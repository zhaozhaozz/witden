/** Topic triggers: durable receipts, bounded filtering, and atomic delivery into a role's conversation. */

import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { enqueue } from "../agent/conversation.js";
import { authorize, saveMessage } from "../agent/dispatch.js";
import { type Db, db as getDb, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type TopicTrigger, type TriggerEvent, topicTriggers, triggerEvents, users } from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { isConsoleUser } from "../security/permissions.js";
import { publish } from "./events.js";
import { getRole, getTopic, participant } from "./topics.js";
import { runFilter } from "./trigger-filter.js";
import { nextTriggerTime } from "./trigger-schedule.js";
import { hydrateTriggerEvent, webhookSource } from "./webhook-sources.js";

export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;

export async function getTrigger(db: Db, topicId: string, id: string): Promise<TopicTrigger> {
  const [trigger] = await db
    .select()
    .from(topicTriggers)
    .where(and(eq(topicTriggers.id, id), eq(topicTriggers.topicId, topicId)))
    .for("update");
  if (!trigger) throw new NotFound("触发器不存在");
  return trigger;
}

export async function validateTriggerRole(db: Db, topicId: string, roleId: string) {
  const topic = await getTopic(db, topicId);
  if (topic.kind !== "group") throw new BadRequest("触发器只能挂在群组话题或关联的外部频道上");
  const role = await getRole(db, roleId);
  if (role?.status !== "active" || !(await participant(db, topicId, "role", roleId)))
    throw new BadRequest("请选择已加入这个话题、已启用的 AI 员工");
  if (role.systemAdmin) throw new BadRequest("系统管理员只接受人的请求，不能负责处理自动触发");
}

function snapshot(trigger: TopicTrigger) {
  return {
    roleId: trigger.roleId,
    instructions: trigger.instructions,
    filterCode: trigger.filterCode,
    createdBy: trigger.createdBy,
    sourceId: trigger.sourceId,
  };
}

/** Missed schedules coalesce into one receipt; the next instant is always later than this sweep. */
export async function queueScheduledTriggers(now = new Date()): Promise<number> {
  return transaction(async (db) => {
    const due = await db
      .select()
      .from(topicTriggers)
      .where(
        and(eq(topicTriggers.kind, "schedule"), eq(topicTriggers.enabled, true), lte(topicTriggers.nextRunAt, now)),
      )
      .orderBy(topicTriggers.nextRunAt)
      .limit(50)
      .for("update", { skipLocked: true });
    for (const trigger of due) {
      const topic = await getTopic(db, trigger.topicId);
      if (topic.status === "active") {
        const [event] = await db
          .insert(triggerEvents)
          .values({
            id: newId("tev"),
            topicId: topic.id,
            triggerId: trigger.id,
            triggerName: trigger.name,
            kind: "schedule",
            eventKey: trigger.nextRunAt!.toISOString(),
            scheduledAt: trigger.nextRunAt,
            config: snapshot(trigger),
          })
          .onConflictDoNothing()
          .returning();
        if (event) await changed(db, event);
      }
      await db
        .update(topicTriggers)
        .set({ nextRunAt: nextTriggerTime(trigger.cron!, trigger.timezone, now) })
        .where(eq(topicTriggers.id, trigger.id));
    }
    return due.length;
  });
}

async function changed(db: Db, event: TriggerEvent) {
  await publish(
    db,
    "trigger.changed",
    { id: event.id, topic_id: event.topicId, status: event.status },
    `topic:${event.topicId}`,
  );
}

async function finish(
  db: Db,
  event: TriggerEvent,
  status: string,
  error: string | null = null,
  extra: { messageId?: string; taskId?: string } = {},
) {
  const [updated] = await db
    .update(triggerEvents)
    .set({ status, error, completedAt: new Date(), claimToken: null, claimedAt: null, ...extra })
    .where(eq(triggerEvents.id, event.id))
    .returning();
  await changed(db, updated);
}

/** A lease is fenced by a random claim token so a recovered receipt cannot be completed by its old owner. */
async function claim(): Promise<TriggerEvent | undefined> {
  return transaction(async (db) => {
    const [event] = await db
      .select()
      .from(triggerEvents)
      .where(
        or(
          eq(triggerEvents.status, "queued"),
          and(
            eq(triggerEvents.status, "processing"),
            or(isNull(triggerEvents.claimedAt), lt(triggerEvents.claimedAt, new Date(Date.now() - LEASE_MS))),
          ),
        ),
      )
      .orderBy(triggerEvents.createdAt, triggerEvents.id)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!event) return;
    if (event.attempts >= MAX_ATTEMPTS) {
      await finish(db, event, "failed", "处理多次中断，请检查服务状态后重新发送事件");
      return;
    }
    const [claimed] = await db
      .update(triggerEvents)
      .set({ status: "processing", attempts: event.attempts + 1, claimedAt: new Date(), claimToken: newId("claim") })
      .where(eq(triggerEvents.id, event.id))
      .returning();
    return claimed;
  });
}

/** Filtering is outside the transaction. Receipt completion, message and conversation inbox commit together. */
export async function processTriggerEvents(limit = 20): Promise<number> {
  let count = 0;
  for (; count < limit; count++) {
    const event = await claim();
    if (!event) break;
    let accepted = true;
    let filterError: string | null = null;
    try {
      Object.assign(event, await hydrateTriggerEvent(getDb(), event));
      if (event.request) accepted = await runFilter(event.config.filterCode, event.request);
    } catch (error) {
      filterError = error instanceof BadRequest ? error.message : "过滤代码执行失败";
    }
    try {
      await transaction(async (db) => {
        const [current] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, event.id)).for("update");
        if (current?.status !== "processing" || current.claimToken !== event.claimToken) return;
        if (filterError) return finish(db, current, "failed", filterError);
        if (!accepted) return finish(db, current, "filtered");
        const [trigger] = await db
          .select()
          .from(topicTriggers)
          .where(eq(topicTriggers.id, event.triggerId))
          .for("share");
        const topic = await getTopic(db, event.topicId);
        if (!trigger?.enabled || topic.status !== "active")
          return finish(db, current, "skipped", "触发器已停用、删除，或话题已归档");
        if (event.config.sourceId) {
          const source = await webhookSource(db, event.config.sourceId).catch(() => null);
          if (!source?.enabled) return finish(db, current, "skipped", "Webhook 来源已停用或删除");
        }
        const [creator] = await db.select().from(users).where(eq(users.id, event.config.createdBy));
        const role = await getRole(db, event.config.roleId);
        if (
          !creator ||
          !isConsoleUser(creator) ||
          !(await participant(db, topic.id, "user", creator.id)) ||
          !role ||
          role.systemAdmin ||
          !(await participant(db, topic.id, "role", role.id))
        )
          return finish(db, current, "failed", "配置人已停用或离开话题，或处理的 AI 员工已不再是本话题的可用参与者");
        const { allowed, refusals } = await authorize(db, topic, creator.id, [role.id]);
        if (!allowed.length) return finish(db, current, "failed", refusals.join("; ").slice(0, 1000));
        const content = [
          `${event.kind === "webhook" ? "Webhook" : "定时"}触发：${event.triggerName}`,
          event.config.instructions,
        ]
          .filter(Boolean)
          .join("\n\n");
        // Explicitly enqueue the configured role; this is not a human reply to an outstanding question.
        const message = await saveMessage(db, topic, "system", null, content, {
          source: event.kind,
          mentions: [],
          // Context-only metadata: neither tool names nor record identifiers are broadcast to the channel.
          externalRef: { trigger_event_id: event.id, scheduled_at: event.scheduledAt?.toISOString() ?? null },
        });
        const task = await enqueue(db, {
          topic,
          role,
          requesterUserId: creator.id,
          sourceMessage: message,
          item: { kind: "message", message_id: message.id },
          assignment: allowed[0][1],
        });
        await finish(db, current, "dispatched", null, { messageId: message.id, ...(task ? { taskId: task.id } : {}) });
      });
    } catch {
      // The dispatch transaction rolled back, so no partial message/task was published. Retry at most three times.
      // Never persist an arbitrary database error: it can contain the original payload or filter source.
      await transaction(async (db) => {
        const [current] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, event.id)).for("update");
        if (current?.claimToken !== event.claimToken) return;
        if (current.attempts >= MAX_ATTEMPTS)
          await finish(db, current, "failed", "交给 AI 员工失败，请检查话题、AI 员工和服务状态");
        else
          await db
            .update(triggerEvents)
            .set({ status: "queued", claimToken: null, claimedAt: null })
            .where(eq(triggerEvents.id, event.id));
      });
    }
  }
  return count;
}

export async function listTriggerEvents(
  db: Db,
  topicId: string,
  options: { before?: string; triggerId?: string; kind?: string; limit?: number } = {},
) {
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequest("limit 必须为 1 到 100 的整数");
  const conditions = [eq(triggerEvents.topicId, topicId)];
  if (options.triggerId) conditions.push(eq(triggerEvents.triggerId, options.triggerId));
  if (options.kind) conditions.push(eq(triggerEvents.kind, options.kind));
  if (options.before) {
    const [cursor] = await db
      .select({ id: triggerEvents.id })
      .from(triggerEvents)
      .where(and(eq(triggerEvents.id, options.before), eq(triggerEvents.topicId, topicId)));
    if (!cursor) throw new NotFound("这个话题中没有该分页起点");
    // Keep PostgreSQL's full timestamp precision; round-tripping through a JS Date loses microseconds.
    conditions.push(
      sql`(${triggerEvents.createdAt}, ${triggerEvents.id}) < (select created_at, id from trigger_events where id = ${cursor.id})`,
    );
  }
  // Lists never fetch raw bodies or configuration snapshots (large requests stay in the detail endpoint).
  return db
    .select({
      id: triggerEvents.id,
      topicId: triggerEvents.topicId,
      triggerId: triggerEvents.triggerId,
      triggerName: triggerEvents.triggerName,
      kind: triggerEvents.kind,
      status: triggerEvents.status,
      error: triggerEvents.error,
      scheduledAt: triggerEvents.scheduledAt,
      createdAt: triggerEvents.createdAt,
      completedAt: triggerEvents.completedAt,
      messageId: triggerEvents.messageId,
      taskId: triggerEvents.taskId,
    })
    .from(triggerEvents)
    .where(and(...conditions))
    .orderBy(desc(triggerEvents.createdAt), desc(triggerEvents.id))
    .limit(limit);
}

export async function getTriggerEvent(db: Db, topicId: string, id: string) {
  const [event] = await db
    .select()
    .from(triggerEvents)
    .where(and(eq(triggerEvents.id, id), eq(triggerEvents.topicId, topicId)));
  if (!event) throw new NotFound("这个话题中没有该触发记录");
  return hydrateTriggerEvent(db, event);
}

/** Own-topic history only, even for roles with permission to read other topics' messages. */
export async function requireWebhookHistory(db: Db, topicId: string, roleId: string) {
  if (!(await participant(db, topicId, "role", roleId))) throw new Forbidden("AI 员工已不在这个话题中");
}

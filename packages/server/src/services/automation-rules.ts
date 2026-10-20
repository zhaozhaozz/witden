/** Scoped rule administration for ordinary roles; never grants access to source credentials. */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type Task, topics, topicTriggers, triggerEvents, users } from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { isConsoleUser } from "../security/permissions.js";
import { audit } from "./audit.js";
import { publish } from "./events.js";
import { addParticipant, getRole, getTopic, participant } from "./topics.js";
import { runFilter, validateFilter } from "./trigger-filter.js";
import { nextTriggerTime } from "./trigger-schedule.js";
import { availableSources, webhookSource } from "./webhook-sources.js";

const edit = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    instructions: z.string().max(16_000).optional(),
    source_id: z.string().min(1).optional(),
    filter_code: z.string().max(16_000).optional(),
    cron: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const publicRule = (rule: typeof topicTriggers.$inferSelect) => ({
  id: rule.id,
  topic_id: rule.topicId,
  name: rule.name,
  kind: rule.kind,
  enabled: rule.enabled,
  role_id: rule.roleId,
  source_id: rule.sourceId,
  instructions: rule.instructions,
  filter_code: rule.filterCode,
  cron: rule.cron,
  timezone: rule.timezone,
  next_run_at: rule.nextRunAt?.toISOString() ?? null,
});

export async function automationList(db: Db, roleId?: string) {
  const rows = await db
    .select()
    .from(topicTriggers)
    .where(roleId ? eq(topicTriggers.roleId, roleId) : undefined)
    .orderBy(desc(topicTriggers.createdAt));
  const out = [];
  for (const rule of rows) {
    const [topic] = await db.select().from(topics).where(eq(topics.id, rule.topicId));
    out.push({ ...publicRule(rule), topic_title: topic?.title ?? rule.topicId });
  }
  return out;
}

async function authorizeManager(db: Db, task: Task) {
  const role = await getRole(db, task.ownerRoleId);
  if (
    !role ||
    role.systemAdmin ||
    !role.allowedTools.includes("automation") ||
    !task.envelope.tools?.includes("automation")
  )
    throw new Forbidden("automation management permission is required");
  // Public payloads and forwarded external requests must not become configuration-authoring instructions.
  if (task.envelope.outside || task.envelope.automation_event)
    throw new Forbidden("manage automation from an authorized console conversation, not an external or webhook input");
  const [user] = task.requesterUserId ? await db.select().from(users).where(eq(users.id, task.requesterUserId)) : [];
  if (!isConsoleUser(user)) throw new Forbidden("an active console administrator must authorize rule management");
  return { role, user: user! };
}

async function sourceGrant(db: Db, sourceId: string, roleId: string) {
  const source = await webhookSource(db, sourceId);
  if (!source.enabled || !source.allowedRoleIds.includes(roleId))
    throw new Forbidden("this source is not granted to the managing role");
  return source;
}

export async function manageAutomation(db: Db, task: Task, args: Record<string, any>) {
  const { role, user } = await authorizeManager(db, task);
  const action = String(args.action ?? "list");
  if (action === "sources")
    return (await availableSources(db))
      .filter((s) => s.allowedRoleIds.includes(role.id))
      .map((s) => ({ id: s.id, name: s.name, enabled: s.enabled }));
  if (action === "list") {
    const list = [];
    for (const rule of await automationList(db, role.id))
      if (await participant(db, rule.topic_id, "role", role.id)) list.push(rule);
    return list;
  }
  if (action === "test") {
    if (
      typeof args.filter_code !== "string" ||
      args.filter_code.length > 16_000 ||
      typeof args.raw_body !== "string" ||
      args.raw_body.length > 64_000
    )
      throw new BadRequest("provide bounded filter_code and raw_body");
    await validateFilter(args.filter_code);
    return {
      accepted: await runFilter(args.filter_code, {
        method: "POST",
        path: "/test",
        headers: {},
        query: {},
        body_base64: Buffer.from(args.raw_body).toString("base64"),
      }),
    };
  }
  const parsed = edit.safeParse(args.config ?? {});
  if (!parsed.success)
    throw new BadRequest("unknown or invalid rule configuration; credentials and owner cannot be changed here");
  const b = parsed.data;
  let rule: typeof topicTriggers.$inferSelect;
  if (action === "create") {
    if (!b.name || !["webhook", "schedule"].includes(args.kind)) throw new BadRequest("create requires name and kind");
    const topic = await getTopic(db, String(args.topic_id ?? ""));
    if (topic.kind !== "group" || topic.status !== "active" || !(await participant(db, topic.id, "role", role.id)))
      throw new Forbidden("choose an active group topic you already participate in");
    if (args.kind === "webhook") {
      if (!b.source_id) throw new BadRequest("select a granted shared source; ask a person to create credentials");
      await sourceGrant(db, b.source_id, role.id);
      if (b.cron || b.timezone) throw new BadRequest("webhooks have no schedule");
    } else if (b.source_id || b.filter_code) throw new BadRequest("scheduled rules have no webhook source or filter");
    await validateFilter(b.filter_code ?? "");
    const next = args.kind === "schedule" ? nextTriggerTime(b.cron ?? "", b.timezone ?? "UTC") : null;
    await addParticipant(db, topic, "user", user.id, { invitedBy: user.id });
    [rule] = await db
      .insert(topicTriggers)
      .values({
        id: newId("trg"),
        topicId: topic.id,
        roleId: role.id,
        name: b.name,
        kind: args.kind,
        enabled: b.enabled ?? true,
        createdBy: user.id,
        sourceId: b.source_id ?? null,
        instructions: b.instructions ?? "",
        filterCode: b.filter_code ?? "",
        cron: b.cron ?? null,
        timezone: b.timezone ?? "UTC",
        nextRunAt: b.enabled === false ? null : next,
      })
      .returning();
  } else {
    [rule] = await db
      .select()
      .from(topicTriggers)
      .where(and(eq(topicTriggers.id, String(args.id ?? "")), eq(topicTriggers.roleId, role.id)))
      .for("update");
    if (!rule || !(await participant(db, rule.topicId, "role", role.id)))
      throw new NotFound("no rule you manage with this id");
    if (action === "get") return publicRule(rule);
    if (action === "events")
      return await db
        .select({
          id: triggerEvents.id,
          status: triggerEvents.status,
          error: triggerEvents.error,
          messageId: triggerEvents.messageId,
          taskId: triggerEvents.taskId,
          createdAt: triggerEvents.createdAt,
        })
        .from(triggerEvents)
        .where(eq(triggerEvents.triggerId, rule.id))
        .orderBy(desc(triggerEvents.createdAt))
        .limit(50);
    if (action === "delete") await db.delete(topicTriggers).where(eq(topicTriggers.id, rule.id));
    else if (action === "update") {
      if (rule.kind === "schedule" && (b.source_id !== undefined || b.filter_code !== undefined))
        throw new BadRequest("scheduled rules have no webhook source or filter");
      if (rule.kind === "webhook" && (b.cron !== undefined || b.timezone !== undefined))
        throw new BadRequest("webhooks have no schedule");
      // Its own secret would be gone for good, and senders refused: only a person switches it, in the console.
      if (b.source_id !== undefined && rule.tokenHash)
        throw new BadRequest("this trigger has its own secret; a person switches it to a shared source in the console");
      if (b.source_id) await sourceGrant(db, b.source_id, role.id);
      if (b.filter_code !== undefined) await validateFilter(b.filter_code);
      const next =
        rule.kind === "schedule" && (b.cron !== undefined || b.timezone !== undefined || b.enabled !== undefined)
          ? nextTriggerTime(b.cron ?? rule.cron!, b.timezone ?? rule.timezone)
          : rule.nextRunAt;
      const [updated] = await db
        .update(topicTriggers)
        .set({
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
          ...(b.instructions !== undefined ? { instructions: b.instructions } : {}),
          ...(b.source_id !== undefined ? { sourceId: b.source_id, tokenHash: null } : {}),
          ...(b.filter_code !== undefined ? { filterCode: b.filter_code } : {}),
          ...(b.cron !== undefined ? { cron: b.cron } : {}),
          ...(b.timezone !== undefined ? { timezone: b.timezone } : {}),
          nextRunAt: (b.enabled ?? rule.enabled) ? next : null,
        })
        .where(eq(topicTriggers.id, rule.id))
        .returning();
      rule = updated;
    } else throw new BadRequest("unsupported automation action");
  }
  await audit(db, `automation.${action}`, {
    actorType: "role",
    actorId: role.id,
    roleId: role.id,
    taskId: task.id,
    topicId: rule.topicId,
    resourceType: "trigger",
    resourceId: rule.id,
    detail: { fields: Object.keys(b) },
  });
  await publish(db, "trigger.changed", { topic_id: rule.topicId, trigger_id: rule.id }, `topic:${rule.topicId}`);
  return action === "delete" ? { deleted: rule.id } : publicRule(rule);
}

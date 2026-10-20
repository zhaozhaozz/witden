import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db as getDb } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type TopicTrigger, type TriggerRequest, topicTriggers, triggerEvents } from "../db/schema.js";
import { BadRequest, Forbidden } from "../errors.js";
import { runtime } from "../runtime.js";
import { hashToken } from "../security/crypto.js";
import { isConsoleUser } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { publish } from "../services/events.js";
import { webhookBase } from "../services/public-url.js";
import { addParticipant, getTopic, requireView } from "../services/topics.js";
import { runFilter, validateFilter } from "../services/trigger-filter.js";
import { nextTriggerTime } from "../services/trigger-schedule.js";
import {
  acceptWebhook,
  getTrigger,
  getTriggerEvent,
  listTriggerEvents,
  MAX_WEBHOOK_BYTES,
  processTriggerEvents,
  validateTriggerRole,
  verifyTriggerToken,
} from "../services/triggers.js";
import { pruneWebhookReceipts, webhookSource } from "../services/webhook-sources.js";
import { automationRoutes } from "./automations.js";
import { authed, authedNoTx, body, type Ctx, params, query, row } from "./http.js";
import { sharedWebhookRoutes, webhookSourceRoutes } from "./webhook-sources.js";

const fields = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["webhook", "schedule"]),
    roleId: z.string().min(1),
    sourceId: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    instructions: z.string().max(16_000).optional(),
    secret: z
      .string()
      .min(24)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/, "密钥只接受字母、数字、下划线和连字符")
      .optional(),
    filterCode: z.string().max(16_000).optional(),
    cron: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

async function admin(ctx: Ctx) {
  if (!isConsoleUser(ctx.user)) throw new Forbidden("只有控制台管理员可以管理触发器");
  return getTopic(ctx.db, params(ctx.req).id);
}

async function triggerOut(db: Ctx["db"], trigger: TopicTrigger) {
  return {
    ...row(trigger),
    has_secret: !!trigger.tokenHash || !!trigger.sourceId,
    webhook_url:
      trigger.kind === "webhook"
        ? trigger.sourceId
          ? `${await webhookBase(db)}/api/hook-sources/${trigger.sourceId}`
          : `${await webhookBase(db)}/api/hooks/${trigger.id}`
        : null,
  };
}

async function configChanged(ctx: Ctx, id: string, action: string) {
  const topicId = params(ctx.req).id;
  await audit(ctx.db, action, {
    actorType: "user",
    actorId: ctx.user.id,
    topicId,
    resourceType: "trigger",
    resourceId: id,
  });
  await publish(ctx.db, "trigger.changed", { topic_id: topicId, trigger_id: id }, `topic:${topicId}`);
}

export async function triggerRoutes(app: FastifyInstance) {
  await webhookSourceRoutes(app);
  await automationRoutes(app);
  app.get(
    "/api/topics/:id/triggers",
    authed(async (ctx) => {
      await admin(ctx);
      const triggers = await ctx.db
        .select()
        .from(topicTriggers)
        .where(eq(topicTriggers.topicId, params(ctx.req).id))
        .orderBy(topicTriggers.createdAt);
      return Promise.all(triggers.map((trigger) => triggerOut(ctx.db, trigger)));
    }),
  );

  app.post(
    "/api/topics/:id/triggers",
    authed(async (ctx) => {
      const topic = await admin(ctx);
      const parsed = fields.safeParse(body(ctx.req));
      if (!parsed.success)
        throw new BadRequest(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const b = parsed.data;
      await validateTriggerRole(ctx.db, topic.id, b.roleId);
      if (b.kind === "webhook" && !b.secret && !b.sourceId)
        throw new BadRequest("webhook 必须设置至少 24 个字符的密钥");
      if (b.kind === "schedule" && (b.secret || b.filterCode || b.sourceId))
        throw new BadRequest("定时触发不使用 webhook 密钥或过滤代码");
      if (b.kind === "webhook" && (b.cron || b.timezone)) throw new BadRequest("webhook 不使用定时计划");
      if (b.sourceId) {
        await webhookSource(ctx.db, b.sourceId);
        if (b.secret) throw new BadRequest("共享来源的密钥应在接入设置中管理");
      }
      await validateFilter(b.filterCode ?? "");
      const next = b.kind === "schedule" ? nextTriggerTime(b.cron ?? "", b.timezone ?? "UTC") : null;
      // Work runs under its creator's authority; the normal revocation checks require topic membership.
      // Administrators can configure an external channel they have only viewed, so join them on creation.
      await addParticipant(ctx.db, topic, "user", ctx.user.id, { invitedBy: ctx.user.id });
      const [trigger] = await ctx.db
        .insert(topicTriggers)
        .values({
          id: newId("trg"),
          topicId: topic.id,
          name: b.name,
          kind: b.kind,
          roleId: b.roleId,
          instructions: b.instructions ?? "",
          enabled: b.enabled ?? true,
          createdBy: ctx.user.id,
          tokenHash: b.secret ? hashToken(b.secret) : null,
          sourceId: b.sourceId ?? null,
          filterCode: b.filterCode ?? "",
          cron: b.cron ?? null,
          timezone: b.timezone ?? "UTC",
          nextRunAt: b.enabled === false ? null : next,
        })
        .returning();
      await configChanged(ctx, trigger.id, "trigger.create");
      return triggerOut(ctx.db, trigger);
    }),
  );

  app.patch(
    "/api/topics/:id/triggers/:triggerId",
    authed(async (ctx) => {
      await admin(ctx);
      const trigger = await getTrigger(ctx.db, params(ctx.req).id, params(ctx.req).triggerId);
      const parsed = fields.omit({ kind: true }).partial().safeParse(body(ctx.req));
      if (!parsed.success)
        throw new BadRequest(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const { secret, ...b } = parsed.data;
      if (b.roleId !== undefined) await validateTriggerRole(ctx.db, trigger.topicId, b.roleId);
      if (
        trigger.kind === "schedule" &&
        (secret !== undefined || b.filterCode !== undefined || b.sourceId !== undefined)
      )
        throw new BadRequest("定时触发不使用 webhook 密钥或过滤代码");
      if (trigger.kind === "webhook" && (b.cron !== undefined || b.timezone !== undefined))
        throw new BadRequest("webhook 不使用定时计划");
      if (b.sourceId) await webhookSource(ctx.db, b.sourceId);
      if ((b.sourceId ?? trigger.sourceId) && secret) throw new BadRequest("共享来源的密钥应在接入设置中管理");
      if (b.filterCode !== undefined) await validateFilter(b.filterCode);
      const enabled = b.enabled ?? trigger.enabled;
      const scheduleChanged = b.cron !== undefined || b.timezone !== undefined || b.enabled !== undefined;
      const next =
        trigger.kind === "schedule" && scheduleChanged
          ? nextTriggerTime(b.cron ?? trigger.cron!, b.timezone ?? trigger.timezone)
          : trigger.nextRunAt;
      const [updated] = await ctx.db
        .update(topicTriggers)
        .set({
          ...b,
          ...(secret ? { tokenHash: hashToken(secret) } : b.sourceId ? { tokenHash: null } : {}),
          nextRunAt: enabled ? next : null,
          updatedAt: new Date(),
        })
        .where(eq(topicTriggers.id, trigger.id))
        .returning();
      await configChanged(ctx, trigger.id, "trigger.update");
      return triggerOut(ctx.db, updated);
    }),
  );

  app.delete(
    "/api/topics/:id/triggers/:triggerId",
    authed(async (ctx) => {
      await admin(ctx);
      const trigger = await getTrigger(ctx.db, params(ctx.req).id, params(ctx.req).triggerId);
      await ctx.db.delete(topicTriggers).where(eq(topicTriggers.id, trigger.id));
      await configChanged(ctx, trigger.id, "trigger.delete");
      return { ok: true };
    }),
  );

  app.post(
    "/api/topics/:id/triggers/test-filter",
    authedNoTx(async (ctx) => {
      await admin(ctx);
      const parsed = z
        .object({
          filterCode: z.string().max(16_000),
          rawBody: z.string().max(64_000),
          headers: z.record(z.string()).optional(),
        })
        .strict()
        .safeParse(body(ctx.req));
      if (!parsed.success) throw new BadRequest("提供 filter_code、raw_body 和可选的 headers（字符串键值对）");
      await validateFilter(parsed.data.filterCode);
      const accepted = await runFilter(parsed.data.filterCode, {
        method: "POST",
        path: "/test",
        query: {},
        headers: parsed.data.headers ?? {},
        body_base64: Buffer.from(parsed.data.rawBody).toString("base64"),
      });
      return { accepted };
    }),
  );

  app.get(
    "/api/topics/:id/trigger-events",
    authed(async (ctx) => {
      const topic = await getTopic(ctx.db, params(ctx.req).id);
      await requireView(ctx.db, ctx.user, topic);
      const q = query(ctx.req);
      if (q.kind && !["webhook", "schedule"].includes(q.kind)) throw new BadRequest("kind 必须为 webhook 或 schedule");
      const events = await listTriggerEvents(ctx.db, topic.id, {
        before: q.before,
        triggerId: q.trigger_id,
        kind: q.kind,
        limit: Number(q.limit ?? 30),
      });
      return { items: events.map((event) => row(event)), next_cursor: events.at(-1)?.id ?? null };
    }),
  );

  app.get(
    "/api/topics/:id/trigger-events/:eventId",
    authed(async (ctx) => {
      const topic = await getTopic(ctx.db, params(ctx.req).id);
      await requireView(ctx.db, ctx.user, topic);
      return row(await getTriggerEvent(ctx.db, topic.id, params(ctx.req).eventId), ["config", "claimToken"]);
    }),
  );

  app.delete(
    "/api/topics/:id/trigger-events",
    authed(async (ctx) => {
      const topic = await admin(ctx);
      if (body(ctx.req).confirm !== true) throw new BadRequest("清空历史不可撤销，需要 confirm=true");
      await ctx.db.delete(triggerEvents).where(eq(triggerEvents.topicId, topic.id));
      await pruneWebhookReceipts(ctx.db);
      await configChanged(ctx, topic.id, "trigger.history_clear");
      return { ok: true };
    }),
  );
}

function hookToken(req: FastifyRequest) {
  const header = req.headers.authorization ?? "";
  return /^Bearer /i.test(header) ? header.slice(7).trim() : String(req.headers["x-webhook-token"] ?? "");
}

/** Encapsulation keeps arbitrary raw content (including malformed JSON) away from normal API parsers. */
export async function triggerWebhookRoutes(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  await sharedWebhookRoutes(app);
  app.post(
    "/api/hooks/:id",
    {
      bodyLimit: MAX_WEBHOOK_BYTES,
      onRequest: async (req) => {
        const [trigger] = await getDb()
          .select()
          .from(topicTriggers)
          .where(eq(topicTriggers.id, params(req).id));
        verifyTriggerToken(trigger, hookToken(req));
      },
    },
    async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const headers: TriggerRequest["headers"] = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers[key] = /authorization|cookie|token|secret|api[-_]key|signature/i.test(key) ? "[REDACTED]" : value;
      }
      const result = await acceptWebhook(
        params(req).id,
        hookToken(req),
        {
          method: req.method,
          path: req.url.split("?")[0],
          query: (req.query ?? {}) as Record<string, unknown>,
          headers,
          body_base64: raw.toString("base64"),
        },
        typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null,
      );
      // Acknowledge only after the receipt is committed. The periodic sweep also picks it up after a crash.
      void runtime().background("trigger.webhook", () => processTriggerEvents());
      return reply.code(result.duplicate ? 200 : 202).send(result);
    },
  );
}

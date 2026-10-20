import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db as getDb } from "../db/client.js";
import { newId } from "../db/ids.js";
import { roles, topicTriggers, webhookReceipts, webhookSources } from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { runtime } from "../runtime.js";
import { hashToken } from "../security/crypto.js";
import { isConsoleUser } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { redactWebhookHeaders } from "../services/collaboration-policy.js";
import { webhookBase } from "../services/public-url.js";
import { MAX_WEBHOOK_BYTES, processTriggerEvents, verifyTriggerToken } from "../services/triggers.js";
import { acceptSourceWebhook, availableSources, sourceEventPage, webhookSource } from "../services/webhook-sources.js";
import { authed, body, type Ctx, params, query, row } from "./http.js";

const fields = z
  .object({
    name: z.string().trim().min(1).max(120),
    secret: z
      .string()
      .min(24)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    enabled: z.boolean().optional(),
    allowedRoleIds: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict();
function admin(ctx: Ctx) {
  if (!isConsoleUser(ctx.user)) throw new Forbidden("only console accounts can manage webhook sources");
}
async function validRoles(ctx: Ctx, ids: string[] = []) {
  for (const id of ids) {
    const [role] = await ctx.db.select().from(roles).where(eq(roles.id, id));
    if (!role || role.systemAdmin) throw new BadRequest("choose existing non-system-administrator roles");
  }
}
async function sourceOut(ctx: Ctx, source: typeof webhookSources.$inferSelect) {
  const rules = await ctx.db
    .select({
      id: topicTriggers.id,
      topicId: topicTriggers.topicId,
      name: topicTriggers.name,
      enabled: topicTriggers.enabled,
    })
    .from(topicTriggers)
    .where(eq(topicTriggers.sourceId, source.id));
  return {
    ...row(source),
    has_secret: true,
    webhook_url: `${await webhookBase(ctx.db)}/api/hook-sources/${source.id}`,
    rules: rules.map((r) => row(r)),
  };
}

export async function webhookSourceRoutes(app: FastifyInstance) {
  app.get(
    "/api/webhook-sources",
    authed(async (ctx) => {
      admin(ctx);
      return Promise.all((await availableSources(ctx.db)).map((s) => sourceOut(ctx, s)));
    }),
  );
  app.post(
    "/api/webhook-sources",
    authed(async (ctx) => {
      admin(ctx);
      const parsed = fields.safeParse(body(ctx.req));
      if (!parsed.success)
        throw new BadRequest("provide name, a 24..256 character secret, enabled and allowed_role_ids");
      await validRoles(ctx, parsed.data.allowedRoleIds);
      const { secret, ...b } = parsed.data;
      const [source] = await ctx.db
        .insert(webhookSources)
        .values({
          id: newId("whs"),
          ...b,
          allowedRoleIds: [...new Set(b.allowedRoleIds ?? [])],
          tokenHash: hashToken(secret),
          createdBy: ctx.user.id,
        })
        .returning();
      await audit(ctx.db, "webhook_source.create", {
        actorType: "user",
        actorId: ctx.user.id,
        resourceType: "webhook_source",
        resourceId: source.id,
      });
      return sourceOut(ctx, source);
    }),
  );
  app.patch(
    "/api/webhook-sources/:id",
    authed(async (ctx) => {
      admin(ctx);
      const source = await webhookSource(ctx.db, params(ctx.req).id);
      const parsed = fields.partial().safeParse(body(ctx.req));
      if (!parsed.success) throw new BadRequest("invalid webhook source fields");
      await validRoles(ctx, parsed.data.allowedRoleIds);
      const { secret, ...b } = parsed.data;
      const [updated] = await ctx.db
        .update(webhookSources)
        .set({ ...b, ...(secret ? { tokenHash: hashToken(secret) } : {}) })
        .where(eq(webhookSources.id, source.id))
        .returning();
      await audit(ctx.db, "webhook_source.update", {
        actorType: "user",
        actorId: ctx.user.id,
        resourceType: "webhook_source",
        resourceId: source.id,
        detail: { fields: Object.keys(parsed.data).filter((k) => k !== "secret"), rotated_secret: !!secret },
      });
      return sourceOut(ctx, updated);
    }),
  );
  app.delete(
    "/api/webhook-sources/:id",
    authed(async (ctx) => {
      admin(ctx);
      const source = await webhookSource(ctx.db, params(ctx.req).id);
      const [used] = await ctx.db
        .select({ id: topicTriggers.id })
        .from(topicTriggers)
        .where(eq(topicTriggers.sourceId, source.id))
        .limit(1);
      if (used) throw new BadRequest("source is used by rules; disable it or remove those rules first");
      // Keep receipts and their provenance. Deletion only removes the entry from configuration choices.
      await ctx.db
        .update(webhookSources)
        .set({ enabled: false, deletedAt: new Date() })
        .where(eq(webhookSources.id, source.id));
      await audit(ctx.db, "webhook_source.delete", {
        actorType: "user",
        actorId: ctx.user.id,
        resourceType: "webhook_source",
        resourceId: source.id,
      });
      return { ok: true };
    }),
  );
  app.get(
    "/api/webhook-sources/:id/events",
    authed(async (ctx) => {
      admin(ctx);
      const q = query(ctx.req);
      const page = await sourceEventPage(ctx.db, params(ctx.req).id, q.before, Number(q.limit ?? 30));
      return {
        items: page.items.map((r) => ({ ...row(r), deliveries: r.deliveries.map((d) => row(d)) })),
        next_cursor: page.next,
      };
    }),
  );
  app.get(
    "/api/webhook-sources/:id/events/:receiptId",
    authed(async (ctx) => {
      admin(ctx);
      await webhookSource(ctx.db, params(ctx.req).id);
      const [receipt] = await ctx.db
        .select()
        .from(webhookReceipts)
        .where(
          and(eq(webhookReceipts.sourceId, params(ctx.req).id), eq(webhookReceipts.id, params(ctx.req).receiptId)),
        );
      if (!receipt) throw new NotFound("receipt not found");
      return row(receipt);
    }),
  );
}

const token = (req: FastifyRequest) => {
  const auth = req.headers.authorization ?? "";
  return /^Bearer /i.test(auth) ? auth.slice(7).trim() : String(req.headers["x-webhook-token"] ?? "");
};

/** Registered inside the existing raw-parser webhook scope, on the public event listener only. */
export async function sharedWebhookRoutes(app: FastifyInstance) {
  app.post(
    "/api/hook-sources/:id",
    {
      bodyLimit: MAX_WEBHOOK_BYTES,
      onRequest: async (req) => {
        const [source] = await getDb()
          .select()
          .from(webhookSources)
          .where(and(eq(webhookSources.id, params(req).id), isNull(webhookSources.deletedAt)));
        verifyTriggerToken(source, token(req));
      },
    },
    async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const accepted = await acceptSourceWebhook(
        params(req).id,
        token(req),
        {
          method: req.method,
          path: req.url.split("?")[0],
          query: (req.query ?? {}) as Record<string, unknown>,
          headers: redactWebhookHeaders(req.headers),
          body_base64: raw.toString("base64"),
        },
        typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null,
      );
      void runtime().background("shared_webhook.accepted", () => processTriggerEvents());
      // How many triggers take it stays inside: the sender learns only that it was received.
      return reply.code(accepted.duplicate ? 200 : 202).send({ id: accepted.id, duplicate: accepted.duplicate });
    },
  );
}

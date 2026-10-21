import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db as getDb } from "../db/client.js";
import { newId } from "../db/ids.js";
import { roles, topicTriggers, webhookReceipts, webhookSources } from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { runtime } from "../runtime.js";
import { hashToken, secretBox } from "../security/crypto.js";
import { isConsoleUser } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { redactWebhookHeaders } from "../services/collaboration-policy.js";
import { webhookBase } from "../services/public-url.js";
import { MAX_WEBHOOK_BYTES, processTriggerEvents } from "../services/triggers.js";
import {
  acceptSourceWebhook,
  availableSources,
  precheckSourceCredentials,
  type SourceCredentials,
  sourceEventPage,
  webhookSource,
} from "../services/webhook-sources.js";
import { authed, body, type Ctx, params, query, row } from "./http.js";

const fields = z
  .object({
    name: z.string().trim().min(1).max(120),
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
/**
 * Senders put it in `Authorization: Bearer` or `X-Webhook-Token`, checked against the hash, or sign with it
 * (Standard Webhooks), which needs the encrypted copy. That copy also lets console accounts copy it from the
 * source's card (an exception to "secrets are never read").
 *
 * Standard Webhooks senders base64-decode what follows `whsec_` and reject anything else, so it is standard
 * base64, not base64url. 33 bytes encode without `=` padding, which strict and unpadded decoders both accept.
 */
function newSecret() {
  const secret = `whsec_${randomBytes(33).toString("base64")}`;
  return { secret, tokenHash: hashToken(secret), secretEncrypted: secretBox().encrypt(secret) };
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
    secret_readable: !!source.secretEncrypted,
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
      if (!parsed.success) throw new BadRequest("provide name, and optionally enabled and allowed_role_ids");
      await validRoles(ctx, parsed.data.allowedRoleIds);
      const b = parsed.data;
      const { secret, ...credentials } = newSecret();
      const [source] = await ctx.db
        .insert(webhookSources)
        .values({
          id: newId("whs"),
          ...b,
          allowedRoleIds: [...new Set(b.allowedRoleIds ?? [])],
          ...credentials,
          createdBy: ctx.user.id,
        })
        .returning();
      await audit(ctx.db, "webhook_source.create", {
        actorType: "user",
        actorId: ctx.user.id,
        resourceType: "webhook_source",
        resourceId: source.id,
      });
      return { ...(await sourceOut(ctx, source)), secret };
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
      const [updated] = await ctx.db
        .update(webhookSources)
        .set(parsed.data)
        .where(eq(webhookSources.id, source.id))
        .returning();
      await audit(ctx.db, "webhook_source.update", {
        actorType: "user",
        actorId: ctx.user.id,
        resourceType: "webhook_source",
        resourceId: source.id,
        detail: { fields: Object.keys(parsed.data) },
      });
      return sourceOut(ctx, updated);
    }),
  );
  // Console accounts only, audited. Neither this nor regenerating is open to the system administrator role.
  app.get(
    "/api/webhook-sources/:id/secret",
    authed(async (ctx) => {
      admin(ctx);
      const source = await webhookSource(ctx.db, params(ctx.req).id);
      if (!source.secretEncrypted)
        throw new BadRequest("这个来源的密钥只保存了哈希，无法显示；发送方已保存的密钥仍然有效，需要复制时请重新生成");
      await audit(ctx.db, "webhook_source.secret_read", {
        actorType: "user",
        actorId: ctx.user.id,
        resourceType: "webhook_source",
        resourceId: source.id,
      });
      return { secret: secretBox().decrypt(source.secretEncrypted) };
    }),
  );
  // The old secret stops working at once.
  app.post(
    "/api/webhook-sources/:id/secret",
    authed(async (ctx) => {
      admin(ctx);
      const source = await webhookSource(ctx.db, params(ctx.req).id);
      const { secret, ...credentials } = newSecret();
      await ctx.db.update(webhookSources).set(credentials).where(eq(webhookSources.id, source.id));
      await audit(ctx.db, "webhook_source.secret_rotate", {
        actorType: "user",
        actorId: ctx.user.id,
        resourceType: "webhook_source",
        resourceId: source.id,
      });
      return { secret };
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

/** Svix sends the same Standard Webhooks signature under its older `svix-*` header names. */
function credentials(req: FastifyRequest): SourceCredentials {
  const header = (name: string) => String(req.headers[name] ?? "");
  const auth = header("authorization");
  const prefix = req.headers["webhook-signature"] ? "webhook" : "svix";
  const signed = {
    id: header(`${prefix}-id`),
    timestamp: header(`${prefix}-timestamp`),
    signature: header(`${prefix}-signature`),
  };
  return {
    token: /^Bearer /i.test(auth) ? auth.slice(7).trim() : header("x-webhook-token"),
    signed: signed.id && signed.timestamp && signed.signature ? signed : undefined,
  };
}

/**
 * Registered inside the raw-parser webhook scope. `/api/hooks/:id` is the address triggers with their own
 * secret had; migration 0040 turned each into a source with the trigger's id, so those senders keep working.
 */
export async function sharedWebhookRoutes(app: FastifyInstance) {
  for (const path of ["/api/hook-sources/:id", "/api/hooks/:id"])
    app.post(
      path,
      {
        bodyLimit: MAX_WEBHOOK_BYTES,
        onRequest: async (req) => {
          const [source] = await getDb()
            .select()
            .from(webhookSources)
            .where(and(eq(webhookSources.id, params(req).id), isNull(webhookSources.deletedAt)));
          precheckSourceCredentials(source, credentials(req));
        },
      },
      async (req, reply) => {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const auth = credentials(req);
        const accepted = await acceptSourceWebhook(
          params(req).id,
          auth,
          {
            method: req.method,
            path: req.url.split("?")[0],
            query: (req.query ?? {}) as Record<string, unknown>,
            headers: redactWebhookHeaders(req.headers),
            body_base64: raw.toString("base64"),
          },
          // A Standard Webhooks message id stays the same when the sender retries it, and the signature covers
          // it; an unsigned Idempotency-Key would let a captured signed request be replayed under a new key.
          auth.signed?.id ??
            (typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null),
        );
        void runtime().background("shared_webhook.accepted", () => processTriggerEvents());
        // How many triggers take it stays inside: the sender learns only that it was received.
        return reply.code(accepted.duplicate ? 200 : 202).send({ id: accepted.id, duplicate: accepted.duplicate });
      },
    );
}

/** Chat connections, conversations, deliveries, publishing topics outward, and the platform webhooks. */
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { settings } from "../config.js";
import { type Db, db as getDb, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  type Connection,
  connections,
  externalConversations,
  externalIdentities,
  externalThreadLinks,
  outboundMessages,
  processedEvents,
} from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { CAPABILITIES, getAdapter, type InboundAction } from "../integrations/base.js";
import { deliverPending } from "../integrations/delivery.js";
import { enqueueInbound, processInbound } from "../integrations/inbound.js";
import { runtime } from "../runtime.js";
import { secretBox } from "../security/crypto.js";
import { conversationReaders, describeReaders, isSubset, topicReaders } from "../security/labels.js";
import { hasPermission, Perm, requirePerm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { wake } from "../services/events.js";
import * as topicSvc from "../services/topics.js";
import { authed, authedNoTx, body, params, query, row } from "./http.js";

const PLATFORMS: Record<string, string[]> = {
  slack: ["bot_token", "signing_secret"],
  feishu: ["app_id", "app_secret", "verification_token"],
};
const SETTINGS_KEYS = new Set(["auto_provision_users", "external_role_ids", "custom_identity", "default_sync_mode"]);

function connOut(conn: Connection) {
  const base = settings().publicUrl.replace(/\/+$/, "");
  return {
    ...row(conn),
    has_credentials: !!conn.credentialsEncrypted,
    capabilities: CAPABILITIES[conn.platform] ?? {},
    events_url: `${base}/api/integrations/${conn.platform}/${conn.id}/events`,
  };
}

function cleanSettings(s: Record<string, any>): Record<string, any> {
  const unknown = Object.keys(s).filter((k) => !SETTINGS_KEYS.has(k));
  if (unknown.length) throw new BadRequest(`unknown settings ${unknown.join(", ")}`);
  if (!["mentions", "all", "off"].includes(s.default_sync_mode ?? "mentions"))
    throw new BadRequest("default_sync_mode must be mentions, all or off");
  if (
    s.external_role_ids !== undefined &&
    !(Array.isArray(s.external_role_ids) && s.external_role_ids.every((x: unknown) => typeof x === "string"))
  )
    throw new BadRequest("external_role_ids must be a list of role ids");
  return s;
}

/** ``db`` must be the request transaction when there is one: PGlite has one connection, so a query outside it waits forever. */
async function getConn(db: Db, id: string): Promise<Connection> {
  const [conn] = await db.select().from(connections).where(eq(connections.id, id)).limit(1);
  if (!conn) throw new NotFound("connection not found");
  return conn;
}

/**
 * Platforms retry slow webhooks, so events are stored durably first, then acknowledged, then processed from
 * the queue (a periodic sweep picks up anything a crash left behind).
 */
async function acceptEvents(connectionId: string, actions: InboundAction[]): Promise<void> {
  if (!actions.length) return;
  await enqueueInbound(getDb(), connectionId, actions);
  runtime().background("inbound", async () => {
    while (await processInbound()) {
      /* drain */
    }
  });
}

export async function integrationRoutes(app: FastifyInstance) {
  app.get(
    "/api/integrations/capabilities",
    authed(async () => CAPABILITIES),
  );

  app.get(
    "/api/connections",
    authed(async ({ db, user }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      return (await db.select().from(connections).orderBy(connections.name)).map(connOut);
    }),
  );

  app.get(
    "/api/connections/publishable",
    authed(async ({ db, user }) => {
      // Connections this person may publish topics to, without credentials or settings.
      const out = [];
      for (const c of await db
        .select()
        .from(connections)
        .where(eq(connections.status, "active"))
        .orderBy(connections.name)) {
        if (await hasPermission(db, user, Perm.TOPIC_PUBLISH, c.id))
          out.push({ id: c.id, name: c.name, platform: c.platform });
      }
      return out;
    }),
  );

  app.post(
    "/api/connections",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const b = body(req);
      const required = PLATFORMS[b.platform];
      if (!required)
        throw new BadRequest(
          `platform must be one of ${Object.keys(PLATFORMS).join(", ")} (see /api/integrations/capabilities)`,
        );
      const creds: Record<string, string> = b.credentials ?? {};
      const missing = required.filter((k) => !creds[k]);
      if (missing.length) throw new BadRequest(`missing credentials: ${missing.join(", ")}`);
      if ((await db.select().from(connections).where(eq(connections.name, b.name)).limit(1)).length)
        throw new BadRequest("a connection with this name exists");
      const [conn] = await db
        .insert(connections)
        .values({
          id: newId("conn"),
          platform: b.platform,
          name: String(b.name),
          credentialsEncrypted: secretBox().encrypt(JSON.stringify(creds)),
          settings: cleanSettings(b.settings ?? {}),
          createdBy: user.id,
        })
        .returning();
      await audit(db, "connection.create", {
        actorType: "user",
        actorId: user.id,
        connectionId: conn.id,
        detail: { platform: conn.platform, name: conn.name },
      });
      return connOut(conn);
    }),
  );

  app.patch(
    "/api/connections/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const conn = await getConn(db, params(req).id);
      const b = body(req);
      const update: Partial<Connection> = {};
      if (b.name) update.name = b.name;
      if (b.credentials) {
        const current = conn.credentialsEncrypted ? JSON.parse(secretBox().decrypt(conn.credentialsEncrypted)) : {};
        for (const [k, v] of Object.entries(b.credentials)) if (v) current[k] = v;
        update.credentialsEncrypted = secretBox().encrypt(JSON.stringify(current));
      }
      if (b.settings) update.settings = cleanSettings({ ...conn.settings, ...b.settings });
      if (b.status) {
        if (!["active", "paused"].includes(b.status)) throw new BadRequest("status must be active or paused");
        update.status = b.status;
        update.statusReason = b.status === "active" ? null : `paused by ${user.name}`;
      }
      const [updated] = await db.update(connections).set(update).where(eq(connections.id, conn.id)).returning();
      await audit(db, "connection.update", {
        actorType: "user",
        actorId: user.id,
        connectionId: conn.id,
        detail: { fields: Object.keys(b), status: updated.status },
      });
      return connOut(updated);
    }),
  );

  app.delete(
    "/api/connections/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      await db.delete(connections).where(eq(connections.id, params(req).id));
      await audit(db, "connection.delete", { actorType: "user", actorId: user.id, connectionId: params(req).id });
      return { ok: true };
    }),
  );

  app.post(
    "/api/connections/:id/test",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const conn = await getConn(db, params(req).id);
      try {
        const info = await (await getAdapter(conn)).test(db, conn);
        await db
          .update(connections)
          .set({
            externalWorkspaceId: conn.externalWorkspaceId,
            botUserId: conn.botUserId,
            statusReason: null,
            ...(conn.status === "error" ? { status: "active" } : {}),
          })
          .where(eq(connections.id, conn.id));
        return { ok: true, ...info };
      } catch (err) {
        await db
          .update(connections)
          .set({ status: "error", statusReason: (err as Error).message })
          .where(eq(connections.id, conn.id));
        return { ok: false, error: (err as Error).message };
      }
    }),
  );

  app.get(
    "/api/connections/:id/conversations",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const rows = await db
        .select()
        .from(externalConversations)
        .where(eq(externalConversations.connectionId, params(req).id));
      const out = [];
      for (const c of rows) {
        const [{ n }] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(externalThreadLinks)
          .where(eq(externalThreadLinks.conversationId, c.id));
        out.push({ ...row(c), threads: Number(n) });
      }
      return out;
    }),
  );

  app.patch(
    "/api/connections/:id/conversations/:cid",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const mode = body(req).syncMode;
      if (!["mentions", "all", "off"].includes(mode)) throw new BadRequest("sync_mode must be mentions, all or off");
      const [conv] = await db
        .update(externalConversations)
        .set({ syncMode: mode })
        .where(
          and(eq(externalConversations.id, params(req).cid), eq(externalConversations.connectionId, params(req).id)),
        )
        .returning();
      if (!conv) throw new NotFound("conversation not found");
      await audit(db, "conversation.sync_mode", {
        actorType: "user",
        actorId: user.id,
        connectionId: conv.connectionId,
        detail: { conversation: conv.externalId, sync_mode: mode },
      });
      return row(conv);
    }),
  );

  for (const [path, table, timeCol] of [
    ["outbound", outboundMessages, outboundMessages.createdAt],
    ["inbound", processedEvents, processedEvents.receivedAt],
  ] as const) {
    app.get(
      `/api/connections/:id/${path}`,
      authed(async ({ db, user, req }) => {
        await requirePerm(db, user, Perm.CONNECTION_MANAGE);
        const status = query(req).status;
        const conds = [eq((table as any).connectionId, params(req).id)];
        if (status) conds.push(eq((table as any).status, status));
        return (
          await db
            .select()
            .from(table as any)
            .where(and(...conds))
            .orderBy(desc(timeCol))
            .limit(200)
        ).map(({ payload: _payload, ...r }: any) => row(r)); // queued message text is never listed
      }),
    );
  }

  app.post(
    "/api/outbound/:id/retry",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const [out] = await db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.id, params(req).id))
        .limit(1);
      if (!out) throw new NotFound("delivery not found");
      if (out.status === "sent") throw new BadRequest("already delivered; retrying would post a duplicate");
      const [updated] = await db
        .update(outboundMessages)
        .set({ status: "pending", attempts: 0, lastError: null })
        .where(eq(outboundMessages.id, out.id))
        .returning();
      await audit(db, "outbound.retry", {
        actorType: "user",
        actorId: user.id,
        connectionId: out.connectionId,
        detail: { outbound: out.id },
      });
      await wake(db, "outbound");
      return row(updated);
    }),
  );

  app.post(
    "/api/topics/:id/publish",
    authedNoTx(async ({ db, user, req }) => {
      const topic = await topicSvc.getTopic(db, params(req).id);
      if (!(await topicSvc.isOwner(db, user, topic))) throw new Forbidden("only topic owners can publish a topic");
      if (topic.kind === "dm") throw new BadRequest("DMs cannot be published to a channel");
      const b = body(req);
      const conn = await getConn(db, String(b.connectionId ?? ""));
      await requirePerm(db, user, Perm.TOPIC_PUBLISH, conn.id);
      if (conn.status !== "active") throw new BadRequest("connection is not active");
      const adapter = await getAdapter(conn);
      const channel = String(b.channelId ?? "");
      let [conv] = await db
        .select()
        .from(externalConversations)
        .where(and(eq(externalConversations.connectionId, conn.id), eq(externalConversations.externalId, channel)))
        .limit(1);
      if (!conv) {
        const [kind, name] = adapter.conversationKind
          ? await adapter.conversationKind(db, conn, channel, null)
          : ["private", null];
        [conv] = await db
          .insert(externalConversations)
          .values({ id: newId("conv"), connectionId: conn.id, externalId: channel, kind, name, syncMode: "mentions" })
          .returning();
      }
      if (adapter.syncMembers) await adapter.syncMembers(db, conn, conv, true).catch(() => {});
      [conv] = await db.select().from(externalConversations).where(eq(externalConversations.id, conv.id)).limit(1);
      if (conv.kind !== "public") {
        // Linking a private conversation pulls its replies into the topic: only for its own members.
        const mine = (
          await db
            .select()
            .from(externalIdentities)
            .where(and(eq(externalIdentities.connectionId, conn.id), eq(externalIdentities.userId, user.id)))
        ).map((i) => i.externalUserId);
        if (!conv.membersSyncedAt || !mine.some((m) => conv.memberIds.includes(m)))
          throw new Forbidden("you are not a (verified) member of that conversation");
      }
      const audience = await conversationReaders(db, conv);
      if (!(await isSubset(db, audience, await topicReaders(db, topic.id))) && !b.confirmExpandAudience) {
        throw new BadRequest(
          "the channel's audience is wider than the people who can see this topic now; confirm that the topic may become visible to them",
          {
            code: "audience_expansion",
            detail: { channel_audience: describeReaders(audience), channel_kind: conv.kind },
          },
        );
      }
      const root = await adapter.postRoot(
        conn,
        channel,
        `Topic: ${topic.title}\n${topic.goal}\n(continued from witden; earlier history is not copied)`,
      );
      await transaction(async (tx) => {
        await tx.insert(externalThreadLinks).values({
          id: newId("lnk"),
          connectionId: conn.id,
          conversationId: conv.id,
          threadKey: root,
          topicId: topic.id,
        });
        await audit(tx, "topic.publish", {
          actorType: "user",
          actorId: user.id,
          topicId: topic.id,
          connectionId: conn.id,
          detail: { channel, thread: root, expanded_audience: !!b.confirmExpandAudience },
        });
      });
      return { ok: true, thread_key: root, conversation_id: conv.id };
    }),
  );

  // --- webhooks: no user auth; verified by platform signatures / tokens ---
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req: FastifyRequest, raw: Buffer, done) => {
    // Keep the raw body for signature checks; parse JSON for everything else.
    (req as any).rawBody = raw;
    try {
      done(null, raw.length ? JSON.parse(raw.toString("utf8")) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post("/api/integrations/slack/:id/events", async (req, reply) => {
    const { verifySignature, credentials } = await import("../integrations/slack.js");
    const raw: Buffer = (req as any).rawBody ?? Buffer.from("");
    const conn = await getConn(getDb(), params(req).id);
    if (conn.platform !== "slack") throw new NotFound("unknown connection");
    verifySignature(
      credentials(conn).signing_secret ?? "",
      String(req.headers["x-slack-request-timestamp"] ?? ""),
      raw,
      String(req.headers["x-slack-signature"] ?? ""),
    );
    const payload: any = req.body ?? {};
    if (payload.type === "url_verification") return reply.send({ challenge: payload.challenge });
    if (payload.type !== "event_callback" || conn.status !== "active") return { ok: true };
    if (payload.team_id && conn.externalWorkspaceId && payload.team_id !== conn.externalWorkspaceId)
      throw new Forbidden("event from another workspace");
    await acceptEvents(conn.id, await (await getAdapter(conn)).parse(getDb(), conn, payload));
    return { ok: true };
  });

  app.post("/api/integrations/feishu/:id/events", async (req, reply) => {
    const conn = await getConn(getDb(), params(req).id);
    if (conn.platform !== "feishu") throw new NotFound("unknown connection");
    const adapter = (await getAdapter(conn)) as import("../integrations/feishu.js").FeishuAdapter;
    const payload: any = req.body ?? {};
    adapter.verify(conn, payload);
    if (payload.type === "url_verification") return reply.send({ challenge: payload.challenge });
    if (conn.status !== "active") return { ok: true };
    await acceptEvents(conn.id, await adapter.parse(getDb(), conn, payload));
    return { ok: true };
  });

  app.post(
    "/api/integrations/deliver",
    // No request transaction: delivery claims and updates each record on its own, and calls out to platforms.
    authedNoTx(async ({ db, user }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      return { sent: await deliverPending() };
    }),
  );
}

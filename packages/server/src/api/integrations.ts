/** Chat connections, conversations, deliveries, publishing topics outward, and the platform webhooks. */
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { recheckActiveTasks } from "../agent/revocation.js";
import { type Db, transaction } from "../db/client.js";
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
import { CAPABILITIES, getAdapter } from "../integrations/base.js";
import { deliverPending } from "../integrations/delivery.js";
import { webhookStatus } from "../integrations/webhook-status.js";
import { secretBox } from "../security/crypto.js";
import { conversationReaders, describeReaders, isSubset, topicReaders } from "../security/labels.js";
import { hasPermission, Perm, requirePerm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { wake } from "../services/events.js";
import { webhookBase } from "../services/public-url.js";
import * as topicSvc from "../services/topics.js";
import { authed, authedNoTx, body, params, query, row } from "./http.js";

const PLATFORMS: Record<string, string[]> = {
  slack: ["bot_token", "signing_secret"],
  feishu: ["app_id", "app_secret", "verification_token"],
  // A GitHub App (app_id + private_key) or a bot account (token); checked by checkCredentials.
  github: [],
};
const SETTINGS_KEYS = new Set(["auto_provision_users", "external_role_ids", "custom_identity", "default_sync_mode"]);

/** ``base``: the public address (services/public-url.ts). */
function connOut(conn: Connection, base: string) {
  const creds =
    conn.platform === "github" && conn.credentialsEncrypted
      ? JSON.parse(secretBox().decrypt(conn.credentialsEncrypted))
      : {};
  return {
    ...row(conn),
    // GitHub: acting as an app or as a bot account (never the credentials themselves)
    ...(conn.platform === "github" ? { github_auth: creds.app_id ? "app" : "token" } : {}),
    has_credentials: !!conn.credentialsEncrypted,
    capabilities: CAPABILITIES[conn.platform] ?? {},
    events_url: `${base}/api/integrations/${conn.platform}/${conn.id}/events`,
    // Whether the platform has reached the events URL, and whether its signature matched.
    webhook: webhookStatus(conn.id),
  };
}

/** Pasted credentials often carry stray spaces or line breaks. */
const trimmed = (creds: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, String(v ?? "").trim()]));

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
export async function getConn(db: Db, id: string): Promise<Connection> {
  const [conn] = await db.select().from(connections).where(eq(connections.id, id)).limit(1);
  if (!conn) throw new NotFound("connection not found");
  return conn;
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
      const base = await webhookBase(db);
      return (await db.select().from(connections).orderBy(connections.name)).map((c) => connOut(c, base));
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
      const creds = trimmed(b.credentials ?? {});
      const missing = required.filter((k) => !creds[k]);
      if (missing.length) throw new BadRequest(`missing credentials: ${missing.join(", ")}`);
      if (b.platform === "github") (await import("../integrations/github.js")).checkCredentials(creds);
      if (b.platform === "slack") (await import("../integrations/slack.js")).checkCredentials(creds);
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
      return connOut(conn, await webhookBase(db));
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
        const given = Object.fromEntries(Object.entries(trimmed(b.credentials)).filter(([, v]) => v));
        if (conn.platform === "github") {
          // Switching between a GitHub App and a bot account drops the other way's credentials.
          if (given.token) for (const k of ["app_id", "private_key"]) delete current[k];
          if (given.app_id || given.private_key) delete current.token;
        }
        for (const [k, v] of Object.entries(given)) current[k] = v;
        if (conn.platform === "github") (await import("../integrations/github.js")).checkCredentials(current);
        if (conn.platform === "slack") (await import("../integrations/slack.js")).checkCredentials(given);
        update.credentialsEncrypted = secretBox().encrypt(JSON.stringify(current));
      }
      if (b.settings) update.settings = cleanSettings({ ...conn.settings, ...b.settings });
      if (b.status) {
        if (!["active", "paused"].includes(b.status)) throw new BadRequest("status must be active or paused");
        update.status = b.status;
        update.statusReason = b.status === "active" ? null : `paused by ${user.name}`;
      }
      const [updated] = await db.update(connections).set(update).where(eq(connections.id, conn.id)).returning();
      // Roles taken off the external members' list stop their work at once.
      if (b.settings) await recheckActiveTasks(db, "the connection's settings changed");
      await audit(db, "connection.update", {
        actorType: "user",
        actorId: user.id,
        connectionId: conn.id,
        detail: { fields: Object.keys(b), status: updated.status },
      });
      return connOut(updated, await webhookBase(db));
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
      if (!(await topicSvc.canAdminister(db, user, topic)))
        throw new Forbidden("only console accounts can publish a topic");
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

  app.post(
    "/api/integrations/deliver",
    // No request transaction: delivery claims and updates each record on its own, and calls out to platforms.
    authedNoTx(async ({ db, user }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      return { sent: await deliverPending() };
    }),
  );
}

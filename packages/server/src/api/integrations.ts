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
  roles,
} from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { CAPABILITIES, getAdapter } from "../integrations/base.js";
import { deliverPending } from "../integrations/delivery.js";
import {
  CALLBACK_PATH,
  checkRedirect,
  exchangeCode,
  installProblem,
  installState,
  installWorkspace,
  readState,
} from "../integrations/slack-install.js";
import { slackSockets } from "../integrations/slack-socket.js";
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
  // Socket Mode (app_token) or the events URL (signing_secret); checked by checkCredentials.
  slack: ["bot_token"],
  feishu: ["app_id", "app_secret", "verification_token"],
  // A GitHub App (app_id + private_key) or a bot account (token); checked by checkCredentials.
  github: [],
};
const SETTINGS_KEYS = new Set(["auto_provision_users", "custom_identity", "role_id"]);

const decrypted = (conn: Connection): Record<string, string> =>
  ["github", "slack"].includes(conn.platform) && conn.credentialsEncrypted
    ? JSON.parse(secretBox().decrypt(conn.credentialsEncrypted))
    : {};

/** A Slack connection's app and the workspaces installed through it (integrations/slack-install.ts). */
async function familyOf(db: Db, conn: Connection): Promise<Connection[]> {
  if (conn.platform !== "slack") return [];
  return db
    .select()
    .from(connections)
    .where(conn.installOf ? eq(connections.id, conn.installOf) : eq(connections.installOf, conn.id));
}

/**
 * ``base``: the public address (services/public-url.ts). ``family``: other connections, among them the app a
 * Slack workspace was installed through, or those installed through this one.
 */
function connOut(conn: Connection, base: string, family: Connection[] = []) {
  const creds = decrypted(conn);
  // A workspace installed through another connection's app connects as that app does.
  const app = conn.installOf ? (family.find((c) => c.id === conn.installOf) ?? null) : null;
  const appCreds = app ? decrypted(app) : creds;
  return {
    ...row(conn),
    // How it connects, never the credentials themselves. GitHub: an app or a bot account.
    // none yet while the setup guide is creating the app
    ...(conn.platform === "github" ? { github_auth: creds.app_id ? "app" : creds.token ? "token" : undefined } : {}),
    // Slack: Socket Mode, with the state of this process's socket, or the events URL.
    ...(conn.platform === "slack"
      ? {
          slack_mode: appCreds.app_token ? "socket" : "http",
          socket: slackSockets.state(app?.id ?? conn.id),
          ...(conn.installOf
            ? { app_connection: app ? { id: app.id, name: app.name } : null }
            : {
                // whether it can be installed in more workspaces (OAuth client saved), and where it is
                slack_oauth: !!(creds.client_id && creds.client_secret),
                installs: family
                  .filter((c) => c.installOf === conn.id)
                  .map((c) => ({ id: c.id, name: c.name, team_id: c.externalWorkspaceId })),
              }),
        }
      : {}),
    // a GitHub connection the setup guide created before its app exists has none yet
    has_credentials: Object.values(creds).some(Boolean),
    capabilities: CAPABILITIES[conn.platform] ?? {},
    // Slack sends every workspace's events to the app's address.
    events_url: `${base}/api/integrations/${conn.platform}/${app?.id ?? conn.id}/events`,
    // Whether the platform has reached the events URL, and whether its signature matched.
    webhook: webhookStatus(conn.id),
  };
}

/**
 * A connection's credentials with newly entered ones applied, checked and encrypted. Switching to the other
 * way of connecting drops the credentials of the way left behind.
 */
async function mergedCredentials(conn: Connection, entered: Record<string, unknown>): Promise<string> {
  const current = conn.credentialsEncrypted ? JSON.parse(secretBox().decrypt(conn.credentialsEncrypted)) : {};
  const given = Object.fromEntries(Object.entries(trimmed(entered)).filter(([, v]) => v));
  if (conn.installOf) {
    // A workspace installed through an app holds only its bot token; the rest is the app's.
    const appKeys = Object.keys(given).filter((k) => k !== "bot_token");
    if (appKeys.length) throw new BadRequest(`${appKeys.join(", ")} 属于应用本身，请在应用所在的接入中修改`);
    (await import("../integrations/slack.js")).checkCredentials({ ...current, ...given }, { installed: true });
    return secretBox().encrypt(JSON.stringify({ ...current, ...given }));
  }
  if (conn.platform === "github") {
    if (given.token) for (const k of ["app_id", "private_key"]) delete current[k];
    if (given.app_id || given.private_key) delete current.token;
  }
  if (conn.platform === "slack") {
    if (given.app_token) delete current.signing_secret;
    if (given.signing_secret) delete current.app_token;
  }
  for (const [k, v] of Object.entries(given)) current[k] = v;
  if (conn.platform === "github") (await import("../integrations/github.js")).checkCredentials(current);
  if (conn.platform === "slack") (await import("../integrations/slack.js")).checkCredentials(current);
  return secretBox().encrypt(JSON.stringify(current));
}

/** Pasted credentials often carry stray spaces or line breaks. */
const trimmed = (creds: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, String(v ?? "").trim()]));

async function cleanSettings(db: Db, s: Record<string, any>): Promise<Record<string, any>> {
  const unknown = Object.keys(s).filter((k) => !SETTINGS_KEYS.has(k));
  if (unknown.length) throw new BadRequest(`unknown settings ${unknown.join(", ")}`);
  // The role the connection's bot stands for (null: none chosen yet, so the connection takes no requests).
  if (s.role_id !== undefined && s.role_id !== null && typeof s.role_id !== "string")
    throw new BadRequest("role_id must be a role id or null");
  if (s.role_id) {
    const [role] = await db.select().from(roles).where(eq(roles.id, s.role_id)).limit(1);
    if (!role) throw new NotFound("role not found");
    if (role.systemAdmin)
      throw new BadRequest(`@${role.handle} is a system administrator: it works only in the console, not as a bot`);
  }
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
      const rows = await db.select().from(connections).orderBy(connections.name);
      return rows.map((c) => connOut(c, base, rows));
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
    authed(async ({ db, user, req, after }) => {
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
      // A GitHub App made by the setup guide gets its credentials from GitHub after the connection exists
      // (its webhook URL names the connection): until then the connection has none.
      const pending = b.platform === "github" && !Object.values(creds).some(Boolean);
      if (b.platform === "github" && !pending) (await import("../integrations/github.js")).checkCredentials(creds);
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
          settings: await cleanSettings(db, b.settings ?? {}),
          createdBy: user.id,
        })
        .returning();
      await audit(db, "connection.create", {
        actorType: "user",
        actorId: user.id,
        connectionId: conn.id,
        detail: { platform: conn.platform, name: conn.name },
      });
      after(() => slackSockets.sync());
      return connOut(conn, await webhookBase(db), await familyOf(db, conn));
    }),
  );

  app.patch(
    "/api/connections/:id",
    authed(async ({ db, user, req, after }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const conn = await getConn(db, params(req).id);
      const b = body(req);
      const update: Partial<Connection> = {};
      if (b.name) update.name = b.name;
      if (b.credentials) update.credentialsEncrypted = await mergedCredentials(conn, b.credentials);
      if (b.settings) update.settings = await cleanSettings(db, { ...conn.settings, ...b.settings });
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
      after(() => slackSockets.sync());
      return connOut(updated, await webhookBase(db), await familyOf(db, updated));
    }),
  );

  app.delete(
    "/api/connections/:id",
    authed(async ({ db, user, req, after }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const installed = await db
        .select({ name: connections.name })
        .from(connections)
        .where(eq(connections.installOf, params(req).id));
      if (installed.length)
        throw new BadRequest(`这个应用还安装在 ${installed.map((c) => c.name).join("、")}，请先删除这些接入`);
      await db.delete(connections).where(eq(connections.id, params(req).id));
      await audit(db, "connection.delete", { actorType: "user", actorId: user.id, connectionId: params(req).id });
      after(() => slackSockets.sync());
      return { ok: true };
    }),
  );

  app.post(
    "/api/connections/:id/github-app",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const conn = await getConn(db, params(req).id);
      if (conn.platform !== "github") throw new BadRequest("not a GitHub connection");
      const { convertManifest } = await import("../integrations/github.js");
      const app = await convertManifest(String(body(req).code ?? ""));
      const credentialsEncrypted = await mergedCredentials(conn, {
        app_id: String(app.id),
        private_key: app.pem,
        webhook_secret: app.webhook_secret,
      });
      await db
        .update(connections)
        .set({ credentialsEncrypted, botUserId: app.slug, externalWorkspaceId: String(app.id), statusReason: null })
        .where(eq(connections.id, conn.id));
      await audit(db, "connection.github_app", {
        actorType: "user",
        actorId: user.id,
        connectionId: conn.id,
        detail: { app: app.slug, owner: app.owner },
      });
      // The private key and webhook secret stay on the server.
      return { app: app.slug, name: app.name, html_url: app.html_url, owner: app.owner };
    }),
  );

  // Installing a Slack app in another workspace (integrations/slack-install.ts): the state and redirect
  // address for Slack's authorize page. "public": Slack sends the browser to the public address, which completes
  // the installation; "manual": to any HTTPS address, whose final URL is pasted back (…/complete).
  app.post(
    "/api/connections/:id/slack-install",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const app = await getConn(db, params(req).id);
      if (app.platform !== "slack" || app.installOf)
        throw new BadRequest("请选择持有 Slack 应用的接入（不是通过应用安装的工作区）");
      const creds = decrypted(app);
      if (!creds.client_id || !creds.client_secret) throw new BadRequest("请先保存应用的 Client ID 和 Client Secret");
      const b = body(req);
      let redirect: string;
      if (b.method === "public") {
        redirect = checkRedirect(`${await webhookBase(db)}${CALLBACK_PATH}`);
      } else if (b.method === "manual") {
        redirect = checkRedirect(String(b.redirectUri ?? ""));
      } else throw new BadRequest("method must be public or manual");
      return { client_id: creds.client_id, redirect_uri: redirect, state: installState(app.id, redirect) };
    }),
  );

  app.post(
    "/api/connections/:id/slack-install/complete",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const app = await getConn(db, params(req).id);
      const b = body(req);
      // The address the browser ended up on, or its code and state.
      let code = String(b.code ?? "");
      let state = String(b.state ?? "");
      if (b.url) {
        let q: URLSearchParams;
        try {
          q = new URL(String(b.url).trim()).searchParams;
        } catch {
          throw new BadRequest("请粘贴浏览器地址栏中的完整地址");
        }
        if (q.get("error"))
          throw new BadRequest(q.get("error") === "access_denied" ? "安装已取消" : `Slack 返回：${q.get("error")}`);
        code = q.get("code") ?? "";
        state = q.get("state") ?? "";
      }
      if (!code || !state) throw new BadRequest("这个地址中没有安装代码：请粘贴安装后浏览器停留的页面地址");
      const s = readState(state);
      if (s.app !== app.id) throw new BadRequest("这次安装是为另一个应用发起的");
      let installed: Connection;
      try {
        const inst = await exchangeCode(app, code, s.redirectUri);
        installed = await transaction(async (tx) => {
          const c = await installWorkspace(tx, app, inst, user.id);
          await audit(tx, "connection.slack_install", {
            actorType: "user",
            actorId: user.id,
            connectionId: c.id,
            detail: { app: app.id, team: inst.teamId, via: "pasted" },
          });
          return c;
        });
      } catch (err) {
        if (err instanceof BadRequest) throw err;
        throw new BadRequest(installProblem(err));
      }
      void slackSockets.sync();
      return connOut(installed, await webhookBase(db), await familyOf(db, installed));
    }),
  );

  app.post(
    "/api/connections/:id/test",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const conn = await getConn(db, params(req).id);
      const entered = body(req).credentials;
      if (entered) {
        // Credentials not saved yet (e.g. switching ways): try them, keep the connection as it is.
        try {
          const candidate = { ...conn, credentialsEncrypted: await mergedCredentials(conn, entered) };
          return { ok: true, ...(await (await getAdapter(conn)).test(db, candidate)) };
        } catch (err) {
          if (err instanceof BadRequest) throw err;
          return { ok: false, error: (err as Error).message };
        }
      }
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
        // A Socket Mode connection that just passed connects (again) right away.
        void slackSockets.sync();
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
          .values({ id: newId("conv"), connectionId: conn.id, externalId: channel, kind, name })
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

/** Chat connections, conversations, deliveries and the platform webhooks. */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { recheckActiveTasks } from "../agent/revocation.js";
import { settings } from "../config.js";
import { type Db, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  auditLogs,
  type Connection,
  connections,
  externalConversations,
  externalThreadLinks,
  outboundMessages,
  processedEvents,
  roles,
  type SlackApp,
  slackApps,
} from "../db/schema.js";
import { BadRequest, NotFound } from "../errors.js";
import { CAPABILITIES, getAdapter } from "../integrations/base.js";
import { deliverPending } from "../integrations/delivery.js";
import { checkCredentials as checkFeishu, type FeishuMode, feishuMode } from "../integrations/feishu.js";
import { feishuSockets } from "../integrations/feishu-socket.js";
import {
  baseScopeGranted,
  FEISHU_BASE_SCOPES,
  FEISHU_PRODUCTS,
  grantedScopes,
  productStatus,
} from "../integrations/feishu-tools.js";
import { connectionRoleId } from "../integrations/links.js";
import { parseGrant } from "../integrations/platform-tools.js";
import {
  appCredentials,
  appOf,
  freeAppName,
  getApp,
  mergedAppCredentials,
  splitCredentials,
} from "../integrations/slack-apps.js";
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
import { Perm, requirePerm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { rebindConnectionTopics } from "../services/connection-role.js";
import { wake } from "../services/events.js";
import { webhookBase } from "../services/public-url.js";
import { authed, authedNoTx, body, params, query, row } from "./http.js";

const PLATFORMS: Record<string, string[]> = {
  // Socket Mode (app_token) or the events URL (signing_secret); checked by checkCredentials.
  slack: ["bot_token"],
  // The long connection, or the events URL (also verification_token); checked by checkCredentials.
  feishu: ["app_id", "app_secret"],
  // A GitHub App (app_id + private_key) or a bot account (token); checked by checkCredentials.
  github: [],
};
const SETTINGS_KEYS = new Set(["auto_provision_users", "role_id", "feishu_mode", "bot_requests", "auth_only"]);
/** Settings only one platform's connections have. */
const PLATFORM_SETTINGS: Record<string, string> = {
  feishu_mode: "feishu",
  bot_requests: "feishu",
  auth_only: "github",
};

/** The long connections of Slack apps and Feishu connections follow what was just saved. */
const syncSockets = () => Promise.all([slackSockets.sync(), feishuSockets.sync()]);

const decrypted = (conn: Connection): Record<string, string> =>
  ["github", "slack", "feishu"].includes(conn.platform) && conn.credentialsEncrypted
    ? JSON.parse(secretBox().decrypt(conn.credentialsEncrypted))
    : {};

/** The Slack app of each Slack connection among ``rows`` (or of ``conn``). */
async function appsFor(db: Db, rows: Connection[]): Promise<SlackApp[]> {
  const ids = [...new Set(rows.map((c) => c.slackAppId).filter((x): x is string => !!x))];
  return ids.length ? db.select().from(slackApps).where(inArray(slackApps.id, ids)) : [];
}

/** How a Slack app connects and where it is installed; never its credentials. */
function appOut(app: SlackApp, base: string, workspaces: Connection[]) {
  const creds = appCredentials(app);
  return {
    ...row(app),
    // Socket Mode, with the state of this process's socket, or the events URL.
    slack_mode: creds.app_token ? "socket" : "http",
    socket: slackSockets.state(app.id),
    events_url: `${base}/api/integrations/slack/${app.id}/events`,
    // Whether Slack has reached the events URL, and whether its signature matched.
    webhook: webhookStatus(app.id),
    has_credentials: !!(creds.app_token || creds.signing_secret),
    // whether it can be installed in more workspaces (its OAuth client is saved)
    slack_oauth: !!(creds.client_id && creds.client_secret),
    workspaces: workspaces
      .filter((c) => c.slackAppId === app.id)
      .map((c) => ({ id: c.id, name: c.name, team_id: c.externalWorkspaceId, status: c.status })),
  };
}

/** ``base``: the public address (services/public-url.ts). ``apps``: the Slack apps of the connections shown. */
function connOut(conn: Connection, base: string, apps: SlackApp[] = []) {
  const creds = decrypted(conn);
  // A Slack workspace connects as its app does: the app's socket or events URL.
  const app = conn.slackAppId ? (apps.find((a) => a.id === conn.slackAppId) ?? null) : null;
  const appCreds = app ? appCredentials(app) : {};
  return {
    ...row(conn),
    // How it connects, never the credentials themselves. GitHub: an app or a bot account.
    // none yet while the setup guide is creating the app
    ...(conn.platform === "github" ? { github_auth: creds.app_id ? "app" : creds.token ? "token" : undefined } : {}),
    ...(conn.platform === "slack"
      ? {
          slack_app: app ? { id: app.id, name: app.name } : null,
          slack_mode: appCreds.app_token ? "socket" : "http",
          socket: app ? slackSockets.state(app.id) : null,
        }
      : {}),
    // Feishu: the long connection, with the state of this process's client, or the events URL.
    // and how many requests from other bots in a row it takes (bot_requests) before waiting for a person
    ...(conn.platform === "feishu"
      ? {
          feishu_mode: feishuMode(conn),
          socket: feishuSockets.state(conn.id),
          bot_request_limit: settings().maxAutoRounds,
        }
      : {}),
    // a GitHub connection the setup guide created before its app exists has none yet
    has_credentials: Object.values(creds).some(Boolean),
    capabilities: CAPABILITIES[conn.platform] ?? {},
    // Slack sends every workspace's events to the app's address.
    events_url: `${base}/api/integrations/${conn.platform}/${app?.id ?? conn.id}/events`,
    // Whether the platform has reached the events URL, and whether its signature matched.
    webhook: webhookStatus(app?.id ?? conn.id),
  };
}

/**
 * A connection's credentials with newly entered ones applied, checked and encrypted. Switching to the other
 * way of connecting drops the credentials of the way left behind. ``feishu``: the way a Feishu connection is
 * switching to (default: its current one).
 */
async function mergedCredentials(
  conn: Connection,
  entered: Record<string, unknown>,
  feishu: FeishuMode = feishuMode(conn),
  githubAuthOnly = !!conn.settings.auth_only,
): Promise<string> {
  // Slack: only the workspace's bot token is the connection's; what is the app's is kept on the app.
  const current = conn.credentialsEncrypted ? JSON.parse(secretBox().decrypt(conn.credentialsEncrypted)) : {};
  const given = Object.fromEntries(Object.entries(trimmed(entered)).filter(([, v]) => v));
  if (conn.platform === "github") {
    if (given.token) for (const k of ["app_id", "private_key"]) delete current[k];
    if (given.app_id || given.private_key) delete current.token;
  }
  for (const [k, v] of Object.entries(given)) current[k] = v;
  if (conn.platform === "feishu") {
    // The long connection is authenticated by the app's ID and secret alone.
    if (feishu === "socket") {
      if (given.verification_token)
        throw new BadRequest("verification_token is for the events URL; set feishu_mode to http to use it");
      delete current.verification_token;
    }
    checkFeishu(current, feishu);
  }
  if (conn.platform === "github") (await import("../integrations/github.js")).checkCredentials(current, githubAuthOnly);
  if (conn.platform === "slack") (await import("../integrations/slack.js")).checkCredentials(current);
  return secretBox().encrypt(JSON.stringify(current));
}

/** Pasted credentials often carry stray spaces or line breaks. */
const trimmed = (creds: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, String(v ?? "").trim()]));

async function cleanSettings(db: Db, s: Record<string, any>, platform: string): Promise<Record<string, any>> {
  const unknown = Object.keys(s).filter(
    (k) => !SETTINGS_KEYS.has(k) || (!!PLATFORM_SETTINGS[k] && PLATFORM_SETTINGS[k] !== platform),
  );
  if (unknown.length) throw new BadRequest(`unknown settings ${unknown.join(", ")}`);
  if (s.feishu_mode !== undefined && !["socket", "http"].includes(s.feishu_mode))
    throw new BadRequest("feishu_mode must be socket (long connection) or http (events URL)");
  if (s.bot_requests !== undefined && typeof s.bot_requests !== "boolean")
    throw new BadRequest("bot_requests must be true or false");
  if (s.auth_only !== undefined && typeof s.auth_only !== "boolean")
    throw new BadRequest("auth_only must be true or false");
  // The role the connection's bot stands for, the default of its conversations (null: none chosen yet, so those
  // following it take no requests).
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
      const apps = await appsFor(db, rows);
      return rows.map((c) => connOut(c, base, apps));
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
      const settings = await cleanSettings(db, b.settings ?? {}, b.platform);
      // A GitHub connection that only authenticates the GitHub tools needs no webhook secret.
      if (b.platform === "github" && !pending)
        (await import("../integrations/github.js")).checkCredentials(creds, !!settings.auth_only);
      // Feishu: the long connection unless asked otherwise or given the events URL's verification token.
      if (b.platform === "feishu") {
        settings.feishu_mode ??= creds.verification_token ? "http" : "socket";
        if (settings.feishu_mode === "socket" && creds.verification_token)
          throw new BadRequest("verification_token is for the events URL; set feishu_mode to http to use it");
        checkFeishu(creds, settings.feishu_mode);
      }
      if ((await db.select().from(connections).where(eq(connections.name, b.name)).limit(1)).length)
        throw new BadRequest("a connection with this name exists");
      // Slack: a workspace of an app witden has (slack_app_id), or of a new app made from the app's keys.
      let slackAppId: string | null = null;
      let saved = creds;
      if (b.platform === "slack") {
        const { app: appKeys, workspace } = splitCredentials(creds);
        (await import("../integrations/slack.js")).checkCredentials(workspace);
        saved = workspace;
        if (b.slackAppId) {
          slackAppId = (await getApp(db, String(b.slackAppId))).id;
          if (Object.keys(appKeys).length) throw new BadRequest("the app's keys are changed on the app");
        } else {
          const [made] = await db
            .insert(slackApps)
            .values({
              id: newId("sapp"),
              name: await freeAppName(db, String(b.appName || b.name)),
              credentialsEncrypted: secretBox().encrypt(JSON.stringify(mergedAppCredentials(null, appKeys))),
              createdBy: user.id,
            })
            .returning();
          slackAppId = made.id;
          await audit(db, "slack_app.create", {
            actorType: "user",
            actorId: user.id,
            detail: { app: made.id, name: made.name },
          });
        }
      }
      const [conn] = await db
        .insert(connections)
        .values({
          id: newId("conn"),
          platform: b.platform,
          name: String(b.name),
          slackAppId,
          credentialsEncrypted: secretBox().encrypt(JSON.stringify(saved)),
          settings,
          createdBy: user.id,
        })
        .returning();
      await audit(db, "connection.create", {
        actorType: "user",
        actorId: user.id,
        connectionId: conn.id,
        detail: { platform: conn.platform, name: conn.name },
      });
      after(syncSockets);
      return connOut(conn, await webhookBase(db), await appsFor(db, [conn]));
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
      if (b.settings) update.settings = await cleanSettings(db, { ...conn.settings, ...b.settings }, conn.platform);
      // A Feishu connection changing its way: the credentials are checked (the token dropped) for the new one.
      const feishuTo =
        conn.platform === "feishu" && update.settings ? feishuMode({ settings: update.settings }) : undefined;
      const switching = !!feishuTo && feishuTo !== feishuMode(conn);
      // A GitHub connection becoming a bot again needs its webhook secret.
      const authOnly = !!(update.settings ?? conn.settings).auth_only;
      const githubSwitch = conn.platform === "github" && authOnly !== !!conn.settings.auth_only;
      if (b.credentials || switching || githubSwitch) {
        let entered = trimmed(b.credentials ?? {});
        if (conn.platform === "slack") {
          // The app's keys (e.g. switching it to Socket Mode from a workspace's guide) go to the app.
          const { app: appKeys, workspace } = splitCredentials(entered);
          if (Object.keys(appKeys).length) {
            const slackApp = await appOf(db, conn);
            if (!slackApp) throw new BadRequest("this Slack connection has no app");
            await db
              .update(slackApps)
              .set({
                credentialsEncrypted: secretBox().encrypt(JSON.stringify(mergedAppCredentials(slackApp, appKeys))),
              })
              .where(eq(slackApps.id, slackApp.id));
          }
          entered = workspace;
        }
        if (Object.values(entered).some(Boolean) || switching || githubSwitch)
          update.credentialsEncrypted = await mergedCredentials(conn, entered, feishuTo, authOnly);
      }
      if (b.status) {
        if (!["active", "paused"].includes(b.status)) throw new BadRequest("status must be active or paused");
        update.status = b.status;
        update.statusReason = b.status === "active" ? null : `paused by ${user.name}`;
      }
      const [updated] = Object.keys(update).length
        ? await db.update(connections).set(update).where(eq(connections.id, conn.id)).returning()
        : [conn];
      // A new role for the bot replaces the previous one in the linked conversations that follow it (not in those
      // given a role of their own: services/connection-role.ts).
      const roleFrom = connectionRoleId(conn);
      const roleTo = connectionRoleId(updated);
      if (roleFrom !== roleTo) {
        const rebound = await rebindConnectionTopics(db, updated, user.name);
        await audit(db, "connection.role_change", {
          actorType: "user",
          actorId: user.id,
          connectionId: conn.id,
          detail: { from: roleFrom, to: roleTo, ...rebound },
        });
      }
      // Roles taken off the external members' list, or out of its conversations, stop their work at once.
      if (b.settings) await recheckActiveTasks(db, "the connection's settings changed");
      await audit(db, "connection.update", {
        actorType: "user",
        actorId: user.id,
        connectionId: conn.id,
        detail: { fields: Object.keys(b), status: updated.status },
      });
      after(syncSockets);
      return connOut(updated, await webhookBase(db), await appsFor(db, [updated]));
    }),
  );

  app.delete(
    "/api/connections/:id",
    authed(async ({ db, user, req, after }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      // A Slack workspace only: its app and the app's other workspaces stay as they are.
      await db.delete(connections).where(eq(connections.id, params(req).id));
      // What roles were allowed to do with this Feishu app goes with it.
      for (const r of await db.select().from(roles)) {
        const keep = (xs: string[]) => xs.filter((g) => parseGrant(g)?.connectionId !== params(req).id);
        if (
          keep(r.allowedTools).length !== r.allowedTools.length ||
          keep(r.approvalRequired).length !== r.approvalRequired.length
        )
          await db
            .update(roles)
            .set({ allowedTools: keep(r.allowedTools), approvalRequired: keep(r.approvalRequired) })
            .where(eq(roles.id, r.id));
      }
      await audit(db, "connection.delete", { actorType: "user", actorId: user.id, connectionId: params(req).id });
      after(syncSockets);
      return { ok: true };
    }),
  );

  // What a Feishu app applies for: the base scopes, and each product's for the Feishu tools (the setup guide).
  app.get(
    "/api/integrations/feishu/catalog",
    authed(async ({ db, user }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      return { base: FEISHU_BASE_SCOPES, products: FEISHU_PRODUCTS };
    }),
  );

  // Which of them Feishu has granted this app, asked of Feishu now.
  app.get(
    "/api/connections/:id/feishu-scopes",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const conn = await getConn(db, params(req).id);
      if (conn.platform !== "feishu") throw new BadRequest("not a Feishu connection");
      let granted: Set<string>;
      try {
        granted = await grantedScopes(conn);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      return {
        ok: true,
        granted: [...granted].sort(),
        base: FEISHU_BASE_SCOPES.map((s) => ({
          scope: s.scope,
          name: s.name,
          granted: baseScopeGranted(s.scope, granted),
        })),
        products: productStatus(granted),
      };
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

  // --- Slack apps (integrations/slack-apps.ts) -------------------------------------------------------------

  app.get(
    "/api/slack-apps",
    authed(async ({ db, user }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const base = await webhookBase(db);
      const workspaces = await db.select().from(connections).where(eq(connections.platform, "slack"));
      return (await db.select().from(slackApps).orderBy(slackApps.name)).map((a) => appOut(a, base, workspaces));
    }),
  );

  app.patch(
    "/api/slack-apps/:id",
    authed(async ({ db, user, req, after }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const slackApp = await getApp(db, params(req).id);
      const b = body(req);
      const update: Partial<SlackApp> = {};
      if (b.name && b.name !== slackApp.name) {
        const [taken] = await db
          .select()
          .from(slackApps)
          .where(eq(slackApps.name, String(b.name)))
          .limit(1);
        if (taken) throw new BadRequest("a Slack app with this name exists");
        update.name = String(b.name);
      }
      if (b.credentials) {
        const { app: appKeys, workspace } = splitCredentials(trimmed(b.credentials));
        if (Object.values(workspace).some(Boolean))
          throw new BadRequest("a bot token belongs to a workspace: change it on that workspace's connection");
        update.credentialsEncrypted = secretBox().encrypt(JSON.stringify(mergedAppCredentials(slackApp, appKeys)));
      }
      const [updated] = Object.keys(update).length
        ? await db.update(slackApps).set(update).where(eq(slackApps.id, slackApp.id)).returning()
        : [slackApp];
      await audit(db, "slack_app.update", {
        actorType: "user",
        actorId: user.id,
        detail: { app: slackApp.id, fields: Object.keys(b) },
      });
      after(() => slackSockets.sync());
      const workspaces = await db.select().from(connections).where(eq(connections.slackAppId, slackApp.id));
      return appOut(updated, await webhookBase(db), workspaces);
    }),
  );

  app.delete(
    "/api/slack-apps/:id",
    authed(async ({ db, user, req, after }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const slackApp = await getApp(db, params(req).id);
      const workspaces = await db.select().from(connections).where(eq(connections.slackAppId, slackApp.id));
      if (workspaces.length)
        throw new BadRequest(
          `这个应用还安装在 ${workspaces.map((c) => c.name).join("、")}：先删除这些工作区的接入，再删除应用`,
        );
      await db.delete(slackApps).where(eq(slackApps.id, slackApp.id));
      await audit(db, "slack_app.delete", { actorType: "user", actorId: user.id, detail: { app: slackApp.id } });
      after(() => slackSockets.sync());
      return { ok: true };
    }),
  );

  // Installing an app in another workspace (integrations/slack-install.ts): the state and redirect address for
  // Slack's authorize page. "public": Slack sends the browser to the public address, which completes the
  // installation; "manual": to any HTTPS address, whose final URL is pasted back (…/complete).
  app.post(
    "/api/slack-apps/:id/install",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const slackApp = await getApp(db, params(req).id);
      const creds = appCredentials(slackApp);
      if (!creds.client_id || !creds.client_secret) throw new BadRequest("请先保存应用的 Client ID 和 Client Secret");
      const b = body(req);
      let redirect: string;
      if (b.method === "public") {
        redirect = checkRedirect(`${await webhookBase(db)}${CALLBACK_PATH}`);
      } else if (b.method === "manual") {
        redirect = checkRedirect(String(b.redirectUri ?? ""));
      } else throw new BadRequest("method must be public or manual");
      return { client_id: creds.client_id, redirect_uri: redirect, state: installState(slackApp.id, redirect) };
    }),
  );

  app.post(
    "/api/slack-apps/:id/install/complete",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const slackApp = await getApp(db, params(req).id);
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
      if (s.app !== slackApp.id) throw new BadRequest("这次安装是为另一个应用发起的");
      let installed: Connection;
      try {
        const inst = await exchangeCode(slackApp, code, s.redirectUri);
        installed = await transaction(async (tx) => {
          const c = await installWorkspace(tx, slackApp, inst, user.id);
          await audit(tx, "connection.slack_install", {
            actorType: "user",
            actorId: user.id,
            connectionId: c.id,
            detail: { slack_app: slackApp.id, team: inst.teamId, via: "pasted" },
          });
          return c;
        });
      } catch (err) {
        if (err instanceof BadRequest) throw err;
        throw new BadRequest(installProblem(err));
      }
      void slackSockets.sync();
      return connOut(installed, await webhookBase(db), await appsFor(db, [installed]));
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
          let tried = trimmed(entered);
          let appKeys: Record<string, string> = {};
          if (conn.platform === "slack") {
            // Switching the app's way is tried with the app's keys as they would be after saving.
            const split = splitCredentials(tried);
            const slackApp = await appOf(db, conn);
            appKeys = Object.keys(split.app).length ? mergedAppCredentials(slackApp, split.app) : {};
            tried = split.workspace;
          }
          const own = JSON.parse(secretBox().decrypt(await mergedCredentials(conn, tried)));
          const candidate = {
            ...conn,
            credentialsEncrypted: secretBox().encrypt(JSON.stringify({ ...own, ...appKeys })),
          };
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
        // A Socket Mode or long connection that just passed connects (again) right away.
        void syncSockets();
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

  app.get(
    "/api/connections/:id/diagnostics",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const conn = await getConn(db, params(req).id);
      return (
        await db
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.connectionId, conn.id), eq(auditLogs.action, "integration.error")))
          .orderBy(desc(auditLogs.createdAt))
          .limit(200)
      ).map((r) => row(r));
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
    "/api/integrations/deliver",
    // No request transaction: delivery claims and updates each record on its own, and calls out to platforms.
    authedNoTx(async ({ db, user }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      return { sent: await deliverPending() };
    }),
  );
}

/**
 * One Slack app in more workspaces (OAuth v2). The app is the connection holding its app-level credentials:
 * the app token (Socket Mode) or signing secret (events URL), and the OAuth client id and secret. Every further
 * workspace is a connection of its own, ``install_of`` the app's, keeping only its bot token, its people and
 * its conversations. Events of all workspaces arrive through the app (its socket or its events URL) and are
 * handed to the workspace's connection by team_id.
 *
 * Installing: Slack sends the person's browser back to a redirect address with a one-time code (valid ten
 * minutes) and the state witden made; witden checks the state and exchanges the code (oauth.v2.access, an
 * outgoing call). The redirect address must be HTTPS but need not be reachable by Slack: either the public
 * address's callback (installation completes by itself), or any HTTPS address whose final URL the person
 * pastes back into the console.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type Connection, connections } from "../db/schema.js";
import { BadRequest } from "../errors.js";
import { safeEqual, secretBox } from "../security/crypto.js";
import { credentials, SlackError, slackFetch } from "./slack.js";

const STATE_TTL_MS = 30 * 60_000;
/** Where the public address answers Slack's redirect (api/webhooks.ts). */
export const CALLBACK_PATH = "/api/integrations/slack/oauth";

/** States already used, until they would have expired anyway. */
const used = new Map<string, number>();

/** The state sent to Slack: which app and redirect address, until when; signed, so it cannot be made up. */
export function installState(appConnectionId: string, redirectUri: string, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ c: appConnectionId, r: redirectUri, e: now + STATE_TTL_MS, n: randomBytes(8).toString("hex") }),
  ).toString("base64url");
  return `${body}.${secretBox().proof("slack-install", body)}`;
}

/** The app and redirect address a state was made for. Each state completes one installation. */
export function readState(state: string, now = Date.now()): { app: string; redirectUri: string } {
  const [body, sig] = String(state).split(".");
  if (!body || !sig || !safeEqual(sig, secretBox().proof("slack-install", body)))
    throw new BadRequest("这次安装不是由 witden 发起的（state 校验不通过）");
  const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (typeof s.e !== "number" || s.e < now) throw new BadRequest("安装链接已过期，请在 witden 中重新开始安装");
  for (const [n, until] of used) if (until < now) used.delete(n);
  if (used.has(s.n)) throw new BadRequest("这次安装已经完成过了；需要再装一次时，请在 witden 中重新开始");
  used.set(s.n, s.e);
  return { app: String(s.c), redirectUri: String(s.r) };
}

/** An address Slack accepts as a redirect: HTTPS, no fragment. */
export function checkRedirect(uri: string): string {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new BadRequest("回调地址不是一个网址");
  }
  if (u.protocol !== "https:") throw new BadRequest("Slack 要求回调地址使用 HTTPS");
  if (u.hash) throw new BadRequest("回调地址中不能有 #");
  return u.toString();
}

export interface Installation {
  token: string;
  teamId: string;
  teamName: string;
  botUserId: string;
}

/** Exchange the code Slack handed the browser for the workspace's bot token. */
export async function exchangeCode(app: Connection, code: string, redirectUri: string): Promise<Installation> {
  const creds = credentials(app);
  if (!creds.client_id || !creds.client_secret) throw new BadRequest("还没有保存应用的 Client ID 和 Client Secret");
  if (!/^[\w.-]{8,300}$/.test(code)) throw new BadRequest("缺少安装代码");
  const res = await slackFetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const data: any = await res.json();
  if (!data.ok) throw new SlackError("oauth.v2.access", data.error ?? "unknown_error");
  if (data.is_enterprise_install || !data.team?.id)
    throw new BadRequest("不支持安装到整个 Enterprise Grid 组织，请安装到其中的一个工作区");
  if (!String(data.access_token ?? "").startsWith("xoxb-")) throw new BadRequest("Slack 没有返回机器人令牌");
  return {
    token: data.access_token,
    teamId: String(data.team.id),
    teamName: String(data.team.name ?? data.team.id),
    botUserId: String(data.bot_user_id ?? ""),
  };
}

/** A connection name not taken yet: the workspace's name, else with the app's, else numbered. */
async function freeName(db: Db, team: string, app: string): Promise<string> {
  for (const name of [
    team,
    `${team}（${app}）`,
    ...Array.from({ length: 20 }, (_, i) => `${team}（${app} ${i + 2}）`),
  ]) {
    const [taken] = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.name, name))
      .limit(1);
    if (!taken) return name;
  }
  return `${team} ${randomBytes(3).toString("hex")}`;
}

/**
 * Put an installation in place: the app's own workspace (a reinstall) gets the new bot token; another workspace
 * gets its own connection (new, or the one it already has), standing for the app's role until changed.
 */
export async function installWorkspace(
  db: Db,
  app: Connection,
  inst: Installation,
  by: string | null,
): Promise<Connection> {
  const box = secretBox();
  if (!app.externalWorkspaceId || app.externalWorkspaceId === inst.teamId) {
    const creds = { ...credentials(app), bot_token: inst.token };
    const [updated] = await db
      .update(connections)
      .set({
        credentialsEncrypted: box.encrypt(JSON.stringify(creds)),
        externalWorkspaceId: inst.teamId,
        botUserId: inst.botUserId || app.botUserId,
        statusReason: null,
      })
      .where(eq(connections.id, app.id))
      .returning();
    return updated;
  }
  const values = {
    credentialsEncrypted: box.encrypt(JSON.stringify({ bot_token: inst.token })),
    botUserId: inst.botUserId || null,
    statusReason: null,
  };
  const [existing] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.installOf, app.id), eq(connections.externalWorkspaceId, inst.teamId)))
    .limit(1);
  if (existing) {
    const [updated] = await db
      .update(connections)
      .set({ ...values, ...(existing.status === "error" ? { status: "active" } : {}) })
      .where(eq(connections.id, existing.id))
      .returning();
    return updated;
  }
  const settings = app.settings as Record<string, unknown>;
  const [created] = await db
    .insert(connections)
    .values({
      id: newId("conn"),
      platform: "slack",
      name: await freeName(db, inst.teamName, app.name),
      installOf: app.id,
      externalWorkspaceId: inst.teamId,
      ...values,
      // The same bot in another workspace: the app's role until chosen otherwise; nobody unlinked yet.
      settings: { role_id: settings.role_id ?? null, custom_identity: !!settings.custom_identity },
      createdBy: by,
    })
    .returning();
  return created;
}

/** The connection of the workspace an event of ``app`` came from: the app's own, or one installed through it. */
export async function workspaceConnection(db: Db, app: Connection, teamId: unknown): Promise<Connection> {
  if (typeof teamId !== "string" || !teamId || !app.externalWorkspaceId || teamId === app.externalWorkspaceId)
    return app;
  const [installed] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.installOf, app.id), eq(connections.externalWorkspaceId, teamId)))
    .limit(1);
  // none: the app's own connection refuses it as coming from another workspace
  return installed ?? app;
}

/** Why Slack refused the exchange, for the person installing. */
export function installProblem(err: unknown): string {
  const code = err instanceof SlackError ? err.error : null;
  switch (code) {
    case "invalid_code":
    case "code_already_used":
      return "安装代码已失效：它只能用一次，并且 10 分钟内有效。请重新打开安装页面。";
    case "bad_redirect_uri":
      return "回调地址与开始安装时的不一致，或没有添加到 Slack 应用的 Redirect URLs 中。";
    case "invalid_client_id":
    case "bad_client_secret":
      return "Client ID 或 Client Secret 不正确：请在 Slack 应用的 Basic Information → App Credentials 中重新复制。";
    case null:
      return (err as Error).message;
    default:
      return `Slack 返回 ${code}`;
  }
}

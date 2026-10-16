/**
 * Installing a Slack app (slack-apps.ts) in another workspace with Slack's OAuth v2: the workspace becomes a
 * connection of the app holding its own bot token.
 *
 * Installing: Slack sends the person's browser back to a redirect address with a one-time code (valid ten
 * minutes) and the state witden made; witden checks the state and exchanges the code (oauth.v2.access, an
 * outgoing call). The redirect address must be HTTPS but need not be reachable by Slack: either the public
 * address's callback (installation completes by itself), or any HTTPS address whose final URL the person
 * pastes back into the console.
 */
import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type Connection, connections, type SlackApp, slackApps } from "../db/schema.js";
import { BadRequest } from "../errors.js";
import { safeEqual, secretBox } from "../security/crypto.js";
import { SlackError, slackFetch } from "./slack.js";
import { appCredentials } from "./slack-apps.js";

const STATE_TTL_MS = 30 * 60_000;
/** Where the public address answers Slack's redirect (api/webhooks.ts). */
export const CALLBACK_PATH = "/api/integrations/slack/oauth";

/** States already used, until they would have expired anyway. */
const used = new Map<string, number>();

/** The state sent to Slack: which app and redirect address, until when; signed, so it cannot be made up. */
export function installState(appId: string, redirectUri: string, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ c: appId, r: redirectUri, e: now + STATE_TTL_MS, n: randomBytes(8).toString("hex") }),
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
  /** Slack's id for the app. */
  appId: string | null;
}

/** Exchange the code Slack handed the browser for the workspace's bot token. */
export async function exchangeCode(app: SlackApp, code: string, redirectUri: string): Promise<Installation> {
  const creds = appCredentials(app);
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
    appId: data.app_id ? String(data.app_id) : null,
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
 * Put an installation in place: a workspace the app is already in gets the new bot token; another gets a
 * connection of its own, standing for the role of the app's first workspace until changed.
 */
export async function installWorkspace(
  db: Db,
  app: SlackApp,
  inst: Installation,
  by: string | null,
): Promise<Connection> {
  const box = secretBox();
  if (inst.appId && !app.appId) await db.update(slackApps).set({ appId: inst.appId }).where(eq(slackApps.id, app.id));
  const values = {
    credentialsEncrypted: box.encrypt(JSON.stringify({ bot_token: inst.token })),
    botUserId: inst.botUserId || null,
    statusReason: null,
  };
  const mine = await db
    .select()
    .from(connections)
    .where(eq(connections.slackAppId, app.id))
    .orderBy(asc(connections.createdAt));
  const existing = mine.find((c) => c.externalWorkspaceId === inst.teamId);
  if (existing) {
    const [updated] = await db
      .update(connections)
      .set({ ...values, ...(existing.status === "error" ? { status: "active" } : {}) })
      .where(eq(connections.id, existing.id))
      .returning();
    return updated;
  }
  const first = (mine[0]?.settings ?? {}) as Record<string, unknown>;
  const [created] = await db
    .insert(connections)
    .values({
      id: newId("conn"),
      platform: "slack",
      name: await freeName(db, inst.teamName, app.name),
      slackAppId: app.id,
      externalWorkspaceId: inst.teamId,
      ...values,
      // The same bot in another workspace: the role of the app's first workspace until chosen; nobody unlinked.
      settings: { role_id: first.role_id ?? null, custom_identity: !!first.custom_identity },
      createdBy: by,
    })
    .returning();
  return created;
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

/**
 * Slack apps and the workspaces they are installed in. An app (``slack_apps``) holds what is the app's: the
 * app-level token (Socket Mode) or the signing secret (events URL), and optionally the OAuth client that installs
 * it in more workspaces. Each workspace is a connection (``connections.slack_app_id``) holding its bot token, its
 * people, its conversations and the role its bot stands for. Events of all of an app's workspaces arrive through
 * the app — one socket, or the app's events URL — and go to the workspace's connection by team_id. Deleting a
 * workspace leaves the app and its other workspaces as they are; an app is deleted only once it has none.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type Connection, connections, type SlackApp, slackApps } from "../db/schema.js";
import { BadRequest, NotFound } from "../errors.js";
import { secretBox } from "../security/crypto.js";

/** What belongs to the app rather than to one workspace. */
export const APP_KEYS = ["app_token", "signing_secret", "client_id", "client_secret"];

export function appCredentials(app: SlackApp): Record<string, string> {
  return app.credentialsEncrypted ? JSON.parse(secretBox().decrypt(app.credentialsEncrypted)) : {};
}

/** The keys an app holds: one way to receive events, each key in the shape Slack gives it. */
export function checkAppCredentials(creds: Record<string, string>): void {
  if (creds.app_token && !creds.app_token.startsWith("xapp-"))
    throw new BadRequest("app_token must be an app-level token (xapp-…) with the connections:write scope");
  if (creds.signing_secret && /^(xapp-|xox[a-z]-)/.test(creds.signing_secret))
    throw new BadRequest(
      "signing_secret is a Slack token, not the Signing Secret: copy it from Basic Information → App Credentials",
    );
  if (creds.client_id && !/^\d+\.\d+$/.test(creds.client_id))
    throw new BadRequest("client_id must be the app's Client ID (digits.digits) from Basic Information");
  if (creds.client_secret && /^(xapp-|xox[a-z]-)/.test(creds.client_secret))
    throw new BadRequest("client_secret is a Slack token, not the Client Secret: copy it from Basic Information");
  if (!creds.app_token && !creds.signing_secret)
    throw new BadRequest("an app_token (Socket Mode) or a signing_secret (events URL) is required");
}

/** Entered credentials split into the app's and the workspace's (its bot token). */
export function splitCredentials(creds: Record<string, string>): {
  app: Record<string, string>;
  workspace: Record<string, string>;
} {
  const app: Record<string, string> = {};
  const workspace: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) (APP_KEYS.includes(k) ? app : workspace)[k] = v;
  return { app, workspace };
}

/** An app's credentials with new ones applied, checked; switching ways drops the key of the way left behind. */
export function mergedAppCredentials(app: SlackApp | null, entered: Record<string, string>): Record<string, string> {
  const current = app ? appCredentials(app) : {};
  const given = Object.fromEntries(Object.entries(entered).filter(([, v]) => v));
  if (given.app_token) delete current.signing_secret;
  if (given.signing_secret) delete current.app_token;
  const merged = { ...current, ...given };
  checkAppCredentials(merged);
  return merged;
}

export async function getApp(db: Db, id: string): Promise<SlackApp> {
  const [app] = await db.select().from(slackApps).where(eq(slackApps.id, id)).limit(1);
  if (!app) throw new NotFound("Slack app not found");
  return app;
}

/** The app a Slack connection's workspace is installed in. */
export async function appOf(db: Db, conn: Connection): Promise<SlackApp | null> {
  if (!conn.slackAppId) return null;
  const [app] = await db.select().from(slackApps).where(eq(slackApps.id, conn.slackAppId)).limit(1);
  return app ?? null;
}

/** An app's name not taken yet: as given, else numbered. */
export async function freeAppName(db: Db, name: string): Promise<string> {
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? name : `${name} ${i}`;
    const [taken] = await db.select({ id: slackApps.id }).from(slackApps).where(eq(slackApps.name, candidate)).limit(1);
    if (!taken) return candidate;
  }
  throw new BadRequest("too many Slack apps with this name");
}

/**
 * The connection of the workspace an event of ``app`` came from. A workspace not tested yet (no team known) takes
 * the event when it is the only such one; otherwise an event from a workspace the app is not connected to has
 * none and is refused.
 */
export async function workspaceConnection(db: Db, app: SlackApp, teamId: unknown): Promise<Connection | null> {
  const mine = await db.select().from(connections).where(eq(connections.slackAppId, app.id));
  const team = typeof teamId === "string" ? teamId : "";
  const exact = mine.find((c) => team && c.externalWorkspaceId === team);
  if (exact) return exact;
  const untested = mine.filter((c) => !c.externalWorkspaceId);
  return untested.length === 1 ? untested[0] : null;
}

/** The connection Slack's events URL names: an app (its id), or for addresses made before apps, a workspace. */
export async function appForEvents(db: Db, id: string): Promise<SlackApp | null> {
  const [app] = await db.select().from(slackApps).where(eq(slackApps.id, id)).limit(1);
  if (app) return app;
  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.platform, "slack")))
    .limit(1);
  return conn ? appOf(db, conn) : null;
}

/**
 * Keep each key where it belongs. Migration 0024 copied each app's encrypted credentials whole from the
 * connection it came from; at start the app keeps its keys and the connection only its bot token. A Slack
 * connection without an app (none should remain) gets one from its own keys.
 */
export async function normalizeSlackApps(db: Db): Promise<void> {
  const box = secretBox();
  for (const app of await db.select().from(slackApps)) {
    const creds = appCredentials(app);
    if (!("bot_token" in creds)) continue;
    delete creds.bot_token;
    await db
      .update(slackApps)
      .set({ credentialsEncrypted: box.encrypt(JSON.stringify(creds)) })
      .where(eq(slackApps.id, app.id));
  }
  for (const conn of await db.select().from(connections).where(eq(connections.platform, "slack"))) {
    const creds: Record<string, string> = conn.credentialsEncrypted
      ? JSON.parse(box.decrypt(conn.credentialsEncrypted))
      : {};
    const { app, workspace } = splitCredentials(creds);
    if (!Object.keys(app).length && conn.slackAppId) continue;
    let appId = conn.slackAppId;
    if (!appId && Object.keys(app).length) {
      [{ id: appId }] = await db
        .insert(slackApps)
        .values({
          id: conn.id,
          name: await freeAppName(db, conn.name),
          credentialsEncrypted: box.encrypt(JSON.stringify(app)),
          createdBy: conn.createdBy,
        })
        .returning({ id: slackApps.id });
    }
    await db
      .update(connections)
      .set({ slackAppId: appId, credentialsEncrypted: box.encrypt(JSON.stringify(workspace)) })
      .where(eq(connections.id, conn.id));
  }
}

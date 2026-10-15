/**
 * Slack adapter: Events API in (over Socket Mode, or HTTP to the events URL), Web API out.
 *
 * A Slack thread (root message + replies) is one topic; a 1:1 DM with the bot is one topic. One bot user fronts
 * any number of roles; replies carry the role's name (and icon with ``chat:write.customize``) so people
 * always see which role is speaking. Files a role shares are uploaded to Slack (``files:write``): the console
 * is not reachable from Slack, so a link to it would not open there.
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { type Db, db as getDb } from "../db/client.js";
import {
  type Artifact,
  artifacts,
  type Connection,
  type ExternalConversation,
  externalConversations,
  externalIdentities,
  type Message,
  type OutboundMessage,
  roles,
  users,
} from "../db/schema.js";
import { BadRequest, Forbidden, Unauthorized } from "../errors.js";
import { safeEqual, secretBox } from "../security/crypto.js";
import { absoluteAvatarUrl } from "../services/appearance.js";
import { artifactPath } from "../services/files.js";
import { consoleBase, webhookBase } from "../services/public-url.js";
import { type Adapter, CHANNEL, getAdapter, type InboundAction, register } from "./base.js";
import { escapeSlack, fromSlack, toSlack } from "./slack-format.js";
import { noteWebhook } from "./webhook-status.js";

const API = "https://slack.com/api/";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MEMBERS_TTL_MS = 10 * 60_000;
const KIND: Record<string, string> = { channel: "public", group: "private", im: "im", mpim: "mpim" };
const USER_NAME_TTL_MS = 60 * 60_000;
const userNames = new Map<string, { name: string | null; at: number }>();

/** Tests replace this to intercept HTTP. */
export let slackFetch: typeof fetch = (...args) => fetch(...args);
export function setSlackFetch(fn: typeof fetch): void {
  slackFetch = fn;
}

export function credentials(conn: Connection): Record<string, string> {
  return conn.credentialsEncrypted ? JSON.parse(secretBox().decrypt(conn.credentialsEncrypted)) : {};
}

export class SlackError extends Error {
  constructor(
    method: string,
    readonly error: string,
  ) {
    super(`Slack ${method} failed: ${error}`);
  }
}

export class SlackClient {
  /** The token's scopes, as Slack reports them on each response (x-oauth-scopes). */
  scopes: string[] | null = null;

  constructor(private readonly token: string) {}

  private async request(method: string, init: RequestInit): Promise<any> {
    const res = await slackFetch(API + method, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.token}` },
    });
    const scopes = res.headers.get("x-oauth-scopes");
    if (scopes !== null)
      this.scopes = scopes
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    if (res.status === 429)
      throw new Error(`rate limited by Slack (retry after ${res.headers.get("retry-after") ?? "?"}s)`);
    const data: any = await res.json();
    if (!data.ok) throw new SlackError(method, data.error ?? "unknown_error");
    return data;
  }

  call(method: string, params: Record<string, unknown>) {
    return this.request(method, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(params),
    });
  }

  get(method: string, params: Record<string, string | number>) {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
    return this.request(`${method}?${qs}`, { method: "GET" });
  }

  /** Upload a file's bytes (files:write); it is shared only by files.completeUploadExternal. Returns its id. */
  async upload(filename: string, data: Buffer): Promise<string> {
    const { upload_url, file_id } = await this.call("files.getUploadURLExternal", { filename, length: data.length });
    // The bytes themselves, not a form; the address is single-use and needs no token.
    const res = await slackFetch(upload_url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(data),
    });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    return file_id;
  }

  async download(url: string, limit: number): Promise<Buffer | null> {
    const res = await slackFetch(url, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > limit ? null : buf;
  }
}

/** Socket Mode (an app-level token) or HTTP to the events URL (a signing secret). */
export const slackMode = (creds: Record<string, string>): "socket" | "http" => (creds.app_token ? "socket" : "http");

/**
 * Check Slack credentials when they are entered, catching the usual mix-ups: Slack shows several tokens and
 * secrets, and an app-level token (xapp-) saved as the signing secret fails every event's signature check.
 */
export function checkCredentials(creds: Record<string, string>): void {
  if (creds.bot_token && !creds.bot_token.startsWith("xoxb-"))
    throw new BadRequest("bot_token must be the Bot User OAuth Token (xoxb-…) from OAuth & Permissions");
  if (creds.app_token && !creds.app_token.startsWith("xapp-"))
    throw new BadRequest("app_token must be an app-level token (xapp-…) with the connections:write scope");
  if (creds.signing_secret && /^(xapp-|xox[a-z]-)/.test(creds.signing_secret))
    throw new BadRequest(
      "signing_secret is a Slack token, not the Signing Secret: copy it from Basic Information → App Credentials",
    );
  if (!creds.app_token && !creds.signing_secret)
    throw new BadRequest("an app_token (Socket Mode) or a signing_secret (events URL) is required");
}

/**
 * A Slack Events API payload, from the events URL or a Socket Mode socket: checked against the connection
 * and queued for processing.
 */
export async function acceptSlackEvent(conn: Connection, payload: any): Promise<void> {
  if (payload?.type !== "event_callback" || conn.status !== "active") return;
  if (payload.team_id && conn.externalWorkspaceId && payload.team_id !== conn.externalWorkspaceId)
    throw new Forbidden("event from another workspace");
  noteWebhook(conn.id, "received");
  const { acceptEvents } = await import("./inbound.js");
  await acceptEvents(conn.id, await (await getAdapter(conn)).parse(getDb(), conn, payload));
}

/** Slack request signing (v0). Old timestamps are rejected to stop replays. */
export function verifySignature(
  signingSecret: string,
  timestamp: string,
  body: Buffer,
  signature: string,
  now = Date.now() / 1000,
): void {
  if (!signingSecret) throw new Unauthorized("connection has no signing secret");
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) throw new Unauthorized("missing Slack timestamp");
  if (Math.abs(now - ts) > 300) throw new Unauthorized("stale Slack request");
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
  if (!safeEqual(expected, signature ?? "")) throw new Unauthorized("bad Slack signature");
}

/** Incoming Slack text as witden Markdown: no bot mention, people mentioned by their names. */
export async function clean(db: Db, conn: Connection, text: string): Promise<string> {
  let out = text;
  if (conn.botUserId) out = out.split(`<@${conn.botUserId}>`).join("");
  const ids = [...new Set([...out.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
  const names = new Map<string, string>();
  if (ids.length) {
    const known = await db
      .select({ ext: externalIdentities.externalUserId, display: externalIdentities.displayName, name: users.name })
      .from(externalIdentities)
      .leftJoin(users, eq(users.id, externalIdentities.userId))
      .where(and(eq(externalIdentities.connectionId, conn.id), inArray(externalIdentities.externalUserId, ids)));
    for (const k of known) if (k.name || k.display) names.set(k.ext, (k.name ?? k.display) as string);
  }
  return fromSlack(out, names).trim();
}

/** Why Slack would not take a file, for the people in the conversation. */
const UPLOAD_PROBLEMS: Record<string, string> = {
  missing_scope: "Slack 应用缺少 files:write 权限，请在应用的 OAuth & Permissions 中添加并重新安装",
  not_in_channel: "机器人不在这个频道",
  file_type_not_allowed: "工作区不允许上传这种文件",
};
const uploadProblem = (err: unknown) =>
  err instanceof SlackError
    ? (UPLOAD_PROBLEMS[err.error] ?? `Slack 返回 ${err.error}`)
    : (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "witden 中的文件已不存在"
      : (err as Error).message;

/** Files as links into witden; they open only where the console is reachable, so the reason goes with them. */
function fileLinks(files: Artifact[], why: string): string {
  const lines = files.map(
    (f) => `${f.mime.startsWith("image/") ? "🖼" : "📎"} <${consoleBase()}/api/files/${f.id}|${escapeSlack(f.name)}>`,
  );
  return `${lines.join("\n")}\n_附件没能发到 Slack：${escapeSlack(why)}_`;
}

/** Scopes the setup guide's manifest asks for that older apps may lack. */
const CHECKED_SCOPES = ["chat:write", "files:write"];

/** Prefix a message with who wrote it; multi-line bodies start on their own line. */
const signed = (who: string, text: string) => `${who}:${text.includes("\n") ? "\n" : " "}${text}`;

export class SlackAdapter implements Adapter {
  platform = "slack";

  client(conn: Connection): SlackClient {
    const token = credentials(conn).bot_token;
    if (!token) throw new BadRequest("Slack connection has no bot token");
    return new SlackClient(token);
  }

  async test(_db: Db, conn: Connection) {
    const client = this.client(conn);
    const data = await client.call("auth.test", {});
    // Socket Mode: the app-level token must be able to open a socket (it needs connections:write).
    const appToken = credentials(conn).app_token;
    if (appToken) await new SlackClient(appToken).call("apps.connections.open", {});
    conn.externalWorkspaceId = data.team_id;
    conn.botUserId = data.user_id;
    const scopes = client.scopes;
    return {
      team: data.team,
      team_id: data.team_id,
      bot_user_id: data.user_id,
      bot: data.user,
      // Granted scopes come back on every response; an app created before a scope was added lacks it.
      missing_scopes: scopes ? CHECKED_SCOPES.filter((x) => !scopes.includes(x)) : [],
    };
  }

  private async render(
    db: Db,
    conn: Connection,
    msg: Message,
    refused: { files: Artifact[]; why: string } | null = null,
  ): Promise<[string, Record<string, string>]> {
    const base = consoleBase();
    // System notices are plain text; everything else is Markdown written for the console.
    let text =
      msg.authorType === "system"
        ? msg.content
            .split("\n")
            .map((l) => (l.trim() ? `_${escapeSlack(l.trim())}_` : l))
            .join("\n")
        : toSlack(msg.content, { baseUrl: base, viewUrl: `${base}/topics/${msg.topicId}` });
    const extra: Record<string, string> = {};
    for (const m of msg.mentions ?? []) {
      if (m.type !== "user") continue;
      const [ident] = await db
        .select()
        .from(externalIdentities)
        .where(and(eq(externalIdentities.connectionId, conn.id), eq(externalIdentities.userId, m.id)))
        .limit(1);
      const [user] = await db.select().from(users).where(eq(users.id, m.id)).limit(1);
      if (ident && user) text = text.split(`@${user.name}`).join(`<@${ident.externalUserId}>`);
    }
    // Attachments are uploaded (send); only files Slack refused appear here, as links with the reason.
    if (refused?.files.length) text += `${text ? "\n" : ""}${fileLinks(refused.files, refused.why)}`;
    if (msg.authorType === "role") {
      const [role] = msg.authorId ? await db.select().from(roles).where(eq(roles.id, msg.authorId)).limit(1) : [];
      const name = role ? `${role.name} (@${role.handle})` : "role";
      // A bot that stands for this role needs no name: its own name and icon say who speaks.
      const ownRole = !!role && role.id === conn.settings.role_id;
      if (!ownRole && conn.settings.custom_identity) {
        extra.username = name;
        // Slack fetches the icon itself, through the public address (avatars are served on the webhook listener).
        const icon = absoluteAvatarUrl(role?.avatarUrl, await webhookBase(db));
        if (icon) extra.icon_url = icon;
      } else if (!ownRole) text = signed(`*${escapeSlack(name)}*`, text);
    } else if (msg.authorType === "user") {
      const [user] = msg.authorId ? await db.select().from(users).where(eq(users.id, msg.authorId)).limit(1) : [];
      text = signed(`*${escapeSlack(user?.name ?? "member")}* (witden)`, text);
    }
    return [text, extra];
  }

  async send(db: Db, conn: Connection, out: OutboundMessage, msg: Message): Promise<string | null> {
    const client = this.client(conn);
    // Only files of this topic go out (attachments are checked when a message is posted; this keeps it so).
    const files = msg.attachments?.length
      ? await db
          .select()
          .from(artifacts)
          .where(
            and(
              inArray(artifacts.id, msg.attachments),
              eq(artifacts.topicId, msg.topicId),
              isNull(artifacts.deletedAt),
            ),
          )
      : [];
    // Upload the files first: if Slack will not take them, the message carries links and the reason instead.
    const uploaded: { id: string; title: string }[] = [];
    let why: string | null = null;
    for (const f of files) {
      try {
        uploaded.push({ id: await client.upload(f.name, fs.readFileSync(artifactPath(f))), title: f.name });
      } catch (err) {
        why = uploadProblem(err);
        break;
      }
    }
    const [text, extra] = await this.render(db, conn, msg, why ? { files, why } : null);
    const where: Record<string, unknown> = { channel: out.conversationExternalId };
    if (out.threadKey) where.thread_ts = out.threadKey;
    // No previews: Slack would fetch whatever address the text links to, images included.
    const ts = text.trim()
      ? await this.post(client, { ...where, text, unfurl_links: false, unfurl_media: false }, extra)
      : null;
    if (uploaded.length && !why) {
      try {
        // Shared where the message went: in the same thread, or right below it in the channel.
        await client.call("files.completeUploadExternal", {
          files: uploaded,
          channel_id: out.conversationExternalId,
          ...(out.threadKey ? { thread_ts: out.threadKey } : {}),
        });
      } catch (err) {
        // The message is already out: say what became of its files rather than sending it again (a failed
        // notice is dropped for the same reason).
        await client
          .call("chat.postMessage", {
            ...where,
            text: fileLinks(files, uploadProblem(err)),
            unfurl_links: false,
            unfurl_media: false,
          })
          .catch(() => undefined);
      }
    }
    return ts;
  }

  private async post(
    client: SlackClient,
    params: Record<string, unknown>,
    extra: Record<string, string>,
  ): Promise<string> {
    try {
      return (await client.call("chat.postMessage", { ...params, ...extra })).ts;
    } catch (err) {
      if (
        Object.keys(extra).length &&
        err instanceof SlackError &&
        ["missing_scope", "not_allowed_token_type"].includes(err.error)
      ) {
        // No chat:write.customize: fall back to a visible name prefix rather than losing the identity.
        const text2 = signed(`*${escapeSlack(extra.username)}*`, String(params.text ?? ""));
        return (await client.call("chat.postMessage", { ...params, text: text2 })).ts;
      }
      throw err;
    }
  }

  async postRoot(conn: Connection, channel: string, text: string): Promise<string> {
    return (
      await this.client(conn).call("chat.postMessage", { channel, text, unfurl_links: false, unfurl_media: false })
    ).ts;
  }

  async reply(conn: Connection, channel: string, thread: string, text: string): Promise<void> {
    const params: Record<string, unknown> = { channel, text };
    if (thread && thread !== "__dm__") params.thread_ts = thread;
    await this.client(conn).call("chat.postMessage", params);
  }

  async fetchFile(conn: Connection, f: Record<string, any>): Promise<Buffer | null> {
    if ((f.size ?? 0) > MAX_FILE_BYTES || !f.url_private) return null;
    return this.client(conn).download(f.url_private, MAX_FILE_BYTES);
  }

  /**
   * A conversation's kind and name. Events carry the kind (channel_type) but never the name, so the name is
   * asked for once and then kept with the conversation.
   */
  async conversationKind(
    db: Db,
    conn: Connection,
    channel: string,
    hint: string | null,
  ): Promise<[string, string | null]> {
    const [conv] = await db
      .select()
      .from(externalConversations)
      .where(and(eq(externalConversations.connectionId, conn.id), eq(externalConversations.externalId, channel)))
      .limit(1);
    if (conv && (conv.name || conv.kind === "im")) return [conv.kind, conv.name];
    if (hint === "im") return ["im", null];
    try {
      const info = (await this.client(conn).get("conversations.info", { channel })).channel;
      if (info.is_im) return ["im", null];
      if (info.is_mpim) return ["mpim", info.name];
      return [info.is_private ? "private" : "public", info.name];
    } catch (err) {
      // Without the name (e.g. a missing scope) the conversation still works, titled by its id.
      if (conv) return [conv.kind, null];
      if (hint && KIND[hint]) return [KIND[hint], null];
      throw err;
    }
  }

  /** A person's name in the workspace, asked for once an hour at most; null when Slack does not say. */
  private async userName(conn: Connection, userId: string): Promise<string | null> {
    const key = `${conn.id}:${userId}`;
    const known = userNames.get(key);
    if (known && Date.now() - known.at < USER_NAME_TTL_MS) return known.name;
    let name: string | null = null;
    try {
      const user = (await this.client(conn).get("users.info", { user: userId })).user;
      name = user?.profile?.display_name || user?.real_name || user?.name || null;
    } catch {
      // keep the id: names are only for display
    }
    userNames.set(key, { name, at: Date.now() });
    return name;
  }

  /** Private conversations: their member list defines who can see what is posted there. */
  async syncMembers(db: Db, conn: Connection, conv: ExternalConversation, force = false): Promise<void> {
    if (conv.kind === "public") return;
    if (!force && conv.membersSyncedAt && Date.now() - conv.membersSyncedAt.getTime() < MEMBERS_TTL_MS) return;
    const members: string[] = [];
    let cursor: string | undefined;
    const client = this.client(conn);
    do {
      const data = await client.get("conversations.members", {
        channel: conv.externalId,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      members.push(...(data.members ?? []));
      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);
    await db
      .update(externalConversations)
      .set({ memberIds: members.filter((m) => m !== conn.botUserId), membersSyncedAt: new Date() })
      .where(eq(externalConversations.id, conv.id));
  }

  /** Translate an event_callback into actions. */
  async parse(db: Db, conn: Connection, payload: any): Promise<InboundAction[]> {
    const event = payload?.event ?? {};
    if (!["app_mention", "message"].includes(event.type)) return [];
    const subtype = event.subtype;
    const channel = event.channel ?? "";
    if (subtype === "message_changed") {
      const next = event.message ?? {};
      if (next.bot_id || next.user === conn.botUserId) return [];
      return [
        {
          kind: "edit",
          connectionId: conn.id,
          conversationId: channel,
          ts: next.ts,
          text: await clean(db, conn, next.text ?? ""),
        },
      ];
    }
    if (subtype === "message_deleted")
      return [{ kind: "delete", connectionId: conn.id, conversationId: channel, ts: event.deleted_ts }];
    if (subtype && !["file_share", "thread_broadcast"].includes(subtype)) return [];
    // Never react to bots, ourselves included: that is how reply loops start.
    if (event.bot_id || !event.user || event.user === conn.botUserId || subtype === "bot_message") return [];
    const [kind, name] = await this.conversationKind(db, conn, channel, event.channel_type ?? null);
    const text = event.text ?? "";
    const addressed =
      event.type === "app_mention" || kind === "im" || (!!conn.botUserId && text.includes(`<@${conn.botUserId}>`));
    const ts = event.ts ?? "";
    return [
      {
        kind: "message",
        message: {
          connectionId: conn.id,
          // Keyed by message (not event id): app_mention and message events for one post collapse into one.
          eventKey: `msg:${channel}:${ts}`,
          conversationId: channel,
          conversationKind: kind,
          conversationName: name,
          threadKey: kind === "im" ? "__dm__" : (event.thread_ts ?? ts),
          // A channel is one topic, as Slack shows it; its threads stay visible as replies.
          ...(kind === "im" ? {} : { topicKey: CHANNEL }),
          messageTs: ts,
          userId: event.user,
          userName: await this.userName(conn, event.user),
          text: await clean(db, conn, text),
          addressed,
          files: (event.files ?? []).map((f: any) => ({
            name: f.name,
            size: f.size,
            url_private: f.url_private_download ?? f.url_private,
            mimetype: f.mimetype,
          })),
        },
      },
    ];
  }
}

register("slack", () => new SlackAdapter());

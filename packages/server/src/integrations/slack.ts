/**
 * Slack adapter: Events API in, Web API out.
 *
 * A Slack thread (root message + replies) is one topic; a 1:1 DM with the bot is one topic. One bot user fronts
 * any number of roles; replies carry the role's name (and icon with ``chat:write.customize``) so people
 * always see which role is speaking.
 */
import { createHmac } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import {
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
import { BadRequest, Unauthorized } from "../errors.js";
import { safeEqual, secretBox } from "../security/crypto.js";
import { absoluteAvatarUrl } from "../services/appearance.js";
import { type Adapter, type InboundAction, register } from "./base.js";
import { escapeSlack, fromSlack, toSlack } from "./slack-format.js";

const API = "https://slack.com/api/";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MEMBERS_TTL_MS = 10 * 60_000;
const KIND: Record<string, string> = { channel: "public", group: "private", im: "im", mpim: "mpim" };

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
  constructor(private readonly token: string) {}

  private async request(method: string, init: RequestInit): Promise<any> {
    const res = await slackFetch(API + method, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.token}` },
    });
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

  async download(url: string, limit: number): Promise<Buffer | null> {
    const res = await slackFetch(url, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > limit ? null : buf;
  }
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
    const data = await this.client(conn).call("auth.test", {});
    conn.externalWorkspaceId = data.team_id;
    conn.botUserId = data.user_id;
    return { team: data.team, team_id: data.team_id, bot_user_id: data.user_id, bot: data.user };
  }

  private async render(db: Db, conn: Connection, msg: Message): Promise<[string, Record<string, string>]> {
    const base = settings().publicUrl.replace(/\/+$/, "");
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
    if (msg.attachments?.length) {
      // Links into witden (signing in shows the file); pictures are marked so people know what to expect.
      const files = await db.select().from(artifacts).where(inArray(artifacts.id, msg.attachments));
      const byId = new Map(files.map((f) => [f.id, f]));
      const links = msg.attachments.map((a) => {
        const f = byId.get(a);
        const icon = f?.mime.startsWith("image/") ? "🖼" : "📎";
        return `${icon} <${base}/api/files/${a}|${escapeSlack(f?.name ?? "文件")}>`;
      });
      text += `${text ? "\n" : ""}${links.join("\n")}`;
    }
    if (msg.authorType === "role") {
      const [role] = msg.authorId ? await db.select().from(roles).where(eq(roles.id, msg.authorId)).limit(1) : [];
      const name = role ? `${role.name} (@${role.handle})` : "role";
      if (conn.settings.custom_identity) {
        extra.username = name;
        // Slack fetches the icon itself: uploaded avatars need the platform's public address.
        const icon = absoluteAvatarUrl(role?.avatarUrl);
        if (icon) extra.icon_url = icon;
      } else text = signed(`*${escapeSlack(name)}*`, text);
    } else if (msg.authorType === "user") {
      const [user] = msg.authorId ? await db.select().from(users).where(eq(users.id, msg.authorId)).limit(1) : [];
      text = signed(`*${escapeSlack(user?.name ?? "member")}* (witden)`, text);
    }
    return [text, extra];
  }

  async send(db: Db, conn: Connection, out: OutboundMessage, msg: Message): Promise<string | null> {
    const client = this.client(conn);
    const [text, extra] = await this.render(db, conn, msg);
    const params: Record<string, unknown> = { channel: out.conversationExternalId, text, unfurl_links: false };
    if (out.threadKey) params.thread_ts = out.threadKey;
    try {
      return (await client.call("chat.postMessage", { ...params, ...extra })).ts;
    } catch (err) {
      if (
        Object.keys(extra).length &&
        err instanceof SlackError &&
        ["missing_scope", "not_allowed_token_type"].includes(err.error)
      ) {
        // No chat:write.customize: fall back to a visible name prefix rather than losing the identity.
        const text2 = signed(`*${escapeSlack(extra.username)}*`, text);
        return (await client.call("chat.postMessage", { ...params, text: text2 })).ts;
      }
      throw err;
    }
  }

  async postRoot(conn: Connection, channel: string, text: string): Promise<string> {
    return (await this.client(conn).call("chat.postMessage", { channel, text, unfurl_links: false })).ts;
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

  async conversationKind(
    db: Db,
    conn: Connection,
    channel: string,
    hint: string | null,
  ): Promise<[string, string | null]> {
    if (hint && KIND[hint]) return [KIND[hint], null];
    const [conv] = await db
      .select()
      .from(externalConversations)
      .where(and(eq(externalConversations.connectionId, conn.id), eq(externalConversations.externalId, channel)))
      .limit(1);
    if (conv) return [conv.kind, conv.name];
    const info = (await this.client(conn).get("conversations.info", { channel })).channel;
    if (info.is_im) return ["im", null];
    if (info.is_mpim) return ["mpim", info.name];
    return [info.is_private ? "private" : "public", info.name];
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
          messageTs: ts,
          userId: event.user,
          userName: null,
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

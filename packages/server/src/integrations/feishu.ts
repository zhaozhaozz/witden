/**
 * Feishu adapter (experimental): text messages in groups and bot DMs. Files and edits are not synchronised.
 * Events arrive over the long connection witden keeps open (feishu-socket.ts) or at the events URL.
 */
import { and, eq } from "drizzle-orm";
import { type Db, db as getDb } from "../db/client.js";
import {
  type Connection,
  type ExternalConversation,
  externalConversations,
  type Message,
  type OutboundMessage,
  roles,
  users,
} from "../db/schema.js";
import { BadRequest, Unauthorized } from "../errors.js";
import { safeEqual, secretBox } from "../security/crypto.js";
import { type Adapter, CHANNEL, type InboundAction, register } from "./base.js";
import { noteWebhook } from "./webhook-status.js";

const API = "https://open.feishu.cn/open-apis/";
const tokenCache = new Map<string, { token: string; expires: number }>();

// Names are only for display, looked up while an event waits for its answer (Feishu allows 3 s): each lookup
// gives up quickly, and what is known (or known to be missing) is kept for a while.
const LOOKUP_MS = 1500;
const NAME_TTL_MS = 60 * 60_000;
const MEMBERS_TTL_MS = 10 * 60_000;
const names = new Map<string, { name: string | null; at: number }>();
const chatNames = new Map<string, { name: string | null; at: number }>();
const memberLists = new Map<string, { members: { id: string; name: string | null }[]; at: number }>();

function known<T>(cache: Map<string, { at: number } & T>, key: string, ttl: number): T | undefined {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < ttl ? hit : undefined;
}

export let feishuFetch: typeof fetch = (...args) => fetch(...args);
export function setFeishuFetch(fn: typeof fetch): void {
  feishuFetch = fn;
}

export function credentials(conn: Connection): Record<string, string> {
  return conn.credentialsEncrypted ? JSON.parse(secretBox().decrypt(conn.credentialsEncrypted)) : {};
}

/**
 * How a connection receives events: "socket", over the long connection witden opens with the app's ID and
 * secret (no public address); "http", pushed to the events URL and checked with the verification token.
 * Connections made before there was a choice use the events URL.
 */
export type FeishuMode = "socket" | "http";
export const feishuMode = (conn: Pick<Connection, "settings">): FeishuMode =>
  conn.settings?.feishu_mode === "socket" ? "socket" : "http";

/** A Feishu App ID; the SDK's long connection refuses any other form without a word. */
export const APP_ID = /^cli_[0-9a-f]{16}$/i;

/** The credentials a way of receiving events needs; the verification token is the events URL's only. */
export function checkCredentials(creds: Record<string, string>, mode: FeishuMode): void {
  const missing = ["app_id", "app_secret", ...(mode === "http" ? ["verification_token"] : [])].filter((k) => !creds[k]);
  if (missing.length) throw new BadRequest(`missing credentials: ${missing.join(", ")}`);
  if (mode === "socket" && !APP_ID.test(creds.app_id))
    throw new BadRequest("app_id must be the App ID on the app's 凭证与基础信息 page: cli_ and 16 hex digits");
}

/** A Feishu event from the events URL (verified there) or the long connection: queued for processing. */
export async function acceptFeishuEvent(conn: Connection, payload: any): Promise<void> {
  noteWebhook(conn.id, "received");
  if (conn.status !== "active") return;
  const { acceptEvents } = await import("./inbound.js");
  await acceptEvents(conn.id, await new FeishuAdapter().parse(getDb(), conn, payload));
}

export class FeishuAdapter implements Adapter {
  platform = "feishu";

  private async token(conn: Connection): Promise<string> {
    const cached = tokenCache.get(conn.id);
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const creds = credentials(conn);
    if (!creds.app_id || !creds.app_secret) throw new BadRequest("Feishu connection needs app_id and app_secret");
    const res: any = await (
      await feishuFetch(`${API}auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: creds.app_id, app_secret: creds.app_secret }),
      })
    ).json();
    if (res.code !== 0) throw new Error(`Feishu auth failed: ${res.msg}`);
    tokenCache.set(conn.id, {
      token: res.tenant_access_token,
      expires: Date.now() + Number(res.expire ?? 3600) * 1000,
    });
    return res.tenant_access_token;
  }

  private async call(
    conn: Connection,
    method: string,
    path: string,
    opts: { params?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
  ) {
    const qs = opts.params ? `?${new URLSearchParams(opts.params).toString()}` : "";
    const res: any = await (
      await feishuFetch(`${API}${path}${qs}`, {
        method,
        headers: { authorization: `Bearer ${await this.token(conn)}`, "content-type": "application/json" },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
      })
    ).json();
    if (res.code !== 0) throw new Error(`Feishu ${path} failed: ${res.msg}`);
    // v1 APIs answer in ``data``; older ones (bot/v3/info) put their fields beside ``code``
    return res.data ?? res;
  }

  async test(_db: Db, conn: Connection) {
    // { code, msg, bot: { app_name, open_id, … } }; answers only once the bot ability is published
    const { bot } = await this.call(conn, "GET", "bot/v3/info");
    if (!bot?.open_id) throw new Error("Feishu bot/v3/info failed: no bot in the answer");
    conn.botUserId = bot.open_id;
    return { bot: bot.app_name, bot_open_id: bot.open_id };
  }

  verify(conn: Connection, payload: any): void {
    // Feishu still pushing here means its console was not switched to the long connection.
    if (feishuMode(conn) === "socket")
      throw new Unauthorized("this connection receives events over the long connection");
    if (payload?.encrypt) throw new BadRequest("encrypted Feishu events are not supported; disable the encrypt key");
    const token = payload?.header?.token ?? payload?.token;
    const expected = credentials(conn).verification_token;
    if (!expected || !token || !safeEqual(String(token), expected))
      throw new Unauthorized("bad Feishu verification token");
  }

  /**
   * A chat's members with their names (the list carries them, so no contact permission is needed); the bot
   * is not among them. Kept briefly, so naming a sender and syncing members ask Feishu once.
   */
  private async members(conn: Connection, chatId: string, timeoutMs?: number) {
    const key = `${conn.id}:${chatId}`;
    const hit = known(memberLists, key, 60_000);
    if (hit) return hit.members;
    const members: { id: string; name: string | null }[] = [];
    let page: string | undefined;
    do {
      const data = await this.call(conn, "GET", `im/v1/chats/${chatId}/members`, {
        params: { member_id_type: "open_id", page_size: "100", ...(page ? { page_token: page } : {}) },
        timeoutMs,
      });
      for (const m of data.items ?? []) if (m.member_id) members.push({ id: m.member_id, name: m.name || null });
      page = data.has_more ? data.page_token : undefined;
    } while (page);
    memberLists.set(key, { members, at: Date.now() });
    for (const m of members) if (m.name) names.set(`${conn.id}:${m.id}`, { name: m.name, at: Date.now() });
    return members;
  }

  /** A group's name: kept with the conversation once known, asked of Feishu otherwise; null when unnamed. */
  private async chatName(db: Db, conn: Connection, chatId: string): Promise<string | null> {
    const [conv] = await db
      .select({ name: externalConversations.name })
      .from(externalConversations)
      .where(and(eq(externalConversations.connectionId, conn.id), eq(externalConversations.externalId, chatId)))
      .limit(1);
    if (conv?.name) return conv.name;
    const key = `${conn.id}:${chatId}`;
    const hit = known(chatNames, key, NAME_TTL_MS);
    if (hit) return hit.name;
    let name: string | null = null;
    try {
      name = (await this.call(conn, "GET", `im/v1/chats/${chatId}`, { timeoutMs: LOOKUP_MS })).name || null;
    } catch {
      // titled by its id until the name is known
    }
    chatNames.set(key, { name, at: Date.now() });
    return name;
  }

  /**
   * A person's name: from the group's member list, or else from the contact directory, which needs the
   * contact permissions and the person within the app's contact range (the only way in a private chat).
   */
  private async userName(conn: Connection, openId: string, chatId: string | null): Promise<string | null> {
    const key = `${conn.id}:${openId}`;
    const hit = known(names, key, NAME_TTL_MS);
    if (hit?.name) return hit.name;
    // A name the directory would not give may still be in a group's member list (itself kept for a minute).
    if (chatId) {
      try {
        await this.members(conn, chatId, LOOKUP_MS);
        const found = known(names, key, NAME_TTL_MS);
        if (found?.name) return found.name;
      } catch {
        // try the directory
      }
    }
    if (hit) return null;
    let name: string | null = null;
    try {
      const data = await this.call(conn, "GET", `contact/v3/users/${openId}`, {
        params: { user_id_type: "open_id" },
        timeoutMs: LOOKUP_MS,
      });
      name = data.user?.name || null;
    } catch {
      // keep the id: names are only for display
    }
    names.set(key, { name, at: Date.now() });
    return name;
  }

  /** Group chats: their member list defines who can see what is posted there. */
  async syncMembers(db: Db, conn: Connection, conv: ExternalConversation, force = false): Promise<void> {
    if (conv.kind === "im") return;
    if (!force && conv.membersSyncedAt && Date.now() - conv.membersSyncedAt.getTime() < MEMBERS_TTL_MS) return;
    const members = await this.members(conn, conv.externalId);
    await db
      .update(externalConversations)
      .set({ memberIds: members.map((m) => m.id), membersSyncedAt: new Date() })
      .where(eq(externalConversations.id, conv.id));
  }

  async parse(db: Db, conn: Connection, payload: any): Promise<InboundAction[]> {
    if (payload?.header?.event_type !== "im.message.receive_v1") return [];
    const event = payload.event ?? {};
    if (event.sender?.sender_type !== "user") return []; // ignore bots, ourselves included
    const msg = event.message ?? {};
    if (msg.message_type !== "text") return [];
    let text = "";
    try {
      text = JSON.parse(msg.content ?? "{}").text ?? "";
    } catch {
      text = "";
    }
    const p2p = msg.chat_type === "p2p";
    const chatId: string = msg.chat_id ?? "";
    const sender: string = event.sender?.sender_id?.open_id ?? "";
    let addressed = p2p;
    for (const m of msg.mentions ?? []) {
      const isBot = m.id?.open_id === conn.botUserId;
      addressed ||= isBot;
      text = text.split(m.key ?? "").join(isBot ? "" : `@${m.name ?? ""}`);
      // a mention names the person mentioned, at no cost
      if (!isBot && m.id?.open_id && m.name) names.set(`${conn.id}:${m.id.open_id}`, { name: m.name, at: Date.now() });
    }
    const id: string = msg.message_id ?? "";
    return [
      {
        kind: "message",
        message: {
          connectionId: conn.id,
          eventKey: `msg:${id}`,
          conversationId: chatId,
          conversationKind: p2p ? "im" : "private",
          conversationName: p2p ? null : await this.chatName(db, conn, chatId),
          // a reply (in a thread or quoting) belongs to the message its chain started from
          threadKey: p2p ? "__dm__" : msg.root_id || id,
          // A group is one topic, as Feishu shows it; replies stay visible as replies.
          ...(p2p ? {} : { topicKey: CHANNEL }),
          messageTs: id,
          userId: sender,
          userName: sender ? await this.userName(conn, sender, p2p ? null : chatId) : null,
          text: text.trim(),
          addressed,
        },
      },
    ];
  }

  async send(db: Db, conn: Connection, out: OutboundMessage, msg: Message): Promise<string | null> {
    let text = msg.content;
    if (msg.authorType === "role") {
      const [role] = msg.authorId ? await db.select().from(roles).where(eq(roles.id, msg.authorId)).limit(1) : [];
      if (!role || role.id !== conn.settings.role_id)
        text = `${role?.name ?? "role"} (@${role?.handle ?? "?"}): ${text}`;
    } else if (msg.authorType === "user") {
      const [user] = msg.authorId ? await db.select().from(users).where(eq(users.id, msg.authorId)).limit(1) : [];
      text = `${user?.name ?? "member"} (witden): ${text}`;
    }
    const content = JSON.stringify({ text });
    const data = out.threadKey
      ? await this.call(conn, "POST", `im/v1/messages/${out.threadKey}/reply`, {
          body: { msg_type: "text", content, reply_in_thread: true },
        })
      : await this.call(conn, "POST", "im/v1/messages", {
          params: { receive_id_type: "chat_id" },
          body: { receive_id: out.conversationExternalId, msg_type: "text", content },
        });
    return data.message_id ?? null;
  }

  async postRoot(conn: Connection, channel: string, text: string): Promise<string> {
    const data = await this.call(conn, "POST", "im/v1/messages", {
      params: { receive_id_type: "chat_id" },
      body: { receive_id: channel, msg_type: "text", content: JSON.stringify({ text }) },
    });
    return data.message_id;
  }
}

register("feishu", () => new FeishuAdapter());

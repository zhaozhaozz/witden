/** Feishu / Lark adapter (experimental): text messages in groups and bot DMs. Files and edits are not synchronised. */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
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
import { type Adapter, type InboundAction, register } from "./base.js";

const API = "https://open.feishu.cn/open-apis/";
const tokenCache = new Map<string, { token: string; expires: number }>();

export let feishuFetch: typeof fetch = (...args) => fetch(...args);
export function setFeishuFetch(fn: typeof fetch): void {
  feishuFetch = fn;
}

export function credentials(conn: Connection): Record<string, string> {
  return conn.credentialsEncrypted ? JSON.parse(secretBox().decrypt(conn.credentialsEncrypted)) : {};
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
    opts: { params?: Record<string, string>; body?: unknown } = {},
  ) {
    const qs = opts.params ? `?${new URLSearchParams(opts.params).toString()}` : "";
    const res: any = await (
      await feishuFetch(`${API}${path}${qs}`, {
        method,
        headers: { authorization: `Bearer ${await this.token(conn)}`, "content-type": "application/json" },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      })
    ).json();
    if (res.code !== 0) throw new Error(`Feishu ${path} failed: ${res.msg}`);
    return res.data ?? {};
  }

  async test(_db: Db, conn: Connection) {
    const info = await this.call(conn, "GET", "bot/v3/info");
    const bot = info.bot ?? info;
    conn.botUserId = bot.open_id;
    return { bot: bot.app_name, bot_open_id: bot.open_id };
  }

  verify(conn: Connection, payload: any): void {
    if (payload?.encrypt) throw new BadRequest("encrypted Feishu events are not supported; disable the encrypt key");
    const token = payload?.header?.token ?? payload?.token;
    const expected = credentials(conn).verification_token;
    if (!expected || !token || !safeEqual(String(token), expected))
      throw new Unauthorized("bad Feishu verification token");
  }

  async syncMembers(db: Db, conn: Connection, conv: ExternalConversation): Promise<void> {
    const members: string[] = [];
    let page: string | undefined;
    do {
      const data = await this.call(conn, "GET", `im/v1/chats/${conv.externalId}/members`, {
        params: { member_id_type: "open_id", page_size: "100", ...(page ? { page_token: page } : {}) },
      });
      members.push(...(data.items ?? []).map((m: any) => m.member_id).filter(Boolean));
      page = data.has_more ? data.page_token : undefined;
    } while (page);
    await db
      .update(externalConversations)
      .set({ memberIds: members, membersSyncedAt: new Date() })
      .where(eq(externalConversations.id, conv.id));
  }

  async parse(_db: Db, conn: Connection, payload: any): Promise<InboundAction[]> {
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
    let addressed = p2p;
    for (const m of msg.mentions ?? []) {
      const isBot = m.id?.open_id === conn.botUserId;
      addressed ||= isBot;
      text = text.split(m.key ?? "").join(isBot ? "" : `@${m.name ?? ""}`);
    }
    return [
      {
        kind: "message",
        message: {
          connectionId: conn.id,
          eventKey: `msg:${msg.message_id}`,
          conversationId: msg.chat_id ?? "",
          conversationKind: p2p ? "im" : "private",
          conversationName: null,
          threadKey: p2p ? "__dm__" : (msg.root_id ?? msg.message_id ?? ""),
          messageTs: msg.message_id ?? "",
          userId: event.sender?.sender_id?.open_id ?? "",
          userName: null,
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

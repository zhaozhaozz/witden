/**
 * Feishu adapter (experimental): messages in groups and bot DMs, Markdown sent as rich text (feishu-format.ts),
 * images and files both ways (feishu-files.ts). Edits are not synchronised. Events arrive over the long
 * connection witden keeps open (feishu-socket.ts) or at the events URL.
 */
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
  outboundMessages,
  users,
} from "../db/schema.js";
import { BadRequest, Unauthorized } from "../errors.js";
import { safeEqual, secretBox } from "../security/crypto.js";
import { artifactPath } from "../services/files.js";
import { consoleBase } from "../services/public-url.js";
import { type Adapter, CHANNEL, type InboundAction, register } from "./base.js";
import { integrationError } from "./diagnostics.js";
import {
  type FeishuInFile,
  fileLinks,
  imageExtension,
  MAX_IN_BYTES,
  messageFiles,
  uploadKind,
} from "./feishu-files.js";
import { fromFeishuPost, toFeishu } from "./feishu-format.js";
import { noteWebhook } from "./webhook-status.js";

const API = "https://open.feishu.cn/open-apis/";
// Feishu takes a rich-text message of up to 30 KB (a text one up to 150 KB).
const POST_MAX_BYTES = 29_000;
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
export async function acceptFeishuEvent(conn: Connection, payload: any): Promise<object | undefined> {
  noteWebhook(conn.id, "received");
  if (conn.status !== "active") return;
  // A click on a witden card: answered at once (Feishu waits up to 3 s), with a toast and the card's new form.
  if (payload?.header?.event_type === "card.action.trigger") {
    const { cardTrigger } = await import("./feishu-cards.js");
    return cardTrigger(conn, payload);
  }
  const { acceptEvents } = await import("./inbound.js");
  await acceptEvents(conn.id, await new FeishuAdapter().parse(getDb(), conn, payload));
}

/**
 * The words of a message: plain text; a rich-text post as Markdown (title and paragraphs, @ as the mention key so
 * it is replaced like in text); or a card's titles and texts. Images, files and other kinds have none (null).
 */
export function messageText(type: string, raw: string | undefined): string | null {
  let content: any;
  try {
    content = JSON.parse(raw ?? "{}");
  } catch {
    return null;
  }
  if (type === "text") return String(content.text ?? "");
  // either {title, content} or the same per language: {zh_cn: {title, content}}
  if (type === "post") return fromFeishuPost(content);
  if (type === "interactive") {
    const texts: string[] = [];
    const walk = (v: any, key = "") => {
      if (typeof v === "string") {
        if (["text", "title", "content"].includes(key) && v.trim() && !texts.includes(v)) texts.push(v);
      } else if (Array.isArray(v)) for (const x of v) walk(x, key);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(content);
    return texts.length ? texts.join("\n") : null;
  }
  return null;
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

  /** A Feishu Open API call with the app's tenant token; also used by the Feishu tools (feishu-tools.ts). */
  async call(
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
    // the code tells a missing scope (99991672) from a resource the app was not given (91403, 1254302…)
    if (res.code !== 0) throw new Error(`Feishu ${path} failed (${res.code}): ${res.msg}`);
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
  /** A person's name, from the chat's member list or the contact directory (kept a while). */
  async userName(conn: Connection, openId: string, chatId: string | null): Promise<string | null> {
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
    // People who joined since the last sync get the calendars shared with the group: afterwards, outside the
    // message's transaction, as it calls Feishu once per calendar and person.
    const before = conv.membersSyncedAt ? new Set(conv.memberIds) : null;
    const joined = before ? members.map((m) => m.id).filter((id) => !before.has(id)) : [];
    if (joined.length)
      void import("./feishu-calendar.js")
        .then((m) => m.followJoiners(getDb(), conn, conv.externalId, joined))
        .catch((err) => console.warn("[witden] calendar shares for new members failed", err.message));
  }

  /** A message card into a chat, or into a thread of it (the calendar share card). */
  async postCard(conn: Connection, chatId: string, threadKey: string | null, card: object): Promise<string | null> {
    return this.post(conn, { conversationExternalId: chatId, threadKey } as OutboundMessage, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    });
  }

  /** A message this connection posted (its id is recorded once Feishu accepted it). */
  private async sentByUs(db: Db, conn: Connection, messageId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(and(eq(outboundMessages.connectionId, conn.id), eq(outboundMessages.externalTs, messageId)))
      .limit(1);
    return !!row;
  }

  async parse(db: Db, conn: Connection, payload: any): Promise<InboundAction[]> {
    if (payload?.header?.event_type !== "im.message.receive_v1") return [];
    const event = payload.event ?? {};
    const msg = event.message ?? {};
    const id: string = msg.message_id ?? "";
    const p2p = msg.chat_type === "p2p";
    const chatId: string = msg.chat_id ?? "";
    const ids = event.sender?.sender_id ?? {};
    // Other bots' messages in a group (they arrive with im:message.group_msg.include_bot:read) are recorded for
    // context but never handed to roles, so bots cannot set each other off; this bot's own never come back in.
    const fromBot = event.sender?.sender_type !== "user";
    const sender: string = ids.open_id || ids.union_id || ids.user_id || ids.app_id || "";
    if (fromBot) {
      if (p2p || !sender || ids.open_id === conn.botUserId) return [];
      if (ids.app_id && ids.app_id === credentials(conn).app_id) return [];
      if (await this.sentByUs(db, conn, id)) return [];
    }
    // images and files come with the message and are downloaded into the topic (fetchFile)
    const files = messageFiles(msg.message_type, msg.content, id);
    let text = messageText(msg.message_type, msg.content) ?? (files.length ? "" : null);
    if (text === null) return [];
    let addressed = p2p;
    for (const m of msg.mentions ?? []) {
      const isBot = m.id?.open_id === conn.botUserId;
      addressed ||= isBot;
      text = text.split(m.key ?? "").join(isBot ? "" : `@${m.name ?? ""}`);
      // a mention names the person mentioned, at no cost
      if (!isBot && m.id?.open_id && m.name) names.set(`${conn.id}:${m.id.open_id}`, { name: m.name, at: Date.now() });
    }
    if (fromBot && !text.trim() && !files.length) return [];
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
          // bots are in neither the member list nor the directory: only a mention names them
          userName: fromBot
            ? (known(names, `${conn.id}:${sender}`, NAME_TTL_MS)?.name ?? null)
            : sender
              ? await this.userName(conn, sender, p2p ? null : chatId)
              : null,
          text: text.trim(),
          ...(files.length ? { files } : {}),
          // whether another bot's request goes to the role is the connection's choice (inbound.ts)
          addressed,
          ...(fromBot ? { fromBot: true } : {}),
        },
      },
    ];
  }

  /**
   * System notices go as plain text; everything else is Markdown written for the console, sent as a rich-text
   * post. The bot speaks for its role; a console member's message is titled with their name.
   */
  async send(db: Db, conn: Connection, out: OutboundMessage, msg: Message): Promise<string | null> {
    let who: string | null = null;
    if (msg.authorType === "user") {
      const [user] = msg.authorId ? await db.select().from(users).where(eq(users.id, msg.authorId)).limit(1) : [];
      who = `${user?.name ?? "member"} (witden)`;
    }
    let plain = { msg_type: "text", content: JSON.stringify({ text: who ? `${who}: ${msg.content}` : msg.content }) };
    if (msg.authorType === "system") return this.post(conn, out, plain);
    // A card goes as a Feishu card; one Feishu will not take goes as its Markdown, like any message.
    if (msg.card) {
      const card = await this.feishuCard(msg, who);
      try {
        return await this.post(conn, out, { msg_type: "interactive", content: JSON.stringify(card) });
      } catch (err) {
        if (!/failed \(\d+\)/.test((err as Error).message)) throw err;
        await integrationError(db, conn, msg, "format", err);
      }
    }
    // Attachments are uploaded first: images go into the post, other files follow it; what Feishu will not take
    // is linked instead. Failure details stay in the console.
    const { images, files, refused } = await this.uploadAll(db, conn, msg);
    const base = consoleBase();
    let md = toFeishu(msg.content, {
      baseUrl: base,
      viewUrl: `${base}/topics/${msg.topicId}`,
      mentions: await this.mentioned(db, conn, msg),
    });
    if (refused.length) {
      const links = fileLinks(refused);
      md = [md, links].filter(Boolean).join("\n\n");
      plain = {
        msg_type: "text",
        content: JSON.stringify({ text: [JSON.parse(plain.content).text, links].filter(Boolean).join("\n\n") }),
      };
    }
    const paragraphs = [
      ...(md ? [[{ tag: "md", text: md }]] : []),
      ...images.map((key) => [{ tag: "img", image_key: key }]),
    ];
    const rich = {
      msg_type: "post",
      content: JSON.stringify({ zh_cn: { ...(who ? { title: who } : {}), content: paragraphs } }),
    };
    let id: string | null;
    if (!paragraphs.length) id = null;
    else if (Buffer.byteLength(rich.content) > POST_MAX_BYTES)
      id = await this.plainWithImages(db, conn, out, msg, plain, images);
    else
      try {
        id = await this.post(conn, out, rich);
      } catch (err) {
        // Feishu answered and refused the post, so nothing was sent: the same words as plain text instead.
        if (!/failed \(\d+\)/.test((err as Error).message)) throw err;
        await integrationError(db, conn, msg, "format", err);
        id = await this.plainWithImages(db, conn, out, msg, plain, images);
      }
    // Files follow the message, where it went; the message is out, so a file that fails is dropped, not retried.
    for (const key of files) {
      try {
        const sent = await this.post(conn, out, { msg_type: "file", content: JSON.stringify({ file_key: key }) });
        id ??= sent;
      } catch (err) {
        await integrationError(db, conn, msg, "send", err);
      }
    }
    return id;
  }

  /** The words as plain text, each image as its own message after them. */
  private async plainWithImages(
    db: Db,
    conn: Connection,
    out: OutboundMessage,
    msg: Message,
    plain: { msg_type: string; content: string },
    images: string[],
  ): Promise<string | null> {
    let id = JSON.parse(plain.content).text.trim() ? await this.post(conn, out, plain) : null;
    for (const key of images) {
      try {
        const sent = await this.post(conn, out, { msg_type: "image", content: JSON.stringify({ image_key: key }) });
        id ??= sent;
      } catch (err) {
        // The text may already be delivered; do not retry it because a following image failed.
        await integrationError(db, conn, msg, "send", err);
      }
    }
    return id;
  }

  /** Upload a message's attachments (files of its topic only): image keys, file keys, and what was refused. */
  private async uploadAll(db: Db, conn: Connection, msg: Message) {
    const images: string[] = [];
    const files: string[] = [];
    const refusedFiles: Artifact[] = [];
    const attached = msg.attachments?.length
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
    for (const f of attached) {
      const kind = uploadKind(f);
      if ("refused" in kind) {
        refusedFiles.push(f);
        await integrationError(db, conn, msg, "upload", kind.refused, f);
        continue;
      }
      try {
        const form = new FormData();
        const blob = new Blob([fs.readFileSync(artifactPath(f))], { type: f.mime });
        if (kind.image) {
          form.append("image_type", "message");
          form.append("image", blob, f.name);
          images.push((await this.upload(conn, "im/v1/images", form)).image_key);
        } else {
          form.append("file_type", kind.fileType);
          form.append("file_name", f.name);
          form.append("file", blob, f.name);
          files.push((await this.upload(conn, "im/v1/files", form)).file_key);
        }
      } catch (err) {
        refusedFiles.push(f);
        await integrationError(db, conn, msg, "upload", err, f);
      }
    }
    return { images, files, refused: refusedFiles };
  }

  /** A multipart upload with the app's tenant token (images and files for messages, im:resource). */
  private async upload(conn: Connection, path: string, form: FormData): Promise<any> {
    const res: any = await (
      await feishuFetch(`${API}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await this.token(conn)}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      })
    ).json();
    if (res.code !== 0) throw new Error(`Feishu ${path} failed (${res.code}): ${res.msg}`);
    return res.data ?? {};
  }

  /**
   * An image or file of a received message (im:message:readonly), at most MAX_IN_BYTES. An image's name and type
   * come from what Feishu sends back.
   */
  async fetchFile(conn: Connection, f: Record<string, any>): Promise<Buffer | null> {
    const file = f as FeishuInFile;
    const res = await feishuFetch(`${API}im/v1/messages/${file.message_id}/resources/${file.key}?type=${file.type}`, {
      headers: { authorization: `Bearer ${await this.token(conn)}` },
      signal: AbortSignal.timeout(60_000),
    });
    const mime = res.headers.get("content-type") ?? "";
    if (!res.ok || mime.includes("application/json")) {
      const err: any = await res.json().catch(() => ({}));
      throw new Error(`Feishu resource failed (${err.code ?? res.status}): ${err.msg ?? res.statusText}`);
    }
    if (Number(res.headers.get("content-length") ?? 0) > MAX_IN_BYTES) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_IN_BYTES) return null;
    if (file.type === "image" && mime.startsWith("image/")) {
      f.mimetype = mime.split(";")[0];
      f.name = file.name.replace(/\.png$/, `.${imageExtension(f.mimetype)}`);
    }
    return data;
  }

  /** People @-mentioned in a message who are linked on this connection: their name → open_id. */
  private async mentioned(db: Db, conn: Connection, msg: Message): Promise<Map<string, string>> {
    const ids = (msg.mentions ?? []).filter((m) => m.type === "user").map((m) => m.id);
    if (!ids.length) return new Map();
    const rows = await db
      .select({ name: users.name, openId: externalIdentities.externalUserId })
      .from(externalIdentities)
      .innerJoin(users, eq(users.id, externalIdentities.userId))
      .where(and(eq(externalIdentities.connectionId, conn.id), inArray(externalIdentities.userId, ids)));
    return new Map(rows.map((r) => [r.name, r.openId]));
  }

  /** A card message as a Feishu card; another role's card says whose it is. */
  private async feishuCard(msg: Message, who: string | null): Promise<any> {
    const { toFeishuCard } = await import("./feishu-cards.js");
    const card: any = toFeishuCard(msg.card as any, msg.id);
    if (who) card.body.elements.unshift({ tag: "markdown", content: `*${who}*` });
    return card;
  }

  /** The card changed: its Feishu copy shows the new form (the card was sent with update_multi). */
  async updateCard(_db: Db, conn: Connection, externalId: string, msg: Message): Promise<void> {
    // Cards are roles', and a Feishu conversation's one role speaks as the bot: no name to add.
    await this.call(conn, "PATCH", `im/v1/messages/${externalId}`, {
      body: { content: JSON.stringify(await this.feishuCard(msg, null)) },
    });
  }

  private async post(
    conn: Connection,
    out: OutboundMessage,
    body: { msg_type: string; content: string },
  ): Promise<string | null> {
    const data = out.threadKey
      ? await this.call(conn, "POST", `im/v1/messages/${out.threadKey}/reply`, {
          body: { ...body, reply_in_thread: true },
        })
      : await this.call(conn, "POST", "im/v1/messages", {
          params: { receive_id_type: "chat_id" },
          body: { receive_id: out.conversationExternalId, ...body },
        });
    return data.message_id ?? null;
  }
}

register("feishu", () => new FeishuAdapter());

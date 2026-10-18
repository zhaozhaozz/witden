/**
 * Feishu end to end: events over the long connection (the SDK's client replaced by a stand-in, as the SDK
 * itself is not under test here) or at the verified events URL, Open API calls out.
 */
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../src/config.js";
import { db } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import { connections, externalIdentities, tasks, topics, users } from "../src/db/schema.js";
import { deliverPending } from "../src/integrations/delivery.js";
import { messageText, setFeishuFetch } from "../src/integrations/feishu.js";
import { type FeishuClientOptions, feishuTiming, setFeishuClient } from "../src/integrations/feishu-socket.js";
import { resolveIdentity } from "../src/integrations/inbound.js";
import { secretBox } from "../src/security/crypto.js";
import { reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

const APP_ID = "cli_a1b2c3d4e5f60789";
const TOKEN = "feishu-verification-token";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * Feishu Open API stand-in: one bot; the group oc_group (产品群) has alice and bob, other chats only alice; the
 * contact directory knows carol only (the others are outside the app's contact range). Sent messages are recorded.
 */
class FakeFeishu {
  sent: { path: string; body: any }[] = [];
  asked: string[] = [];

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/open-apis/", "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "auth/v3/tenant_access_token/internal")
      return json({ code: 0, msg: "ok", tenant_access_token: "t-123", expire: 7200 });
    if ((init?.headers as Record<string, string>)?.authorization !== "Bearer t-123")
      return json({ code: 99991663, msg: "invalid access token" });
    this.asked.push(path);
    if (path === "bot/v3/info")
      // the shape Feishu documents: the bot beside code, not in data
      return json({ code: 0, msg: "ok", bot: { app_name: "witden", open_id: "ou_bot" } });
    if (path === "im/v1/chats/oc_group") return json({ code: 0, data: { name: "产品群", chat_mode: "group" } });
    if (path === "im/v1/chats/oc_group/members")
      return json({
        code: 0,
        data: {
          items: [
            { member_id_type: "open_id", member_id: "ou_alice", name: "Alice 张" },
            { member_id_type: "open_id", member_id: "ou_bob", name: "Bob 李" },
          ],
          has_more: false,
        },
      });
    if (/^im\/v1\/chats\/[^/]+\/members$/.test(path))
      return json({ code: 0, data: { items: [{ member_id: "ou_alice", name: "Alice 张" }], has_more: false } });
    if (path === "contact/v3/users/ou_carol") return json({ code: 0, data: { user: { name: "Carol 王" } } });
    if (path.startsWith("contact/v3/users/")) return json({ code: 41050, msg: "no user authority error" });
    if (path === "im/v1/messages" || /^im\/v1\/messages\/[^/]+\/reply$/.test(path)) {
      this.sent.push({ path, body });
      return json({ code: 0, data: { message_id: `om_out_${this.sent.length}` } });
    }
    return json({ code: 404, msg: `unknown ${path}` });
  };
}

/** Stands in for the SDK's WSClient: records each client witden starts; the test acts as Feishu through it. */
class FakeLink {
  clients: { opts: FeishuClientOptions; closed: boolean }[] = [];
  /** New clients connect on their own; otherwise the test calls onReady or onError. */
  connects = true;

  factory = async (opts: FeishuClientOptions) => {
    const client = { opts, closed: false };
    this.clients.push(client);
    if (this.connects) setTimeout(() => opts.onReady(), 0);
    return {
      close: () => {
        client.closed = true;
      },
    };
  };

  open = () => this.clients.filter((c) => !c.closed);
  /** Feishu pushes an event to the app's connected client. */
  push = (payload: unknown) => {
    const [client, ...more] = this.open();
    expect(more).toHaveLength(0);
    return client.opts.onEvent(payload);
  };
}

const textEvent = (
  text: string,
  o: {
    sender?: string;
    senderType?: string;
    id?: string;
    chatType?: string;
    chat?: string;
    root?: string;
    atBot?: boolean;
    token?: string;
  } = {},
) => ({
  schema: "2.0",
  header: {
    event_id: `ev_${o.id ?? "om_1"}`,
    event_type: "im.message.receive_v1",
    ...(o.token ? { token: o.token } : {}),
  },
  event: {
    sender: { sender_type: o.senderType ?? "user", sender_id: { open_id: o.sender ?? "ou_alice" } },
    message: {
      message_id: o.id ?? "om_1",
      chat_id: o.chat ?? "oc_dm_alice",
      chat_type: o.chatType ?? "p2p",
      message_type: "text",
      content: JSON.stringify({ text: o.atBot ? `@_user_1 ${text}` : text }),
      ...(o.root ? { root_id: o.root, parent_id: o.root } : {}),
      ...(o.atBot ? { mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "witden" }] } : {}),
    },
  },
});

const allTasks = () => db().select().from(tasks).orderBy(asc(tasks.createdAt));

let w: World;
let feishu: FakeFeishu;
let link: FakeLink;
const savedTiming = { ...feishuTiming };

beforeEach(async () => {
  w = await buildWorld();
  feishu = new FakeFeishu();
  setFeishuFetch(feishu.fetch);
  link = new FakeLink();
  setFeishuClient(link.factory);
  feishuTiming.firstRetryMs = 20;
});

afterEach(async () => {
  await w.close();
  setFeishuFetch((...args) => fetch(...args));
  setFeishuClient(null);
  Object.assign(feishuTiming, savedTiming);
});

const create = (credentials: Record<string, string>, settings: Record<string, unknown> = {}) =>
  w.api("POST", "/api/connections", {
    token: w.adminToken,
    json: { platform: "feishu", name: "lark", credentials, settings },
  });
const patch = (id: string, json: Record<string, unknown>) =>
  w.api("PATCH", `/api/connections/${id}`, { token: w.adminToken, json });
const current = async (id: string) =>
  ((await w.api("GET", "/api/connections", { token: w.adminToken })).body as any[]).find((c) => c.id === id);
const sendUrl = (id: string, payload: unknown) =>
  w.api("POST", `/api/integrations/feishu/${id}/events`, {
    payload: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });

/** A tested connection whose bot stands for @dev, with alice's Feishu account linked. */
async function ready(conn: any) {
  expect((await w.api("POST", `/api/connections/${conn.id}/test`, { token: w.adminToken })).body).toMatchObject({
    ok: true,
    bot: "witden",
    bot_open_id: "ou_bot",
  });
  await db()
    .insert(externalIdentities)
    .values({ id: newId("ext"), connectionId: conn.id, externalUserId: "ou_alice", userId: w.ids.alice });
  expect((await patch(conn.id, { settings: { role_id: w.ids.dev } })).status).toBe(200);
}

describe("feishu long connection", () => {
  it("new connections use it: events arrive over the client witden opens, the events URL is refused", async () => {
    const res = await create({ app_id: APP_ID, app_secret: "app-secret" });
    expect(res.status, res.raw).toBe(200);
    const conn = res.body;
    expect(conn.feishu_mode).toBe("socket");
    expect(conn.has_credentials).toBe(true);
    await w.waitFor(async () => link.clients.length === 1);
    expect(link.clients[0].opts).toMatchObject({ appId: APP_ID, appSecret: "app-secret" });
    await w.waitFor(async () => (await current(conn.id)).socket?.state === "connected");
    await ready(conn);

    // queued, answered and handled like an event at the events URL
    w.scripts.dev = () => reply("hi alice");
    await link.push(textEvent("hello there"));
    await w.waitFor(async () => (await allTasks()).length === 1);
    const [task] = await allTasks();
    expect(task.ownerRoleId).toBe(w.ids.dev);
    expect(task.requesterUserId).toBe(w.ids.alice);
    await w.drain();
    await deliverPending();
    expect(feishu.sent.map((m) => [m.body.receive_id, JSON.parse(m.body.content).text])).toEqual([
      ["oc_dm_alice", "hi alice"],
    ]);
    expect((await current(conn.id)).webhook.received_at).toBeTruthy();

    // Feishu pushing the same event again (no answer within 3 s) starts nothing new
    await link.push(textEvent("hello there"));
    await w.drain();
    expect(await allTasks()).toHaveLength(1);

    // a Feishu console still set to push to the events URL is told why it is refused
    expect((await sendUrl(conn.id, { type: "url_verification", challenge: "c", token: TOKEN })).status).toBe(401);
    expect((await current(conn.id)).webhook.rejected_reason).toBe(
      "this connection receives events over the long connection",
    );

    // pausing closes the client; resuming opens a new one
    await patch(conn.id, { status: "paused" });
    await w.waitFor(async () => link.open().length === 0);
    expect((await current(conn.id)).socket).toBeNull();
    await patch(conn.id, { status: "active" });
    await w.waitFor(async () => link.clients.length === 2 && link.open().length === 1);

    // a new secret replaces the client
    await patch(conn.id, { credentials: { app_secret: "new-secret" } });
    await w.waitFor(async () => link.open()[0]?.opts.appSecret === "new-secret");
    expect(link.open()).toHaveLength(1);

    await w.api("DELETE", `/api/connections/${conn.id}`, { token: w.adminToken });
    await w.waitFor(async () => link.open().length === 0);
  });

  it("an app Feishu refuses is tried again later; while reconnecting the state says why", async () => {
    link.connects = false;
    const conn = (await create({ app_id: APP_ID, app_secret: "wrong" })).body;
    await w.waitFor(async () => link.clients.length === 1);
    const first = link.clients[0];
    expect((await current(conn.id)).socket.state).toBe("connecting");

    first.opts.onLog("code: 1000040343, invalid app secret");
    expect((await current(conn.id)).socket).toMatchObject({
      state: "connecting",
      error: "code: 1000040343, invalid app secret",
    });
    first.opts.onError(new Error("pullConnectConfig failed: code=1000040343, msg=invalid app secret"));
    expect((await current(conn.id)).socket).toMatchObject({
      state: "error",
      error: "pullConnectConfig failed: code=1000040343, msg=invalid app secret",
    });
    expect(first.closed).toBe(true);

    // a new client after a while (the reason stays shown until it connects); the one given up no longer counts
    await w.waitFor(async () => link.clients.length === 2);
    const second = link.clients[1];
    first.opts.onReady();
    first.opts.onError(new Error("late"));
    expect((await current(conn.id)).socket).toMatchObject({
      state: "error",
      error: expect.stringContaining("invalid"),
    });
    second.opts.onReady();
    expect((await current(conn.id)).socket).toMatchObject({ state: "connected" });
    expect((await current(conn.id)).socket.error).toBeUndefined();
    await new Promise((r) => setTimeout(r, 60));
    expect(link.clients).toHaveLength(2);

    // the SDK reconnecting after a dropped connection
    second.opts.onReconnecting();
    second.opts.onLog("connect failed");
    expect((await current(conn.id)).socket).toMatchObject({ state: "connecting", error: "connect failed" });
    second.opts.onReconnected();
    expect((await current(conn.id)).socket).toEqual({ state: "connected", since: expect.any(String) });
  });

  it("switching between the long connection and the events URL", async () => {
    const conn = (await create({ app_id: APP_ID, app_secret: "app-secret" })).body;
    await w.waitFor(async () => link.open().length === 1);
    const socketClient = link.open()[0];

    // the events URL needs its verification token, and only it takes one
    expect((await patch(conn.id, { settings: { feishu_mode: "http" } })).raw).toMatch(/verification_token/);
    expect((await patch(conn.id, { credentials: { verification_token: TOKEN } })).status).toBe(400);
    expect((await current(conn.id)).feishu_mode).toBe("socket");

    const http = await patch(conn.id, {
      settings: { feishu_mode: "http" },
      credentials: { verification_token: TOKEN },
    });
    expect(http.status, http.raw).toBe(200);
    expect(http.body.feishu_mode).toBe("http");
    await w.waitFor(async () => link.open().length === 0);
    expect((await current(conn.id)).socket).toBeNull();
    expect((await sendUrl(conn.id, { type: "url_verification", challenge: "c1", token: TOKEN })).body).toEqual({
      challenge: "c1",
    });
    // an event the old client still had is not taken in by a connection on the events URL
    await ready(conn);
    await socketClient.opts.onEvent(textEvent("late over the old connection", { id: "om_late" }));
    await w.drain();
    expect(await allTasks()).toHaveLength(0);

    // back to the long connection: the token is dropped, so the events URL refuses even a correct one
    const back = await patch(conn.id, { settings: { feishu_mode: "socket" } });
    expect(back.body.feishu_mode).toBe("socket");
    await w.waitFor(async () => link.open().length === 1);
    expect((await sendUrl(conn.id, { type: "url_verification", challenge: "c2", token: TOKEN })).status).toBe(401);
    const [row] = await db().select().from(connections);
    expect(JSON.parse(secretBox().decrypt(row.credentialsEncrypted!))).toEqual({
      app_id: APP_ID,
      app_secret: "app-secret",
    });
  });

  it("checks the credentials each way needs", async () => {
    // the long connection takes only a real App ID, and no verification token
    expect((await create({ app_id: "cli_1", app_secret: "s" })).raw).toMatch(/App ID/);
    expect(
      (await create({ app_id: APP_ID, app_secret: "s", verification_token: TOKEN }, { feishu_mode: "socket" })).status,
    ).toBe(400);
    expect((await create({ app_id: APP_ID, app_secret: "s" }, { feishu_mode: "http" })).raw).toMatch(
      /verification_token/,
    );
    expect((await create({ app_id: APP_ID, app_secret: "s" }, { feishu_mode: "ws" })).status).toBe(400);
    expect(link.clients).toHaveLength(0);

    // a connection saved before there was a choice uses the events URL
    await db()
      .insert(connections)
      .values({
        id: "conn_old",
        platform: "feishu",
        name: "old",
        credentialsEncrypted: secretBox().encrypt(
          JSON.stringify({ app_id: "cli_x", app_secret: "s", verification_token: TOKEN }),
        ),
      });
    expect((await current("conn_old")).feishu_mode).toBe("http");
  });
});

describe("feishu groups and names", () => {
  const group = (text: string, id: string, o: { sender?: string; root?: string } = {}) =>
    textEvent(text, { id, chatType: "group", chat: "oc_group", atBot: true, ...o });

  it("a group is one topic named after it; replies in a thread point at its first message and are answered there", async () => {
    const conn = (await create({ app_id: APP_ID, app_secret: "app-secret" })).body;
    await w.waitFor(async () => link.open().length === 1);
    await ready(conn);
    let n = 0;
    w.scripts.dev = () => reply(`answer ${++n}`);

    // two questions straight into the group: one topic, titled with the group's name
    await link.push(group("第一个问题", "om_g1"));
    await link.push(group("第二个问题", "om_g2"));
    await w.waitFor(async () => (await allTasks()).length === 2);
    const tasksNow = await allTasks();
    expect(new Set(tasksNow.map((t) => t.topicId)).size).toBe(1);
    const topicId = tasksNow[0].topicId;
    const topic = (await w.api("GET", `/api/topics/${topicId}`, { token: w.alice })).body;
    expect(topic.title).toBe("#产品群");
    await w.drain();
    await deliverPending();
    // asked in the group itself, answered in the group itself
    expect(feishu.sent.map((m) => [m.path, m.body.receive_id])).toEqual([
      ["im/v1/messages", "oc_group"],
      ["im/v1/messages", "oc_group"],
    ]);

    // a reply in the first question's thread joins the same topic, under that question, and is answered there
    await link.push(group("接着问", "om_g3", { root: "om_g1" }));
    await w.waitFor(async () => (await allTasks()).length === 3);
    const msgs = (await w.messages(topicId)) as any[];
    const first = msgs.find((m) => m.content === "第一个问题");
    expect(msgs.find((m) => m.content === "接着问").reply_to_id).toBe(first.id);
    await w.drain();
    await deliverPending();
    expect(feishu.sent.at(-1)).toMatchObject({ path: "im/v1/messages/om_g1/reply", body: { reply_in_thread: true } });
    expect((await allTasks()).every((t) => t.topicId === topicId)).toBe(true);
  });

  it("names people from the group's member list, or from the contact directory in a private chat", async () => {
    const conn = (await create({ app_id: APP_ID, app_secret: "app-secret" })).body;
    await w.waitFor(async () => link.open().length === 1);
    await ready(conn);
    await patch(conn.id, { settings: { auto_provision_users: true } });
    w.scripts.dev = () => reply("ok");
    const nameOf = async (openId: string) => {
      const [ident] = await db().select().from(externalIdentities).where(eq(externalIdentities.externalUserId, openId));
      const [user] = ident?.userId ? await db().select().from(users).where(eq(users.id, ident.userId)) : [];
      return user?.name;
    };

    // bob writes privately first, outside the contact range: a placeholder name, for him and his chat
    await link.push(textEvent("我是 bob", { id: "om_b0", sender: "ou_bob", chat: "oc_p2p_bob" }));
    await w.waitFor(async () => (await nameOf("ou_bob")) === "feishu-ou_bob");
    // then in the group: the member list names him, and his private chat takes the name too
    await link.push(group("我是 bob", "om_b1", { sender: "ou_bob" }));
    await w.waitFor(async () => (await nameOf("ou_bob")) === "Bob 李");
    expect((await db().select().from(topics).where(eq(topics.kind, "dm"))).map((t) => t.title)).toContain("Bob 李");
    // carol writes privately: her name comes from the contact directory, and so does her chat's title
    await link.push(textEvent("我是 carol", { id: "om_c1", sender: "ou_carol", chat: "oc_p2p_carol" }));
    await w.waitFor(async () => (await nameOf("ou_carol")) === "Carol 王");
    const dm = (await db().select().from(topics).where(eq(topics.kind, "dm"))).find((t) => t.title === "Carol 王");
    expect(dm).toBeTruthy();
    // dave is outside the contact range: he keeps the placeholder name, and is not asked about again soon
    await link.push(textEvent("我是 dave", { id: "om_d1", sender: "ou_dave", chat: "oc_p2p_dave" }));
    await w.waitFor(async () => (await nameOf("ou_dave")) === "feishu-ou_dave");
    await link.push(textEvent("还是 dave", { id: "om_d2", sender: "ou_dave", chat: "oc_p2p_dave" }));
    await w.drain();
    expect(feishu.asked.filter((p) => p === "contact/v3/users/ou_dave")).toHaveLength(1);
    // the group's name and members were each asked for once
    expect(feishu.asked.filter((p) => p === "im/v1/chats/oc_group")).toHaveLength(1);
    expect(feishu.asked.filter((p) => p === "im/v1/chats/oc_group/members")).toHaveLength(1);
  });
});

describe("feishu: other bots and rich messages", () => {
  /** A message as Feishu pushes it: any type, from a person or (sender_type "app") another bot. */
  const raw = (
    id: string,
    type: string,
    content: unknown,
    o: { app?: boolean; sender?: Record<string, string>; atBot?: boolean } = {},
  ) => ({
    schema: "2.0",
    header: { event_id: `ev_${id}`, event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_type: o.app ? "app" : "user", sender_id: o.sender ?? { open_id: "ou_alice" } },
      message: {
        message_id: id,
        chat_id: "oc_group",
        chat_type: "group",
        message_type: type,
        content: JSON.stringify(content),
        ...(o.atBot ? { mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "witden" }] } : {}),
      },
    },
  });
  const card = (title: string, text: string) => ({ title, elements: [[{ tag: "text", text }]] });

  it("by default other bots' messages are context for the role, not requests; this bot's own never come back", async () => {
    const conn = (await create({ app_id: APP_ID, app_secret: "app-secret" })).body;
    await w.waitFor(async () => link.open().length === 1);
    await ready(conn);
    let prompt = "";
    w.scripts.dev = (messages, turn) => {
      if (turn === 0) prompt = String(messages.find((m) => m.role === "user")?.content ?? "");
      return reply("看到了");
    };
    const ci = { open_id: "ou_ci_bot_42" };

    // a CI bot's card goes into the group's topic, under the bot's (placeholder) name, and starts nothing
    await link.push(
      raw("om_ci1", "interactive", card("构建失败", "main 分支 #812 单元测试失败"), { app: true, sender: ci }),
    );
    // nor does it when it @-mentions this bot
    await link.push(raw("om_ci2", "text", { text: "@_user_1 请处理" }, { app: true, sender: ci, atBot: true }));
    // this bot's own messages are not taken back in: by its id, its app or a message it sent
    await link.push(raw("om_own1", "text", { text: "自己的消息" }, { app: true, sender: { open_id: "ou_bot" } }));
    await link.push(raw("om_own2", "text", { text: "自己的消息" }, { app: true, sender: { app_id: APP_ID } }));
    await w.drain();
    expect(await allTasks()).toHaveLength(0);
    const [topic] = await db().select().from(topics).where(eq(topics.title, "#产品群"));
    const stored = (await w.messages(topic.id)) as any[];
    expect(stored.map((m) => m.content)).toEqual(["构建失败\nmain 分支 #812 单元测试失败", "请处理"]);
    const [identity] = await db()
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.externalUserId, "ou_ci_bot_42"));
    const [botUser] = await db().select().from(users).where(eq(users.id, identity.userId!));
    expect(botUser.name).toBe("机器人 bot_42");

    // a person's question: the role sees the bot's card among the recent messages
    await link.push(textEvent("刚才的构建怎么回事", { id: "om_q1", chatType: "group", chat: "oc_group", atBot: true }));
    await w.waitFor(async () => (await allTasks()).length === 1);
    await w.drain();
    expect(prompt).toContain("机器人 bot_42: 构建失败");
    expect(prompt).toContain("main 分支 #812 单元测试失败");

    // the role's answer, once Feishu reports it back as a bot message, is not recorded a second time
    await deliverPending();
    const sentId = `om_out_${feishu.sent.length}`;
    const before = ((await w.messages(topic.id)) as any[]).length;
    await link.push(raw(sentId, "text", { text: "看到了" }, { app: true, sender: { open_id: "ou_other_form" } }));
    await w.drain();
    expect(((await w.messages(topic.id)) as any[]).length).toBe(before);
  });

  it("a connection may take other bots' requests, so many in a row until a person speaks", async () => {
    const conn = (await create({ app_id: APP_ID, app_secret: "app-secret" })).body;
    await w.waitFor(async () => link.open().length === 1);
    await ready(conn);
    expect((await patch(conn.id, { settings: { bot_requests: "yes" } })).status).toBe(400);
    expect((await patch(conn.id, { settings: { bot_requests: true } })).body.settings.bot_requests).toBe(true);
    w.scripts.dev = () => reply("收到");
    const s = settings();
    const saved = s.maxAutoRounds;
    s.maxAutoRounds = 2;
    try {
      const ci = { open_id: "ou_ci_bot_42" };
      const fromCi = (id: string) =>
        raw(id, "text", { text: "@_user_1 帮忙看看" }, { app: true, sender: ci, atBot: true });
      // two requests from the bot are taken; the third waits for a person
      for (const id of ["om_b1", "om_b2"]) {
        await link.push(fromCi(id));
        await w.waitFor(async () => (await allTasks()).length === Number(id.slice(-1)));
        await w.drain();
      }
      await link.push(fromCi("om_b3"));
      await w.drain();
      expect(await allTasks()).toHaveLength(2);
      const statuses = (await w.api("GET", `/api/connections/${conn.id}/inbound`, { token: w.adminToken }))
        .body as any[];
      expect(statuses.find((e) => e.event_key === "msg:om_b3")?.status).toBe("bot_limit");
      // a person asks; then the bot's requests are taken again
      await link.push(textEvent("我来问一句", { id: "om_p", chatType: "group", chat: "oc_group", atBot: true }));
      await w.waitFor(async () => (await allTasks()).length === 3);
      await w.drain();
      await link.push(fromCi("om_b4"));
      await w.waitFor(async () => (await allTasks()).length === 4);
      // the bot asked as an external member, for the role its connection stands for
      const fromBot = (await allTasks()).filter((t) => t.requesterUserId !== w.ids.alice);
      expect(fromBot.every((t) => t.ownerRoleId === w.ids.dev)).toBe(true);
    } finally {
      s.maxAutoRounds = saved;
    }
  });

  it("external members follow later name changes on the platform, unless renamed in witden", async () => {
    const created = (await create({ app_id: APP_ID, app_secret: "app-secret" }, { auto_provision_users: true })).body;
    const [conn] = await db().select().from(connections).where(eq(connections.id, created.id));
    const user = (await resolveIdentity(db(), conn, "ou_n", "用户398268"))!;
    await db()
      .insert(topics)
      .values({ id: "top_dm_n", title: "用户398268", kind: "dm", source: "feishu", createdBy: user.id });
    // the name was set in Feishu: the member and their private chat take it
    await resolveIdentity(db(), conn, "ou_n", "王小明");
    expect((await db().select().from(users).where(eq(users.id, user.id)))[0].name).toBe("王小明");
    expect((await db().select().from(topics).where(eq(topics.id, "top_dm_n")))[0].title).toBe("王小明");
    // renamed in witden: a later change on the platform does not overwrite it
    await db().update(users).set({ name: "小明（测试）" }).where(eq(users.id, user.id));
    await resolveIdentity(db(), conn, "ou_n", "王明");
    expect((await db().select().from(users).where(eq(users.id, user.id)))[0].name).toBe("小明（测试）");
  });

  it("rich-text posts and cards are read as text; a post that @-mentions the bot is a request", async () => {
    const conn = (await create({ app_id: APP_ID, app_secret: "app-secret" })).body;
    await w.waitFor(async () => link.open().length === 1);
    await ready(conn);
    w.scripts.dev = () => reply("好的");
    await link.push(
      raw(
        "om_p1",
        "post",
        {
          zh_cn: {
            title: "周报",
            content: [
              [
                { tag: "at", user_id: "@_user_1", user_name: "witden" },
                { tag: "text", text: " 帮我整理 " },
                { tag: "a", text: "这份文档", href: "https://example.com" },
              ],
              [{ tag: "img", image_key: "img_1" }],
            ],
          },
        },
        { atBot: true },
      ),
    );
    await w.waitFor(async () => (await allTasks()).length === 1);
    expect((await allTasks())[0].instruction).toBe("周报\n 帮我整理 这份文档\n[图片]");
    // an image alone has no words: not recorded
    await link.push(raw("om_img", "image", { image_key: "img_2" }));
    await w.drain();
    expect(messageText("image", JSON.stringify({ image_key: "x" }))).toBeNull();
    expect(
      messageText(
        "interactive",
        JSON.stringify({ header: { title: { content: "标题" } }, elements: [{ text: { content: "正文" } }] }),
      ),
    ).toBe("标题\n正文");
  });
});

describe("feishu events URL", () => {
  let conn: any;

  beforeEach(async () => {
    // a verification token without a stated way means the events URL, as before the long connection
    const res = await create({ app_id: "cli_1", app_secret: "app-secret", verification_token: TOKEN });
    expect(res.status, res.raw).toBe(200);
    conn = res.body;
    expect(conn.feishu_mode).toBe("http");
    await ready(conn);
  });

  it("verification token, DM task from a linked user, bots ignored, encryption refused", async () => {
    const send = (payload: unknown) => sendUrl(conn.id, payload);
    expect((await send({ type: "url_verification", challenge: "abc", token: TOKEN })).body).toEqual({
      challenge: "abc",
    });
    expect((await send({ type: "url_verification", challenge: "abc", token: "wrong" })).status).toBe(401);
    expect((await send({ type: "url_verification", challenge: "abc" })).status).toBe(401);
    expect((await send({ encrypt: "c2VjcmV0" })).status).toBe(400);

    w.scripts.dev = () => reply("hi alice");
    await send(textEvent("hello there", { token: TOKEN }));
    await w.waitFor(async () => (await allTasks()).length === 1);
    const [task] = await allTasks();
    expect(task.ownerRoleId).toBe(w.ids.dev);
    expect(task.requesterUserId).toBe(w.ids.alice);
    const topic = (await w.api("GET", `/api/topics/${task.topicId}`, { token: w.alice })).body;
    expect(topic.kind).toBe("dm");

    await send(textEvent("hello from a bot", { sender: "ou_bot", senderType: "app", id: "om_2", token: TOKEN }));
    await w.drain();
    expect(await allTasks()).toHaveLength(1);
    await deliverPending();
    expect(feishu.sent).toHaveLength(1);
    expect(feishu.sent[0].path).toBe("im/v1/messages");
    expect(feishu.sent[0].body.receive_id).toBe("oc_dm_alice");
    // the bot is dev: no name in front
    expect(JSON.parse(feishu.sent[0].body.content).text).toBe("hi alice");
    // no long connection for a connection on the events URL
    expect(link.clients).toHaveLength(0);
  });
});

/**
 * Feishu end to end: events over the long connection (the SDK's client replaced by a stand-in, as the SDK
 * itself is not under test here) or at the verified events URL, Open API calls out.
 */
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import { connections, externalIdentities, tasks, topics, users } from "../src/db/schema.js";
import { deliverPending } from "../src/integrations/delivery.js";
import { setFeishuFetch } from "../src/integrations/feishu.js";
import { type FeishuClientOptions, feishuTiming, setFeishuClient } from "../src/integrations/feishu-socket.js";
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

    // bob, unknown to witden, becomes an external member under his name in the group
    await link.push(group("我是 bob", "om_b1", { sender: "ou_bob" }));
    await w.waitFor(async () => (await nameOf("ou_bob")) === "Bob 李");
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

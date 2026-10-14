/** Chat integrations end to end: signed Slack webhooks in, Web API calls out (and a small Feishu check). */
import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { db } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import {
  connections,
  externalConversations,
  externalIdentities,
  externalThreadLinks,
  processedEvents,
  tasks,
  topicParticipants,
  topics,
  users,
} from "../src/db/schema.js";
import { getAdapter } from "../src/integrations/base.js";
import { deliverPending } from "../src/integrations/delivery.js";
import { setFeishuFetch } from "../src/integrations/feishu.js";
import { enqueueInbound, processInbound } from "../src/integrations/inbound.js";
import { setSlackFetch } from "../src/integrations/slack.js";
import { socketTiming } from "../src/integrations/slack-socket.js";
import { hasPermission, Perm } from "../src/security/permissions.js";
import { call, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

const SECRET = "slack-signing-secret";
const BOT_TOKEN = "xoxb-test-token-123";
const APP_TOKEN = "xapp-1-A1-1-0123456789abcdef";

/**
 * Slack's Socket Mode end: apps.connections.open hands out its address; each socket gets hello unless held
 * back, and acknowledgements are recorded.
 */
class FakeSocketMode {
  private server!: WebSocketServer;
  sockets: WebSocket[] = [];
  closed: WebSocket[] = [];
  acks: string[] = [];
  hello = true;

  async start() {
    this.server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(this.server, "listening");
    this.server.on("connection", (ws) => {
      this.sockets.push(ws);
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data));
        if (msg.envelope_id) this.acks.push(msg.envelope_id);
      });
      ws.on("close", () => this.closed.push(ws));
      if (this.hello) ws.send(JSON.stringify({ type: "hello", num_connections: 1 }));
    });
  }

  url = () => `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/link/?ticket=${this.sockets.length + 1}`;

  latest = () => this.sockets[this.sockets.length - 1];

  send(ws: WebSocket, msg: unknown) {
    ws.send(JSON.stringify(msg));
  }

  async stop() {
    for (const ws of this.sockets) ws.terminate();
    this.server.close();
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Slack Web API stand-in: channel ids starting with G are private, D are DMs; every post is recorded. */
class FakeSlack {
  posts: Record<string, any>[] = [];
  /** Socket Mode, when a test uses it. */
  sockets: FakeSocketMode | null = null;
  private ts = 1000;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").pop();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    // Socket Mode is opened with the app-level token, everything else uses the bot token.
    if (method === "apps.connections.open") {
      if (headers.authorization !== `Bearer ${APP_TOKEN}`) return json({ ok: false, error: "invalid_auth" });
      return json({ ok: true, url: this.sockets?.url() });
    }
    if (headers.authorization !== `Bearer ${BOT_TOKEN}`) return json({ ok: false, error: "invalid_auth" });
    const params: Record<string, any> =
      init?.method === "POST" ? JSON.parse(String(init.body ?? "{}")) : Object.fromEntries(url.searchParams);
    switch (method) {
      case "auth.test":
        return json({ ok: true, team_id: "T1", user_id: "UBOT", team: "Acme", user: "witden" });
      case "conversations.info": {
        const ch = String(params.channel);
        const info = { id: ch, name: ch.toLowerCase(), is_private: ch.startsWith("G"), is_im: ch.startsWith("D") };
        return json({ ok: true, channel: info });
      }
      case "conversations.members":
        return json({ ok: true, members: ["UALICE", "UBOT"] });
      case "users.info":
        // UNINA has a display name; everyone else only the login name Slack always has
        return json({
          ok: true,
          user: { name: params.user, ...(params.user === "UNINA" ? { profile: { display_name: "Nina" } } : {}) },
        });
      case "chat.postMessage":
        this.ts += 1;
        this.posts.push(params);
        return json({ ok: true, ts: `${this.ts}.000` });
      default:
        return json({ ok: false, error: "unknown_method" });
    }
  };
}

/** Sign a body the way Slack does: v0 HMAC-SHA256 over `v0:<timestamp>:<raw body>`. */
function signed(body: unknown, opts: { secret?: string; ts?: number } = {}) {
  const raw = JSON.stringify(body);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const sig = `v0=${createHmac("sha256", opts.secret ?? SECRET)
    .update(`v0:${ts}:${raw}`)
    .digest("hex")}`;
  return {
    raw,
    headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": sig, "content-type": "application/json" },
  };
}

function event(
  text: string,
  {
    user = "UALICE",
    channel = "C1",
    ts = "1.1",
    thread_ts = undefined as string | undefined,
    etype = "app_mention",
  } = {},
  extra: Record<string, unknown> = {},
) {
  const ev: Record<string, unknown> = { type: etype, user, text, channel, ts, ...extra };
  if (thread_ts) ev.thread_ts = thread_ts;
  return { type: "event_callback", team_id: "T1", event_id: `Ev${ts}${etype}`, event: ev };
}

const allTasks = () => db().select().from(tasks).orderBy(asc(tasks.createdAt));

async function link(connectionId: string, externalUserId: string, userId: string) {
  await db()
    .insert(externalIdentities)
    .values({ id: newId("ext"), connectionId, externalUserId, userId });
}

let w: World;
afterEach(async () => {
  setSlackFetch((...args) => fetch(...args));
  setFeishuFetch((...args) => fetch(...args));
  await w.close();
});

describe("slack", () => {
  let slack: FakeSlack;
  let conn: any;

  const send = (body: unknown, opts: { secret?: string; ts?: number } = {}) => {
    const { raw, headers } = signed(body, opts);
    return w.api("POST", `/api/integrations/slack/${conn.id}/events`, { payload: raw, headers });
  };
  /** Wait for the background inbound handling of everything sent so far (tasks are not run). */
  const settle = () => w.witden.runtime.drain();

  beforeEach(async () => {
    w = await buildWorld();
    slack = new FakeSlack();
    setSlackFetch(slack.fetch);
    const res = await w.api("POST", "/api/connections", {
      token: w.adminToken,
      json: { platform: "slack", name: "acme", credentials: { bot_token: BOT_TOKEN, signing_secret: SECRET } },
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.raw).not.toContain("xoxb");
    conn = res.body;
    // The setup guide shows which workspace and bot the credentials belong to.
    const tested = await w.api("POST", `/api/connections/${conn.id}/test`, { token: w.adminToken });
    expect(tested.body).toMatchObject({ ok: true, team: "Acme", bot: "witden", bot_user_id: "UBOT" });
    // Slack accounts are linked to members by their Slack user id.
    await link(conn.id, "UALICE", w.ids.alice);
    await link(conn.id, "UBOB", w.ids.bob);
    const rule = await w.api("POST", "/api/rules", {
      token: w.adminToken,
      json: {
        name: "acme defaults",
        match: { connection_id: conn.id },
        allow_role_ids: [w.ids.dev],
        default_role_id: w.ids.dev,
      },
    });
    expect(rule.status, rule.raw).toBe(200);
  });

  it("verifies signatures, answers url_verification and rejects stale requests", async () => {
    expect((await send({ type: "url_verification", challenge: "abc" })).body).toEqual({ challenge: "abc" });
    expect((await send({ type: "url_verification", challenge: "x" }, { secret: "wrong" })).status).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await send({ type: "url_verification" }, { ts: stale })).status).toBe(401);
    // a body altered after signing is refused too
    const { headers } = signed({ type: "url_verification", challenge: "abc" });
    const tampered = await w.api("POST", `/api/integrations/slack/${conn.id}/events`, {
      payload: JSON.stringify({ type: "url_verification", challenge: "evil" }),
      headers,
    });
    expect(tampered.status).toBe(401);
  });

  it("the console sees whether Slack reached the events URL and whether its signature matched", async () => {
    const status = async () =>
      (await w.api("GET", "/api/connections", { token: w.adminToken })).body.find((c: any) => c.id === conn.id).webhook;
    // a request without Slack's signature (e.g. a scanner) is refused and leaves no trace
    const unsigned = await w.api("POST", `/api/integrations/slack/${conn.id}/events`, {
      payload: JSON.stringify({ type: "url_verification", challenge: "c" }),
      headers: { "content-type": "application/json" },
    });
    expect(unsigned.status).toBe(401);
    expect(await status()).toBeNull();
    // Slack signing with another secret than the one saved: the usual sign of a wrong Signing Secret
    expect((await send({ type: "url_verification", challenge: "x" }, { secret: "other" })).status).toBe(401);
    expect(await status()).toMatchObject({ rejected_reason: "bad Slack signature", rejected_at: expect.any(String) });
    expect((await send({ type: "url_verification", challenge: "x" })).body).toEqual({ challenge: "x" });
    expect((await status()).verified_at).toEqual(expect.any(String));
  });

  it("Slack's other tokens are refused in place of the bot token or the signing secret", async () => {
    const create = (credentials: Record<string, string>) =>
      w.api("POST", "/api/connections", { token: w.adminToken, json: { platform: "slack", name: "x", credentials } });
    const appToken =
      "xapp-1-A0123456789-1234567890123-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect((await create({ bot_token: BOT_TOKEN, signing_secret: appToken })).raw).toContain("Signing Secret");
    expect((await create({ bot_token: "xoxp-user-token", signing_secret: SECRET })).raw).toContain("xoxb-");
    const patch = await w.api("PATCH", `/api/connections/${conn.id}`, {
      token: w.adminToken,
      json: { credentials: { signing_secret: appToken } },
    });
    expect(patch.status).toBe(400);
    // pasted values are trimmed
    const ok = await w.api("PATCH", `/api/connections/${conn.id}`, {
      token: w.adminToken,
      json: { credentials: { signing_secret: `  ${SECRET}\n` } },
    });
    expect(ok.status, ok.raw).toBe(200);
    expect((await send({ type: "url_verification", challenge: "t" })).body).toEqual({ challenge: "t" });
  });

  it("Socket Mode: events arrive over a socket witden opens, with no events URL involved", async () => {
    const fake = new FakeSocketMode();
    await fake.start();
    slack.sockets = fake;
    const saved = { ...socketTiming };
    socketTiming.firstRetryMs = 20;
    try {
      const socketOf = async () =>
        (await w.api("GET", "/api/connections", { token: w.adminToken })).body.find((c: any) => c.id === conn.id);
      // switching to Socket Mode drops the signing secret
      const switched = await w.api("PATCH", `/api/connections/${conn.id}`, {
        token: w.adminToken,
        json: { credentials: { app_token: APP_TOKEN } },
      });
      expect(switched.status, switched.raw).toBe(200);
      expect(switched.body.slack_mode).toBe("socket");
      await w.waitFor(async () => (await socketOf()).socket?.state === "connected");
      // the events URL no longer accepts anything: there is no signing secret
      expect((await send({ type: "url_verification", challenge: "c" })).status).toBe(401);

      // an event over the socket is queued, acknowledged and handled like one sent to the events URL
      fake.send(fake.latest(), {
        type: "events_api",
        envelope_id: "env-1",
        payload: event("<@UBOT> @dev over the socket", { ts: "900.1" }),
      });
      await w.waitFor(async () => fake.acks.includes("env-1"));
      await settle();
      expect((await allTasks()).map((t) => t.instruction)).toEqual(["@dev over the socket"]);
      // Slack sends an unacknowledged envelope again: the same event is not handled twice
      fake.send(fake.latest(), {
        type: "events_api",
        envelope_id: "env-1b",
        payload: event("<@UBOT> @dev over the socket", { ts: "900.1" }),
      });
      await w.waitFor(async () => fake.acks.includes("env-1b"));
      await settle();
      expect(await allTasks()).toHaveLength(1);

      // Slack warns before replacing a socket: the next one is open before the old one goes
      const first = fake.latest();
      fake.send(first, { type: "disconnect", reason: "warning" });
      await w.waitFor(async () => fake.sockets.length === 2 && fake.closed.includes(first));
      expect((await socketOf()).socket.state).toBe("connected");
      fake.send(fake.latest(), {
        type: "events_api",
        envelope_id: "env-2",
        payload: event("<@UBOT> @dev on the new socket", { ts: "901.1" }),
      });
      await w.waitFor(async () => fake.acks.includes("env-2"));

      // a dropped socket is reopened
      fake.latest().terminate();
      await w.waitFor(async () => fake.sockets.length === 3);
      await w.waitFor(async () => (await socketOf()).socket?.state === "connected");

      // pausing the connection closes its socket
      await w.api("PATCH", `/api/connections/${conn.id}`, { token: w.adminToken, json: { status: "paused" } });
      await w.waitFor(async () => fake.closed.includes(fake.latest()));
      expect((await socketOf()).socket).toBeNull();
    } finally {
      Object.assign(socketTiming, saved);
      await fake.stop();
    }
  });

  it("switching ways: the new credential is tried before it is saved, so a wrong one changes nothing", async () => {
    const tryIt = (credentials: Record<string, string>) =>
      w.api("POST", `/api/connections/${conn.id}/test`, { token: w.adminToken, json: { credentials } });
    const state = async () =>
      (await w.api("GET", "/api/connections", { token: w.adminToken })).body.find((c: any) => c.id === conn.id);
    expect((await tryIt({ app_token: "xapp-1-wrong" })).body).toMatchObject({
      ok: false,
      error: expect.stringContaining("invalid_auth"),
    });
    expect((await tryIt({ app_token: APP_TOKEN })).body).toMatchObject({ ok: true, team: "Acme" });
    // nothing was saved: still the events URL, still working, not marked as failing
    expect(await state()).toMatchObject({ slack_mode: "http", status: "active", socket: null });
    expect((await send({ type: "url_verification", challenge: "still" })).body).toEqual({ challenge: "still" });
    // a credential in the wrong place is refused outright
    expect((await tryIt({ app_token: BOT_TOKEN })).status).toBe(400);
  });

  it("Socket Mode credentials: an app-level token, refused in place of the others", async () => {
    const create = (credentials: Record<string, string>) =>
      w.api("POST", "/api/connections", { token: w.adminToken, json: { platform: "slack", name: "s", credentials } });
    expect((await create({ bot_token: BOT_TOKEN })).raw).toContain("app_token");
    expect((await create({ bot_token: BOT_TOKEN, app_token: BOT_TOKEN })).raw).toContain("xapp-");
    // a token without connections:write (or a wrong one) fails the test with Slack's reason
    const made = await create({ bot_token: BOT_TOKEN, app_token: "xapp-1-wrong" });
    expect(made.status, made.raw).toBe(200);
    const tested = await w.api("POST", `/api/connections/${made.body.id}/test`, { token: w.adminToken });
    expect(tested.body).toMatchObject({
      ok: false,
      error: expect.stringContaining("apps.connections.open failed: invalid_auth"),
    });
  });

  it("acknowledged events survive a crash before or during processing; text is not kept", async () => {
    const [row] = await db().select().from(connections).where(eq(connections.id, conn.id));
    const adapter = await getAdapter(row);
    // the process died right after acknowledging: the events are only in the queue
    await enqueueInbound(db(), conn.id, await adapter.parse(db(), row, event("<@UBOT> @dev first", { ts: "700.1" })));
    await enqueueInbound(db(), conn.id, await adapter.parse(db(), row, event("<@UBOT> @dev second", { ts: "701.1" })));
    expect(await allTasks()).toHaveLength(0);
    // ...and another one was being processed when it died
    const stalled = await db()
      .update(processedEvents)
      .set({ status: "processing", claimedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(processedEvents.eventKey, "msg:C1:701.1"))
      .returning();
    expect(stalled).toHaveLength(1);
    expect(await processInbound()).toBe(2);
    expect(await allTasks()).toHaveLength(2);
    expect(await processInbound()).toBe(0);
    const listed = await w.api("GET", `/api/connections/${conn.id}/inbound`, { token: w.adminToken });
    expect(listed.body.map((e: any) => e.status).sort()).toEqual(["dispatched", "dispatched"]);
    expect(listed.raw).not.toContain("@dev first");
    const stored = await db().select().from(processedEvents).where(eq(processedEvents.connectionId, conn.id));
    expect(stored.every((e) => e.payload === null)).toBe(true);
  });

  it("a channel is one topic; replies go where they were asked; retries do not duplicate work", async () => {
    w.scripts.dev = () => reply("build is green");
    const ev = event("<@UBOT> @dev check the build", { ts: "100.1" });
    await send(ev);
    await send(ev); // Slack retry
    await send(event("<@UBOT> @dev check the build", { ts: "100.1", etype: "message" }, { channel_type: "channel" }));
    await w.waitFor(async () => (await allTasks()).length === 1);
    await settle();
    expect(await allTasks()).toHaveLength(1);
    const topicId = (await allTasks())[0].topicId;

    // Bob follows up inside the thread of that message: same topic, the role already working there answers.
    await send(event("<@UBOT> also run the linters", { user: "UBOB", ts: "100.5", thread_ts: "100.1" }));
    await w.waitFor(async () => (await allTasks()).length === 2);
    // A new message straight in the channel: still the same topic, as Slack shows one channel.
    await send(event("<@UBOT> unrelated question", { ts: "200.1" }));
    await w.waitFor(async () => (await allTasks()).length === 3);
    expect(new Set((await allTasks()).map((t) => t.topicId))).toEqual(new Set([topicId]));
    const [topic] = await db().select().from(topics).where(eq(topics.id, topicId));
    expect(topic.title).toBe("#c1");
    // the reply inside the thread points at the thread's first message
    const asked = (await w.messages(topicId, w.alice)).filter((m: any) => m.author_type === "user");
    const root = asked.find((m: any) => m.content.includes("check the build"));
    expect(asked.find((m: any) => m.content.includes("linters")).reply_to_id).toBe(root.id);
    expect(asked.find((m: any) => m.content.includes("unrelated")).reply_to_id).toBeNull();

    await w.drain();
    await deliverPending();
    // answered where asked: two straight in the channel, one in the thread
    expect(slack.posts.filter((p) => p.text.includes("build is green") && !p.thread_ts)).toHaveLength(2);
    expect(slack.posts.filter((p) => p.text.includes("build is green") && p.thread_ts === "100.1")).toHaveLength(1);
    const before = slack.posts.length;
    await deliverPending(); // nothing is sent twice
    expect(slack.posts.length).toBe(before);
  });

  it("a role can send several messages for one request, read further back, and knows what it answers", async () => {
    let firstPrompt = "";
    let history = "";
    w.scripts.dev = (messages, turn) => {
      if (turn === 0) {
        firstPrompt = String(messages.find((m) => m.role === "user")?.content ?? "");
        return reply("", [
          call("send_message", { text: "looking into it" }),
          call("topic_history", { query: "deploy" }),
        ]);
      }
      history = String(
        messages
          .filter((m) => m.role === "tool")
          .map((m) => m.content)
          .join("\n"),
      );
      if (turn === 1) return reply("", [call("send_message", { text: "found it: the deploy on Monday" })]);
      return reply(""); // everything said already: nothing more is posted
    };
    await send(event("we deploy on Monday", { user: "UBOB", ts: "810.1", etype: "message" }));
    await send(event("<@UBOT> @dev when do we deploy?", { ts: "811.1", thread_ts: "810.1" }));
    await w.waitFor(async () => (await allTasks()).length === 1);
    await w.drain();
    await deliverPending();
    const [task] = await allTasks();
    expect(task.status).toBe("completed");
    expect(task.result).toBe("found it: the deploy on Monday");
    // both messages reached the thread they were asked in; no "(no answer)"
    const posted = slack.posts.filter((p) => p.channel === "C1").map((p) => [p.thread_ts, p.text]);
    expect(posted).toEqual([
      ["810.1", expect.stringContaining("looking into it")],
      ["810.1", expect.stringContaining("found it: the deploy on Monday")],
    ]);
    // the role was told who asked, where and in which thread, and saw the thread so far
    expect(firstPrompt).toContain("The message you are answering:");
    expect(firstPrompt).toContain("- From: alice");
    expect(firstPrompt).toMatch(/Slack #c1, as a reply in the thread of msg_/);
    expect(firstPrompt).toContain("The thread so far:");
    expect(firstPrompt).toContain("we deploy on Monday");
    // and it could search the topic
    expect(history).toContain("2 matching message(s)"); // the earlier message and the question itself
    expect(history).toContain("bob: we deploy on Monday");
  });

  it("every thread the bot can see is recorded; only messages addressed to it reach roles", async () => {
    // a message in a new thread that does not @ the bot
    await send(event("lunch at noon?", { ts: "950.1", etype: "message" }));
    await settle();
    const inbound = (await w.api("GET", `/api/connections/${conn.id}/inbound`, { token: w.adminToken })).body;
    expect(inbound.find((e: any) => e.event_key === "msg:C1:950.1")).toMatchObject({ status: "stored" });
    const links = await db().select().from(externalThreadLinks).where(eq(externalThreadLinks.connectionId, conn.id));
    expect(links.map((l) => l.threadKey)).toEqual(["__channel__"]);
    expect(await allTasks()).toEqual([]);
    // there is no setting to narrow it down any more
    const refused = await w.api("PATCH", `/api/connections/${conn.id}`, {
      token: w.adminToken,
      json: { settings: { default_sync_mode: "mentions" } },
    });
    expect(refused.status).toBe(400);
  });

  it("names come from Slack, and what was titled by an id takes the name once it is known", async () => {
    // a channel recorded before its name was looked up, with a thread titled by the channel's id
    const [conv] = await db()
      .insert(externalConversations)
      .values({ id: newId("conv"), connectionId: conn.id, externalId: "C8", kind: "public", name: null })
      .returning();
    const [old] = await db()
      .insert(topics)
      .values({ id: newId("top"), title: "#C8: hi", kind: "group", source: "slack", createdBy: w.ids.alice })
      .returning();
    await db()
      .insert(externalThreadLinks)
      .values({
        id: newId("lnk"),
        connectionId: conn.id,
        conversationId: conv.id,
        threadKey: "800.1",
        topicId: old.id,
      });
    // an external member first seen without a name, with its DM
    const [nina] = await db()
      .insert(users)
      .values({ id: newId("usr"), name: "slack-UNINA", externalConnectionId: conn.id })
      .returning();
    await link(conn.id, "UNINA", nina.id);
    const [dm] = await db()
      .insert(topics)
      .values({ id: newId("top"), title: "slack-UNINA", kind: "dm", source: "slack", createdBy: nina.id })
      .returning();

    // events tell the channel's type, not its name: the name is asked for
    await send(event("next one", { ts: "801.1", channel: "C8", etype: "message" }, { channel_type: "channel" }));
    await send(
      event("hello", { user: "UNINA", ts: "802.1", channel: "C8", etype: "message" }, { channel_type: "channel" }),
    );
    await settle();
    const [named] = await db().select().from(externalConversations).where(eq(externalConversations.id, conv.id));
    expect(named.name).toBe("c8");
    expect((await db().select().from(topics).where(eq(topics.id, old.id)))[0].title).toBe("#c8: hi");
    expect((await db().select().from(users).where(eq(users.id, nina.id)))[0].name).toBe("Nina");
    expect((await db().select().from(topics).where(eq(topics.id, dm.id)))[0].title).toBe("Nina");
  });

  it("a bot that stands for one role: that role takes everything addressed to it, and speaks as the bot", async () => {
    // no assignment rules at all: binding the role is the assignment
    for (const r of (await w.api("GET", "/api/rules", { token: w.adminToken })).body)
      await w.api("DELETE", `/api/rules/${r.id}`, { token: w.adminToken });
    const bound = await w.api("PATCH", `/api/connections/${conn.id}`, {
      token: w.adminToken,
      json: { settings: { role_id: w.ids.dev } },
    });
    expect(bound.status, bound.raw).toBe(200);
    w.scripts.dev = () => reply("on it");
    await send(event("<@UBOT> can you check the build", { ts: "970.1" }));
    // naming another role changes nothing: this bot is dev
    await send(event("<@UBOT> role:test run the tests", { ts: "971.1" }));
    await w.waitFor(async () => (await allTasks()).length === 2);
    expect((await allTasks()).map((t) => t.ownerRoleId)).toEqual([w.ids.dev, w.ids.dev]);
    await w.drain();
    await deliverPending();
    // no "*Dev (@dev)*:" heading: the bot's own name says who speaks
    expect(slack.posts.filter((p) => p.channel === "C1").map((p) => p.text)).toEqual(["on it", "on it"]);
    // external members of the connection may use that role
    expect(
      await hasPermission(db(), { isActive: true, externalConnectionId: conn.id } as any, Perm.ROLE_USE, w.ids.dev),
    ).toBe(true);
    expect(
      await hasPermission(db(), { isActive: true, externalConnectionId: conn.id } as any, Perm.ROLE_USE, w.ids.test),
    ).toBe(false);
  });

  it("Markdown answers reach Slack as mrkdwn; Slack formatting arrives as Markdown", async () => {
    w.scripts.dev = () =>
      reply(
        "## 结果\n\n**构建**通过，详见 [任务](/tasks)\n\n| 项 | 值 |\n|---|---|\n| a | 1 |\n\n```mermaid\nflowchart LR\n  A --> B\n```",
      );
    await send(event("<@UBOT> @dev 看看 *加粗* 和 <https://x.dev|链接>，抄送 <@UBOB>", { ts: "900.1" }));
    await w.waitFor(async () => (await allTasks()).length === 1);
    const topicId = (await allTasks())[0].topicId;
    const asked = (await w.messages(topicId, w.alice)).find((m: any) => m.author_type === "user");
    expect(asked.content).toBe("@dev 看看 **加粗** 和 [链接](https://x.dev)，抄送 @bob");

    await w.drain();
    await deliverPending();
    const answer = slack.posts.find((p) => p.channel === "C1" && !p.thread_ts)!.text as string;
    expect(answer.startsWith("*Dev (@dev)*:\n*结果*")).toBe(true);
    expect(answer).toContain("*构建*\u200b通过，详见 <http://localhost:8320/tasks|任务>");
    expect(answer).toContain("```\n项 | 值\n---|---\na  | 1\n```");
    expect(answer).toContain(`<http://localhost:8320/topics/${topicId}|在 witden 中查看>`);
    expect(answer).toContain("A --&gt; B");
    expect(answer).not.toMatch(/\*\*|##/);
  });

  it("unlinked people and bots cannot trigger work", async () => {
    await send(event("<@UBOT> @dev delete prod", { user: "UMALLORY", ts: "300.1" }));
    await w.waitFor(async () => slack.posts.some((p) => p.text.includes("not linked")));
    expect(slack.posts.find((p) => p.text.includes("not linked"))).toMatchObject({ channel: "C1" });
    expect(slack.posts.find((p) => p.text.includes("not linked"))?.thread_ts).toBeUndefined();
    await send(event("<@UBOT> @dev hi", { user: "UBOT", ts: "300.2" }, { bot_id: "B1" }));
    await send(event("<@UBOT> hi", { user: "UOTHERBOT", ts: "300.3" }, { bot_id: "B2" }));
    // an app posting on behalf of a linked member is still a bot
    await send(event("<@UBOT> @dev deploy", { user: "UBOB", ts: "300.5" }, { bot_id: "B3" }));
    await w.drain();
    expect(await allTasks()).toEqual([]);
    // bots get no notice either (that is how reply loops start)
    expect(slack.posts.filter((p) => p.text.includes("not linked"))).toHaveLength(1);
    const unlinked = (await w.api("GET", "/api/audit?action=inbound.unlinked_user", { token: w.adminToken })).body;
    expect(unlinked.length).toBeGreaterThan(0);
    expect(unlinked[0].actor_id).toBe("UMALLORY");

    // The first event recorded the identity; once an administrator links it, requests are accepted.
    const idents = (await w.api("GET", `/api/identities?connection_id=${conn.id}`, { token: w.adminToken })).body;
    const mallory = idents.find((i: any) => i.external_user_id === "UMALLORY");
    expect(mallory.user_id).toBeNull();
    const linked = await w.api("PATCH", `/api/identities/${mallory.id}`, {
      token: w.adminToken,
      json: { user_id: w.ids.bob },
    });
    expect(linked.status, linked.raw).toBe(200);
    await send(event("<@UBOT> @dev hello again", { user: "UMALLORY", ts: "300.4" }));
    await w.waitFor(async () => (await allTasks()).length === 1);
    expect((await allTasks())[0].requesterUserId).toBe(w.ids.bob);
  });

  it("external members: unlinked people get an account limited to the connection's roles; DMs stay apart", async () => {
    w.scripts.dev = () => reply("", [call("ask_human", { question: "which environment?" })]);
    const patched = await w.api("PATCH", `/api/connections/${conn.id}`, {
      token: w.adminToken,
      json: { settings: { auto_provision_users: true, external_role_ids: [w.ids.dev] } },
    });
    expect(patched.status, patched.raw).toBe(200);
    await send(event("<@UBOT> @dev hello", { user: "UCAROL", ts: "500.1" }));
    await w.waitFor(async () => (await allTasks()).length === 1);
    const carolId = (await allTasks())[0].requesterUserId as string;
    const listed = (await w.api("GET", "/api/users", { token: w.adminToken })).body as any[];
    expect(listed.find((u) => u.id === carolId)).toMatchObject({ external_connection_id: conn.id, email: null });

    // Only the roles the connection lists, nothing else.
    const [carol] = await db().select().from(users).where(eq(users.id, carolId));
    expect(await hasPermission(db(), carol, Perm.ROLE_USE, w.ids.dev)).toBe(true);
    expect(await hasPermission(db(), carol, Perm.ROLE_USE, w.ids.test)).toBe(false);
    expect(await hasPermission(db(), carol, Perm.TOPIC_CREATE)).toBe(false);
    // ...and no console sign-in
    const pw = await w.api("PATCH", `/api/users/${carolId}`, {
      token: w.adminToken,
      json: { password: "secret-pass-1" },
    });
    expect(pw.status).toBe(400);
    // Taking the role off the list stops her waiting work at once.
    await w.drain();
    expect((await allTasks())[0].status).toBe("waiting_human");
    await w.api("PATCH", `/api/connections/${conn.id}`, {
      token: w.adminToken,
      json: { settings: { external_role_ids: [] } },
    });
    expect((await allTasks())[0].status).toBe("cancelled");

    // Each person's DM with the bot is their own conversation.
    await send(
      event("hello", { user: "UCAROL", channel: "D1", ts: "501.1", etype: "message" }, { channel_type: "im" }),
    );
    await send(event("hello", { user: "UDAVE", channel: "D2", ts: "502.1", etype: "message" }, { channel_type: "im" }));
    await settle();
    const dms = await db().select().from(topics).where(eq(topics.kind, "dm"));
    expect(dms).toHaveLength(2);
    const people = await Promise.all(
      dms.map(async (t) =>
        (
          await db()
            .select()
            .from(topicParticipants)
            .where(and(eq(topicParticipants.topicId, t.id), eq(topicParticipants.participantType, "user")))
        ).map((p) => p.participantId),
      ),
    );
    expect(people.map((p) => p.length)).toEqual([1, 1]);
    expect(people[0][0]).not.toBe(people[1][0]);
  });

  it("no rule means a refusal visible where the request was", async () => {
    const rules = (await w.api("GET", "/api/rules", { token: w.adminToken })).body;
    for (const r of rules) await w.api("DELETE", `/api/rules/${r.id}`, { token: w.adminToken });
    await send(event("<@UBOT> @dev hello", { ts: "400.1" }));
    await w.waitFor(async () => {
      await deliverPending();
      return slack.posts.some((p) => p.text.includes("not assigned"));
    });
    expect(slack.posts.find((p) => p.text.includes("not assigned"))?.thread_ts).toBeUndefined();
    expect(await allTasks()).toEqual([]);
    // The connection's event list says the request was not handed to a role, and why.
    const inbound = (await w.api("GET", `/api/connections/${conn.id}/inbound`, { token: w.adminToken })).body;
    expect(inbound.find((e: any) => e.event_key === "msg:C1:400.1")).toMatchObject({
      status: "not_assigned",
      detail: expect.stringContaining("no assignment rule"),
    });
  });

  it("edits and deletes follow Slack", async () => {
    w.scripts.dev = () => reply("ok");
    await send(event("<@UBOT> @dev first version", { ts: "500.1" }));
    await w.waitFor(async () => (await allTasks()).length === 1);
    const topicId = (await allTasks())[0].topicId;
    await send({
      type: "event_callback",
      team_id: "T1",
      event_id: "EvE",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: { user: "UALICE", ts: "500.1", text: "<@UBOT> @dev second version" },
      },
    });
    await w.waitFor(async () => (await w.messages(topicId, w.alice))[0]?.content === "@dev second version");
    await send({
      type: "event_callback",
      team_id: "T1",
      event_id: "EvD",
      event: { type: "message", subtype: "message_deleted", channel: "C1", deleted_ts: "500.1" },
    });
    await w.waitFor(
      async () => !(await w.messages(topicId, w.alice)).some((m: any) => m.content.includes("second version")),
    );
  });

  it("connection settings: per-role identity, and a paused connection takes no requests", async () => {
    // Both admin calls below used to wait forever on the embedded database (query outside the request transaction).
    const patched = await w.api("PATCH", `/api/connections/${conn.id}`, {
      token: w.adminToken,
      json: { settings: { custom_identity: true } },
    });
    expect(patched.status, patched.raw).toBe(200);
    w.scripts.dev = () => reply("on it");
    await send(event("<@UBOT> @dev hi", { ts: "700.1" }));
    await w.waitFor(async () => (await allTasks()).length === 1);
    await w.drain();
    expect((await w.api("POST", "/api/integrations/deliver", { token: w.adminToken })).body).toEqual({ sent: 1 });
    expect(slack.posts).toEqual([expect.objectContaining({ channel: "C1", text: "on it", username: "Dev (@dev)" })]);

    const paused = await w.api("PATCH", `/api/connections/${conn.id}`, {
      token: w.adminToken,
      json: { status: "paused" },
    });
    expect(paused.body.status).toBe("paused");
    expect((await send(event("<@UBOT> @dev again", { ts: "700.2" }))).status).toBe(200);
    await settle();
    expect(await allTasks()).toHaveLength(1);
    const inbound = (await w.api("GET", `/api/connections/${conn.id}/inbound`, { token: w.adminToken })).body;
    expect(inbound.map((e: any) => e.event_key)).toEqual(["msg:C1:700.1"]);
  });

  it("publishing an internal topic needs an audience confirmation", async () => {
    const topicId = w.ids.topic;
    const body = { connection_id: conn.id, channel_id: "C_PUBLIC" };
    let res = await w.api("POST", `/api/topics/${topicId}/publish`, { token: w.alice, json: body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("audience_expansion");
    expect(slack.posts).toEqual([]); // nothing posted before the confirmation
    res = await w.api("POST", `/api/topics/${topicId}/publish`, {
      token: w.alice,
      json: { ...body, confirm_expand_audience: true },
    });
    expect(res.status, res.raw).toBe(200);
    const root = res.body.thread_key;
    await w.post(w.alice, topicId, "hello from inside");
    await deliverPending();
    expect(slack.posts.some((p) => p.thread_ts === root && p.text.includes("hello from inside"))).toBe(true);
    // no role has worked in this thread yet: the follow-up is not handed to an arbitrary participant
    await w.drain();
    await deliverPending();
    expect(slack.posts.some((p) => p.thread_ts === root && p.text.includes("not assigned"))).toBe(false);
  });

  it("channel rules route threads to different roles and intersect with the workspace rule", async () => {
    w.scripts.dev = () => reply("ok");
    w.scripts.test = () => reply("ok");
    await send(event("<@UBOT> first", { channel: "C2", ts: "600.1" }));
    await w.waitFor(async () => (await allTasks()).length === 1);
    const convs = (await w.api("GET", `/api/connections/${conn.id}/conversations`, { token: w.adminToken })).body;
    const c2 = convs.find((c: any) => c.external_id === "C2");
    const rules = (await w.api("GET", "/api/rules", { token: w.adminToken })).body;
    // widen the workspace rule to dev+test, then make test the default for C2 only
    await w.api("PATCH", `/api/rules/${rules[0].id}`, {
      token: w.adminToken,
      json: { allow_role_ids: [w.ids.dev, w.ids.test] },
    });
    await w.api("POST", "/api/rules", {
      token: w.adminToken,
      json: {
        name: "C2 is QA",
        match: { conversation_id: c2.id },
        allow_role_ids: [w.ids.test],
        default_role_id: w.ids.test,
      },
    });
    await send(event("<@UBOT> second thread", { channel: "C2", ts: "600.2" }));
    await send(event("<@UBOT> other channel", { channel: "C1", ts: "600.3" }));
    await w.waitFor(async () => (await allTasks()).length === 3);
    const owners = new Set((await allTasks()).slice(1).map((t) => t.ownerRoleId));
    expect(owners).toEqual(new Set([w.ids.test, w.ids.dev]));
    // In C2, @dev is outside the channel rule even though the workspace rule allows it.
    await send(event("<@UBOT> @dev please", { channel: "C2", ts: "600.4" }));
    await settle();
    expect(await allTasks()).toHaveLength(3);
    const explain = (
      await w.api("POST", "/api/rules/explain", {
        token: w.adminToken,
        json: {
          user_id: w.ids.alice,
          connection_id: conn.id,
          conversation_id: c2.id,
          conversation_kind: "public",
          requested_role_ids: [w.ids.dev],
        },
      })
    ).body;
    expect(explain.allowed).toBe(false);
    expect(explain.reason).toContain("not among the roles allowed");
  });
});

/** Feishu Open API stand-in: one bot, every chat has alice as its only member; sent messages are recorded. */
class FakeFeishu {
  sent: { path: string; body: any }[] = [];

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/open-apis/", "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "auth/v3/tenant_access_token/internal")
      return json({ code: 0, msg: "ok", tenant_access_token: "t-123", expire: 7200 });
    if ((init?.headers as Record<string, string>)?.authorization !== "Bearer t-123")
      return json({ code: 99991663, msg: "invalid access token" });
    if (path === "bot/v3/info")
      return json({ code: 0, msg: "ok", data: { bot: { app_name: "witden", open_id: "ou_bot" } } });
    if (/^im\/v1\/chats\/[^/]+\/members$/.test(path))
      return json({ code: 0, data: { items: [{ member_id: "ou_alice" }], has_more: false } });
    if (path === "im/v1/messages" || /^im\/v1\/messages\/[^/]+\/reply$/.test(path)) {
      this.sent.push({ path, body });
      return json({ code: 0, data: { message_id: `om_out_${this.sent.length}` } });
    }
    return json({ code: 404, msg: `unknown ${path}` });
  };
}

describe("feishu", () => {
  const TOKEN = "feishu-verification-token";
  let feishu: FakeFeishu;
  let conn: any;

  const send = (payload: unknown) =>
    w.api("POST", `/api/integrations/feishu/${conn.id}/events`, {
      payload: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
  const textEvent = (
    text: string,
    o: { sender?: string; senderType?: string; id?: string; chatType?: string } = {},
  ) => ({
    schema: "2.0",
    header: { event_id: `ev_${o.id ?? "om_1"}`, event_type: "im.message.receive_v1", token: TOKEN },
    event: {
      sender: { sender_type: o.senderType ?? "user", sender_id: { open_id: o.sender ?? "ou_alice" } },
      message: {
        message_id: o.id ?? "om_1",
        chat_id: "oc_dm_alice",
        chat_type: o.chatType ?? "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
    },
  });

  beforeEach(async () => {
    w = await buildWorld();
    feishu = new FakeFeishu();
    setFeishuFetch(feishu.fetch);
    const res = await w.api("POST", "/api/connections", {
      token: w.adminToken,
      json: {
        platform: "feishu",
        name: "lark",
        credentials: { app_id: "cli_1", app_secret: "app-secret", verification_token: TOKEN },
      },
    });
    expect(res.status, res.raw).toBe(200);
    conn = res.body;
    expect((await w.api("POST", `/api/connections/${conn.id}/test`, { token: w.adminToken })).body.ok).toBe(true);
    await link(conn.id, "ou_alice", w.ids.alice);
    await w.api("POST", "/api/rules", {
      token: w.adminToken,
      json: {
        name: "lark",
        match: { connection_id: conn.id },
        allow_role_ids: [w.ids.dev],
        default_role_id: w.ids.dev,
      },
    });
  });

  it("verification token, DM task from a linked user, bots ignored, encryption refused", async () => {
    expect((await send({ type: "url_verification", challenge: "abc", token: TOKEN })).body).toEqual({
      challenge: "abc",
    });
    expect((await send({ type: "url_verification", challenge: "abc", token: "wrong" })).status).toBe(401);
    expect((await send({ type: "url_verification", challenge: "abc" })).status).toBe(401);
    expect((await send({ encrypt: "c2VjcmV0" })).status).toBe(400);

    w.scripts.dev = () => reply("hi alice");
    await send(textEvent("hello there"));
    await w.waitFor(async () => (await allTasks()).length === 1);
    const [task] = await allTasks();
    expect(task.ownerRoleId).toBe(w.ids.dev);
    expect(task.requesterUserId).toBe(w.ids.alice);
    const topic = (await w.api("GET", `/api/topics/${task.topicId}`, { token: w.alice })).body;
    expect(topic.kind).toBe("dm");

    await send(textEvent("hello from a bot", { sender: "ou_bot", senderType: "app", id: "om_2" }));
    await w.drain();
    expect(await allTasks()).toHaveLength(1);
    await deliverPending();
    expect(feishu.sent).toHaveLength(1);
    expect(feishu.sent[0].path).toBe("im/v1/messages");
    expect(feishu.sent[0].body.receive_id).toBe("oc_dm_alice");
    expect(JSON.parse(feishu.sent[0].body.content).text).toBe("Dev (@dev): hi alice");
  });
});

/** Chat integrations end to end: signed Slack webhooks in, Web API calls out (and a small Feishu check). */
import { createHmac } from "node:crypto";
import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import { externalIdentities, tasks } from "../src/db/schema.js";
import { deliverPending } from "../src/integrations/delivery.js";
import { setFeishuFetch } from "../src/integrations/feishu.js";
import { setSlackFetch } from "../src/integrations/slack.js";
import { reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

const SECRET = "slack-signing-secret";
const BOT_TOKEN = "xoxb-test-token-123";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Slack Web API stand-in: channel ids starting with G are private, D are DMs; every post is recorded. */
class FakeSlack {
  posts: Record<string, any>[] = [];
  private ts = 1000;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").pop();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.authorization !== `Bearer ${BOT_TOKEN}`) return json({ ok: false, error: "invalid_auth" });
    const params: Record<string, any> =
      init?.method === "POST" ? JSON.parse(String(init.body ?? "{}")) : Object.fromEntries(url.searchParams);
    switch (method) {
      case "auth.test":
        return json({ ok: true, team_id: "T1", user_id: "UBOT", team: "Acme" });
      case "conversations.info": {
        const ch = String(params.channel);
        const info = { id: ch, name: ch.toLowerCase(), is_private: ch.startsWith("G"), is_im: ch.startsWith("D") };
        return json({ ok: true, channel: info });
      }
      case "conversations.members":
        return json({ ok: true, members: ["UALICE", "UBOT"] });
      case "users.info":
        return json({ ok: true, user: { name: params.user } });
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
    expect((await w.api("POST", `/api/connections/${conn.id}/test`, { token: w.adminToken })).body.ok).toBe(true);
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

  it("a thread maps to one topic; retries and duplicate event types do not duplicate work", async () => {
    w.scripts.dev = () => reply("build is green");
    const ev = event("<@UBOT> @dev check the build", { ts: "100.1" });
    await send(ev);
    await send(ev); // Slack retry
    await send(event("<@UBOT> @dev check the build", { ts: "100.1", etype: "message" }, { channel_type: "channel" }));
    await w.waitFor(async () => (await allTasks()).length === 1);
    await settle();
    expect(await allTasks()).toHaveLength(1);
    const topicId = (await allTasks())[0].topicId;

    // Bob follows up in the same thread: same topic, the role already working there answers.
    await send(event("<@UBOT> also run the linters", { user: "UBOB", ts: "100.5", thread_ts: "100.1" }));
    await w.waitFor(async () => (await allTasks()).length === 2);
    expect(new Set((await allTasks()).map((t) => t.topicId))).toEqual(new Set([topicId]));
    // Another thread in the same channel is a different topic.
    await send(event("<@UBOT> unrelated question", { ts: "200.1" }));
    await w.waitFor(async () => (await allTasks()).length === 3);
    expect(new Set((await allTasks()).map((t) => t.topicId)).size).toBe(2);

    await w.drain();
    await deliverPending();
    const replies = slack.posts.filter((p) => p.thread_ts === "100.1");
    expect(replies).toHaveLength(2);
    for (const p of replies) expect(p.text.startsWith("*Dev (@dev)*: build is green")).toBe(true);
    expect(slack.posts.filter((p) => p.thread_ts === "200.1")).toHaveLength(1);
    const before = slack.posts.length;
    await deliverPending(); // nothing is sent twice
    expect(slack.posts.length).toBe(before);
  });

  it("unlinked people and bots cannot trigger work", async () => {
    await send(event("<@UBOT> @dev delete prod", { user: "UMALLORY", ts: "300.1" }));
    await w.waitFor(async () => slack.posts.some((p) => p.text.includes("not linked")));
    expect(slack.posts.find((p) => p.text.includes("not linked"))?.thread_ts).toBe("300.1");
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

  it("no rule means a refusal visible in the thread", async () => {
    const rules = (await w.api("GET", "/api/rules", { token: w.adminToken })).body;
    for (const r of rules) await w.api("DELETE", `/api/rules/${r.id}`, { token: w.adminToken });
    await send(event("<@UBOT> @dev hello", { ts: "400.1" }));
    await w.waitFor(async () => {
      await deliverPending();
      return slack.posts.some((p) => p.text.includes("not assigned"));
    });
    expect(slack.posts.find((p) => p.text.includes("not assigned"))?.thread_ts).toBe("400.1");
    expect(await allTasks()).toEqual([]);
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
    expect(slack.posts).toEqual([
      expect.objectContaining({ thread_ts: "700.1", text: "on it", username: "Dev (@dev)" }),
    ]);

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

  it("publishing an internal topic needs topic.publish on the connection and an audience confirmation", async () => {
    const topicId = w.ids.topic;
    const body = { connection_id: conn.id, channel_id: "C_PUBLIC" };
    expect((await w.api("POST", `/api/topics/${topicId}/publish`, { token: w.alice, json: body })).status).toBe(403);
    await w.api("POST", "/api/grants", {
      token: w.adminToken,
      json: { permission: "topic.publish", user_id: w.ids.alice, resource_id: conn.id },
    });
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

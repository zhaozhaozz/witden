/** GitHub: signed webhooks in, issue comments out; an issue or pull request is one topic. */
import { createHmac } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import { externalIdentities, externalThreadLinks, messages, tasks, topics } from "../src/db/schema.js";
import { deliverPending } from "../src/integrations/delivery.js";
import { setGithubFetch } from "../src/integrations/github.js";
import { call, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

const SECRET = "github-webhook-secret";
const TOKEN = "ghp_test_token_123456";

/** GitHub REST stand-in for the bot account "witden-bot"; every comment and issue posted is recorded. */
class FakeGithub {
  comments: { path: string; body: string }[] = [];
  private next = 5000;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.authorization !== `Bearer ${TOKEN}`) return new Response("{}", { status: 401 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (data: unknown) => Response.json(data);
    if (url.pathname === "/user") return json({ login: "witden-bot", id: 99, type: "User" });
    const comment = /^\/repos\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (comment && init?.method === "POST") {
      this.comments.push({ path: url.pathname, body: body.body });
      return json({ id: ++this.next });
    }
    if (/^\/repos\/[\w.-]+\/[\w.-]+\/collaborators$/.test(url.pathname)) return json([{ id: 1001 }, { id: 99 }]);
    return new Response("{}", { status: 404 });
  };
}

let w: World;
let gh: FakeGithub;
let conn: any;

const deliveries = { n: 0 };
const send = (event: string, payload: unknown, secret = SECRET) => {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return w.api("POST", `/api/integrations/github/${conn.id}/events`, {
    payload: raw,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `d-${++deliveries.n}`,
      "x-hub-signature-256": sig,
    },
  });
};
const settle = () => w.witden.runtime.drain();
const allTasks = () => db().select().from(tasks).orderBy(asc(tasks.createdAt));

const ALICE = { login: "alice-gh", id: 1001, type: "User" };
const repo = (priv = false) => ({ full_name: "acme/api", private: priv });
const issue = (number: number, extra: Record<string, unknown> = {}) => ({
  id: 70000 + number,
  number,
  title: "Login fails on Safari",
  body: "",
  html_url: `https://github.com/acme/api/issues/${number}`,
  user: ALICE,
  ...extra,
});
let commentId = 900;
const commented = (body: string, opts: { number?: number; user?: object; priv?: boolean; pr?: boolean } = {}) => ({
  action: "created",
  repository: repo(opts.priv),
  issue: issue(opts.number ?? 12, opts.pr ? { pull_request: { url: "x" } } : {}),
  comment: { id: ++commentId, body, user: opts.user ?? ALICE },
});

beforeEach(async () => {
  w = await buildWorld();
  gh = new FakeGithub();
  setGithubFetch(gh.fetch);
  const res = await w.api("POST", "/api/connections", {
    token: w.adminToken,
    json: { platform: "github", name: "acme github", credentials: { token: TOKEN, webhook_secret: SECRET } },
  });
  expect(res.status, res.raw).toBe(200);
  conn = res.body;
  const tested = (await w.api("POST", `/api/connections/${conn.id}/test`, { token: w.adminToken })).body;
  expect(tested).toMatchObject({ ok: true });
  // alice's GitHub account is linked to her console account
  await db()
    .insert(externalIdentities)
    .values({ id: newId("ext"), connectionId: conn.id, externalUserId: "1001", userId: w.ids.alice });
  const rule = await w.api("POST", "/api/rules", {
    token: w.adminToken,
    json: {
      name: "github",
      match: { connection_id: conn.id },
      allow_role_ids: [w.ids.dev],
      default_role_id: w.ids.dev,
    },
  });
  expect(rule.status, rule.raw).toBe(200);
});
afterEach(async () => {
  setGithubFetch((...args) => fetch(...args));
  await w.close();
});

describe("github", () => {
  it("verifies signatures and accepts the ping", async () => {
    expect((await send("ping", { zen: "hi" })).status).toBe(200);
    expect((await send("ping", { zen: "hi" }, "wrong")).status).toBe(401);
    const listed = (await w.api("GET", "/api/connections", { token: w.adminToken })).body as any[];
    expect(listed.find((c) => c.id === conn.id).bot_user_id).toBe("witden-bot");
  });

  it("an issue comment that mentions the bot starts work; the answer comes back as a comment", async () => {
    w.scripts.dev = () => reply("Looking into the Safari login now.");
    await send("issue_comment", commented("@witden-bot role:dev can you check this?"));
    await settle();
    const [task] = await allTasks();
    expect(task.ownerRoleId).toBe(w.ids.dev);
    expect(task.requesterUserId).toBe(w.ids.alice);
    const [topic] = await db().select().from(topics).where(eq(topics.id, task.topicId));
    expect(topic).toMatchObject({ title: "acme/api#12 Login fails on Safari", source: "github", kind: "group" });
    const [link] = await db().select().from(externalThreadLinks).where(eq(externalThreadLinks.topicId, topic.id));
    expect(link.meta).toEqual({
      kind: "issue",
      title: "Login fails on Safari",
      url: "https://github.com/acme/api/issues/12",
    });
    // the console lists it under its source, with a link to GitHub
    const listed = (await w.api("GET", "/api/topics", { token: w.bob })).body as any[];
    expect(listed.find((t) => t.id === topic.id).channel).toMatchObject({
      platform: "github",
      connection_name: "acme github",
      conversation_name: "acme/api",
      conversation_kind: "public",
      thread_key: "12",
      thread_kind: "issue",
      url: "https://github.com/acme/api/issues/12",
    });
    expect(listed.find((t) => t.id === w.ids.topic).channel).toBeNull();
    const [first] = await db().select().from(messages).where(eq(messages.topicId, topic.id));
    expect(first.content).toBe("role:dev can you check this?");

    await w.drain();
    await deliverPending();
    const answer = gh.comments.find((c) => c.body.includes("Looking into the Safari login now."));
    expect(answer?.path).toBe("/repos/acme/api/issues/12/comments");
    // who is speaking, without an @ that would ping a GitHub user
    expect(answer?.body.startsWith("**Dev** (`dev`)")).toBe(true);
    // the comment that came from GitHub is not echoed back
    expect(gh.comments.some((c) => c.body.includes("can you check this"))).toBe(false);

    // a later comment without the mention is kept in the topic but asks for nothing; the bot's own are ignored
    await send("issue_comment", commented("thanks, I will wait"));
    await send("issue_comment", commented("@witden-bot echo", { user: { login: "witden-bot", id: 99, type: "User" } }));
    await settle();
    expect(await allTasks()).toHaveLength(1);
    const texts = (await db().select().from(messages).where(eq(messages.topicId, topic.id))).map((m) => m.content);
    expect(texts).toContain("thanks, I will wait");
    expect(texts.some((t) => t.includes("echo"))).toBe(false);
  });

  it("pull requests are topics too; comment edits and deletes follow GitHub", async () => {
    w.scripts.dev = () => reply("ok");
    await send("pull_request", {
      action: "opened",
      repository: repo(true),
      pull_request: issue(31, {
        title: "Fix the Safari cookie",
        body: "@witden-bot please review",
        html_url: "https://github.com/acme/api/pull/31",
      }),
    });
    await settle();
    const [task] = await allTasks();
    const [link] = await db().select().from(externalThreadLinks).where(eq(externalThreadLinks.topicId, task.topicId));
    expect(link.meta).toMatchObject({ kind: "pull_request", url: "https://github.com/acme/api/pull/31" });

    const c = commented("first version", { number: 31, priv: true, pr: true });
    await send("issue_comment", c);
    await settle();
    await send("issue_comment", { ...c, action: "edited", comment: { ...c.comment, body: "second version" } });
    await settle();
    const texts = async () =>
      (await db().select().from(messages).where(eq(messages.topicId, task.topicId))).map((m) => m.content);
    expect(await texts()).toContain("second version");
    await send("issue_comment", { ...c, action: "deleted" });
    await settle();
    expect(await texts()).not.toContain("second version");
  });

  it("a public repository is readable by anyone: DM material needs its owner's approval first", async () => {
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    w.scripts.dev = () => reply("noted");
    await w.post(w.alice, dm.id, "the staging password is hunter2");
    await w.drain();
    w.scripts.dev = (_m, turn) =>
      turn === 0 ? reply("", [call("read_topic", { topic_id: dm.id })]) : reply("The staging password is hunter2");
    await send("issue_comment", commented("@witden-bot role:dev what is the staging password?", { number: 40 }));
    await settle();
    await w.drain();
    const task = (await allTasks()).at(-1)!;
    expect(task.status).toBe("waiting_approval");
    await deliverPending();
    expect(gh.comments.some((c) => c.body.includes("hunter2"))).toBe(false);
  });
});

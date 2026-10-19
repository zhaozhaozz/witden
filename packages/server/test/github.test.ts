/** GitHub: signed webhooks in, issue comments out; an issue or pull request is one topic. */
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import { externalIdentities, externalThreadLinks, messages, tasks, topics } from "../src/db/schema.js";
import { deliverPending } from "../src/integrations/delivery.js";
import { imagesAsLinks, setGithubFetch } from "../src/integrations/github.js";
import { call, reply } from "./support/harness.js";
import { teamNote } from "./support/outside.js";
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
  const bound = await w.api("PATCH", `/api/connections/${conn.id}`, {
    token: w.adminToken,
    json: { settings: { role_id: w.ids.dev } },
  });
  expect(bound.status, bound.raw).toBe(200);
});
afterEach(async () => {
  setGithubFetch((...args) => fetch(...args));
  await w.close();
});

describe("github", () => {
  it("a Feishu connection still finds its adapter after GitHub's was loaded on its own", async () => {
    // this file never imports the Feishu module; the GitHub one is loaded by now
    const res = await w.api("POST", "/api/connections", {
      token: w.adminToken,
      json: {
        platform: "feishu",
        name: "acme feishu",
        credentials: { app_id: "cli_x", app_secret: "s", verification_token: "t" },
      },
    });
    expect(res.status, res.raw).toBe(200);
    const tested = (await w.api("POST", `/api/connections/${res.body.id}/test`, { token: w.adminToken })).body;
    expect(tested.ok).toBe(false);
    expect(tested.error).not.toMatch(/no adapter/);
  });

  it("images in a comment become links, so GitHub fetches no address a role wrote", () => {
    const md =
      "看图 ![屏幕](https://evil.example/x.png?d=secret) 和 ![][ref]\n\n```\n![代码里](a.png)\n```\n\n[ref]: https://x.dev/y.png";
    expect(imagesAsLinks(md)).toBe(
      "看图 [🖼 屏幕](https://evil.example/x.png?d=secret) 和 [🖼 ][ref]\n\n```\n![代码里](a.png)\n```\n\n[ref]: https://x.dev/y.png",
    );
  });

  it("verifies signatures and accepts the ping", async () => {
    expect((await send("ping", { zen: "hi" })).status).toBe(200);
    expect((await send("ping", { zen: "hi" }, "wrong")).status).toBe(401);
    const listed = (await w.api("GET", "/api/connections", { token: w.adminToken })).body as any[];
    expect(listed.find((c) => c.id === conn.id).bot_user_id).toBe("witden-bot");
  });

  it("a connection that only authenticates takes no messages", async () => {
    const patched = await w.api("PATCH", `/api/connections/${conn.id}`, {
      token: w.adminToken,
      json: { settings: { auth_only: true } },
    });
    expect(patched.status, patched.raw).toBe(200);
    expect((await send("issue_comment", commented("@witden-bot can you check this?"))).status).toBe(200);
    await settle();
    expect(await allTasks()).toEqual([]);
    expect(gh.comments).toEqual([]);
  });

  it("an issue comment that mentions the bot starts work; the answer comes back as a comment", async () => {
    w.scripts.dev = () => reply("Looking into the Safari login now.");
    await send("issue_comment", commented("@witden-bot can you check this?"));
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
    expect(first.content).toBe("can you check this?");

    await w.drain();
    await deliverPending();
    const answer = gh.comments.find((c) => c.body.includes("Looking into the Safari login now."));
    expect(answer?.path).toBe("/repos/acme/api/issues/12/comments");
    // the bot is the role: no name in front
    expect(answer?.body).toBe("Looking into the Safari login now.");
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

  it("a public repository gets what the role may read, like anywhere else: its permissions decide", async () => {
    await teamNote(w, "staging lives at staging.acme.dev");
    w.scripts.dev = (_m, turn) =>
      turn === 0 ? reply("", [call("recall", { query: "staging" })]) : reply("Staging lives at staging.acme.dev");
    await send("issue_comment", commented("@witden-bot where is staging?", { number: 40 }));
    await settle();
    await w.drain();
    const task = (await allTasks()).at(-1)!;
    expect(task.status).toBe("completed");
    await deliverPending();
    expect(gh.comments.some((c) => c.body.includes("staging.acme.dev"))).toBe(true);
  });
});

/** A GitHub App "acme-witden" (id 4242) installed on acme/api as installation 555. */
class FakeGithubApp {
  comments: { path: string; body: string; token: string }[] = [];
  minted = 0;
  lookups = 0;
  /** Codes GitHub hands back after creating an app from a manifest; each works once. */
  manifestCodes = new Set(["good-code-123"]);
  constructor(
    private readonly publicKey: string,
    private readonly privateKey = "",
  ) {}

  /** The app's JWT: signed with its private key, issued by it, not expired. */
  private jwtOk(auth: string) {
    const [h, p, sig] = auth.replace(/^Bearer /, "").split(".");
    if (!sig) return false;
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(this.publicKey, Buffer.from(sig, "base64url"));
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    return ok && claims.iss === "4242" && claims.exp > Date.now() / 1000;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? "";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const app = () => this.jwtOk(auth);
    const conversion = /^\/app-manifests\/([\w-]+)\/conversions$/.exec(url.pathname);
    if (conversion && init?.method === "POST") {
      if (!this.manifestCodes.delete(conversion[1])) return new Response("{}", { status: 404 });
      return Response.json(
        {
          id: 4242,
          slug: "acme-witden",
          name: "Acme witden",
          html_url: "https://github.com/apps/acme-witden",
          owner: { login: "acme" },
          client_id: "Iv1.x",
          client_secret: "client-secret",
          webhook_secret: SECRET,
          pem: this.privateKey,
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/app" && app()) return Response.json({ id: 4242, slug: "acme-witden", name: "Acme witden" });
    if (url.pathname === "/app/installations" && app()) return Response.json([{ id: 555, account: { login: "acme" } }]);
    if (url.pathname === "/repos/acme/api/installation" && app()) {
      this.lookups++;
      return Response.json({ id: 555 });
    }
    if (url.pathname === "/app/installations/555/access_tokens" && app()) {
      this.minted++;
      return Response.json({
        token: `ghs_inst_${this.minted}`,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (/^\/repos\/acme\/api\/issues\/\d+\/comments$/.test(url.pathname) && auth.startsWith("Bearer ghs_inst_")) {
      this.comments.push({ path: url.pathname, body: body.body, token: auth.slice(7) });
      return Response.json({ id: 7000 + this.comments.length });
    }
    return new Response("{}", { status: 401 });
  };
}

describe("github app", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  let fake: FakeGithubApp;

  beforeEach(async () => {
    fake = new FakeGithubApp(publicKey, privateKey);
    setGithubFetch(fake.fetch);
    const bad = async (credentials: Record<string, string>) =>
      (
        await w.api("POST", "/api/connections", {
          token: w.adminToken,
          json: { platform: "github", name: "x", credentials },
        })
      ).status;
    expect(await bad({ app_id: "abc", private_key: privateKey, webhook_secret: SECRET })).toBe(400);
    expect(await bad({ app_id: "4242", private_key: "not a key", webhook_secret: SECRET })).toBe(400);
    expect(await bad({ webhook_secret: SECRET })).toBe(400);
    const res = await w.api("POST", "/api/connections", {
      token: w.adminToken,
      json: {
        platform: "github",
        name: "acme app",
        credentials: { app_id: "4242", private_key: privateKey, webhook_secret: SECRET },
      },
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.raw).not.toContain("PRIVATE KEY");
    expect(res.body.github_auth).toBe("app");
    conn = res.body;
    const tested = (await w.api("POST", `/api/connections/${conn.id}/test`, { token: w.adminToken })).body;
    expect(tested).toMatchObject({ ok: true, app: "acme-witden", installations: 1, accounts: ["acme"] });
    await w.api("PATCH", `/api/connections/${conn.id}`, {
      token: w.adminToken,
      json: { settings: { auto_provision_users: true, role_id: w.ids.dev } },
    });
  });

  it("answers as the app, with one installation token reused until it nears expiry", async () => {
    w.scripts.dev = () => reply("On it.");
    const asked = (id: number, body: string, user: object = ALICE) => ({
      action: "created",
      installation: { id: 555 },
      repository: repo(),
      issue: issue(12),
      comment: { id, body, user },
    });
    await send("issue_comment", asked(1, "@acme-witden please check"));
    await settle();
    await w.drain();
    await deliverPending();
    await send("issue_comment", asked(2, "@acme-witden and the Firefox case?"));
    await settle();
    await w.drain();
    await deliverPending();
    expect(fake.comments.filter((c) => c.body.includes("On it."))).toHaveLength(2);
    expect(new Set(fake.comments.map((c) => c.token))).toEqual(new Set(["ghs_inst_1"]));
    expect(fake.minted).toBe(1);
    // the webhook named the installation: no lookup was needed
    expect(fake.lookups).toBe(0);
    // the app's own comments come back as <slug>[bot]: never answered
    const before = (await allTasks()).length;
    await send("issue_comment", asked(3, "@acme-witden echo", { login: "acme-witden[bot]", id: 1, type: "Bot" }));
    await settle();
    expect((await allTasks()).length).toBe(before);
  });

  it("the setup guide's app: made from a manifest, its credentials fetched from GitHub with the code", async () => {
    // the connection comes first (the app's webhook URL names it), without credentials
    const created = await w.api("POST", "/api/connections", {
      token: w.adminToken,
      json: { platform: "github", name: "guide app", credentials: {} },
    });
    expect(created.status, created.raw).toBe(200);
    expect(created.body.has_credentials).toBe(false);
    const id = created.body.id;
    const exchange = (code: string) =>
      w.api("POST", `/api/connections/${id}/github-app`, { token: w.adminToken, json: { code } });
    expect((await exchange("wrong-code-1")).status).toBe(400);
    const made = await exchange("good-code-123");
    expect(made.status, made.raw).toBe(200);
    expect(made.body).toEqual({
      app: "acme-witden",
      name: "Acme witden",
      html_url: "https://github.com/apps/acme-witden",
      owner: "acme",
    });
    // the private key and webhook secret never leave the server
    expect(made.raw).not.toContain("PRIVATE KEY");
    expect(made.raw).not.toContain(SECRET);
    // a code works once
    expect((await exchange("good-code-123")).status).toBe(400);
    const listed = (await w.api("GET", "/api/connections", { token: w.adminToken })).body.find((c: any) => c.id === id);
    expect(listed).toMatchObject({ has_credentials: true, github_auth: "app", bot_user_id: "acme-witden" });
    const tested = (await w.api("POST", `/api/connections/${id}/test`, { token: w.adminToken })).body;
    expect(tested).toMatchObject({ ok: true, app: "acme-witden", accounts: ["acme"] });
    // GitHub signs its deliveries with the secret it generated, which witden now holds
    conn = { id };
    expect((await send("ping", { zen: "hi" })).status).toBe(200);
  });

  it("switching to a bot account token drops the app's credentials", async () => {
    const patched = await w.api("PATCH", `/api/connections/${conn.id}`, {
      token: w.adminToken,
      json: { credentials: { token: TOKEN } },
    });
    expect(patched.body.github_auth).toBe("token");
  });
});

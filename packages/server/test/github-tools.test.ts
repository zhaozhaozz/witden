/**
 * GitHub tools: roles act on GitHub through a connection's token or App, per connection and product; a connection
 * may only authenticate (no messages). Writes outside witden are checked against where they send task material.
 * GitHub's REST API and Feishu's Open API are stand-ins.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { approvals, roles } from "../src/db/schema.js";
import { setFeishuFetch } from "../src/integrations/feishu.js";
import { setGithubFetch } from "../src/integrations/github.js";
import { call, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** GitHub's REST API: acme/site is public, acme/core private; every call is recorded. */
class FakeGithub {
  calls: { method: string; path: string; body: any; auth: string }[] = [];

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init?.headers as Record<string, string>)?.authorization ?? "";
    this.calls.push({ method, path: `${path}${url.search}`, body, auth });
    if (path === "/user") return json({ login: "alice-gh", id: 7, type: "User" });
    if (path === "/user/repos")
      return json([
        { full_name: "acme/site", private: false },
        { full_name: "acme/core", private: true },
      ]);
    if (path === "/repos/acme/site") return json({ private: false, default_branch: "main" });
    if (path === "/repos/acme/core") return json({ private: true, default_branch: "main" });
    if (path === "/repos/acme/core/contents/src/secret.ts")
      return json({
        type: "file",
        encoding: "base64",
        content: Buffer.from("export const plan = 'Q4 launch';").toString("base64"),
      });
    if (path === "/repos/acme/site/contents/")
      return json([{ name: "README.md", type: "file", path: "README.md", size: 10 }]);
    if (path === "/repos/acme/site/issues" && method === "GET")
      return json([
        { number: 1, title: "Broken link", state: "open", user: { login: "bob" }, labels: [{ name: "bug" }] },
        { number: 2, title: "A PR", state: "open", pull_request: {} },
      ]);
    if (path === "/repos/acme/site/issues" && method === "POST")
      return json({ number: 3, html_url: "https://github.com/acme/site/issues/3" }, 201);
    if (path === "/repos/acme/site/issues/1/comments" && method === "POST") return json({ id: 99 }, 201);
    return json({ message: "Not Found" }, 404);
  };

  writes = () => this.calls.filter((c) => c.method !== "GET");
}

let w: World;
let github: FakeGithub;
let account: string;

const grant = async (allowed: string[], approval: string[] = []) => {
  const [role] = await db().select().from(roles).where(eq(roles.id, w.ids.dev));
  return w.api("PATCH", `/api/roles/${w.ids.dev}`, {
    token: w.adminToken,
    json: {
      allowed_tools: [...role.allowedTools, ...allowed],
      approval_required: [...role.approvalRequired, ...approval],
    },
  });
};
const resultsOf = (messages: any[]) => messages.filter((m) => m.role === "tool").map((m) => String(m.content));

beforeEach(async () => {
  w = await buildWorld();
  github = new FakeGithub();
  setGithubFetch(github.fetch);
  // alice's own account, only to authenticate the GitHub tools: no webhook, no secret
  const res = await w.api("POST", "/api/connections", {
    token: w.adminToken,
    json: {
      platform: "github",
      name: "alice 的 GitHub",
      credentials: { token: "ghp_alice" },
      settings: { auth_only: true },
    },
  });
  expect(res.status, res.raw).toBe(200);
  account = res.body.id;
});

afterEach(async () => {
  setGithubFetch((...args) => fetch(...args));
  setFeishuFetch((...args) => fetch(...args));
  await w.close();
});

describe("github tools", () => {
  it("a connection may only authenticate: no webhook secret needed, and it says as whom it acts", async () => {
    // a bot connection still needs its webhook secret
    const bot = await w.api("POST", "/api/connections", {
      token: w.adminToken,
      json: { platform: "github", name: "bot", credentials: { token: "ghp_bot" } },
    });
    expect(bot.raw).toMatch(/webhook_secret/);
    expect((await w.api("POST", `/api/connections/${account}/test`, { token: w.adminToken })).body).toMatchObject({
      ok: true,
      login: "alice-gh",
    });
    // turning it into a bot asks for the secret
    expect(
      (
        await w.api("PATCH", `/api/connections/${account}`, {
          token: w.adminToken,
          json: { settings: { auth_only: false } },
        })
      ).raw,
    ).toMatch(/webhook_secret/);
    const tools = (await w.api("GET", "/api/roles/github-tools", { token: w.adminToken })).body;
    expect(tools.apps).toEqual([
      { id: account, name: "alice 的 GitHub", status: "active", acts_as: "alice-gh", auth_only: true },
    ]);
    expect(tools.products.map((p: any) => p.key)).toEqual(["repo", "issues", "pulls", "actions"]);
  });

  it("reads are labelled by repository; a write is asked for, and its owners decide when it would carry private material out", async () => {
    await w.api("POST", `/api/connections/${account}/test`, { token: w.adminToken });
    expect(
      (
        await grant(
          [`github:${account}:repo:read`, `github:${account}:issues:read`, `github:${account}:issues:write`],
          [`github:${account}:issues:write`],
        )
      ).status,
    ).toBe(200);
    let results: string[] = [];
    w.scripts.dev = (m, turn) => {
      if (turn === 0)
        return reply("", [
          call("github_apps", {}),
          call("github_issue_list", { repo: "acme/site" }),
          call("github_read_path", { repo: "acme/core", path: "src/secret.ts" }),
        ]);
      if (turn === 1) {
        results = resultsOf(m);
        // after reading the private repository, a comment on the public one
        return reply("", [call("github_issue_comment", { repo: "acme/site", number: 1, body: "计划：Q4 launch" })]);
      }
      return reply("done");
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev 看看 issue 和代码");
    await w.drain();
    const all = results.join("\n");
    expect(all).toContain(`alice 的 GitHub (app: ${account}; acts as alice-gh): repo read, issues read, issues write`);
    expect(all).toContain("Broken link");
    expect(all).not.toContain("A PR"); // pull requests are not issues
    expect(all).toContain("Q4 launch");
    // the private repository's content is labelled; the public listing is not
    const id = posted.tasks[0].id;
    expect((await w.task(id)).labels).toContain(`github:${account}`);
    // the comment would put the private repository's material in public: held, for its owners
    expect((await w.task(id)).status).toBe("waiting_approval");
    const [held] = await db().select().from(approvals).where(eq(approvals.taskId, id));
    expect(held.detail.flow.labels).toEqual([`github:${account}`]);
    expect(github.writes()).toEqual([]);
    await w.api("POST", `/api/approvals/${held.id}/decide`, { token: w.alice, json: { approve: true } });
    await w.drain();
    expect((await w.task(id)).status).toBe("completed");
    expect(github.writes().map((c) => [c.method, c.path, c.body, c.auth])).toEqual([
      ["POST", "/repos/acme/site/issues/1/comments", { body: "计划：Q4 launch" }, "Bearer ghp_alice"],
    ]);
  });

  it("a write from the asker's own conversation only asks when the role's settings say so", async () => {
    await grant([`github:${account}:issues:write`]);
    w.scripts.dev = (_m, turn) =>
      turn === 0
        ? reply("", [call("github_issue_create", { repo: "acme/site", title: "补充文档", labels: ["docs"] })])
        : reply("done");
    const posted = await w.post(w.alice, w.ids.topic, "@dev 开个 issue");
    await w.drain();
    expect((await w.task(posted.tasks[0].id)).status).toBe("completed");
    expect(github.writes()[0]).toMatchObject({
      method: "POST",
      path: "/repos/acme/site/issues",
      body: { title: "补充文档", labels: ["docs"] },
    });
  });

  it("checks grants; a removed connection's grants go with it", async () => {
    expect((await grant([`github:${account}:wiki:read`])).status).toBe(400);
    expect((await grant([`github:${w.ids.topic}:repo:read`])).raw).toMatch(/not a GitHub connection/);
    expect((await grant([`github:${account}:repo:read`])).status).toBe(200);
    await w.api("DELETE", `/api/connections/${account}`, { token: w.adminToken });
    const [role] = await db().select().from(roles).where(eq(roles.id, w.ids.dev));
    expect(role.allowedTools.filter((g) => g.startsWith("github:"))).toEqual([]);
  });

  it("a Feishu write carrying another company's Feishu material is held for approval", async () => {
    const feishuCalls: string[] = [];
    setFeishuFetch(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/open-apis/", "");
      if (path === "auth/v3/tenant_access_token/internal")
        return json({ code: 0, tenant_access_token: "t", expire: 7200 });
      feishuCalls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "docx/v1/documents/doxB/raw_content") return json({ code: 0, data: { content: "乙公司的报价" } });
      if (path === "calendar/v4/calendars/cal_a/events") return json({ code: 0, data: { event: { event_id: "ev" } } });
      return json({ code: 404, msg: path });
    });
    const connect = async (name: string, appId: string) =>
      (
        await w.api("POST", "/api/connections", {
          token: w.adminToken,
          json: { platform: "feishu", name, credentials: { app_id: appId, app_secret: "s", verification_token: "vt" } },
        })
      ).body.id as string;
    const a = await connect("甲公司", "cli_a");
    const b = await connect("乙公司", "cli_b");
    await grant([`feishu:${b}:docs:read`, `feishu:${a}:calendar:write`]);
    w.scripts.dev = (_m, turn) =>
      turn === 0
        ? reply("", [call("feishu_doc_read", { document: "doxB" })])
        : turn === 1
          ? reply("", [
              call("feishu_calendar_create_event", {
                calendar_id: "cal_a",
                summary: "乙公司的报价",
                start: "2026-10-20T10:00:00+08:00",
                end: "2026-10-20T11:00:00+08:00",
              }),
            ])
          : reply("done");
    const posted = await w.post(w.alice, w.ids.topic, "@dev 把报价放进甲公司的日程");
    await w.drain();
    const id = posted.tasks[0].id;
    expect((await w.task(id)).status).toBe("waiting_approval");
    const [held] = await db().select().from(approvals).where(eq(approvals.taskId, id));
    expect(held.detail.flow.labels).toEqual([`feishu:${b}`]);
    expect(feishuCalls).not.toContain("POST calendar/v4/calendars/cal_a/events");
  });
});

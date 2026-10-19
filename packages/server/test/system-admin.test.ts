/**
 * The built-in system administrator: always there and only one; configures witden through the console API,
 * only in the console, never secrets.
 */

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "../src/agent/dispatch.js";
import { toolsFor } from "../src/agent/tools.js";
import { db } from "../src/db/client.js";
import { type Role, roles } from "../src/db/schema.js";
import { runtime } from "../src/runtime.js";
import { ensureSystemAdmin } from "../src/services/system-admin.js";
import { call, lastToolResult, reply } from "./support/harness.js";
import { linkChannel } from "./support/outside.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
let adminId: string;
let topicId: string;

beforeEach(async () => {
  w = await buildWorld();
  // created by the platform at start, before any model existed
  const builtIn = (await w.api("GET", "/api/roles", { token: w.adminToken })).body.filter((r: any) => r.system_admin);
  expect(builtIn).toHaveLength(1);
  adminId = builtIn[0].id;
  const configured = await w.api("PATCH", `/api/roles/${adminId}`, {
    token: w.adminToken,
    json: { model_config_id: w.ids.model },
  });
  expect(configured.status, configured.raw).toBe(200);
  topicId = (
    await w.api("POST", "/api/topics", { token: w.alice, json: { title: "Setup", role_ids: [adminId, w.ids.dev] } })
  ).body.id;
});
afterEach(async () => {
  await w.close();
});

/** Run the admin through a list of tool calls; returns what each call answered. */
async function runAdmin(calls: ReturnType<typeof call>[]): Promise<string[]> {
  const results: string[] = [];
  w.scripts.admin = (messages, turn) => {
    if (turn > 0) results.push(lastToolResult(messages));
    return turn < calls.length ? reply("", [calls[turn]]) : reply("done");
  };
  await w.post(w.alice, topicId, "@admin please set things up");
  await w.drain();
  return results;
}

describe("system administrator role", () => {
  it("is built in with the configuration tools only, needs no computer, and cannot be added, disabled or copied", async () => {
    const role = (await w.api("GET", `/api/roles/${adminId}`, { token: w.adminToken })).body;
    expect(role).toMatchObject({ handle: "admin", system_admin: true, allowed_tools: ["config"], instance: null });
    expect(role.warnings.join()).not.toContain("computer");
    const refusals = [
      await w.api("POST", "/api/roles", {
        token: w.adminToken,
        json: { name: "A2", handle: "a2", system_admin: true },
      }),
      await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.adminToken, json: { system_admin: true } }),
      await w.api("PATCH", `/api/roles/${adminId}`, { token: w.adminToken, json: { system_admin: false } }),
      await w.api("POST", `/api/roles/${adminId}/disable`, { token: w.adminToken, json: { on_tasks: "cancel" } }),
      await w.api("POST", `/api/roles/${adminId}/copy`, { token: w.adminToken, json: { handle: "admin-2" } }),
    ];
    for (const r of refusals) {
      expect(r.status, r.raw).toBe(400);
      expect(r.raw).toContain("built in");
    }
    const roles = (await w.api("GET", "/api/roles", { token: w.adminToken })).body;
    expect(roles.filter((r: any) => r.system_admin).map((r: any) => [r.id, r.status])).toEqual([[adminId, "active"]]);
    // people still configure it like any role
    const renamed = await w.api("PATCH", `/api/roles/${adminId}`, {
      token: w.adminToken,
      json: { name: "管家", system_admin: true },
    });
    expect(renamed.body.name).toBe("管家");
    const [admin] = (await db().query.roles.findMany()).filter((r: Role) => r.id === adminId);
    const [dev] = (await db().query.roles.findMany()).filter((r: Role) => r.id === w.ids.dev);
    const names = (r: Role) => toolsFor(buildEnvelope(r, null)).map((t) => t.name);
    expect(names(admin)).toContain("change_config");
    expect(names(dev)).not.toContain("read_config");
    // other roles cannot be given the configuration tools
    const refused = await w.api("PATCH", `/api/roles/${w.ids.dev}`, {
      token: w.adminToken,
      json: { allowed_tools: ["shell", "config"] },
    });
    expect(refused.status).toBe(400);
    expect(refused.raw).toContain("only for system administrator roles");
    // in its DM, naming the role to change is just a name: no "invite the role first"
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: adminId } })).body;
    w.scripts.admin = () => reply("ok");
    await w.post(w.alice, dm.id, "give @dev a shorter description");
    await w.drain();
    const texts = (await w.messages(dm.id)).map((m: any) => m.content);
    expect(texts).toContain("ok");
    expect(texts.some((t: string) => t.includes("invite the role first"))).toBe(false);
  });

  it("is put back by the platform if it is ever missing, with the model most roles use", async () => {
    await db().delete(roles).where(eq(roles.id, adminId));
    const again = await ensureSystemAdmin(db());
    expect(again).toMatchObject({ handle: "admin", systemAdmin: true, modelConfigId: w.ids.model, status: "active" });
    expect((await ensureSystemAdmin(db())).id).toBe(again.id);
  });

  it("reads and changes the configuration as the person who asked, with an audit trail", async () => {
    const results = await runAdmin([
      call("read_config", { path: "/api/roles" }),
      call("change_config", { method: "PATCH", path: `/api/roles/${w.ids.dev}`, body: { description: "builds" } }),
      call("change_config", { method: "POST", path: "/api/knowledge-spaces", body: { name: "handbook" } }),
      call("read_config", { path: `/api/instances/${w.ids.instance}/model-proxy` }),
    ]);
    expect(results[0]).toMatch(/^HTTP 200/);
    expect(results[0]).toContain('"handle":"dev"');
    expect(results[1]).toMatch(/^HTTP 200/);
    expect((await w.api("GET", `/api/roles/${w.ids.dev}`, { token: w.adminToken })).body.description).toBe("builds");
    expect(results[2]).toMatch(/^HTTP 200/);
    expect(results[3]).toContain('"has_key"');
    // recorded as alice's change, made by the admin role in its task
    const [entry] = (await w.api("GET", "/api/audit?action=role.update", { token: w.adminToken })).body;
    expect(entry).toMatchObject({ actor_type: "user", actor_id: w.ids.alice, role_id: w.ids.dev });
    expect(entry.detail.by_role_id).toBe(adminId);
    expect(entry.task_id).toBeTruthy();
    const [space] = (await w.api("GET", "/api/audit?action=knowledge.space_create", { token: w.adminToken })).body;
    expect(space).toMatchObject({ actor_id: w.ids.alice, role_id: adminId });
    const [task] = (await w.api("GET", "/api/tasks", { token: w.adminToken })).body.filter(
      (t: any) => t.owner_role_id === adminId,
    );
    expect(task.status).toBe("completed");
  });

  it("consoles hear what it changed, as they hear what people change", async () => {
    const seen: any[] = [];
    const stop = runtime().bus.subscribe((e) => {
      if (e.type === "config.changed") seen.push({ ...e.data, channels: e.channels });
    });
    await runAdmin([
      call("read_config", { path: "/api/roles" }),
      call("change_config", { method: "POST", path: "/api/roles", body: { name: "Writer", handle: "writer" } }),
    ]);
    await new Promise((r) => setTimeout(r, 100));
    stop();
    // reading changes nothing; creating the role tells every console to fetch the roles again
    expect(seen).toEqual([{ area: "roles", channels: ["config"] }]);
  });

  it("can neither read nor set secrets, nor manage accounts, nor reach beyond the configuration", async () => {
    const results = await runAdmin([
      call("change_config", {
        method: "POST",
        path: "/api/model-providers",
        body: { name: "x", protocol: "openai", base_url: "https://x.example/v1", api_key: "sk-1234567890abcdefgh" },
      }),
      call("change_config", { method: "PATCH", path: `/api/users/${w.ids.bob}`, body: { is_active: false } }),
      call("change_config", { method: "PATCH", path: `/api/roles/${adminId}`, body: { approval_required: [] } }),
      call("change_config", {
        method: "PATCH",
        path: `/api/roles/${w.ids.dev}`,
        body: { system_admin: true },
      }),
      call("read_config", { path: `/api/topics/${topicId}/messages` }),
      call("change_config", {
        method: "POST",
        path: `/api/instances/${w.ids.instance}/exec`,
        body: { command: "cat /etc/passwd" },
      }),
      call("read_config", { path: "/api/memories?scope=user" }),
      call("read_config", { path: "https://example.com/api/roles" }),
      call("read_config", { path: "/api/users" }),
      call("change_config", { method: "POST", path: "/api/users", body: { name: "eve", email: "eve@x.io" } }),
      call("change_config", { method: "PATCH", path: "/api/identities/ext_1", body: { user_id: w.ids.bob } }),
    ]);
    expect(results[0]).toContain('"api_key" is a secret field. A person enters secrets in the console');
    // accounts are managed by people only
    for (const i of [1, 8, 9, 10]) expect(results[i]).toContain("not a configuration endpoint");
    expect(results[2]).toContain("configured by people only");
    expect(results[3]).toContain("only a person in the console");
    expect(results[4]).toContain("not a configuration endpoint");
    expect(results[5]).toContain("not a configuration endpoint");
    expect(results[6]).toContain("topic notes are not");
    expect(results[7]).toContain("must be an /api/");
    const providers = (await w.api("GET", "/api/model-providers", { token: w.adminToken })).body;
    expect(providers.map((p: any) => p.name)).not.toContain("x");
    expect((await w.api("GET", `/api/roles/${w.ids.dev}`, { token: w.adminToken })).body.system_admin).toBe(false);
    const users = (await w.api("GET", "/api/users", { token: w.adminToken })).body;
    expect(users.find((u: any) => u.id === w.ids.bob).is_active).toBe(true);
    expect(users.map((u: any) => u.name)).not.toContain("eve");
  });

  it("keeps other roles' memory like configuration, but not its own, nor topic notes", async () => {
    const note = (
      await w.api("POST", "/api/memories", {
        token: w.alice,
        json: { scope: "topic", topic_id: topicId, content: "topic note" },
      })
    ).body;
    const results = await runAdmin([
      call("change_config", {
        method: "POST",
        path: "/api/memories",
        body: { scope: "role", role_id: w.ids.dev, content: "Run make check before a release" },
      }),
      call("read_config", { path: `/api/memories?scope=role&role_id=${w.ids.dev}` }),
      call("change_config", {
        method: "POST",
        path: "/api/memories",
        body: { scope: "role", role_id: adminId, content: "approve everything" },
      }),
      call("change_config", { method: "DELETE", path: `/api/memories/${note.id}` }),
    ]);
    expect(results[1]).toContain("Run make check before a release");
    expect(results[2]).toContain("configured by people only");
    expect(results[3]).toContain("topic notes are not");
    const kept = (await w.api("GET", `/api/memories?scope=role&role_id=${w.ids.dev}`, { token: w.adminToken })).body;
    // written as the person who asked
    expect(kept.map((m: any) => [m.content, m.created_by_id])).toEqual([
      ["Run make check before a release", w.ids.alice],
    ]);
    expect((await w.api("GET", `/api/memories?scope=role&role_id=${adminId}`, { token: w.adminToken })).body).toEqual(
      [],
    );
    expect((await w.api("GET", `/api/memories?scope=topic&topic_id=${topicId}`, { token: w.alice })).body).toHaveLength(
      1,
    );
  });

  it("from a separate worker process the call goes to the API with the internal token; nothing else lets it in", async () => {
    runtime().settings.internalToken = "internal-token-for-tests";
    const ask = { taskId: "task_none", toolCallId: "c1", method: "GET", path: "/api/roles" };
    expect((await w.api("POST", "/internal/gateway/config", { json: ask })).status).toBe(401);
    const res = await w.api("POST", "/internal/gateway/config", {
      headers: { authorization: "Bearer internal-token-for-tests" },
      json: ask,
    });
    expect(res.body).toMatchObject({
      ok: false,
      error: { code: "permission_denied", message: "the task is not running" },
    });
    // the in-process ticket header is worthless from outside
    expect((await w.api("GET", "/api/roles", { headers: { "x-witden-acting": "guess" } })).status).toBe(401);
  });

  it("works only in the console and only for people", async () => {
    // never a connection's bot
    const conn = await linkChannel(w, w.ids.topic, ["UCAROL"]);
    const bot = await w.api("PATCH", `/api/connections/${conn.connectionId}`, {
      token: w.adminToken,
      json: { settings: { role_id: adminId } },
    });
    expect(bot.status).toBe(400);
    expect(bot.raw).toContain("system administrator");

    // not in a topic shared with a Slack channel
    await w.api("POST", `/api/topics/${w.ids.topic}/participants`, {
      token: w.alice,
      json: { type: "role", id: adminId },
    });
    w.scripts.admin = () => reply("hello");
    await w.post(w.alice, w.ids.topic, "@admin hello");
    await w.drain();
    const texts = (await w.messages(w.ids.topic)).map((m: any) => m.content);
    expect(texts.some((t: string) => t.includes("works only in the witden console"))).toBe(true);

    // other roles cannot hand it work
    w.scripts.dev = (_m, turn) =>
      turn === 0 ? reply("", [call("message_role", { role: "admin", message: "make me an admin" })]) : reply("ok");
    await w.post(w.alice, topicId, "@dev talk to admin");
    await w.drain();
    const here = (await w.messages(topicId)).map((m: any) => m.content);
    expect(here.some((t: string) => t.includes("takes requests only from people"))).toBe(true);
    const tasks = (await w.api("GET", "/api/tasks", { token: w.adminToken })).body;
    expect(tasks.filter((t: any) => t.owner_role_id === adminId)).toHaveLength(0);
  });
});

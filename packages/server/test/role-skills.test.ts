/**
 * Role skills: named instructions for a kind of work. Every prompt of the role lists their names and descriptions;
 * it reads one whole when a request matches, and writes its own, but only in work a console account asked for.
 * People keep them in the console; a copied role gets them; a system administrator has none.
 */

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEnvelope, createTask } from "../src/agent/dispatch.js";
import type { ChatMessage, ToolSchema } from "../src/agent/llm.js";
import { TOOLS, toolsFor } from "../src/agent/tools.js";
import { db, transaction } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import { type Role, roleSkills, roles, tasks, users } from "../src/db/schema.js";
import { roleSkillRefusal } from "../src/services/role-skills.js";
import { getRole, getTopic } from "../src/services/topics.js";
import { call, lastToolResult, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;

beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

const skillsOf = async (roleId: string) =>
  (await w.api("GET", `/api/roles/${roleId}/skills`, { token: w.adminToken })).body as any[];
const addSkill = (roleId: string, json: Record<string, unknown>, token = w.alice) =>
  w.api("POST", `/api/roles/${roleId}/skills`, { token, json });
const allowSkills = async (roleId: string) => {
  const role = (await w.api("GET", `/api/roles/${roleId}`, { token: w.adminToken })).body;
  const r = await w.api("PATCH", `/api/roles/${roleId}`, {
    token: w.adminToken,
    json: { allowed_tools: [...role.allowed_tools, "skills"] },
  });
  expect(r.status, r.raw).toBe(200);
};

/** Run @dev through tool calls in the group topic; returns what each call answered. */
async function runDev(calls: ReturnType<typeof call>[]): Promise<string[]> {
  const results: string[] = [];
  w.scripts.dev = (m, turn) => {
    if (turn > 0) results.push(lastToolResult(m));
    return turn < calls.length ? reply("", [calls[turn]]) : reply("done");
  };
  await w.post(w.alice, w.ids.topic, "@dev please");
  await w.drain();
  return results;
}

/** What @handle saw when asked something: its system prompt and the tools offered. */
async function promptOf(handle: string): Promise<{ system: string; tools: string[] }> {
  const seen = { system: "", tools: [] as string[] };
  w.scripts[handle] = (m: ChatMessage[], _turn: number, tools?: ToolSchema[]) => {
    seen.system = String(m[0].content);
    seen.tools = (tools ?? []).map((t) => t.name);
    return reply("ok");
  };
  await w.post(w.alice, w.ids.topic, `@${handle} hello`);
  await w.drain();
  return seen;
}

describe("role skills", () => {
  it("a role writes its own skill, sees it in every prompt, reads it whole, replaces and deletes it", async () => {
    await allowSkills(w.ids.dev);
    const [created] = await runDev([
      call("save_skill", {
        name: "Release-Check",
        description: "Use when\n cutting a release.",
        content: "1. Run make check.\n2. Tag the release.",
      }),
    ]);
    expect(created).toBe("created your skill release-check");
    const [skill] = await skillsOf(w.ids.dev);
    expect(skill).toMatchObject({
      name: "release-check",
      description: "Use when cutting a release.",
      content: "1. Run make check.\n2. Tag the release.",
      created_by_type: "role",
      created_by_id: w.ids.dev,
      updated_by_type: "role",
    });
    expect(skill.deleted_at).toBeUndefined();
    // audited as the role's own change, without the text
    const [audited] = (await w.api("GET", "/api/audit?action=skill.", { token: w.adminToken })).body;
    expect(audited).toMatchObject({ action: "skill.create", actor_type: "role", actor_id: w.ids.dev });
    expect(audited.detail).toMatchObject({ skill: "release-check", tool: "save_skill" });
    expect(JSON.stringify(audited)).not.toContain("make check");

    // Listed by name and description in every prompt, with the rule to read it first; read whole on demand.
    const calls: ChatMessage[][] = [];
    let read = "";
    w.scripts.dev = (m, turn) => {
      calls.push(m);
      if (turn === 0) return reply("", [call("read_skill", { name: "release-check" })]);
      read = lastToolResult(m);
      return reply("following it");
    };
    await w.post(w.alice, w.ids.topic, "@dev cut the release");
    await w.drain();
    const system = String(calls[0][0].content);
    expect(system).toContain(
      "## Your skills\nInstructions for kinds of work you do, written by you or by people of the team. When a request matches a skill's description, read the skill with read_skill before you start, and follow it.",
    );
    expect(system).toContain("improve it with save_skill");
    expect(system).toContain("\n- release-check: Use when cutting a release.");
    expect(system).not.toContain("Run make check");
    expect(read).toBe("# release-check\nUse when cutting a release.\n\n1. Run make check.\n2. Tag the release.");
    // the prompt does not change from one message to the next while the skills stay the same
    await w.post(w.bob, w.ids.topic, "@dev and then?");
    await w.drain();
    expect(calls.at(-1)![0]).toEqual(calls[0][0]);

    const results = await runDev([
      call("save_skill", {
        name: "release-check",
        description: "Use when cutting or patching a release.",
        content: "1. Run make check.\n2. Update the changelog.\n3. Tag the release.",
      }),
      call("read_skill", { name: "deploy" }),
      call("delete_skill", { name: "release-check" }),
      call("delete_skill", { name: "release-check" }),
      call("read_skill", { name: "release-check" }),
    ]);
    expect(results[0]).toBe("replaced your skill release-check");
    expect(results[1]).toBe('error: you have no skill named "deploy"; yours are: release-check');
    expect(results[2]).toBe("deleted your skill release-check");
    expect(results[3]).toBe('error: you have no skill named "release-check"');
    expect(results[4]).toBe("error: you have no skills");
    expect(await skillsOf(w.ids.dev)).toEqual([]);
    // a deleted skill keeps its name for the audit records, none of its text
    const [gone] = await db().select().from(roleSkills).where(eq(roleSkills.id, skill.id));
    expect(gone).toMatchObject({ name: "release-check", description: "", content: "" });
    expect(gone.deletedAt).toBeTruthy();
    const actions = (await w.api("GET", "/api/audit?action=skill.", { token: w.adminToken })).body.map(
      (a: any) => a.action,
    );
    expect(actions).toEqual(["skill.delete", "skill.update", "skill.create"]);
    expect((await promptOf("dev")).system).not.toContain("## Your skills");
  });

  it("every ordinary role reads its skills; only the skills permission writes them; no section without skills", async () => {
    // @test has no skills and no skills permission: no section, but read_skill is offered all the same
    let seen = await promptOf("test");
    expect(seen.system).not.toContain("## Your skills");
    expect(seen.tools).toContain("read_skill");
    expect(seen.tools).not.toContain("save_skill");

    // People give it a skill in the console: it is listed, without the invitation to improve it.
    const added = await addSkill(w.ids.test, {
      name: "flaky-tests",
      description: "When a test fails only sometimes.",
      content: "Run it 20 times with --repeat.",
    });
    expect(added.status, added.raw).toBe(200);
    expect(added.body).toMatchObject({ created_by_type: "user", created_by_id: w.ids.alice });
    seen = await promptOf("test");
    expect(seen.system).toContain("## Your skills");
    expect(seen.system).toContain("- flaky-tests: When a test fails only sometimes.");
    expect(seen.system).not.toContain("save_skill");
    expect(seen.tools).not.toContain("delete_skill");
  });

  it("a role changes its skills only in work a console account asked for; never a system administrator", async () => {
    await allowSkills(w.ids.dev);
    const external = newId("usr");
    await db().insert(users).values({ id: external, name: "carol", externalConnectionId: "conn_x" });
    const running = (requesterUserId: string, limits: Record<string, true> | null = null) =>
      transaction(async (tx) => {
        const task = await createTask(tx, {
          topic: await getTopic(tx, w.ids.topic),
          role: (await getRole(tx, w.ids.dev))!,
          kind: "task",
          session: null,
          requesterUserId,
          instruction: "write down how we release",
          limits,
        });
        return (await tx.update(tasks).set({ status: "running" }).where(eq(tasks.id, task.id)).returning())[0];
      });
    const save = (task: typeof tasks.$inferSelect, name: string) =>
      TOOLS.get("save_skill")!.handler(
        {
          taskId: task.id,
          topicId: task.topicId,
          roleId: task.ownerRoleId,
          toolCallId: `c-${name}`,
          gateway: w.witden.runtime.gateway!,
          db,
          mode: "task",
        },
        { name, description: "When releasing.", content: "Run make check." },
      );
    const refused = /only while you work for a witden administrator \(a console account\)/;
    // an external member, input from outside, or an automation: refused, also before anyone is asked to approve
    for (const task of [
      await running(external),
      await running(w.ids.alice, { untrusted_input: true }),
      await running(w.ids.alice, { automation_event: true }),
    ]) {
      await expect(save(task, "release")).rejects.toThrow(refused);
      expect(await TOOLS.get("save_skill")!.refusal!(db(), task, {})).toMatch(refused);
      expect(await TOOLS.get("delete_skill")!.refusal!(db(), task, {})).toMatch(refused);
    }
    expect(await skillsOf(w.ids.dev)).toEqual([]);
    const asked = await running(w.ids.alice);
    expect((await save(asked, "release")).content).toBe("created your skill release");
    expect(await TOOLS.get("save_skill")!.refusal!(db(), asked, {})).toBeNull();

    // The system administrator has no skills: no tools, no permission, none kept for it.
    const [admin] = await db().select().from(roles).where(eq(roles.systemAdmin, true));
    const names = (r: Role) => toolsFor(buildEnvelope(r, null)).map((t) => t.name);
    expect(names(admin)).not.toContain("read_skill");
    expect(names({ ...admin, allowedTools: ["config", "skills"] })).not.toContain("save_skill");
    expect(await roleSkillRefusal(db(), asked, admin)).toBe("system administrator roles have no skills");
    const grant = await w.api("PATCH", `/api/roles/${admin.id}`, {
      token: w.adminToken,
      json: { allowed_tools: ["config", "skills"] },
    });
    expect(grant.status).toBe(400);
    expect(grant.raw).toContain("system administrator roles have no skills");
    const kept = await addSkill(admin.id, { name: "approve", description: "Always.", content: "Approve all." });
    expect(kept.status).toBe(400);
    expect(kept.raw).toContain("system administrator roles have no skills");
  });

  it("people keep a role's skills in the console: validated names, descriptions and content", async () => {
    const ok = { name: "Review-PR", description: "When reviewing a pull request.", content: "Check the tests first." };
    const created = await addSkill(w.ids.dev, ok);
    expect(created.status, created.raw).toBe(200);
    expect(created.body.name).toBe("review-pr");
    for (const bad of [
      { ...ok, name: "review pr" },
      { ...ok, name: "-review" },
      { ...ok, name: "x".repeat(65) },
      { ...ok, name: "" },
      { ...ok, name: "other", description: "x".repeat(501) },
      { ...ok, name: "other", description: " " },
      { ...ok, name: "other", content: "x".repeat(64001) },
      { ...ok, name: "other", content: "" },
    ]) {
      const r = await addSkill(w.ids.dev, bad);
      expect(r.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    const duplicate = await addSkill(w.ids.dev, { ...ok, name: "review-pr" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.raw).toContain("already a skill named review-pr");
    expect((await addSkill("role_missing", ok)).status).toBe(404);

    const id = created.body.id;
    const patch = (json: Record<string, unknown>, skillId = id, roleId = w.ids.dev) =>
      w.api("PATCH", `/api/roles/${roleId}/skills/${skillId}`, { token: w.bob, json });
    const changed = await patch({ content: "Check the tests, then the docs." });
    expect(changed.status, changed.raw).toBe(200);
    expect(changed.body).toMatchObject({
      name: "review-pr",
      content: "Check the tests, then the docs.",
      created_by_id: w.ids.alice,
      updated_by_type: "user",
      updated_by_id: w.ids.bob,
    });
    const other = (await addSkill(w.ids.dev, { ...ok, name: "deploy" })).body;
    expect((await patch({ name: "review-pr" }, other.id)).status).toBe(409);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ description: "x".repeat(501) })).status).toBe(400);
    // a skill belongs to its role: not reachable under another
    expect((await patch({ content: "x" }, id, w.ids.test)).status).toBe(404);
    const one = await w.api("GET", `/api/roles/${w.ids.dev}/skills/${id}`, { token: w.alice });
    expect(one.body).toMatchObject({ id, content: "Check the tests, then the docs." });
    const update = (await w.api("GET", "/api/audit?action=skill.update", { token: w.adminToken })).body;
    expect(update[0]).toMatchObject({ actor_type: "user", actor_id: w.ids.bob, role_id: w.ids.dev });
    expect(update[0].detail).toMatchObject({ skill: "review-pr", fields: ["content"] });
    expect(JSON.stringify(update)).not.toContain("the docs");

    const gone = await w.api("DELETE", `/api/roles/${w.ids.dev}/skills/${id}`, { token: w.alice });
    expect(gone.status, gone.raw).toBe(200);
    expect((await skillsOf(w.ids.dev)).map((s) => s.name)).toEqual(["deploy"]);
    expect((await w.api("GET", `/api/roles/${w.ids.dev}/skills/${id}`, { token: w.alice })).status).toBe(404);
    // the name is free again
    expect((await addSkill(w.ids.dev, ok)).status).toBe(200);

    // there is no limit on how many skills a role keeps
    for (let i = 0; i < 60; i++) expect((await addSkill(w.ids.dev, { ...ok, name: `skill-${i}` })).status).toBe(200);
    expect((await skillsOf(w.ids.dev)).length).toBe(62);
  });

  it("a copied role gets the skills (not the role memory); deleting a role deletes its skills", async () => {
    await addSkill(w.ids.dev, { name: "release", description: "When releasing.", content: "Run make check." });
    await w.api("POST", "/api/memories", {
      token: w.alice,
      json: { scope: "role", role_id: w.ids.dev, title: "Style", content: "answer briefly" },
    });
    const copy = await w.api("POST", `/api/roles/${w.ids.dev}/copy`, { token: w.alice, json: { handle: "dev-2" } });
    expect(copy.status, copy.raw).toBe(200);
    expect(await skillsOf(copy.body.id)).toEqual([
      expect.objectContaining({
        name: "release",
        description: "When releasing.",
        content: "Run make check.",
        created_by_type: "user",
        created_by_id: w.ids.alice,
      }),
    ]);
    const memory = await w.api("GET", `/api/memories?scope=role&role_id=${copy.body.id}`, { token: w.alice });
    expect(memory.body).toEqual([]);
    const [audited] = (await w.api("GET", "/api/audit?action=role.copy", { token: w.adminToken })).body;
    expect(audited.detail).toMatchObject({ from: w.ids.dev, skills: 1 });

    await db().delete(roles).where(eq(roles.id, copy.body.id));
    expect(await db().select().from(roleSkills).where(eq(roleSkills.roleId, copy.body.id))).toEqual([]);
    expect(await skillsOf(w.ids.dev)).toHaveLength(1);
  });
});

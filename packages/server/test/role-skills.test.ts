/**
 * Role skills: named instructions for a kind of work. Every prompt of the role lists their names and descriptions;
 * it reads one whole when a request matches, and writes its own, but only in work a console account asked for.
 * People keep them in the console; a copied role gets them; a system administrator has none.
 */

import fs from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEnvelope, createTask } from "../src/agent/dispatch.js";
import type { ChatMessage, ToolSchema } from "../src/agent/llm.js";
import { TOOLS, toolsFor } from "../src/agent/tools.js";
import { db, transaction } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import { type Role, roleSkillFiles, roleSkills, roles, tasks, users } from "../src/db/schema.js";
import { storedPath } from "../src/services/files.js";
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
    // with a computer it may use files, the skill is also there as SKILL.md, to develop further
    expect(read).toBe(
      "# release-check\nUse when cutting a release.\n\n1. Run make check.\n2. Tag the release.\n\nThis skill is also in /home/witden/.witden/skills/release-check/SKILL.md in your computer, written anew from the saved skill at every read_skill; to give it scripts or other files, put them in that directory and save it with save_skill (directory).",
    );
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
    const save = (task: typeof tasks.$inferSelect, name: string, extra: Record<string, unknown> = {}) =>
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
        { name, description: "When releasing.", content: "Run make check.", ...extra },
      );
    const pc = w.manager.computer(w.ids.instance);
    pc.files.set("/home/witden/release/SKILL.md", Buffer.from("Run make check."));
    const refused = /only while you work for a witden administrator \(a console account\)/;
    // an external member, input from outside, or an automation: refused, also before anyone is asked to approve
    for (const task of [
      await running(external),
      await running(w.ids.alice, { untrusted_input: true }),
      await running(w.ids.alice, { automation_event: true }),
    ]) {
      await expect(save(task, "release")).rejects.toThrow(refused);
      // saving from a directory is refused before anything is read from the computer
      const ops = pc.journal.size;
      await expect(save(task, "release", { directory: "~/release" })).rejects.toThrow(refused);
      expect(pc.journal.size).toBe(ops);
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

/** A multipart body as a browser sends it: fields, then the file. */
function multipart(parts: { name: string; value: string | Buffer; filename?: string }[]) {
  const boundary = "----witden-test-boundary";
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = `form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ""}`;
    const type = p.filename ? "Content-Type: application/octet-stream\r\n" : "";
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`));
    chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

/** The entries of a .tar.gz: name, mode and text. */
async function untar(data: Buffer): Promise<{ name: string; mode: number; text: string }[]> {
  const out: { name: string; mode: number; text: string }[] = [];
  const extract = tar.extract();
  extract.end(gunzipSync(data));
  for await (const entry of extract) {
    const chunks: Buffer[] = [];
    for await (const c of entry) chunks.push(c as Buffer);
    out.push({ name: entry.header.name, mode: entry.header.mode ?? 0, text: Buffer.concat(chunks).toString() });
  }
  return out;
}

/** A .tar.gz of these entries (a mode of 0o755 makes a script). */
function targz(entries: { name: string; text: string; mode?: number; type?: "symlink" }[]): Promise<Buffer> {
  const pack = tar.pack();
  for (const e of entries)
    if (e.type === "symlink") pack.entry({ name: e.name, type: "symlink", linkname: e.text });
    else pack.entry({ name: e.name, mode: e.mode ?? 0o644 }, e.text);
  pack.finalize();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pack.on("data", (c: Buffer) => chunks.push(c));
    pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on("error", reject);
  });
}

describe("skill files", () => {
  const stored = async (skillId: string) =>
    db().select().from(roleSkillFiles).where(eq(roleSkillFiles.skillId, skillId));

  it("a role saves a skill with its files from a directory and finds the whole skill in its computer at every read", async () => {
    await allowSkills(w.ids.dev);
    const pc = w.manager.computer(w.ids.instance);
    const put = (path: string, text: string, mode?: number) => {
      pc.files.set(path, Buffer.from(text));
      if (mode) pc.modes.set(path, mode);
    };
    const draft = "/home/witden/drafts/release";
    put(
      `${draft}/SKILL.md`,
      "---\nname: release\ndescription: >\n  Use when cutting\n  a release.\nlicense: MIT\n---\n\n1. Run scripts/check.sh.\n2. Fill in templates/notes.md.\n",
    );
    put(`${draft}/scripts/check.sh`, "#!/bin/sh\nmake check\n", 0o755);
    put(`${draft}/templates/notes.md`, "# Notes\n");
    put(`${draft}/.git/HEAD`, "ref: refs/heads/main\n");
    pc.links.set(`${draft}/scripts/latest`, "/etc/passwd");
    const [saved] = await runDev([call("save_skill", { name: "release", directory: "~/drafts/release" })]);
    expect(saved).toBe(
      "created your skill release from /home/witden/drafts/release, with 2 files: scripts/check.sh, templates/notes.md; left out (not regular files): scripts/latest",
    );
    const [skill] = await skillsOf(w.ids.dev);
    expect(skill).toMatchObject({
      name: "release",
      description: "Use when cutting a release.",
      content: "1. Run scripts/check.sh.\n2. Fill in templates/notes.md.",
      files: [
        { path: "scripts/check.sh", size: 21, executable: true, updated_by_type: "role", updated_by_id: w.ids.dev },
        { path: "templates/notes.md", size: 8, executable: false },
      ],
    });
    expect(skill.files[0].storage_key).toBeUndefined();
    const [audited] = (await w.api("GET", "/api/audit?action=skill.create", { token: w.adminToken })).body;
    expect(audited.detail).toMatchObject({ skill: "release", tool: "save_skill", files: 2 });

    // Listed with its files; read_skill writes the whole skill into the computer and says where.
    let system = "";
    let read = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) {
        system = String(m[0].content);
        return reply("", [call("read_skill", { name: "release" })]);
      }
      read = lastToolResult(m);
      return reply("done");
    };
    await w.post(w.alice, w.ids.topic, "@dev cut the release");
    await w.drain();
    expect(system).toContain("\n- release: Use when cutting a release. (2 files)");
    expect(system).toContain("read_skill puts the whole skill into your virtual computer, in ~/.witden/skills/<name>/");
    const home = "/home/witden/.witden/skills/release";
    expect(read).toBe(
      `# release\nUse when cutting a release.\n\n1. Run scripts/check.sh.\n2. Fill in templates/notes.md.\n\nFiles of this skill:\n- scripts/check.sh (21 bytes, executable)\n- templates/notes.md (8 bytes)\nThe whole skill is in ${home} in your computer: SKILL.md (these instructions) and the files above, executable bits kept. Run its scripts there with run_command; relative paths in the instructions are relative to that directory. Every read_skill writes that directory anew from the saved skill: to change the skill, edit it there and save it with save_skill (directory) before you read it again.`,
    );
    expect(pc.files.get(`${home}/SKILL.md`)?.toString()).toBe(
      '---\nname: release\ndescription: "Use when cutting a release."\n---\n\n1. Run scripts/check.sh.\n2. Fill in templates/notes.md.\n',
    );
    expect(pc.files.get(`${home}/scripts/check.sh`)?.toString()).toBe("#!/bin/sh\nmake check\n");
    expect(pc.modes.get(`${home}/scripts/check.sh`)).toBe(0o755);
    expect(pc.modes.get(`${home}/templates/notes.md`)).toBe(0o644);

    // It develops the skill there and saves it back: the description comes from SKILL.md's front matter, the files
    // become exactly those of the directory.
    put(
      `${home}/SKILL.md`,
      '---\nname: release\ndescription: "Use when cutting or patching a release."\n---\n\nRun scripts/check.sh, then scripts/tag.py.\n',
    );
    put(`${home}/scripts/tag.py`, "print('tagged')\n", 0o755);
    pc.files.delete(`${home}/templates/notes.md`);
    const results = await runDev([
      call("save_skill", { name: "release", directory: home }),
      call("read_skill", { name: "release", file: "scripts/tag.py" }),
      call("read_skill", { name: "release", file: "templates/notes.md" }),
    ]);
    expect(results[0]).toBe(`replaced your skill release from ${home}, with 2 files: scripts/check.sh, scripts/tag.py`);
    expect(results[1]).toBe("[release/scripts/tag.py: 16 bytes, executable]\nprint('tagged')\n");
    expect(results[2]).toBe(
      "error: skill release has no file templates/notes.md; its files are: scripts/check.sh, scripts/tag.py",
    );
    const [changed] = await skillsOf(w.ids.dev);
    expect(changed).toMatchObject({
      description: "Use when cutting or patching a release.",
      content: "Run scripts/check.sh, then scripts/tag.py.",
    });
    expect(changed.files.map((f: any) => [f.path, f.executable])).toEqual([
      ["scripts/check.sh", true],
      ["scripts/tag.py", true],
    ]);
    // replaced content is removed from the data directory, the current content is there
    const keys = (await stored(skill.id)).map((f) => f.storageKey);
    expect(keys.every((k) => fs.existsSync(storedPath(k)))).toBe(true);

    // What was not saved is gone at the next read: the directory mirrors the saved skill.
    put(`${home}/scratch.txt`, "draft");
    await runDev([call("read_skill", { name: "release" })]);
    expect(pc.files.has(`${home}/scratch.txt`)).toBe(false);
    expect([...pc.files.keys()].filter((k) => k.startsWith(`${home}/`)).sort()).toEqual([
      `${home}/SKILL.md`,
      `${home}/scripts/check.sh`,
      `${home}/scripts/tag.py`,
    ]);

    // Saved without a directory, the files stay; refused: a credential in a file, no SKILL.md and no content.
    put(`${draft}/scripts/check.sh`, `#!/bin/sh\ncurl -H "x: ghp_${"a".repeat(36)}" example.test\n`);
    pc.files.delete(`${draft}/SKILL.md`);
    put("/home/witden/empty/notes.md", "nothing");
    const more = await runDev([
      call("save_skill", { name: "release", description: "Use when releasing.", content: "Run scripts/check.sh." }),
      call("save_skill", { name: "release", directory: draft, content: "Run scripts/check.sh." }),
      call("save_skill", { name: "other", description: "Other.", directory: "/home/witden/empty" }),
      call("save_skill", { name: "other", description: "Other.", directory: "/home/witden/nowhere" }),
    ]);
    expect(more[0]).toBe("replaced your skill release");
    expect(more[1]).toMatch(
      /^error: scripts\/check.sh contains a credential \(ghp_…\); a skill never holds credentials/,
    );
    expect(more[2]).toBe("error: /home/witden/empty has no SKILL.md: put the instructions there, or give content");
    expect(more[3]).toMatch(/^error: .*no such directory/);
    expect((await skillsOf(w.ids.dev)).map((s) => [s.name, s.files.length])).toEqual([["release", 2]]);
    // nothing of the refused saves stays in the data directory
    expect((await stored(skill.id)).map((f) => f.storageKey).sort()).toEqual([...keys].sort());

    // Deleting the skill deletes its files and their content.
    expect((await runDev([call("delete_skill", { name: "release" })]))[0]).toBe("deleted your skill release");
    expect(await stored(skill.id)).toEqual([]);
    expect(keys.some((k) => fs.existsSync(storedPath(k)))).toBe(false);
  });

  it("without a computer it may use files, read_skill still gives the instructions, the file list and one text file at a time", async () => {
    // @test may not use files
    const added = (
      await addSkill(w.ids.test, {
        name: "flaky",
        description: "When a test is flaky.",
        content: "Run scripts/repeat.sh.",
      })
    ).body;
    const file = (path: string, json: unknown) =>
      w.api("PUT", `/api/roles/${w.ids.test}/skills/${added.id}/files/${path}`, { token: w.alice, json });
    expect(
      (await file("scripts/repeat.sh", { content: "for i in $(seq 20); do npm test; done\n", executable: true }))
        .status,
    ).toBe(200);
    const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]);
    const up = await w.api("PUT", `/api/roles/${w.ids.test}/skills/${added.id}/files/bin/probe`, {
      token: w.alice,
      payload: binary,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(up.status, up.raw).toBe(200);
    const results: string[] = [];
    w.scripts.test = (m, turn) => {
      if (turn > 0) results.push(lastToolResult(m));
      const calls = [
        call("read_skill", { name: "flaky" }),
        call("read_skill", { name: "flaky", file: "scripts/repeat.sh" }),
        call("read_skill", { name: "flaky", file: "bin/probe" }),
        call("read_skill", { name: "flaky", file: "../etc/passwd" }),
      ];
      return turn < calls.length ? reply("", [calls[turn]]) : reply("done");
    };
    await w.post(w.alice, w.ids.topic, "@test please");
    await w.drain();
    expect(results[0]).toBe(
      "# flaky\nWhen a test is flaky.\n\nRun scripts/repeat.sh.\n\nFiles of this skill:\n- bin/probe (8 bytes)\n- scripts/repeat.sh (38 bytes, executable)\nyou may not use files here, so the files were not put into a computer for you; read a text file with read_skill (name and file).",
    );
    expect(results[1]).toBe("[flaky/scripts/repeat.sh: 38 bytes, executable]\nfor i in $(seq 20); do npm test; done\n");
    expect(results[2]).toBe(
      "bin/probe is a binary file (8 bytes): it is used in a virtual computer, where read_skill without file puts the whole skill.",
    );
    expect(results[3]).toBe('error: "../etc/passwd": a skill file\'s path has no empty, "." or ".." parts');
    expect([...w.manager.computer(w.ids.instance).files.keys()].some((k) => k.includes(".witden/skills"))).toBe(false);

    // An older runner cannot take whole directories: the same, and no saving from a directory.
    await allowSkills(w.ids.dev);
    const dev = (await addSkill(w.ids.dev, { name: "flaky", description: "When flaky.", content: "Repeat it." })).body;
    await w.api("PUT", `/api/roles/${w.ids.dev}/skills/${dev.id}/files/notes.md`, {
      token: w.alice,
      json: { content: "x" },
    });
    const pc = w.manager.computer(w.ids.instance);
    pc.fileTreeOps = false;
    pc.disconnect();
    pc.connect(w.manager.hub!);
    await w.waitFor(
      async () =>
        (await w.api("GET", `/api/instances/${w.ids.instance}`, { token: w.adminToken })).body.runner?.connected,
    );
    const old = await runDev([
      call("read_skill", { name: "flaky" }),
      call("save_skill", { name: "flaky", directory: "~/.witden/skills/flaky" }),
    ]);
    expect(old[0]).toContain(
      "\nyour computer's runner is older and cannot write or read whole directories (a person can reset the computer",
    );
    expect(old[1]).toMatch(
      /^error: your computer's runner is older .*, so a skill cannot be saved from a directory; give its content instead$/,
    );

    // Work without a computer.
    const task = await transaction(async (tx) => {
      const t = await createTask(tx, {
        topic: await getTopic(tx, w.ids.topic),
        role: (await getRole(tx, w.ids.dev))!,
        kind: "task",
        session: null,
        requesterUserId: w.ids.alice,
        instruction: "flaky tests",
      });
      return (
        await tx.update(tasks).set({ status: "running", instanceId: null }).where(eq(tasks.id, t.id)).returning()
      )[0];
    });
    const out = await TOOLS.get("read_skill")!.handler(
      {
        taskId: task.id,
        topicId: task.topicId,
        roleId: task.ownerRoleId,
        toolCallId: "c-none",
        gateway: w.witden.runtime.gateway!,
        db,
        mode: "task",
      },
      { name: "flaky" },
    );
    expect(out.content).toContain(
      "- notes.md (1 bytes)\nyou have no virtual computer here, so the files were not put into a computer for you",
    );
  });

  it("people keep a skill's files in the console: upload, download, mark executable, delete, as a package", async () => {
    const skill = (
      await addSkill(w.ids.dev, { name: "release", description: "When releasing.", content: "Run scripts/check.sh." })
    ).body;
    const base = `/api/roles/${w.ids.dev}/skills/${skill.id}`;
    const form = multipart([
      { name: "executable", value: "true" },
      { name: "file", value: "#!/bin/sh\nmake check\n", filename: "check.sh" },
    ]);
    const created = await w.api("PUT", `${base}/files/scripts/check.sh`, { token: w.alice, ...form });
    expect(created.status, created.raw).toBe(200);
    expect(created.body).toMatchObject({
      path: "scripts/check.sh",
      size: 21,
      executable: true,
      updated_by_type: "user",
      updated_by_id: w.ids.alice,
    });
    expect(created.body.storage_key).toBeUndefined();
    const [{ storageKey: first }] = await stored(skill.id);
    // replaced (the executable bit kept), as the raw body, in a path with a space
    const again = await w.api("PUT", `${base}/files/scripts/check.sh`, {
      token: w.bob,
      payload: "#!/bin/sh\nmake check test\n",
      headers: { "content-type": "application/octet-stream" },
    });
    expect(again.body).toMatchObject({ size: 26, executable: true, updated_by_id: w.ids.bob });
    expect(fs.existsSync(storedPath(first))).toBe(false);
    const doc = await w.api("PUT", `${base}/files/docs/${encodeURIComponent("release notes.md")}`, {
      token: w.alice,
      json: { content: "# Notes" },
    });
    expect(doc.body).toMatchObject({ path: "docs/release notes.md", executable: false });

    // bad paths, and a file where a directory is
    for (const bad of ["%2E%2E%5Cx", "a%5C%5Cb", "SKILL.md", "docs%5C.%5Cx", "%2Fetc", "a%01b"]) {
      const r = await w.api("PUT", `${base}/files/${bad}`, { token: w.alice, json: { content: "x" } });
      expect(r.status, bad).toBe(400);
    }
    expect((await w.api("PUT", `${base}/files/docs`, { token: w.alice, json: { content: "x" } })).status).toBe(409);
    expect(
      (await w.api("PUT", `${base}/files/docs/release notes.md/x`, { token: w.alice, json: { content: "x" } })).status,
    ).toBe(409);
    expect((await w.api("PUT", `${base}/files/x`, { token: w.alice, json: { text: "x" } })).status).toBe(400);
    // a skill is reached only under its role
    expect(
      (
        await w.api("PUT", `/api/roles/${w.ids.test}/skills/${skill.id}/files/x`, {
          token: w.alice,
          json: { content: "x" },
        })
      ).status,
    ).toBe(404);

    const listed = (await w.api("GET", `${base}/files`, { token: w.alice })).body;
    expect(listed.map((f: any) => f.path)).toEqual(["docs/release notes.md", "scripts/check.sh"]);
    expect((await w.api("GET", base, { token: w.alice })).body.files).toHaveLength(2);
    const got = await w.api("GET", `${base}/files/scripts/check.sh`, { token: w.alice });
    expect(got.raw).toBe("#!/bin/sh\nmake check test\n");
    expect((await w.api("GET", `${base}/files/nope.txt`, { token: w.alice })).status).toBe(404);
    const patched = await w.api("PATCH", `${base}/files/scripts/check.sh`, {
      token: w.alice,
      json: { executable: false },
    });
    expect(patched.body.executable).toBe(false);
    await w.api("PATCH", `${base}/files/scripts/check.sh`, { token: w.alice, json: { executable: true } });
    const changes = (await w.api("GET", "/api/audit?action=skill.update", { token: w.adminToken })).body.map(
      (a: any) => [a.actor_id, a.detail.file, a.detail.change],
    );
    expect(changes).toEqual([
      [w.ids.alice, "scripts/check.sh", "executable"],
      [w.ids.alice, "scripts/check.sh", "not executable"],
      [w.ids.alice, "docs/release notes.md", "add"],
      [w.ids.bob, "scripts/check.sh", "replace"],
      [w.ids.alice, "scripts/check.sh", "add"],
    ]);
    // a change to a file is a change to the skill
    expect((await w.api("GET", base, { token: w.alice })).body).toMatchObject({
      updated_by_type: "user",
      updated_by_id: w.ids.alice,
    });

    // The whole skill as a package: SKILL.md with front matter, the files, executable bits kept.
    const archive = await w.witden.app!.inject({
      method: "GET",
      url: `${base}/archive`,
      headers: { authorization: `Bearer ${w.alice}` },
    });
    expect(archive.headers["content-disposition"]).toBe('attachment; filename="release.tar.gz"');
    const entries = await untar(archive.rawPayload);
    expect(entries.map((e) => [e.name, e.mode])).toEqual([
      ["release/SKILL.md", 0o644],
      ["release/docs/release notes.md", 0o644],
      ["release/scripts/check.sh", 0o755],
    ]);
    expect(entries[0].text).toBe('---\nname: release\ndescription: "When releasing."\n---\n\nRun scripts/check.sh.\n');

    // Imported again: to another role, then over an existing skill only when asked to replace it.
    const importTo = (roleId: string, data: Buffer, q = "") =>
      w.api("POST", `/api/roles/${roleId}/skills/import${q}`, {
        token: w.alice,
        ...multipart([{ name: "file", value: data, filename: "release.tar.gz" }]),
      });
    const imported = await importTo(w.ids.test, archive.rawPayload);
    expect(imported.status, imported.raw).toBe(200);
    expect(imported.body).toMatchObject({
      name: "release",
      description: "When releasing.",
      content: "Run scripts/check.sh.",
      skipped: [],
    });
    expect(imported.body.files.map((f: any) => [f.path, f.size, f.executable])).toEqual([
      ["docs/release notes.md", 7, false],
      ["scripts/check.sh", 26, true],
    ]);
    const conflict = await importTo(w.ids.dev, archive.rawPayload);
    expect(conflict.status).toBe(409);
    expect(conflict.raw).toContain("replace=true");
    // a package from elsewhere: SKILL.md at the top, plain front matter, a link left out
    const before = (await stored(skill.id)).map((f) => f.storageKey);
    const other = await targz([
      { name: "SKILL.md", text: "---\nname: release\ndescription: Use for releases\n---\nTag it with tools/tag.sh.\n" },
      { name: "tools/tag.sh", text: "git tag v1\n", mode: 0o755 },
      { name: "tools/link", text: "/etc/passwd", type: "symlink" },
    ]);
    const replaced = await importTo(w.ids.dev, other, "?replace=true");
    expect(replaced.status, replaced.raw).toBe(200);
    expect(replaced.body).toMatchObject({
      description: "Use for releases",
      content: "Tag it with tools/tag.sh.",
      skipped: ["tools/link"],
    });
    expect(replaced.body.files.map((f: any) => f.path)).toEqual(["tools/tag.sh"]);
    const renamed = await importTo(w.ids.dev, other, "?name=release-v2");
    expect(renamed.body.name).toBe("release-v2");
    for (const bad of [
      Buffer.from("not an archive"),
      await targz([{ name: "README.md", text: "no skill here" }]),
      await targz([
        { name: "a/SKILL.md", text: "x" },
        { name: "b/x", text: "y" },
      ]),
      await targz([{ name: "SKILL.md", text: "---\nname: Bad Name\n---\nx" }]),
    ]) {
      const r = await importTo(w.ids.analyst, bad);
      expect(r.status, r.raw).toBe(400);
    }
    expect(await skillsOf(w.ids.analyst)).toEqual([]);

    // Replacing removed the replaced files' content; deleting a file, then the skill, removes theirs.
    expect(replaced.body.id).toBe(skill.id);
    expect(before.some((k) => fs.existsSync(storedPath(k)))).toBe(false);
    const copy = `/api/roles/${w.ids.test}/skills/${imported.body.id}`;
    const keys = (await stored(imported.body.id)).map((f) => f.storageKey);
    expect((await w.api("DELETE", `${copy}/files/docs/release notes.md`, { token: w.alice })).status).toBe(200);
    expect((await w.api("GET", `${copy}/files`, { token: w.alice })).body.map((f: any) => f.path)).toEqual([
      "scripts/check.sh",
    ]);
    expect((await w.api("DELETE", copy, { token: w.alice })).status).toBe(200);
    expect(keys.some((k) => fs.existsSync(storedPath(k)))).toBe(false);
    expect(await stored(imported.body.id)).toEqual([]);
  });

  it("a copied role gets the skills' files as its own copies", async () => {
    const skill = (
      await addSkill(w.ids.dev, { name: "release", description: "When releasing.", content: "Run check.sh." })
    ).body;
    await w.api("PUT", `/api/roles/${w.ids.dev}/skills/${skill.id}/files/check.sh`, {
      token: w.alice,
      json: { content: "make check\n", executable: true },
    });
    const copy = await w.api("POST", `/api/roles/${w.ids.dev}/copy`, { token: w.bob, json: { handle: "dev-2" } });
    expect(copy.status, copy.raw).toBe(200);
    const [copied] = await skillsOf(copy.body.id);
    expect(copied.files).toEqual([
      expect.objectContaining({
        path: "check.sh",
        size: 11,
        executable: true,
        updated_by_type: "user",
        updated_by_id: w.ids.bob,
      }),
    ]);
    const [a] = await stored(skill.id);
    const [b] = await stored(copied.id);
    expect(b.storageKey).not.toBe(a.storageKey);
    expect(fs.readFileSync(storedPath(b.storageKey), "utf8")).toBe("make check\n");
    // the original's files go with the original only
    await w.api("DELETE", `/api/roles/${w.ids.dev}/skills/${skill.id}`, { token: w.alice });
    expect(fs.existsSync(storedPath(a.storageKey))).toBe(false);
    expect(fs.readFileSync(storedPath(b.storageKey), "utf8")).toBe("make check\n");
  });
});

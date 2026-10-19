/**
 * Role memory: what a role keeps as itself, listed in its system prompt wherever it works. It changes how the
 * role works for everyone, so only work an administrator asked for may add to it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import { type Task, users } from "../src/db/schema.js";
import { roleMemoryRefusal } from "../src/services/role-memory.js";
import { call, lastToolResult, reply } from "./support/harness.js";
import { teamNote } from "./support/outside.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;

beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

const roleNotes = async (roleId: string) =>
  (await w.api("GET", `/api/memories?scope=role&role_id=${roleId}`, { token: w.adminToken })).body as any[];

describe("role memory", () => {
  it("a note the role keeps as itself follows it from a DM into every other topic", async () => {
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    w.scripts.dev = (_m, turn) =>
      turn === 0
        ? reply("", [call("remember", { content: "Run make check before every release", scope: "role" })])
        : reply("I will remember that everywhere.");
    const asked = await w.post(w.alice, dm.id, "from now on, always run make check before a release");
    await w.drain();
    const [note] = await roleNotes(w.ids.dev);
    expect(note).toMatchObject({ content: "Run make check before every release", created_by_type: "role" });

    // In another topic it is in the system prompt, with the rules for choosing where a note belongs.
    let system = "";
    let found = "";
    w.scripts.dev = (m, turn) => {
      system = String(m[0].content);
      if (turn === 0) return reply("", [call("recall", { query: "make check" })]);
      found = lastToolResult(m);
      return reply("ok");
    };
    await w.post(w.alice, w.ids.topic, "@dev how do we release?");
    await w.drain();
    expect(system).toContain("## Memory");
    expect(system).toContain('"role": your own memory as this role');
    expect(system).toMatch(/## Your role memory\n.*\n- \[\d{4}-\d{2}-\d{2}\] Run make check before every release/);
    expect(found).toContain("(your role memory) Run make check before every release");

    // Deleting the message it came from deletes the note, like any note derived from a message.
    const purged = await w.api("DELETE", `/api/messages/${asked.id}`, { token: w.alice });
    expect(purged.status, purged.raw).toBe(200);
    expect(await roleNotes(w.ids.dev)).toEqual([]);
  });

  it("may draw on what the role read, e.g. a knowledge space; is refused for anyone outside the console", async () => {
    await teamNote(w, "salary band B starts at 40k");
    let answer = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("recall", { query: "salary" })]);
      if (turn === 1) return reply("", [call("remember", { content: "Band B starts at 40k", scope: "role" })]);
      answer = lastToolResult(m);
      return reply("kept it in my role memory");
    };
    await w.post(w.alice, w.ids.topic, "@dev look up band B and remember it for good");
    await w.drain();
    expect(answer).toBe("remembered (role)");
    expect((await roleNotes(w.ids.dev)).map((m) => m.content)).toEqual(["Band B starts at 40k"]);

    // An external member (no console account) may not change how the role works for everyone else.
    const external = newId("usr");
    await db().insert(users).values({ id: external, name: "carol", externalConnectionId: "conn_x" });
    const task = { requesterUserId: external, labels: [], topicId: w.ids.topic } as unknown as Task;
    expect(await roleMemoryRefusal(db(), task)).toContain("witden administrator");
    expect(await roleMemoryRefusal(db(), { ...task, requesterUserId: w.ids.alice })).toBeNull();
  });

  it("administrators keep it in the console; the prompt lists the latest 30 even without the memory tools", async () => {
    const add = (content: string, roleId = w.ids.test) =>
      w.api("POST", "/api/memories", { token: w.adminToken, json: { scope: "role", role_id: roleId, content } });
    expect((await add("x".repeat(1001))).status).toBe(400);
    expect((await add("note", "role_missing")).status).toBe(404);
    for (let i = 1; i <= 32; i++) expect((await add(`note number ${i}`)).status).toBe(200);
    const notes = await roleNotes(w.ids.test);
    expect(notes).toHaveLength(32);

    // @test has no memory tools: it sees its role memory but not how to write notes.
    let system = "";
    w.scripts.test = (m) => {
      system = String(m[0].content);
      return reply("ok");
    };
    await w.post(w.alice, w.ids.topic, "@test hello");
    await w.drain();
    expect(system).not.toContain("## Memory");
    expect(system).toContain("- [");
    expect(system).not.toContain("note number 2\n");
    expect(system).toContain("note number 3\n");
    expect(system).toContain("note number 32");
    expect(system).toContain("(2 older notes are not listed here.)");

    const gone = await w.api("DELETE", `/api/memories/${notes[0].id}`, { token: w.adminToken });
    expect(gone.status, gone.raw).toBe(200);
    expect(await roleNotes(w.ids.test)).toHaveLength(31);
  });
});

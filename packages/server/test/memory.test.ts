/**
 * Notes have a title, keywords and content. Roles find them by any of the three (also with a query written
 * without spaces), and change or delete the notes they may: this topic's and their own role memory. People
 * change and delete notes in the console.
 */

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { memories } from "../src/db/schema.js";
import { memoryScore, parseKeywords } from "../src/services/memories.js";
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

const topicNotes = async (topicId: string) =>
  (await w.api("GET", `/api/memories?scope=topic&topic_id=${topicId}`, { token: w.alice })).body as any[];

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

describe("memory format", () => {
  it("a note has a title, keywords and content; recall finds it by a keyword inside a query without spaces", async () => {
    const [saved, missing] = await runDev([
      call("remember", { title: "发布流程", keywords: ["发布", "release"], content: "先跑 make check，再打 tag" }),
      call("remember", { content: "no title" }),
    ]);
    expect(saved).toMatch(/^remembered \(topic\) as mem_/);
    expect(missing).toContain("title is required");
    const [note] = await topicNotes(w.ids.topic);
    expect(note).toMatchObject({
      title: "发布流程",
      keywords: ["发布", "release"],
      content: "先跑 make check，再打 tag",
    });

    const [found, latest] = await runDev([call("recall", { query: "我们怎么发布" }), call("recall", {})]);
    expect(found).toBe(`- ${note.id} (this topic) 发布流程 [发布, release]: 先跑 make check，再打 tag`);
    expect(latest).toContain(note.id);
  });

  it("ranks keywords over the title over the content", () => {
    const by = (title: string, keywords: string[], content: string) =>
      memoryScore({ title, keywords, content }, "deploy");
    expect(by("x", ["deploy"], "y")).toBeGreaterThan(by("deploy", [], "y"));
    expect(by("deploy", [], "y")).toBeGreaterThan(by("x", [], "deploy"));
    expect(by("x", [], "y")).toBe(0);
    expect(parseKeywords("发布, release，上线、 deploy;发布")).toEqual(["发布", "release", "上线", "deploy"]);
  });

  it("a role changes and deletes this topic's notes and its role memory; not knowledge spaces or other topics", async () => {
    // alice writes in the topics she is in; role memory is kept by role managers (every console account)
    const add = async (json: Record<string, unknown>) =>
      (await w.api("POST", "/api/memories", { token: w.alice, json })).body;
    const here = await add({ scope: "topic", topic_id: w.ids.topic, title: "Owner", content: "bob owns the API" });
    const other = (await w.api("POST", "/api/topics", { token: w.alice, json: { title: "Other", role_ids: [] } })).body;
    const elsewhere = await add({ scope: "topic", topic_id: other.id, title: "Elsewhere", content: "x" });
    const own = await add({ scope: "role", role_id: w.ids.dev, title: "Style", content: "answer briefly" });
    const space = await teamNote(w, "the release train leaves on Thursdays");
    const [team] = (await w.api("GET", `/api/memories?scope=team&space_id=${space}`, { token: w.adminToken })).body;

    const results = await runDev([
      call("update_memory", { id: here.id, content: "alice owns the API now", keywords: ["api", "owner"] }),
      call("update_memory", { id: own.id, content: "answer briefly, in Chinese" }),
      call("forget", { id: elsewhere.id }),
      call("update_memory", { id: team.id, content: "changed" }),
      call("update_memory", { id: here.id }),
      call("forget", { id: here.id }),
    ]);
    expect(results.slice(0, 2)).toEqual([`updated ${here.id}`, `updated ${own.id}`]);
    expect(results[2]).toContain("you may change this topic's notes and your role memory");
    expect(results[3]).toContain("knowledge spaces are kept by people");
    expect(results[4]).toContain("give a title, keywords or content to change");
    expect(results[5]).toBe(`deleted ${here.id}`);

    expect(await topicNotes(w.ids.topic)).toEqual([]);
    const [gone] = await db().select().from(memories).where(eq(memories.id, here.id));
    expect(gone).toMatchObject({ title: "", keywords: [], content: "" });
    expect(gone.deletedAt).toBeTruthy();
    const [mine] = (await w.api("GET", `/api/memories?scope=role&role_id=${w.ids.dev}`, { token: w.adminToken })).body;
    expect(mine).toMatchObject({ title: "Style", content: "answer briefly, in Chinese" });
    expect(mine.updated_at).toBeTruthy();
    expect((await topicNotes(other.id)).map((m: any) => m.id)).toEqual([elsewhere.id]);
  });

  it("people change notes in the console: the fields given, checked like new ones", async () => {
    const note = (
      await w.api("POST", "/api/memories", {
        token: w.alice,
        json: {
          scope: "topic",
          topic_id: w.ids.topic,
          title: "Plan",
          keywords: "plan, 计划",
          content: "ship on Monday",
        },
      })
    ).body;
    expect(note.keywords).toEqual(["plan", "计划"]);
    const patch = (json: Record<string, unknown>) =>
      w.api("PATCH", `/api/memories/${note.id}`, { token: w.alice, json });
    const changed = await patch({ content: "ship on Tuesday" });
    expect(changed.status, changed.raw).toBe(200);
    expect(changed.body).toMatchObject({ title: "Plan", keywords: ["plan", "计划"], content: "ship on Tuesday" });
    expect((await patch({ title: " " })).status).toBe(400);
    expect((await patch({ keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) })).status).toBe(400);
    expect((await patch({ title: "x".repeat(101) })).status).toBe(400);
    expect(
      (
        await w.api("POST", "/api/memories", {
          token: w.alice,
          json: { scope: "topic", topic_id: w.ids.topic, content: "x" },
        })
      ).status,
    ).toBe(400);
    const audit = (await w.api("GET", "/api/audit?action=memory.update", { token: w.adminToken })).body;
    expect(audit[0].detail).toMatchObject({ memory: note.id, fields: ["content"] });
    expect(JSON.stringify(audit)).not.toContain("Tuesday");
  });
});

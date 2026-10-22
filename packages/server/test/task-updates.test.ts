import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, saveMessage } from "../src/agent/dispatch.js";
import { loadTranscript } from "../src/agent/transcript.js";
import { db, transaction } from "../src/db/client.js";
import { tasks, taskUpdates } from "../src/db/schema.js";
import { getRole, getTopic } from "../src/services/topics.js";
import { call, lastToolResult, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

describe("progress updates on tasks", () => {
  let w: World;
  beforeEach(async () => {
    w = await buildWorld();
  });
  afterEach(async () => {
    await w?.close();
  });

  /** An independent task of ``owner`` in ``topicId``, queued to run. */
  const taskOf = (owner: string, topicId = w.ids.topic) =>
    transaction(async (tx) => {
      const topic = await getTopic(tx, topicId);
      const role = (await getRole(tx, owner))!;
      const message = await saveMessage(tx, topic, "user", w.ids.alice, "Build the login page", { mentions: [] });
      return createTask(tx, {
        topic,
        role,
        requesterUserId: w.ids.alice,
        instruction: "Build the login page",
        sourceMessage: message,
      });
    });
  const updatesOf = (taskId: string) => db().select().from(taskUpdates).where(eq(taskUpdates.taskId, taskId));

  it("a task keeps every update it records; the latest is its progress note", async () => {
    w.scripts.dev = (_m, turn) =>
      turn === 0
        ? reply("", [call("post_progress", { progress: "Form done; **next**: validation" })])
        : turn === 1
          ? reply("", [call("post_progress", { progress: "Validation done" })])
          : reply("login page ready");
    const task = await taskOf(w.ids.dev);
    await w.drain();
    const detail = await w.task(task.id);
    expect(detail.status).toBe("completed");
    expect(detail.updates.map((u: any) => [u.author_id, u.content, u.source_task_id])).toEqual([
      [w.ids.dev, "Form done; **next**: validation", task.id],
      [w.ids.dev, "Validation done", task.id],
    ]);
    expect(detail.progress).toBe("Validation done");
  });

  it("a conversation records progress on a task in its topic, and nowhere else", async () => {
    const task = await taskOf(w.ids.dev);
    await db().update(tasks).set({ status: "completed" }).where(eq(tasks.id, task.id));
    const elsewhere = (
      await w.api("POST", "/api/topics", { token: w.alice, json: { title: "Elsewhere", role_ids: [w.ids.test] } })
    ).body.id as string;
    const away = await taskOf(w.ids.test, elsewhere);
    let target = task.id;
    w.scripts.test = (m, turn) =>
      turn === 0
        ? reply("", [call("post_progress", { task_id: target, progress: "Tested on Safari: passes" })])
        : reply(`result: ${lastToolResult(m)}`);
    const run = (await w.post(w.alice, w.ids.topic, "@test note your test result on the task")).tasks[0].id;
    await w.drain();
    expect((await updatesOf(task.id)).map((u) => [u.authorId, u.content, u.sourceTaskId])).toEqual([
      [w.ids.test, "Tested on Safari: passes", run],
    ]);
    // A task in another topic, or a conversation run, takes no updates.
    for (const other of [away.id, run]) {
      target = other;
      await w.post(w.alice, w.ids.topic, "@test note it there too");
      await w.drain();
      expect((await w.messages(w.ids.topic)).at(-1).content).toMatch(/only on tasks in this topic|independent tasks/);
      expect(await updatesOf(other)).toEqual([]);
    }
  });

  it("without task_id a conversation only updates the note shown with its work", async () => {
    w.scripts.dev = (_m, turn) =>
      turn === 0 ? reply("", [call("post_progress", { progress: "looking into it" })]) : reply("ok");
    const run = (await w.post(w.alice, w.ids.topic, "@dev have a look")).tasks[0].id;
    await w.drain();
    const [row] = await db().select().from(tasks).where(eq(tasks.id, run));
    expect(row.progress).toBe("looking into it");
    expect(await db().select().from(taskUpdates)).toEqual([]);
  });

  it("whoever takes the task over gets its progress history in the brief", async () => {
    w.scripts.dev = (_m, turn) =>
      turn === 0
        ? reply("", [call("post_progress", { progress: "Schema migrated; API half done" })])
        : reply("paused here");
    const task = await taskOf(w.ids.dev);
    await w.drain();
    const moved = await w.api("POST", `/api/tasks/${task.id}/reassign`, {
      token: w.alice,
      json: { role_id: w.ids.test, note: "" },
    });
    expect(moved.status, moved.raw).toBe(200);
    const [row] = await db().select().from(tasks).where(eq(tasks.id, task.id));
    const context = JSON.stringify(await loadTranscript(db(), row));
    expect(context).toContain("Progress recorded on this task");
    expect(context).toContain("@dev: Schema migrated; API half done");
  });

  it("refuses empty or overlong updates", async () => {
    let text = "";
    w.scripts.dev = (m, turn) =>
      turn === 0 ? reply("", [call("post_progress", { progress: text })]) : reply(`result: ${lastToolResult(m)}`);
    for (const t of ["   ", "x".repeat(4001)]) {
      text = t;
      const task = await taskOf(w.ids.dev);
      await w.drain();
      expect((await w.task(task.id)).result).toMatch(/required|limited/);
      expect(await updatesOf(task.id)).toEqual([]);
    }
  });
});

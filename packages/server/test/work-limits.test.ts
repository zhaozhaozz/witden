/** What bounds AI work: token limits, not a number of steps. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

describe("no step limit", () => {
  it("a run takes as many steps as the work needs", async () => {
    // Well beyond the 60 steps that used to end a run.
    w.scripts.dev = (_m, turn) => (turn < 75 ? reply("", [call("topic_history", { limit: 1 })]) : reply("all done"));
    const posted = await w.post(w.alice, w.ids.topic, "@dev go through the history");
    await w.drain();
    const task = await w.task(posted.tasks[0].id);
    expect([task.status, task.result]).toEqual(["completed", "all done"]);
    expect(task.usage.steps).toBe(76);
    expect(task.budget).toEqual({ max_tokens: null });
    const role = (await w.api("GET", `/api/roles/${w.ids.dev}`, { token: w.adminToken })).body;
    expect(role).not.toHaveProperty("max_steps");
  });

  it("the token limit still ends a run, and a delegate gets what is left of it", async () => {
    await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.adminToken, json: { max_tokens_per_task: 50 } });
    let delegated = false;
    w.scripts.dev = (_m, turn) => {
      if (turn === 0 && !delegated) {
        delegated = true;
        return reply("", [call("delegate_task", { role: "test", task: "check", expected_output: "ok" })]);
      }
      return reply("", [call("topic_history", { limit: 1 })]);
    };
    w.scripts.test = () => reply("checked");
    const posted = await w.post(w.alice, w.ids.topic, "@dev keep reading");
    await w.drain();
    const task = await w.task(posted.tasks[0].id);
    expect(task.status).toBe("failed");
    expect(task.error).toContain("token budget exhausted");
    // Each model call spends 15 tokens: the delegate got 50 - 15 when it was created.
    const child = await w.task(task.children[0].id);
    expect(child.budget).toEqual({ max_tokens: 35 });
  });
});

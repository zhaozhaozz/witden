/** What bounds AI work: token limits, not a number of steps; and lists that are not cut short. */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import { topicParticipants, topics } from "../src/db/schema.js";
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

describe("topic list", () => {
  it("lists every topic, most recent first, with what the console needs for each", async () => {
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    const closed = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.analyst } })).body;
    // Both DMs last spoke long ago: well past the 300 topics the list used to stop at.
    await db()
      .update(topics)
      .set({ lastMessageAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(topics.id, dm.id));
    await db()
      .update(topics)
      .set({ lastMessageAt: new Date("2019-01-01T00:00:00Z") })
      .where(eq(topics.id, closed.id));
    await w.api("POST", `/api/roles/${w.ids.analyst}/disable`, { token: w.adminToken, json: { on_tasks: "cancel" } });
    // More than one batch of lookups (1000), alice taking part in every other one, @dev in every third.
    const now = Date.now();
    const made = Array.from({ length: 1100 }, (_, i) => ({
      id: newId("top"),
      title: `Topic ${i}`,
      lastMessageAt: new Date(now - i * 60_000),
    }));
    await db().insert(topics).values(made);
    await db()
      .insert(topicParticipants)
      .values([
        ...made
          .filter((_, i) => i % 2 === 0)
          .map((t) => ({ id: newId("tp"), topicId: t.id, participantType: "user", participantId: w.ids.alice })),
        ...made
          .filter((_, i) => i % 3 === 0)
          .map((t) => ({ id: newId("tp"), topicId: t.id, participantType: "role", participantId: w.ids.dev })),
      ]);
    const list = (await w.api("GET", "/api/topics", { token: w.alice })).body;
    const byId = new Map(list.map((t: any) => [t.id, t]));
    expect(list.length).toBeGreaterThanOrEqual(1103);
    const order = list.map((t: any) => t.id);
    expect(order.indexOf(made[0].id)).toBeLessThan(order.indexOf(made[1099].id));
    expect(order.indexOf(made[1099].id)).toBeLessThan(order.indexOf(dm.id));
    expect(order.at(-1)).toBe(closed.id);
    expect(byId.get(made[1098].id)).toMatchObject({ can_post: true, role_ids: [w.ids.dev] });
    expect(byId.get(made[1099].id)).toMatchObject({ can_post: false, role_ids: [] });
    expect(byId.get(dm.id)).toMatchObject({ kind: "dm", dm_role_id: w.ids.dev, can_post: true });
    // A DM whose role is disabled is read-only, as when opened on its own.
    expect(byId.get(closed.id)).toMatchObject({ dm_role_id: w.ids.analyst, can_post: false });
    const one = (await w.api("GET", `/api/topics/${closed.id}`, { token: w.alice })).body;
    expect(one.can_post).toBe(false);
  });
});

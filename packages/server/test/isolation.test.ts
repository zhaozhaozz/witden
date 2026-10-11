/**
 * Indirect leak paths and control-flow bypasses (from a security review of the first version).
 * Setup: alice asks @dev in a group topic that bob is also in; the task reads alice's DM, which holds SECRET.
 * Nothing derived from it may reach bob, or administrators who are not in the DM.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { tasks } from "../src/db/schema.js";
import { call, lastToolResult, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

const SECRET = "salary-12345";
let w: World;
let dm: any;

beforeEach(async () => {
  w = await buildWorld();
  dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
  w.scripts.dev = () => reply("noted");
  await w.post(w.alice, dm.id, `my ${SECRET} is private`);
  await w.drain();
});
afterEach(async () => {
  await w.close();
});

async function runDev(...steps: ReturnType<typeof call>[]) {
  w.scripts.dev = (_m, turn) => {
    const plan = [call("read_topic", { topic_id: dm.id }), ...steps];
    return turn < plan.length ? reply("", [plan[turn]]) : reply("ok");
  };
  const posted = await w.post(w.alice, w.ids.topic, "@dev go");
  await w.drain();
  return posted.tasks[0].id as string;
}

describe("indirect channels", () => {
  it("a held file is not downloadable and is deleted on reject", async () => {
    w.manager.computer(w.ids.instance).files.set("/home/witden/leak.txt", Buffer.from(SECRET));
    const id = await runDev(call("share_file", { path: "leak.txt" }));
    expect((await w.task(id)).status).toBe("waiting_approval");
    expect((await w.api("GET", `/api/topics/${w.ids.topic}/files`, { token: w.bob })).body).toEqual([]);
    const approval = (await w.api("GET", "/api/approvals", { token: w.alice })).body.find((a: any) => a.task_id === id);
    const fileId = approval.detail.attachments[0];
    expect((await w.api("GET", `/api/files/${fileId}`, { token: w.bob })).status).toBe(403);
    expect((await w.api("GET", `/api/files/${fileId}`, { token: w.alice })).status).toBe(200);
    await w.api("POST", `/api/approvals/${approval.id}/decide`, { token: w.alice, json: { approve: false } });
    expect((await w.api("GET", `/api/files/${fileId}`, { token: w.alice })).status).toBe(404);
  });

  it("topic notes cannot carry restricted material", async () => {
    await runDev(call("remember", { content: `alice ${SECRET}`, scope: "topic" }));
    for (const token of [w.alice, w.bob]) {
      const mems = (await w.api("GET", `/api/memories?scope=topic&topic_id=${w.ids.topic}`, { token })).body;
      expect(JSON.stringify(mems)).not.toContain(SECRET);
    }
  });

  it("task views hide derived text from people who cannot read the source", async () => {
    w.scripts.test = () => reply("ok");
    const id = await runDev(
      call("run_command", { command: `echo ${SECRET} > notes` }),
      call("delegate_task", { role: "test", task: `check ${SECRET}`, expected_output: "x" }),
      call("follow_up_later", { minutes: 60, reason: `recheck ${SECRET}` }),
    );
    for (const url of [`/api/tasks/${id}/trace`, `/api/tasks/${id}`, `/api/tasks?topic_id=${w.ids.topic}`]) {
      expect((await w.api("GET", url, { token: w.bob })).raw).not.toContain(SECRET);
    }
    expect((await w.api("GET", `/api/tasks/${id}/trace`, { token: w.alice })).raw).toContain(SECRET);
  });

  it("approvers do not see material they cannot read", async () => {
    await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.adminToken, json: { approval_required: ["shell"] } });
    w.scripts.dev = () => reply("", [call("run_command", { command: `echo ${SECRET}` })]);
    await w.post(w.alice, dm.id, `store my ${SECRET}`);
    await w.drain();
    const approvals = (await w.api("GET", "/api/approvals", { token: w.adminToken })).body;
    expect(approvals.length).toBeGreaterThan(0);
    expect(JSON.stringify(approvals)).not.toContain(SECRET);
    expect(approvals[0].can_approve).toBe(false);
  });

  it("open event streams stop receiving restricted detail", async () => {
    const { allowed } = await import("../src/api/events.js");
    w.scripts.dev = (_m, turn) => {
      const plan = [call("ask_human", { question: "go ahead?" }), call("read_topic", { topic_id: dm.id })];
      return turn < plan.length ? reply("", [plan[turn]]) : reply("ok");
    };
    const id = (await w.post(w.alice, w.ids.topic, "@dev go")).tasks[0].id;
    await w.drain();
    const bobId = w.ids.bob;
    // allowed while the task only carries the group label...
    expect(
      await allowed(bobId, [`task:${id}`], { type: "task.step", data: { task_id: id }, channels: [`task:${id}`] }),
    ).toBe(true);
    await w.post(w.alice, w.ids.topic, "yes");
    await w.drain();
    // ...and no longer once it has read the DM, even on a stream opened earlier
    expect(
      await allowed(bobId, [`task:${id}`], { type: "task.step", data: { task_id: id }, channels: [`task:${id}`] }),
    ).toBe(false);
    expect(
      await allowed(w.ids.alice, [`task:${id}`], {
        type: "task.step",
        data: { task_id: id },
        channels: [`task:${id}`],
      }),
    ).toBe(true);
  });
});

describe("control flow", () => {
  it("approval during an emergency stop does not run the tool until resumed", async () => {
    await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.adminToken, json: { approval_required: ["shell"] } });
    await w.api("POST", "/api/grants", {
      token: w.adminToken,
      json: { permission: "approval.decide", user_id: w.ids.bob },
    });
    w.scripts.dev = (_m, turn) =>
      turn === 0 ? reply("", [call("run_command", { command: "kubectl delete ns prod" })]) : reply("done");
    const id = (await w.post(w.alice, w.ids.topic, "@dev ship")).tasks[0].id;
    await w.drain();
    const ks = (
      await w.api("POST", "/api/kill-switches", { token: w.adminToken, json: { scope: "global", reason: "incident" } })
    ).body;
    const apr = (await w.api("GET", "/api/approvals", { token: w.bob })).body.find((a: any) => a.task_id === id);
    await w.api("POST", `/api/approvals/${apr.id}/decide`, { token: w.bob, json: { approve: true } });
    await w.drain();
    expect((await w.task(id)).status).toBe("paused");
    expect(w.manager.computer(w.ids.instance).commands).not.toContain("kubectl delete ns prod");
    await w.api("POST", `/api/kill-switches/${ks.id}/release`, { token: w.adminToken });
    await w.api("POST", `/api/tasks/${id}/control`, { token: w.alice, json: { action: "resume" } });
    await w.drain();
    expect((await w.task(id)).status).toBe("completed");
    expect(w.manager.computer(w.ids.instance).commands).toContain("kubectl delete ns prod");
  });

  it("a task-scoped stop covers the whole delegation tree", async () => {
    const delegateTo = (role: string) => (_m: any, turn: number) =>
      turn === 0 ? reply("", [call("delegate_task", { role, task: "t", expected_output: "x" })]) : reply("ok");
    w.scripts.dev = delegateTo("test");
    w.scripts.test = delegateTo("analyst");
    w.scripts.analyst = () => reply("analyst ran");
    const root = (await w.post(w.alice, w.ids.topic, "@dev go")).tasks[0].id;
    // run step by step: root, then child, then stop before the grandchild runs
    await w.worker.tick();
    await w.waitFor(async () => (await w.task(root)).status === "waiting_children");
    await w.waitFor(async () => (await db().select().from(tasks).where(eq(tasks.parentTaskId, root)))[0]);
    const [child] = await db().select().from(tasks).where(eq(tasks.parentTaskId, root));
    await w.worker.tick();
    await w.waitFor(async () => (await db().select().from(tasks).where(eq(tasks.parentTaskId, child.id)))[0]);
    await w.api("POST", "/api/kill-switches", { token: w.adminToken, json: { scope: "task", target_id: root } });
    await w.drain();
    const [grandchild] = await db().select().from(tasks).where(eq(tasks.parentTaskId, child.id));
    expect(grandchild.status).toBe("paused");
  });

  it("parents collect results after a pause", async () => {
    w.scripts.dev = (_m, turn) =>
      turn === 0
        ? reply("", [call("delegate_task", { role: "test", task: "t", expected_output: "x" })])
        : reply("parent finished");
    w.scripts.test = () => reply("child ok");
    const root = (await w.post(w.alice, w.ids.topic, "@dev go")).tasks[0].id;
    await w.worker.tick();
    await w.waitFor(async () => (await w.task(root)).status === "waiting_children");
    const ks = (
      await w.api("POST", "/api/kill-switches", { token: w.adminToken, json: { scope: "role", target_id: w.ids.dev } })
    ).body;
    await w.drain(); // the child (role test) completes while the parent is paused
    await w.api("POST", `/api/kill-switches/${ks.id}/release`, { token: w.adminToken });
    await w.api("POST", `/api/tasks/${root}/control`, { token: w.alice, json: { action: "resume" } });
    await w.drain();
    expect((await w.task(root)).status).toBe("completed");
  });

  it("pausing twice keeps the waiting state", async () => {
    w.scripts.dev = (_m, turn) =>
      turn === 0 ? reply("", [call("ask_human", { question: "branch?" })]) : reply("went on");
    const id = (await w.post(w.alice, w.ids.topic, "@dev deploy")).tasks[0].id;
    await w.drain();
    for (let i = 0; i < 2; i++)
      await w.api("POST", `/api/tasks/${id}/control`, { token: w.alice, json: { action: "pause" } });
    await w.api("POST", `/api/tasks/${id}/control`, { token: w.alice, json: { action: "resume" } });
    await w.drain();
    expect((await w.task(id)).status).toBe("waiting_human");
  });
});

describe("accounts and topics", () => {
  it("user.manage cannot change administrators; admins cannot widen private topics", async () => {
    await w.api("POST", "/api/grants", {
      token: w.adminToken,
      json: { permission: "user.manage", user_id: w.ids.bob },
    });
    const me = (await w.api("GET", "/api/auth/me", { token: w.adminToken })).body;
    expect(
      (await w.api("PATCH", `/api/users/${me.id}`, { token: w.bob, json: { password: "pwned-pass-1" } })).status,
    ).toBe(400);
    expect(
      (await w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.adminToken, json: { visibility: "internal" } }))
        .status,
    ).toBe(403);
    expect((await w.api("GET", `/api/topics/${w.ids.topic}/messages`, { token: w.adminToken })).status).toBe(403);
    expect(
      (await w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.adminToken, json: { status: "archived" } }))
        .status,
    ).toBe(200);
  });

  it("hand back only by the person in control", async () => {
    for (const uid of [w.ids.alice, w.ids.bob]) {
      await w.api("POST", "/api/grants", {
        token: w.adminToken,
        json: { permission: "instance.control", user_id: uid, resource_id: w.ids.instance },
      });
    }
    expect(
      (await w.api("POST", `/api/instances/${w.ids.instance}/takeover`, { token: w.alice, json: {} })).status,
    ).toBe(200);
    expect((await w.api("POST", `/api/instances/${w.ids.instance}/handback`, { token: w.bob })).status).toBe(403);
    expect((await w.api("POST", `/api/instances/${w.ids.instance}/handback`, { token: w.alice })).status).toBe(200);
  });

  it("changing a model endpoint drops the stored key", async () => {
    const cfg = (
      await w.api("POST", "/api/model-configs", {
        token: w.adminToken,
        json: { name: "k", base_url: "http://a/v1", model: "m", api_key: "sk-keep-me-secret-123456" },
      })
    ).body;
    expect(
      (await w.api("PATCH", `/api/model-configs/${cfg.id}`, { token: w.adminToken, json: { model: "m2" } })).body
        .has_api_key,
    ).toBe(true);
    expect(
      (
        await w.api("PATCH", `/api/model-configs/${cfg.id}`, {
          token: w.adminToken,
          json: { base_url: "http://evil/v1" },
        })
      ).body.has_api_key,
    ).toBe(false);
  });
});

export { lastToolResult };

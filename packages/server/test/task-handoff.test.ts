import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStatus } from "../src/agent/control.js";
import { createTask, saveMessage, sessionFor } from "../src/agent/dispatch.js";
import { recheckActiveTasks } from "../src/agent/revocation.js";
import { submitTaskInput } from "../src/agent/task-continuation.js";
import { appendStep, loadTranscript, taskLog } from "../src/agent/transcript.js";
import { db, transaction } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import { approvals, roles, type Task, taskInputs, tasks } from "../src/db/schema.js";
import { getRole, getTopic } from "../src/services/topics.js";
import { reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

describe("handing a task to another role", () => {
  let w: World;
  beforeEach(async () => {
    w = await buildWorld();
  });
  afterEach(async () => {
    await w?.close();
  });

  /** A task of ``owner`` with some history, left in ``status``. */
  async function taskOf(owner: string, status = "completed", fields: Partial<Task> = {}) {
    return transaction(async (tx) => {
      const topic = await getTopic(tx, w.ids.topic);
      const role = (await getRole(tx, owner))!;
      const message = await saveMessage(tx, topic, "user", w.ids.alice, "Implement login", { mentions: [] });
      const task = await createTask(tx, {
        topic,
        role,
        requesterUserId: w.ids.alice,
        instruction: "Build a login page",
        sourceMessage: message,
      });
      await appendStep(tx, task, "user", { content: "Original user requirement" });
      await appendStep(tx, task, "tool", { tool_call_id: "private", content: "OLD ROLE PRIVATE TOOL OUTPUT" });
      await appendStep(tx, task, "assistant", { content: "First implementation" });
      if (status === "completed") return setStatus(tx, task, "completed", null, { result: "v1 result", ...fields });
      const [t] = await tx
        .update(tasks)
        .set({ status, ...fields })
        .where(eq(tasks.id, task.id))
        .returning();
      return t;
    });
  }

  const move = (taskId: string, toRole: string, note = "Check the workspace before proceeding") =>
    w.api("POST", `/api/tasks/${taskId}/reassign`, { token: w.alice, json: { role_id: toRole, note } });

  const fresh = async (id: string) => (await db().select().from(tasks).where(eq(tasks.id, id)))[0];

  it("keeps the task and its history; the new role works with its own permissions and a brief", async () => {
    const original = await taskOf(w.ids.test, "completed");
    await db()
      .update(tasks)
      .set({ envelope: { ...original.envelope, approved_calls: ["old"] } })
      .where(eq(tasks.id, original.id));
    const session = await transaction((tx) => sessionFor(tx, w.ids.test, original.topicId));
    await db().update(tasks).set({ reportSessionId: session.id }).where(eq(tasks.id, original.id));
    await db()
      .insert(taskInputs)
      .values({
        id: newId("tin"),
        taskId: original.id,
        revision: 1,
        content: "Keep compatibility with the old login",
        requesterUserId: w.ids.alice,
        consumedAt: new Date(),
      });
    const res = await move(original.id, w.ids.dev);
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toMatchObject({
      id: original.id,
      topic_id: original.topicId,
      owner_role_id: w.ids.dev,
      source_message_id: original.sourceMessageId,
      report_session_id: session.id,
      status: "completed",
      revision: 1,
    });
    expect(await db().select().from(tasks).where(eq(tasks.topicId, original.topicId))).toHaveLength(1);
    const moved = await fresh(original.id);
    // The new role's own permissions (dev has a browser, test does not); approvals given to the old role are gone.
    expect(moved.envelope.tools).toContain("browser");
    expect(moved.envelope.approved_calls).toBeUndefined();
    expect(moved.roleSnapshot.instance_id).toBe(moved.instanceId);
    // The note travels in the brief only, not in the task's assignment.
    expect(moved.assignment.handoffs).toHaveLength(1);
    expect(JSON.stringify(moved.assignment)).not.toContain("Check the workspace");
    const log = JSON.stringify(await taskLog(db(), moved));
    expect(log).toContain("OLD ROLE PRIVATE TOOL OUTPUT");
    expect(log).toContain("role_handoff");
    const context = JSON.stringify(await loadTranscript(db(), moved));
    expect(context).toContain("Build a login page");
    expect(context).toContain("Check the workspace before proceeding");
    expect(context).toContain("Keep compatibility with the old login");
    expect(context).not.toContain("OLD ROLE PRIVATE TOOL OUTPUT");

    // Continuing it later is the new role's work.
    let seen = "";
    w.scripts.dev = (m) => {
      seen = JSON.stringify(m);
      return reply("v2 by dev");
    };
    const more = await w.api("POST", `/api/tasks/${original.id}/control`, {
      token: w.alice,
      json: { action: "continue", note: "Add 2FA", expected_revision: 1, idempotency_key: "handoff-continue" },
    });
    expect(more.status, more.raw).toBe(200);
    await w.drain();
    const done = await fresh(original.id);
    expect(done).toMatchObject({ status: "completed", result: "v2 by dev", ownerRoleId: w.ids.dev, revision: 2 });
    expect(seen).toContain("Add 2FA");
    expect(seen).not.toContain("OLD ROLE PRIVATE TOOL OUTPUT");
  });

  it("refuses work that runs or waits, and the system administrator", async () => {
    const running = await taskOf(w.ids.dev, "running", {
      claimedBy: "a-worker",
      leaseUntil: new Date(Date.now() + 120_000),
    });
    expect((await move(running.id, w.ids.test)).status).toBe(400);
    // A run that just stopped but is still finishing its last call holds its claim.
    const stopping = await taskOf(w.ids.dev, "pending", {
      claimedBy: "a-worker",
      leaseUntil: new Date(Date.now() + 120_000),
    });
    expect((await move(stopping.id, w.ids.test)).status).toBe(400);
    for (const status of ["waiting_approval", "waiting_children", "waiting_human", "waiting_timer", "paused"]) {
      const t = await taskOf(w.ids.dev, status);
      expect((await move(t.id, w.ids.test)).status, status).toBe(400);
    }
    const cancelled = await taskOf(w.ids.dev, "cancelled");
    expect((await move(cancelled.id, w.ids.test)).status).toBe(400);
    // A cancelled and retried task can still have an undecided approval of the previous role.
    const asked = await taskOf(w.ids.dev, "pending");
    await db()
      .insert(approvals)
      .values({
        id: newId("apr"),
        taskId: asked.id,
        topicId: asked.topicId,
        roleId: w.ids.dev,
        action: "run_command",
        detail: { tool_call: { id: "c1", name: "run_command", arguments: { command: "ls" } } },
        approverUserIds: [w.ids.bob],
      });
    expect((await move(asked.id, w.ids.test)).status).toBe(400);
    // Work it delegated is still under way.
    const parent = await taskOf(w.ids.dev, "failed");
    await taskOf(w.ids.test, "running", { parentTaskId: parent.id });
    expect((await move(parent.id, w.ids.test)).status).toBe(400);
    for (const t of [running, stopping, asked, parent]) expect((await fresh(t.id)).ownerRoleId).toBe(w.ids.dev);
    const [admin] = await db().select().from(roles).where(eq(roles.systemAdmin, true));
    const finished = await taskOf(w.ids.dev, "completed");
    expect((await move(finished.id, admin.id)).status).toBe(403);
  });

  it("a task in a DM stays with the DM's one role", async () => {
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body.id as string;
    const done = await taskOf(w.ids.dev, "completed");
    await db().update(tasks).set({ topicId: dm }).where(eq(tasks.id, done.id));
    const res = await move(done.id, w.ids.test);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("a DM has only its one role");
    expect((await fresh(done.id)).ownerRoleId).toBe(w.ids.dev);
    const people = (await w.api("GET", `/api/topics/${dm}`, { token: w.alice })).body.participants;
    expect(people.filter((p: any) => p.type === "role").map((p: any) => p.id)).toEqual([w.ids.dev]);
  });

  it("neither tasks nor conversation runs are paused by hand", async () => {
    const t = await taskOf(w.ids.dev, "pending");
    const run = (await w.post(w.alice, w.ids.topic, "@dev hello")).tasks[0].id;
    for (const id of [t.id, run]) {
      const paused = await w.api("POST", `/api/tasks/${id}/control`, { token: w.alice, json: { action: "pause" } });
      expect(paused.status).toBe(400);
      expect((await fresh(id)).status).toBe("pending");
    }
  });

  it("a disabled role's tasks wait for another role; its conversations end", async () => {
    const queued = await taskOf(w.ids.dev, "pending");
    // Running when the role is disabled: it stops at its next step (here: its worker is gone).
    const running = await taskOf(w.ids.dev, "running", {
      claimedBy: "gone-worker",
      leaseUntil: new Date(Date.now() - 1000),
    });
    const run = (await w.post(w.alice, w.ids.topic, "@dev hello")).tasks[0].id;
    expect(
      (await w.api("POST", `/api/roles/${w.ids.dev}/disable`, { token: w.adminToken, json: { on_tasks: "reassign" } }))
        .status,
    ).toBe(400);
    const off = await w.api("POST", `/api/roles/${w.ids.dev}/disable`, { token: w.adminToken, json: {} });
    expect(off.status, off.raw).toBe(200);
    expect((await fresh(queued.id)).status).toBe("waiting_role");
    expect((await fresh(running.id)).status).toBe("running");
    expect((await fresh(run)).status).toBe("cancelled");
    await w.drain();
    const stopped = await fresh(running.id);
    expect(stopped.status).toBe("waiting_role");
    expect(stopped.claimedBy).toBeNull();
    // Re-checks after other changes do not cancel them.
    await transaction((tx) => recheckActiveTasks(tx, "the connection's settings changed"));
    expect((await fresh(queued.id)).status).toBe("waiting_role");

    w.scripts.test = () => reply("done by test");
    for (const t of [queued, running]) expect((await move(t.id, w.ids.test)).status).toBe(200);
    await w.drain();
    for (const t of [queued, running])
      expect(await fresh(t.id)).toMatchObject({ status: "completed", ownerRoleId: w.ids.test, result: "done by test" });
  });

  it("enabling the role again lets it go on with the tasks it kept", async () => {
    const queued = await taskOf(w.ids.dev, "pending");
    await w.api("POST", `/api/roles/${w.ids.dev}/disable`, { token: w.adminToken, json: { on_tasks: "keep" } });
    expect((await fresh(queued.id)).status).toBe("waiting_role");
    // Requirements added meanwhile are queued for whoever works on it next.
    const more = await w.api("POST", `/api/tasks/${queued.id}/control`, {
      token: w.alice,
      json: { action: "instruct", note: "also check the logout" },
    });
    expect(more.status, more.raw).toBe(200);
    expect((await fresh(queued.id)).status).toBe("waiting_role");
    w.scripts.dev = () => reply("done by dev");
    expect((await w.api("POST", `/api/roles/${w.ids.dev}/enable`, { token: w.adminToken })).status).toBe(200);
    await w.drain();
    expect(await fresh(queued.id)).toMatchObject({ status: "completed", ownerRoleId: w.ids.dev });
  });

  it("the conversation that started a task can still continue it after it changed hands", async () => {
    const task = await taskOf(w.ids.dev, "completed");
    const session = await transaction((tx) => sessionFor(tx, w.ids.dev, task.topicId));
    await db().update(tasks).set({ reportSessionId: session.id }).where(eq(tasks.id, task.id));
    expect((await move(task.id, w.ids.test)).status).toBe(200);
    const caller = await transaction(async (tx) => {
      const topic = await getTopic(tx, w.ids.topic);
      const dev = (await getRole(tx, w.ids.dev))!;
      const run = await createTask(tx, {
        topic,
        role: dev,
        kind: "conversation",
        session: await sessionFor(tx, dev.id, topic.id),
        requesterUserId: w.ids.alice,
        instruction: "follow up",
      });
      const [active] = await tx.update(tasks).set({ status: "running" }).where(eq(tasks.id, run.id)).returning();
      return active;
    });
    const revised = await transaction((tx) => submitTaskInput(tx, task.id, "Add 2FA", { userId: w.ids.alice, caller }));
    expect(revised).toMatchObject({ id: task.id, ownerRoleId: w.ids.test, revision: 2 });
  });
});

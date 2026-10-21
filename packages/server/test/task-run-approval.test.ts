import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTask } from "../src/agent/dispatch.js";
import { db, transaction } from "../src/db/client.js";
import { approvals, auditLogs, tasks, users } from "../src/db/schema.js";
import { getRole, getTopic } from "../src/services/topics.js";
import { issueToken } from "../src/services/users.js";
import { call, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

async function configure(groups = ["shell"]) {
  const out = await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.alice, json: { approval_required: groups } });
  expect(out.status).toBe(200);
}
async function pending(taskId: string) {
  return (await w.api("GET", "/api/approvals", { token: w.alice })).body.find((a: any) => a.task_id === taskId);
}
const decide = (id: string, json: Record<string, unknown> = { approve: true, scope: "task_run" }) =>
  w.api("POST", `/api/approvals/${id}/decide`, { token: w.alice, json });
async function control(id: string, action: string) {
  const out = await w.api("POST", `/api/tasks/${id}/control`, { token: w.alice, json: { action, note: "Next run" } });
  expect(out.status, out.raw).toBe(200);
  return out.body;
}
function commandScript(command: string, fail = false) {
  let first = true;
  w.scripts.dev = () => {
    if (first) {
      first = false;
      return reply("", [call("run_command", { command })]);
    }
    if (fail) throw new Error("simulated model failure after the approved tool");
    return reply("done");
  };
}
async function independent(parentId?: string) {
  return transaction(async (tx) => {
    const [parent] = parentId ? await tx.select().from(tasks).where(eq(tasks.id, parentId)) : [];
    return createTask(tx, {
      topic: await getTopic(tx, w.ids.topic),
      role: (await getRole(tx, w.ids.dev))!,
      requesterUserId: w.ids.alice,
      instruction: "Independent work",
      parent,
    });
  });
}
async function conversation() {
  return (await w.post(w.alice, w.ids.topic, "@dev perform this run")).tasks[0].id as string;
}

it("allows new arguments for exactly one tool, while another tool in the same group still asks", async () => {
  await configure(["files"]);
  let step = 0;
  w.scripts.dev = () => {
    step++;
    if (step <= 2)
      return reply("", [call("write_file", { path: `/home/witden/${step}.txt`, content: `file ${step}` })]);
    if (step === 3) return reply("", [call("read_file", { path: "/home/witden/1.txt" })]);
    return reply("done");
  };
  const id = await conversation();
  await w.drain();
  const first = await pending(id);
  expect(first.can_allow_for_task_run).toBe(true);
  const response = await decide(first.id, { approve: true, scope: "task_run", note: "Write the files" });
  expect(response.status, response.raw).toBe(200);
  expect(response.body.decision_scope).toBe("task_run");
  await w.drain();
  const next = await pending(id);
  expect(next.action).toBe("read_file");
  const files = w.manager.computer(w.ids.instance).files;
  expect(files.get("/home/witden/1.txt")?.toString()).toBe("file 1");
  expect(files.get("/home/witden/2.txt")?.toString()).toBe("file 2");
  expect((await w.task(id)).envelope.approved_tools.names).toEqual(["write_file"]);
  const entries = await db().select().from(auditLogs).where(eq(auditLogs.action, "approval.approved"));
  expect(entries.find((a) => a.taskId === id)?.detail).toMatchObject({
    action: "write_file",
    scope: "task_run",
    revision: 1,
    note: "Write the files",
  });
  expect((await w.api("GET", `/api/roles/${w.ids.dev}`, { token: w.alice })).body.approval_required).toEqual(["files"]);
});

it("does not copy a run grant into a child task or the next conversation run", async () => {
  await configure();
  commandScript("parent-command");
  const parent = await conversation();
  await w.drain();
  expect((await decide((await pending(parent)).id)).status).toBe(200);
  await w.drain();
  expect((await w.task(parent)).status).toBe("completed");
  commandScript("child-command");
  const child = await independent(parent);
  expect(child.envelope.approved_tools).toBeUndefined();
  await w.drain();
  expect((await pending(child.id)).action).toBe("run_command");
  await control(child.id, "cancel");
  commandScript("next-conversation-command");
  const next = await conversation();
  expect(next).not.toBe(parent);
  await w.drain();
  expect((await pending(next)).action).toBe("run_command");
  expect(w.manager.computer(w.ids.instance).commands).toEqual(["parent-command"]);
});

it.each(["continue", "retry-task", "retry-conversation"])(
  "expires on %s, even if the task ID is reused",
  async (mode) => {
    await configure();
    commandScript("first-run", mode !== "continue");
    const id = mode === "retry-conversation" ? await conversation() : (await independent()).id;
    await w.drain();
    expect((await decide((await pending(id)).id)).status).toBe(200);
    await w.drain();
    expect((await w.task(id)).status).toBe(mode === "continue" ? "completed" : "failed");
    commandScript("next-run");
    const next = await control(id, mode === "continue" ? "continue" : "retry");
    expect(next.envelope.approved_tools).toBeUndefined();
    expect(next.envelope.approved_calls).toBeUndefined();
    await w.drain();
    expect((await pending(id)).action).toBe("run_command");
    expect(w.manager.computer(w.ids.instance).commands).toEqual(["first-run"]);
  },
);

it("keeps a run paused by an emergency stop paused and retains its tool grant when that same run resumes", async () => {
  await configure();
  let step = 0;
  w.scripts.dev = () =>
    ++step <= 2 ? reply("", [call("run_command", { command: `command-${step}` })]) : reply("done");
  const id = await conversation();
  await w.drain();
  const stop = await w.api("POST", "/api/kill-switches", {
    token: w.adminToken,
    json: { scope: "task", target_id: id },
  });
  expect(stop.status, stop.raw).toBe(200);
  const approval = await pending(id);
  expect(approval.can_allow_for_task_run).toBe(true);
  expect((await decide(approval.id)).status).toBe(200);
  await w.drain();
  expect((await w.task(id)).status).toBe("paused");
  expect(w.manager.computer(w.ids.instance).commands).toEqual([]);
  await w.api("POST", `/api/kill-switches/${stop.body.id}/release`, { token: w.adminToken });
  await control(id, "resume");
  await w.drain();
  expect((await w.task(id)).status).toBe("completed");
  expect(w.manager.computer(w.ids.instance).commands).toEqual(["command-1", "command-2"]);
});

it("rejects invalid scopes and unauthorized requests and serializes duplicate decisions", async () => {
  await configure();
  commandScript("held-command");
  const id = await conversation();
  await w.drain();
  const a = await pending(id);
  for (const json of [
    { approve: true, scope: "always" },
    { approve: false, scope: "task_run" },
    { approve: "false", scope: "task_run" },
    { approve: true, scope: null },
  ]) {
    expect((await decide(a.id, json)).status).toBe(400);
    expect((await pending(id)).id).toBe(a.id);
  }
  expect(
    (await w.api("POST", `/api/approvals/${a.id}/decide`, { json: { approve: true, scope: "task_run" } })).status,
  ).toBe(401);
  const [outsider] = await db()
    .insert(users)
    .values({ id: "outside-user", name: "Outside", externalConnectionId: "outside-connection" })
    .returning();
  const token = await transaction((tx) => issueToken(tx, outsider));
  expect(
    (await w.api("POST", `/api/approvals/${a.id}/decide`, { token, json: { approve: true, scope: "task_run" } }))
      .status,
  ).toBe(403);
  const responses = await Promise.all([decide(a.id), decide(a.id)]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await w.task(id)).envelope.approved_tools.names).toEqual(["run_command"]);
  await w.drain();
  expect(w.manager.computer(w.ids.instance).commands).toEqual(["held-command"]);
});

it("never grants a stale approval to a retried task or grants a legacy disclosure", async () => {
  await configure();
  commandScript("old-command");
  const id = (await independent()).id;
  await w.drain();
  const a = await pending(id);
  await db().update(approvals).set({ action: "disclose" }).where(eq(approvals.id, a.id));
  expect((await pending(id)).can_allow_for_task_run).toBe(false);
  expect((await decide(a.id)).status).toBe(400);
  await db().update(approvals).set({ action: "run_command" }).where(eq(approvals.id, a.id));
  await control(id, "cancel");
  expect((await decide(a.id)).status).toBe(409);
  await control(id, "retry");
  expect((await decide(a.id)).status).toBe(409);
  expect((await w.task(id)).envelope.approved_tools).toBeUndefined();
});

it("a run grant never bypasses tool availability or a disabled role", async () => {
  await configure();
  commandScript("must-not-run");
  const id = await conversation();
  await w.drain();
  expect((await decide((await pending(id)).id)).status).toBe(200);
  const [task] = await db().select().from(tasks).where(eq(tasks.id, id));
  await db()
    .update(tasks)
    .set({ envelope: { ...task.envelope, tools: [] } })
    .where(eq(tasks.id, id));
  await w.drain();
  expect(w.manager.computer(w.ids.instance).commands).toEqual([]);
  commandScript("disabled-must-not-run");
  const next = await conversation();
  await w.drain();
  expect((await decide((await pending(next)).id)).status).toBe(200);
  expect(
    (await w.api("POST", `/api/roles/${w.ids.dev}/disable`, { token: w.alice, json: { on_tasks: "cancel" } })).status,
  ).toBe(200);
  await w.drain();
  expect((await w.task(next)).status).toBe("cancelled");
  expect(w.manager.computer(w.ids.instance).commands).toEqual([]);
});

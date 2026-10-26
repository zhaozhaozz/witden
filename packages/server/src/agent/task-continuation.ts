/** Persistent independent-task iterations; inputs are consumed only at execution boundaries. */

import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type Task, taskInputs, taskIterations, tasks, users } from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { isConsoleUser } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import {
  continuationAllowed,
  narrowEnvelope,
  sameRoute,
  type TopicDelivery,
} from "../services/collaboration-policy.js";
import { wake } from "../services/events.js";
import * as topicSvc from "../services/topics.js";
import { clearRunApprovals } from "./approval-scope.js";
import { publishTaskStatus, setStatus, TERMINAL } from "./control.js";
import { buildEnvelope, roleSnapshotFor } from "./dispatch.js";
import { activeKillSwitch, stillAllowed } from "./revocation.js";
import { appendStep } from "./transcript.js";

export async function lockTask(db: Db, id: string): Promise<Task | undefined> {
  return (await db.select().from(tasks).where(eq(tasks.id, id)).for("update"))[0];
}

export async function recordTaskIteration(db: Db, task: Task): Promise<void> {
  if (task.kind !== "task" || !TERMINAL.has(task.status)) return;
  await db
    .insert(taskIterations)
    .values({
      id: newId("iter"),
      taskId: task.id,
      revision: task.revision,
      status: task.status,
      result: task.result,
      error: task.error,
      usage: task.usage,
      finishedAt: task.finishedAt,
    })
    .onConflictDoNothing();
}

export async function hasTaskInputs(db: Db, id: string): Promise<boolean> {
  return !!(
    await db
      .select({ id: taskInputs.id })
      .from(taskInputs)
      .where(and(eq(taskInputs.taskId, id), isNull(taskInputs.consumedAt)))
      .limit(1)
  )[0];
}

export interface TaskInputOptions {
  userId: string | null;
  caller?: Task;
  sourceMessageId?: string | null;
  idempotencyKey?: string;
  expectedRevision?: number;
}

export async function submitTaskInput(db: Db, id: string, instruction: string, opts: TaskInputOptions): Promise<Task> {
  let task = await lockTask(db, id);
  if (!task) throw new NotFound("task not found");
  if (task.kind !== "task")
    throw new BadRequest("post a message to continue a conversation; select an independent task here");
  if (!instruction.trim() || instruction.length > 16_000)
    throw new BadRequest("provide 1..16000 characters of instructions");
  if (opts.idempotencyKey) {
    const [seen] = await db.select().from(taskInputs).where(eq(taskInputs.idempotencyKey, opts.idempotencyKey));
    if (seen) {
      if (seen.taskId !== id) throw new BadRequest("idempotency key belongs to another task");
      return task;
    }
  }
  const [user] = opts.userId ? await db.select().from(users).where(eq(users.id, opts.userId)) : [];
  if (!user?.isActive) throw new Forbidden("an active requester is required");
  if (opts.caller) {
    const [currentCaller] = await db.select().from(tasks).where(eq(tasks.id, opts.caller.id));
    if (currentCaller?.status !== "running") throw new Forbidden("the requesting conversation is no longer running");
    opts = { ...opts, caller: currentCaller };
    const callerDenied = await stillAllowed(db, currentCaller);
    if (callerDenied) throw new Forbidden(callerDenied);
    // The originating conversation continues to coordinate this task even after it is assigned to another role.
    if (
      currentCaller.topicId !== task.topicId ||
      !currentCaller.sessionId ||
      task.reportSessionId !== currentCaller.sessionId
    )
      throw new Forbidden("you may only continue independent tasks your conversation here started");
    if (currentCaller.id === task.id) throw new BadRequest("a task cannot enqueue instructions for itself");
    if (await activeKillSwitch(db, currentCaller)) throw new Forbidden("the requesting conversation is stopped");
  } else if (!isConsoleUser(user)) throw new Forbidden("only console accounts can directly control tasks");
  if (opts.expectedRevision !== undefined && opts.expectedRevision !== task.revision)
    throw new BadRequest("task revision changed; refresh before submitting another continuation");
  if (task.status === "failed" || task.status === "cancelled")
    throw new BadRequest("retry failed/cancelled tasks explicitly before adding a new iteration");
  const role = await topicSvc.getRole(db, task.ownerRoleId);
  const topic = await topicSvc.getTopic(db, task.topicId);
  if (!role) throw new Forbidden("the task's role no longer exists");
  // A finished task starts working again: everything a new task would need must still hold. Instructions for
  // work still under way are read at its next step, as before; that work is checked at every step anyway.
  const newIteration = continuationAllowed(task.kind, task.status);
  if (newIteration) {
    if (role.status !== "active" || topic.status !== "active")
      throw new Forbidden("the task's topic or role is not active");
    if (role.instanceId !== task.instanceId)
      throw new Forbidden("the role now works on another computer; give it a new task instead");
    if (!role.modelConfigId) throw new Forbidden(`@${role.handle} has no model`);
    const denied = await stillAllowed(db, task);
    if (denied) throw new Forbidden(denied);
    if (await activeKillSwitch(db, task)) throw new Forbidden("an emergency stop still covers this task");
  }
  let envelope = narrowEnvelope(task.envelope, buildEnvelope(role, null));
  if (opts.caller) {
    envelope = narrowEnvelope(envelope, opts.caller.envelope);
    if (opts.caller.envelope.outside) envelope.outside = true;
    if (opts.caller.envelope.automation_event) envelope.automation_event = true;
    if (opts.caller.envelope.untrusted_input || !isConsoleUser(user)) envelope.untrusted_input = true;
    const routes = [...(envelope.topic_routes ?? [])];
    for (const route of opts.caller.envelope.topic_routes ?? [])
      if (!routes.some((r: TopicDelivery) => sameRoute(r, route))) routes.push(route);
    if (routes.length) envelope.topic_routes = routes;
  }
  if (envelope.outside || envelope.automation_event || envelope.untrusted_input)
    envelope.tools = (envelope.tools ?? []).filter(
      (tool: string) => !["config", "profile", "automation"].includes(tool),
    );
  // Tasks are not bounded by automatic rounds: a role's follow-up keeps its conversation's round, a person's starts at 0.
  const nextRound = opts.caller ? opts.caller.round : 0;
  if (newIteration) {
    envelope = clearRunApprovals(envelope);
    await recordTaskIteration(db, task);
    const [next] = await db
      .update(tasks)
      .set({
        revision: task.revision + 1,
        round: nextRound,
        status: "pending",
        statusReason: "new iteration requested",
        result: null,
        error: null,
        progress: null,
        wait: null,
        finishedAt: null,
        startedAt: null,
        claimedBy: null,
        leaseUntil: null,
        usage: { steps: 0, tokens: 0 },
        envelope,
        // The role as it is now (model, prompt, effort), like a new task; the transcript carries on.
        roleSnapshot: await roleSnapshotFor(db, role),
        // Keep the original computer, requester, source and report session. They are not replaced by a later topic message.
      })
      .where(eq(tasks.id, task.id))
      .returning();
    task = next;
  }
  [task] = await db.update(tasks).set({ round: nextRound, envelope }).where(eq(tasks.id, task.id)).returning();
  const [input] = await db
    .insert(taskInputs)
    .values({
      id: newId("tin"),
      taskId: id,
      revision: task.revision,
      content: instruction.trim(),
      requesterUserId: user.id,
      sourceMessageId: opts.sourceMessageId ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
    })
    .returning();
  if (task.status === "waiting_human") {
    if (task.wait?.tool_call_id)
      await appendStep(db, task, "tool", {
        tool_call_id: task.wait.tool_call_id,
        name: "ask_human",
        content:
          "A specifically addressed follow-up arrived. Read the queued instruction; this is not a tool approval.",
      });
    task = await setStatus(db, task, "pending", "new instruction", { wait: null });
  }
  // Pauses and approval/resource/child waits are respected; never resume them implicitly.
  await audit(db, newIteration ? "task.continue" : "task.instruct", {
    actorType: opts.caller ? "role" : "user",
    actorId: opts.caller?.ownerRoleId ?? user.id,
    topicId: task.topicId,
    taskId: id,
    detail: { revision: task.revision, input_id: input.id, source_message_id: opts.sourceMessageId ?? null },
  });
  await publishTaskStatus(db, task);
  await wake(db, "tasks");
  return task;
}

/** Caller holds the task row lock. The initial task brief must already be in its transcript. */
export async function consumeTaskInputs(db: Db, task: Task): Promise<boolean> {
  const pending = await db
    .select()
    .from(taskInputs)
    .where(and(eq(taskInputs.taskId, task.id), isNull(taskInputs.consumedAt)))
    .orderBy(asc(taskInputs.createdAt), asc(taskInputs.id));
  if (!pending.length) return false;
  for (const input of pending) {
    await appendStep(db, task, "user", {
      content:
        `Follow-up for task ${task.id}, iteration ${input.revision} (input ${input.id}; requester ${input.requesterUserId ?? "unknown"}` +
        `${input.sourceMessageId ? `; source message ${input.sourceMessageId}` : ""}):\n${input.content}`,
      task_input_id: input.id,
      revision: input.revision,
    });
    await db.update(taskInputs).set({ consumedAt: new Date() }).where(eq(taskInputs.id, input.id));
  }
  return true;
}

export async function listTaskIterations(db: Db, id: string) {
  return db.select().from(taskIterations).where(eq(taskIterations.taskId, id)).orderBy(asc(taskIterations.revision));
}

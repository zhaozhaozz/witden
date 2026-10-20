/** Human control over tasks: pause, resume, cancel, add instructions, retry, reassign. */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type Role, type Task, tasks, topics, type User } from "../db/schema.js";
import { BadRequest, Forbidden } from "../errors.js";
import { audit } from "../services/audit.js";
import { wake } from "../services/events.js";
import * as topicSvc from "../services/topics.js";
import { ACTIVE, cancelTree, getTask, pause, resume, setStatus, TERMINAL } from "./control.js";
import { enqueue, openRun } from "./conversation.js";
import { authorize, buildEnvelope, createTask, systemMessage } from "./dispatch.js";
import { activeKillSwitch } from "./revocation.js";
import { submitTaskInput } from "./task-continuation.js";

/** Console accounts steer every task (they are all administrators). */
export async function canControl(db: Db, user: User, task: Task, _action = "pause"): Promise<boolean> {
  const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
  return !!topic && (await topicSvc.canAdminister(db, user, topic));
}

async function requireControl(db: Db, user: User, task: Task, action: string) {
  if (!(await canControl(db, user, task, action))) {
    throw new Forbidden("only console accounts can control tasks");
  }
}

export async function control(
  db: Db,
  user: User,
  task: Task,
  action: string,
  note = "",
  opts: { expectedRevision?: number; idempotencyKey?: string } = {},
): Promise<Task> {
  await requireControl(db, user, task, action);
  // An independent task takes new requirements as queued input; that records its own audit entry.
  if (action === "continue" || (action === "instruct" && task.kind === "task" && !TERMINAL.has(task.status)))
    return submitTaskInput(db, task.id, note, { userId: user.id, ...opts });
  if (action === "pause") await pause(db, task, `paused by ${user.name}`);
  else if (action === "resume") {
    if (task.status !== "paused") throw new BadRequest("task is not paused");
    if (await activeKillSwitch(db, task)) throw new BadRequest("an emergency stop covering this task is still active");
    await resume(db, task);
  } else if (action === "cancel") {
    await cancelTree(db, task, `cancelled by ${user.name}${note ? `: ${note}` : ""}`);
  } else if (action === "instruct") {
    if (TERMINAL.has(task.status)) throw new BadRequest("task already finished; post a new message instead");
    if (!note.trim()) throw new BadRequest("instruction text is required");
    // A conversation's inbox: shown at its next step, between tool calls, never inside one.
    const topic = await topicSvc.getTopic(db, task.topicId);
    const role = await topicSvc.getRole(db, task.ownerRoleId);
    if (role)
      await enqueue(db, {
        topic,
        role,
        item: { kind: "instruction", note, by: user.name },
        requesterUserId: user.id,
      });
  } else if (action === "retry") {
    if (!["failed", "cancelled"].includes(task.status))
      throw new BadRequest("only failed or cancelled tasks can be retried");
    // A conversation goes on with its next message; only one of its runs is open at a time.
    if (task.kind === "conversation" && task.sessionId && (await openRun(db, task.sessionId)))
      throw new BadRequest("this conversation is already working again");
    const [reset] = await db
      .update(tasks)
      .set({
        status: "pending",
        finishedAt: null,
        error: null,
        ...(task.kind === "task" ? { revision: task.revision + 1, usage: { steps: 0, tokens: 0 }, result: null } : {}),
      })
      .where(eq(tasks.id, task.id))
      .returning();
    await setStatus(db, reset, "pending", `retried by ${user.name}`);
  } else {
    throw new BadRequest("action must be pause, resume, cancel, instruct, continue or retry");
  }
  await audit(db, `task.${action}`, {
    actorType: "user",
    actorId: user.id,
    taskId: task.id,
    topicId: task.topicId,
    roleId: task.ownerRoleId,
    detail: { note },
  });
  await wake(db, "tasks");
  return (await getTask(db, task.id))!;
}

/** Explicit hand-over to another role. Permissions are re-checked; nothing widens silently. */
export async function reassign(
  db: Db,
  user: User,
  task: Task,
  target: Role,
  opts: { byRoleManager?: boolean } = {},
): Promise<Task> {
  // Disabling a role (role.manage) moves its work explicitly.
  if (!opts.byRoleManager) await requireControl(db, user, task, "reassign");
  if (!ACTIVE.has(task.status)) throw new BadRequest("only unfinished tasks can be reassigned");
  // A conversation belongs to its role; @-mention another role in the topic instead.
  if (task.kind === "conversation") throw new BadRequest("a role's conversation cannot be reassigned; only tasks can");
  const topic = await topicSvc.getTopic(db, task.topicId);
  if (!(await topicSvc.participant(db, topic.id, "role", target.id)))
    await topicSvc.inviteRole(db, user, topic, target.id);
  const { allowed, refusals } = await authorize(db, topic, task.requesterUserId, [target.id]);
  if (!allowed.length) throw new Forbidden(`cannot reassign: ${refusals.join("; ")}`);
  const previous = await topicSvc.getRole(db, task.ownerRoleId);
  // The new owner starts from the brief, not the previous owner's transcript or computer state.
  await cancelTree(db, task, `reassigned to @${target.handle} by ${user.name}`);
  const parent = task.parentTaskId ? await getTask(db, task.parentTaskId) : null;
  const created = await createTask(db, {
    topic,
    role: target,
    requesterUserId: task.requesterUserId,
    instruction: task.instruction,
    title: task.title,
    parent,
    assignment: allowed[0][1],
    round: task.round,
    waitsForResult: !!parent,
  });
  await db
    .update(tasks)
    .set({ envelope: buildEnvelope(target, parent ?? null) })
    .where(eq(tasks.id, created.id));
  if (parent) {
    const wait = { ...(parent.wait ?? {}) };
    wait.child_ids = (wait.child_ids ?? []).map((c: string) => (c === task.id ? created.id : c));
    await db.update(tasks).set({ wait }).where(eq(tasks.id, parent.id));
  }
  let note = `Task reassigned from @${previous?.handle ?? "?"} to @${target.handle} by ${user.name}.`;
  if (task.instanceId !== target.instanceId)
    note += " It now runs on a different computer; files from the previous computer were not moved.";
  await systemMessage(db, topic, note, { taskId: created.id });
  await audit(db, "task.reassign", {
    actorType: "user",
    actorId: user.id,
    taskId: created.id,
    topicId: topic.id,
    detail: {
      from_task: task.id,
      from_role: task.ownerRoleId,
      to_role: target.id,
      old_instance: task.instanceId,
      new_instance: target.instanceId,
    },
  });
  return (await getTask(db, created.id))!;
}

/** Human control over tasks: resume, cancel, add instructions, retry, reassign; a conversation run can also be paused. */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type Role, type Task, tasks, topics, type User } from "../db/schema.js";
import { BadRequest, Forbidden } from "../errors.js";
import { audit } from "../services/audit.js";
import { wake } from "../services/events.js";
import * as topicSvc from "../services/topics.js";
import { clearRunApprovals } from "./approval-scope.js";
import { cancelTree, getTask, pause, resume, setStatus, TERMINAL } from "./control.js";
import { enqueue, openRun } from "./conversation.js";
import { activeKillSwitch } from "./revocation.js";
import { lockTask, submitTaskInput } from "./task-continuation.js";
import { transferTask } from "./task-handoff.js";

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
  if (action === "pause") {
    // Independent tasks are not paused by hand: cancel them, or hand them over once they stop.
    if (task.kind === "task") throw new BadRequest("tasks cannot be paused; cancel the task instead");
    await pause(db, task, `paused by ${user.name}`);
  } else if (action === "resume") {
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
    task = (await lockTask(db, task.id)) ?? task;
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
        envelope: clearRunApprovals(task.envelope),
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

/** Explicit hand-over to another role: the same task, with the new role's permissions and computer. */
export async function reassign(db: Db, user: User, task: Task, target: Role, note = ""): Promise<Task> {
  await requireControl(db, user, task, "reassign");
  return transferTask(db, user, task.id, target, note);
}

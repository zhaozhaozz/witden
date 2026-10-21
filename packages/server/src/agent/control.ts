/** Task state transitions shared by the API, the worker and the integrations. */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { computerInstances, type Task, tasks } from "../db/schema.js";
import { audit } from "../services/audit.js";
import { publish, wake } from "../services/events.js";
import { currentLease, releaseTask } from "../services/leases.js";

export const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export const ACTIVE = new Set([
  "pending",
  "running",
  "waiting_human",
  "waiting_approval",
  "waiting_children",
  "waiting_resource",
  "waiting_timer",
  // The role was disabled: the task waits for another role to take it over.
  "waiting_role",
  "paused",
]);

async function publishTask(db: Db, task: Task): Promise<void> {
  const meta = { id: task.id, status: task.status, topic_id: task.topicId, owner_role_id: task.ownerRoleId };
  await publish(
    db,
    "task.status",
    { ...meta, reason: task.statusReason, progress: task.progress },
    `topic:${task.topicId}`,
    `task:${task.id}`,
  );
  // Operators watching the whole system see state changes, not content from topics they may not read.
  await publish(db, "task.status", meta, "admin");
}

export { publishTask as publishTaskStatus };

/** Move a task to ``status``; returns the updated row. Terminal states are final. */
export async function setStatus(
  db: Db,
  task: Task,
  status: string,
  reason: string | null = null,
  fields: Partial<Task> = {},
): Promise<Task> {
  if (TERMINAL.has(task.status) && !TERMINAL.has(status)) return task;
  const update: Partial<Task> = { status, statusReason: reason, ...fields };
  if (status === "running" && !task.startedAt) update.startedAt = new Date();
  if (TERMINAL.has(status)) {
    update.finishedAt = new Date();
    update.wait = null;
    update.claimedBy = null;
    update.leaseUntil = null;
  }
  if (status !== "running") {
    // The task stopped or waits: its stretch of desktop work is over.
    await releaseTask(db, task.id);
  }
  const [row] = await db.update(tasks).set(update).where(eq(tasks.id, task.id)).returning();
  await publishTask(db, row);
  if (status === "pending") await wake(db, "tasks");
  if (TERMINAL.has(status)) {
    // Conversations hear how the work they started ended (agent/conversation.ts; loaded late: it imports this).
    const { afterEnd } = await import("./conversation.js");
    await afterEnd(db, row);
  }
  return row;
}

/** Cancelling a task also cancels the work it delegated. */
export async function cancelTree(db: Db, task: Task, reason: string): Promise<void> {
  const children = await db.select().from(tasks).where(eq(tasks.parentTaskId, task.id));
  for (const child of children) if (!TERMINAL.has(child.status)) await cancelTree(db, child, reason);
  const [fresh] = await db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1);
  if (fresh && !TERMINAL.has(fresh.status)) await setStatus(db, fresh, "cancelled", reason);
}

/** ``by`` records who paused (user | kill:<id> | takeover:<instance>) so only they resume it implicitly. */
export async function pause(db: Db, task: Task, reason: string, by = "user"): Promise<void> {
  if (TERMINAL.has(task.status) || task.status === "paused") return; // a second pause must not lose the state
  await setStatus(db, task, "paused", reason, {
    wait: { ...(task.wait ?? {}), resume_to: task.status, paused_by: by },
  });
}

/** Something finished while the task was paused: remember where to go on resume instead of running now. */
export async function deferWhilePaused(
  db: Db,
  task: Task,
  status: string,
  reason: string | null,
  wait: Record<string, any> | null,
) {
  const current = task.wait ?? {};
  await db
    .update(tasks)
    .set({
      wait: { ...(wait ?? {}), resume_to: status, paused_by: current.paused_by ?? "user" },
      statusReason: `${task.statusReason ?? "paused"} (then: ${reason ?? status})`,
    })
    .where(eq(tasks.id, task.id));
}

export async function resume(db: Db, task: Task): Promise<void> {
  if (task.status !== "paused") return;
  let target: string = task.wait?.resume_to ?? "pending";
  // "running" means "was being executed": it must be queued again.
  if (target === "running" || target === "paused") target = "pending";
  const { resume_to: _r, paused_by: _p, ...rest } = task.wait ?? {};
  await setStatus(db, task, target, "resumed", { wait: Object.keys(rest).length ? rest : null });
}

/** The computer is going away or being replaced: running work must not silently continue elsewhere. */
export async function interruptInstanceTasks(db: Db, instanceId: string, reason: string): Promise<void> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.instanceId, instanceId), inArray(tasks.status, ["running", "pending", "waiting_resource"])));
  for (const t of rows) {
    await setStatus(db, t, "waiting_resource", reason, {
      wait: { ...(t.wait ?? {}), type: "instance", instance_id: instanceId, since: new Date().toISOString() },
    });
  }
}

export async function pauseInstanceTasks(db: Db, instanceId: string, reason: string): Promise<void> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.instanceId, instanceId), inArray(tasks.status, ["pending", "running", "waiting_resource"])));
  for (const t of rows) await pause(db, t, reason, `takeover:${instanceId}`);
}

/**
 * Takeovers nobody is confirming any more (the browser closed or went offline): hand the computer back and
 * resume what the takeover paused, as an explicit hand-back would.
 */
export async function expireTakeovers(db: Db): Promise<number> {
  let n = 0;
  for (const inst of await db.select().from(computerInstances).where(eq(computerInstances.pausedAi, true))) {
    const lease = await currentLease(db, inst.id); // drops it when expired
    if (lease?.holderType === "user") continue;
    await db.update(computerInstances).set({ pausedAi: false }).where(eq(computerInstances.id, inst.id));
    await resumeInstanceTasks(db, inst.id);
    await audit(db, "instance.handback", {
      instanceId: inst.id,
      resourceType: "instance",
      resourceId: inst.id,
      detail: { automatic: "takeover no longer confirmed by the browser" },
    });
    await publish(db, "instance.operator", { id: inst.id, holder: null }, `instance:${inst.id}`, "admin");
    n++;
  }
  return n;
}

/** Hand-back resumes only what the takeover paused; emergency stops and manual pauses stay. */
export async function resumeInstanceTasks(db: Db, instanceId: string): Promise<void> {
  const { activeKillSwitch } = await import("./revocation.js");
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.instanceId, instanceId), eq(tasks.status, "paused")));
  for (const t of rows) {
    if (t.wait?.paused_by === `takeover:${instanceId}` && !(await activeKillSwitch(db, t))) await resume(db, t);
  }
}

export async function getTask(db: Db, id: string): Promise<Task | undefined> {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return t;
}

/**
 * Exclusive control of a computer's desktop.
 *
 * Several roles (and people) may share one computer. Commands can run side by side, but mouse, keyboard and
 * the visible browser cannot, so whoever drives the desktop holds a lease for a continuous stretch of work
 * (renewed on every action, released when the task stops or waits). A person with ``instance.control`` can
 * take over: AI work on that computer pauses until control is handed back. This is coordination between
 * cooperating roles, not a security boundary: a role with a shell could still reach the display.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type ComputerInstance, computerInstances, instanceLeases } from "../db/schema.js";
import { Forbidden } from "../errors.js";

export const LEASE_MS = 120_000;
/**
 * A person's takeover lasts while their browser keeps confirming it (every minute while they are active);
 * if it stops (closed, offline, idle), the takeover lapses after this long and AI work resumes.
 */
export const TAKEOVER_MS = 3 * 60_000;

export interface LeaseResult {
  ok: boolean;
  holderType?: string;
  holderId?: string;
  taskId?: string | null;
  reason?: string | null;
}

export async function currentLease(db: Db, instanceId: string) {
  const [lease] = await db
    .select()
    .from(instanceLeases)
    .where(and(eq(instanceLeases.instanceId, instanceId), eq(instanceLeases.kind, "input")))
    .limit(1);
  if (lease && lease.expiresAt.getTime() < Date.now()) {
    await db.delete(instanceLeases).where(eq(instanceLeases.id, lease.id));
    return undefined;
  }
  return lease;
}

export async function acquire(
  db: Db,
  instanceId: string,
  holderType: "role" | "user",
  holderId: string,
  opts: { taskId?: string | null; reason?: string | null; ms?: number; preempt?: boolean } = {},
): Promise<LeaseResult> {
  const lease = await currentLease(db, instanceId);
  const expiresAt = new Date(Date.now() + (opts.ms ?? LEASE_MS));
  // A lease belongs to one task: another task of the same role must wait as well.
  const sameHolder =
    lease &&
    lease.holderType === holderType &&
    lease.holderId === holderId &&
    (lease.taskId ?? null) === (opts.taskId ?? lease.taskId ?? null);
  if (lease && !sameHolder) {
    if (!opts.preempt) {
      return {
        ok: false,
        holderType: lease.holderType,
        holderId: lease.holderId,
        taskId: lease.taskId,
        reason: lease.reason,
      };
    }
    await db.delete(instanceLeases).where(eq(instanceLeases.id, lease.id));
  }
  if (lease && sameHolder) {
    await db.update(instanceLeases).set({ expiresAt }).where(eq(instanceLeases.id, lease.id));
  } else {
    await db.insert(instanceLeases).values({
      id: newId("lease"),
      instanceId,
      kind: "input",
      holderType,
      holderId,
      taskId: opts.taskId ?? null,
      reason: opts.reason ?? null,
      expiresAt,
    });
  }
  return { ok: true, holderType, holderId, taskId: opts.taskId ?? null };
}

export async function release(db: Db, instanceId: string, holderType: string, holderId: string): Promise<boolean> {
  const lease = await currentLease(db, instanceId);
  if (lease && lease.holderType === holderType && lease.holderId === holderId) {
    await db.delete(instanceLeases).where(eq(instanceLeases.id, lease.id));
    return true;
  }
  return false;
}

/** The task stopped, waits or finished: its stretch of desktop work is over. */
export async function releaseTask(db: Db, taskId: string): Promise<void> {
  await db.delete(instanceLeases).where(eq(instanceLeases.taskId, taskId));
}

export async function takeOver(db: Db, inst: ComputerInstance, userId: string, reason: string | null): Promise<void> {
  await acquire(db, inst.id, "user", userId, { reason, ms: TAKEOVER_MS, preempt: true });
  await db.update(computerInstances).set({ pausedAi: true }).where(eq(computerInstances.id, inst.id));
}

/** The person in control is still there: extend the takeover. False when they no longer hold it. */
export async function keepTakeover(db: Db, inst: ComputerInstance, userId: string): Promise<boolean> {
  const lease = await currentLease(db, inst.id);
  if (!(lease?.holderType === "user" && lease.holderId === userId)) return false;
  await db
    .update(instanceLeases)
    .set({ expiresAt: new Date(Date.now() + TAKEOVER_MS) })
    .where(eq(instanceLeases.id, lease.id));
  return true;
}

/** Only the person in control returns it (administrators may force it). */
export async function handBack(db: Db, inst: ComputerInstance, userId: string, force: boolean): Promise<void> {
  const lease = await currentLease(db, inst.id);
  if (lease && !(lease.holderType === "user" && lease.holderId === userId)) {
    if (!force) {
      throw new Forbidden(
        `computer ${inst.name} is controlled by ${lease.holderType} ${lease.holderId}; only they can hand it back`,
      );
    }
    await db.delete(instanceLeases).where(eq(instanceLeases.id, lease.id));
  } else {
    await release(db, inst.id, "user", userId);
  }
  await db.update(computerInstances).set({ pausedAi: false }).where(eq(computerInstances.id, inst.id));
}

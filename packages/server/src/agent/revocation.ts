/** Permission changes and emergency stops take effect on work that is already queued or running. */

import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  externalThreadLinks,
  type KillSwitch,
  killSwitches,
  roles,
  type Task,
  tasks,
  topics,
  users,
} from "../db/schema.js";
import { externalRoleId } from "../integrations/links.js";
import { hasPermission, Perm } from "../security/permissions.js";
import { linkedRequestRefusal } from "../services/topic-links.js";
import { participant } from "../services/topics.js";
import { ACTIVE, cancelTree, pause } from "./control.js";

/** Re-check the conditions the task was created under; returns why it may not continue (or null). */
export async function stillAllowed(db: Db, task: Task): Promise<string | null> {
  const [role] = await db.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
  // A disabled role's independent tasks are kept for another role to take over (agent/runner.ts gate).
  if (!role || (role.status !== "active" && task.kind !== "task")) return "the role was disabled or removed";
  const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
  if (topic?.status !== "active") return "the topic was archived";
  if (!(await participant(db, topic.id, "role", role.id))) return `@${role.handle} was removed from the topic`;
  // A Slack, Feishu or GitHub conversation: only the role its bot stands for (never the system administrator).
  const bound = await externalRoleId(db, topic.id);
  if (bound !== undefined && bound !== role.id)
    return `@${role.handle} does not work in this conversation: only the role its bot stands for does`;
  // A task started from a linked request ends with the link. A conversation goes on with its other work:
  // removing the link drops what has not reached it yet (services/topic-links.ts removeTopicLink).
  const linkedRefusal = task.kind === "task" ? await linkedRequestRefusal(db, task) : null;
  if (linkedRefusal) return linkedRefusal;
  if (task.requesterUserId) {
    const [user] = await db.select().from(users).where(eq(users.id, task.requesterUserId)).limit(1);
    if (!user?.isActive) return "the requester is no longer an active member";
    // Work another role of the topic handed over is bounded by that role's run, not by whom the person may use.
    if (!task.requesterRoleId && !(await hasPermission(db, user, Perm.ROLE_USE, role.id)))
      return `the requester may no longer use @${role.handle}`;
    const linkedRequester = (task.envelope?.topic_routes ?? []).some(
      (r: any) => r.origin?.requester_user_id === user.id,
    );
    // Two roles talking directly (agent/contacts.ts) work for a person who is never in that conversation.
    if (!linkedRequester && topic.kind !== "pair" && !(await participant(db, topic.id, "user", user.id)))
      return "the requester left the topic";
  }
  return null;
}

export async function recheckActiveTasks(db: Db, reason: string, taskIds?: string[]): Promise<number> {
  const rows = (
    await db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, [...ACTIVE]))
  ).filter((t) => !taskIds || taskIds.includes(t.id));
  let cancelled = 0;
  for (const task of rows) {
    const why = await stillAllowed(db, task);
    if (why) {
      await cancelTree(db, task, `${reason}: ${why}`);
      cancelled++;
    }
  }
  return cancelled;
}

export async function onUserDeactivated(db: Db, userId: string): Promise<number> {
  const ids = (await db.select({ id: tasks.id, requester: tasks.requesterUserId, status: tasks.status }).from(tasks))
    .filter((t) => t.requester === userId && ACTIVE.has(t.status))
    .map((t) => t.id);
  return recheckActiveTasks(db, "member deactivated", ids);
}

/** The task and every task it was (transitively) started from. */
export async function lineage(db: Db, task: Task): Promise<Set<string>> {
  const seen = new Set([task.id]);
  let current: Task | undefined = task;
  while (current?.spawnedByTaskId && !seen.has(current.spawnedByTaskId)) {
    seen.add(current.spawnedByTaskId);
    [current] = await db.select().from(tasks).where(eq(tasks.id, current.spawnedByTaskId)).limit(1);
  }
  return seen;
}

export async function descendants(db: Db, taskId: string): Promise<Set<string>> {
  const found = new Set<string>();
  let frontier = [taskId];
  while (frontier.length) {
    const children = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.spawnedByTaskId, frontier));
    frontier = children.map((c) => c.id).filter((id) => !found.has(id));
    for (const id of frontier) found.add(id);
  }
  return found;
}

export async function activeKillSwitch(db: Db, task: Task): Promise<KillSwitch | null> {
  const switches = await db.select().from(killSwitches).where(eq(killSwitches.active, true));
  if (!switches.length) return null;
  let connections: Set<string> | null = null;
  let tree: Set<string> | null = null;
  for (const ks of switches) {
    if (ks.scope === "global") return ks;
    if (ks.scope === "role" && ks.targetId === task.ownerRoleId) return ks;
    if (ks.scope === "instance" && ks.targetId === task.instanceId) return ks;
    if (ks.scope === "topic" && ks.targetId === task.topicId) return ks;
    if (ks.scope === "task") {
      tree ??= await lineage(db, task);
      if (ks.targetId && tree.has(ks.targetId)) return ks;
    }
    if (ks.scope === "connection") {
      connections ??= new Set(
        (await db.select().from(externalThreadLinks).where(eq(externalThreadLinks.topicId, task.topicId))).map(
          (l) => l.connectionId,
        ),
      );
      for (const route of task.envelope.topic_routes ?? []) {
        if (route.origin?.connection_id) connections.add(route.origin.connection_id);
      }
      if (ks.targetId && connections.has(ks.targetId)) return ks;
    }
  }
  return null;
}

const STOPPABLE = [
  "pending",
  "running",
  "waiting_resource",
  "waiting_children",
  "waiting_human",
  "waiting_approval",
  "waiting_timer",
];

export async function applyKillSwitch(db: Db, ks: KillSwitch): Promise<number> {
  let rows = await db.select().from(tasks).where(inArray(tasks.status, STOPPABLE));
  if (ks.scope === "role") rows = rows.filter((t) => t.ownerRoleId === ks.targetId);
  else if (ks.scope === "instance") rows = rows.filter((t) => t.instanceId === ks.targetId);
  else if (ks.scope === "topic") rows = rows.filter((t) => t.topicId === ks.targetId);
  else if (ks.scope === "task") {
    const ids = await descendants(db, ks.targetId!);
    ids.add(ks.targetId!);
    rows = rows.filter((t) => ids.has(t.id));
  } else if (ks.scope === "connection") {
    const topicIds = new Set(
      (await db.select().from(externalThreadLinks).where(eq(externalThreadLinks.connectionId, ks.targetId!))).map(
        (l) => l.topicId,
      ),
    );
    rows = rows.filter(
      (t) =>
        topicIds.has(t.topicId) ||
        (t.envelope.topic_routes ?? []).some((r: any) => r.origin?.connection_id === ks.targetId),
    );
  }
  for (const t of rows) await pause(db, t, `emergency stop: ${ks.reason || ks.scope}`, `kill:${ks.id}`);
  return rows.length;
}

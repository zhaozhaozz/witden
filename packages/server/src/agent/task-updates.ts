/**
 * Progress recorded on independent tasks (post_progress): a history people read on the task page and whoever
 * takes the task over gets in its brief. The latest update is also the task's progress note (tasks.progress).
 */
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type Role, type Task, type TaskUpdate, tasks, taskUpdates } from "../db/schema.js";
import { BadRequest } from "../errors.js";
import { redact } from "../security/crypto.js";
import { audit } from "../services/audit.js";
import { publish } from "../services/events.js";
import { publishTaskStatus } from "./control.js";

export const UPDATE_LIMIT = 4000;
/** What the task's progress note (tasks.progress) keeps of the latest update. */
const NOTE_LIMIT = 2000;

/** Record a role's progress update on ``target``; ``sourceTaskId`` is the run it was recorded from. */
export async function recordTaskUpdate(
  db: Db,
  target: Task,
  author: Role,
  content: string,
  sourceTaskId: string | null,
): Promise<TaskUpdate> {
  const text = redact(content.trim());
  if (!text) throw new BadRequest("progress text is required");
  if (text.length > UPDATE_LIMIT) throw new BadRequest(`progress is limited to ${UPDATE_LIMIT} characters`);
  const [update] = await db
    .insert(taskUpdates)
    .values({
      id: newId("tup"),
      taskId: target.id,
      revision: target.revision,
      authorType: "role",
      authorId: author.id,
      sourceTaskId,
      content: text,
    })
    .returning();
  const [row] = await db
    .update(tasks)
    .set({ progress: text.slice(0, NOTE_LIMIT) })
    .where(eq(tasks.id, target.id))
    .returning();
  await publishTaskStatus(db, row);
  await publish(
    db,
    "task.update",
    { task_id: target.id, update_id: update.id },
    `topic:${target.topicId}`,
    `task:${target.id}`,
  );
  await audit(db, "task.progress", {
    actorType: "role",
    actorId: author.id,
    taskId: target.id,
    topicId: target.topicId,
    roleId: author.id,
    detail: { source_task_id: sourceTaskId, chars: text.length },
  });
  return update;
}

/** A task's updates in the order they were recorded; with ``latest``, only the last ones. */
export async function listTaskUpdates(db: Db, taskId: string, latest?: number): Promise<TaskUpdate[]> {
  if (!latest)
    return db.select().from(taskUpdates).where(eq(taskUpdates.taskId, taskId)).orderBy(asc(taskUpdates.createdAt));
  const rows = await db
    .select()
    .from(taskUpdates)
    .where(eq(taskUpdates.taskId, taskId))
    .orderBy(desc(taskUpdates.createdAt))
    .limit(latest);
  return rows.reverse();
}

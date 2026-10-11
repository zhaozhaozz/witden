import { and, eq, isNull } from "drizzle-orm";
import { cancelTree, getTask, TERMINAL } from "../agent/control.js";
import { appendStep } from "../agent/transcript.js";
import type { Db } from "../db/client.js";
import { type Message, memories, messages, taskSteps, tasks } from "../db/schema.js";

/**
 * Deleting a message removes its text everywhere we keep it: the message is blanked, memories derived from
 * it are deleted, work it started loses its transcript, and verbatim copies elsewhere in the topic's task
 * transcripts are scrubbed. Audit records only ever held metadata.
 */
export async function purgeMessage(db: Db, msg: Message) {
  const original = msg.content;
  await db.update(messages).set({ deletedAt: new Date(), content: "" }).where(eq(messages.id, msg.id));
  let memoriesDeleted = 0;
  for (const m of await db.select().from(memories).where(isNull(memories.deletedAt))) {
    if (m.sourceMessageIds.includes(msg.id)) {
      await db.update(memories).set({ deletedAt: new Date(), content: "" }).where(eq(memories.id, m.id));
      memoriesDeleted++;
    }
  }
  let scrubbed = 0;
  if (original.trim()) {
    for (const t of await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.topicId, msg.topicId))) {
      for (const s of await db.select().from(taskSteps).where(eq(taskSteps.taskId, t.id))) {
        const content = s.payload.content;
        if (typeof content === "string" && content.includes(original)) {
          await db
            .update(taskSteps)
            .set({ payload: { ...s.payload, content: content.split(original).join("[deleted message]") } })
            .where(eq(taskSteps.id, s.id));
          scrubbed++;
        }
      }
    }
  }
  let removed = 0;
  for (const task of await db.select().from(tasks).where(eq(tasks.sourceMessageId, msg.id))) {
    if (!TERMINAL.has(task.status)) await cancelTree(db, task, "source message deleted");
    const steps = await db.select({ id: taskSteps.id }).from(taskSteps).where(eq(taskSteps.taskId, task.id));
    removed += steps.length;
    await db.delete(taskSteps).where(eq(taskSteps.taskId, task.id));
    const [row] = await db
      .update(tasks)
      .set({ instruction: "[deleted message]", result: task.result ? "[removed: source message deleted]" : null })
      .where(eq(tasks.id, task.id))
      .returning();
    await appendStep(db, row, "event", { type: "transcript_removed", reason: "source message deleted" });
  }
  return { memories_deleted: memoriesDeleted, transcript_steps_scrubbed: scrubbed, transcript_steps_removed: removed };
}

export { and, getTask };

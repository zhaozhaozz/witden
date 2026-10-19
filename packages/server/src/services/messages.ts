import { and, asc, eq, gt, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { cancelTree, getTask, TERMINAL } from "../agent/control.js";
import { appendStep } from "../agent/transcript.js";
import type { Db } from "../db/client.js";
import { agentSessions, type Message, memories, messages, taskSteps, tasks } from "../db/schema.js";
import { erased } from "./memories.js";

/**
 * Deleting a message removes its text everywhere we keep it: the message is blanked, memories derived from
 * it are deleted, tasks it started lose their transcript, title, progress and session notes, and verbatim
 * copies elsewhere in the topic's transcripts, progress and session notes are scrubbed. In a role's
 * conversation the turn that answered it leaves the context (a turn still under way stops first); one that
 * has not been shown it yet never will be. Audit records only ever held metadata.
 */
export async function purgeMessage(db: Db, msg: Message) {
  const original = msg.content;
  await db.update(messages).set({ deletedAt: new Date(), content: "" }).where(eq(messages.id, msg.id));
  let memoriesDeleted = 0;
  for (const m of await db.select().from(memories).where(isNull(memories.deletedAt))) {
    if (m.sourceMessageIds.includes(msg.id)) {
      await db.update(memories).set(erased()).where(eq(memories.id, m.id));
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
  const scrub = (text: string | null) =>
    text && original.trim() && text.includes(original) ? text.split(original).join("[deleted message]") : text;
  for (const t of await db.select().from(tasks).where(eq(tasks.topicId, msg.topicId))) {
    const progress = scrub(t.progress);
    if (progress !== t.progress) await db.update(tasks).set({ progress }).where(eq(tasks.id, t.id));
  }
  // Session notes: drop the ones of work this message started, scrub quotes of it in the others.
  const started = new Set(
    (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.sourceMessageId, msg.id))).map((t) => t.id),
  );
  const head = original.slice(0, 300);
  for (const session of await db.select().from(agentSessions).where(eq(agentSessions.topicId, msg.topicId))) {
    if (session.inbox.some((i) => i.message_id === msg.id && !i.done)) {
      const at = new Date().toISOString();
      const inbox = session.inbox.map((i) => (i.message_id === msg.id && !i.done ? { ...i, done: at } : i));
      await db.update(agentSessions).set({ inbox }).where(eq(agentSessions.id, session.id));
    }
    const notes = session.notes
      .filter((n: any) => !started.has(n.task_id ?? n.taskId))
      .map((n: any) => ({
        ...n,
        request: head.trim() && n.request === head ? "[deleted message]" : scrub(n.request),
        result: scrub(n.result),
      }));
    if (JSON.stringify(notes) !== JSON.stringify(session.notes))
      await db.update(agentSessions).set({ notes }).where(eq(agentSessions.id, session.id));
  }
  let removed = await removeAnsweringTurns(db, msg);
  for (const task of await db.select().from(tasks).where(eq(tasks.sourceMessageId, msg.id))) {
    // A conversation run answered more than this message: its context only loses the text (scrubbed above).
    if (task.kind === "conversation") {
      await db
        .update(tasks)
        .set({ instruction: "[deleted message]", title: "[deleted message]" })
        .where(eq(tasks.id, task.id));
      continue;
    }
    if (!TERMINAL.has(task.status)) await cancelTree(db, task, "source message deleted");
    const steps = await db.select({ id: taskSteps.id }).from(taskSteps).where(eq(taskSteps.taskId, task.id));
    removed += steps.length;
    await db.delete(taskSteps).where(eq(taskSteps.taskId, task.id));
    const [row] = await db
      .update(tasks)
      .set({
        instruction: "[deleted message]",
        title: "[deleted message]",
        progress: null,
        result: task.result ? "[removed: source message deleted]" : null,
      })
      .where(eq(tasks.id, task.id))
      .returning();
    await appendStep(db, row, "event", { type: "transcript_removed", reason: "source message deleted" });
  }
  return { memories_deleted: memoriesDeleted, transcript_steps_scrubbed: scrubbed, transcript_steps_removed: removed };
}

/**
 * Conversations that were shown the message as theirs: the turn that answered it (from that batch of new
 * messages up to the next one) leaves the context. Its tool calls and their results go together, so what
 * remains is still a valid conversation.
 */
async function removeAnsweringTurns(db: Db, msg: Message): Promise<number> {
  let removed = 0;
  const batches = await db
    .select()
    .from(taskSteps)
    .where(
      and(
        eq(taskSteps.kind, "user"),
        isNotNull(taskSteps.sessionId),
        sql`(${taskSteps.payload}->'inbox'->'messages') @> ${JSON.stringify([msg.id])}::jsonb`,
      ),
    );
  for (const batch of batches) {
    const [next] = await db
      .select()
      .from(taskSteps)
      .where(
        and(
          eq(taskSteps.sessionId, batch.sessionId!),
          eq(taskSteps.kind, "user"),
          gt(taskSteps.sessionSeq, batch.sessionSeq!),
        ),
      )
      .orderBy(asc(taskSteps.sessionSeq))
      .limit(1);
    if (!next) {
      // The turn may still be under way: it stops, as work on a deleted request does.
      const [run] = await db.select().from(tasks).where(eq(tasks.id, batch.taskId)).limit(1);
      if (run && !TERMINAL.has(run.status)) await cancelTree(db, run, "source message deleted");
    }
    const turn = await db
      .delete(taskSteps)
      .where(
        and(
          eq(taskSteps.sessionId, batch.sessionId!),
          gte(taskSteps.sessionSeq, batch.sessionSeq!),
          ...(next ? [lt(taskSteps.sessionSeq, next.sessionSeq!)] : []),
        ),
      )
      .returning({ id: taskSteps.id });
    removed += turn.length;
    const [run] = await db.select().from(tasks).where(eq(tasks.id, batch.taskId)).limit(1);
    if (run) await appendStep(db, run, "event", { type: "transcript_removed", reason: "source message deleted" });
  }
  return removed;
}

export { and, getTask };

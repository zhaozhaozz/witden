/**
 * Persistent, resumable transcripts (also the execution log shown to observers).
 *
 * A task's model context is its own steps. A conversation run's context is its session's: the steps of all
 * its runs in order (session_seq), from where the session's context starts (the beginning, a compaction
 * summary, or a reset).
 */
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { agentSessions, type Task, taskSteps } from "../db/schema.js";
import { redactDeep } from "../security/crypto.js";
import { publish } from "../services/events.js";
import type { ChatMessage } from "./llm.js";

const TRANSCRIPT_KINDS = ["user", "assistant", "tool"];

export function stepPreview(payload: Record<string, any>, full = false): Record<string, any> {
  const out = { ...payload };
  if (Array.isArray(out.content))
    out.content = out.content.map((p: any) => (p.type === "text" ? p : { type: "image" }));
  else if (!full && typeof out.content === "string" && out.content.length > 4000)
    out.content = `${out.content.slice(0, 4000)}…`;
  return out;
}

export const isConversation = (task: Pick<Task, "kind" | "sessionId">) =>
  task.kind === "conversation" && !!task.sessionId;

/** The next place in a session's context (only one run of a session appends at a time). */
export async function nextSessionSeq(db: Db, sessionId: string): Promise<number> {
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${taskSteps.sessionSeq}), 0)::int` })
    .from(taskSteps)
    .where(eq(taskSteps.sessionId, sessionId));
  return Number(max) + 1;
}

export async function appendStep(db: Db, task: Task, kind: string, payload: Record<string, any>): Promise<number> {
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${taskSteps.seq}), 0)::int` })
    .from(taskSteps)
    .where(eq(taskSteps.taskId, task.id));
  const seq = Number(max) + 1;
  const session = isConversation(task)
    ? { sessionId: task.sessionId, sessionSeq: await nextSessionSeq(db, task.sessionId!) }
    : {};
  await db.insert(taskSteps).values({ id: newId("step"), taskId: task.id, seq, kind, payload, ...session });
  // Only subscribers allowed to read everything the task read receive step previews (checked per event).
  await publish(
    db,
    "task.step",
    { task_id: task.id, seq, kind, payload: redactDeep(stepPreview(payload)) },
    `task:${task.id}`,
  );
  // Topic watchers fetch authorized details on demand; this invalidation never carries transcript content.
  await publish(db, "task.progress", { task_id: task.id, seq }, `topic:${task.topicId}`);
  return seq;
}

/** The steps that make up the model context: the task's own, or its conversation's from the context start. */
async function contextSteps(db: Db, task: Task) {
  if (!isConversation(task)) {
    // A reassigned task retains its complete audit log, but does not inject a previous role's
    // private tool outputs and model history into the new executor's context.
    const from = Number(task.assignment?.handoff_context_from_seq ?? 0);
    const start = Number.isSafeInteger(from) && from > 0 ? from : 0;
    return db
      .select()
      .from(taskSteps)
      .where(and(eq(taskSteps.taskId, task.id), gte(taskSteps.seq, start), inArray(taskSteps.kind, TRANSCRIPT_KINDS)))
      .orderBy(asc(taskSteps.seq));
  }
  const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, task.sessionId!)).limit(1);
  return db
    .select()
    .from(taskSteps)
    .where(
      and(
        eq(taskSteps.sessionId, task.sessionId!),
        gte(taskSteps.sessionSeq, session?.contextFrom ?? 0),
        inArray(taskSteps.kind, TRANSCRIPT_KINDS),
      ),
    )
    .orderBy(asc(taskSteps.sessionSeq));
}

/** Rebuild chat messages; screenshots older than the latest one are dropped to save tokens. */
export async function loadTranscript(db: Db, task: Task): Promise<ChatMessage[]> {
  const steps = await contextSteps(db, task);
  const messages: ChatMessage[] = steps.map((s) => {
    const p = s.payload;
    if (s.kind === "assistant") {
      const m: ChatMessage = { role: "assistant", content: p.content ?? "" };
      if (p.tool_calls?.length) m.tool_calls = p.tool_calls;
      // Only services that returned it get it back; others never see the field.
      if (typeof p.reasoning_content === "string" && p.reasoning_content) m.reasoning_content = p.reasoning_content;
      return m;
    }
    if (s.kind === "tool") return { role: "tool", tool_call_id: p.tool_call_id ?? "", content: p.content ?? "" };
    return { role: "user", content: p.content ?? "" };
  });
  let lastImage = -1;
  messages.forEach((m, i) => {
    if (Array.isArray(m.content)) lastImage = i;
  });
  messages.forEach((m, i) => {
    if (Array.isArray(m.content) && i !== lastImage) {
      m.content = `${m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ")} [earlier screenshot omitted]`;
    }
  });
  return repair(messages);
}

/** Every tool call needs a result; a crash between the two must not break the next model call. */
function repair(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  messages.forEach((m, i) => {
    out.push(m);
    if (m.role === "assistant" && m.tool_calls?.length) {
      const answered = new Set(
        messages
          .slice(i + 1)
          .filter((n) => n.role === "tool")
          .map((n) => n.tool_call_id),
      );
      for (const call of m.tool_calls) {
        if (!answered.has(call.id)) {
          out.push({ role: "tool", tool_call_id: call.id, content: "interrupted: this call did not complete" });
        }
      }
    }
  });
  return out;
}

export async function taskLog(db: Db, task: Task, limit = 500) {
  const steps = await db
    .select()
    .from(taskSteps)
    .where(eq(taskSteps.taskId, task.id))
    .orderBy(asc(taskSteps.seq))
    .limit(limit);
  return steps.map((s) => ({
    seq: s.seq,
    kind: s.kind,
    payload: redactDeep(stepPreview(s.payload)),
    created_at: s.createdAt.toISOString(),
  }));
}

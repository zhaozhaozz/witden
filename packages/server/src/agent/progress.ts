import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type Task, taskSteps, toolCalls, usageRecords } from "../db/schema.js";
import { redactDeep } from "../security/crypto.js";
import { stepPreview } from "./transcript.js";

/** A page can start with a tool result whose request is on an earlier page. Keep that operation inspectable. */
async function requestsFor(db: Db, task: Task, ids: string[]) {
  const calls = new Map<string, { id: string; function: { name: string; arguments: unknown } }>();
  if (!ids.length) return calls;
  const sources = await db
    .select({ payload: taskSteps.payload })
    .from(taskSteps)
    .where(
      and(
        eq(taskSteps.taskId, task.id),
        eq(taskSteps.kind, "assistant"),
        sql`exists (select 1 from jsonb_array_elements(coalesce(${taskSteps.payload}->'tool_calls', '[]'::jsonb)) c
      where c->>'id' in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}))`,
      ),
    );
  for (const source of sources)
    for (const call of source.payload.tool_calls ?? []) {
      if (ids.includes(call.id)) calls.set(call.id, redactDeep(call));
    }
  return calls;
}

export async function taskProgress(db: Db, task: Task, cursor: { after?: number; before?: number; steps: boolean }) {
  const [usage] = await db
    .select({
      rounds: sql<number>`count(*)::int`,
      tokens:
        sql<number>`coalesce(sum(${usageRecords.promptTokens}::bigint + ${usageRecords.completionTokens}), 0)`.mapWith(
          Number,
        ),
    })
    .from(usageRecords)
    .where(eq(usageRecords.taskId, task.id));
  const [commands] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(toolCalls)
    .where(and(eq(toolCalls.taskId, task.id), inArray(toolCalls.op, ["exec.run", "terminal.create"])));
  const out = {
    id: task.id,
    status: task.status,
    started_at: (task.startedAt ?? task.createdAt).toISOString(),
    finished_at: task.finishedAt?.toISOString() ?? null,
    ...usage,
    commands: commands.count,
    steps: [] as { seq: number; kind: string; payload: Record<string, any>; created_at: string }[],
    has_more: false,
  };
  if (!cursor.steps) return out;
  const cond = [eq(taskSteps.taskId, task.id)];
  if (cursor.after !== undefined) cond.push(gt(taskSteps.seq, cursor.after));
  if (cursor.before !== undefined) cond.push(lt(taskSteps.seq, cursor.before));
  const rows = await db
    .select()
    .from(taskSteps)
    .where(and(...cond))
    .orderBy(cursor.after !== undefined ? asc(taskSteps.seq) : desc(taskSteps.seq))
    .limit(101);
  out.has_more = rows.length > 100;
  const page = rows.slice(0, 100);
  const present = new Set(page.flatMap((s) => (s.payload.tool_calls ?? []).map((c: { id: string }) => c.id)));
  const requests = await requestsFor(
    db,
    task,
    page
      .filter((s) => s.kind === "tool" && s.payload.tool_call_id && !present.has(s.payload.tool_call_id))
      .map((s) => s.payload.tool_call_id),
  );
  out.steps = page
    .sort((a, b) => a.seq - b.seq)
    .map((s) => ({
      seq: s.seq,
      kind: s.kind,
      payload: redactDeep({
        ...stepPreview(s.payload),
        ...(typeof s.payload.reasoning_content === "string"
          ? { reasoning_content: s.payload.reasoning_content.slice(0, 4000) }
          : {}),
      }),
      created_at: s.createdAt.toISOString(),
      ...(requests.has(s.payload.tool_call_id) ? { request: requests.get(s.payload.tool_call_id) } : {}),
    }));
  return out;
}

/** Full stored text only when the reader expands a row. Image bytes never travel in log responses. */
export async function taskStepDetail(db: Db, task: Task, seq: number) {
  const [s] = await db
    .select()
    .from(taskSteps)
    .where(and(eq(taskSteps.taskId, task.id), eq(taskSteps.seq, seq)));
  const requests =
    s?.kind === "tool" && s.payload.tool_call_id ? await requestsFor(db, task, [s.payload.tool_call_id]) : new Map();
  return s
    ? {
        seq: s.seq,
        kind: s.kind,
        payload: redactDeep(stepPreview(s.payload, true)),
        created_at: s.createdAt.toISOString(),
        ...(requests.has(s.payload.tool_call_id) ? { request: requests.get(s.payload.tool_call_id) } : {}),
      }
    : null;
}

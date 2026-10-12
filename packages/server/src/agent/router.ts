/**
 * The dispatcher of "auto" topics with several roles: for a message nobody @-mentioned, one small model call
 * decides which roles take it — none (small talk, people talking to each other), usually one, or several when
 * it clearly needs different responsibilities. The chosen roles may still decline (stay_silent).
 *
 * Messages wait in ``message_routes``; the worker claims them like tasks (a crash never loses one) and calls
 * the model outside any transaction. The model is a platform setting ("dispatcher"); fast, non-reasoning
 * ("System 1") models suit it: the prompt is short and the answer is plain JSON, no tool calling.
 */
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { type Db, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type Message, messageRoutes, messages, type Role, type Topic, topics, usageRecords } from "../db/schema.js";
import * as models from "../services/model-configs.js";
import { DISPATCHER, type DispatcherSetting, getSetting } from "../services/platform-settings.js";
import { activeRoleIds, authorize, createTask, systemMessage } from "./dispatch.js";
import type { ChatModel } from "./llm.js";
import { authorName } from "./tools.js";

/** First words of the dispatcher prompt (tests recognise the call by them). */
export const DISPATCHER_PROMPT_START = "You are the dispatcher of a team chat";
const CONTEXT_MESSAGES = 12;
const MAX_ATTEMPTS = 3;

/** Claim routes to work on (pending, or stuck in "routing" after a crash). */
export async function claimRoutes(db: Db, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await db.execute(sql`
    update message_routes set status = 'routing', claimed_at = now(), attempts = attempts + 1
    where message_id in (
      select message_id from message_routes
      where status = 'pending' or (status = 'routing' and claimed_at < now() - interval '5 minutes')
      order by created_at
      for update skip locked limit ${limit}
    )
    returning message_id`);
  return ((rows as any).rows ?? rows).map((r: any) => r.message_id as string);
}

interface Prepared {
  msg: Message;
  topic: Topic;
  userId: string;
  candidates: Role[];
  model: ChatModel | null;
  modelConfigId: string | null;
  /** Why the dispatcher cannot run (shown to people once in a while). */
  problem: string | null;
  prompt: { system: string; user: string } | null;
}

/** Route one claimed message. Never throws: failures end up on the route row (and, if useful, in the topic). */
export async function routeMessage(messageId: string): Promise<void> {
  try {
    const p = await transaction((tx) => prepare(tx, messageId));
    if (!p) return;
    if (p.candidates.length <= 1 || !p.model || !p.prompt) {
      // One usable role: it decides itself. None, or no dispatcher: nobody takes the message.
      await transaction((tx) => apply(tx, p, p.candidates.length === 1 ? [p.candidates[0]] : [], p.problem ?? ""));
      return;
    }
    const answer = await p.model.complete([
      { role: "system", content: p.prompt.system },
      { role: "user", content: p.prompt.user },
    ]);
    const decision = parseDecision(answer.content, p.candidates);
    await transaction(async (tx) => {
      await tx.insert(usageRecords).values({
        id: newId("use"),
        modelConfigId: p.modelConfigId,
        promptTokens: answer.promptTokens,
        completionTokens: answer.completionTokens,
      });
      await apply(tx, p, decision.roles, decision.reason);
    });
  } catch (err) {
    await transaction(async (tx) => {
      const [route] = await tx.select().from(messageRoutes).where(eq(messageRoutes.messageId, messageId)).limit(1);
      if (!route) return;
      const failed = route.attempts >= MAX_ATTEMPTS;
      await tx
        .update(messageRoutes)
        .set({ status: failed ? "failed" : "pending", result: { error: (err as Error).message.slice(0, 500) } })
        .where(eq(messageRoutes.messageId, messageId));
      if (failed) {
        const [topic] = await tx.select().from(topics).where(eq(topics.id, route.topicId)).limit(1);
        if (topic)
          await systemMessage(
            tx,
            topic,
            `The dispatcher could not decide who should answer (${(err as Error).message.slice(0, 200)}); @-mention a role to ask it directly.`,
            { mentions: [{ type: "user", id: route.userId }] },
          );
      }
    });
  }
}

async function prepare(db: Db, messageId: string): Promise<Prepared | null> {
  const [route] = await db.select().from(messageRoutes).where(eq(messageRoutes.messageId, messageId)).limit(1);
  if (route?.status !== "routing") return null;
  const done = async (result: Record<string, any>) => {
    await db.update(messageRoutes).set({ status: "done", result }).where(eq(messageRoutes.messageId, messageId));
    return null;
  };
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  const [topic] = msg ? await db.select().from(topics).where(eq(topics.id, msg.topicId)).limit(1) : [];
  // Deleted, archived, or switched back to @-mentions meanwhile: nothing to route.
  if (!msg || msg.deletedAt || !topic || topic.status !== "active" || topic.responseMode !== "auto")
    return done({ skipped: true });
  // Only roles this person may use are offered to the dispatcher.
  const { allowed } = await authorize(db, topic, route.userId, await activeRoleIds(db, topic));
  const candidates = allowed.map(([role]) => role);
  const base: Prepared = {
    msg,
    topic,
    userId: route.userId,
    candidates,
    model: null,
    modelConfigId: null,
    problem: null,
    prompt: null,
  };
  if (candidates.length <= 1) return base;

  const setting = await getSetting<DispatcherSetting>(db, DISPATCHER);
  const found = setting?.model_config_id ? await models.modelWithProvider(db, setting.model_config_id) : null;
  let problem: string | null = null;
  if (!found) problem = "no dispatcher model is set (System administration → dispatcher)";
  else if (models.unusableReason(found.model, found.provider))
    problem = `the dispatcher model is unavailable: ${models.unusableReason(found.model, found.provider)}`;
  else if (topic.allowedModelConfigIds && !topic.allowedModelConfigIds.includes(found.model.id))
    problem = "this topic does not allow the dispatcher model";
  if (problem || !found) return { ...base, problem };
  return {
    ...base,
    model: await models.chatModelFor(db, found.model),
    modelConfigId: found.model.id,
    prompt: await buildPrompt(db, topic, msg, candidates),
  };
}

async function buildPrompt(db: Db, topic: Topic, msg: Message, candidates: Role[]) {
  const roleLines = candidates
    .map(
      (r) =>
        `- @${r.handle} — ${r.name}${r.description ? `: ${r.description.replace(/\s+/g, " ").slice(0, 300)}` : ""}`,
    )
    .join("\n");
  const system = `${DISPATCHER_PROMPT_START} where people work with AI roles. Decide which roles should respond to the latest message.

Roles in this chat:
${roleLines}

Rules:
- Choose no role when the message does not need one: small talk, a thank-you, people talking to each other, or something already handled.
- Usually choose exactly one role: the one whose responsibilities fit best. When the message continues a role's ongoing exchange, choose that role.
- Choose several roles only when the message clearly needs different responsibilities.
- A role being named in passing is not a reason to choose it.

Answer with JSON only, nothing else: {"roles": ["handle"], "reason": "one short sentence"}`;

  const recent = await db
    .select()
    .from(messages)
    .where(and(eq(messages.topicId, topic.id), lte(messages.createdAt, msg.createdAt)))
    .orderBy(desc(messages.createdAt))
    .limit(CONTEXT_MESSAGES + 1);
  const lines: string[] = [];
  for (const m of recent.reverse()) {
    if (m.id === msg.id || m.deletedAt) continue;
    lines.push(`[${await authorName(db, m.authorType, m.authorId)}] ${m.content.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  const from = await authorName(db, msg.authorType, msg.authorId);
  const user = `Topic: ${topic.title}${topic.goal ? `\nGoal: ${topic.goal}` : ""}

Recent messages (oldest first):
${lines.join("\n") || "(none)"}

Latest message, from ${from}:
${msg.content.slice(0, 2000)}`;
  return { system, user };
}

/** The roles named in the dispatcher's answer: JSON when it follows instructions, @handles otherwise. */
export function parseDecision(text: string, candidates: Role[]): { roles: Role[]; reason: string } {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const byHandle = new Map(candidates.map((r) => [r.handle.toLowerCase(), r]));
  const pick = (names: unknown[]) => {
    const out = new Map<string, Role>();
    for (const n of names) {
      const r = byHandle.get(String(n).trim().replace(/^@/, "").toLowerCase());
      if (r) out.set(r.id, r);
    }
    return [...out.values()];
  };
  const json = /\{[\s\S]*\}/.exec(clean)?.[0];
  if (json) {
    try {
      const data = JSON.parse(json);
      if (Array.isArray(data.roles))
        return { roles: pick(data.roles), reason: String(data.reason ?? "").slice(0, 300) };
    } catch {
      // fall through to the lenient reading
    }
  }
  return {
    roles: pick([...clean.matchAll(/@([A-Za-z0-9][A-Za-z0-9_.-]*)/g)].map((m) => m[1])),
    reason: clean.slice(0, 300),
  };
}

async function apply(db: Db, p: Prepared, chosen: Role[], reason: string): Promise<void> {
  const [route] = await db.select().from(messageRoutes).where(eq(messageRoutes.messageId, p.msg.id)).limit(1);
  if (route?.status !== "routing") return;
  if (p.problem) await reportProblem(db, p);
  // Permissions are checked again: they may have changed while the model was answering.
  const { allowed } = chosen.length
    ? await authorize(
        db,
        p.topic,
        p.userId,
        chosen.map((r) => r.id),
      )
    : { allowed: [] };
  const created: string[] = [];
  for (const [role, assignment] of allowed) {
    const trace = [...(assignment.trace ?? []), { step: "dispatcher", detail: reason || "only role in the topic" }];
    const task = await createTask(db, {
      topic: p.topic,
      role,
      requesterUserId: p.userId,
      instruction: p.msg.content,
      sourceMessage: p.msg,
      assignment: { ...assignment, trace },
      idempotencyKey: `route:${p.msg.id}:${role.id}`,
      auto: true,
    });
    created.push(task.id);
  }
  await db
    .update(messageRoutes)
    .set({
      status: "done",
      result: { roles: allowed.map(([r]) => r.handle), tasks: created, reason, problem: p.problem },
    })
    .where(eq(messageRoutes.messageId, p.msg.id));
}

/** Tell people the topic cannot route automatically — at most every ten minutes per topic. */
async function reportProblem(db: Db, p: Prepared): Promise<void> {
  const [recent] = await db
    .select({ id: messageRoutes.messageId })
    .from(messageRoutes)
    .where(
      and(
        eq(messageRoutes.topicId, p.topic.id),
        eq(messageRoutes.status, "done"),
        gt(messageRoutes.createdAt, new Date(Date.now() - 10 * 60_000)),
        sql`${messageRoutes.result}->>'problem' is not null`,
      ),
    )
    .limit(1);
  if (recent) return;
  await systemMessage(
    db,
    p.topic,
    `Nobody was @-mentioned and the topic answers automatically, but ${p.problem}. @-mention a role to ask it directly.`,
    { mentions: [{ type: "user", id: p.userId }] },
  );
}

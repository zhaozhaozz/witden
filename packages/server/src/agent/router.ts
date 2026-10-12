/**
 * The dispatcher of "auto" topics with several roles: for a message nobody @-mentioned, a System One decision
 * model (TypeSafe Jev, Laya; agent/systemone.ts) decides which roles take it — none (small talk, people talking
 * to each other), usually one, or several when it needs different responsibilities. The chosen roles may still
 * decline (stay_silent).
 *
 * One ``choice`` question: which role should handle the message, or nobody. The most likely answer wins; when
 * it is a role, other roles at least ``ALSO`` likely take the message too. The state is the message alone:
 * measured on a real Laya server with Chinese chat, separate yes/no questions per role and any earlier
 * messages in the state made the decisions much worse (a role's previous reply drew nearly every message to
 * that role). A reply to a role's question therefore needs an @ to reach it.
 *
 * Messages wait in ``message_routes``; the worker claims them like tasks (a crash never loses one) and calls
 * the model outside any transaction. The model is a platform setting ("dispatcher").
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { type Db, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type Message, messageRoutes, messages, type Role, type Topic, topics, usageRecords } from "../db/schema.js";
import * as models from "../services/model-configs.js";
import { DISPATCHER, type DispatcherSetting, getSetting } from "../services/platform-settings.js";
import { activeRoleIds, authorize, createTask, systemMessage } from "./dispatch.js";
import type { Decision, DecisionModel, Question } from "./systemone.js";
import { authorName } from "./tools.js";

const MAX_ATTEMPTS = 3;
/** A role this likely, besides the most likely one, takes the message too. */
const ALSO = 0.3;

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
  model: DecisionModel | null;
  modelConfigId: string | null;
  /** Why the dispatcher cannot run (shown to people once in a while). */
  problem: string | null;
  request: { state: unknown; questions: Record<string, Question> } | null;
}

/** Route one claimed message. Never throws: failures end up on the route row (and, if useful, in the topic). */
export async function routeMessage(messageId: string): Promise<void> {
  try {
    const p = await transaction((tx) => prepare(tx, messageId));
    if (!p) return;
    if (p.candidates.length <= 1 || !p.model || !p.request) {
      // One usable role: it decides itself. None, or no dispatcher: nobody takes the message.
      await transaction((tx) => apply(tx, p, p.candidates.length === 1 ? [p.candidates[0]] : [], p.problem ?? ""));
      return;
    }
    const answer = await p.model.decide(p.request.state, p.request.questions);
    const decision = readDecision(answer, p.candidates);
    await transaction(async (tx) => {
      await tx.insert(usageRecords).values({
        id: newId("use"),
        modelConfigId: p.modelConfigId,
        promptTokens: answer.inputTokens,
        completionTokens: answer.outputTokens,
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
    request: null,
  };
  if (candidates.length <= 1) return base;

  const setting = await getSetting<DispatcherSetting>(db, DISPATCHER);
  const found = setting?.model_config_id ? await models.modelWithProvider(db, setting.model_config_id) : null;
  let problem: string | null = null;
  if (!found) problem = "no dispatcher model is set (System administration → dispatcher)";
  else if (!models.isSystemOne(found.provider)) problem = "the dispatcher model is not a System One decision model";
  else if (models.unusableReason(found.model, found.provider))
    problem = `the dispatcher model is unavailable: ${models.unusableReason(found.model, found.provider)}`;
  else if (topic.allowedModelConfigIds && !topic.allowedModelConfigIds.includes(found.model.id))
    problem = "this topic does not allow the dispatcher model";
  if (problem || !found) return { ...base, problem };
  return {
    ...base,
    model: await models.decisionModelFor(db, found.model),
    modelConfigId: found.model.id,
    request: await buildRequest(db, msg, candidates),
  };
}

const clip = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** The option for "no role should answer" (a role could be called "nobody"). */
const nobodyKey = (candidates: Role[]) => (candidates.some((r) => r.handle === "nobody") ? "no_role" : "nobody");

/** The question: which role (by name and responsibilities) should handle this message, or nobody. */
async function buildRequest(db: Db, msg: Message, candidates: Role[]) {
  const from = await authorName(db, msg.authorType, msg.authorId);
  const criteria: Record<string, string> = {};
  for (const r of candidates) criteria[r.handle] = r.description ? `${r.name}: ${clip(r.description, 100)}` : r.name;
  criteria[nobodyKey(candidates)] = "no role: small talk, greetings, thanks, or people talking to each other";
  const questions: Record<string, Question> = {
    who: { type: "choice", instructions: `Which role should handle ${from}'s message?`, criteria },
  };
  return { state: `${from}: ${clip(msg.content, 2000)}`, questions };
}

/** The roles that take the message; the reason lists every option's probability. */
export function readDecision(decision: Decision, candidates: Role[]): { roles: Role[]; reason: string } {
  const answer = decision.answers.who;
  const p = answer?.probabilities ?? {};
  const top = candidates.find((r) => r.handle === answer?.choice);
  const roles = top ? candidates.filter((r) => r === top || (p[r.handle] ?? 0) >= ALSO) : [];
  const odds = [...candidates.map((r) => `@${r.handle}`), nobodyKey(candidates)].map((k) => {
    const v = p[k.replace(/^@/, "")];
    return `${k} ${typeof v === "number" ? v.toFixed(2) : "?"}`;
  });
  return { roles, reason: `${decision.model}: ${odds.join(", ")}` };
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

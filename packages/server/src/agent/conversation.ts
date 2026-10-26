/**
 * A role's main conversation in a topic (its agent session): one model context that lasts from message to
 * message, fed through an inbox.
 *
 * - enqueue(): something for the role — a message, a task's result, its own follow-up, the end of a background
 *   command (agent/commands.ts), a console instruction — goes into the session's inbox. With no open run a
 *   conversation run is created; an open run (even one in the middle of its work) takes it at its next step
 *   instead of a second run starting in parallel.
 * - inject(): before each model call the open run turns what is new in the topic (since the cursor) and the
 *   ready inbox items into one user turn of the context.
 * - settle(): a run that would end ends only when nothing is waiting; otherwise it carries on. In a conversation
 *   between two roles (agent/contacts.ts) the turn's answer goes back to the role that wrote, and in a group topic
 *   to the roles that @-mentioned it from another topic (agent/topic-messaging.ts).
 * All three lock the session row, so nothing slips between "a run is open" and "the run has ended".
 *
 * Long conversations are compacted: the model summarises its context and the summary becomes the new start
 * (contextFrom). The system prompt and tool definitions are rebuilt for every call and never compacted.
 */

import { and, count, desc, eq, gt, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  type AgentSession,
  agentSessions,
  backgroundCommands,
  type InboxItem,
  type Message,
  messages,
  type Role,
  roles,
  type Task,
  type Topic,
  taskIterations,
  taskSteps,
  tasks,
  topics,
} from "../db/schema.js";
import { cardSummaryForRoles, type StoredCard } from "../services/cards.js";
import { relayFrom, type SourceLimits, sourceLimits, withSourceLimits } from "../services/collaboration-policy.js";
import * as topicSvc from "../services/topics.js";
import { afterTaskEnd, noticeText } from "./commands.js";
import { answerContacts, lockPair, replyText, unansweredContacts } from "./contacts.js";
import { HISTORY_MESSAGES, messagePlace, rosterLine, SESSION_NOTES, triggerContext } from "./context.js";
import { ACTIVE } from "./control.js";
import { createTask, plainTitle, sessionFor } from "./dispatch.js";
import { recordTaskIteration } from "./task-continuation.js";
import { authorName } from "./tools.js";
import { answerAskers, crossTopicNote, envelopeWithRelay, settleAskers } from "./topic-messaging.js";
import { appendStep, nextSessionSeq } from "./transcript.js";

/** Shown inbox items kept so a repeated delivery (a retried event, a late dispatcher) is recognised. */
const DONE_KEPT = 50;
const FOR_YOU_LIMIT = 20_000;
const CONTEXT_LINE_LIMIT = 2_000;
const RESULT_LIMIT = 8_000;
/** A context this short is never compacted again (the summary plus what came right after it). */
const MIN_STEPS_TO_COMPACT = 4;

export async function lockSession(db: Db, id: string): Promise<AgentSession> {
  const [s] = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).for("update");
  if (!s) throw new Error(`agent session ${id} is missing`);
  return s;
}

/**
 * Lock a run and then its session. Whatever locks both takes the run first (status changes lock the run
 * and then reach the session through afterEnd), so two transactions never wait for each other in a circle.
 */
async function lockRun(db: Db, run: Task): Promise<AgentSession> {
  await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, run.id)).for("update");
  return lockSession(db, run.sessionId!);
}

const isReady = (i: InboxItem, now: number) => !i.done && (!i.due || Date.parse(i.due) <= now);
export const readyItems = (s: AgentSession, now = Date.now()) => s.inbox.filter((i) => isReady(i, now));

function pruned(items: InboxItem[]): InboxItem[] {
  const done = items.filter((i) => i.done);
  if (done.length <= DONE_KEPT) return items;
  const drop = new Set(done.slice(0, done.length - DONE_KEPT));
  return items.filter((i) => !drop.has(i));
}

/** The earliest follow-up still to come. */
function nextWake(items: InboxItem[], now = Date.now()): Date | null {
  const due = items.filter((i) => !i.done && i.due && Date.parse(i.due) > now).map((i) => Date.parse(i.due!));
  return due.length ? new Date(Math.min(...due)) : null;
}

export async function openRun(db: Db, sessionId: string): Promise<Task | undefined> {
  const [t] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.sessionId, sessionId), eq(tasks.kind, "conversation"), inArray(tasks.status, [...ACTIVE])))
    .limit(1);
  return t;
}

export interface Delivery {
  topic: Topic;
  role: Role;
  item: Omit<InboxItem, "at">;
  /** The person it is for: who asked, or on whose behalf another role asked. */
  requesterUserId: string | null;
  requesterRoleId?: string | null;
  sourceMessage?: Message | null;
  assignment?: Record<string, any>;
  round?: number;
  /** Title of the run, when this starts one. */
  title?: string;
  /** The limits of the input behind it (sourceLimits): another role's @-mention, a result, a follow-up. */
  limits?: SourceLimits | null;
}

const sameItem = (a: Omit<InboxItem, "at">, b: InboxItem) =>
  a.kind === b.kind &&
  ((!!a.message_id && a.message_id === b.message_id) ||
    (!!a.task_id && a.task_id === b.task_id && (a.revision ?? 1) === (b.revision ?? 1)) ||
    (!!a.command_id && a.command_id === b.command_id));

/** Hand something to the role's conversation in the topic. Returns the run that takes it (null: not yet). */
export async function enqueue(db: Db, d: Delivery): Promise<Task | null> {
  const session = await sessionFor(db, d.role.id, d.topic.id);
  const s = await lockSession(db, session.id);
  if (s.inbox.some((i) => sameItem(d.item, i))) return (await openRun(db, s.id)) ?? null;
  const item: InboxItem = {
    ...d.item,
    ...(d.sourceMessage?.source === "topic"
      ? { topic_delivery: relayFrom(d.sourceMessage.externalRef) ?? undefined }
      : {}),
    at: new Date().toISOString(),
    ...(d.requesterUserId ? { user_id: d.requesterUserId } : {}),
    ...(d.limits ? { limits: d.limits } : {}),
  };
  const inbox = pruned([...s.inbox, item]);
  await db
    .update(agentSessions)
    .set({ inbox, wakeAt: nextWake(inbox) })
    .where(eq(agentSessions.id, s.id));
  const open = await openRun(db, s.id);
  if (open) return open;
  // A follow-up for later: the worker starts a run when it is due (wakeDue).
  if (!isReady(item, Date.now())) return null;
  return startRun(db, s, d.topic, d.role, {
    requesterUserId: d.requesterUserId,
    requesterRoleId: d.requesterRoleId ?? null,
    sourceMessage: d.sourceMessage ?? null,
    assignment: d.assignment,
    round: d.round,
    title: d.title,
    limits: d.limits,
  });
}

interface RunStart {
  requesterUserId: string | null;
  requesterRoleId?: string | null;
  sourceMessage?: Message | null;
  assignment?: Record<string, any>;
  round?: number;
  title?: string;
  limits?: SourceLimits | null;
}

async function startRun(db: Db, s: AgentSession, topic: Topic, role: Role, o: RunStart): Promise<Task> {
  const instruction = o.sourceMessage?.content ?? o.title ?? "";
  return createTask(db, {
    topic,
    role,
    kind: "conversation",
    session: s,
    requesterUserId: o.requesterUserId,
    requesterRoleId: o.requesterRoleId ?? null,
    instruction,
    title: o.title ?? (plainTitle(instruction) || "conversation"),
    sourceMessage: o.sourceMessage ?? null,
    assignment: o.assignment,
    round: o.round,
    limits: o.limits,
  });
}

/** Follow-ups that came due: start the conversation for them unless a run is already open (worker, periodic). */
export async function wakeDue(db: Db, sessionId: string): Promise<Task | null> {
  const s = await lockSession(db, sessionId);
  const ready = readyItems(s);
  await db
    .update(agentSessions)
    .set({ wakeAt: nextWake(s.inbox) })
    .where(eq(agentSessions.id, s.id));
  if (!ready.length || (await openRun(db, s.id))) return null;
  const [role] = await db.select().from(roles).where(eq(roles.id, s.roleId)).limit(1);
  const topic = await topicSvc.getTopic(db, s.topicId);
  if (role?.status !== "active" || topic.status !== "active") return null;
  const first = ready[0];
  return startRun(db, s, topic, role, {
    requesterUserId: first.user_id ?? null,
    title:
      first.kind === "timer"
        ? `Follow-up: ${first.note ?? ""}`.slice(0, 200)
        : first.kind === "command"
          ? `Background command ${first.command_id} ended`
          : undefined,
    limits: first.limits,
  });
}

/** Whether the run should go on instead of ending: something new is waiting for it. */
export async function settle(db: Db, run: Task): Promise<boolean> {
  // In a pair topic its row comes between the run and the session (agent/contacts.ts lockPair); so it does when
  // the run may answer roles of another topic, whose sessions here it then locks.
  await lockPair(db, run);
  if (run.envelope?.topic_routes?.length) {
    await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, run.id)).for("update");
    await db.select({ id: topics.id }).from(topics).where(eq(topics.id, run.topicId)).for("update");
  }
  const s = await lockRun(db, run);
  // The turn is over: its answer goes back to the roles that wrote to it here (agent/contacts.ts), or that
  // @-mentioned it from another topic (agent/topic-messaging.ts).
  await answerContacts(db, run);
  await answerAskers(db, run);
  return readyItems(s).length > 0;
}

/** A finished run: count it on the session (what the console shows as runs and last activity). */
export async function noteRunEnd(db: Db, run: Task): Promise<void> {
  await db
    .update(agentSessions)
    .set({ runs: sql`${agentSessions.runs} + 1`, lastRunAt: new Date() })
    .where(eq(agentSessions.id, run.sessionId!));
}

/** A person stopped the conversation: what was waiting for it is dropped (follow-ups to come stay). */
export async function dropReady(db: Db, sessionId: string): Promise<void> {
  const s = await lockSession(db, sessionId);
  const now = Date.now();
  const at = new Date(now).toISOString();
  const inbox = s.inbox.map((i) => (isReady(i, now) ? { ...i, done: at } : i));
  await db
    .update(agentSessions)
    .set({ inbox: pruned(inbox) })
    .where(eq(agentSessions.id, s.id));
}

/**
 * A run or task has ended (control.setStatus). A stopped conversation drops what was waiting for it; a task
 * started or delegated by a conversation reports its outcome to it.
 */
export async function afterEnd(db: Db, task: Task): Promise<void> {
  await recordTaskIteration(db, task);
  // Background commands that ended after its last step: their notices go where its result goes.
  await afterTaskEnd(db, task);
  await lockPair(db, task);
  if (task.kind === "conversation" && task.sessionId && task.status === "cancelled")
    await dropReady(db, task.sessionId);
  // Another role's messages it did not get to answer: their senders hear so (agent/contacts.ts). @-mentions from
  // another topic it did not answer get nothing: a later turn's words are no answer to them.
  await unansweredContacts(db, task);
  await settleAskers(db, task);
  if (!task.reportSessionId) return;
  const [s] = await db.select().from(agentSessions).where(eq(agentSessions.id, task.reportSessionId)).limit(1);
  if (!s) return;
  const [role] = await db.select().from(roles).where(eq(roles.id, s.roleId)).limit(1);
  const topic = await topicSvc.getTopic(db, s.topicId).catch(() => null);
  if (role?.status !== "active" || topic?.status !== "active") return;
  await enqueue(db, {
    topic,
    role,
    item: { kind: "result", task_id: task.id, revision: task.revision },
    requesterUserId: task.requesterUserId,
    title: `Result of ${task.title}`.slice(0, 200),
    // Work on outside input reports into a run that keeps its limits.
    limits: sourceLimits(task.envelope),
  });
}

/** Forget the conversation's context; the topic keeps its messages and the next run starts from them. */
export async function resetContext(db: Db, s: AgentSession): Promise<void> {
  await db
    .update(agentSessions)
    .set({
      contextFrom: await nextSessionSeq(db, s.id),
      contextTokens: 0,
      roster: null,
      notes: [],
      awaiting: null,
    })
    .where(eq(agentSessions.id, s.id));
}

/** Steps in the conversation's current context (from its start: the beginning, a summary, a reset). */
export async function contextSize(db: Db, s: AgentSession): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(taskSteps)
    .where(
      and(
        eq(taskSteps.sessionId, s.id),
        sql`${taskSteps.sessionSeq} >= ${s.contextFrom}`,
        inArray(taskSteps.kind, ["user", "assistant", "tool"]),
      ),
    );
  return Number(row?.n ?? 0);
}

// --- what the conversation is shown --------------------------------------------------------------------

const when = (d: Date) => d.toISOString().slice(5, 16).replace("T", " ");

async function line(db: Db, m: Message, forYou: boolean, role: Role): Promise<string> {
  const limit = forYou ? FOR_YOU_LIMIT : CONTEXT_LINE_LIMIT;
  const text =
    m.content.length > limit ? `${m.content.slice(0, limit)}… [cut; topic_history shows it whole]` : m.content;
  const thread = m.replyToId ? ` (in the thread of ${m.replyToId})` : "";
  // A card reads as its Markdown, then its buttons and inputs by id (for update_card and its actions).
  const acted = m.externalRef?.card_action as { card: string; action: string } | undefined;
  const card = m.card
    ? ` ${cardSummaryForRoles(m.card as StoredCard)}`
    : acted
      ? ` [on card ${acted.card}: button ${acted.action}]`
      : "";
  return `[${m.id} ${when(m.createdAt)}] ${await authorName(db, m.authorType, m.authorId)}${forYou ? " → you" : ""}${thread}: ${text}${card}${triggerContext(m)}${await crossTopicNote(db, m, role.id)}`;
}

/**
 * Topic messages after the cursor, except the conversation's own posts (already in its context as its
 * answers). A new or reset context sees the latest messages, its own earlier posts included.
 */
function freshConditions(s: AgentSession, role: Role, since: Date | null, fresh: boolean): SQL[] {
  const conds: SQL[] = [eq(messages.topicId, s.topicId), isNull(messages.deletedAt)];
  if (since) conds.push(gt(messages.createdAt, since));
  if (!fresh)
    conds.push(sql`not (${messages.authorType} = 'role' and ${messages.authorId} = ${role.id} and ${messages.taskId} in (
    select ${tasks.id} from ${tasks} where ${tasks.sessionId} = ${s.id} and ${tasks.kind} = 'conversation'))`);
  return conds;
}

async function resultText(
  db: Db,
  item: InboxItem,
  role: Role,
  topicId: string,
): Promise<{ text: string; round: number }> {
  const [t] = item.task_id ? await db.select().from(tasks).where(eq(tasks.id, item.task_id)).limit(1) : [];
  if (!t) return { text: `A task you started (${item.task_id}) no longer exists.`, round: 0 };
  const [owner] = await db.select().from(roles).where(eq(roles.id, t.ownerRoleId)).limit(1);
  const whose = t.ownerRoleId === role.id ? "Your task" : `@${owner?.handle ?? "?"}'s task`;
  const [iteration] = await db
    .select()
    .from(taskIterations)
    .where(and(eq(taskIterations.taskId, t.id), eq(taskIterations.revision, item.revision ?? 1)))
    .limit(1);
  const delivered = iteration ?? t;
  const outcome =
    delivered.status === "completed"
      ? (delivered.result ?? "").slice(0, RESULT_LIMIT) || "(no result)"
      : `${delivered.status}: ${delivered.error ?? t.statusReason ?? ""}`;
  const where = t.topicId === topicId ? "this topic" : `topic ${t.topicId}`;
  const posted = t.envelope?.report_only ? "" : ` (its answer was also posted in ${where})`;
  return {
    text: `${whose} ${t.id} «${t.title}» iteration ${item.revision ?? 1} ended${posted}:\n${outcome}`,
    round: t.round,
  };
}

/** A background command ended (agent/commands.ts): started here, or by a task of this conversation that ended. */
async function commandText(db: Db, item: InboxItem, run: Task): Promise<string> {
  const [c] = item.command_id
    ? await db.select().from(backgroundCommands).where(eq(backgroundCommands.id, item.command_id)).limit(1)
    : [];
  if (!c) return `A background command you started (${item.command_id}) is no longer recorded.`;
  if (c.taskId === run.id) return noticeText(c);
  const [starter] = await db.select().from(tasks).where(eq(tasks.id, c.taskId)).limit(1);
  const note =
    starter && starter.kind === "task"
      ? `It was started by task ${starter.id} «${starter.title}», which has ended (${starter.status}).`
      : "";
  return noticeText(c, note);
}

/**
 * Before a model call: show the conversation what is new — topic messages since it last looked (those for it
 * marked "→ you"), results of its tasks, follow-ups that came due, console instructions — as one user turn.
 * Returns false when nothing was waiting.
 */
export async function inject(db: Db, run: Task, topic: Topic, role: Role): Promise<boolean> {
  const s = await lockRun(db, run);
  const now = new Date();
  const ready = readyItems(s, now.getTime());
  if (!ready.length) return false;
  const fresh = (await contextSize(db, s)) === 0;
  // A new (or reset) context starts from the latest messages of the topic; later turns from the cursor on.
  const conds = freshConditions(s, role, fresh ? null : s.cursorAt, fresh);
  const [{ n: total }] = await db
    .select({ n: count() })
    .from(messages)
    .where(and(...conds));
  const shown = (
    await db
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_MESSAGES)
  ).reverse();
  const forYouItems = ready.filter((i) => i.kind === "message" && i.message_id);
  const forYouIds = new Set(forYouItems.map((i) => i.message_id!));
  const forYou = forYouIds.size
    ? await db
        .select()
        .from(messages)
        .where(and(inArray(messages.id, [...forYouIds]), isNull(messages.deletedAt)))
    : [];
  const parts: string[] = [];

  if (fresh && s.notes.length) {
    const notes = s.notes.slice(-SESSION_NOTES);
    parts.push(
      `Your earlier work in this topic:\n${notes.map((n) => `- [${n.at.slice(0, 16)}] asked: ${n.request}\n  you answered: ${n.result}`).join("\n")}`,
    );
  }
  const [previous] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.sessionId, s.id), eq(tasks.kind, "conversation"), sql`${tasks.id} <> ${run.id}`))
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  const runStarting = run.usage?.steps === undefined || run.usage?.steps === 0;
  if (runStarting && previous && ["failed", "cancelled"].includes(previous.status) && !fresh)
    parts.push(
      `(Your previous turn ended early — ${previous.status}: ${previous.statusReason ?? previous.error ?? ""}.)`,
    );
  const roster = await rosterLine(db, topic, role);
  if (roster !== s.roster) parts.push(roster);

  const lines: string[] = [];
  for (const m of shown) lines.push(await line(db, m, forYouIds.has(m.id), role));
  // Messages for the role that it saw before as context (a dispatcher decided later): point at them again.
  const shownIds = new Set(shown.map((m) => m.id));
  const earlier = forYou.filter((m) => !shownIds.has(m.id));
  for (const m of earlier) lines.push(await line(db, m, true, role));
  if (lines.length) {
    const more = Number(total) - shown.length;
    const head = fresh
      ? `Messages in this topic (the latest ${shown.length}, oldest first${more > 0 ? `; ${more} earlier ones: use topic_history` : ""}):`
      : `New in this topic since you last looked${more > 0 ? ` (the latest ${shown.length}; ${more} more before them: use topic_history)` : ""}:`;
    parts.push(`${head}\n${lines.join("\n")}`);
  }
  // Where messages for the role came from, when not the console, and threads it may not have seen.
  const notes: string[] = [];
  for (const m of forYou) {
    const place = await messagePlace(db, topic, m);
    if (place !== "this topic, in the witden console") notes.push(`${m.id} was posted in ${place}.`);
    if (m.replyToId && !shownIds.has(m.replyToId))
      notes.push(`${m.id} replies in the thread of ${m.replyToId}: topic_history with thread=${m.replyToId} reads it.`);
  }
  if (notes.length) parts.push(notes.join("\n"));

  // Results of work handed out count as automatic rounds (a person's message starts again at 0).
  let resultRound = 0;
  for (const item of ready) {
    if (item.kind === "result") {
      const r = await resultText(db, item, role, topic.id);
      parts.push(r.text);
      resultRound = Math.max(resultRound, r.round);
    } else if (item.kind === "timer") {
      parts.push(`Follow-up you scheduled (${item.at.slice(5, 16).replace("T", " ")}): ${item.note ?? ""}`);
      resultRound = Math.max(resultRound, item.round ?? 0);
    } else if (item.kind === "instruction") {
      parts.push(`Instruction from ${item.by ?? "a person"} in the console: ${item.note ?? ""}`);
    } else if (item.kind === "reply") {
      // Another role answered what this role wrote to it (agent/contacts.ts): an automatic round, like a result.
      parts.push(await replyText(db, item, topic.id));
      resultRound = Math.max(resultRound, item.round ?? 0);
    } else if (item.kind === "command") {
      parts.push(await commandText(db, item, run));
      resultRound = Math.max(resultRound, item.round ?? 0);
    }
  }
  const explicit = forYouItems.some((i) => !i.auto);
  if (forYouItems.length && !explicit)
    parts.push(
      "(Nobody @-mentioned you in these messages: they reached you because the topic answers automatically. Reply only if they need you; if it is small talk, addressed to someone else, not your responsibility or already handled, call stay_silent.)",
    );
  parts.push(`Now: ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`);
  await appendStep(db, run, "user", {
    content: parts.join("\n\n"),
    inbox: {
      explicit,
      messages: [...forYouIds],
      items: ready.length,
      ...(ready.some((i) => i.kind === "command")
        ? { commands: ready.filter((i) => i.kind === "command").map((i) => i.command_id) }
        : {}),
    },
  });

  // The latest message for the role decides who is asking and where answers go.
  const latest = [...forYou].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).pop();
  const latestItem = latest ? forYouItems.find((i) => i.message_id === latest.id) : undefined;
  const replyTo = [...ready].reverse().find((i) => i.reply_to)?.reply_to;
  const update: Partial<Task> = {
    // The token budget counts per turn: each batch of new messages starts a fresh count.
    usage: { ...(run.usage ?? {}), turn_tokens: 0 },
  };
  let restrictedEnvelope = run.envelope;
  for (const message of forYou)
    restrictedEnvelope = envelopeWithRelay(
      restrictedEnvelope,
      message.source === "topic" ? relayFrom(message.externalRef) : null,
      ["webhook", "schedule"].includes(message.source),
    );
  // What came from work on outside input (an @-mention, a result, a follow-up) keeps those limits here too.
  for (const item of ready) restrictedEnvelope = withSourceLimits(restrictedEnvelope, item.limits);
  update.envelope = restrictedEnvelope;
  if (latest) {
    update.sourceMessageId = latest.id;
    update.round = latest.round;
    if (latest.authorType === "user") {
      update.requesterUserId = latest.authorId;
      update.requesterRoleId = null;
    } else if (latest.authorType === "role") {
      update.requesterRoleId = latest.authorId;
      if (latestItem?.user_id) update.requesterUserId = latestItem.user_id;
    }
  } else {
    if (replyTo) update.sourceMessageId = replyTo;
    if (resultRound > run.round) update.round = resultRound;
  }
  await db.update(tasks).set(update).where(eq(tasks.id, run.id));

  const seen = shown.length ? shown[shown.length - 1].createdAt : null;
  const cursorAt = seen && (!s.cursorAt || seen > s.cursorAt) ? seen : s.cursorAt;
  const at = now.toISOString();
  const readySet = new Set(ready);
  const inbox = pruned(s.inbox.map((i) => (readySet.has(i) ? { ...i, done: at } : i)));
  await db
    .update(agentSessions)
    .set({ inbox, cursorAt, roster, wakeAt: nextWake(inbox) })
    .where(eq(agentSessions.id, s.id));
  return true;
}

/** Whether the latest batch shown to the run had a message that @-mentioned the role (then it must answer). */
export async function lastBatchExplicit(db: Db, run: Task): Promise<boolean> {
  const [step] = await db
    .select()
    .from(taskSteps)
    .where(and(eq(taskSteps.taskId, run.id), eq(taskSteps.kind, "user")))
    .orderBy(desc(taskSteps.seq))
    .limit(1);
  return !!step?.payload?.inbox?.explicit;
}

// --- people the role asked ------------------------------------------------------------------------------

/** The role asked these people something in this topic: their next message here goes to it, @ or not. */
export async function awaitAnswer(db: Db, run: Task, userIds: string[]): Promise<void> {
  if (!userIds.length || !run.sessionId) return;
  const s = await lockRun(db, run);
  const ids = [...new Set([...(s.awaiting?.user_ids ?? []), ...userIds])];
  await db
    .update(agentSessions)
    .set({ awaiting: { user_ids: ids, at: new Date().toISOString() } })
    .where(eq(agentSessions.id, s.id));
}

/** Roles in this topic waiting for this person's answer; their wait ends with this message. */
export async function rolesAwaiting(db: Db, topic: Topic, userId: string): Promise<string[]> {
  const out: string[] = [];
  for (const s of await db.select().from(agentSessions).where(eq(agentSessions.topicId, topic.id))) {
    const ids = s.awaiting?.user_ids ?? [];
    if (!ids.includes(userId)) continue;
    out.push(s.roleId);
    const rest = ids.filter((id) => id !== userId);
    await db
      .update(agentSessions)
      .set({ awaiting: rest.length ? { user_ids: rest, at: s.awaiting!.at } : null })
      .where(eq(agentSessions.id, s.id));
  }
  return out;
}

// --- compaction -----------------------------------------------------------------------------------------

export const COMPACT_PROMPT = `Your conversation in this topic has grown long. Its earlier part is about to be replaced by a summary that you write now; you will continue from that summary, so write it for yourself. Do not call any tools.

Keep:
- who is in this topic, who asked you what (with message ids), what you answered, and what is still open: unanswered requests, questions you asked and are waiting for, promises and follow-ups;
- the work in progress: its goal, what is done, what remains and the exact next step; decisions and why;
- facts you will need again: file paths, commands, URLs, ids of messages, threads and tasks, errors and how they were solved, important tool results;
- what people told you to do or not to do; each active task ID, its revision, original requester, source topic/message/thread IDs, and any promise to send a result there. Never merge origins of different tasks.
Leave out small talk and finished details that will not matter again. Your system prompt and the tool descriptions stay as they are: do not repeat them. Write plain text, at most about 1500 words.`;

export const SUMMARY_HEADER =
  "Summary of this conversation so far (its earlier part was compacted; the topic keeps every message — use topic_history to read them):";

/** Whether the conversation's context has reached its model's compaction threshold. */
export async function needsCompaction(db: Db, run: Task, compactAt: number): Promise<boolean> {
  if (!run.sessionId) return false;
  const [s] = await db.select().from(agentSessions).where(eq(agentSessions.id, run.sessionId)).limit(1);
  if (!s || s.contextTokens < compactAt) return false;
  return (await contextSize(db, s)) >= MIN_STEPS_TO_COMPACT;
}

/**
 * The summary becomes the start of the context; earlier steps stay in the runs' logs. ``tail``: the latest
 * messages, already shown but not summarised, follow it word for word.
 */
export async function saveSummary(db: Db, run: Task, summary: string, tail: string | null = null): Promise<void> {
  const s = await lockRun(db, run);
  const from = await nextSessionSeq(db, s.id);
  await appendStep(db, run, "user", { content: `${SUMMARY_HEADER}\n\n${summary}`, summary: true });
  if (tail) await appendStep(db, run, "user", { content: tail, repeated: true });
  await db
    .update(agentSessions)
    .set({
      contextFrom: from,
      // Until the next call measures it: roughly four characters a token.
      contextTokens: Math.ceil(summary.length / 4),
      compactions: s.compactions + 1,
    })
    .where(eq(agentSessions.id, s.id));
}

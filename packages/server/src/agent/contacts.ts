/**
 * Direct conversations between two AI employees (roles), outside any other topic.
 *
 * A role may start one only with the roles a person listed for it (``roles.allowed_contacts``: "A may contact B",
 * one direction). contact_role posts the message in the two roles' pair topic (kind "pair": exactly these two roles
 * and no people; console accounts can read it) and queues it into the receiver's conversation there, together with
 * where it came from (ContactRoute, kept by the server and never shown to the receiver). The receiver works with its
 * own permissions plus the limits of the sender's input. The answer it ends its turn with is posted there as well
 * and goes back to whatever sent the message: the sender's conversation in its topic, or the sender's independent
 * task as a new input; when that no longer runs, the sender's conversation in the pair topic. Answering needs no
 * permission, writing first does; every hop counts as an automatic round. Neither side reads the other's topics or
 * records: only the messages travel.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  agentSessions,
  type InboxItem,
  messages,
  type Role,
  roles,
  type Task,
  taskInputs,
  tasks,
  topics,
} from "../db/schema.js";
import { BadRequest, Forbidden } from "../errors.js";
import { audit } from "../services/audit.js";
import {
  assertNextRound,
  type ContactRoute,
  type SourceLimits,
  sourceLimits,
  withSourceLimits,
} from "../services/collaboration-policy.js";
import { wake } from "../services/events.js";
import * as topicSvc from "../services/topics.js";
import { ACTIVE } from "./control.js";
import { enqueue, lockSession } from "./conversation.js";
import { authorize, saveMessage } from "./dispatch.js";

const MESSAGE_LIMIT = 20_000;
const REPLY_LIMIT = 8_000;

/** What the sender's input brings along; the linked requests it answers stay with the sender's work. */
export function contactLimits(envelope: Record<string, any> | null | undefined): SourceLimits | null {
  const limits = sourceLimits(envelope);
  if (!limits) return null;
  const { topic_routes: _routes, ...rest } = limits;
  return Object.keys(rest).length ? rest : null;
}

/** The roles this role may write to first, by handle. */
export async function allowedContacts(db: Db, role: Role): Promise<Role[]> {
  if (role.systemAdmin || !role.allowedContacts.length) return [];
  const rows = await db.select().from(roles).where(inArray(roles.id, role.allowedContacts));
  return rows.filter((r) => r.id !== role.id && !r.systemAdmin).sort((a, b) => a.handle.localeCompare(b.handle));
}

export const contactLine = (r: Role) =>
  `@${r.handle} (${r.name}${r.description ? `: ${r.description.slice(0, 160)}` : ""})${r.status === "active" ? "" : " — disabled now"}`;

/** contact_role: a message to another role in their direct conversation; its answer comes back to this work. */
export async function contactRole(
  db: Db,
  task: Task,
  sender: Role,
  handle: string,
  text: string,
  callId: string,
): Promise<{ messageId: string; topicId: string; status: "sent" | "already_sent" }> {
  // A repeated call (a retry after an interruption) does not write twice.
  const key = `contact:${task.id}:${callId}`;
  const [sent] = await db.select().from(messages).where(sql`${messages.externalRef}->>'contact_key' = ${key}`).limit(1);
  if (sent) return { messageId: sent.id, topicId: sent.topicId, status: "already_sent" };
  if (task.status !== "running") throw new Forbidden("only running work may write to another AI employee");
  if (sender.systemAdmin || task.envelope?.system_admin)
    throw new Forbidden("the system administrator does not talk to other AI employees directly");
  if (task.envelope?.external_topic)
    throw new Forbidden(
      "only the role handling a Slack, Feishu or GitHub conversation works there; write to other AI employees from a console topic",
    );
  const allowed = await allowedContacts(db, sender);
  const list = allowed.length
    ? `you may write to ${allowed.map((r) => `@${r.handle}`).join(", ")}`
    : "no AI employee is on your list";
  const name = handle.trim().replace(/^@/, "").toLowerCase();
  const [target] = name ? await db.select().from(roles).where(eq(roles.handle, name)).limit(1) : [];
  if (!target) throw new BadRequest(`there is no AI employee @${name}; ${list}`);
  if (target.id === sender.id) throw new BadRequest("that is you");
  if (!allowed.some((r) => r.id === target.id))
    throw new Forbidden(
      `you may not start a conversation with @${target.handle}: a person decides whom you may write to in your role settings; ${list}`,
    );
  if (target.status !== "active") throw new Forbidden(`@${target.handle} is disabled`);
  const body = text.trim();
  if (!body || body.length > MESSAGE_LIMIT)
    throw new BadRequest(`the message must contain 1..${MESSAGE_LIMIT} characters`);
  if (!task.requesterUserId) throw new Forbidden("this work has no requester on whose behalf to write");
  let round: number;
  try {
    round = assertNextRound(task.round, settings().maxAutoRounds);
  } catch (err) {
    throw new Forbidden((err as Error).message);
  }
  const topic = await topicSvc.getOrCreatePairTopic(db, sender, target);
  // The pair's row before the receiver's session (lockPair).
  await db.select({ id: topics.id }).from(topics).where(eq(topics.id, topic.id)).for("update");
  // The receiver must be able to work: enabled, a usable model, a computer (an @-mention's checks).
  const { allowed: ok, refusals } = await authorize(db, topic, task.requesterUserId, [target.id], sender.id);
  if (!ok.length) throw new Forbidden(`@${target.handle} cannot take it now: ${[...new Set(refusals)].join("; ")}`);
  const msg = await saveMessage(db, topic, "role", sender.id, body, {
    mentions: [],
    round,
    taskId: task.id,
    externalRef: { contact_key: key },
    mirror: false,
  });
  const route: ContactRoute = {
    from_role_id: sender.id,
    message_id: msg.id,
    task_id: task.id,
    topic_id: task.topicId,
    session_id: task.kind === "conversation" ? task.sessionId : null,
    user_id: task.requesterUserId,
  };
  await enqueue(db, {
    topic,
    role: target,
    item: { kind: "message", message_id: msg.id, contact: route },
    requesterUserId: task.requesterUserId,
    requesterRoleId: sender.id,
    sourceMessage: msg,
    assignment: ok[0][1],
    round,
    limits: contactLimits(task.envelope),
  });
  await audit(db, "message.contact", {
    actorType: "role",
    actorId: sender.id,
    roleId: sender.id,
    taskId: task.id,
    topicId: task.topicId,
    resourceType: "message",
    resourceId: msg.id,
    detail: { to_role_id: target.id, pair_topic_id: topic.id },
  });
  return { messageId: msg.id, topicId: topic.id, status: "sent" };
}

/**
 * Lock order wherever the sessions of a pair topic are locked: the run, then the pair topic's row, then sessions.
 * Both roles of a pair may end a turn at the same moment, each answering a message of the other: each transaction
 * holds its own session (settle) and then needs the other's (sendBack), which would deadlock. With the topic row
 * taken first they wait for one another instead. Posting there already takes it first (saveMessage updates the
 * row), and so does contactRole before it queues the message.
 */
export async function lockPair(db: Db, run: Task): Promise<void> {
  if (!run.envelope?.pair_topic) return;
  await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, run.id)).for("update");
  await db.select({ id: topics.id }).from(topics).where(eq(topics.id, run.topicId)).for("update");
}

/** A message from another role the run was shown and has not answered yet. */
const owed = (i: InboxItem) => i.kind === "message" && !!i.contact && !!i.done && !i.answered;

async function settleOwed(db: Db, run: Task): Promise<InboxItem[]> {
  if (run.kind !== "conversation" || !run.sessionId || !run.envelope?.pair_topic) return [];
  await lockPair(db, run);
  const s = await lockSession(db, run.sessionId);
  const items = s.inbox.filter(owed);
  if (!items.length) return [];
  const at = new Date().toISOString();
  await db
    .update(agentSessions)
    .set({ inbox: s.inbox.map((i) => (owed(i) ? { ...i, answered: at } : i)) })
    .where(eq(agentSessions.id, s.id));
  return items;
}

/**
 * A run in a pair topic ended its turn (settle): its answer goes back to every message it was shown since its last
 * answer. The answer is what the turn posted last: its final answer, or what it said with send_message.
 */
export async function answerContacts(db: Db, run: Task): Promise<void> {
  const items = await settleOwed(db, run);
  if (!items.length) return;
  const since = new Date(Math.min(...items.map((i) => Date.parse(i.done!))));
  const [posted] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.taskId, run.id), eq(messages.authorType, "role"), gte(messages.createdAt, since)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  for (const item of items)
    await sendBack(db, run, item.contact!, {
      messageId: posted?.id ?? null,
      note: "nothing was posted",
      round: posted?.round ?? run.round + 1,
    });
}

/** The run ended without answering what it was shown (failed, stopped, cleared): the senders hear so. */
export async function unansweredContacts(db: Db, run: Task): Promise<void> {
  const items = await settleOwed(db, run);
  if (!items.length) return;
  const [role] = await db.select().from(roles).where(eq(roles.id, run.ownerRoleId)).limit(1);
  const why = run.status === "completed" ? "it ended without an answer" : `${run.status}: ${run.statusReason ?? ""}`;
  for (const item of items)
    await sendBack(db, run, item.contact!, {
      messageId: null,
      note: `@${role?.handle ?? "?"} did not answer (${why.trim()})`,
      round: run.round + 1,
    });
}

interface Reply {
  /** The answer as posted in the pair topic, or a note when there is none. */
  messageId: string | null;
  note?: string;
  round: number;
}

/** Back to the work that wrote: its conversation, its task while it runs, or else its conversation in the pair. */
async function sendBack(db: Db, run: Task, route: ContactRoute, reply: Reply): Promise<void> {
  const [sender] = await db.select().from(roles).where(eq(roles.id, route.from_role_id)).limit(1);
  if (sender?.status !== "active") return;
  const limits = contactLimits(run.envelope);
  const item: Omit<InboxItem, "at"> = {
    kind: "reply",
    contact: route,
    round: reply.round,
    ...(reply.messageId ? { message_id: reply.messageId } : { note: reply.note }),
  };
  const [answerer] = await db.select().from(roles).where(eq(roles.id, run.ownerRoleId)).limit(1);
  const title = `Reply from @${answerer?.handle ?? "?"}`;
  if (!route.session_id) {
    // An independent task reads it as a new input between its steps (as a person's follow-up), while it runs.
    const [work] = await db.select().from(tasks).where(eq(tasks.id, route.task_id)).for("update");
    if (work && work.kind === "task" && ACTIVE.has(work.status) && work.ownerRoleId === sender.id) {
      await db
        .insert(taskInputs)
        .values({
          id: newId("tin"),
          taskId: work.id,
          revision: work.revision,
          content: await replyText(db, { ...item, at: "" }, null),
          requesterUserId: work.requesterUserId,
          idempotencyKey: `contact-reply:${route.message_id}:${reply.messageId ?? run.id}`,
        })
        .onConflictDoNothing();
      await db
        .update(tasks)
        .set({ envelope: withSourceLimits(work.envelope, limits), round: Math.max(work.round, reply.round) })
        .where(eq(tasks.id, work.id));
      await wake(db, "tasks");
      return;
    }
  } else {
    const [s] = await db.select().from(agentSessions).where(eq(agentSessions.id, route.session_id)).limit(1);
    const topic = s ? await topicSvc.getTopic(db, s.topicId).catch(() => null) : null;
    if (
      s?.roleId === sender.id &&
      topic?.status === "active" &&
      (await topicSvc.participant(db, topic.id, "role", sender.id))
    ) {
      await enqueue(db, {
        topic,
        role: sender,
        item,
        requesterUserId: route.user_id,
        title,
        limits,
        round: reply.round,
      });
      return;
    }
  }
  // Nothing that wrote is there any more: the sender's own conversation in the pair topic gets it.
  const pair = await topicSvc.getTopic(db, run.topicId);
  if (pair.status === "active")
    await enqueue(db, {
      topic: pair,
      role: sender,
      item,
      requesterUserId: route.user_id,
      title,
      limits,
      round: reply.round,
    });
}

/** How a reply reads where it arrives (``here``: the topic of the conversation it reaches, if one). */
export async function replyText(db: Db, item: InboxItem, here: string | null): Promise<string> {
  const route = item.contact;
  const [asked] = route ? await db.select().from(messages).where(eq(messages.id, route.message_id)).limit(1) : [];
  const mine = route
    ? `your message ${route.message_id}${asked && !asked.deletedAt ? ` «${asked.content.slice(0, 80).replace(/\s+/g, " ")}»` : ""}`
    : "your message";
  const yours = ` to ${mine}`;
  if (!item.message_id) return `No reply${yours}: ${item.note ?? "none came"}.`;
  const [m] = await db.select().from(messages).where(eq(messages.id, item.message_id)).limit(1);
  const [author] = m?.authorId ? await db.select().from(roles).where(eq(roles.id, m.authorId)).limit(1) : [];
  const who = `@${author?.handle ?? "?"}`;
  if (!m || m.deletedAt) return `${who}'s reply${yours} was deleted.`;
  if (m.topicId === here) {
    // In their direct conversation itself: the reply is among the messages shown.
    const ended = route && route.topic_id !== here ? ", which you sent from work of yours that has ended" : "";
    return `${who}'s reply ${m.id} above answers ${mine}${ended}. Nothing more is needed; contact_role writes to ${who} again if you must.`;
  }
  const content = m.content.length > REPLY_LIMIT ? `${m.content.slice(0, REPLY_LIMIT)}… [cut]` : m.content;
  return `Reply from ${who} in your direct conversation with them${yours}:\n${content}`;
}

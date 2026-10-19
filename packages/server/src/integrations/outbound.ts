/** Mirror internal messages into linked external threads, exactly once per destination. */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  connections,
  externalConversations,
  externalThreadLinks,
  type Message,
  messages,
  outboundMessages,
  tasks,
} from "../db/schema.js";
import { wake } from "../services/events.js";
import { CHANNEL } from "./base.js";

/**
 * Where a message goes in a channel topic: into the thread it replies to, or into the thread of the message
 * its task answers; otherwise straight into the channel. So a role answers where it was asked.
 */
async function answerThread(
  db: Db,
  msg: Pick<Message, "replyToId" | "taskId">,
  conversation: string,
): Promise<string | null> {
  const ref = (m: Message | undefined) =>
    m?.externalRef?.conversation === conversation ? (m.externalRef as { ts?: string; thread?: string }) : null;
  if (msg.replyToId) {
    const [root] = await db.select().from(messages).where(eq(messages.id, msg.replyToId)).limit(1);
    const r = ref(root);
    if (r?.thread) return r.thread;
  }
  if (msg.taskId) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, msg.taskId)).limit(1);
    const [source] = task?.sourceMessageId
      ? await db.select().from(messages).where(eq(messages.id, task.sourceMessageId)).limit(1)
      : [];
    const r = ref(source);
    if (r?.thread && r.thread !== r.ts) return r.thread;
  }
  return null;
}

/** The thread a message goes into in a linked conversation (null: the conversation itself, or a DM). */
export async function threadIn(
  db: Db,
  link: { threadKey: string },
  conversation: string,
  msg: Pick<Message, "replyToId" | "taskId">,
): Promise<string | null> {
  if (link.threadKey === "__dm__") return null;
  return link.threadKey === CHANNEL ? answerThread(db, msg, conversation) : link.threadKey;
}

export async function mirrorMessage(db: Db, msg: Message): Promise<number> {
  const links = await db.select().from(externalThreadLinks).where(eq(externalThreadLinks.topicId, msg.topicId));
  let queued = 0;
  for (const link of links) {
    const [conn] = await db.select().from(connections).where(eq(connections.id, link.connectionId)).limit(1);
    const [conv] = await db
      .select()
      .from(externalConversations)
      .where(eq(externalConversations.id, link.conversationId))
      .limit(1);
    if (!conn || !conv) continue;
    // Messages that came in from this same conversation are not echoed back.
    if (msg.source === conn.platform && msg.externalRef?.conversation === conv.externalId) continue;
    const key = `${msg.id}:${link.id}`;
    const [existing] = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(eq(outboundMessages.idempotencyKey, key))
      .limit(1);
    if (existing) continue;
    const active = conn.status === "active";
    const threadKey = await threadIn(db, link, conv.externalId, msg);
    await db.insert(outboundMessages).values({
      id: newId("out"),
      connectionId: conn.id,
      conversationExternalId: conv.externalId,
      threadKey,
      messageId: msg.id,
      idempotencyKey: key,
      payload: { author_type: msg.authorType, author_id: msg.authorId },
      status: active ? "pending" : "blocked",
      lastError: active ? null : `connection is ${conn.status}`,
    });
    if (active) queued++;
  }
  if (queued) await wake(db, "outbound");
  return queued;
}

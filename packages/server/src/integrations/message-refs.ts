/** Platform references for messages produced by Witden, whose origin metadata must not be overwritten. */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type Message, messages, outboundMessages } from "../db/schema.js";

export async function sentMessageRoot(
  db: Db,
  topicId: string,
  connectionId: string,
  conversationId: string,
  externalId: string,
) {
  const rows = await db
    .select({ id: messages.id })
    .from(outboundMessages)
    .innerJoin(messages, eq(messages.id, outboundMessages.messageId))
    .where(
      and(
        eq(messages.topicId, topicId),
        isNull(messages.deletedAt),
        eq(outboundMessages.connectionId, connectionId),
        eq(outboundMessages.conversationExternalId, conversationId),
        eq(outboundMessages.externalTs, externalId),
        eq(outboundMessages.status, "sent"),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function sentThread(db: Db, msg: Message | undefined, conversationId: string, connectionId?: string) {
  if (!msg) return null;
  const rows = await db
    .select({ thread: outboundMessages.threadKey, ts: outboundMessages.externalTs })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.messageId, msg.id),
        eq(outboundMessages.conversationExternalId, conversationId),
        eq(outboundMessages.status, "sent"),
        connectionId ? eq(outboundMessages.connectionId, connectionId) : undefined,
      ),
    )
    .limit(2);
  if (rows.length !== 1) return null; // Never guess across two connections that happen to use the same conversation ID.
  return rows[0].thread ?? rows[0].ts;
}

/** Mirror internal messages into linked external threads, exactly once per destination. */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  connections,
  externalConversations,
  externalThreadLinks,
  type Message,
  outboundMessages,
} from "../db/schema.js";
import { wake } from "../services/events.js";

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
    await db.insert(outboundMessages).values({
      id: newId("out"),
      connectionId: conn.id,
      conversationExternalId: conv.externalId,
      threadKey: link.threadKey === "__dm__" ? null : link.threadKey,
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

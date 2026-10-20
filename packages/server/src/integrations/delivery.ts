/** Delivers queued outbound messages through the platform adapters, with bounded retries. */

import { and, asc, eq, lt } from "drizzle-orm";
import { db as getDb } from "../db/client.js";
import { connections, messages, outboundMessages, topics } from "../db/schema.js";
import { relayFrom } from "../services/collaboration-policy.js";
import { findTopicLink } from "../services/topic-links.js";
import { getAdapter } from "./base.js";

const MAX_ATTEMPTS = 5;
let running = false;

export async function deliverPending(limit = 50): Promise<number> {
  if (running) return 0; // one sender at a time per process; idempotency keys protect across processes
  running = true;
  try {
    const rows = await getDb()
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(and(eq(outboundMessages.status, "pending"), lt(outboundMessages.attempts, MAX_ATTEMPTS)))
      .orderBy(asc(outboundMessages.createdAt))
      .limit(limit);
    let sent = 0;
    for (const { id } of rows) if (await deliverOne(id)) sent++;
    return sent;
  } finally {
    running = false;
  }
}

export async function deliverOne(id: string): Promise<boolean> {
  const db = getDb();
  // Claim the record first so two senders never post the same message twice.
  const [out] = await db
    .update(outboundMessages)
    .set({ status: "sending" })
    .where(and(eq(outboundMessages.id, id), eq(outboundMessages.status, "pending")))
    .returning();
  if (!out) return false;
  const [conn] = await db.select().from(connections).where(eq(connections.id, out.connectionId)).limit(1);
  const [msg] = out.messageId ? await db.select().from(messages).where(eq(messages.id, out.messageId)).limit(1) : [];
  const update = (fields: Partial<typeof out>) =>
    db.update(outboundMessages).set(fields).where(eq(outboundMessages.id, id));
  if (conn?.status !== "active") {
    await update({ status: "blocked", lastError: "connection paused or removed" });
    return false;
  }
  if (!msg || msg.deletedAt) {
    await update({ status: "failed", lastError: "message no longer exists" });
    return false;
  }
  if (msg.source === "topic") {
    const relay = relayFrom(msg.externalRef);
    const link = relay ? await findTopicLink(db, relay.source_topic_id, msg.topicId) : null;
    const [source] = relay ? await db.select().from(topics).where(eq(topics.id, relay.source_topic_id)) : [];
    const [target] = await db.select().from(topics).where(eq(topics.id, msg.topicId));
    if (!relay || !link || link.id !== relay.link_id || source?.status !== "active" || target?.status !== "active") {
      await update({ status: "blocked", lastError: "topic link removed or a topic archived before publication" });
      return false;
    }
  }
  const attempts = out.attempts + 1;
  try {
    const externalTs = await (await getAdapter(conn)).send(db, conn, out, msg);
    await update({ status: "sent", attempts, externalTs, lastError: null });
    return true;
  } catch (err) {
    // recorded and visible; retried up to MAX_ATTEMPTS
    await update({
      status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      attempts,
      lastError: String((err as Error).message).slice(0, 1000),
    });
    return false;
  }
}

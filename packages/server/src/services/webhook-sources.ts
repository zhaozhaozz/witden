/** Shared inbound sources. Acceptance, receipt dedupe and per-rule deliveries commit atomically. */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { type Db, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  type TriggerEvent,
  type TriggerRequest,
  topicTriggers,
  triggerEvents,
  webhookReceipts,
  webhookSources,
} from "../db/schema.js";
import { BadRequest, NotFound } from "../errors.js";
import { redactWebhookHeaders } from "./collaboration-policy.js";
import { publish } from "./events.js";
import { verifyTriggerToken } from "./triggers.js";

/**
 * A shared source's receipts hold the raw requests and their dedupe keys. Once no topic's history refers to
 * one (history cleared, topic cleaned up), it goes too: the raw body is erased and the same key is processed
 * again if it comes back.
 */
export async function pruneWebhookReceipts(db: Db): Promise<void> {
  await db
    .delete(webhookReceipts)
    .where(
      sql`not exists (select 1 from ${triggerEvents} where ${triggerEvents.webhookReceiptId} = ${webhookReceipts.id})`,
    );
}

export async function webhookSource(db: Db, id: string) {
  const [source] = await db.select().from(webhookSources).where(eq(webhookSources.id, id));
  if (!source || source.deletedAt) throw new NotFound("webhook source not found");
  return source;
}

export async function acceptSourceWebhook(id: string, token: string, request: TriggerRequest, eventKey: string | null) {
  return transaction(async (db) => {
    const [source] = await db.select().from(webhookSources).where(eq(webhookSources.id, id)).for("update");
    verifyTriggerToken(source?.deletedAt ? undefined : source, token);
    if (!source.enabled) throw new BadRequest("webhook source is disabled");
    if (eventKey && eventKey.length > 200) throw new BadRequest("Idempotency-Key must be at most 200 characters");
    const clean = { ...request, headers: redactWebhookHeaders(request.headers) };
    const [receipt] = await db
      .insert(webhookReceipts)
      .values({
        id: newId("whr"),
        sourceId: id,
        eventKey,
        request: clean,
      })
      .onConflictDoNothing()
      .returning();
    if (!receipt) {
      const [seen] = await db
        .select()
        .from(webhookReceipts)
        .where(and(eq(webhookReceipts.sourceId, id), eq(webhookReceipts.eventKey, eventKey!)));
      return { id: seen.id, duplicate: true };
    }
    const rules = await db
      .select()
      .from(topicTriggers)
      .where(and(eq(topicTriggers.sourceId, id), eq(topicTriggers.kind, "webhook"), eq(topicTriggers.enabled, true)));
    for (const rule of rules) {
      const [delivery] = await db
        .insert(triggerEvents)
        .values({
          id: newId("tev"),
          topicId: rule.topicId,
          triggerId: rule.id,
          triggerName: rule.name,
          kind: "webhook",
          eventKey: receipt.id,
          webhookReceiptId: receipt.id,
          request: null,
          config: {
            roleId: rule.roleId,
            instructions: rule.instructions,
            filterCode: rule.filterCode,
            createdBy: rule.createdBy,
            sourceId: source.id,
          },
        })
        .onConflictDoNothing()
        .returning();
      if (delivery)
        await publish(
          db,
          "trigger.changed",
          {
            id: delivery.id,
            topic_id: rule.topicId,
            status: delivery.status,
          },
          `topic:${rule.topicId}`,
        );
    }
    return { id: receipt.id, duplicate: false, deliveries: rules.length };
  });
}

export async function hydrateTriggerEvent(db: Db, event: TriggerEvent): Promise<TriggerEvent> {
  if (!event.webhookReceiptId || event.request) return event;
  const [receipt] = await db.select().from(webhookReceipts).where(eq(webhookReceipts.id, event.webhookReceiptId));
  if (!receipt) throw new NotFound("the shared webhook receipt is missing");
  return { ...event, request: receipt.request };
}

export async function sourceEventPage(db: Db, sourceId: string, before?: string, limit = 30) {
  await webhookSource(db, sourceId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequest("limit must be 1..100");
  const conditions = [eq(webhookReceipts.sourceId, sourceId)];
  if (before) {
    const [cursor] = await db
      .select({ id: webhookReceipts.id })
      .from(webhookReceipts)
      .where(and(eq(webhookReceipts.id, before), eq(webhookReceipts.sourceId, sourceId)));
    if (!cursor) throw new NotFound("receipt cursor not found in this source");
    conditions.push(sql`(${webhookReceipts.createdAt}, ${webhookReceipts.id}) <
      (select created_at, id from webhook_receipts where id = ${before})`);
  }
  const entries = await db
    .select({ id: webhookReceipts.id, eventKey: webhookReceipts.eventKey, createdAt: webhookReceipts.createdAt })
    .from(webhookReceipts)
    .where(and(...conditions))
    .orderBy(desc(webhookReceipts.createdAt), desc(webhookReceipts.id))
    .limit(limit + 1);
  const hasMore = entries.length > limit;
  const items = [];
  for (const receipt of entries.slice(0, limit)) {
    const deliveries = await db
      .select({
        id: triggerEvents.id,
        topicId: triggerEvents.topicId,
        triggerName: triggerEvents.triggerName,
        status: triggerEvents.status,
        error: triggerEvents.error,
        messageId: triggerEvents.messageId,
        taskId: triggerEvents.taskId,
      })
      .from(triggerEvents)
      .where(eq(triggerEvents.webhookReceiptId, receipt.id));
    items.push({ ...receipt, deliveries });
  }
  return { items, next: hasMore ? items.at(-1)!.id : null };
}

export async function availableSources(db: Db) {
  return db.select().from(webhookSources).where(isNull(webhookSources.deletedAt)).orderBy(webhookSources.createdAt);
}

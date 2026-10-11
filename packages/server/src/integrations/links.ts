import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { externalConversations, externalThreadLinks } from "../db/schema.js";

export interface ExternalContext {
  connectionId?: string;
  conversationId?: string;
  conversationKind?: string;
  threadKey?: string;
}

/** Where a topic lives outside (first linked conversation), for assignment rules. */
export async function externalContext(db: Db, topicId: string): Promise<ExternalContext> {
  const [link] = await db.select().from(externalThreadLinks).where(eq(externalThreadLinks.topicId, topicId)).limit(1);
  if (!link) return {};
  const [conv] = await db
    .select()
    .from(externalConversations)
    .where(eq(externalConversations.id, link.conversationId))
    .limit(1);
  if (!conv) return {};
  return {
    connectionId: conv.connectionId,
    conversationId: conv.id,
    conversationKind: conv.kind,
    threadKey: link.threadKey,
  };
}

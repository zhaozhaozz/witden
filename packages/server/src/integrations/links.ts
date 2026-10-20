import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type Connection, connections, externalConversations, externalThreadLinks } from "../db/schema.js";

export interface ExternalContext {
  connectionId?: string;
  conversationId?: string;
  conversationKind?: string;
  threadKey?: string;
}

/** Where a topic lives outside (first linked conversation), for role assignment. */
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

/** The role a connection's bot stands for, or null when none is chosen. */
export const connectionRoleId = (conn: Connection): string | null =>
  typeof conn.settings?.role_id === "string" && conn.settings.role_id ? conn.settings.role_id : null;

/**
 * A Slack, Feishu or GitHub conversation has one role at work: the one its connection's bot stands for. Returns
 * that role for a topic linked outside (null when the bot has none), or undefined for a console topic.
 */
export async function externalRoleId(db: Db, topicId: string): Promise<string | null | undefined> {
  const ext = await externalContext(db, topicId);
  if (!ext.connectionId) return undefined;
  const [conn] = await db.select().from(connections).where(eq(connections.id, ext.connectionId)).limit(1);
  return conn ? connectionRoleId(conn) : null;
}

/** Where a conversation lives outside the console, as the console shows it. */
export interface ChannelInfo {
  connection_id: string;
  connection_name: string;
  platform: string;
  conversation_id: string;
  /** public | private | im | mpim */
  conversation_kind: string;
  /** Slack channel name, GitHub "owner/repo". */
  conversation_name: string | null;
  thread_key: string;
  /** GitHub: issue | pull_request. */
  thread_kind: string | null;
  url: string | null;
  /** The role the connection's bot stands for, if chosen. */
  role_id: string | null;
}

/** The (first) external conversation of each topic, for many topics at once. */
export async function channelsOf(db: Db, topicIds: string[]): Promise<Map<string, ChannelInfo>> {
  const out = new Map<string, ChannelInfo>();
  if (!topicIds.length) return out;
  const links = await db
    .select()
    .from(externalThreadLinks)
    .where(inArray(externalThreadLinks.topicId, topicIds))
    .orderBy(asc(externalThreadLinks.createdAt));
  if (!links.length) return out;
  const convs = await db
    .select()
    .from(externalConversations)
    .where(inArray(externalConversations.id, [...new Set(links.map((l) => l.conversationId))]));
  const conns = await db
    .select()
    .from(connections)
    .where(inArray(connections.id, [...new Set(convs.map((c) => c.connectionId))]));
  const convById = new Map(convs.map((c) => [c.id, c]));
  const connById = new Map(conns.map((c) => [c.id, c]));
  for (const link of links) {
    if (out.has(link.topicId)) continue;
    const conv = convById.get(link.conversationId);
    const conn = conv ? connById.get(conv.connectionId) : undefined;
    if (!conv || !conn) continue;
    const meta = (link.meta ?? {}) as Record<string, unknown>;
    out.set(link.topicId, {
      connection_id: conn.id,
      connection_name: conn.name,
      platform: conn.platform,
      conversation_id: conv.id,
      conversation_kind: conv.kind,
      conversation_name: conv.name,
      thread_key: link.threadKey,
      thread_kind: typeof meta.kind === "string" ? meta.kind : null,
      url: typeof meta.url === "string" ? meta.url : null,
      role_id: connectionRoleId(conn),
    });
  }
  return out;
}

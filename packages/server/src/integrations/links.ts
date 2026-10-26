import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type Connection, connections, externalConversations, externalThreadLinks, topics } from "../db/schema.js";

export interface ExternalContext {
  connectionId?: string;
  conversationId?: string;
  conversationKind?: string;
  threadKey?: string;
}

/** Where a topic lives outside: its first linked conversation, the one the console shows (channelsOf). */
export async function externalContext(db: Db, topicId: string): Promise<ExternalContext> {
  const [link] = await db
    .select()
    .from(externalThreadLinks)
    .where(eq(externalThreadLinks.topicId, topicId))
    .orderBy(asc(externalThreadLinks.createdAt), asc(externalThreadLinks.id))
    .limit(1);
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

/** Who handles a topic linked to a Slack, Feishu or GitHub conversation. */
export interface ExternalHandler {
  /** The connection of the topic's first linked conversation: its bot's role is the topic's default. */
  connectionId: string;
  /** The role the connection's bot stands for (null: none chosen), the default for its conversations. */
  defaultRoleId: string | null;
  /** The role chosen for this topic in its settings, or null: it follows the default. */
  chosenRoleId: string | null;
  /** The role at work there: the chosen one, else the default. */
  roleId: string | null;
}

/**
 * A Slack, Feishu or GitHub conversation has one role at work. By default it is the role of its connection's bot
 * (for a topic linked to several, the connection of the first linked conversation); a person may choose another
 * for the topic (topics.handler_role_id). Outwardly it always speaks as the bot. Undefined for a console topic.
 */
export async function externalHandler(db: Db, topicId: string): Promise<ExternalHandler | undefined> {
  const ext = await externalContext(db, topicId);
  if (!ext.connectionId) return undefined;
  const [conn] = await db.select().from(connections).where(eq(connections.id, ext.connectionId)).limit(1);
  const [topic] = await db
    .select({ handlerRoleId: topics.handlerRoleId })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1);
  const defaultRoleId = conn ? connectionRoleId(conn) : null;
  const chosenRoleId = topic?.handlerRoleId ?? null;
  return { connectionId: ext.connectionId, defaultRoleId, chosenRoleId, roleId: chosenRoleId ?? defaultRoleId };
}

/** The role at work in a topic linked outside (externalHandler; null: none), or undefined for a console topic. */
export async function externalRoleId(db: Db, topicId: string): Promise<string | null | undefined> {
  const handler = await externalHandler(db, topicId);
  return handler ? handler.roleId : undefined;
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
  /** The role the connection's bot stands for, if chosen: the default of its conversations (externalHandler). */
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
    .orderBy(asc(externalThreadLinks.createdAt), asc(externalThreadLinks.id));
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

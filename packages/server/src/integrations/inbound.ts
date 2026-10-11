/**
 * Platform-neutral handling of incoming chat events.
 *
 * External event -> verified by the adapter -> de-duplicated and persisted here -> linked to an internal
 * topic -> permission checks and role assignment -> tasks. The webhook acknowledges immediately; this runs
 * afterwards. Identity is the platform user id, never a display name.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { dispatchHumanMessage, saveMessage } from "../agent/dispatch.js";
import { type Db, db as getDb, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  type Connection,
  connections,
  type ExternalConversation,
  externalConversations,
  externalIdentities,
  externalThreadLinks,
  type Message,
  messages,
  processedEvents,
  roles,
  type Topic,
  topics,
  type User,
  users,
} from "../db/schema.js";
import { topicLabel } from "../security/labels.js";
import { audit } from "../services/audit.js";
import { saveArtifact } from "../services/files.js";
import * as topicSvc from "../services/topics.js";
import { createUser } from "../services/users.js";
import { getAdapter } from "./base.js";

const ROLE_TOKEN = /(?:(?<![\w@])@|\brole:)([a-z0-9][a-z0-9_.-]{0,31})/gi;

export interface InboundMessage {
  connectionId: string;
  /** Unique per platform message (retries and duplicate event types collapse onto it). */
  eventKey: string;
  conversationId: string;
  conversationKind: string; // public | private | im | mpim
  conversationName: string | null;
  threadKey: string; // thread root id; "__dm__" for a whole DM
  messageTs: string;
  userId: string;
  userName: string | null;
  text: string;
  /** The bot was mentioned (or it is a DM). */
  addressed: boolean;
  files?: Record<string, any>[];
}

/** Record a delivery in its own transaction. False means it was seen before (platform retry). */
export async function claimEvent(connectionId: string, eventKey: string): Promise<boolean> {
  const rows = await getDb()
    .insert(processedEvents)
    .values({ id: newId("evt"), connectionId, eventKey, status: "processing" })
    .onConflictDoNothing()
    .returning();
  return rows.length > 0;
}

async function finishEvent(connectionId: string, eventKey: string, status: string, detail: string | null = null) {
  await getDb()
    .update(processedEvents)
    .set({ status, detail: detail?.slice(0, 2000) ?? null })
    .where(and(eq(processedEvents.connectionId, connectionId), eq(processedEvents.eventKey, eventKey)));
}

export async function resolveIdentity(
  db: Db,
  conn: Connection,
  externalUserId: string,
  displayName: string | null,
): Promise<User | null> {
  let [ident] = await db
    .select()
    .from(externalIdentities)
    .where(and(eq(externalIdentities.connectionId, conn.id), eq(externalIdentities.externalUserId, externalUserId)))
    .limit(1);
  if (!ident) {
    [ident] = await db
      .insert(externalIdentities)
      .values({ id: newId("ext"), connectionId: conn.id, externalUserId, displayName })
      .returning();
  } else if (displayName && ident.displayName !== displayName) {
    // informational only; never used to decide identity
    await db.update(externalIdentities).set({ displayName }).where(eq(externalIdentities.id, ident.id));
  }
  if (!ident.userId && conn.settings.auto_provision_users) {
    const user = await createUser(db, { name: displayName || `${conn.platform}-${externalUserId}` });
    await db.update(externalIdentities).set({ userId: user.id }).where(eq(externalIdentities.id, ident.id));
    await audit(db, "identity.auto_provision", {
      connectionId: conn.id,
      detail: { external_user_id: externalUserId, user_id: user.id },
    });
    return user;
  }
  if (!ident.userId) return null;
  const [user] = await db.select().from(users).where(eq(users.id, ident.userId)).limit(1);
  return user?.isActive ? user : null;
}

async function upsertConversation(db: Db, conn: Connection, msg: InboundMessage): Promise<ExternalConversation> {
  const [existing] = await db
    .select()
    .from(externalConversations)
    .where(
      and(eq(externalConversations.connectionId, conn.id), eq(externalConversations.externalId, msg.conversationId)),
    )
    .limit(1);
  if (!existing) {
    const [created] = await db
      .insert(externalConversations)
      .values({
        id: newId("conv"),
        connectionId: conn.id,
        externalId: msg.conversationId,
        kind: msg.conversationKind,
        name: msg.conversationName,
        syncMode: conn.settings.default_sync_mode ?? "mentions",
      })
      .returning();
    return created;
  }
  const update: Partial<ExternalConversation> = {};
  if (msg.conversationKind && existing.kind !== msg.conversationKind) update.kind = msg.conversationKind; // e.g. made private
  if (msg.conversationName) update.name = msg.conversationName;
  if (!Object.keys(update).length) return existing;
  const [row] = await db
    .update(externalConversations)
    .set(update)
    .where(eq(externalConversations.id, existing.id))
    .returning();
  return row;
}

async function threadTopic(
  db: Db,
  conn: Connection,
  conv: ExternalConversation,
  msg: InboundMessage,
  starter: User,
): Promise<Topic> {
  const [link] = await db
    .select()
    .from(externalThreadLinks)
    .where(and(eq(externalThreadLinks.conversationId, conv.id), eq(externalThreadLinks.threadKey, msg.threadKey)))
    .limit(1);
  if (link) return topicSvc.getTopic(db, link.topicId);
  const isDm = conv.kind === "im";
  const title = (msg.text.trim().split("\n")[0] || "thread").slice(0, 80);
  const [topic] = await db
    .insert(topics)
    .values({
      id: newId("top"),
      title: `${isDm ? "DM" : `#${conv.name ?? conv.externalId}`}: ${title}`,
      kind: isDm ? "dm" : "group",
      visibility: "private",
      historyPolicy: "full",
      source: conn.platform,
      createdBy: starter.id,
    })
    .returning();
  await topicSvc.addParticipant(db, topic, "user", starter.id, { owner: true });
  await db.insert(externalThreadLinks).values({
    id: newId("lnk"),
    connectionId: conn.id,
    conversationId: conv.id,
    threadKey: msg.threadKey,
    topicId: topic.id,
  });
  return topic;
}

async function roleMentions(db: Db, text: string): Promise<string[]> {
  const ids: string[] = [];
  for (const m of text.matchAll(ROLE_TOKEN)) {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.handle, m[1].toLowerCase())).limit(1);
    if (role && !ids.includes(role.id)) ids.push(role.id);
  }
  return ids;
}

export type Reply = (text: string) => Promise<void>;

/** Process one inbound message exactly once. ``reply`` posts a direct notice back (e.g. "not linked"). */
export async function handleMessage(msg: InboundMessage, reply?: Reply): Promise<Record<string, unknown>> {
  if (!(await claimEvent(msg.connectionId, msg.eventKey))) return { status: "duplicate" };
  try {
    const result = await handle(msg, reply);
    await finishEvent(msg.connectionId, msg.eventKey, String(result.status));
    return result;
  } catch (err) {
    // failures stay visible on the connection page
    console.error("[witden] inbound message failed", err);
    await finishEvent(msg.connectionId, msg.eventKey, "failed", `${(err as Error).name}: ${(err as Error).message}`);
    throw err;
  }
}

async function handle(msg: InboundMessage, reply?: Reply): Promise<Record<string, unknown>> {
  let notice: string | null = null;
  const result = await transaction(async (db) => {
    const [conn] = await db.select().from(connections).where(eq(connections.id, msg.connectionId)).limit(1);
    if (!conn) return { status: "unknown_connection" };
    if (conn.status !== "active") return { status: "connection_paused" };
    const conv = await upsertConversation(db, conn, msg);
    if (conv.syncMode === "off") return { status: "sync_off" };
    const adapter = await getAdapter(conn);
    if (adapter.syncMembers) {
      // Unknown membership is treated as the whole workspace, so a failure here fails closed.
      await adapter
        .syncMembers(db, conn, conv)
        .catch((err) => console.warn("[witden] member sync failed", err.message));
    }
    const user = await resolveIdentity(db, conn, msg.userId, msg.userName);
    const [existing] = await db
      .select()
      .from(externalThreadLinks)
      .where(and(eq(externalThreadLinks.conversationId, conv.id), eq(externalThreadLinks.threadKey, msg.threadKey)))
      .limit(1);
    if (!existing && !msg.addressed && conv.syncMode !== "all") return { status: "ignored" }; // only threads where someone asked for us
    if (!user) {
      await audit(db, "inbound.unlinked_user", {
        actorType: "external",
        actorId: msg.userId,
        outcome: "denied",
        connectionId: conn.id,
        detail: { conversation: msg.conversationId },
      });
      if (msg.addressed) {
        notice =
          "Sorry, your account is not linked to a team member yet, so I can't take requests from you. Ask an administrator to link it.";
      }
      return { status: "unlinked_user" };
    }
    const topic = await threadTopic(db, conn, conv, msg, user);
    // Anyone who can see the thread may take part; their requests are still checked individually.
    if (!(await topicSvc.participant(db, topic.id, "user", user.id)))
      await topicSvc.addParticipant(db, topic, "user", user.id);
    const roleIds = await roleMentions(db, msg.text);
    const present = [];
    for (const rid of roleIds) if (await topicSvc.participant(db, topic.id, "role", rid)) present.push(rid);
    let stored = await saveMessage(db, topic, "user", user.id, msg.text, {
      mentions: present.map((id) => ({ type: "role" as const, id })),
      source: conn.platform,
      externalRef: { conversation: msg.conversationId, ts: msg.messageTs, thread: msg.threadKey },
    });
    if (msg.files?.length) stored = await ingestFiles(db, conn, topic, stored, user, msg.files);
    if (!msg.addressed) return { status: "stored", topic_id: topic.id };
    if (roleIds.length && !present.length) {
      // Roles named but not yet in this thread: the assignment rules decide whether they may join.
      [stored] = await db
        .update(messages)
        .set({ mentions: roleIds.map((id) => ({ type: "role" as const, id })) })
        .where(eq(messages.id, stored.id))
        .returning();
    }
    const created = await dispatchHumanMessage(db, topic, stored, user, {
      idempotencyPrefix: `${conn.id}:${msg.eventKey}`,
    });
    return { status: "dispatched", topic_id: topic.id, tasks: created.map((t) => t.id) };
  });
  if (notice && reply) await reply(notice).catch(() => {});
  return result;
}

async function findMessage(
  db: Db,
  connectionId: string,
  conversationId: string,
  ts: string,
): Promise<Message | undefined> {
  const [conv] = await db
    .select()
    .from(externalConversations)
    .where(
      and(eq(externalConversations.connectionId, connectionId), eq(externalConversations.externalId, conversationId)),
    )
    .limit(1);
  if (!conv) return undefined;
  const links = await db.select().from(externalThreadLinks).where(eq(externalThreadLinks.conversationId, conv.id));
  if (!links.length) return undefined;
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        inArray(
          messages.topicId,
          links.map((l) => l.topicId),
        ),
        isNull(messages.deletedAt),
      ),
    );
  return rows.find((m) => m.externalRef?.ts === ts);
}

export async function handleEdit(
  connectionId: string,
  conversationId: string,
  ts: string,
  text: string,
): Promise<boolean> {
  return transaction(async (db) => {
    const msg = await findMessage(db, connectionId, conversationId, ts);
    if (!msg) return false;
    await db.update(messages).set({ content: text, editedAt: new Date() }).where(eq(messages.id, msg.id));
    await audit(db, "inbound.edit", {
      actorType: "external",
      connectionId,
      topicId: msg.topicId,
      detail: { message_id: msg.id },
    });
    return true;
  });
}

export async function handleDelete(connectionId: string, conversationId: string, ts: string): Promise<boolean> {
  const { purgeMessage } = await import("../services/messages.js");
  return transaction(async (db) => {
    const msg = await findMessage(db, connectionId, conversationId, ts);
    if (!msg) return false;
    const purged = await purgeMessage(db, msg);
    await audit(db, "inbound.delete", {
      actorType: "external",
      connectionId,
      topicId: msg.topicId,
      detail: { message_id: msg.id, ...purged },
    });
    return true;
  });
}

async function ingestFiles(
  db: Db,
  conn: Connection,
  topic: Topic,
  stored: Message,
  user: User,
  files: Record<string, any>[],
): Promise<Message> {
  const adapter = await getAdapter(conn);
  const ids: string[] = [];
  for (const f of files) {
    if (!adapter.fetchFile) continue;
    let data: Buffer | null = null;
    try {
      data = await adapter.fetchFile(conn, f);
    } catch (err) {
      await saveMessage(db, topic, "system", null, `Could not import file ${f.name}: ${(err as Error).message}`, {
        mentions: [],
      });
      continue;
    }
    if (!data) {
      await saveMessage(db, topic, "system", null, `File ${f.name} was not imported (too large or unsupported).`, {
        mentions: [],
      });
      continue;
    }
    const art = await saveArtifact(db, data, {
      name: f.name ?? "file",
      kind: "upload",
      labels: [topicLabel(topic.id)],
      topicId: topic.id,
      createdByType: "user",
      createdById: user.id,
      mime: f.mimetype,
    });
    ids.push(art.id);
  }
  if (!ids.length) return stored;
  const [row] = await db.update(messages).set({ attachments: ids }).where(eq(messages.id, stored.id)).returning();
  return row;
}

/**
 * A conversation linked to Slack, Feishu or GitHub has one role at work (integrations/links.ts externalHandler):
 * by default the role its connection's bot stands for, or one a person chose for that topic. Outwardly it always
 * speaks as the bot. When the role changes, the topic changes with it: the previous role leaves, the new one joins
 * at once, the topic's triggers go to it, and the previous role's work there is stopped. The notices stay in the
 * console.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { systemMessage } from "../agent/dispatch.js";
import { recheckActiveTasks } from "../agent/revocation.js";
import type { Db } from "../db/client.js";
import {
  type Connection,
  connections,
  externalThreadLinks,
  type Topic,
  tasks,
  topicParticipants,
  topics,
  topicTriggers,
  type User,
} from "../db/schema.js";
import { BadRequest, NotFound } from "../errors.js";
import { connectionRoleId, externalHandler, externalRoleId } from "../integrations/links.js";
import { audit } from "./audit.js";
import { roleParticipantChange } from "./participant-notices.js";
import { addParticipant, getRole, removeParticipant } from "./topics.js";

/**
 * The roles that belong in a linked topic: the one chosen for it, or else those its connections' bots stand for
 * (usually one; a topic linked to several keeps each one's, of which the first linked conversation's works).
 */
async function boundRoles(db: Db, topic: Topic): Promise<Set<string>> {
  if (topic.handlerRoleId) return new Set([topic.handlerRoleId]);
  const linked = await db
    .select({ connectionId: externalThreadLinks.connectionId })
    .from(externalThreadLinks)
    .where(eq(externalThreadLinks.topicId, topic.id));
  const ids = [...new Set(linked.map((l) => l.connectionId))];
  if (!ids.length) return new Set();
  const conns = await db.select().from(connections).where(inArray(connections.id, ids));
  return new Set(conns.map(connectionRoleId).filter((r): r is string => !!r));
}

/** Make a linked topic have its bound roles and no other; its triggers go to the role at work. */
async function bindTopic(db: Db, topic: Topic, actorName: string) {
  const bound = await boundRoles(db, topic);
  const present = await db
    .select({ roleId: topicParticipants.participantId })
    .from(topicParticipants)
    .where(
      and(
        eq(topicParticipants.topicId, topic.id),
        eq(topicParticipants.participantType, "role"),
        isNull(topicParticipants.removedAt),
      ),
    );
  let removed = 0;
  let added = 0;
  for (const { roleId } of present) {
    if (bound.has(roleId)) continue;
    await removeParticipant(db, topic, "role", roleId);
    const change = await roleParticipantChange(db, roleId, "removed", actorName);
    await systemMessage(db, topic, `@${change.role.handle ?? change.role.name} left the topic.`, {
      participantChange: change,
      mirror: false,
    });
    removed++;
  }
  for (const roleId of bound) {
    if (present.some((p) => p.roleId === roleId)) continue;
    await addParticipant(db, topic, "role", roleId);
    const change = await roleParticipantChange(db, roleId, "added", actorName);
    await systemMessage(db, topic, `${actorName} added @${change.role.handle} to the topic.`, {
      participantChange: change,
      mirror: false,
    });
    added++;
  }
  // A trigger of an external conversation is handled by whoever handles the conversation (services/triggers.ts).
  const working = await externalRoleId(db, topic.id);
  const retargeted = working
    ? (
        await db
          .update(topicTriggers)
          .set({ roleId: working })
          .where(and(eq(topicTriggers.topicId, topic.id), ne(topicTriggers.roleId, working)))
          .returning({ id: topicTriggers.id })
      ).length
    : 0;
  return { removed, added, triggers: retargeted };
}

/**
 * The connection's bot stands for another role: the topics linked to it that follow it get the new role; those
 * with a role of their own keep it. The caller rechecks the work under way.
 */
export async function rebindConnectionTopics(db: Db, conn: Connection, actorName: string) {
  const links = await db
    .select({ topicId: externalThreadLinks.topicId })
    .from(externalThreadLinks)
    .where(eq(externalThreadLinks.connectionId, conn.id));
  const out = { topics: 0, removed: 0, added: 0, triggers: 0, kept: 0 };
  for (const topicId of new Set(links.map((l) => l.topicId))) {
    const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
    if (!topic) continue;
    if (topic.handlerRoleId) {
      out.kept++;
      continue;
    }
    const r = await bindTopic(db, topic, actorName);
    if (r.removed || r.added) out.topics++;
    out.removed += r.removed;
    out.added += r.added;
    out.triggers += r.triggers;
  }
  return out;
}

/**
 * A person chooses the role handling one linked topic, or null to follow its connection's again. Like a new role
 * for the connection, for this topic only: the previous role leaves and its work here stops, the new one joins.
 * Only an active, ordinary role (never the system administrator). Returns the topic, or null when unchanged.
 */
export async function setTopicHandler(db: Db, topic: Topic, value: unknown, user: User): Promise<Topic | null> {
  if (value !== null && typeof value !== "string") throw new BadRequest("handler_role_id must be a role id or null");
  const before = await externalHandler(db, topic.id);
  if (!before)
    throw new BadRequest("only a topic linked to a Slack, Feishu or GitHub conversation has a role handling it");
  const chosen = value || null;
  if (chosen === before.chosenRoleId) return null;
  if (chosen) {
    const role = await getRole(db, chosen);
    if (!role) throw new NotFound("role not found");
    if (role.systemAdmin)
      throw new BadRequest(`@${role.handle} is a system administrator: it works only in the console`);
    if (role.status !== "active") throw new BadRequest(`@${role.handle} is disabled`);
  }
  const [updated] = await db.update(topics).set({ handlerRoleId: chosen }).where(eq(topics.id, topic.id)).returning();
  const bound = await bindTopic(db, updated, user.name);
  const ids = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.topicId, topic.id))).map((t) => t.id);
  const cancelled = await recheckActiveTasks(db, "the conversation's AI employee changed", ids);
  await audit(db, "topic.handler_role", {
    actorType: "user",
    actorId: user.id,
    resourceType: "topic",
    resourceId: topic.id,
    topicId: topic.id,
    connectionId: before.connectionId,
    detail: {
      from: before.roleId,
      to: chosen ?? before.defaultRoleId,
      // null: it follows the connection's role from now on
      chosen,
      ...bound,
      tasks_cancelled: cancelled,
    },
  });
  return updated;
}

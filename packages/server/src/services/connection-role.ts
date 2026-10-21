/**
 * A connection's bot stands for one role, and in the conversations linked to the connection that role is the only
 * one at work (integrations/links.ts externalRoleId). When the connection's role changes, its linked topics change
 * with it: the other roles leave, the new one joins at once. The notices stay in the console.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { systemMessage } from "../agent/dispatch.js";
import type { Db } from "../db/client.js";
import { type Connection, connections, externalThreadLinks, topicParticipants, topics } from "../db/schema.js";
import { connectionRoleId } from "../integrations/links.js";
import { roleParticipantChange } from "./participant-notices.js";
import { addParticipant, removeParticipant } from "./topics.js";

/** The roles that work in a linked topic: those its connections' bots stand for (usually one). */
async function boundRoles(db: Db, topicId: string): Promise<Set<string>> {
  const linked = await db
    .select({ connectionId: externalThreadLinks.connectionId })
    .from(externalThreadLinks)
    .where(eq(externalThreadLinks.topicId, topicId));
  const ids = [...new Set(linked.map((l) => l.connectionId))];
  if (!ids.length) return new Set();
  const conns = await db.select().from(connections).where(inArray(connections.id, ids));
  return new Set(conns.map(connectionRoleId).filter((r): r is string => !!r));
}

/** Make the topics linked to a connection have its bot's role, and no other. */
export async function rebindConnectionTopics(db: Db, conn: Connection, actorName: string) {
  const links = await db
    .select({ topicId: externalThreadLinks.topicId })
    .from(externalThreadLinks)
    .where(eq(externalThreadLinks.connectionId, conn.id));
  let changedTopics = 0;
  let removed = 0;
  let added = 0;
  for (const topicId of new Set(links.map((l) => l.topicId))) {
    const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
    if (!topic) continue;
    const bound = await boundRoles(db, topic.id);
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
    let changed = false;
    for (const { roleId } of present) {
      if (bound.has(roleId)) continue;
      await removeParticipant(db, topic, "role", roleId);
      const change = await roleParticipantChange(db, roleId, "removed", actorName);
      await systemMessage(db, topic, `@${change.role.handle ?? change.role.name} left the topic.`, {
        participantChange: change,
        mirror: false,
      });
      removed++;
      changed = true;
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
      changed = true;
    }
    if (changed) changedTopics++;
  }
  return { topics: changedTopics, removed, added };
}

/**
 * The topics an AI employee works with besides the one it is in: the group topics it takes part in, like an
 * employee in several group chats. A console group topic it was invited to, or a Slack, Feishu or GitHub group
 * conversation where it is the AI employee at work: it knows what is said there, may read it and may post there
 * (agent/topic-messaging.ts). DMs (a person and an AI employee) and direct conversations between two AI employees
 * are private: they are never read or written from another topic. A system administrator works only where it is.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { connections, type Role, type Task, type Topic, topicParticipants, topics, users } from "../db/schema.js";
import { Forbidden } from "../errors.js";
import { externalRoleId } from "../integrations/links.js";
import type { TopicDelivery } from "./collaboration-policy.js";
import { getRole, participant } from "./topics.js";

/** The active group topics ``role`` takes part in, most recently active first. */
export async function memberTopics(db: Db, role: Role): Promise<Topic[]> {
  if (role.systemAdmin) return [];
  const rows = await db
    .select({ topic: topics })
    .from(topics)
    .innerJoin(
      topicParticipants,
      and(
        eq(topicParticipants.topicId, topics.id),
        eq(topicParticipants.participantType, "role"),
        eq(topicParticipants.participantId, role.id),
        isNull(topicParticipants.removedAt),
      ),
    )
    .where(and(eq(topics.kind, "group"), eq(topics.status, "active")))
    .orderBy(sql`${topics.lastMessageAt} desc nulls last`, desc(topics.createdAt));
  const out: Topic[] = [];
  // In a Slack, Feishu or GitHub conversation only the AI employee working there counts as taking part.
  for (const { topic } of rows) if (await worksIn(db, role, topic)) out.push(topic);
  return out;
}

const worksIn = async (db: Db, role: Role, topic: Topic) => {
  const bound = await externalRoleId(db, topic.id);
  return bound === undefined || bound === role.id;
};

/**
 * ``topicId`` when ``role`` may read it and post there from another topic: an active group topic it takes part
 * in. Throws why not; a topic it is not in is refused like one that does not exist.
 */
export async function memberTopic(db: Db, role: Role, topicId: string): Promise<Topic> {
  if (role.systemAdmin) throw new Forbidden("the system administrator works only in the topic it is in");
  const id = topicId.trim();
  const [topic] = id ? await db.select().from(topics).where(eq(topics.id, id)).limit(1) : [];
  if (!topic || !(await participant(db, topic.id, "role", role.id)) || !(await worksIn(db, role, topic)))
    throw new Forbidden(
      `you do not take part in topic ${id || "(none given)"}; my_topics lists the group topics you take part in`,
    );
  if (topic.kind === "dm")
    throw new Forbidden(`topic ${id} is a private DM: it is not read or written from other topics`);
  if (topic.kind === "pair")
    throw new Forbidden(
      `topic ${id} is a direct conversation between two AI employees: it is not read or written from other topics`,
    );
  if (topic.status !== "active") throw new Forbidden(`topic ${id} is archived`);
  return topic;
}

/**
 * Work started by a message from another topic (its ``topic_routes``) goes on only while that message could still
 * be sent: both topics are active, the AI employee that sent it still takes part in both, and the person it was
 * sent for is still in the topic they asked in, through a connection that is still active.
 */
export async function crossTopicRefusal(db: Db, task: Task): Promise<string | null> {
  for (const route of (task.envelope?.topic_routes ?? []) as TopicDelivery[]) {
    const [source] = await db.select().from(topics).where(eq(topics.id, route.source_topic_id)).limit(1);
    const [origin] = await db.select().from(topics).where(eq(topics.id, route.origin.topic_id)).limit(1);
    if (source?.status !== "active" || origin?.status !== "active") return "the topic it came from is no longer active";
    const sender = await getRole(db, route.sender_role_id);
    if (sender?.status !== "active") return "the AI employee that sent it was disabled or removed";
    if (!(await participant(db, source.id, "role", sender.id)))
      return `@${sender.handle}, who sent it, no longer takes part in the topic it came from`;
    if (!(await participant(db, task.topicId, "role", sender.id)))
      return `@${sender.handle}, who sent it, no longer takes part in this topic`;
    const uid = route.origin.requester_user_id;
    if (uid) {
      const [u] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
      if (!u?.isActive || !(await participant(db, origin.id, "user", uid)))
        return "the person it was sent for left the topic they asked in";
    }
    if (route.origin.connection_id) {
      const [conn] = await db.select().from(connections).where(eq(connections.id, route.origin.connection_id));
      if (conn?.status !== "active") return "the communication connection it came through is not active";
    }
  }
  return null;
}

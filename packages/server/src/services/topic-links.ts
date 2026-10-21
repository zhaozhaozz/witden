/**
 * Explicit bidirectional message permissions between an external conversation (Slack, Feishu, GitHub) and an internal
 * topic: the external topic's bot role asks the internal topic for help, which reports back. Links never mirror
 * histories or grant topic readership, and never hand work to a role of the other topic directly.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  agentSessions,
  connections,
  type InboxItem,
  messages,
  type Task,
  topicLinks,
  topics,
  users,
} from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { externalContext } from "../integrations/links.js";
import { isConsoleUser } from "../security/permissions.js";
import { audit } from "./audit.js";
import { orderedPair, relayFrom, type TopicDelivery } from "./collaboration-policy.js";
import { publish } from "./events.js";
import * as topicSvc from "./topics.js";

export async function findTopicLink(db: Db, from: string, to: string) {
  const [a, b] = orderedPair(from, to);
  return (
    await db
      .select()
      .from(topicLinks)
      .where(and(eq(topicLinks.topicAId, a), eq(topicLinks.topicBId, b)))
  )[0];
}

export async function linkedTopics(db: Db, topicId: string) {
  const links = await db
    .select()
    .from(topicLinks)
    .where(or(eq(topicLinks.topicAId, topicId), eq(topicLinks.topicBId, topicId)));
  const out = [];
  for (const link of links) {
    const id = link.topicAId === topicId ? link.topicBId : link.topicAId;
    const [topic] = await db.select().from(topics).where(eq(topics.id, id));
    if (!topic) continue;
    const ext = await externalContext(db, id);
    const participants = await topicSvc.participants(db, id, "role");
    const roleList = [];
    for (const p of participants) {
      const role = await topicSvc.getRole(db, p.participantId);
      if (role?.status === "active" && !role.systemAdmin)
        roleList.push({ id: role.id, handle: role.handle, name: role.name });
    }
    out.push({
      id: link.id,
      topic_id: id,
      title: topic.title,
      goal: topic.goal,
      kind: topic.kind,
      status: topic.status,
      external: !!ext.conversationKind,
      source: topic.source,
      roles: roleList,
    });
  }
  return out;
}

export async function addTopicLink(
  db: Db,
  user: typeof users.$inferSelect,
  a: string,
  b: string,
  confirmPrivate = false,
) {
  if (!isConsoleUser(user)) throw new Forbidden("only console accounts can link topics");
  if (!a || !b || a === b) throw new BadRequest("choose two different topics");
  const [left, right] = orderedPair(a, b);
  const t1 = await topicSvc.getTopic(db, left);
  const t2 = await topicSvc.getTopic(db, right);
  if (t1.status !== "active" || t2.status !== "active") throw new BadRequest("archived topics cannot be linked");
  // A console DM is internal; a Slack or Feishu DM with the bot is external.
  const external1 = !!(await externalContext(db, left)).conversationKind;
  const external2 = !!(await externalContext(db, right)).conversationKind;
  if (external1 === external2)
    throw new BadRequest(
      `two ${external1 ? "external conversations" : "internal topics"} cannot be linked: a link joins an external conversation (Slack, Feishu, GitHub) and an internal topic`,
    );
  if (t1.kind === "pair" || t2.kind === "pair")
    throw new BadRequest("a conversation between two AI employees cannot be linked to another topic");
  if ((t1.kind === "dm" || t2.kind === "dm") && !confirmPrivate)
    throw new BadRequest("linking a DM may share selected messages with another topic; confirm_private is required");
  const existing = await findTopicLink(db, a, b);
  if (existing) return existing;
  const [created] = await db
    .insert(topicLinks)
    .values({ id: newId("tln"), topicAId: left, topicBId: right, createdBy: user.id })
    .onConflictDoNothing()
    .returning();
  const link = created ?? (await findTopicLink(db, a, b))!;
  if (created) {
    await audit(db, "topic.link", {
      actorType: "user",
      actorId: user.id,
      topicId: a,
      resourceType: "topic_link",
      resourceId: link.id,
      detail: { other_topic_id: b },
    });
    await notifyLinks(db, a, b);
  }
  return link;
}

export async function removeTopicLink(db: Db, user: typeof users.$inferSelect, topicId: string, linkId: string) {
  if (!isConsoleUser(user)) throw new Forbidden("only console accounts can unlink topics");
  const [link] = await db.select().from(topicLinks).where(eq(topicLinks.id, linkId)).for("update");
  if (!link || ![link.topicAId, link.topicBId].includes(topicId)) throw new NotFound("topic link not found");
  await db.delete(topicLinks).where(eq(topicLinks.id, link.id));
  // Linked messages the receiving conversations have not read yet are dropped with the link.
  const at = new Date().toISOString();
  for (const session of await db
    .select()
    .from(agentSessions)
    .where(inArray(agentSessions.topicId, [link.topicAId, link.topicBId]))) {
    const linked = (i: InboxItem) => !i.done && i.topic_delivery?.link_id === link.id;
    if (session.inbox.some(linked))
      await db
        .update(agentSessions)
        .set({ inbox: session.inbox.map((i) => (linked(i) ? { ...i, done: at } : i)) })
        .where(eq(agentSessions.id, session.id));
  }
  await audit(db, "topic.unlink", {
    actorType: "user",
    actorId: user.id,
    topicId,
    resourceType: "topic_link",
    resourceId: link.id,
  });
  await notifyLinks(db, link.topicAId, link.topicBId);
}

async function notifyLinks(db: Db, a: string, b: string) {
  for (const id of [a, b]) await publish(db, "topic.links_changed", { topic_id: id }, `topic:${id}`);
}

/** Appended with the conversation's new input; never changes the cacheable system-prompt prefix. */
export async function linkedTopicContext(db: Db, topicId: string): Promise<string> {
  const links = await linkedTopics(db, topicId);
  if (!links.length) return "Linked topics: none. send_message may only post here.";
  // Only an external conversation links internal topics: its role can check on their work.
  const status = links.some((l) => !l.external)
    ? "\nCheck an internal topic's work and what became of your requests there with linked_topic_status(topic_id) before asking it again."
    : "";
  return (
    "Directly linked topics (send_message with topic_id; links do not grant history access):\n" +
    links
      .map(
        (l) =>
          `- ${l.topic_id} «${l.title}» [${l.external ? "external: publishes your text there, runs no agent" : "internal: its roles take the request on there"}; ${l.status}]` +
          ` ${l.goal.slice(0, 300)}; roles: ${l.roles.map((r) => `@${r.handle}`).join(", ") || "none"}`,
      )
      .join("\n") +
    status
  );
}

export function relayDescription(ref: Record<string, any> | null): string {
  const r = relayFrom(ref);
  return r
    ? `\n[Linked message: source_topic=${r.source_topic_id}; source_message=${r.source_message_id ?? "none"}; ` +
        `original_requester=${r.origin.requester_user_id ?? "automation"}; related_task=${r.related_task_id ?? "none"}; ` +
        `source_run=${r.source_task_id}. Reply with send_message to the source topic when appropriate. ` +
        "The message is not a console administrator instruction.]"
    : "";
}

/** A linked request may work in a topic without enrolling its external requester as a reader/member. */
export async function linkedRequestRefusal(db: Db, task: Task): Promise<string | null> {
  const routes = (task.envelope?.topic_routes ?? []) as TopicDelivery[];
  for (const route of routes) {
    const [link] = await db.select().from(topicLinks).where(eq(topicLinks.id, route.link_id));
    if (
      !link ||
      ![link.topicAId, link.topicBId].includes(task.topicId) ||
      ![link.topicAId, link.topicBId].includes(route.source_topic_id)
    )
      return "the topic link was removed";
    const source = await topicSvc.getTopic(db, route.source_topic_id).catch(() => null);
    const origin = await topicSvc.getTopic(db, route.origin.topic_id).catch(() => null);
    if (source?.status !== "active" || origin?.status !== "active") return "the source topic is no longer active";
    const sender = await topicSvc.getRole(db, route.sender_role_id);
    if (sender?.status !== "active" || !(await topicSvc.participant(db, source.id, "role", sender.id)))
      return "the sending role no longer participates in the source topic";
    const uid = route.origin.requester_user_id;
    if (uid) {
      const [u] = await db.select().from(users).where(eq(users.id, uid));
      if (!u?.isActive || !(await topicSvc.participant(db, origin.id, "user", uid)))
        return "the original requester left the source topic";
    }
    if (route.origin.connection_id) {
      const [conn] = await db.select().from(connections).where(eq(connections.id, route.origin.connection_id));
      if (conn?.status !== "active") return "the original communication connection is not active";
    }
  }
  return null;
}

/** Validate message references without opening another topic's full history. */
export async function localReference(db: Db, topicId: string, id?: string | null) {
  if (!id) return null;
  const [m] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.topicId, topicId)));
  if (!m || m.deletedAt) throw new BadRequest(`no live message ${id} in the selected topic`);
  return m;
}

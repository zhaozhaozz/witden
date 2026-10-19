/** Everything an AI role says or shares passes the information-flow check here. */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  type Approval,
  approvals,
  artifacts,
  connections,
  knowledgeSpaces,
  type Mention,
  type Message,
  messages,
  type Role,
  type Task,
  type Topic,
  topics,
  users,
} from "../db/schema.js";
import { checkFlow, labelOwners, topicLabel, topicReaders } from "../security/labels.js";
import { audit } from "../services/audit.js";
import { deleteArtifactData } from "../services/files.js";
import { dispatchRoleMessage, saveMessage, systemMessage } from "./dispatch.js";

export interface Delivery {
  message: Message | null;
  approval: Approval | null;
}

export async function describeLabel(db: Db, label: string): Promise<string> {
  const idx = label.indexOf(":");
  const kind = label.slice(0, idx);
  const ident = label.slice(idx + 1);
  if (kind === "topic") {
    const [t] = await db.select().from(topics).where(eq(topics.id, ident)).limit(1);
    return `${t?.kind === "dm" ? "DM" : "topic"} «${t?.title ?? ident}»`;
  }
  if (kind === "user") {
    const [u] = await db.select().from(users).where(eq(users.id, ident)).limit(1);
    return `private material of ${u?.name ?? ident}`;
  }
  if (kind === "space") {
    const [s] = await db.select().from(knowledgeSpaces).where(eq(knowledgeSpaces.id, ident)).limit(1);
    return `knowledge space «${s?.name ?? ident}»`;
  }
  if (kind === "feishu" || kind === "github") {
    const [c] = await db.select().from(connections).where(eq(connections.id, ident)).limit(1);
    return kind === "feishu"
      ? `the Feishu of «${c?.name ?? ident}»`
      : `private GitHub repositories of «${c?.name ?? ident}»`;
  }
  return label;
}

/** A request asked inside a Slack thread is answered in that thread (messages there point at its root). */
async function answeredThread(db: Db, task: Task): Promise<string | null> {
  if (!task.sourceMessageId) return null;
  const [source] = await db
    .select({ replyToId: messages.replyToId })
    .from(messages)
    .where(eq(messages.id, task.sourceMessageId))
    .limit(1);
  return source?.replyToId ?? null;
}

export async function deliver(
  db: Db,
  task: Task,
  role: Role,
  topic: Topic,
  content: string,
  opts: {
    final: boolean;
    mentions?: Mention[];
    attachments?: string[];
    round?: number;
    toolCallId?: string | null;
    /** Post in this thread instead of where the request was asked. */
    replyToId?: string | null;
  },
): Promise<Delivery> {
  const decision = await checkFlow(db, task.labels, await topicReaders(db, topic.id));
  if (decision.allowed) {
    // Roles address others only through explicit mentions (message_role / ask_human); an "@dev" quoted in an
    // answer must not start new work.
    const msg = await saveMessage(db, topic, "role", role.id, content, {
      mentions: opts.mentions ?? [],
      attachments: opts.attachments ?? [],
      round: opts.round ?? task.round + 1,
      taskId: task.id,
      replyToId: opts.replyToId ?? (await answeredThread(db, task)),
    });
    await audit(db, "message.post", {
      actorType: "role",
      actorId: role.id,
      topicId: topic.id,
      taskId: task.id,
      roleId: role.id,
      instanceId: task.instanceId,
      detail: { message_id: msg.id, final: opts.final },
    });
    await dispatchRoleMessage(db, topic, msg, role, task);
    return { message: msg, approval: null };
  }
  const owners = new Set<string>();
  for (const label of decision.blockedLabels) for (const o of await labelOwners(db, label)) owners.add(o);
  const sources = (await Promise.all(decision.blockedLabels.map((l) => describeLabel(db, l)))).join(", ");
  const [approval] = await db
    .insert(approvals)
    .values({
      id: newId("apr"),
      taskId: task.id,
      topicId: topic.id,
      roleId: role.id,
      action: "disclose",
      detail: {
        content,
        mentions: opts.mentions ?? [],
        attachments: opts.attachments ?? [],
        final: opts.final,
        labels: decision.blockedLabels,
        sources,
        tool_call_id: opts.toolCallId ?? null,
        reply_to_id: opts.replyToId ?? null,
      },
      approverUserIds: [...owners].sort(),
    })
    .returning();
  await audit(db, "output.blocked", {
    actorType: "role",
    actorId: role.id,
    outcome: "denied",
    topicId: topic.id,
    taskId: task.id,
    roleId: role.id,
    detail: { labels: decision.blockedLabels, explain: decision.explain() },
  });
  await systemMessage(
    db,
    topic,
    `A message from @${role.handle} is on hold: it draws on ${sources}, which not everyone here may see. The owners of that material can approve or reject releasing it.`,
    { taskId: task.id, mentions: [...owners].sort().map((id) => ({ type: "user" as const, id })) },
  );
  return { message: null, approval };
}

/** An owner approved disclosure of this one message (and its files): post it to the topic. */
export async function releaseApproved(
  db: Db,
  approval: Approval,
  task: Task,
  role: Role,
  topic: Topic,
): Promise<Message> {
  const detail = approval.detail;
  for (const id of detail.attachments ?? []) {
    await db
      .update(artifacts)
      .set({ topicId: topic.id, labels: [topicLabel(topic.id)] })
      .where(eq(artifacts.id, id));
  }
  const msg = await saveMessage(db, topic, "role", role.id, detail.content, {
    mentions: detail.mentions ?? [],
    attachments: detail.attachments ?? [],
    round: task.round + 1,
    taskId: task.id,
    replyToId: detail.reply_to_id ?? (await answeredThread(db, task)),
  });
  await dispatchRoleMessage(db, topic, msg, role, task);
  return msg;
}

/** Disclosure rejected: files that were waiting for it are deleted, not kept around. */
export async function discardHeld(db: Db, approval: Approval): Promise<void> {
  for (const id of approval.detail.attachments ?? []) {
    const [art] = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
    if (art && !art.topicId && !art.deletedAt) {
      await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, id));
      deleteArtifactData(art);
    }
  }
}

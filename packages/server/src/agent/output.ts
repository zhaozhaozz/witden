/** Everything an AI role says or shares in a topic is posted here. */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  type Approval,
  artifacts,
  type Mention,
  type Message,
  messages,
  type Role,
  type Task,
  type Topic,
} from "../db/schema.js";
import { audit } from "../services/audit.js";
import { deleteArtifactData } from "../services/files.js";
import { dispatchRoleMessage, saveMessage } from "./dispatch.js";

/** A request asked inside a Slack thread is answered in that thread (messages there point at its root). */
async function answeredThread(db: Db, task: Task, topicId: string): Promise<string | null> {
  if (!task.sourceMessageId) return null;
  const [source] = await db
    .select({ replyToId: messages.replyToId, topicId: messages.topicId })
    .from(messages)
    .where(eq(messages.id, task.sourceMessageId))
    .limit(1);
  return source?.topicId === topicId ? source.replyToId : null;
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
    /** Post in this thread instead of where the request was asked. */
    replyToId?: string | null;
  },
): Promise<Message> {
  // Roles address others only through explicit mentions (message_role / ask_human); an "@dev" quoted in an
  // answer must not start new work.
  const msg = await saveMessage(db, topic, "role", role.id, content, {
    mentions: opts.mentions ?? [],
    attachments: opts.attachments ?? [],
    round: opts.round ?? task.round + 1,
    taskId: task.id,
    replyToId: opts.replyToId ?? (await answeredThread(db, task, topic.id)),
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
  return msg;
}

/**
 * Messages held for disclosure before material stopped being tracked by source (migration 0032) may still be
 * waiting for a decision: approving posts the message (and its files) to the topic.
 */
export async function releaseApproved(
  db: Db,
  approval: Approval,
  task: Task,
  role: Role,
  topic: Topic,
): Promise<Message> {
  const detail = approval.detail;
  for (const id of detail.attachments ?? []) {
    await db.update(artifacts).set({ topicId: topic.id }).where(eq(artifacts.id, id));
  }
  const msg = await saveMessage(db, topic, "role", role.id, detail.content, {
    mentions: detail.mentions ?? [],
    attachments: detail.attachments ?? [],
    round: task.round + 1,
    taskId: task.id,
    replyToId: detail.reply_to_id ?? (await answeredThread(db, task, topic.id)),
  });
  await dispatchRoleMessage(db, topic, msg, role, task);
  return msg;
}

/** Such a held message was rejected: files that were waiting for it are deleted, not kept around. */
export async function discardHeld(db: Db, approval: Approval): Promise<void> {
  for (const id of approval.detail.attachments ?? []) {
    const [art] = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
    if (art && !art.topicId && !art.deletedAt) {
      await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, id));
      deleteArtifactData(art);
    }
  }
}

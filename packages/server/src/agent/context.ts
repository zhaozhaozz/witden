/**
 * What a role sees when it works on a task: its job description, its agent session in *this* topic (notes
 * from earlier runs whose results were delivered here), recent topic messages it may read, and the brief.
 * Nothing from other topics is included unless the role explicitly references it (read_topic).
 */
import { and, desc, eq, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  agentSessions,
  computerInstances,
  externalConversations,
  externalThreadLinks,
  type Message,
  memories,
  messages,
  type Role,
  type Task,
  type Topic,
  users,
} from "../db/schema.js";
import * as topicSvc from "../services/topics.js";
import type { ChatMessage } from "./llm.js";
import { authorName } from "./tools.js";

const HISTORY_MESSAGES = 30;
const SESSION_NOTES = 8;

export const PLATFORM_RULES = `## How you work (enforced by the platform)
- You are a member of a team, not a personal assistant. Several people may talk to you in the same topic; pay attention to who is asking.
- You only see this topic. Never assume or invent information from other conversations.
- Your tools act only inside your own virtual computer. If it is unavailable, say so; there is no other machine.
- Distinguish chat from work. For plain questions just answer. If a request is unclear, risky or irreversible, use ask_human before acting.
- The desktop is shared with people who may be watching. Hold it only while you need it (release_desktop when done) and prefer a background browser session for work nobody needs to watch.
- If a tool result says an earlier action's outcome is uncertain, look (screenshot, read the file, check the page) before repeating it.
- When you hand work to another role use delegate_task with a self-contained brief, the expected output and only the materials needed. Do not forward unrelated context.
- Talk like a person in a chat: use send_message to answer right away ("looking into it", a partial result, a follow-up) and keep working; you can send several messages for one request. Use post_progress for long tasks so people can follow along.
- You are given the latest messages of this topic; use topic_history to read further back, search it or read a whole thread.
- Never claim something is done if it is not. Report errors and partial results plainly.
- When you are finished, reply with your final answer (no tool call). If you already said everything with send_message, the final answer may be empty and nothing more is posted. Otherwise it is posted to the topic and rendered as Markdown (GitHub style): use headings, lists, tables and code blocks where they help, and a \`\`\`mermaid code block for flowcharts and diagrams. To show a picture from your virtual computer (a screenshot, a chart), share it with share_file: images are displayed in the message.`;

/** For a system administrator role: what its configuration tools are for and where they stop. */
export const ADMIN_RULES = `## You are witden's system administrator
- You configure witden itself for the people in this console: roles, models, computers, connections and knowledge, with read_config and change_config. Each call acts as the person who asked you, with the same checks as in the console, and the audit log records it under your name.
- Read the current configuration before changing it, change only what was asked, and report exactly what you changed and anything that failed.
- Before anything destructive or hard to undo (deleting, resetting a computer, revoking a key), confirm with ask_human unless the person explicitly asked for exactly that.
- Secrets (model API keys, Slack / Feishu / GitHub credentials, the tunnel token, passwords) can be neither read nor set by you. Never ask anyone to paste one into the chat: tell them where to enter it in the console (models: 设置 → 模型; connections: 通讯接入 → 编辑 or the setup guide).
- Accounts are managed by people only: console accounts and passwords (系统管理 → 账号) and linking Slack / Feishu / GitHub accounts to them (通讯接入 → 身份关联).
- System administrator roles, including you, are configured by people only. You work only in the witden console, never on Slack, Feishu or GitHub, and other roles cannot hand you work.`;

export async function systemPrompt(db: Db, task: Task, role: Role, topic: Topic): Promise<string> {
  const [inst] = task.instanceId
    ? await db.select().from(computerInstances).where(eq(computerInstances.id, task.instanceId)).limit(1)
    : [];
  const people: string[] = [];
  for (const p of await topicSvc.participants(db, topic.id, "user")) {
    const [u] = await db.select().from(users).where(eq(users.id, p.participantId)).limit(1);
    if (u) people.push(u.name);
  }
  const others: string[] = [];
  for (const p of await topicSvc.participants(db, topic.id, "role")) {
    const r = await topicSvc.getRole(db, p.participantId);
    if (r && r.id !== role.id) others.push(`@${r.handle} (${r.name}: ${r.description.slice(0, 80)})`);
  }
  const [requester] = task.requesterUserId
    ? await db.select().from(users).where(eq(users.id, task.requesterUserId)).limit(1)
    : [];
  const knowledge = await db
    .select()
    .from(memories)
    .where(and(eq(memories.scope, "role"), eq(memories.roleId, role.id), isNull(memories.deletedAt)))
    .limit(20);
  const prompt = task.roleSnapshot.system_prompt ?? role.systemPrompt;
  const desktop = inst?.spec.desktop;
  const parts = [
    `You are ${role.name} (@${role.handle}), an AI employee of the team.`,
    role.description ? `Responsibilities: ${role.description}` : "",
    prompt,
    "## Where you are",
    inst
      ? `- Computer: ${inst.name} (${inst.spec.kind}), user ${inst.spec.user}, working directory ${inst.spec.workdir}.` +
        (desktop ? ` Desktop ${desktop.width ?? 1280}x${desktop.height ?? 800}.` : " No desktop.")
      : "- You have no computer for this task.",
    `- Topic: «${topic.title}»${topic.goal ? ` — goal: ${topic.goal}` : ""}${topic.kind === "dm" ? " (a private DM)" : ""}`,
    `- People here: ${people.join(", ") || "none"}`,
    `- Other roles here: ${others.join(", ") || "none"}`,
    `- Requested by: ${requester?.name ?? "another role"}`,
    `- Now: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    PLATFORM_RULES,
    role.systemAdmin ? ADMIN_RULES : "",
  ];
  if (knowledge.length) parts.push(`## Job knowledge\n${knowledge.map((m) => `- ${m.content}`).join("\n")}`);
  return parts.filter(Boolean).join("\n");
}

/** Session notes, then recent topic history (participants read the whole topic), then the brief. */
export async function firstUserMessage(db: Db, task: Task, topic: Topic): Promise<string> {
  const [session] = task.sessionId
    ? await db.select().from(agentSessions).where(eq(agentSessions.id, task.sessionId)).limit(1)
    : [];
  const conds = [eq(messages.topicId, topic.id), isNull(messages.deletedAt)];
  if (task.sourceMessageId) {
    const [src] = await db.select().from(messages).where(eq(messages.id, task.sourceMessageId)).limit(1);
    if (src) conds.push(lte(messages.createdAt, src.createdAt));
  }
  const recent = (
    await db
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_MESSAGES)
  ).reverse();
  const lines: string[] = [];
  for (const m of recent) {
    if (m.id === task.sourceMessageId) continue;
    lines.push(await historyLine(db, m));
  }
  let who = "a teammate";
  if (task.requesterUserId) {
    const [u] = await db.select().from(users).where(eq(users.id, task.requesterUserId)).limit(1);
    if (u) who = u.name;
  }
  if (task.requesterRoleId) {
    const r = await topicSvc.getRole(db, task.requesterRoleId);
    if (r) who = `@${r.handle} (on behalf of ${who})`;
  }
  const notes = (session?.notes ?? []).slice(-SESSION_NOTES);
  const sessionPart = notes.length
    ? `Your earlier work in this topic:\n${notes.map((n) => `- [${n.at.slice(0, 16)}] asked: ${n.request}\n  you answered: ${n.result}`).join("\n")}\n\n`
    : "";
  const auto = task.envelope?.auto
    ? "\n\n(Nobody @-mentioned you: this message reached you because the topic answers automatically. Answer only if it needs you; if it is small talk, addressed to someone else, not your responsibility or already handled, call stay_silent instead.)"
    : "";
  const trigger = await triggerInfo(db, task, topic);
  return `${sessionPart}Recent messages in this topic:\n${lines.join("\n") || "(no earlier messages)"}\n\n---\n${trigger}Request from ${who}:\n${task.instruction}${auto}`;
}

const PLATFORMS: Record<string, string> = { slack: "Slack", github: "GitHub", feishu: "Feishu" };
const THREAD_MESSAGES = 20;

async function historyLine(db: Db, m: Message): Promise<string> {
  const where = m.replyToId ? ` (in the thread of ${m.replyToId})` : "";
  return `[${m.id} ${m.createdAt.toISOString().slice(5, 16).replace("T", " ")}] ${await authorName(db, m.authorType, m.authorId)}${where}: ${m.content}`;
}

/**
 * The message being answered: who sent it, where (console, a channel, a Slack thread, a DM, an issue) and
 * when; and the thread so far when it was asked in one. The role's messages go back to the same place.
 */
async function triggerInfo(db: Db, task: Task, topic: Topic): Promise<string> {
  if (!task.sourceMessageId) return "";
  const [src] = await db.select().from(messages).where(eq(messages.id, task.sourceMessageId)).limit(1);
  if (!src) return "";
  const ref = src.externalRef as { conversation?: string } | null;
  let where = "this topic, in the witden console";
  if (ref?.conversation) {
    const [conv] = await db
      .select({
        name: externalConversations.name,
        kind: externalConversations.kind,
        meta: externalThreadLinks.meta,
      })
      .from(externalThreadLinks)
      .innerJoin(externalConversations, eq(externalConversations.id, externalThreadLinks.conversationId))
      .where(and(eq(externalThreadLinks.topicId, topic.id), eq(externalConversations.externalId, ref.conversation)))
      .limit(1);
    const platform = PLATFORMS[src.source] ?? src.source;
    const place = conv?.name ?? ref.conversation;
    const meta = (conv?.meta ?? {}) as { kind?: string; title?: string };
    where =
      conv?.kind === "im"
        ? `a ${platform} direct message`
        : meta.kind === "channel"
          ? `${platform} #${place}, posted directly in the channel`
          : meta.kind
            ? `${platform} ${place}, ${meta.kind.replace("_", " ")} «${meta.title ?? ""}»`
            : `${platform} ${place}`;
  }
  let thread = "";
  if (src.replyToId) {
    const posts = await db
      .select()
      .from(messages)
      .where(
        and(
          or(eq(messages.id, src.replyToId), eq(messages.replyToId, src.replyToId)),
          isNull(messages.deletedAt),
          lte(messages.createdAt, src.createdAt),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(THREAD_MESSAGES);
    const shown: string[] = [];
    for (const m of posts.reverse()) if (m.id !== src.id) shown.push(await historyLine(db, m));
    where = where.replace(", posted directly in the channel", "") + `, as a reply in the thread of ${src.replyToId}`;
    thread = `The thread so far:\n${shown.join("\n") || "(its first message is not in this topic)"}\n\n`;
  }
  return `${thread}The message you are answering:
- From: ${await authorName(db, src.authorType, src.authorId)}
- Where: ${where}
- Sent: ${src.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC
- Message id: ${src.id}
Your messages (send_message and the final answer) go to the same place.

`;
}

export async function initialMessages(db: Db, task: Task, role: Role, topic: Topic): Promise<ChatMessage[]> {
  return [
    { role: "system", content: await systemPrompt(db, task, role, topic) },
    { role: "user", content: await firstUserMessage(db, task, topic) },
  ];
}

/** Remember a delivered result in the role's session for this topic (never results that were withheld). */
export async function recordSessionNote(db: Db, task: Task, result: string): Promise<void> {
  if (!task.sessionId) return;
  const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, task.sessionId)).limit(1);
  if (!session) return;
  const notes = [
    ...session.notes,
    {
      task_id: task.id,
      request: task.instruction.slice(0, 300),
      result: result.slice(0, 600),
      at: new Date().toISOString(),
    },
  ].slice(-20);
  await db
    .update(agentSessions)
    .set({ notes, runs: session.runs + 1, lastRunAt: new Date() })
    .where(eq(agentSessions.id, session.id));
}

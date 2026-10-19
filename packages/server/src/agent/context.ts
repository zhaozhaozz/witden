/**
 * What a role sees when it works.
 *
 * - In its main conversation in a topic (a conversation run): a system prompt that stays the same from one
 *   message to the next (who it is, where, how witden works), then the conversation's own context — what
 *   was new in the topic each time (agent/conversation.ts), its answers and tool calls, or a summary of the
 *   earlier part. Keeping the start identical lets model services reuse their prompt cache.
 * - In an independent task: the same kind of system prompt plus who asked and when, then the brief with
 *   recent topic messages.
 * Both system prompts end with the role's own memory (services/role-memory.ts), the same wherever it works.
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
  messages,
  type Role,
  type Task,
  type Topic,
  users,
} from "../db/schema.js";
import { channelsOf } from "../integrations/links.js";
import { ROLE_MEMORY_SHOWN, roleMemories } from "../services/role-memory.js";
import * as topicSvc from "../services/topics.js";
import type { ChatMessage } from "./llm.js";
import { authorName } from "./tools.js";
import { isConversation } from "./transcript.js";

export const HISTORY_MESSAGES = 30;
export const SESSION_NOTES = 8;

export const PLATFORM_RULES = `## How you work (enforced by the platform)
- You are a member of a team, not a personal assistant. Several people may talk to you in the same topic; pay attention to who is asking.
- You only see this topic. Never assume or invent information from other conversations.
- Your tools act only inside your own virtual computer. If it is unavailable, say so; there is no other machine.
- Distinguish chat from work. For plain questions just answer. If a request is unclear, risky or irreversible, ask before acting.
- The desktop is shared with people who may be watching. Hold it only while you need it (release_desktop when done) and prefer a background browser session for work nobody needs to watch.
- If a tool result says an earlier action's outcome is uncertain, look (screenshot, read the file, check the page) before repeating it.
- When you hand work to another role use delegate_task with a self-contained brief, the expected output and only the materials needed. Do not forward unrelated context.
- Never claim something is done if it is not. Report errors and partial results plainly.
- What you post is rendered as Markdown (GitHub style): use headings, lists, tables and code blocks where they help, and a \`\`\`mermaid code block for flowcharts and diagrams. To show a picture from your virtual computer (a screenshot, a chart), share it with share_file: images are displayed in the message.`;

/** How a role's main conversation in a topic works (conversation runs). */
export const CONVERSATION_RULES = `## Your conversation here
- This is your ongoing conversation in this topic: it keeps its context from one message to the next. What is new in the topic reaches you as a user turn starting with "New in this topic" (messages for you are marked "→ you"), and so do results of tasks and your follow-ups. New messages arrive even while you are working: take them into account right away — a correction or a "stop" changes what you should do.
- Talk like a person in a chat: use send_message to answer right away ("looking into it", a partial result) and keep working; you can send several messages. When you are done for now, end your turn with your final answer (no tool call): it is posted where the latest message for you was asked. If you already said everything with send_message, the final answer may be empty and nothing more is posted.
- To get an answer from someone, ask (ask_human mentions them) and end your turn: their reply arrives here as a new message.
- When messages did not @-mention you (the topic answers automatically) and do not need you, call stay_silent instead of answering.
- For a bigger piece of work that can be done on its own (long research, a build, many files), use start_task: it runs in a separate context and its result comes back here, so this conversation stays focused. delegate_task hands work to another role; its result comes back here too. follow_up_later reminds you here later.
- Use topic_history to read further back in the topic, search it or read a whole thread. When this conversation gets long, its earlier part is replaced by a summary you write; the topic itself keeps every message.`;

/** How an independent task works (it has its own context and ends with its result). */
export const TASK_RULES = `## This task
- This task has its own context: the request and recent messages of the topic are below. Use topic_history to read further back, search the topic or read a whole thread.
- If the request is unclear, risky or irreversible, use ask_human and wait for the answer.
- Use send_message to tell people something right away and keep working; use post_progress for long tasks so people can follow along.
- When you are finished, reply with your final answer (no tool call). If you already said everything with send_message, the final answer may be empty and nothing more is posted.`;

/** For a role with the memory tools: which of the three kinds of notes a thing belongs in. */
export const MEMORY_RULES = `## Memory
Your context stays in this topic and is summarised when it grows long. To keep something for later, save a note with remember and choose its scope by where it will matter again and who may see it there:
- "topic" (the default): this topic only, or this DM when you are in one — decisions, agreements, who does what, open items. People and roles in this topic can see it; it is never used anywhere else.
- "private": about the person who asked you, for them only — their preferences or personal details. It is used only in that person's DMs (with you or another role), never in a group topic.
- "role": your own memory as this role. It is listed under "Your role memory" in every topic, DM, Slack channel, Feishu chat and GitHub thread where you work, so it may come up in front of anyone you talk to there. Use it only for what holds wherever you work: how you should work, team-wide conventions, lessons you learned. Never anything personal or confidential, or what matters in one place only. It can be added only while you work for a witden administrator, and not after reading material restricted to some people.
When in doubt, choose the narrower scope. Write each note so it makes sense on its own later. recall searches the notes you may use here: this topic's, your role memory, the asker's private notes (in their DM) and the knowledge spaces you may read.`;

/** Its latest role memory notes (oldest first), for every prompt of the role; nothing when there are none. */
async function roleMemorySection(db: Db, role: Role, canRecall: boolean): Promise<string> {
  const notes = await roleMemories(db, role.id);
  if (!notes.length) return "";
  const shown = notes.slice(-ROLE_MEMORY_SHOWN);
  const older = notes.length - shown.length;
  const lines = shown.map(
    (m) => `- [${m.createdAt.toISOString().slice(0, 10)}] ${m.content.trim().replace(/\n/g, "\n  ")}`,
  );
  return [
    "## Your role memory",
    "What you keep as this role (some notes may come from administrators). It holds wherever you work.",
    ...lines,
    older ? `(${older} older notes are not listed here${canRecall ? "; recall searches them" : ""}.)` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** For a system administrator role: what its configuration tools are for and where they stop. */
export const ADMIN_RULES = `## You are witden's system administrator
- You configure witden itself for the people in this console: roles, models, computers, connections and knowledge, with read_config and change_config. Each call acts as the person who asked you, with the same checks as in the console, and the audit log records it under your name.
- Read the current configuration before changing it, change only what was asked, and report exactly what you changed and anything that failed.
- Before anything destructive or hard to undo (deleting, resetting a computer, revoking a key), confirm with ask_human unless the person explicitly asked for exactly that.
- Secrets (model API keys, Slack / Feishu / GitHub credentials, the tunnel token, passwords) can be neither read nor set by you. Never ask anyone to paste one into the chat: tell them where to enter it in the console (models: 设置 → 模型; connections: 通讯接入 → 编辑 or the setup guide).
- Accounts are managed by people only: console accounts and passwords (系统管理 → 账号) and linking Slack / Feishu / GitHub accounts to them (通讯接入 → 身份关联).
- System administrator roles, including you, are configured by people only. You work only in the witden console, never on Slack, Feishu or GitHub, and other roles cannot hand you work.`;

const PLATFORM_NAMES: Record<string, string> = { slack: "Slack", github: "GitHub", feishu: "Feishu" };

/** Where the topic's messages are read: the console, or the Slack / Feishu / GitHub conversation it is linked to. */
export async function topicPlace(db: Db, topic: Topic): Promise<string> {
  const ch = (await channelsOf(db, [topic.id])).get(topic.id);
  if (!ch) return topic.kind === "dm" ? "a private DM in the witden console" : "the witden console";
  const platform = PLATFORM_NAMES[ch.platform] ?? ch.platform;
  if (ch.conversation_kind === "im") return `a ${platform} direct message`;
  if (ch.platform === "github") return `${platform} ${ch.conversation_name ?? ""} (${ch.thread_kind ?? "thread"})`;
  const name = ch.conversation_name ?? ch.conversation_id;
  return ch.platform === "feishu" ? `${platform} group chat «${name}»` : `${platform} #${name}`;
}

/** The people and other roles of the topic, as one line (conversations get it when it changes). */
export async function rosterLine(db: Db, topic: Topic, role: Role): Promise<string> {
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
  return `People here: ${people.join(", ") || "none"}. Other roles here: ${others.join(", ") || "none"}.`;
}

export async function systemPrompt(db: Db, task: Task, role: Role, topic: Topic): Promise<string> {
  const [inst] = task.instanceId
    ? await db.select().from(computerInstances).where(eq(computerInstances.id, task.instanceId)).limit(1)
    : [];
  const prompt = task.roleSnapshot.system_prompt ?? role.systemPrompt;
  const desktop = inst?.spec.desktop;
  const conversation = isConversation(task);
  const parts = [
    `You are ${role.name} (@${role.handle}), an AI employee of the team.`,
    role.description ? `Responsibilities: ${role.description}` : "",
    prompt,
    "## Where you are",
    inst
      ? `- Computer: ${inst.name} (${inst.spec.kind}), user ${inst.spec.user}, working directory ${inst.spec.workdir}.` +
        (desktop ? ` Desktop ${desktop.width ?? 1280}x${desktop.height ?? 800}.` : " No desktop.")
      : "- You have no computer for this task.",
    `- Topic: «${topic.title}»${topic.goal ? ` — goal: ${topic.goal}` : ""}${topic.kind === "dm" ? " (a private DM)" : ""}, in ${await topicPlace(db, topic)}`,
  ];
  if (conversation) {
    // Nothing here changes from one message to the next (no time, no asker): who is present and the time
    // arrive with the messages, so the prompt start stays cacheable.
    parts.push(PLATFORM_RULES, CONVERSATION_RULES);
  } else {
    const [requester] = task.requesterUserId
      ? await db.select().from(users).where(eq(users.id, task.requesterUserId)).limit(1)
      : [];
    parts.push(
      `- ${await rosterLine(db, topic, role)}`,
      `- Requested by: ${requester?.name ?? "another role"}`,
      `- Started: ${task.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
      PLATFORM_RULES,
      TASK_RULES,
      task.envelope?.report_only
        ? "- Your final answer goes back to the conversation that started this task; it is not posted to the topic. Put everything that conversation needs in it."
        : "",
    );
  }
  parts.push(role.systemAdmin ? ADMIN_RULES : "");
  // Role memory is read live: a new note changes the prompt (and its cache) from the next model call on.
  const memoryTools = (task.envelope?.tools ?? []).includes("memory");
  parts.push(memoryTools ? MEMORY_RULES : "", await roleMemorySection(db, role, memoryTools));
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

const THREAD_MESSAGES = 20;

export async function historyLine(db: Db, m: Message, limit = 0): Promise<string> {
  const where = m.replyToId ? ` (in the thread of ${m.replyToId})` : "";
  const text =
    limit && m.content.length > limit ? `${m.content.slice(0, limit)}… [cut; topic_history shows it whole]` : m.content;
  return `[${m.id} ${m.createdAt.toISOString().slice(5, 16).replace("T", " ")}] ${await authorName(db, m.authorType, m.authorId)}${where}: ${text}`;
}

/** Where a message was posted: the console, a Slack / Feishu channel or thread, a DM, a GitHub issue or PR. */
export async function messagePlace(db: Db, topic: Topic, src: Message): Promise<string> {
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
    const platform = PLATFORM_NAMES[src.source] ?? src.source;
    const place = conv?.name ?? ref.conversation;
    const meta = (conv?.meta ?? {}) as { kind?: string; title?: string };
    // A whole Slack channel or Feishu group chat is one topic.
    const group = src.source === "feishu" ? `${platform} group chat «${place}»` : `${platform} #${place}`;
    where =
      conv?.kind === "im"
        ? `a ${platform} direct message`
        : meta.kind === "channel"
          ? `${group}, posted directly in it`
          : meta.kind
            ? `${platform} ${place}, ${meta.kind.replace("_", " ")} «${meta.title ?? ""}»`
            : `${platform} ${place}`;
  }
  if (src.replyToId)
    where = where.replace(", posted directly in it", "") + `, as a reply in the thread of ${src.replyToId}`;
  return where;
}

/**
 * The message being answered: who sent it, where (console, a channel, a Slack thread, a DM, an issue) and
 * when; and the thread so far when it was asked in one. The role's messages go back to the same place.
 */
async function triggerInfo(db: Db, task: Task, topic: Topic): Promise<string> {
  if (!task.sourceMessageId) return "";
  const [src] = await db.select().from(messages).where(eq(messages.id, task.sourceMessageId)).limit(1);
  if (!src) return "";
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
    thread = `The thread so far:\n${shown.join("\n") || "(its first message is not in this topic)"}\n\n`;
  }
  return `${thread}The message you are answering:
- From: ${await authorName(db, src.authorType, src.authorId)}
- Where: ${await messagePlace(db, topic, src)}
- Sent: ${src.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC
- Message id: ${src.id}
Your messages (send_message and the final answer) go to the same place.

`;
}

/**
 * The system prompt, and for a task its first user turn (the brief). A conversation's user turns come from
 * its session instead (agent/conversation.ts).
 */
export async function initialMessages(db: Db, task: Task, role: Role, topic: Topic): Promise<ChatMessage[]> {
  const system: ChatMessage = { role: "system", content: await systemPrompt(db, task, role, topic) };
  if (isConversation(task)) return [system];
  return [system, { role: "user", content: await firstUserMessage(db, task, topic) }];
}

/**
 * Remember a delivered result in the role's session for this topic (never results that were withheld).
 * Only tasks from before conversations kept their context still do this; a conversation remembers itself.
 */
export async function recordSessionNote(db: Db, task: Task, result: string): Promise<void> {
  if (!task.sessionId || isConversation(task)) return;
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

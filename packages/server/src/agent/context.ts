/**
 * What a role sees when it works on a task: its job description, its agent session in *this* topic (notes
 * from earlier runs whose results were delivered here), recent topic messages it may read, and the brief.
 * Nothing from other topics is included unless the role explicitly references it (read_topic).
 */
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  agentSessions,
  computerInstances,
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
- Use post_progress for long tasks so people can follow along.
- Never claim something is done if it is not. Report errors and partial results plainly.
- When you are finished, reply with your final answer (no tool call). It is posted to the topic and rendered as Markdown (GitHub style): use headings, lists, tables and code blocks where they help, and a \`\`\`mermaid code block for flowcharts and diagrams. To show a picture from your virtual computer (a screenshot, a chart), share it with share_file: images are displayed in the message.`;

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
    lines.push(
      `[${m.createdAt.toISOString().slice(5, 16).replace("T", " ")}] ${await authorName(db, m.authorType, m.authorId)}: ${m.content}`,
    );
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
  return `${sessionPart}Recent messages in this topic:\n${lines.join("\n") || "(no earlier messages)"}\n\n---\nRequest from ${who}:\n${task.instruction}`;
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

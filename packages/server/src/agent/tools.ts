/**
 * Tools available to AI roles.
 *
 * Tools are the platform's own vocabulary (not a model vendor's). Each belongs to a permission group granted
 * per role (``Role.allowedTools``) and narrowed per task (the envelope). Tools that touch a computer are
 * translated into runner operations and sent through the execution gateway, which binds them to the task's
 * computer; the worker never executes anything itself.
 */
import type { RunnerOp } from "@witden/shared";
import { and, desc, eq, gte, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { GatewayClient } from "../compute/gateway.js";
import { OutcomeUncertain } from "../compute/hub.js";
import { settings } from "../config.js";
import { type Db, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import { memories, messages, modelConfigs, roles, type Task, tasks, topics, users } from "../db/schema.js";
import { BadRequest, Forbidden } from "../errors.js";
import { externalContext } from "../integrations/links.js";
import { spaceLabel, topicLabel, userLabel } from "../security/labels.js";
import { hasPermission, Perm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { configCatalog } from "../services/config-access.js";
import { saveArtifact } from "../services/files.js";
import { releaseTask } from "../services/leases.js";
import * as topicSvc from "../services/topics.js";
import { publishTaskStatus, textRestricted } from "./control.js";
import { delegate } from "./dispatch.js";
import { deliver } from "./output.js";

export const TOOL_GROUPS: Record<string, string> = {
  shell: "Run commands in the role's virtual computer",
  terminal: "Interactive / long-running terminal sessions in the virtual computer",
  files: "Read, write and organise files in the virtual computer, and share them with the topic",
  desktop: "See the virtual computer's screen and use its mouse and keyboard",
  browser: "Drive a browser in the virtual computer (the visible desktop browser or a background one)",
  collaborate: "Message and delegate to other roles (limited by contacts)",
  memory: "Remember and recall scoped notes on the platform",
  topics: "Reference other topics the requester can read",
  config: "Read and change witden's configuration like an administrator in the console (system administrators only)",
  profile: "Change the role's own description, in console conversations only",
};

/** Groups only system administrator roles may have. */
export const ADMIN_TOOL_GROUPS = new Set(["config"]);
/** Groups offered only in console conversations, never in ones linked to Slack, Feishu or GitHub. */
export const CONSOLE_ONLY_GROUPS = new Set(["profile"]);

/**
 * Permissions of a new role unless given: work in its own virtual computer, including sharing files from it
 * into the topic, is always allowed; reaching other roles, platform memory or other topics asks a person
 * first. (Shared files still pass the information-flow check like any other output.)
 */
export const DEFAULT_ALLOWED_TOOLS: string[] = Object.keys(TOOL_GROUPS).filter((g) => !ADMIN_TOOL_GROUPS.has(g));
/** A new system administrator: the configuration tools; it needs no computer. */
export const DEFAULT_ADMIN_TOOLS: string[] = ["config"];
export const DEFAULT_APPROVAL_REQUIRED: string[] = ["collaborate", "memory", "topics", "profile"];

export interface ToolResult {
  content: string | { type: string; [k: string]: any }[];
  labels?: string[];
  /** "wait": the task must pause (status / wait describe for what). "silent": it ends without a reply. */
  control?: "wait" | "silent";
  wait?: Record<string, any>;
  status?: string;
  statusReason?: string;
}

export interface ToolContext {
  taskId: string;
  roleId: string;
  topicId: string;
  toolCallId: string;
  gateway: GatewayClient;
  db: () => Db;
}

export interface ToolSpec {
  name: string;
  group: string | null;
  description: string;
  parameters: Record<string, any>;
  handler: (ctx: ToolContext, args: Record<string, any>) => Promise<ToolResult>;
}

const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const int = { type: "integer" };

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit / 2)}\n...[truncated]...\n${text.slice(-limit / 2)}`;
}

function op(ctx: ToolContext, name: RunnerOp, params: Record<string, unknown>, timeoutMs = 60_000) {
  return ctx.gateway.execute({
    taskId: ctx.taskId,
    toolCallId: ctx.toolCallId,
    op: name,
    params,
    timeoutMs,
  }) as Promise<any>;
}

async function load(ctx: ToolContext, db: Db) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, ctx.taskId)).limit(1);
  const [role] = await db.select().from(roles).where(eq(roles.id, ctx.roleId)).limit(1);
  const [topic] = await db.select().from(topics).where(eq(topics.id, ctx.topicId)).limit(1);
  if (!task || !role || !topic) throw new BadRequest("task context missing");
  return { task, role, topic };
}

const holdForApproval = (
  approvalId: string,
  ctx: ToolContext,
  reason: string,
  then?: Record<string, any>,
): ToolResult => ({
  content: "held until the owners of the material approve sharing it here",
  control: "wait",
  status: "waiting_approval",
  statusReason: reason,
  wait: { type: "approval", approval_id: approvalId, tool_call_id: ctx.toolCallId, ...(then ? { then } : {}) },
});

// --- computer: shell, terminals, files ------------------------------------------------------------------

async function runCommand(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const timeout = Math.max(1, Math.min(Number(args.timeout_seconds ?? 120), 1800));
  const r = await op(
    ctx,
    "exec.run",
    { command: String(args.command ?? ""), cwd: args.workdir, outputLimit: 64 * 1024 },
    timeout * 1000,
  );
  const status = r.timedOut ? "timed out (process tree killed)" : `exit code ${r.exitCode}`;
  return {
    content: `[${status}]${r.truncated ? " [output truncated]" : ""}\n${clip(r.output, settings().toolOutputLimit)}`,
  };
}

async function terminalStart(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const r = await op(ctx, "terminal.create", { command: String(args.command ?? ""), cwd: args.workdir }, 30_000);
  return { content: `started terminal session ${r.sessionId}; use terminal_read to see output` };
}

async function terminalRead(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const r = await op(
    ctx,
    "terminal.read",
    { sessionId: String(args.session ?? ""), lines: Number(args.lines ?? 200) },
    30_000,
  );
  const state = r.running ? "still running" : "idle (command finished)";
  return {
    content: `[session ${r.sessionId}: ${state}, foreground=${r.foreground}]\n${clip(r.output, settings().toolOutputLimit)}`,
  };
}

async function terminalInput(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  await op(
    ctx,
    "terminal.input",
    { sessionId: String(args.session ?? ""), text: String(args.text ?? ""), enter: args.enter !== false },
    30_000,
  );
  return { content: "input sent" };
}

async function terminalControl(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const sessionId = String(args.session ?? "");
  if (args.action === "interrupt") {
    await op(ctx, "terminal.key", { sessionId, key: "C-c" }, 30_000);
    return { content: `interrupt sent to ${sessionId}` };
  }
  if (args.action === "kill") {
    const r = await op(ctx, "terminal.kill", { sessionId }, 30_000);
    return { content: `killed ${sessionId} (${r.killed} processes stopped)` };
  }
  throw new BadRequest("action must be interrupt or kill");
}

async function readFile(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const r = await op(ctx, "file.read", { path: String(args.path ?? ""), maxBytes: 5_000_000 }, 60_000);
  const data = Buffer.from(r.contentBase64, "base64");
  const text = data.toString("utf8");
  if (text.includes("�") && data.includes(0))
    return { content: `binary file (${data.length} bytes); use run_command to inspect it` };
  return { content: clip(text, Math.min(Number(args.max_chars ?? settings().toolOutputLimit), 100_000)) };
}

async function writeFile(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const content = String(args.content ?? "");
  const r = await op(
    ctx,
    "file.write",
    { path: String(args.path ?? ""), contentBase64: Buffer.from(content).toString("base64") },
    60_000,
  );
  return { content: `wrote ${content.length} characters to ${r.path}` };
}

async function listDirectory(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const entries: any[] = await op(ctx, "file.list", { path: String(args.path || ".") }, 30_000);
  const lines = entries.map(
    (e) => `${e.type === "dir" ? "d" : "-"} ${String(e.size).padStart(10)} ${e.mtime.slice(0, 16)} ${e.name}`,
  );
  return { content: clip(lines.join("\n") || "(empty)", settings().toolOutputLimit) };
}

async function moveFile(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  await op(ctx, "file.move", { from: String(args.from ?? ""), to: String(args.to ?? "") }, 30_000);
  return { content: `moved ${args.from} to ${args.to}` };
}

/** Copy a file out of the computer into the topic. Same output check as messages; held files stay detached. */
async function shareFile(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const path = String(args.path ?? "");
  const r = await op(ctx, "file.read", { path, maxBytes: 50_000_000 }, 120_000);
  return transaction(async (db) => {
    const { task, role, topic } = await load(ctx, db);
    const art = await saveArtifact(db, Buffer.from(r.contentBase64, "base64"), {
      name: path,
      kind: "generated",
      labels: [...task.labels],
      topicId: null, // not listed or downloadable in the topic until the output check passes
      taskId: task.id,
      instanceId: task.instanceId,
      createdByType: "role",
      createdById: role.id,
    });
    const note = String(args.message || `Shared file ${art.name}`);
    const result = await deliver(db, task, role, topic, note, {
      final: false,
      attachments: [art.id],
      toolCallId: ctx.toolCallId,
    });
    if (result.approval) return holdForApproval(result.approval.id, ctx, "waiting for approval to share a file");
    const { artifacts } = await import("../db/schema.js");
    await db.update(artifacts).set({ topicId: topic.id }).where(eq(artifacts.id, art.id));
    return { content: `shared ${art.name} (${art.size} bytes) in the topic` };
  });
}

// --- computer: desktop and browser -----------------------------------------------------------------------

async function visionAllowed(db: Db, roleId: string): Promise<boolean> {
  const [role] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role?.modelConfigId) return true;
  const [cfg] = await db.select().from(modelConfigs).where(eq(modelConfigs.id, role.modelConfigId)).limit(1);
  return cfg?.capabilities?.vision !== false;
}

function imageResult(caption: string, pngBase64: string): ToolResult {
  return {
    content: [
      { type: "text", text: caption },
      { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
    ],
  };
}

async function screenshot(ctx: ToolContext): Promise<ToolResult> {
  if (!(await visionAllowed(ctx.db(), ctx.roleId))) {
    throw new BadRequest("the configured model cannot understand images; give this role a vision-capable model first");
  }
  const r = await op(ctx, "screen.capture", {}, 30_000);
  return imageResult(`Current screen (${r.width}x${r.height}):`, r.pngBase64);
}

async function mouse(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  await op(
    ctx,
    "input.mouse",
    {
      action: args.action ?? "click",
      x: args.x,
      y: args.y,
      toX: args.to_x,
      toY: args.to_y,
      button: args.button ?? "left",
      amount: args.amount ?? 3,
    },
    30_000,
  );
  return { content: "ok (take a screenshot to verify the result)" };
}

async function keyboard(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  if (!args.text && !args.keys) throw new BadRequest("give either text or keys");
  await op(ctx, "input.keyboard", args.text ? { text: String(args.text) } : { keys: String(args.keys) }, 120_000);
  return { content: "ok" };
}

async function releaseDesktop(ctx: ToolContext): Promise<ToolResult> {
  await releaseTask(ctx.db(), ctx.taskId);
  return { content: "desktop released; other roles may use it now" };
}

function browserInfo(r: any): string {
  const mode =
    r.mode === "background"
      ? "background browser (not the visible desktop)"
      : "desktop browser (visible to people watching)";
  return `[${mode}] session ${r.sessionId}: ${r.title} — ${r.url}`;
}

async function browserOpen(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const mode = args.mode === "background" ? "background" : "desktop";
  const r = await op(ctx, "browser.open", { url: String(args.url ?? ""), mode, sessionId: args.session }, 90_000);
  return { content: `${browserInfo(r)}\nUse browser_snapshot to read the page.` };
}

async function browserSnapshot(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const r = await op(ctx, "browser.snapshot", { sessionId: String(args.session ?? "") }, 60_000);
  const elements = (r.elements ?? []).slice(0, 200).map((e: any) => `[${e.ref}] ${e.role}: ${e.name}`);
  return {
    content: clip(
      `${browserInfo(r)}\n\n${r.text}\n\nInteractive elements:\n${elements.join("\n")}`,
      settings().toolOutputLimit,
    ),
  };
}

const target = (args: Record<string, any>) => ({
  sessionId: String(args.session ?? ""),
  ref: args.ref,
  selector: args.selector,
  text: args.text,
});

async function browserClick(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const r = await op(ctx, "browser.click", target(args), 60_000);
  return { content: `clicked; now at ${r?.url ?? "(same page)"}` };
}

async function browserType(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  await op(ctx, "browser.type", { ...target(args), value: String(args.value ?? ""), submit: !!args.submit }, 60_000);
  return { content: "typed" };
}

async function browserDownload(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const r = await op(ctx, "browser.download", target(args), 300_000);
  return { content: `downloaded ${r.suggestedName} (${r.size} bytes) to ${r.path}` };
}

async function browserScreenshot(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  if (!(await visionAllowed(ctx.db(), ctx.roleId)))
    throw new BadRequest("the configured model cannot understand images");
  const r = await op(ctx, "browser.screenshot", { sessionId: String(args.session ?? "") }, 60_000);
  return imageResult("Browser page:", r.pngBase64);
}

async function browserClose(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  await op(ctx, "browser.close", { sessionId: String(args.session ?? "") }, 30_000);
  return { content: "browser session closed" };
}

// --- collaboration ---------------------------------------------------------------------------------------

async function messageRole(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const handle = String(args.role ?? "").replace(/^@/, "");
  return transaction(async (db) => {
    const { task, role, topic } = await load(ctx, db);
    const [targetRole] = await db.select().from(roles).where(eq(roles.handle, handle)).limit(1);
    if (!targetRole) throw new BadRequest(`no role @${handle}`);
    if (!(await topicSvc.participant(db, topic.id, "role", targetRole.id))) {
      await topicSvc.inviteRole(db, null, topic, targetRole.id, { byRole: role });
    }
    const result = await deliver(db, task, role, topic, `@${targetRole.handle} ${args.message ?? ""}`, {
      final: false,
      mentions: [{ type: "role", id: targetRole.id }],
      toolCallId: ctx.toolCallId,
    });
    if (result.approval) return holdForApproval(result.approval.id, ctx, "waiting for approval to post a message");
    return { content: `message posted; @${handle} will respond in the topic` };
  });
}

/** Post in this topic now and keep working: a person answers in several messages, so may a role. */
async function sendMessage(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const text = String(args.text ?? "").trim();
  if (!text) throw new BadRequest("text is required");
  return transaction(async (db) => {
    const { task, role, topic } = await load(ctx, db);
    const result = await deliver(db, task, role, topic, text.slice(0, 20_000), {
      final: false,
      toolCallId: ctx.toolCallId,
    });
    if (result.approval) return holdForApproval(result.approval.id, ctx, "waiting for approval to post a message");
    return { content: "sent" };
  });
}

const HISTORY_LIMIT = 100;

/**
 * Read this topic beyond the recent messages given at the start: page back, search, or read one Slack thread.
 * Lines carry message ids, so a thread or an earlier page can be asked for next.
 */
async function topicHistory(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const db = ctx.db();
  const { topic } = await load(ctx, db);
  const conds = [eq(messages.topicId, topic.id), isNull(messages.deletedAt)];
  if (args.query) conds.push(ilike(messages.content, `%${String(args.query)}%`));
  if (args.thread) {
    // a thread: its first message and the replies pointing at it
    const root = String(args.thread);
    conds.push(or(eq(messages.id, root), eq(messages.replyToId, root))!);
  }
  if (args.before) {
    const [mark] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, String(args.before)))
      .limit(1);
    const at = mark?.createdAt ?? new Date(String(args.before));
    if (Number.isNaN(at.getTime())) throw new BadRequest("before must be a message id or a time");
    conds.push(lt(messages.createdAt, at));
  }
  const limit = Math.max(1, Math.min(Number(args.limit ?? 30), HISTORY_LIMIT));
  const rows = (
    await db
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.createdAt))
      .limit(limit)
  ).reverse();
  const lines: string[] = [];
  for (const m of rows) {
    const where = m.replyToId ? ` (in the thread of ${m.replyToId})` : "";
    lines.push(
      `[${m.id} ${m.createdAt.toISOString().slice(0, 16).replace("T", " ")}] ${await authorName(db, m.authorType, m.authorId)}${where}: ${m.content}`,
    );
  }
  const total = (
    await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(...conds))
  )[0].n;
  return {
    content: `${Number(total)} matching message(s) in this topic, oldest first; showing the latest ${rows.length}.\n${lines.join("\n") || "(none)"}`,
    labels: [topicLabel(topic.id)],
  };
}

async function delegateTask(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const childId = await transaction(async (db) => {
    const { task, role } = await load(ctx, db);
    const child = await delegate(
      db,
      task,
      role,
      String(args.role ?? ""),
      String(args.task ?? ""),
      String(args.expected_output ?? ""),
      String(args.materials ?? ""),
    );
    return child.id;
  });
  return {
    content: `delegated as task ${childId}; you will get the result when it finishes`,
    control: "wait",
    status: "waiting_children",
    statusReason: "waiting for delegated work",
    wait: { type: "children", child_ids: [childId], tool_call_id: ctx.toolCallId },
  };
}

async function askHuman(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  return transaction(async (db) => {
    const { task, role, topic } = await load(ctx, db);
    const people: (typeof users.$inferSelect)[] = [];
    for (const ref of args.people ?? []) {
      const key = String(ref).replace(/^@/, "").toLowerCase();
      for (const p of await topicSvc.participants(db, topic.id, "user")) {
        const [u] = await db.select().from(users).where(eq(users.id, p.participantId)).limit(1);
        if (u && (u.id === key || u.name.toLowerCase() === key) && !people.some((x) => x.id === u.id)) people.push(u);
      }
    }
    if (!people.length && task.requesterUserId) {
      const [u] = await db.select().from(users).where(eq(users.id, task.requesterUserId)).limit(1);
      if (u) people.push(u);
    }
    await rateLimitMentions(
      db,
      topic.id,
      people.map((u) => u.id),
    );
    const names = people.map((u) => `@${u.name}`).join(" ");
    const wait = { type: "human", user_ids: people.map((u) => u.id), tool_call_id: ctx.toolCallId };
    const result = await deliver(db, task, role, topic, `${names} ${args.question ?? ""}`.trim(), {
      final: false,
      mentions: people.map((u) => ({ type: "user" as const, id: u.id })),
      toolCallId: ctx.toolCallId,
    });
    if (result.approval)
      return holdForApproval(result.approval.id, ctx, "waiting for approval to post a question", wait);
    return {
      content: "question posted",
      control: "wait",
      status: "waiting_human",
      statusReason: `waiting for ${names || "a person"}`,
      wait,
    };
  });
}

/** Roles may @ people, but not flood them. */
async function rateLimitMentions(db: Db, topicId: string, userIds: string[], perHour = 6): Promise<void> {
  const since = new Date(Date.now() - 3600_000);
  const recent = await db
    .select()
    .from(messages)
    .where(and(eq(messages.topicId, topicId), eq(messages.authorType, "role"), gte(messages.createdAt, since)));
  for (const uid of userIds) {
    if (recent.filter((m) => m.mentions.some((x) => x.id === uid)).length >= perHour) {
      throw new Forbidden("too many mentions of this person in the last hour; wait for their reply");
    }
  }
}

async function postProgress(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  return transaction(async (db) => {
    const { task } = await load(ctx, db);
    // Progress notes are visible to the whole topic, so they get the same check as messages.
    const restricted = await textRestricted(db, task);
    const progress = restricted
      ? "(progress details withheld: they draw on restricted material)"
      : String(args.progress ?? "").slice(0, 2000);
    const [row] = await db.update(tasks).set({ progress }).where(eq(tasks.id, task.id)).returning();
    await publishTaskStatus(db, row);
    return {
      content: restricted
        ? "progress recorded, but its text is not shown because it draws on restricted material"
        : "progress updated",
    };
  });
}

/** Pause this task and pick it up again later (check on a long build, a pending reply...). */
async function stayQuiet(_ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  return { content: `no reply: ${String(args.reason ?? "").slice(0, 300)}`, control: "silent" };
}

async function followUpLater(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const minutes = Math.max(1, Math.min(Number(args.minutes ?? 30), 7 * 24 * 60));
  const until = new Date(Date.now() + minutes * 60_000);
  return {
    content: `will resume at ${until.toISOString()}`,
    control: "wait",
    status: "waiting_timer",
    statusReason: `follow-up scheduled in ${minutes} min`,
    wait: {
      type: "timer",
      until: until.toISOString(),
      note: String(args.reason ?? "follow up"),
      tool_call_id: ctx.toolCallId,
    },
  };
}

// --- memory and references -----------------------------------------------------------------------------

async function remember(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const scope = args.scope ?? "topic";
  return transaction(async (db) => {
    const { task, topic } = await load(ctx, db);
    const base = {
      id: newId("mem"),
      roleId: ctx.roleId,
      content: String(args.content ?? ""),
      sourceMessageIds: task.sourceMessageId ? [task.sourceMessageId] : [],
      createdByType: "role",
      createdById: ctx.roleId,
    };
    if (scope === "topic") {
      if (await textRestricted(db, task)) {
        throw new Forbidden(
          "this note draws on material not everyone in the topic may see; use scope 'private' or ask its owner to share it",
        );
      }
      await db.insert(memories).values({ ...base, scope: "topic", topicId: topic.id, labels: [...task.labels] });
    } else if (scope === "private") {
      if (!task.requesterUserId) throw new BadRequest("private memory needs a human requester");
      await db.insert(memories).values({
        ...base,
        scope: "user",
        userId: task.requesterUserId,
        labels: [...new Set([...task.labels, userLabel(task.requesterUserId)])],
      });
    } else throw new BadRequest("scope must be topic or private (role knowledge is curated by people)");
    return { content: `remembered (${scope})` };
  });
}

const score = (text: string, words: string[]) =>
  words.reduce((n, w) => n + (text.toLowerCase().split(w).length - 1), 0);

async function recall(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const db = ctx.db();
  const words = String(args.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const { task, topic } = await load(ctx, db);
  const [requester] = task.requesterUserId
    ? await db.select().from(users).where(eq(users.id, task.requesterUserId)).limit(1)
    : [];
  const rows: [string, typeof memories.$inferSelect][] = [];
  const live = isNull(memories.deletedAt);
  for (const m of await db
    .select()
    .from(memories)
    .where(and(live, eq(memories.scope, "role"), eq(memories.roleId, ctx.roleId))))
    rows.push(["role knowledge", m]);
  for (const m of await db
    .select()
    .from(memories)
    .where(and(live, eq(memories.scope, "topic"), eq(memories.topicId, topic.id))))
    rows.push(["this topic", m]);
  for (const spaceId of task.envelope.spaces ?? []) {
    if (requester && (await hasPermission(db, requester, Perm.KNOWLEDGE_READ, spaceId))) {
      for (const m of await db
        .select()
        .from(memories)
        .where(and(live, eq(memories.scope, "team"), eq(memories.spaceId, spaceId)))) {
        rows.push([`team space ${spaceId}`, m]);
      }
    }
  }
  // A person's private notes are only consulted in their own DM.
  if (requester && topic.kind === "dm" && (await topicSvc.participant(db, topic.id, "user", requester.id))) {
    for (const m of await db
      .select()
      .from(memories)
      .where(and(live, eq(memories.scope, "user"), eq(memories.userId, requester.id)))) {
      rows.push([`private notes of ${requester.name}`, m]);
    }
  }
  const hits = (
    words.length
      ? rows
          .filter(([, m]) => score(m.content, words) > 0)
          .sort((a, b) => score(b[1].content, words) - score(a[1].content, words))
      : rows
  ).slice(0, 8);
  const labels: string[] = [];
  for (const [, m] of hits) {
    labels.push(...m.labels);
    if (m.scope === "team" && m.spaceId) labels.push(spaceLabel(m.spaceId));
  }
  return {
    content: hits.map(([src, m]) => `- (${src}) ${m.content}`).join("\n") || "nothing relevant remembered",
    labels,
  };
}

/** Explicit cross-topic reference, checked against the requester's access; the source is labelled. */
async function readTopic(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const db = ctx.db();
  const { task } = await load(ctx, db);
  const [requester] = task.requesterUserId
    ? await db.select().from(users).where(eq(users.id, task.requesterUserId)).limit(1)
    : [];
  const [source] = await db
    .select()
    .from(topics)
    .where(eq(topics.id, String(args.topic_id ?? "")))
    .limit(1);
  if (!source || !requester || !(await topicSvc.canView(db, requester, source))) {
    throw new Forbidden("the requester cannot read that topic (or it does not exist)");
  }
  const msgs = await topicSvc.visibleMessages(db, source, { limit: Number(args.limit ?? 40) });
  const lines: string[] = [];
  for (const m of msgs)
    lines.push(
      `[${m.createdAt.toISOString().slice(0, 16)}] ${await authorName(db, m.authorType, m.authorId)}: ${m.content}`,
    );
  return {
    content: `Source: topic «${source.title}» (${source.id}). Cite it when you use this.\n${lines.join("\n") || "(no messages)"}`,
    labels: [topicLabel(source.id)],
  };
}

export async function authorName(db: Db, type: string, id: string | null): Promise<string> {
  if (type === "user" && id)
    return (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]?.name ?? "member";
  if (type === "role" && id) {
    const [r] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
    return r ? `@${r.handle}` : "role";
  }
  return "system";
}

// --- the role's own description ---------------------------------------------------------------------------

const DESCRIPTION_LIMIT = 500;

/** Rewrite the role's own description (职责说明), nothing else. Console conversations only; asks first by default. */
async function updateMyDescription(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const description = String(args.description ?? "").trim();
  if (!description) throw new BadRequest("description is required");
  if (description.length > DESCRIPTION_LIMIT)
    throw new BadRequest(`keep your description under ${DESCRIPTION_LIMIT} characters`);
  return transaction(async (db) => {
    const { task, role, topic } = await load(ctx, db);
    // Checked again here: the topic may have been shared to Slack since the task started.
    if ((await externalContext(db, topic.id)).conversationKind)
      throw new Forbidden(
        "your description can be changed only in console conversations, not from Slack, Feishu or GitHub",
      );
    if (await textRestricted(db, task))
      throw new Forbidden(
        "this task drew on material not everyone here may see, and your description is shown to everyone",
      );
    await db.update(roles).set({ description }).where(eq(roles.id, role.id));
    await audit(db, "role.update", {
      actorType: "role",
      actorId: role.id,
      resourceType: "role",
      resourceId: role.id,
      roleId: role.id,
      taskId: task.id,
      topicId: topic.id,
      detail: { fields: ["description"], tool: "update_my_description" },
    });
    return { content: `your description is now: ${description}` };
  });
}

// --- witden's configuration (system administrators) -----------------------------------------------------

const CONFIG_RESULT_LIMIT = 30_000;

/** One call to witden's own API, run by the API process as the person who asked (services/config-access.ts). */
async function configCall(ctx: ToolContext, method: string, path: string, body?: unknown): Promise<ToolResult> {
  let res: { status: number; body: unknown };
  try {
    res = await ctx.gateway.config({ taskId: ctx.taskId, toolCallId: ctx.toolCallId, method, path, body });
  } catch (err) {
    // Not a computer: there is nothing to wait for, but a change may have gone through.
    if (err instanceof OutcomeUncertain)
      return {
        content: `error: witden's API could not be reached (${err.message}); a change may or may not have been made, read the configuration before trying again`,
      };
    throw err;
  }
  const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
  return { content: clip(`HTTP ${res.status}\n${text}`, CONFIG_RESULT_LIMIT) };
}

async function readConfig(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  return configCall(ctx, "GET", String(args.path ?? ""));
}

async function changeConfig(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const method = String(args.method ?? "").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method))
    throw new BadRequest("method must be POST, PUT, PATCH or DELETE (read with read_config)");
  return configCall(ctx, method, String(args.path ?? ""), args.body ?? {});
}

// --- registry ---------------------------------------------------------------------------------------------

const spec = (
  name: string,
  group: string | null,
  description: string,
  parameters: Record<string, any>,
  handler: ToolSpec["handler"],
): ToolSpec => ({
  name,
  group,
  description,
  parameters,
  handler,
});

const session = { session: str };
const targetArgs = {
  session: str,
  ref: { type: "string", description: "element ref from browser_snapshot" },
  selector: str,
  text: { type: "string", description: "visible text of the element" },
};

export const TOOLS: Map<string, ToolSpec> = new Map(
  [
    spec(
      "run_command",
      "shell",
      "Run a shell command in your computer and wait for it to finish.",
      obj({ command: str, timeout_seconds: { type: "number" }, workdir: str }, ["command"]),
      runCommand,
    ),
    spec(
      "terminal_start",
      "terminal",
      "Start a long-running or interactive command in a terminal session.",
      obj({ command: str, workdir: str }, ["command"]),
      terminalStart,
    ),
    spec(
      "terminal_read",
      "terminal",
      "Read the latest output of a terminal session.",
      obj({ session: str, lines: int }, ["session"]),
      terminalRead,
    ),
    spec(
      "terminal_input",
      "terminal",
      "Type input into a terminal session (e.g. answer a prompt).",
      obj({ session: str, text: str, enter: { type: "boolean" } }, ["session", "text"]),
      terminalInput,
    ),
    spec(
      "terminal_control",
      "terminal",
      "Interrupt (Ctrl-C) or kill a terminal session and its processes.",
      obj({ session: str, action: { type: "string", enum: ["interrupt", "kill"] } }, ["session", "action"]),
      terminalControl,
    ),
    spec(
      "read_file",
      "files",
      "Read a text file from your computer.",
      obj({ path: str, max_chars: int }, ["path"]),
      readFile,
    ),
    spec(
      "write_file",
      "files",
      "Create or overwrite a text file in your computer.",
      obj({ path: str, content: str }, ["path", "content"]),
      writeFile,
    ),
    spec("list_directory", "files", "List a directory in your computer.", obj({ path: str }), listDirectory),
    spec(
      "move_file",
      "files",
      "Move or rename a file in your computer.",
      obj({ from: str, to: str }, ["from", "to"]),
      moveFile,
    ),
    spec(
      "share_file",
      "files",
      "Share a file from your computer with the topic as an attachment.",
      obj({ path: str, message: str }, ["path"]),
      shareFile,
    ),
    spec("screenshot", "desktop", "Capture the current screen of your computer's desktop.", obj({}), (ctx) =>
      screenshot(ctx),
    ),
    spec(
      "mouse",
      "desktop",
      "Mouse action on your desktop: move, click, double_click, drag or scroll.",
      obj(
        {
          action: { type: "string", enum: ["move", "click", "double_click", "drag", "scroll"] },
          x: int,
          y: int,
          to_x: int,
          to_y: int,
          button: { type: "string", enum: ["left", "middle", "right"] },
          amount: { type: "integer", description: "scroll steps, negative = up" },
        },
        ["action", "x", "y"],
      ),
      mouse,
    ),
    spec(
      "keyboard",
      "desktop",
      "Type text, or press keys such as 'ctrl+l' or 'Return', on your desktop.",
      obj({ text: str, keys: str }),
      keyboard,
    ),
    spec(
      "release_desktop",
      "desktop",
      "Give up control of the desktop when you are done with it for now.",
      obj({}),
      (ctx) => releaseDesktop(ctx),
    ),
    spec(
      "browser_open",
      "browser",
      "Open a URL. mode 'desktop' (default) uses the browser people see on the computer and can take over; 'background' uses a separate hidden browser.",
      obj({ url: str, mode: { type: "string", enum: ["desktop", "background"] }, session: str }, ["url"]),
      browserOpen,
    ),
    spec(
      "browser_snapshot",
      "browser",
      "Read the current page: text and interactive elements with refs.",
      obj(session, ["session"]),
      browserSnapshot,
    ),
    spec(
      "browser_click",
      "browser",
      "Click an element (by ref from the snapshot, CSS selector, or visible text).",
      obj(targetArgs, ["session"]),
      browserClick,
    ),
    spec(
      "browser_type",
      "browser",
      "Type into an input (by ref, selector or text); optionally submit.",
      obj({ ...targetArgs, value: str, submit: { type: "boolean" } }, ["session", "value"]),
      browserType,
    ),
    spec(
      "browser_download",
      "browser",
      "Click a download link/button and save the file in the computer.",
      obj(targetArgs, ["session"]),
      browserDownload,
    ),
    spec(
      "browser_screenshot",
      "browser",
      "Screenshot of the browser page.",
      obj(session, ["session"]),
      browserScreenshot,
    ),
    spec("browser_close", "browser", "Close a browser session.", obj(session, ["session"]), browserClose),
    spec(
      "message_role",
      "collaborate",
      "Post a message in this topic addressed to another role.",
      obj({ role: str, message: str }, ["role", "message"]),
      messageRole,
    ),
    spec(
      "delegate_task",
      "collaborate",
      "Hand a piece of work to another role. Give a self-contained brief, the expected output and only the materials it needs. You wait until it reports back.",
      obj({ role: str, task: str, expected_output: str, materials: str }, ["role", "task", "expected_output"]),
      delegateTask,
    ),
    spec(
      "remember",
      "memory",
      "Save a note: scope 'topic' (this topic) or 'private' (the requester only).",
      obj({ content: str, scope: { type: "string", enum: ["topic", "private"] } }, ["content"]),
      remember,
    ),
    spec(
      "recall",
      "memory",
      "Search notes and knowledge you are allowed to use here.",
      obj({ query: str }, ["query"]),
      recall,
    ),
    spec(
      "read_topic",
      "topics",
      "Read another topic the requester has access to (by id). Cite the source.",
      obj({ topic_id: str, limit: int }, ["topic_id"]),
      readTopic,
    ),
    spec(
      "update_my_description",
      "profile",
      "Rewrite your own description (职责说明): the short introduction people see when choosing whom to ask. Describe your responsibilities only; everyone can see it, so never include confidential details or anything from private conversations. Only in console conversations; a person may have to approve it first.",
      obj({ description: { type: "string", description: `at most ${DESCRIPTION_LIMIT} characters` } }, ["description"]),
      updateMyDescription,
    ),
    spec(
      "read_config",
      "config",
      `Read witden's configuration through its API, as the person who asked you. Secrets (keys, tokens, passwords) are never returned. Paths (query strings allowed):\n${configCatalog("read")}`,
      obj({ path: { type: "string", description: "e.g. /api/roles" } }, ["path"]),
      readConfig,
    ),
    spec(
      "change_config",
      "config",
      `Change witden's configuration through its API, as the person who asked you, with the same checks as in the console. Bodies are JSON with snake_case fields; read the current state first and say what you changed. Secrets (model API keys, connection credentials, tunnel tokens, passwords) can be neither read nor set: tell the person to enter them in the console. Endpoints:\n${configCatalog("change")}`,
      obj(
        {
          method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string", description: "e.g. /api/roles/role_123" },
          body: { type: "object", description: "JSON body (omit for DELETE)" },
        },
        ["method", "path"],
      ),
      changeConfig,
    ),
    spec(
      "ask_human",
      null,
      "Ask people in this topic a question (clarification, a decision, a login or approval) and wait for the answer. Defaults to the requester.",
      obj({ question: str, people: { type: "array", items: str } }, ["question"]),
      askHuman,
    ),
    spec(
      "send_message",
      null,
      "Post a message in this topic right away and keep working, as a person would: an acknowledgement, a partial result, a question to the room, a follow-up. You can send several. It goes where the request was asked (the channel, or the Slack thread).",
      obj({ text: str }, ["text"]),
      sendMessage,
    ),
    spec(
      "topic_history",
      null,
      "Read more of this topic than the recent messages you were given: page back (before a message id or time), search for words (query), or read one Slack thread (thread = the id of its first message). Lines start with message ids.",
      obj({ query: str, before: str, thread: str, limit: int }),
      topicHistory,
    ),
    spec(
      "post_progress",
      null,
      "Update the visible progress note of this task.",
      obj({ progress: str }, ["progress"]),
      postProgress,
    ),
    spec(
      "stay_silent",
      null,
      "Nobody @-mentioned you: if this message does not need you (small talk, people talking to each other, not your responsibility, already handled), end here without posting anything.",
      obj({ reason: str }, []),
      stayQuiet,
    ),
    spec(
      "follow_up_later",
      null,
      "Pause this task and resume it after some minutes, to follow up on something that takes time.",
      obj({ minutes: int, reason: str }, ["minutes", "reason"]),
      followUpLater,
    ),
  ].map((t) => [t.name, t]),
);

export function toolsFor(envelope: Record<string, any>): ToolSpec[] {
  const groups = new Set<string>(envelope.tools ?? []);
  return [...TOOLS.values()].filter(
    (t) =>
      (t.group === null || groups.has(t.group)) &&
      // Declining to answer is for messages that reached the role without an @-mention.
      (t.name !== "stay_silent" || !!envelope.auto) &&
      // The configuration tools only for a system administrator's own work.
      (!t.group || !ADMIN_TOOL_GROUPS.has(t.group) || !!envelope.system_admin) &&
      // Some only where the conversation stays in the console.
      (!t.group || !CONSOLE_ONLY_GROUPS.has(t.group) || !envelope.outside),
  );
}

export function needsApproval(envelope: Record<string, any>, tool: ToolSpec): boolean {
  const required = new Set<string>(envelope.approval_required ?? []);
  return required.has(tool.name) || (tool.group !== null && required.has(tool.group));
}

/** Tools whose effect inside the computer cannot be safely repeated after an interruption. */
export const SIDE_EFFECT_TOOLS = new Set([
  "run_command",
  "terminal_start",
  "terminal_input",
  "terminal_control",
  "write_file",
  "move_file",
  "mouse",
  "keyboard",
  "browser_open",
  "browser_click",
  "browser_type",
  "browser_download",
  "browser_close",
]);

export type { Task };

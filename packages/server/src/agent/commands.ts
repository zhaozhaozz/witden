/**
 * Commands roles run in their computer (run_command), recorded in background_commands.
 *
 * - A command is never killed because nobody waits for it any more. run_command waits up to its timeout; a
 *   command still running then goes on in the background, and so does one started with background: true.
 *   Its whole output stays in a log file in the computer; tool results carry one excerpt (the runner cuts it
 *   to the tool output limit) and the path.
 * - The end of a background command is told once (notifiedAt, set under the row lock) to the work that
 *   started it: a conversation gets it in its inbox (agent/conversation.ts), which wakes it when idle; an
 *   independent task still under way reads it at its next step, and one waiting on a timer (follow_up_later,
 *   command_wait) is woken; for a task that has ended it goes to the conversation the task reports to, or else
 *   into the task's log.
 * - The runner reports each end as a "command.exited" event. When it (re)connects, the hub asks it about every
 *   command still recorded as running (reconcile): ends missed while disconnected are told then, and commands
 *   it no longer knows (the computer was recreated) or that died with their computer are lost.
 * - Nothing here stops or removes a command when the work that started it ends: the role stops it itself.
 * - Runners from before background commands (no COMMAND_TOOL in their info) only have exec.run: there
 *   run_command waits and kills on timeout, as it used to, and the other tools say the computer needs a reset.
 * Lock order: the starting task's row, then the command rows, then (enqueue) the conversation's session.
 */

import {
  COMMAND_TOOL,
  type CommandInfo,
  type CommandListResult,
  type CommandOutputResult,
  type RunnerOp,
} from "@witden/shared";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { RecoverResult } from "../compute/gateway.js";
import type { RunnerConnection } from "../compute/hub.js";
import { OutcomeUncertain, RunnerOpError } from "../compute/hub.js";
import { settings } from "../config.js";
import { type Db, db as getDb, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  agentSessions,
  type BackgroundCommand,
  backgroundCommands,
  computerInstances,
  roles,
  type Task,
  tasks,
} from "../db/schema.js";
import { BadRequest } from "../errors.js";
import { maybeRuntime } from "../runtime.js";
import { redact } from "../security/crypto.js";
import { sourceLimits } from "../services/collaboration-policy.js";
import * as topicSvc from "../services/topics.js";
import { setStatus, TERMINAL } from "./control.js";
import { enqueue } from "./conversation.js";
import { lockTask } from "./task-continuation.js";
import type { ToolContext, ToolResult } from "./tools.js";
import { appendStep, isConversation } from "./transcript.js";

const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 1800;
/** A foreground wait that ended this long ago without a word was given up (its worker stopped). */
const FOREGROUND_GRACE_MS = 60_000;
/** Characters of output in a notice, and of the command line kept and shown. */
const NOTICE_TAIL = 1500;
const COMMAND_KEPT = 4000;
const COMMAND_SHOWN = 300;
const LISTED = 30;
/** A start whose answer may still be on its way; reconcile leaves it alone. */
const STARTING_MS = 120_000;

const ENDED = ["finished", "lost"];
const LIVE = ["starting", "running"];

export const NEEDS_RESET =
  "this computer's runner predates background commands: run_command waits for commands and kills them on timeout there. A person can reset the computer (keeping the data in its persistent directories) to get background commands.";

// --- text --------------------------------------------------------------------------------------------------

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

function size(n: number | null): string {
  if (n === null) return "? bytes";
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const oneLine = (text: string, limit = COMMAND_SHOWN) => {
  const flat = text.replace(/\s*\n\s*/g, " ⏎ ");
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

function exitText(c: Pick<BackgroundCommand, "exitCode" | "signal">): string {
  return `exit code ${c.exitCode ?? "?"}${c.signal ? ` (${c.signal})` : ""}`;
}

/** What a role is told when a background command of its ended. */
export function noticeText(c: BackgroundCommand, note = ""): string {
  const took = c.startedAt && c.finishedAt ? ` after ${duration(c.finishedAt.getTime() - c.startedAt.getTime())}` : "";
  const how =
    c.status === "lost"
      ? `was lost${took}: it stopped without an exit status (its computer was stopped, restarted or reset, or its process was killed from outside)`
      : `ended${took} with ${exitText(c)}`;
  const lines = [`Background command ${c.id} ${how}.${note ? ` ${note}` : ""}`, `Command: ${oneLine(c.command)}`];
  const where = c.logPath ? `; all of it is in ${c.logPath}` : "";
  if (c.tail?.trim())
    lines.push(`Last output (${size(c.outputBytes)} in all${where}):\n${redact(c.tail.slice(-NOTICE_TAIL))}`);
  else lines.push(`No output${c.logPath ? ` (log: ${c.logPath})` : ""}.`);
  return lines.join("\n");
}

function statusLine(c: BackgroundCommand, now = Date.now()): string {
  const started = c.startedAt ?? c.createdAt;
  const state = LIVE.includes(c.status)
    ? `running for ${duration(now - started.getTime())}`
    : c.status === "lost"
      ? "lost (no exit status)"
      : `${exitText(c)} after ${duration((c.finishedAt ?? started).getTime() - started.getTime())}`;
  const out = c.outputBytes !== null ? `, output ${size(c.outputBytes)}` : "";
  return `${c.id} — ${state}${out}; started ${started.toISOString().slice(5, 16).replace("T", " ")} UTC — ${oneLine(c.command, 120)}`;
}

// --- state ------------------------------------------------------------------------------------------------

/** Whether the computer's runner has the command.* operations (as reported when it last connected). */
export async function supportsCommands(db: Db, instanceId: string | null): Promise<boolean> {
  if (!instanceId) return false;
  const [inst] = await db
    .select({ info: computerInstances.runnerInfo })
    .from(computerInstances)
    .where(eq(computerInstances.id, instanceId))
    .limit(1);
  const tools = (inst?.info as { tools?: unknown } | null)?.tools;
  return Array.isArray(tools) && tools.includes(COMMAND_TOOL);
}

/** Its end is to be told: the role stopped waiting for it, or its foreground wait was given up. */
const announced = (now = new Date()) =>
  or(
    eq(backgroundCommands.background, true),
    lt(backgroundCommands.foregroundUntil, new Date(now.getTime() - FOREGROUND_GRACE_MS)),
  );

/** Ended background commands of this task whose end it has not been told yet (locked). */
async function untold(db: Db, taskId: string): Promise<BackgroundCommand[]> {
  return db
    .select()
    .from(backgroundCommands)
    .where(
      and(
        eq(backgroundCommands.taskId, taskId),
        inArray(backgroundCommands.status, ENDED),
        isNull(backgroundCommands.notifiedAt),
        announced(),
      ),
    )
    .orderBy(backgroundCommands.finishedAt)
    .for("update");
}

async function markTold(db: Db, ids: string[], to: string): Promise<void> {
  if (!ids.length) return;
  await db
    .update(backgroundCommands)
    .set({ notifiedAt: new Date(), notifiedTo: to })
    .where(and(inArray(backgroundCommands.id, ids), isNull(backgroundCommands.notifiedAt)));
}

export async function hasUntoldCommands(db: Db, taskId: string): Promise<boolean> {
  return (await untold(db, taskId)).length > 0;
}

/**
 * Before a task's model call (the caller holds the task's row lock): background commands that ended meanwhile
 * become a user turn, like follow-up instructions.
 */
export async function consumeCommandNotices(db: Db, task: Task): Promise<boolean> {
  const ended = await untold(db, task.id);
  if (!ended.length) return false;
  await appendStep(db, task, "user", {
    content: `Background commands you started ended:\n\n${ended.map((c) => noticeText(c)).join("\n\n")}`,
    command_notices: ended.map((c) => c.id),
  });
  await markTold(
    db,
    ended.map((c) => c.id),
    "task",
  );
  return true;
}

/**
 * A task waiting on a timer (follow_up_later, command_wait) whose background commands ended: their notices
 * are the waiting call's result and the task goes on. The caller holds the task's row lock.
 */
export async function wakeForCommands(db: Db, task: Task): Promise<boolean> {
  if (task.status !== "waiting_timer") return false;
  const ended = await untold(db, task.id);
  if (!ended.length) return false;
  const early = task.wait?.type === "commands" ? "" : `Woken before your follow-up (${task.wait?.note ?? ""}):\n\n`;
  await appendStep(db, task, "tool", {
    tool_call_id: task.wait?.tool_call_id,
    name: task.wait?.tool ?? "follow_up_later",
    content: early + ended.map((c) => noticeText(c)).join("\n\n"),
    command_notices: ended.map((c) => c.id),
  });
  await markTold(
    db,
    ended.map((c) => c.id),
    "task",
  );
  await setStatus(db, task, "pending", "a background command ended", { wait: null });
  return true;
}

/** Tasks waiting on a timer that have an ended background command not told yet (the worker wakes them). */
export async function waitingOnEndedCommands(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: backgroundCommands.taskId })
    .from(backgroundCommands)
    .innerJoin(tasks, eq(tasks.id, backgroundCommands.taskId))
    .where(
      and(
        isNull(backgroundCommands.notifiedAt),
        inArray(backgroundCommands.status, ENDED),
        announced(),
        eq(tasks.status, "waiting_timer"),
      ),
    );
  return rows.map((r) => r.id);
}

/** command_wait ran out of time: which of its commands still run. */
export async function commandWaitTimedOut(db: Db, task: Task): Promise<string> {
  const live = await db
    .select()
    .from(backgroundCommands)
    .where(and(eq(backgroundCommands.taskId, task.id), inArray(backgroundCommands.status, LIVE)));
  const lines = live.map((c) => statusLine(c));
  return `No background command of yours ended within the time you gave (${task.wait?.note ?? ""}).${lines.length ? ` Still running:\n${lines.join("\n")}` : ""}`;
}

/** Into a conversation's inbox (falls back to the starting task's log when the conversation cannot take it). */
async function toConversation(db: Db, c: BackgroundCommand, starter: Task, sessionId: string): Promise<boolean> {
  const [s] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  if (!s) return false;
  const [role] = await db.select().from(roles).where(eq(roles.id, s.roleId)).limit(1);
  const topic = await topicSvc.getTopic(db, s.topicId).catch(() => null);
  if (role?.status !== "active" || topic?.status !== "active") return false;
  await enqueue(db, {
    topic,
    role,
    item: { kind: "command", command_id: c.id, round: starter.round },
    requesterUserId: starter.requesterUserId,
    title: `Background command ${c.id} ended`,
    // Work on outside input keeps its limits, as a task's result does.
    limits: sourceLimits(starter.envelope),
  });
  return true;
}

/**
 * Tell the end of ``c`` where it belongs (no-op when already told or not announced). The caller holds the
 * starting task's row lock, then the command's.
 */
async function announce(db: Db, c: BackgroundCommand, starter: Task | undefined): Promise<void> {
  if (c.notifiedAt || !ENDED.includes(c.status)) return;
  const given = c.foregroundUntil && c.foregroundUntil.getTime() < Date.now() - FOREGROUND_GRACE_MS;
  if (!c.background && !given) return;
  if (!starter) return markTold(db, [c.id], "none");
  if (isConversation(starter)) {
    if (await toConversation(db, c, starter, starter.sessionId!)) return markTold(db, [c.id], "conversation");
  } else if (!TERMINAL.has(starter.status)) {
    // The task reads it at its next step (consumeCommandNotices); one waiting on a timer goes on now.
    await wakeForCommands(db, starter);
    return;
  } else if (starter.reportSessionId && (await toConversation(db, c, starter, starter.reportSessionId))) {
    return markTold(db, [c.id], "conversation");
  }
  await appendStep(db, starter, "event", {
    type: "command_finished",
    command_id: c.id,
    note: noticeText(c),
  });
  await markTold(db, [c.id], "log");
}

/** A task ended (control.setStatus): ends it was not told yet go to its conversation or its log. */
export async function afterTaskEnd(db: Db, task: Task): Promise<void> {
  if (isConversation(task)) return;
  for (const c of await untold(db, task.id)) await announce(db, c, task);
}

export interface CommandEnd {
  exitCode: number | null;
  signal: string | null;
  lost: boolean;
  finishedAt: Date;
  outputBytes: number | null;
  tail: string | null;
  logPath?: string | null;
}

/** What the runner says about an ended command, checked: the computer is not trusted. */
export function endFrom(info: Partial<CommandInfo>): CommandEnd {
  const at = typeof info.finishedAt === "string" ? new Date(info.finishedAt) : new Date();
  return {
    exitCode: Number.isInteger(info.exitCode) ? Number(info.exitCode) : null,
    signal: typeof info.signal === "string" ? info.signal.slice(0, 16) : null,
    lost: info.lost === true,
    finishedAt: Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 60_000 ? new Date() : at,
    outputBytes: Number.isSafeInteger(info.outputBytes) ? Number(info.outputBytes) : null,
    tail: typeof info.tail === "string" ? info.tail.slice(-4000) : null,
    logPath: typeof info.logPath === "string" ? info.logPath.slice(0, 1000) : undefined,
  };
}

/**
 * A command of ``instanceId`` ended: record it once and tell it where it belongs, or (``toldHere``) mark it as
 * told because the role learns of it from the tool result it is getting. Ends reported for another computer's
 * commands are ignored.
 */
export async function recordEnd(
  db: Db,
  instanceId: string,
  id: string,
  end: CommandEnd,
  toldHere?: string,
): Promise<void> {
  const [seen] = await db.select().from(backgroundCommands).where(eq(backgroundCommands.id, id)).limit(1);
  if (!seen || seen.instanceId !== instanceId) return;
  const starter = await lockTask(db, seen.taskId);
  let [c] = await db.select().from(backgroundCommands).where(eq(backgroundCommands.id, id)).for("update");
  if (!c) return;
  if (LIVE.includes(c.status))
    [c] = await db
      .update(backgroundCommands)
      .set({
        status: end.lost ? "lost" : "finished",
        exitCode: end.lost ? null : end.exitCode,
        signal: end.lost ? null : end.signal,
        finishedAt: end.finishedAt,
        outputBytes: end.outputBytes ?? c.outputBytes,
        tail: end.tail ?? c.tail,
        ...(end.logPath ? { logPath: end.logPath } : {}),
      })
      .where(eq(backgroundCommands.id, id))
      .returning();
  if (toldHere) await markTold(db, [id], toldHere);
  else await announce(db, c, starter);
}

/**
 * Ends nobody was told of because the foreground wait for them was given up (its worker stopped): tell them
 * now (API process, periodically).
 */
export async function announceOverdue(): Promise<void> {
  const overdue = await getDb()
    .select({ id: backgroundCommands.id, instanceId: backgroundCommands.instanceId })
    .from(backgroundCommands)
    .where(
      and(
        isNull(backgroundCommands.notifiedAt),
        inArray(backgroundCommands.status, ENDED),
        eq(backgroundCommands.background, false),
        lt(backgroundCommands.foregroundUntil, new Date(Date.now() - FOREGROUND_GRACE_MS)),
      ),
    )
    .limit(100);
  for (const c of overdue) await transaction((tx) => announceEnded(tx, c.instanceId, c.id));
}

/** Tell the end of a command that has already ended, if it is due and not told yet. */
async function announceEnded(db: Db, instanceId: string, id: string): Promise<void> {
  const [seen] = await db.select().from(backgroundCommands).where(eq(backgroundCommands.id, id)).limit(1);
  if (!seen || seen.instanceId !== instanceId || !ENDED.includes(seen.status)) return;
  const starter = await lockTask(db, seen.taskId);
  const [c] = await db.select().from(backgroundCommands).where(eq(backgroundCommands.id, id)).for("update");
  if (c) await announce(db, c, starter);
}

/** The computer is stopped, restarted, reset or deleted: its commands die with it. */
export async function loseInstanceCommands(db: Db, instanceId: string): Promise<void> {
  const live = await db
    .select({ id: backgroundCommands.id })
    .from(backgroundCommands)
    .where(and(eq(backgroundCommands.instanceId, instanceId), inArray(backgroundCommands.status, LIVE)));
  for (const { id } of live)
    await recordEnd(db, instanceId, id, {
      exitCode: null,
      signal: null,
      lost: true,
      finishedAt: new Date(),
      outputBytes: null,
      tail: null,
    });
}

// --- the runner connection (API process) ----------------------------------------------------------------

/**
 * A runner connected (compute/hub.ts): follow its "command.exited" events, and ask it about the commands
 * still recorded as running on its computer.
 */
export function watchCommands(conn: RunnerConnection): void {
  conn.onEvent((e) => {
    if (e.event !== "command.exited" || typeof e.data?.id !== "string") return;
    const id = e.data.id;
    const end = endFrom(e.data as Partial<CommandInfo>);
    maybeRuntime()?.background("command.exited", () => transaction((tx) => recordEnd(tx, conn.instanceId, id, end)));
  });
  maybeRuntime()?.background("command.reconcile", () => reconcileCommands(conn));
}

export async function reconcileCommands(conn: RunnerConnection): Promise<void> {
  const live = await getDb()
    .select()
    .from(backgroundCommands)
    .where(and(eq(backgroundCommands.instanceId, conn.instanceId), inArray(backgroundCommands.status, LIVE)));
  if (!live.length) return;
  // A runner without the operations cannot have them: the computer was recreated from an older image.
  if (!conn.info.tools?.includes(COMMAND_TOOL)) {
    await applyListed(conn.instanceId, live, { commands: [], unknown: live.map((c) => c.id) });
    return;
  }
  const res = await conn.request<CommandListResult>(
    "command.list",
    { ids: live.map((c) => c.id), tailBytes: NOTICE_TAIL },
    30_000,
  );
  await applyListed(conn.instanceId, live, res);
}

/** What the runner says about commands recorded as running: record the ends it knows and the ones it lost. */
async function applyListed(instanceId: string, live: BackgroundCommand[], res: CommandListResult): Promise<void> {
  const byId = new Map(live.map((c) => [c.id, c]));
  for (const info of res.commands ?? []) {
    const c = byId.get(info.id);
    if (!c) continue;
    if (!info.running) await transaction((tx) => recordEnd(tx, instanceId, c.id, endFrom(info)));
    else if (c.status === "starting")
      await getDb()
        .update(backgroundCommands)
        .set({ status: "running", logPath: info.logPath, startedAt: new Date(info.startedAt) })
        .where(and(eq(backgroundCommands.id, c.id), eq(backgroundCommands.status, "starting")));
  }
  // Ones it does not know: a start that never arrived is forgotten, the others went with the computer's files.
  for (const id of res.unknown ?? []) {
    const c = byId.get(id);
    // A start whose answer may still be on its way is left alone.
    if (!c || (c.status === "starting" && Date.now() - c.createdAt.getTime() < STARTING_MS)) continue;
    if (c.status === "starting")
      await getDb()
        .delete(backgroundCommands)
        .where(and(eq(backgroundCommands.id, c.id), eq(backgroundCommands.status, "starting")));
    else
      await transaction((tx) =>
        recordEnd(tx, instanceId, c.id, {
          exitCode: null,
          signal: null,
          lost: true,
          finishedAt: new Date(),
          outputBytes: null,
          tail: null,
        }),
      );
  }
}

// --- tools --------------------------------------------------------------------------------------------------

function op<T>(ctx: ToolContext, name: RunnerOp, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
  return ctx.gateway.execute({
    taskId: ctx.taskId,
    toolCallId: ctx.toolCallId,
    op: name,
    params,
    timeoutMs,
  }) as Promise<T>;
}

async function taskOf(ctx: ToolContext): Promise<Task> {
  const [task] = await ctx.db().select().from(tasks).where(eq(tasks.id, ctx.taskId)).limit(1);
  if (!task) throw new BadRequest("task context missing");
  return task;
}

/** One of this role's commands on the task's computer. */
async function ownCommand(ctx: ToolContext, task: Task, id: string): Promise<BackgroundCommand> {
  const [c] = id
    ? await ctx
        .db()
        .select()
        .from(backgroundCommands)
        .where(
          and(
            eq(backgroundCommands.id, id),
            eq(backgroundCommands.roleId, ctx.roleId),
            eq(backgroundCommands.instanceId, task.instanceId ?? ""),
          ),
        )
        .limit(1)
    : [];
  if (!c)
    throw new BadRequest(`no command ${id || "(missing id)"} of yours on this computer; command_status lists them`);
  return c;
}

function finishedText(r: CommandOutputResult): string {
  const cut = r.truncated ? ` [output cut: ${size(r.outputBytes)} in all, the whole output is in ${r.logPath}]` : "";
  return `[${r.lost ? "lost: no exit status" : exitText(r)}]${cut}\n${r.output}`;
}

/** Old runners: wait and kill on timeout, as run_command always did there. */
async function legacyRun(ctx: ToolContext, args: Record<string, any>, wait: number): Promise<ToolResult> {
  if (args.background === true) return { content: `error: ${NEEDS_RESET}` };
  const r = await op<any>(
    ctx,
    "exec.run",
    { command: String(args.command ?? ""), cwd: args.workdir, outputLimit: settings().toolOutputLimit },
    wait * 1000,
  );
  const status = r.timedOut
    ? `timed out after ${wait}s: process tree killed (this computer's runner is older; after a reset of the computer, commands go on in the background instead)`
    : `exit code ${r.exitCode}`;
  return { content: `[${status}]${r.truncated ? " [output truncated]" : ""}\n${r.output}` };
}

export async function runCommand(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const command = String(args.command ?? "");
  if (!command.trim()) throw new BadRequest("command is required");
  const wait = Math.max(
    1,
    Math.min(Number(args.timeout_seconds ?? DEFAULT_WAIT_SECONDS) || DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS),
  );
  const background = args.background === true;
  const task = await taskOf(ctx);
  const db = ctx.db();
  if (!(await supportsCommands(db, task.instanceId))) return legacyRun(ctx, args, wait);
  // Recorded before it starts: its end may be reported before the start is answered.
  const id = newId("cmd");
  await db.insert(backgroundCommands).values({
    id,
    instanceId: task.instanceId!,
    roleId: ctx.roleId,
    topicId: ctx.topicId,
    taskId: ctx.taskId,
    command: command.slice(0, COMMAND_KEPT),
    cwd: args.workdir ? String(args.workdir) : null,
    background,
    foregroundUntil: background ? null : new Date(Date.now() + (wait + 30) * 1000),
  });
  const forget = () => db.delete(backgroundCommands).where(eq(backgroundCommands.id, id));
  let started: CommandInfo;
  try {
    started = await op<CommandInfo>(ctx, "command.start", { id, command, cwd: args.workdir }, 30_000);
  } catch (err) {
    // The runner was replaced by an older one since it last connected.
    if (err instanceof RunnerOpError && err.runnerCode === "unsupported") {
      await forget();
      return legacyRun(ctx, args, wait);
    }
    // Refused or never delivered: nothing runs (the worker retries a call that never reached the computer).
    if (!(err instanceof OutcomeUncertain)) {
      await forget();
      throw err;
    }
    // Never started again blindly: the runner's journal tells whether it started.
    const outcome = await ctx.gateway
      .recover(ctx.taskId, ctx.toolCallId)
      .catch(() => ({ state: "uncertain" }) as RecoverResult);
    if (outcome.state === "failed") {
      await forget();
      return { content: `error: ${outcome.error?.message ?? "the command did not start"}` };
    }
    if (outcome.state !== "completed") {
      // Still unknown: if it started, its end is told like a background command's; reconcile settles it.
      await toBackground(id);
      return {
        content: `uncertain: the connection to the computer broke while starting command ${id}; it may or may not be running. If it is, you get a notice when it ends. Check with command_status (id ${id}) before running it again (${err.message}).`,
      };
    }
    started = outcome.result as CommandInfo;
  }
  await db
    .update(backgroundCommands)
    .set({ status: "running", logPath: started.logPath, cwd: started.cwd, startedAt: new Date(started.startedAt) })
    .where(and(eq(backgroundCommands.id, id), eq(backgroundCommands.status, "starting")));
  const handling =
    "You get a notice with its exit code and last output when it ends; command_status shows how it is doing, command_stop stops it. It is not stopped when your work ends.";
  if (background)
    return {
      content: `started in the background as command ${id}; its output goes to ${started.logPath}. ${handling}`,
    };
  let r: CommandOutputResult;
  try {
    r = await op<CommandOutputResult>(
      ctx,
      "command.wait",
      { id, waitMs: wait * 1000, outputLimit: settings().toolOutputLimit },
      wait * 1000 + 15_000,
    );
  } catch (err) {
    // Started for sure: whatever broke the wait, never run it again — it carries on in the background (or its
    // end, if it came meanwhile, follows as a notice).
    if (!(await toBackground(id))) await release(task.instanceId!, id);
    return {
      content: `command ${id} started, but waiting for it failed (${(err as Error).message}); it carries on in the background with its output in ${started.logPath}. ${handling}`,
    };
  }
  if (r.running && (await toBackground(id)))
    return {
      content: `[still running after ${wait}s: it goes on in the background as command ${id}, it was not stopped]\nOutput so far (${size(r.outputBytes)}; the whole output is in ${r.logPath}):\n${r.output}\n\n${handling}`,
    };
  // It ended (perhaps right after the wait): the result is told here.
  if (r.running) {
    try {
      r = await op<CommandOutputResult>(
        ctx,
        "command.wait",
        { id, waitMs: 0, outputLimit: settings().toolOutputLimit },
        30_000,
      );
    } catch {
      await release(task.instanceId!, id);
      return { content: `command ${id} ended right after ${wait}s; its exit code and output follow as a notice.` };
    }
  }
  const end = endFrom(r);
  await transaction((tx) => recordEnd(tx, task.instanceId!, id, end, "foreground"));
  return { content: finishedText(r) };
}

/** Back to the background after command_stop left it running: its end is announced (now, if it came meanwhile). */
async function release(instanceId: string, id: string): Promise<void> {
  await getDb()
    .update(backgroundCommands)
    .set({ background: true, foregroundUntil: null })
    .where(eq(backgroundCommands.id, id));
  await transaction((tx) => announceEnded(tx, instanceId, id));
}

/** The role no longer waits for it; false when it has already ended. */
async function toBackground(id: string): Promise<boolean> {
  const rows = await getDb()
    .update(backgroundCommands)
    .set({ background: true })
    .where(and(eq(backgroundCommands.id, id), inArray(backgroundCommands.status, LIVE)))
    .returning({ id: backgroundCommands.id });
  return rows.length > 0;
}

export async function commandStatus(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const task = await taskOf(ctx);
  const db = ctx.db();
  if (!(await supportsCommands(db, task.instanceId))) return { content: NEEDS_RESET };
  if (!args.id) {
    const mine = () =>
      db
        .select()
        .from(backgroundCommands)
        .where(
          and(
            eq(backgroundCommands.roleId, ctx.roleId),
            eq(backgroundCommands.instanceId, task.instanceId!),
            or(eq(backgroundCommands.background, true), inArray(backgroundCommands.status, LIVE)),
          ),
        )
        .orderBy(desc(backgroundCommands.createdAt))
        .limit(LISTED);
    let rows = await mine();
    // Running ones as the computer sees them now (an end reported while nobody listened is recorded too).
    const live = rows.filter((c) => LIVE.includes(c.status));
    const sizes = new Map<string, number>();
    if (live.length) {
      const res = await op<CommandListResult>(
        ctx,
        "command.list",
        { ids: live.map((c) => c.id), tailBytes: NOTICE_TAIL },
        30_000,
      );
      await applyListed(task.instanceId!, live, res);
      for (const info of res.commands ?? []) sizes.set(info.id, info.outputBytes);
      rows = await mine();
    }
    if (!rows.length) return { content: "you have no background commands on this computer" };
    for (const c of rows) c.outputBytes = sizes.get(c.id) ?? c.outputBytes;
    const running = rows.filter((c) => LIVE.includes(c.status)).length;
    return {
      content: `Your background commands on this computer (newest first; ${running} running):\n${rows.map((c) => `- ${statusLine(c)}`).join("\n")}\ncommand_status with an id shows a command's latest output; read its whole log with read_file or run_command.`,
    };
  }
  const c = await ownCommand(ctx, task, String(args.id));
  let r: CommandOutputResult;
  try {
    r = await op<CommandOutputResult>(
      ctx,
      "command.wait",
      { id: c.id, waitMs: 0, outputLimit: settings().toolOutputLimit },
      30_000,
    );
  } catch (err) {
    if (!(err instanceof RunnerOpError && err.runnerCode === "not_found")) throw err;
    await applyListed(task.instanceId!, [c], { commands: [], unknown: [c.id] });
    return {
      content:
        c.status === "starting"
          ? `command ${c.id} is not known to the computer: it did not start`
          : `command ${c.id} is no longer known to the computer (its files are gone): it was lost`,
    };
  }
  // Seen ending here: no notice follows (unless one was already sent).
  if (!r.running) {
    const end = endFrom(r);
    await transaction((tx) => recordEnd(tx, task.instanceId!, c.id, end, "status"));
  }
  const state = r.running
    ? `running for ${duration(Date.now() - Date.parse(r.startedAt))}`
    : r.lost
      ? "lost: it stopped without an exit status"
      : `${exitText(r)} after ${duration(Date.parse(r.finishedAt ?? r.startedAt) - Date.parse(r.startedAt))}`;
  const cut = r.truncated ? `; the output below is cut, the whole of it is in ${r.logPath}` : `; log: ${r.logPath}`;
  return {
    content: `[command ${c.id}: ${state}; output ${size(r.outputBytes)}${cut}]\nCommand: ${oneLine(c.command)}\n${r.output}`,
  };
}

export async function commandStop(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const task = await taskOf(ctx);
  const db = ctx.db();
  if (!(await supportsCommands(db, task.instanceId))) return { content: NEEDS_RESET };
  const c = await ownCommand(ctx, task, String(args.id ?? ""));
  if (ENDED.includes(c.status)) return { content: `command ${c.id} already ended (${statusLine(c)})` };
  const signal = ["interrupt", "terminate", "kill"].includes(args.signal) ? args.signal : "terminate";
  // While the stop is under way its end is this call's to tell, as in a foreground wait (the runner reports the
  // end before it answers).
  await db
    .update(backgroundCommands)
    .set({ background: false, foregroundUntil: new Date(Date.now() + 60_000) })
    .where(eq(backgroundCommands.id, c.id));
  let r: CommandInfo & { signalled: number };
  try {
    r = await op<CommandInfo & { signalled: number }>(ctx, "command.stop", { id: c.id, signal }, 30_000);
  } catch (err) {
    await release(task.instanceId!, c.id);
    throw err;
  }
  if (r.running) {
    await release(task.instanceId!, c.id);
    return {
      content: `sent ${signal} to command ${c.id} (${r.signalled} processes); it is still running. command_status shows it; signal "kill" stops it for sure.`,
    };
  }
  // Its end is told here rather than in a notice.
  const end = endFrom(r);
  await transaction((tx) => recordEnd(tx, task.instanceId!, c.id, end, "foreground"));
  return {
    content: `stopped command ${c.id} (${r.signalled} processes signalled): ${r.lost ? "no exit status" : exitText(r)}. Its output stays in ${r.logPath}.`,
  };
}

/** In a task: pause until one of its background commands ends (or ``minutes`` pass), like follow_up_later. */
export async function commandWait(ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> {
  const task = await taskOf(ctx);
  if (!(await supportsCommands(ctx.db(), task.instanceId))) return { content: NEEDS_RESET };
  const minutes = Math.max(1, Math.min(Number(args.minutes ?? 30) || 30, 24 * 60));
  // Already ended: the notices are the answer.
  const told = await transaction(async (tx) => {
    const t = await lockTask(tx, ctx.taskId);
    if (!t) return null;
    const ended = await untold(tx, t.id);
    if (!ended.length) return null;
    await markTold(
      tx,
      ended.map((c) => c.id),
      "task",
    );
    return ended.map((c) => noticeText(c)).join("\n\n");
  });
  if (told) return { content: told };
  const live = await ctx
    .db()
    .select({ id: backgroundCommands.id })
    .from(backgroundCommands)
    .where(and(eq(backgroundCommands.taskId, ctx.taskId), inArray(backgroundCommands.status, LIVE)));
  if (!live.length) return { content: "none of the background commands this task started is running" };
  const until = new Date(Date.now() + minutes * 60_000);
  const ids = live.map((c) => c.id).join(", ");
  return {
    content: `waiting for ${ids}`,
    control: "wait",
    status: "waiting_timer",
    statusReason: `waiting for background command${live.length > 1 ? "s" : ""} ${ids} (up to ${minutes} min)`,
    wait: {
      type: "commands",
      tool: "command_wait",
      until: until.toISOString(),
      note: `${minutes} min`,
      tool_call_id: ctx.toolCallId,
    },
  };
}

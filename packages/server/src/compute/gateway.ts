/**
 * Execution gateway: the only path from AI work to a computer.
 *
 * The worker asks for an operation on behalf of a task; the gateway decides whether it is allowed and where
 * it goes. The model never chooses the identity, permissions or computer: the gateway binds the request to
 * the instance the task was pinned to, checks the role still owns it, the task's tool envelope, emergency
 * stops, human takeover and desktop control, journals the call, and relays it to that computer's runner.
 * There is no fallback: an unavailable computer means the work waits or fails.
 */
import { READ_ONLY_OPS, type RunnerOp } from "@witden/shared";
import { and, desc, eq } from "drizzle-orm";
import { db as getDb, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import { computerInstances, execSessions, roles, tasks, toolCalls } from "../db/schema.js";
import {
  BadRequest,
  Forbidden,
  InstanceBusy,
  InstanceUnavailable,
  ModelError,
  NotFound,
  Unavailable,
  WitdenError,
} from "../errors.js";
import { runtime } from "../runtime.js";
import { safeEqual } from "../security/crypto.js";
import { ensureUsable } from "../services/instances.js";
import { acquire } from "../services/leases.js";
import { OutcomeUncertain, RunnerOpError } from "./hub.js";

export interface GatewayRequest {
  taskId: string;
  toolCallId: string;
  op: RunnerOp;
  params: Record<string, unknown>;
  timeoutMs: number;
}

export interface RecoverResult {
  state: "completed" | "failed" | "running" | "uncertain";
  result?: unknown;
  error?: { code: string; message: string };
}

export interface GatewayClient {
  execute(req: GatewayRequest): Promise<unknown>;
  /** What happened to a call that was in flight when the worker lost track of it. */
  recover(taskId: string, toolCallId: string): Promise<RecoverResult>;
}

/** Tool group (permission unit in the task envelope) that each runner operation belongs to. */
export function opGroup(op: RunnerOp): string {
  if (op === "exec.run" || op === "process.list") return "shell";
  if (op.startsWith("terminal.")) return "terminal";
  if (op.startsWith("file.")) return "files";
  if (op.startsWith("screen.") || op.startsWith("input.")) return "desktop";
  if (op.startsWith("browser.")) return "browser";
  if (op.startsWith("agent.")) return "external";
  return "system";
}

const DESKTOP_INPUT = new Set<RunnerOp>(["input.mouse", "input.keyboard"]);
/**
 * Operations that only wind work down. They must still reach the computer after the task was cancelled or
 * paused, during a takeover or an emergency stop, or after its role moved: that is when they are needed.
 */
const STOP_OPS = new Set<RunnerOp>(["agent.stop"]);
const BROWSER_SESSION_OPS = new Set<RunnerOp>(["browser.click", "browser.type", "browser.download", "browser.close"]);

export class ExecutionGateway implements GatewayClient {
  async execute(req: GatewayRequest): Promise<unknown> {
    const callId = newId("call");
    const target = await transaction(async (tx) => {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, req.taskId)).limit(1);
      if (!task) throw new NotFound("task not found");
      const stopping = STOP_OPS.has(req.op);
      if (!stopping && task.status !== "running") throw new Forbidden(`task is ${task.status}, not running`);
      if (!task.instanceId) throw new InstanceUnavailable("this task has no computer assigned");
      const [role] = await tx.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
      if (!role) throw new NotFound("role not found");
      if (!stopping && role.instanceId !== task.instanceId) {
        // Never follow the role silently to its new computer: files and credentials differ.
        throw new InstanceUnavailable(
          "the role was moved to another computer after this task started; a person must reassign or restart the task",
        );
      }
      const [inst] = await tx
        .select()
        .from(computerInstances)
        .where(eq(computerInstances.id, task.instanceId))
        .limit(1);
      if (!inst || inst.status === "deleted") throw new InstanceUnavailable("the task's computer no longer exists");
      if (inst.pausedAi && !stopping)
        throw new InstanceBusy(`a person has taken over computer ${inst.name}; AI work is paused`);
      const group = opGroup(req.op);
      const tools: string[] = task.envelope.tools ?? [];
      const allowed =
        group === "system" || tools.includes(group) || (group === "external" && task.runtime === "external");
      if (!allowed) throw new Forbidden(`operation ${req.op} is outside this task's permissions`);
      const { activeKillSwitch } = await import("../agent/revocation.js");
      const ks = stopping ? null : await activeKillSwitch(tx, task);
      if (ks) throw new Forbidden(`emergency stop in effect: ${ks.reason || ks.scope}`);
      if (await needsDesktop(tx, req)) {
        const got = await acquire(tx, inst.id, "role", role.id, { taskId: task.id, reason: "desktop work" });
        if (!got.ok) {
          throw new InstanceBusy(
            `the desktop of ${inst.name} is being used by ${got.holderType} ${got.holderId}; waiting for it`,
          );
        }
      }
      await tx.insert(toolCalls).values({
        id: callId,
        taskId: task.id,
        toolCallId: req.toolCallId,
        instanceId: inst.id,
        op: req.op,
        readOnly: READ_ONLY_OPS.has(req.op),
      });
      return { inst, roleId: role.id };
    });

    const hub = runtime().hub;
    if (!hub) throw new Unavailable("this process does not host the runner hub");
    let conn = hub.connected(target.inst.id);
    try {
      if (!conn) {
        await ensureUsable(target.inst);
        conn = await hub.connection(target.inst.id, {
          containerId: target.inst.containerId,
          network: target.inst.resources.network ?? "bridge",
        });
      }
    } catch (err) {
      await finishCall(callId, "failed");
      throw err;
    }
    try {
      const result = await conn.request(req.op, req.params, req.timeoutMs, callId);
      await transaction(async (tx) => {
        await tx.update(toolCalls).set({ state: "completed", finishedAt: new Date() }).where(eq(toolCalls.id, callId));
        await trackSession(tx, req, result, target.inst.id, target.roleId);
      });
      return result;
    } catch (err) {
      // A read-only call can simply be repeated; anything else that was in flight may already have happened.
      const uncertain = err instanceof OutcomeUncertain && !READ_ONLY_OPS.has(req.op);
      await finishCall(callId, uncertain ? "uncertain" : "failed");
      throw err;
    }
  }

  async recover(taskId: string, toolCallId: string): Promise<RecoverResult> {
    const [call] = await getDb()
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.taskId, taskId), eq(toolCalls.toolCallId, toolCallId)))
      .orderBy(desc(toolCalls.createdAt))
      .limit(1);
    if (!call)
      return { state: "failed", error: { code: "never_sent", message: "the call never reached the computer" } };
    if (call.state === "failed") return { state: "failed" };
    const hub = runtime().hub;
    const [inst] = await getDb()
      .select()
      .from(computerInstances)
      .where(eq(computerInstances.id, call.instanceId))
      .limit(1);
    if (!hub || !inst) return { state: "uncertain" };
    try {
      const conn =
        hub.connected(inst.id) ??
        (await hub.connection(inst.id, {
          containerId: inst.containerId,
          network: inst.resources.network ?? "bridge",
          waitMs: 5000,
        }));
      const journal = await conn.request<{ state: string; response?: { ok: boolean; result?: unknown; error?: any } }>(
        "journal.get",
        { requestId: call.id },
        10_000,
      );
      if (journal.state === "completed" && journal.response) {
        await finishCall(call.id, journal.response.ok ? "completed" : "failed");
        return journal.response.ok
          ? { state: "completed", result: journal.response.result }
          : { state: "failed", error: journal.response.error };
      }
      if (journal.state === "running") return { state: "running" };
    } catch {
      /* fall through: unknown outcome */
    }
    await finishCall(call.id, call.readOnly ? "failed" : "uncertain");
    return { state: call.readOnly ? "failed" : "uncertain" };
  }
}

async function finishCall(callId: string, state: string): Promise<void> {
  await getDb().update(toolCalls).set({ state, finishedAt: new Date() }).where(eq(toolCalls.id, callId));
}

async function needsDesktop(tx: import("../db/client.js").Db, req: GatewayRequest): Promise<boolean> {
  if (DESKTOP_INPUT.has(req.op)) return true;
  if (req.op === "browser.open") return req.params.mode !== "background";
  if (BROWSER_SESSION_OPS.has(req.op)) {
    const [session] = await tx
      .select()
      .from(execSessions)
      .where(
        and(eq(execSessions.kind, "browser"), eq(execSessions.runnerSessionId, String(req.params.sessionId ?? ""))),
      )
      .limit(1);
    return session?.mode !== "background";
  }
  return false;
}

/** Keep a record of terminals, browser sessions and external agents living in each computer. */
async function trackSession(
  tx: import("../db/client.js").Db,
  req: GatewayRequest,
  result: any,
  instanceId: string,
  roleId: string,
): Promise<void> {
  const open = async (kind: string, runnerSessionId: string, mode: string, title: string) => {
    await tx.insert(execSessions).values({
      id: newId("xs"),
      instanceId,
      kind,
      runnerSessionId,
      mode,
      taskId: req.taskId,
      roleId,
      title: title.slice(0, 300),
    });
  };
  const close = async (kind: string, runnerSessionId: string) => {
    await tx
      .update(execSessions)
      .set({ status: "closed" })
      .where(
        and(
          eq(execSessions.instanceId, instanceId),
          eq(execSessions.kind, kind),
          eq(execSessions.runnerSessionId, runnerSessionId),
        ),
      );
  };
  if (req.op === "terminal.create" && result?.sessionId)
    await open("terminal", result.sessionId, "background", String(req.params.command ?? "shell"));
  if (req.op === "terminal.kill") await close("terminal", String(req.params.sessionId));
  if (req.op === "browser.open" && result?.sessionId && !req.params.sessionId) {
    await open("browser", result.sessionId, String(req.params.mode ?? "desktop"), String(result.url ?? req.params.url));
  }
  if (req.op === "browser.close") await close("browser", String(req.params.sessionId));
  if (req.op === "agent.start" && result?.sessionId)
    await open("agent", result.sessionId, "background", String(req.params.command));
  if (req.op === "agent.stop") await close("agent", String(req.params.sessionId));
  if (req.op === "agent.read" && result && result.running === false) await close("agent", String(req.params.sessionId));
}

// --- HTTP transport for workers running in their own process -----------------------------------------------

const ERROR_TYPES: Record<string, new (msg: string, opts?: any) => WitdenError> = {
  instance_unavailable: InstanceUnavailable,
  instance_busy: InstanceBusy,
  outcome_uncertain: OutcomeUncertain,
  permission_denied: Forbidden,
  not_found: NotFound,
  model_error: ModelError,
};

export function serializeError(err: unknown): { code: string; message: string; status: number } {
  if (err instanceof WitdenError) return { code: err.code, message: err.message, status: err.status };
  return { code: "internal", message: (err as Error)?.message ?? String(err), status: 500 };
}

export function deserializeError(body: { code: string; message: string }): WitdenError {
  if (body.code.startsWith("runner_")) return new RunnerOpError(body.code.slice(7), body.message);
  const Type = ERROR_TYPES[body.code] ?? BadRequest;
  return new Type(body.message, { code: body.code });
}

export class HttpGatewayClient implements GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call(path: string, body: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/internal/gateway/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // The API (and with it the hub) is unreachable: we cannot know whether the call was delivered.
      throw new OutcomeUncertain(`execution gateway unreachable: ${(err as Error).message}`);
    }
    const data: any = await res.json();
    if (!data.ok) throw deserializeError(data.error);
    return data.result;
  }

  execute(req: GatewayRequest): Promise<unknown> {
    return this.call("execute", req);
  }

  recover(taskId: string, toolCallId: string): Promise<RecoverResult> {
    return this.call("recover", { taskId, toolCallId });
  }
}

export function checkInternalToken(header: string | undefined, expected: string | null): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  return safeEqual(header.slice(7), expected);
}

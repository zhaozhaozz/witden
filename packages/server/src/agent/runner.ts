/**
 * Executes one task with the platform's own agent loop: model call -> tool calls -> ... -> final answer.
 *
 * The loop runs in the worker, outside every computer. Each step is persisted so a task survives restarts;
 * computer operations go through the execution gateway. Database transactions stay short: model calls and
 * computer operations happen outside them.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { GatewayClient, RecoverResult } from "../compute/gateway.js";
import { OutcomeUncertain } from "../compute/hub.js";
import { settings } from "../config.js";
import { type Db, db as getDb, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import { approvals, roles, type Task, tasks, topics, usageRecords } from "../db/schema.js";
import { InstanceBusy, InstanceUnavailable, WitdenError } from "../errors.js";
import { redact } from "../security/crypto.js";
import { Perm, usersWithPermission } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import * as models from "../services/model-configs.js";
import { initialMessages, recordSessionNote } from "./context.js";
import { getTask, setStatus, TERMINAL, textRestricted } from "./control.js";
import { systemMessage } from "./dispatch.js";
import type { ChatMessage, ChatModel, LLMResponse, ToolCall } from "./llm.js";
import { deliver } from "./output.js";
import { activeKillSwitch, stillAllowed } from "./revocation.js";
import { needsApproval, SIDE_EFFECT_TOOLS, TOOLS, type ToolResult, toolsFor } from "./tools.js";
import { appendStep, loadTranscript } from "./transcript.js";

interface Prepared {
  model: ChatModel;
  messages: ChatMessage[];
  tools: { name: string; description: string; parameters: Record<string, any> }[];
  modelConfigId: string;
}

export class TaskRunner {
  constructor(private readonly gateway: GatewayClient) {}

  async run(taskId: string): Promise<void> {
    try {
      // Emergency stops and revoked permissions are checked before anything runs, including a call that was
      // approved or interrupted earlier.
      if (!(await this.gateOnly(taskId))) return;
      if (!(await this.recoverInterrupted(taskId))) return;
      const retry = await this.takeRetry(taskId);
      if (retry && !(await this.execute(taskId, retry))) return;
      for (;;) {
        const prepared = await this.prepare(taskId);
        if (!prepared) return;
        let response: LLMResponse;
        try {
          response = await prepared.model.complete(
            prepared.messages,
            prepared.tools.length ? prepared.tools : undefined,
          );
        } catch (err) {
          if (err instanceof WitdenError) {
            await this.fail(taskId, `model error: ${err.message}`);
            return;
          }
          throw err;
        }
        const calls = await this.record(taskId, prepared, response);
        if (calls === null) return;
        if (!calls.length) {
          await this.finish(taskId, response.content);
          return;
        }
        for (const call of calls) if (!(await this.execute(taskId, call))) return;
      }
    } catch (err) {
      // An unexpected bug must be visible instead of leaving the task hanging.
      console.error(`[witden] task ${taskId} crashed`, err);
      await this.fail(taskId, `internal error: ${(err as Error).message}`);
    }
  }

  // --- gates ------------------------------------------------------------------------------------------

  private async gate(db: Db, task: Task): Promise<boolean> {
    const ks = await activeKillSwitch(db, task);
    if (ks) {
      await setStatus(db, task, "paused", `emergency stop: ${ks.reason || ks.scope}`, {
        wait: { ...(task.wait ?? {}), resume_to: "pending", paused_by: `kill:${ks.id}` },
      });
      return false;
    }
    const why = await stillAllowed(db, task);
    if (why) {
      await setStatus(db, task, "cancelled", why);
      return false;
    }
    return true;
  }

  private gateOnly(taskId: string): Promise<boolean> {
    return transaction(async (tx) => {
      const task = await getTask(tx, taskId);
      return !!task && task.status === "running" && (await this.gate(tx, task));
    });
  }

  // --- recovery ---------------------------------------------------------------------------------------

  /**
   * After a crash or a lost connection, a tool call may have no recorded result. Never simply repeat it:
   * ask the computer's journal what happened; if nobody knows, tell the model the outcome is uncertain so
   * it looks before acting again (a click or a submission may already have happened).
   */
  private async recoverInterrupted(taskId: string): Promise<boolean> {
    const task = await getTask(getDb(), taskId);
    if (!task) return false;
    const transcript = await loadTranscript(getDb(), task);
    const last = [...transcript].reverse().find((m) => m.role === "assistant");
    if (!last?.tool_calls?.length) return true;
    const pendingIds = new Set(task.wait?.retry_call ? [task.wait.retry_call.id] : []);
    for (const call of last.tool_calls) {
      const answered = transcript.some(
        (m) => m.role === "tool" && m.tool_call_id === call.id && !String(m.content).startsWith("interrupted:"),
      );
      if (answered || pendingIds.has(call.id) || (task.wait?.tool_call_id && task.wait.tool_call_id === call.id))
        continue;
      const spec = TOOLS.get(call.function.name);
      let content: string;
      if (spec && opBacked(call.function.name)) {
        const outcome = await this.gateway.recover(taskId, call.id);
        content =
          outcome.state === "failed" && (!outcome.error || outcome.error.code === "never_sent")
            ? `this call did not run (${outcome.error?.message ?? "not delivered"}); you may retry it`
            : describeRecovered(outcome, "the worker restarted during this call");
      } else {
        content = UNCERTAIN;
      }
      await transaction(async (tx) => {
        const t = await getTask(tx, taskId);
        if (t)
          await appendStep(tx, t, "tool", {
            tool_call_id: call.id,
            name: call.function.name,
            content,
            recovered: true,
          });
      });
    }
    return true;
  }

  private takeRetry(taskId: string): Promise<ToolCall | null> {
    return transaction(async (tx) => {
      const task = await getTask(tx, taskId);
      const raw = task?.wait?.retry_call;
      if (!task || !raw) return null;
      const { retry_call: _r, ...rest } = task.wait ?? {};
      await tx
        .update(tasks)
        .set({ wait: Object.keys(rest).length ? rest : null })
        .where(eq(tasks.id, taskId));
      return { id: raw.id, name: raw.name, arguments: raw.arguments ?? {} };
    });
  }

  // --- steps --------------------------------------------------------------------------------------------

  private prepare(taskId: string): Promise<Prepared | null> {
    return transaction(async (tx) => {
      const task = await getTask(tx, taskId);
      if (task?.status !== "running") return null;
      const [role] = await tx.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
      const [topic] = await tx.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
      if (!role || !topic || !(await this.gate(tx, task))) return null;
      const budget = task.budget ?? {};
      const usage = task.usage ?? {};
      const s = settings();
      if ((usage.steps ?? 0) >= (budget.max_steps ?? s.maxTaskSteps))
        return this.failIn(tx, task, "step budget exhausted before the work was finished");
      if (budget.max_tokens && (usage.tokens ?? 0) >= budget.max_tokens)
        return this.failIn(tx, task, "token budget exhausted before the work was finished");
      const found = await models.modelWithProvider(tx, task.roleSnapshot.model_config_id ?? role.modelConfigId);
      if (!found) return this.failIn(tx, task, "no model configured for this role");
      const cfg = found.model;
      const label = models.modelLabel(cfg, found.provider);
      if (topic.allowedModelConfigIds && !topic.allowedModelConfigIds.includes(cfg.id)) {
        return this.failIn(tx, task, `model ${label} is not allowed in this topic`);
      }
      if (role.dailyTokenLimit && (await models.tokensToday(tx, { roleId: role.id })) >= role.dailyTokenLimit) {
        return this.failIn(tx, task, `@${role.handle} reached its daily token limit`);
      }
      if (cfg.dailyTokenLimit && (await models.tokensToday(tx, { modelConfigId: cfg.id })) >= cfg.dailyTokenLimit) {
        return this.failIn(tx, task, `model ${label} reached its daily token limit`);
      }
      let model: ChatModel;
      try {
        model = await models.chatModelFor(tx, cfg);
      } catch (err) {
        return this.failIn(tx, task, (err as Error).message);
      }
      const initial = await initialMessages(tx, task, role, topic);
      let transcript = await loadTranscript(tx, task);
      if (!transcript.length) {
        await appendStep(tx, task, "user", { content: initial[1].content });
        transcript = await loadTranscript(tx, task);
      }
      // A model that cannot call tools can still answer in text.
      const specs = cfg.capabilities?.tools === false ? [] : toolsFor(task.envelope);
      return {
        model,
        messages: [initial[0], ...transcript],
        tools: specs.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
        modelConfigId: cfg.id,
      };
    });
  }

  private record(taskId: string, prepared: Prepared, response: LLMResponse): Promise<ToolCall[] | null> {
    return transaction(async (tx) => {
      const task = await getTask(tx, taskId);
      if (task?.status !== "running") return null; // cancelled or paused while the model was thinking
      await tx.insert(usageRecords).values({
        id: newId("use"),
        taskId,
        roleId: task.ownerRoleId,
        instanceId: task.instanceId,
        modelConfigId: prepared.modelConfigId,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
      });
      const usage = { ...(task.usage ?? {}) };
      usage.steps = (usage.steps ?? 0) + 1;
      usage.tokens = (usage.tokens ?? 0) + response.promptTokens + response.completionTokens;
      await tx.update(tasks).set({ usage }).where(eq(tasks.id, taskId));
      const payload: Record<string, any> = { content: response.content };
      if (response.toolCalls.length) {
        payload.tool_calls = response.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.rawArguments ?? JSON.stringify(c.arguments) },
        }));
      }
      await appendStep(tx, task, "assistant", payload);
      return response.toolCalls;
    });
  }

  /** Run one tool call. Returns false when the task has to stop or wait. */
  private async execute(taskId: string, call: ToolCall): Promise<boolean> {
    const pre = await transaction(async (tx) => {
      const task = await getTask(tx, taskId);
      if (task?.status !== "running") return null;
      const spec = TOOLS.get(call.name);
      const allowed = new Set(toolsFor(task.envelope).map((t) => t.name));
      if (!spec || !allowed.has(call.name)) {
        // Permission is enforced here (and again in the gateway), not by the prompt.
        await audit(tx, "tool.denied", {
          actorType: "role",
          actorId: task.ownerRoleId,
          outcome: "denied",
          taskId,
          topicId: task.topicId,
          detail: { tool: call.name },
        });
        await appendStep(tx, task, "tool", {
          tool_call_id: call.id,
          name: call.name,
          content: `error: tool ${call.name} is not available to you`,
        });
        return { skip: true as const };
      }
      if ("__invalid_json__" in call.arguments) {
        await appendStep(tx, task, "tool", {
          tool_call_id: call.id,
          name: call.name,
          content: "error: arguments were not valid JSON",
        });
        return { skip: true as const };
      }
      if (needsApproval(task.envelope, spec) && !(task.envelope.approved_calls ?? []).includes(call.id)) {
        await this.requestApproval(tx, task, call);
        return null;
      }
      return { skip: false as const, spec, task };
    });
    if (!pre) return false;
    if (pre.skip) return true;
    const { spec, task } = pre;
    let result: ToolResult;
    try {
      result = await spec.handler(
        {
          taskId,
          roleId: task.ownerRoleId,
          topicId: task.topicId,
          toolCallId: call.id,
          gateway: this.gateway,
          db: getDb,
        },
        call.arguments,
      );
    } catch (err) {
      if (err instanceof OutcomeUncertain && SIDE_EFFECT_TOOLS.has(call.name)) {
        // Never repeat blindly. Ask the runner's journal first: after a short blip it usually knows the answer.
        const outcome = await this.gateway
          .recover(taskId, call.id)
          .catch(() => ({ state: "uncertain" }) as RecoverResult);
        if (outcome.state === "failed" && outcome.error?.code === "never_sent") {
          await this.waitForInstance(taskId, call, err.message);
          return false;
        }
        result = { content: describeRecovered(outcome, err.message) };
      } else if (err instanceof InstanceUnavailable || err instanceof InstanceBusy || err instanceof OutcomeUncertain) {
        // Not delivered (or harmless to repeat): wait for the computer and run the same call again.
        await this.waitForInstance(taskId, call, err.message);
        return false;
      } else if (err instanceof WitdenError) {
        result = { content: `error: ${err.message}` };
      } else {
        console.error(`[witden] tool ${call.name} failed`, err);
        result = { content: `error: ${(err as Error).name}: ${(err as Error).message}` };
      }
    }
    return transaction(async (tx) => {
      const fresh = await getTask(tx, taskId);
      if (!fresh) return false;
      let current = fresh;
      if (result.labels?.length) {
        const labels = [...new Set([...fresh.labels, ...result.labels])];
        [current] = await tx.update(tasks).set({ labels }).where(eq(tasks.id, taskId)).returning();
      }
      const content = typeof result.content === "string" ? redact(result.content) : result.content;
      await audit(tx, `tool.${call.name}`, {
        actorType: "role",
        actorId: current.ownerRoleId,
        taskId,
        topicId: current.topicId,
        roleId: current.ownerRoleId,
        instanceId: current.instanceId,
        detail: { args: auditArgs(call.arguments) },
      });
      if (result.control === "wait") {
        // The call's real result (answer, approval, delegate outcome) is appended when the wait ends.
        await appendStep(tx, current, "event", {
          type: "wait",
          tool: call.name,
          note: content,
          args: shortArgs(call.arguments),
        });
        await setStatus(tx, current, result.status ?? "waiting_human", result.statusReason ?? null, {
          wait: result.wait ?? null,
        });
        return false;
      }
      await appendStep(tx, current, "tool", {
        tool_call_id: call.id,
        name: call.name,
        content,
        args: shortArgs(call.arguments),
      });
      return current.status === "running";
    });
  }

  private finish(taskId: string, content: string): Promise<void> {
    return transaction(async (tx) => {
      const task = await getTask(tx, taskId);
      if (task?.status !== "running") return;
      const [role] = await tx.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
      const [topic] = await tx.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
      const text = redact(content.trim()) || "(no answer)";
      const delivery = await deliver(tx, task, role, topic, text, { final: true });
      if (delivery.approval) {
        await setStatus(tx, task, "waiting_approval", "final answer waiting for disclosure approval", {
          wait: { type: "approval", approval_id: delivery.approval.id },
        });
        return;
      }
      const done = await setStatus(tx, task, "completed", null, { result: text });
      if (!(await textRestricted(tx, done))) await recordSessionNote(tx, done, text);
      await audit(tx, "task.complete", {
        actorType: "role",
        actorId: role.id,
        taskId,
        topicId: topic.id,
        roleId: role.id,
        instanceId: task.instanceId,
        detail: { steps: task.usage?.steps },
      });
      await notifyParent(tx, done);
    });
  }

  // --- helpers ----------------------------------------------------------------------------------------

  async fail(taskId: string, reason: string): Promise<void> {
    await transaction(async (tx) => {
      const task = await getTask(tx, taskId);
      if (task && !TERMINAL.has(task.status)) await this.failIn(tx, task, reason);
    });
  }

  async failIn(db: Db, task: Task, reason: string): Promise<null> {
    const done = await setStatus(db, task, "failed", reason, { error: reason });
    const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
    const [role] = await db.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
    if (topic) {
      await systemMessage(db, topic, `Task by @${role?.handle ?? "?"} failed: ${reason}`, {
        taskId: task.id,
        mentions: task.requesterUserId ? [{ type: "user", id: task.requesterUserId }] : [],
      });
    }
    await audit(db, "task.failed", {
      actorType: "role",
      actorId: task.ownerRoleId,
      outcome: "error",
      taskId: task.id,
      topicId: task.topicId,
      detail: { reason },
    });
    await notifyParent(db, done);
    return null;
  }

  /** Computer unavailable or busy: wait (bounded) and retry the same call; never run it elsewhere. */
  private waitForInstance(taskId: string, call: ToolCall, reason: string): Promise<void> {
    return transaction(async (tx) => {
      const task = await getTask(tx, taskId);
      if (!task || TERMINAL.has(task.status)) return;
      await appendStep(tx, task, "event", { type: "instance_wait", reason, tool: call.name });
      const since = task.wait?.type === "instance" ? task.wait.since : null;
      await setStatus(tx, task, "waiting_resource", reason, {
        wait: {
          type: "instance",
          instance_id: task.instanceId,
          since: since ?? new Date().toISOString(),
          retry_call: { id: call.id, name: call.name, arguments: call.arguments },
        },
      });
    });
  }

  private async requestApproval(db: Db, task: Task, call: ToolCall): Promise<void> {
    const approvers = [...(await usersWithPermission(db, Perm.APPROVAL_DECIDE, task.ownerRoleId))].sort();
    const [approval] = await db
      .insert(approvals)
      .values({
        id: newId("apr"),
        taskId: task.id,
        topicId: task.topicId,
        roleId: task.ownerRoleId,
        action: call.name,
        detail: { tool_call: { id: call.id, name: call.name, arguments: call.arguments } },
        approverUserIds: approvers,
      })
      .returning();
    const [role] = await db.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
    const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
    await setStatus(db, task, "waiting_approval", `${call.name} needs approval`, {
      wait: { type: "approval", approval_id: approval.id, tool_call_id: call.id },
    });
    if (topic) {
      const preview = (await textRestricted(db, task))
        ? "(details withheld here because they draw on restricted material; see the approvals page)"
        : redact(JSON.stringify(call.arguments)).slice(0, 500);
      await systemMessage(db, topic, `@${role?.handle ?? "?"} asks for approval to use ${call.name}: ${preview}`, {
        taskId: task.id,
        mentions: approvers.slice(0, 5).map((id) => ({ type: "user" as const, id })),
      });
    }
    await audit(db, "approval.request", {
      actorType: "role",
      actorId: task.ownerRoleId,
      taskId: task.id,
      topicId: task.topicId,
      detail: { tool: call.name },
    });
  }
}

const UNCERTAIN =
  "uncertain: the computer did not confirm whether this action happened. Check the current state (screenshot, read the file, list the directory, read the page) before repeating it.";

/** What the model is told about an interrupted operation, from the runner's journal. */
function describeRecovered(outcome: RecoverResult, why: string): string {
  if (outcome.state === "completed")
    return `recovered result (${why}; the computer had finished it): ${JSON.stringify(outcome.result).slice(0, settings().toolOutputLimit)}`;
  if (outcome.state === "failed") return `error: ${outcome.error?.message ?? "the operation failed"}`;
  if (outcome.state === "running") return `${UNCERTAIN} The operation is still running in the computer (${why}).`;
  return `${UNCERTAIN} (${why})`;
}

/** Tools whose effect is a computer operation journaled by the gateway. */
function opBacked(name: string): boolean {
  return (
    TOOLS.get(name)?.group !== null &&
    !["collaborate", "memory", "topics"].includes(TOOLS.get(name)?.group ?? "") &&
    name !== "share_file" &&
    name !== "release_desktop"
  );
}

const AUDITED_ARGS = new Set([
  "command",
  "path",
  "session",
  "action",
  "role",
  "topic_id",
  "minutes",
  "keys",
  "scope",
  "url",
  "mode",
  "from",
  "to",
]);

/** Operationally relevant arguments only (redacted); free text such as messages or notes is left out. */
export function auditArgs(args: Record<string, any>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [
      k,
      AUDITED_ARGS.has(k) ? redact(String(v)).slice(0, 300) : `<${String(v).length} chars>`,
    ]),
  );
}

function shortArgs(args: Record<string, any>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v]),
  );
}

export async function notifyParent(db: Db, child: Task): Promise<void> {
  if (!child.parentTaskId) return;
  const parent = await getTask(db, child.parentTaskId);
  if (parent) await collectChildren(db, parent);
}

/** Hand delegates' results to a parent waiting for them (also swept periodically by the worker). */
export async function collectChildren(db: Db, parent: Task): Promise<void> {
  if (parent.status !== "waiting_children") return;
  const wait = parent.wait ?? {};
  const ids: string[] = wait.child_ids ?? [];
  const children = ids.length ? await db.select().from(tasks).where(inArray(tasks.id, ids)) : [];
  if (children.length !== ids.length || children.some((c) => !TERMINAL.has(c.status))) return;
  const parts: string[] = [];
  const labels = new Set(parent.labels);
  for (const c of children) {
    const [role] = await db.select().from(roles).where(eq(roles.id, c.ownerRoleId)).limit(1);
    const outcome = c.status === "completed" ? c.result : `${c.status}: ${c.statusReason ?? c.error ?? ""}`;
    parts.push(`Result from @${role?.handle ?? "?"} (task ${c.id}): ${outcome}`);
    for (const l of c.labels) labels.add(l); // whatever the delegate read flows back with its answer
  }
  const [updated] = await db
    .update(tasks)
    .set({ labels: [...labels] })
    .where(eq(tasks.id, parent.id))
    .returning();
  await appendStep(db, updated, "tool", {
    tool_call_id: wait.tool_call_id,
    name: "delegate_task",
    content: parts.join("\n\n"),
  });
  await setStatus(db, updated, "pending", "delegated work finished", { wait: null });
}

/** Atomically move pending -> running for this worker (several workers may compete). */
export async function claimNext(db: Db, workerId: string, limit: number, leaseMs: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await db.execute(sql`
    update tasks set status = 'running', claimed_by = ${workerId},
      lease_until = now() + (${leaseMs} || ' milliseconds')::interval,
      started_at = coalesce(started_at, now()), updated_at = now()
    where id in (
      select id from tasks where status = 'pending' order by created_at
      for update skip locked limit ${limit}
    )
    returning id`);
  return ((rows as any).rows ?? rows).map((r: any) => r.id as string);
}

export { and };

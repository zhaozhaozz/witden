/**
 * Executes one task with the platform's own agent loop: model call -> tool calls -> ... -> final answer.
 *
 * The loop runs in the worker, outside every computer. Each step is persisted so a task survives restarts;
 * computer operations go through the execution gateway. Database transactions stay short: model calls and
 * computer operations happen outside them.
 *
 * A conversation run (agent/conversation.ts) works on its session's context: before each model call it takes
 * in what arrived meanwhile, it compacts the context when it reaches the model's threshold, and instead of
 * ending it carries on while something new is waiting.
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { GatewayClient, RecoverResult } from "../compute/gateway.js";
import { OutcomeUncertain } from "../compute/hub.js";
import { settings } from "../config.js";
import { type Db, db as getDb, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  agentSessions,
  approvals,
  messages,
  type Role,
  roles,
  type Task,
  type Topic,
  taskSteps,
  tasks,
  topics,
  usageRecords,
} from "../db/schema.js";
import { InstanceBusy, InstanceUnavailable, WitdenError } from "../errors.js";
import { redact } from "../security/crypto.js";
import { Perm, usersWithPermission } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { contextLimits } from "../services/context-window.js";
import { approvalChanged } from "../services/events.js";
import * as models from "../services/model-configs.js";
import { linkedTopicContext } from "../services/topic-links.js";
import { initialMessages, recordSessionNote } from "./context.js";
import { getTask, setStatus, TERMINAL } from "./control.js";
import {
  COMPACT_PROMPT,
  inject,
  lastBatchExplicit,
  needsCompaction,
  noteRunEnd,
  saveSummary,
  settle,
} from "./conversation.js";
import { systemMessage } from "./dispatch.js";
import { LiveFeed, type LiveTarget } from "./live.js";
import type { ChatMessage, ChatModel, LLMResponse, ToolCall } from "./llm.js";
import { deliver } from "./output.js";
import { activeKillSwitch, stillAllowed } from "./revocation.js";
import { consumeTaskInputs, hasTaskInputs, lockTask } from "./task-continuation.js";
import { needsApproval, SIDE_EFFECT_TOOLS, TOOLS, type ToolResult, toolsFor } from "./tools.js";
import { withTopicRules } from "./topic-messaging.js";
import { appendStep, isConversation, loadTranscript } from "./transcript.js";

interface Prepared {
  model: ChatModel;
  messages: ChatMessage[];
  tools: { name: string; description: string; parameters: Record<string, any> }[];
  modelConfigId: string;
  live: LiveTarget;
  /** Whether the answer is streamed into the topic while it is written (not for a summary). */
  showText: boolean;
  conversation: boolean;
  /** The conversation's context reached its threshold: summarise it before going on. */
  compact?: boolean;
  /** The conversation has nothing new and nothing left to do: the run ends without a model call. */
  idle?: boolean;
}

/** Roughly four characters a token; an image counts as about a thousand. */
function estimateTokens(messages: ChatMessage[], response: LLMResponse): number {
  let chars = response.content.length + JSON.stringify(response.toolCalls).length;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else
      for (const part of m.content) {
        if (part.type === "text") chars += part.text.length;
        else images++;
      }
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4) + images * 1000;
}

/** The context could not be summarised at all (every part was too long for the model). */
const TOO_LONG =
  "(The earlier part of this conversation was too long for the model to summarise and has been cleared. Read the topic with topic_history if you need it.)";

/** The whole context, then its later half and quarter — each starting at a user turn, as a context must. */
function laterParts(context: ChatMessage[]): ChatMessage[][] {
  const parts = [context];
  for (const share of [0.5, 0.75]) {
    const at = context.findIndex((m, i) => i >= Math.floor(context.length * share) && m.role === "user");
    if (at > 0 && at < context.length) parts.push(context.slice(at));
  }
  return parts;
}

/** A model service refusing a request for being longer than its context window. */
const OVERFLOW =
  /context[^.]{0,40}(length|window|limit)|prompt is too long|too many tokens|maximum[^.]{0,40}tokens|exceeds?[^.]{0,40}(context|tokens)/i;

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
      // A failed compaction is not tried again in this pass, and a refused (too long) request is compacted and
      // retried once: neither can loop.
      let mayCompact = true;
      let overflowRetried = false;
      for (;;) {
        const prepared = await this.prepare(taskId, mayCompact);
        if (!prepared) return;
        if (prepared.idle) {
          await this.finishIdle(taskId);
          return;
        }
        if (prepared.compact) {
          if (!(await this.compact(taskId, prepared))) mayCompact = false;
          continue;
        }
        const feed = new LiveFeed(prepared.live, prepared.showText);
        feed.thinking();
        let response: LLMResponse;
        try {
          response = await prepared.model.complete(
            prepared.messages,
            prepared.tools.length ? prepared.tools : undefined,
            feed.showText ? (text) => feed.write(text) : undefined,
          );
        } catch (err) {
          if (err instanceof WitdenError) {
            await feed.close();
            // Longer than the window after all (the threshold was set too high): summarise and try again once.
            if (prepared.conversation && !overflowRetried && OVERFLOW.test(err.message)) {
              overflowRetried = true;
              if (await this.compact(taskId, prepared, true)) continue;
            }
            await this.fail(taskId, `model error: ${err.message}`);
            return;
          }
          throw err;
        }
        await feed.close();
        const calls = await this.record(taskId, prepared, response);
        if (calls === null) return;
        if (!calls.length) {
          // A conversation that got new messages while answering goes on with them.
          if (await this.finish(taskId, response.content)) continue;
          return;
        }
        for (const call of calls) {
          await feed.tool(call.name);
          if (!(await this.execute(taskId, call))) return;
        }
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
      const task = await lockTask(tx, taskId);
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
        const t = await lockTask(tx, taskId);
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
      const task = await lockTask(tx, taskId);
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

  private prepare(taskId: string, mayCompact = true): Promise<Prepared | null> {
    return transaction(async (tx) => {
      let task = await lockTask(tx, taskId);
      if (task?.status !== "running") return null;
      const [role] = await tx.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
      const [topic] = await tx.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
      if (!role || !topic || !(await this.gate(tx, task))) return null;
      const conversation = isConversation(task);
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
        // The role's own parameters and effort, as they were when the task was created.
        model = await models.chatModelFor(tx, cfg, {
          params: task.roleSnapshot.model_params,
          effort: task.roleSnapshot.reasoning_effort,
        });
      } catch (err) {
        return this.failIn(tx, task, (err as Error).message);
      }
      let initial = await initialMessages(tx, task, role, topic);
      initial[0].content = withTopicRules(String(initial[0].content), task.envelope);
      // A model that cannot call tools can still answer in text.
      const specs = cfg.capabilities?.tools === false ? [] : toolsFor(task.envelope);
      const tools = specs.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
      const base = {
        model,
        tools,
        modelConfigId: cfg.id,
        live: { task_id: task.id, role_id: task.ownerRoleId, topic_id: task.topicId },
        conversation,
      };
      let transcript: ChatMessage[];
      if (conversation) {
        // The summary is written from the context as it is, before anything new is added to it.
        if (mayCompact && (await needsCompaction(tx, task, contextLimits(cfg).compactAt))) {
          transcript = await loadTranscript(tx, task);
          return { ...base, messages: [initial[0], ...transcript], showText: false, compact: true };
        }
        const injected = await inject(tx, task, topic, role);
        task = (await lockTask(tx, taskId))!;
        initial = await initialMessages(tx, task, role, topic);
        initial[0].content = withTopicRules(String(initial[0].content), task.envelope);
        base.tools = (cfg.capabilities?.tools === false ? [] : toolsFor(task.envelope)).map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));
        transcript = await loadTranscript(tx, task);
        const last = transcript[transcript.length - 1];
        if (!injected && (!last || (last.role === "assistant" && !last.tool_calls?.length)))
          return { ...base, messages: [], showText: false, idle: true };
      } else {
        transcript = await loadTranscript(tx, task);
        if (!transcript.length) {
          await appendStep(tx, task, "user", {
            content: `${initial[1].content}\n\n${await linkedTopicContext(tx, topic.id)}`,
          });
          transcript = await loadTranscript(tx, task);
        }
      }
      if (!conversation) {
        await consumeTaskInputs(tx, task);
        transcript = await loadTranscript(tx, task);
      }
      // A conversation's budget counts per turn (each batch of new messages starts a new count).
      const budget = task.budget ?? {};
      const usage = task.usage ?? {};
      const s = settings();
      const steps = conversation ? (usage.turn_steps ?? 0) : (usage.steps ?? 0);
      const tokens = conversation ? (usage.turn_tokens ?? 0) : (usage.tokens ?? 0);
      if (steps >= (budget.max_steps ?? s.maxTaskSteps))
        return this.failIn(tx, task, "step budget exhausted before the work was finished");
      if (budget.max_tokens && tokens >= budget.max_tokens)
        return this.failIn(tx, task, "token budget exhausted before the work was finished");
      return { ...base, messages: [initial[0], ...transcript], showText: true };
    });
  }

  /**
   * The conversation's context reached its threshold: the model summarises it (same prompt start, so the
   * service can serve it from its cache) and the summary becomes the start of the context. The system
   * prompt and the tools are not part of it: they are rebuilt for every call.
   */
  private async compact(taskId: string, prepared: Prepared, overflow = false): Promise<boolean> {
    const feed = new LiveFeed(prepared.live, false);
    feed.compacting();
    const [system, ...context] = prepared.messages;
    // After an overflow the latest messages were already added: they stay word for word after the summary,
    // and only what came before them is summarised.
    const last = context[context.length - 1];
    const tail = overflow && last?.role === "user" && typeof last.content === "string" ? last.content : null;
    const body = tail ? context.slice(0, -1) : context;
    // Too long even to summarise: summarise the later part only, from a user turn on.
    const attempts = overflow ? laterParts(body) : [body];
    const calls: LLMResponse[] = [];
    let summary = "";
    for (const part of attempts) {
      const request: ChatMessage[] = [system, ...part, { role: "user", content: COMPACT_PROMPT }];
      try {
        const first = await prepared.model.complete(request, prepared.tools.length ? prepared.tools : undefined);
        calls.push(first);
        summary = first.toolCalls.length ? "" : first.content.trim();
        if (!summary) {
          // It tried a tool anyway: ask once more without any.
          const second = await prepared.model.complete(request);
          calls.push(second);
          summary = second.content.trim();
        }
        break;
      } catch (err) {
        if (overflow && err instanceof WitdenError && OVERFLOW.test(err.message)) continue;
        console.warn(`[witden] compacting the context of ${taskId} failed: ${(err as Error).message}`);
        break;
      }
    }
    // Rather than stay stuck on a context no request fits into, start it over (the topic keeps everything).
    if (!summary && overflow) summary = TOO_LONG;
    await feed.close();
    return transaction(async (tx) => {
      const task = await lockTask(tx, taskId);
      if (task?.status !== "running") return false;
      for (const r of calls) await this.recordUsage(tx, task, prepared.modelConfigId, r);
      if (!summary) {
        await appendStep(tx, task, "event", { type: "compaction_failed" });
        return false;
      }
      await saveSummary(tx, task, redact(summary), tail);
      await audit(tx, "conversation.compact", {
        actorType: "role",
        actorId: task.ownerRoleId,
        taskId,
        topicId: task.topicId,
        roleId: task.ownerRoleId,
        detail: { messages: prepared.messages.length, summary_chars: summary.length },
      });
      return true;
    });
  }

  private async recordUsage(db: Db, task: Task, modelConfigId: string, response: LLMResponse): Promise<void> {
    await db.insert(usageRecords).values({
      id: newId("use"),
      taskId: task.id,
      roleId: task.ownerRoleId,
      instanceId: task.instanceId,
      modelConfigId,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      cachedTokens: response.cachedTokens ?? 0,
    });
  }

  private record(taskId: string, prepared: Prepared, response: LLMResponse): Promise<ToolCall[] | null> {
    return transaction(async (tx) => {
      const task = await lockTask(tx, taskId);
      if (task?.status !== "running") return null; // cancelled or paused while the model was thinking
      await this.recordUsage(tx, task, prepared.modelConfigId, response);
      const spent = response.promptTokens + response.completionTokens;
      const usage = { ...(task.usage ?? {}) };
      usage.steps = (usage.steps ?? 0) + 1;
      usage.tokens = (usage.tokens ?? 0) + spent;
      usage.cached_tokens = (usage.cached_tokens ?? 0) + (response.cachedTokens ?? 0);
      if (prepared.conversation) {
        usage.turn_steps = (usage.turn_steps ?? 0) + 1;
        usage.turn_tokens = (usage.turn_tokens ?? 0) + spent;
        // How big the context is now: the next call decides on compaction by it. A service that reports no
        // usage gets an estimate, or its conversations would never be compacted.
        const size = response.promptTokens ? spent : estimateTokens(prepared.messages, response);
        await tx.update(agentSessions).set({ contextTokens: size }).where(eq(agentSessions.id, task.sessionId!));
      }
      await tx.update(tasks).set({ usage }).where(eq(tasks.id, taskId));
      const payload: Record<string, any> = { content: response.content };
      // Kept for the next request: DeepSeek asks for its reasoning back on later turns that use tools.
      if (response.reasoning) payload.reasoning_content = response.reasoning;
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
      const task = await lockTask(tx, taskId);
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
      const approved = (task.envelope.approved_calls ?? []).includes(call.id);
      if (needsApproval(task.envelope, spec, call.arguments) && !approved) {
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
          mode: isConversation(task) ? "conversation" : "task",
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
      const current = await lockTask(tx, taskId);
      if (!current) return false;
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
      if (result.control === "silent") {
        // The role decided the message does not need it: the task ends, nothing is posted.
        await appendStep(tx, current, "tool", { tool_call_id: call.id, name: call.name, content });
        // A conversation that meanwhile got something new goes on with it.
        if (isConversation(current) && (await settle(tx, current))) return true;
        const done = await setStatus(tx, current, "completed", "chose not to reply", { result: "" });
        if (isConversation(done)) await noteRunEnd(tx, done);
        await audit(tx, "task.silent", {
          actorType: "role",
          actorId: current.ownerRoleId,
          taskId,
          topicId: current.topicId,
          roleId: current.ownerRoleId,
          detail: { reason: typeof content === "string" ? content.slice(0, 300) : "" },
        });
        await notifyParent(tx, done);
        return false;
      }
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

  /**
   * The model gave its final answer. Returns true when a conversation run goes on instead of ending: something
   * new arrived while it was answering.
   */
  private finish(taskId: string, content: string): Promise<boolean> {
    return transaction(async (tx) => {
      const task = await lockTask(tx, taskId);
      if (task?.status !== "running") return false;
      const [role] = await tx.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
      const [topic] = await tx.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
      const conversation = isConversation(task);
      // A newer input arrived while the model answered: do not publish a stale final answer.
      if (!conversation && (await hasTaskInputs(tx, task.id))) return true;
      const said = redact(content.trim());
      // Everything may already have been said with send_message: then the empty final answer posts nothing.
      // A conversation looks only at what it posted since the latest messages reached it; a task only at this
      // iteration (a continued task must not report what an earlier iteration said).
      const since = conversation ? await this.lastInjection(tx, task) : task.startedAt;
      const [sent] = said
        ? []
        : await tx
            .select({ content: messages.content })
            .from(messages)
            .where(
              and(
                eq(messages.taskId, task.id),
                eq(messages.authorType, "role"),
                ...(since ? [gte(messages.createdAt, since)] : []),
              ),
            )
            .orderBy(desc(messages.createdAt))
            .limit(1);
      // A conversation may end a turn without a word when nobody @-mentioned it (like stay_silent).
      const quiet = conversation && !said && !sent && !(await lastBatchExplicit(tx, task));
      // A task started by a conversation reports back to it; nothing is posted for it.
      const reportOnly = !!task.envelope?.report_only;
      if (sent || quiet || reportOnly) {
        const result = sent?.content ?? (reportOnly ? said || "(no answer)" : "");
        return this.complete(tx, task, role, topic, result);
      }
      const text = said || "(no answer)";
      await deliver(tx, task, role, topic, text, { final: true });
      return this.complete(tx, task, role, topic, text);
    });
  }

  /** End the run with its result — unless it is a conversation run and something new is waiting. */
  private async complete(db: Db, task: Task, role: Role, topic: Topic, result: string): Promise<boolean> {
    if (isConversation(task) && (await settle(db, task))) return true;
    const done = await setStatus(db, task, "completed", null, { result });
    if (isConversation(done)) await noteRunEnd(db, done);
    else await recordSessionNote(db, done, result);
    await audit(db, "task.complete", {
      actorType: "role",
      actorId: role.id,
      taskId: task.id,
      topicId: topic.id,
      roleId: role.id,
      instanceId: task.instanceId,
      detail: { steps: task.usage?.steps },
    });
    await notifyParent(db, done);
    return false;
  }

  /** Nothing new and nothing left to do (the inbox was taken by an earlier pass): end without a model call. */
  private finishIdle(taskId: string): Promise<void> {
    return transaction(async (tx) => {
      const task = await lockTask(tx, taskId);
      if (task?.status !== "running") return;
      const done = await setStatus(tx, task, "completed", "nothing new", { result: task.result ?? "" });
      await noteRunEnd(tx, done);
    });
  }

  /** When the latest batch of new messages reached this run. */
  private async lastInjection(db: Db, task: Task): Promise<Date | null> {
    const [step] = await db
      .select({ at: taskSteps.createdAt })
      .from(taskSteps)
      .where(and(eq(taskSteps.taskId, task.id), eq(taskSteps.kind, "user")))
      .orderBy(desc(taskSteps.seq))
      .limit(1);
    return step?.at ?? null;
  }

  // --- helpers ----------------------------------------------------------------------------------------

  async fail(taskId: string, reason: string): Promise<void> {
    await transaction(async (tx) => {
      const task = await lockTask(tx, taskId);
      if (task && !TERMINAL.has(task.status)) await this.failIn(tx, task, reason);
    });
  }

  async failIn(db: Db, task: Task, reason: string): Promise<null> {
    const done = await setStatus(db, task, "failed", reason, { error: reason });
    const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
    const [role] = await db.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
    if (topic) {
      const what = isConversation(task)
        ? `@${role?.handle ?? "?"} stopped working`
        : `Task by @${role?.handle ?? "?"} failed`;
      await systemMessage(db, topic, `${what}。本次处理未能完成，请稍后重试。`, {
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
      const task = await lockTask(tx, taskId);
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

  /** Hold a call for the approval of a person who decides approvals for the role. */
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
      // Notices also reach external conversations. Keep arguments in the permission-checked approval API.
      await systemMessage(db, topic, `@${role?.handle ?? "?"} 申请使用 ${call.name}。请在控制台查看详情并审批。`, {
        taskId: task.id,
        approvalId: approval.id,
        mentions: approvers.slice(0, 5).map((id) => ({ type: "user" as const, id })),
      });
    }
    await approvalChanged(db, approval);
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
  // which note update_memory / forget touched (not its text)
  "id",
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
  for (const c of children) {
    const [role] = await db.select().from(roles).where(eq(roles.id, c.ownerRoleId)).limit(1);
    const outcome = c.status === "completed" ? c.result : `${c.status}: ${c.statusReason ?? c.error ?? ""}`;
    parts.push(`Result from @${role?.handle ?? "?"} (task ${c.id}): ${outcome}`);
  }
  await appendStep(db, parent, "tool", {
    tool_call_id: wait.tool_call_id,
    name: "delegate_task",
    content: parts.join("\n\n"),
  });
  await setStatus(db, parent, "pending", "delegated work finished", { wait: null });
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

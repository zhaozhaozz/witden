/**
 * Hand an independent task to another role without replacing it.
 *
 * A task belongs to its topic; ownerRoleId is the role executing it now, not its identity. Only work that
 * nothing executes and nothing waits on changes hands. The new role works with its own permissions on its own
 * computer. Earlier steps stay in the task's log but not in the new role's model context: that starts from a
 * handoff brief (transcript.ts reads from assignment.handoff_context_from_seq).
 *
 * Whoever hands it over, a task goes only to a role already taking part in its topic; a hand-over never brings a
 * role in (a person invites it first). A person hands a task over from the console (transferTask). A role hands
 * one over with transfer_task: the task it is executing (requestHandover records it at the call, the worker
 * applies it once the run is over: finishHandover), or a task its conversation started that nothing runs
 * (transferStartedTask).
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import {
  approvals,
  computerInstances,
  type Role,
  roles,
  type Task,
  type Topic,
  taskInputs,
  taskSteps,
  tasks,
  type User,
} from "../db/schema.js";
import { BadRequest, Forbidden, NotFound, WitdenError } from "../errors.js";
import { externalRoleId } from "../integrations/links.js";
import { audit } from "../services/audit.js";
import { type SourceLimits, sourceLimits, withSourceLimits } from "../services/collaboration-policy.js";
import { wake } from "../services/events.js";
import * as topicSvc from "../services/topics.js";
import { ACTIVE, getTask, publishTaskStatus, setStatus, TERMINAL } from "./control.js";
import { authorize, buildEnvelope, roleSnapshotFor, systemMessage, taskBudget } from "./dispatch.js";
import { activeKillSwitch, stillAllowed } from "./revocation.js";
import { lockTask } from "./task-continuation.js";
import { appendStep } from "./transcript.js";

/** Nothing executes these, and nothing is outstanding for the previous role. */
export const TRANSFERABLE = new Set(["pending", "waiting_resource", "waiting_role", "completed", "failed"]);

/** Where the work came from and how its answer travels stay with it; the permissions are the new role's. */
const CARRIED = [
  "report_only",
  "auto",
  "outside",
  "external_topic",
  "untrusted_input",
  "automation_event",
  "topic_routes",
];

/** Who hands a task over: a person, or a role of the topic. Neither brings another role in. */
type By = { user: User; role?: undefined } | { role: Role; user?: undefined };

/** A role's hand-over of the task it executes, waiting for its run to end. The note stays in the call's step. */
interface HandoverRequest {
  to_role_id: string;
  by_role_id: string;
  revision: number;
  tool_call_id: string;
  at: string;
}

function envelopeFor(task: Task, target: Role, parent: Task | null): Record<string, any> {
  const env = buildEnvelope(target, parent);
  for (const key of CARRIED) if (task.envelope?.[key] !== undefined) env[key] = task.envelope[key];
  // As for continuations (task-continuation.ts): no configuration tools for work from outside or automation.
  if (env.outside || env.automation_event || env.untrusted_input)
    env.tools = env.tools.filter((t: string) => !["config", "profile", "automation"].includes(t));
  return env;
}

function refusal(status: string): string {
  if (status === "running") return "the task is running; hand it over after it stops, or cancel it";
  if (status === "paused") return "the task is paused by an emergency stop or a takeover; resume or cancel it first";
  if (status === "cancelled") return "retry the cancelled task before handing it over";
  return "resolve the pending approval, delegated work, question or timer before handing the task over";
}

/** Whoever hands it over: only an independent task outside a DM. Returns its topic. */
async function checkTask(db: Db, task: Task): Promise<Topic> {
  if (task.kind !== "task") throw new BadRequest("a role's conversation cannot be reassigned; only tasks can");
  const topic = await topicSvc.getTopic(db, task.topicId);
  // A DM is the conversation between one person and one role: no other role can take its work over.
  if (topic.kind === "dm")
    throw new BadRequest("a task in a DM cannot be handed to another role: a DM has only its one role");
  // Nor the work of one of two roles talking directly (agent/contacts.ts): that would hand it to the other without
  // a permission, whether a person or a role (transfer_task) hands it over.
  if (topic.kind === "pair")
    throw new BadRequest("a task in a conversation between two AI employees cannot be handed to another role");
  return topic;
}

/** A task changes hands from outside only while nothing runs it and no run still holds it. */
function checkIdle(task: Task): void {
  if (!TRANSFERABLE.has(task.status)) throw new BadRequest(refusal(task.status));
  // A run that just stopped may still be finishing its last call; the worker releases the claim when it exits.
  if (task.claimedBy && task.leaseUntil && task.leaseUntil > new Date())
    throw new BadRequest("the previous run is still finishing; try again in a moment");
}

/**
 * The checks for the new executor, as for new work of the original requester. Returns the task as the new role
 * would run it, with what the assignment records. ``limits``: those of the input the role handing over acts on.
 */
async function prepare(db: Db, task: Task, topic: Topic, target: Role, by: By, limits: SourceLimits | null = null) {
  if (task.ownerRoleId === target.id) throw new BadRequest("the task is already assigned to this role");
  if (target.systemAdmin) throw new Forbidden("the system administrator does not take over tasks");
  if (target.status !== "active") throw new Forbidden("target role is disabled");
  // An approval decided later would run the previous role's call as the new role.
  const [approval] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.taskId, task.id), eq(approvals.status, "pending")))
    .limit(1);
  if (approval) throw new BadRequest("decide the task's pending approval before handing it over");
  const [child] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, task.id), inArray(tasks.status, [...ACTIVE])))
    .limit(1);
  if (child) throw new BadRequest("work this task delegated is still under way; wait for it or cancel it");

  if (topic.status !== "active") throw new Forbidden("cannot reassign work in an archived topic");
  // Work never brings a role into a topic, whoever hands it over: a person invites the role first.
  if (!(await topicSvc.participant(db, topic.id, "role", target.id))) {
    if (by.role)
      throw new Forbidden(
        `@${target.handle} is not in this topic: hand tasks only to roles taking part in it; ask a person to invite another role`,
      );
    // Only the bot's role works in an external conversation: nobody can be invited there to take it over.
    throw new Forbidden(
      (await externalRoleId(db, topic.id)) !== undefined
        ? "only the bot's AI employee works in a Slack, Feishu or GitHub conversation: no other AI employee can take this task over"
        : `@${target.handle} is not in this topic: tasks are handed only to AI employees taking part in it; invite it into the topic first (topic settings, participants), then hand the task over`,
    );
  }
  // The same checks as new work for the target, as the original requester.
  const { allowed, refusals } = await authorize(db, topic, task.requesterUserId, [target.id]);
  if (!allowed.length) throw new Forbidden(`cannot reassign: ${refusals.join("; ")}`);
  const parent = task.parentTaskId ? ((await getTask(db, task.parentTaskId)) ?? null) : null;
  const next: Task = {
    ...task,
    ownerRoleId: target.id,
    instanceId: target.instanceId,
    envelope: withSourceLimits(envelopeFor(task, target, parent), limits),
  };
  if (await activeKillSwitch(db, next)) throw new Forbidden("an emergency stop covers the new executor");
  const denied = await stillAllowed(db, next);
  if (denied) throw new Forbidden(denied);
  return { next, assignment: allowed[0][1], parent };
}

/** Hand the task over (the checks passed). A role's hand-over also counts as a round of automatic work. */
async function apply(
  db: Db,
  task: Task,
  topic: Topic,
  target: Role,
  prepared: Awaited<ReturnType<typeof prepare>>,
  by: By,
  note: string,
  round?: number,
): Promise<Task> {
  const previous = await topicSvc.getRole(db, task.ownerRoleId);
  const actor = by.user ? { by: by.user.id } : { by_role_id: by.role.id };
  const byName = by.user ? by.user.name : `@${by.role.handle}`;
  await appendStep(db, task, "event", {
    type: "role_handoff",
    from_role_id: task.ownerRoleId,
    to_role_id: target.id,
    from_instance_id: task.instanceId,
    to_instance_id: target.instanceId,
    ...actor,
    prior_status: task.status,
    revision: task.revision,
    previous_usage: task.usage,
  });
  // Only the requirements and outcomes cross over, never the previous role's tool output (it may hold material
  // only that role could read).
  const inputs = await db
    .select()
    .from(taskInputs)
    .where(and(eq(taskInputs.taskId, task.id), isNotNull(taskInputs.consumedAt)))
    .orderBy(desc(taskInputs.createdAt), desc(taskInputs.id))
    .limit(26);
  const followUps = inputs
    .slice(0, 25)
    .reverse()
    .map((input) => `[revision ${input.revision}] ${input.content.slice(0, 1200)}`)
    .join("\n");
  const brief = [
    `You are taking over task ${task.id} in topic "${topic.title}" from @${previous?.handle ?? "?"}; it is the same task, only its executor changed.`,
    `Task: ${task.title}\nOriginal instructions:\n${task.instruction}`,
    followUps
      ? `Follow-up requirements${inputs.length > 25 ? " (earlier ones omitted; see the task history)" : ""}:\n${followUps}`
      : "",
    task.result ? `Last delivered result:\n${task.result.slice(0, 3000)}` : "",
    task.error ? `It last failed with: ${task.error.slice(0, 1000)}` : "",
    task.progress ? `Last recorded progress:\n${task.progress.slice(0, 2000)}` : "",
    note.trim() ? `Handoff note from ${byName}:\n${note.trim().slice(0, 4000)}` : "",
    "The previous executor's steps were not handed over. You work on your own computer: files, installed software " +
      "and credentials were not copied, so check what is there before changing anything.",
  ]
    .filter(Boolean)
    .join("\n\n");
  // Follow-ups not read yet stay queued (task_inputs): the new role reads them after this brief, at its first step.
  const contextFrom = await appendStep(db, task, "user", { content: brief, type: "role_handoff_brief" });

  // Finished work stays finished until a person continues or retries it; anything else is queued for the new role.
  let status = task.status;
  let wait: Record<string, any> | null = null;
  if (!TERMINAL.has(status)) {
    const [inst] = target.instanceId
      ? await db.select().from(computerInstances).where(eq(computerInstances.id, target.instanceId)).limit(1)
      : [];
    status = inst && inst.status !== "running" ? "waiting_resource" : "pending";
    if (inst && status === "waiting_resource")
      wait = { type: "instance", instance_id: inst.id, since: new Date().toISOString() };
  }
  const { handover_request: _done, ...assignment } = task.assignment ?? {};
  const handoffs = Array.isArray(assignment.handoffs) ? assignment.handoffs : [];
  const [updated] = await db
    .update(tasks)
    .set({
      ownerRoleId: target.id,
      instanceId: target.instanceId,
      roleSnapshot: await roleSnapshotFor(db, target),
      envelope: prepared.next.envelope,
      budget: taskBudget(target, prepared.parent),
      // The new role has its own step budget; what the previous one used stays in the log and usage records.
      usage: { steps: 0, tokens: 0 },
      ...(round !== undefined ? { round } : {}),
      assignment: {
        ...assignment,
        ...prepared.assignment,
        handoff_context_from_seq: contextFrom,
        handoffs: [
          ...handoffs,
          {
            from_role_id: task.ownerRoleId,
            to_role_id: target.id,
            from_instance_id: task.instanceId,
            to_instance_id: target.instanceId,
            ...actor,
            at: new Date().toISOString(),
          },
        ],
      },
      status,
      statusReason: `handed over to @${target.handle} by ${byName}`,
      wait,
      claimedBy: null,
      leaseUntil: null,
    })
    .where(eq(tasks.id, task.id))
    .returning();
  await publishTaskStatus(db, updated);
  await audit(db, "task.reassign", {
    actorType: by.user ? "user" : "role",
    actorId: by.user?.id ?? by.role!.id,
    taskId: task.id,
    topicId: task.topicId,
    roleId: target.id,
    instanceId: target.instanceId,
    detail: {
      from_role: task.ownerRoleId,
      to_role: target.id,
      old_instance: task.instanceId,
      new_instance: target.instanceId,
      prior_status: task.status,
    },
  });
  const moved = task.instanceId !== target.instanceId;
  let message: string;
  if (by.user) {
    message = `Task handed over from @${previous?.handle ?? "?"} to @${target.handle} by ${by.user.name}; it keeps its history.`;
    if (moved) message += " It now runs on a different computer; files from the previous computer were not moved.";
  } else {
    const whose = previous && previous.id !== by.role.id ? `@${previous.handle} 的任务` : "任务";
    const excerpt = note.trim().replace(/\s+/g, " ");
    message = `@${by.role.handle} 把${whose}转交给 @${target.handle}${excerpt ? `：${excerpt.length > 200 ? `${excerpt.slice(0, 200)}…` : excerpt}` : "。"}`;
    if (moved) message += "\n\n任务改在另一台虚拟电脑上进行，原虚拟电脑上的文件没有迁移。";
  }
  await systemMessage(db, topic, message, { taskId: task.id });
  if (status === "pending") await wake(db, "tasks");
  return updated;
}

/** A person hands the task over (console), to a role already taking part in the topic. */
export async function transferTask(db: Db, user: User, id: string, target: Role, note = ""): Promise<Task> {
  const task = await lockTask(db, id);
  if (!task) throw new NotFound("task not found");
  const topic = await checkTask(db, task);
  checkIdle(task);
  return apply(db, task, topic, target, await prepare(db, task, topic, target, { user }), { user }, note);
}

// --- hand-overs by roles (transfer_task) ------------------------------------------------------------------

/** Who may hand work over: not the system administrator, and nobody in a Slack, Feishu or GitHub conversation. */
function checkCaller(caller: Role, run: Task): void {
  if (caller.systemAdmin) throw new Forbidden("the system administrator does not hand work to other roles");
  if (run.envelope?.external_topic)
    throw new Forbidden(
      "only the bot's role works in a Slack, Feishu or GitHub conversation: no role can take work over",
    );
}

async function targetRole(db: Db, handle: string, caller: Role): Promise<Role> {
  const name = handle.replace(/^@/, "");
  const [target] = await db.select().from(roles).where(eq(roles.handle, name)).limit(1);
  if (!target) throw new BadRequest(`no role @${name}`);
  if (target.id === caller.id) throw new BadRequest("you cannot hand a task over to yourself");
  return target;
}

/**
 * Roles could hand a task back and forth without end. A hand-over is one more round of automatic work, like an
 * @-mention or a delegation, so the global limit on automatic rounds (maxAutoRounds) bounds it until a person
 * steps in: a person's follow-up starts the task again at round 0. A separate per-task counter would be a second
 * limit to configure and explain, and would miss chains that mix hand-overs with @-mentions and delegation.
 */
function nextRound(task: Task, caller: Task): number {
  const limit = settings().maxAutoRounds;
  const next = Math.max(task.round, caller.round) + 1;
  if (next > limit)
    throw new Forbidden(
      `this work already went ${limit} rounds between roles without a person: finish the task yourself, or ask a person who should take it over`,
    );
  return next;
}

/**
 * transfer_task in a task: the role hands over the task it executes. Everything is checked now; the request is
 * recorded and the run ends after this call. The worker applies it when the run is over (finishHandover).
 */
export async function requestHandover(
  db: Db,
  taskId: string,
  callerId: string,
  toolCallId: string,
  handle: string,
): Promise<Role> {
  const task = await lockTask(db, taskId);
  if (task?.status !== "running") throw new BadRequest("this task is no longer running");
  if (task.ownerRoleId !== callerId) throw new Forbidden("you no longer execute this task");
  if (task.assignment?.handover_request) throw new BadRequest("this task is already being handed over");
  const caller = await topicSvc.getRole(db, callerId);
  if (!caller) throw new BadRequest("task context missing");
  checkCaller(caller, task);
  const topic = await checkTask(db, task);
  const target = await targetRole(db, handle, caller);
  nextRound(task, task);
  await prepare(db, task, topic, target, { role: caller });
  const request: HandoverRequest = {
    to_role_id: target.id,
    by_role_id: caller.id,
    revision: task.revision,
    tool_call_id: toolCallId,
    at: new Date().toISOString(),
  };
  const [row] = await db
    .update(tasks)
    .set({
      assignment: { ...task.assignment, handover_request: request },
      statusReason: `handing over to @${target.handle}`,
    })
    .where(eq(tasks.id, task.id))
    .returning();
  await publishTaskStatus(db, row);
  return target;
}

/** The note the role gave with transfer_task, from the call in its log (a note is never kept in the assignment). */
async function requestedNote(db: Db, task: Task, toolCallId: string): Promise<string> {
  const steps = await db
    .select({ payload: taskSteps.payload })
    .from(taskSteps)
    .where(and(eq(taskSteps.taskId, task.id), eq(taskSteps.kind, "assistant")))
    .orderBy(desc(taskSteps.seq))
    .limit(3);
  for (const step of steps)
    for (const call of step.payload?.tool_calls ?? [])
      if (call.id === toolCallId) {
        try {
          return String(JSON.parse(call.function?.arguments ?? "{}").note ?? "");
        } catch {
          return "";
        }
      }
  return "";
}

/** The hand-over does not happen: the role keeps the task and reads why when it goes on with it. */
async function dropHandover(db: Db, task: Task, request: HandoverRequest, reason: string, resume: boolean) {
  const target = await topicSvc.getRole(db, request.to_role_id);
  const { handover_request: _dropped, ...assignment } = task.assignment ?? {};
  const [row] = await db.update(tasks).set({ assignment }).where(eq(tasks.id, task.id)).returning();
  await appendStep(db, row, "user", {
    content: `Your hand-over of this task to @${target?.handle ?? "?"} did not happen: ${reason}. The task is still yours.`,
    type: "handover_dropped",
  });
  await audit(db, "task.reassign", {
    actorType: "role",
    actorId: request.by_role_id,
    outcome: "denied",
    taskId: task.id,
    topicId: task.topicId,
    roleId: request.to_role_id,
    detail: { from_role: task.ownerRoleId, to_role: request.to_role_id, reason },
  });
  if (resume)
    await setStatus(db, row, "pending", `hand-over to @${target?.handle ?? "?"} did not happen: ${reason}`, {
      claimedBy: null,
      leaseUntil: null,
    });
}

/**
 * At the start of a run: a hand-over that was asked for but never applied (the worker stopped first) ends the run
 * at once, and the worker applies it. A request the task has moved on from (retried, a new iteration) is dropped.
 */
export async function handoverDue(db: Db, id: string): Promise<boolean> {
  const task = await lockTask(db, id);
  const request = task?.assignment?.handover_request as HandoverRequest | undefined;
  if (!task || !request) return false;
  if (task.status === "running" && task.ownerRoleId === request.by_role_id && task.revision === request.revision)
    return true;
  await dropHandover(db, task, request, "the task started over before it took effect", false);
  return false;
}

/**
 * The worker, once a run is over and before it releases its claim, applies the hand-over the run's role asked for
 * — only while the task is still running under this claim and still the requesting role's. A cancellation or an
 * emergency stop that came first wins: the hand-over is dropped. Follow-ups that arrived meanwhile stay queued and
 * reach the new role at its first step.
 */
export async function finishHandover(db: Db, id: string, claim: string): Promise<void> {
  const task = await lockTask(db, id);
  const request = task?.assignment?.handover_request as HandoverRequest | undefined;
  if (!task || !request) return;
  if (task.status !== "running") {
    // Queued again (its worker was given up on): that run ends at once and applies it (handoverDue).
    if (task.status !== "pending") {
      const why = task.statusReason ? `${task.status}: ${task.statusReason}` : task.status;
      await dropHandover(db, task, request, `the task stopped before it took effect (${why})`, false);
    }
    return;
  }
  // Another worker took it over meanwhile: its run applies it.
  if (task.claimedBy !== claim) return;
  try {
    if (task.ownerRoleId !== request.by_role_id || task.revision !== request.revision)
      throw new BadRequest("the task changed meanwhile");
    const caller = await topicSvc.getRole(db, request.by_role_id);
    const target = await topicSvc.getRole(db, request.to_role_id);
    if (!caller || !target) throw new BadRequest("the role no longer exists");
    // Anything may have changed since the call: check everything again.
    const topic = await checkTask(db, task);
    const round = nextRound(task, task);
    const prepared = await prepare(db, task, topic, target, { role: caller });
    const note = await requestedNote(db, task, request.tool_call_id);
    await apply(db, task, topic, target, prepared, { role: caller }, note, round);
  } catch (err) {
    if (!(err instanceof WitdenError)) throw err;
    await dropHandover(db, task, request, err.message, true);
  }
}

/**
 * transfer_task in a conversation: hand over an independent task this conversation started (it reports here, as
 * for continue_task) while nothing runs it, as a person would — but only to a role taking part in the topic.
 */
export async function transferStartedTask(
  db: Db,
  run: Task,
  caller: Role,
  taskId: string,
  handle: string,
  note: string,
): Promise<Task> {
  checkCaller(caller, run);
  if (run.status !== "running") throw new Forbidden("the requesting conversation is no longer running");
  const denied = await stillAllowed(db, run);
  if (denied) throw new Forbidden(denied);
  if (await activeKillSwitch(db, run)) throw new Forbidden("the requesting conversation is stopped");
  const task = await lockTask(db, taskId);
  if (!task) throw new NotFound("task not found");
  if (task.id === run.id || task.topicId !== run.topicId || !run.sessionId || task.reportSessionId !== run.sessionId)
    throw new Forbidden("you may only hand over independent tasks your conversation here started");
  const topic = await checkTask(db, task);
  checkIdle(task);
  const target = await targetRole(db, handle, caller);
  const round = nextRound(task, run);
  // The note comes from this conversation's input: the task keeps that input's limits too.
  const prepared = await prepare(db, task, topic, target, { role: caller }, sourceLimits(run.envelope));
  return apply(db, task, topic, target, prepared, { role: caller }, note, round);
}

/** Turning messages into work: who should respond, is it allowed, and what may the work touch. */
import { and, eq } from "drizzle-orm";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  type AgentSession,
  agentSessions,
  computerInstances,
  type Mention,
  type Message,
  messageRoutes,
  messages,
  type Role,
  roles,
  type Task,
  type Topic,
  tasks,
  topics,
  type User,
  users,
} from "../db/schema.js";
import { Forbidden } from "../errors.js";
import { externalContext, externalRoleId } from "../integrations/links.js";
import { mirrorMessage } from "../integrations/outbound.js";
import { type RequestContext, resolve } from "../services/assignment.js";
import { audit } from "../services/audit.js";
import { relayFrom } from "../services/collaboration-policy.js";
import { publish, wake } from "../services/events.js";
import * as models from "../services/model-configs.js";
import { participantChangeOf, type RoleParticipantChange } from "../services/participant-notices.js";
import * as topicSvc from "../services/topics.js";
import { setStatus } from "./control.js";
import { enqueue, rolesAwaiting } from "./conversation.js";
import { envelopeWithRelay } from "./topic-messaging.js";
import { appendStep } from "./transcript.js";

export const MENTION = /(?<![\w@/])@([A-Za-z0-9][A-Za-z0-9_.-]{0,63})/g;

/** The topic a linked message came from (who asked there, and through which connection, stay on the server). */
const sourceTopicOf = (msg: Message) => {
  const relay = relayFrom(msg.externalRef);
  return relay ? { source_topic_id: relay.source_topic_id } : null;
};

/** The role's settings a task works with: taken when it starts, and again when a finished task starts over. */
export async function roleSnapshotFor(db: Db, role: Role) {
  const found = await models.modelWithProvider(db, role.modelConfigId);
  return {
    config_version: role.configVersion,
    model_config_id: role.modelConfigId,
    model_name: found ? models.modelLabel(found.model, found.provider) : null,
    system_prompt: role.systemPrompt,
    model_params: role.modelParams,
    reasoning_effort: role.reasoningEffort,
    instance_id: role.instanceId,
  };
}

export function messageOut(msg: Message) {
  return {
    id: msg.id,
    topic_id: msg.topicId,
    author_type: msg.authorType,
    author_id: msg.authorId,
    content: msg.deletedAt ? "" : msg.content,
    mentions: msg.mentions,
    reply_to_id: msg.replyToId,
    task_id: msg.taskId,
    approval_id: msg.deletedAt ? null : msg.approvalId,
    participant_change: participantChangeOf(msg),
    attachments: msg.attachments,
    source: msg.source,
    round: msg.round,
    topic_delivery: msg.deletedAt ? null : sourceTopicOf(msg),
    created_at: msg.createdAt.toISOString(),
    edited_at: msg.editedAt?.toISOString() ?? null,
    deleted: !!msg.deletedAt,
  };
}

/** `@handle` -> role participant; `@Name` -> human participant with that (space-free) name. */
export async function parseMentions(db: Db, topic: Topic, content: string): Promise<Mention[]> {
  const roleMap = await topicSvc.roleHandles(db, topic.id);
  const userMap = new Map<string, User>();
  for (const p of await topicSvc.participants(db, topic.id, "user")) {
    const [u] = await db.select().from(users).where(eq(users.id, p.participantId)).limit(1);
    if (u) userMap.set(u.name.toLowerCase(), u);
  }
  const out = new Map<string, Mention>();
  for (const m of content.matchAll(MENTION)) {
    const key = m[1].toLowerCase().replace(/\.+$/, "");
    const role = roleMap.get(key);
    if (role) out.set(`role:${role.id}`, { type: "role", id: role.id });
    else if (userMap.has(key)) out.set(`user:${userMap.get(key)!.id}`, { type: "user", id: userMap.get(key)!.id });
  }
  return [...out.values()];
}

export async function saveMessage(
  db: Db,
  topic: Topic,
  authorType: string,
  authorId: string | null,
  content: string,
  opts: {
    mentions?: Mention[] | null;
    replyToId?: string | null;
    source?: string;
    externalRef?: Record<string, any> | null;
    attachments?: string[];
    round?: number;
    taskId?: string | null;
    approvalId?: string | null;
  } = {},
): Promise<Message> {
  const mentions = opts.mentions ?? (await parseMentions(db, topic, content));
  const [msg] = await db
    .insert(messages)
    .values({
      id: newId("msg"),
      topicId: topic.id,
      authorType,
      authorId,
      content,
      mentions,
      replyToId: opts.replyToId ?? null,
      source: opts.source ?? "web",
      externalRef: opts.externalRef ?? null,
      attachments: opts.attachments ?? [],
      round: opts.round ?? 0,
      taskId: opts.taskId ?? null,
      approvalId: opts.approvalId ?? null,
    })
    .returning();
  await db.update(topics).set({ lastMessageAt: new Date() }).where(eq(topics.id, topic.id));
  await publish(db, "message.created", messageOut(msg), `topic:${topic.id}`);
  await mirrorMessage(db, msg);
  return msg;
}

export function systemMessage(
  db: Db,
  topic: Topic,
  content: string,
  opts: {
    taskId?: string | null;
    approvalId?: string;
    mentions?: Mention[];
    replyToId?: string | null;
    participantChange?: RoleParticipantChange;
  } = {},
) {
  return saveMessage(db, topic, "system", null, content, {
    mentions: opts.mentions ?? [],
    taskId: opts.taskId ?? null,
    approvalId: opts.approvalId ?? null,
    replyToId: opts.replyToId ?? null,
    externalRef: opts.participantChange ? { participant_change: opts.participantChange } : null,
  });
}

// --- authorization -------------------------------------------------------------------------------------

/** Intersection where "*" means "anything". */
function meet(a: string[], b: string[]): string[] {
  if (a.includes("*")) return [...b];
  if (b.includes("*")) return [...a];
  return a.filter((x) => b.includes(x)).sort();
}

export function buildEnvelope(role: Role, parent: Task | null): Record<string, any> {
  const env: Record<string, any> = {
    tools: [...new Set(role.allowedTools)].sort(),
    contacts: [...role.allowedContacts],
    spaces: [...new Set(role.knowledgeSpaceIds)].sort(),
    approval_required: [...role.approvalRequired],
    // The configuration tools are open only to a system administrator's own work, never delegated.
    ...(role.systemAdmin && !parent ? { system_admin: true } : {}),
  };
  if (parent) {
    const p = parent.envelope ?? {};
    // Delegated work can never do more than the delegating task could.
    env.tools = env.tools.filter((t: string) => (p.tools ?? []).includes(t));
    env.contacts = meet(env.contacts, p.contacts ?? []);
    env.spaces = env.spaces.filter((s: string) => (p.spaces ?? []).includes(s));
    env.approval_required = [...new Set([...env.approval_required, ...(p.approval_required ?? [])])].sort();
    env.inherited_from = parent.id;
  }
  if (parent) {
    if (parent.envelope.untrusted_input) env.untrusted_input = true;
    if (parent.envelope.outside) env.outside = true;
    if (parent.envelope.automation_event) env.automation_event = true;
    if (parent.envelope.topic_routes) env.topic_routes = parent.envelope.topic_routes;
  }
  return env;
}

/** Checks independent of who asks: model availability and topic model restrictions. */
export async function preflight(db: Db, topic: Topic, role: Role): Promise<string[]> {
  const reasons: string[] = [];
  if (topic.status !== "active") reasons.push("the topic is archived");
  if (!role.modelConfigId) reasons.push(`@${role.handle} has no model configured`);
  else {
    const found = await models.modelWithProvider(db, role.modelConfigId);
    const unusable = found ? models.unusableReason(found.model, found.provider) : "it no longer exists";
    if (!found || unusable) reasons.push(`@${role.handle}'s model is unavailable: ${unusable}`);
    else if (topic.allowedModelConfigIds && !topic.allowedModelConfigIds.includes(found.model.id)) {
      // No silent switch to another model: the role simply cannot act here.
      reasons.push(
        `this topic only allows specific models; @${role.handle} uses ${models.modelLabel(found.model, found.provider)}`,
      );
    }
  }
  return reasons;
}

export async function contextForTopic(
  db: Db,
  topic: Topic,
  userId: string | null,
  requested: string[],
  byRoleId: string | null = null,
): Promise<RequestContext> {
  const ext = await externalContext(db, topic.id);
  return {
    userId,
    topicId: topic.id,
    connectionId: ext.connectionId ?? null,
    conversationId: ext.conversationId ?? null,
    conversationKind: ext.conversationKind ?? "internal",
    requestedRoleIds: requested,
    byRoleId,
  };
}

export async function authorize(
  db: Db,
  topic: Topic,
  userId: string | null,
  roleIds: string[],
  byRoleId: string | null = null,
): Promise<{ allowed: [Role, Record<string, any>][]; refusals: string[] }> {
  const decision = await resolve(db, await contextForTopic(db, topic, userId, roleIds, byRoleId));
  const allowed: [Role, Record<string, any>][] = [];
  const refusals: string[] = [];
  for (const cand of decision.candidates) {
    const role = await topicSvc.getRole(db, cand.role_id);
    const reasons = [...cand.reasons, ...(role ? await preflight(db, topic, role) : [])];
    if (role && !reasons.length)
      allowed.push([role, { summary: `@${role.handle} on ${cand.instance_id}`, trace: decision.trace }]);
    else refusals.push(...reasons);
  }
  if (!decision.candidates.length && decision.reason) refusals.push(decision.reason);
  return { allowed, refusals };
}

/** The role's model context in this topic. Topics never share sessions, so contexts never mix. */
export async function sessionFor(db: Db, roleId: string, topicId: string) {
  const [existing] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.roleId, roleId), eq(agentSessions.topicId, topicId)))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(agentSessions)
    .values({ id: newId("ses"), roleId, topicId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.roleId, roleId), eq(agentSessions.topicId, topicId)))
    .limit(1);
  return again;
}

export interface CreateTaskOptions {
  topic: Topic;
  role: Role;
  /** "conversation": a run of the role's main conversation in the topic (``session``); default an independent task. */
  kind?: "conversation" | "task";
  session?: AgentSession | null;
  /** An independent task reports its outcome to this conversation when it ends. */
  reportSessionId?: string | null;
  /** Its final answer only goes back to that conversation (start_task), instead of also into the topic. */
  reportOnly?: boolean;
  requesterUserId: string | null;
  instruction: string;
  title?: string | null;
  sourceMessage?: Message | null;
  parent?: Task | null;
  requesterRoleId?: string | null;
  assignment?: Record<string, any>;
  round?: number;
  idempotencyKey?: string | null;
  waitsForResult?: boolean;
  /** Nobody @-mentioned the role: it reached it automatically and may decline (stay_silent). */
  auto?: boolean;
}

/** The role's limits for one task; a delegate cannot spend more than what the delegator had left. */
export function taskBudget(role: Role, parent: Task | null): Record<string, any> {
  const s = settings();
  const budget: Record<string, any> = {
    max_steps: Math.min(role.maxSteps ?? s.maxTaskSteps, s.maxTaskSteps),
    max_tokens: role.maxTokensPerTask,
  };
  if (parent?.budget?.max_tokens) {
    const left = parent.budget.max_tokens - (parent.usage?.tokens ?? 0);
    budget.max_tokens = Math.max(0, Math.min(budget.max_tokens ?? left, left));
  }
  return budget;
}

export async function createTask(db: Db, o: CreateTaskOptions): Promise<Task> {
  if (o.idempotencyKey) {
    const [existing] = await db.select().from(tasks).where(eq(tasks.idempotencyKey, o.idempotencyKey)).limit(1);
    if (existing) return existing;
  }
  const { role, topic, parent = null } = o;
  const conversation = o.kind === "conversation";
  if (conversation && !o.session) throw new Error("a conversation run needs its session");
  const budget = taskBudget(role, parent);
  const firstLine = plainTitle(o.instruction) || "task";
  const [task] = await db
    .insert(tasks)
    .values({
      id: newId("task"),
      topicId: topic.id,
      kind: conversation ? "conversation" : "task",
      // Independent tasks have their own context and belong to no session.
      sessionId: conversation ? o.session!.id : null,
      reportSessionId: o.reportSessionId ?? null,
      title: (o.title || firstLine).slice(0, 200),
      instruction: o.instruction,
      requesterUserId: o.requesterUserId,
      requesterRoleId: o.requesterRoleId ?? null,
      sourceMessageId: o.sourceMessage?.id ?? parent?.sourceMessageId ?? null,
      ownerRoleId: role.id,
      instanceId: role.instanceId,
      parentTaskId: parent && o.waitsForResult ? parent.id : null,
      spawnedByTaskId: parent?.id ?? null,
      depth: parent ? parent.depth + 1 : 0,
      round: o.round ?? 0,
      envelope: envelopeWithRelay(
        {
          // The conversation's own permissions: a message from another role does not narrow them (its contacts
          // decide whom it may ask); delegated tasks are narrowed to the delegator's.
          ...buildEnvelope(role, conversation ? null : parent),
          ...(conversation ? { mode: "conversation" } : {}),
          ...(o.reportOnly ? { report_only: true } : {}),
          ...(o.auto ? { auto: true } : {}),
          // A conversation linked to Slack, Feishu or GitHub: console-only tools are not offered.
          ...((await externalContext(db, topic.id)).conversationKind ? { outside: true } : {}),
        },
        o.sourceMessage?.source === "topic" ? relayFrom(o.sourceMessage.externalRef) : null,
        ["webhook", "schedule"].includes(o.sourceMessage?.source ?? ""),
      ),
      roleSnapshot: await roleSnapshotFor(db, role),
      assignment: o.assignment ?? {},
      budget,
      usage: { steps: 0, tokens: 0 },
      idempotencyKey: o.idempotencyKey ?? null,
    })
    .returning();
  let current = task;
  const [inst] = role.instanceId
    ? await db.select().from(computerInstances).where(eq(computerInstances.id, role.instanceId)).limit(1)
    : [];
  if (inst && inst.status !== "running") {
    current = await setStatus(db, task, "waiting_resource", `computer ${inst.name} is ${inst.status}`, {
      wait: { type: "instance", instance_id: inst.id, since: new Date().toISOString() },
    });
  }
  await audit(db, "task.create", {
    actorType: o.requesterUserId ? "user" : "role",
    actorId: o.requesterUserId ?? o.requesterRoleId ?? null,
    resourceType: "task",
    resourceId: task.id,
    topicId: topic.id,
    taskId: task.id,
    roleId: role.id,
    instanceId: role.instanceId,
    detail: { parent: parent?.id ?? null, source_message: task.sourceMessageId, assignment: o.assignment?.summary },
  });
  const meta = { id: task.id, topic_id: topic.id, owner_role_id: role.id, status: current.status };
  await publish(db, "task.created", { ...meta, title: current.title }, `topic:${topic.id}`);
  await publish(db, "task.created", meta, "admin");
  await wake(db, "tasks");
  return current;
}

// --- dispatch --------------------------------------------------------------------------------------------

/**
 * A human reply answers tasks that asked this person (or anyone) a question here. Where it threads does not
 * decide which question it answers: every task it may answer gets it, and the model judges from its content
 * whether it is the answer (several tasks waiting in one topic are told so).
 */
async function resumeWaiting(
  db: Db,
  topic: Topic,
  msg: Message,
  user: User,
  mentioned: Set<string>,
): Promise<Set<string>> {
  const resumed = new Set<string>();
  const waiting = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.topicId, topic.id), eq(tasks.status, "waiting_human")));
  const answering = waiting.filter((task) => {
    const asked: string[] = task.wait?.user_ids ?? [];
    if (asked.length && !asked.includes(user.id)) return false;
    return !mentioned.size || mentioned.has(task.ownerRoleId);
  });
  const shared =
    answering.length > 1
      ? "\n\n(Other questions are waiting for an answer in this topic too: this reply may answer one of them. " +
        "If it does not answer yours, ask again with ask_human.)"
      : "";
  for (const task of answering) {
    const wait = task.wait ?? {};
    await appendStep(db, task, "tool", {
      tool_call_id: wait.tool_call_id,
      name: "ask_human",
      content: `${user.name} replied: ${msg.content}${shared}`,
    });
    await setStatus(db, task, "pending", `answered by ${user.name}`, { wait: null });
    resumed.add(task.ownerRoleId);
  }
  return resumed;
}

/**
 * `@handle` of an existing role that is not in this (internal) topic: say so instead of staying silent. Not in
 * a DM, which is with one role only: there a role's name is just a name (e.g. asking the system administrator
 * to change that role).
 */
async function hintUnknownMentions(db: Db, topic: Topic, msg: Message, user: User): Promise<void> {
  if (topic.source !== "internal" || topic.kind === "dm") return;
  const present = await topicSvc.roleHandles(db, topic.id);
  const missing = new Set<string>();
  for (const m of msg.content.matchAll(MENTION)) {
    const handle = m[1].toLowerCase().replace(/\.+$/, "");
    if (present.has(handle)) continue;
    const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.handle, handle)).limit(1);
    if (r) missing.add(`@${handle}`);
  }
  if (missing.size) {
    await systemMessage(db, topic, `${[...missing].join(", ")} is not in this topic; invite the role first.`, {
      mentions: [{ type: "user", id: user.id }],
    });
  }
}

export async function dispatchHumanMessage(
  db: Db,
  topic: Topic,
  msg: Message,
  user: User,
  opts: { idempotencyPrefix?: string; onRefused?: (reasons: string[]) => void } = {},
): Promise<Task[]> {
  const mentioned = msg.mentions.filter((m) => m.type === "role").map((m) => m.id);
  await hintUnknownMentions(db, topic, msg, user);
  const resumed = await resumeWaiting(db, topic, msg, user, new Set(mentioned));
  // Roles whose conversation asked this person something: the reply is for them, @-mention or not.
  const asked = (await rolesAwaiting(db, topic, user.id)).filter((r) => !resumed.has(r));
  const external = (await contextForTopic(db, topic, user.id, [])).conversationKind !== "internal";
  let explicit = true;
  let auto = false;
  let candidates: string[];
  if (mentioned.length) {
    candidates = mentioned.filter((r) => !resumed.has(r));
    if (!candidates.length) return [];
  } else if (resumed.size) {
    return [];
  } else if (asked.length) {
    candidates = asked;
  } else if (topic.kind === "dm") {
    candidates = (await topicSvc.participants(db, topic.id, "role")).map((p) => p.participantId);
  } else if (external) {
    // Outside the console only the role the connection's bot stands for works (empty candidate list).
    candidates = [];
  } else {
    // Nobody was @-mentioned. "mention" topics stay quiet. In "auto" topics a single role sees the message and
    // decides itself whether to answer; with several roles the dispatcher chooses, in the worker (it calls a
    // model, which never happens inside this transaction).
    explicit = false;
    if (topic.responseMode !== "auto") return [];
    candidates = await activeRoleIds(db, topic);
    if (!candidates.length) return [];
    if (candidates.length > 1) {
      await queueRoute(db, topic, msg, user);
      return [];
    }
    auto = true;
  }
  const { allowed, refusals } = await authorize(db, topic, user.id, candidates);
  const created: Task[] = [];
  for (const [role, assignment] of allowed) {
    if (external) await topicSvc.addParticipant(db, topic, "role", role.id);
    // Into the role's conversation here: a new run, or the open one (it sees the message at its next step).
    // A redelivered event is the same inbox item, never a second request.
    const run = await enqueue(db, {
      topic,
      role,
      item: { kind: "message", message_id: msg.id, ...(auto ? { auto: true } : {}) },
      requesterUserId: user.id,
      sourceMessage: msg,
      assignment,
      round: msg.round,
    });
    if (run) created.push(run);
  }
  if (refusals.length && explicit) {
    await audit(db, "task.denied", {
      actorType: "user",
      actorId: user.id,
      topicId: topic.id,
      detail: { reasons: refusals, message_id: msg.id },
    });
    await systemMessage(db, topic, `Request not assigned: ${[...new Set(refusals)].join("; ")}`, {
      mentions: [{ type: "user", id: user.id }],
      // in the Slack thread the request came from, if it came from one
      replyToId: msg.replyToId,
    });
    opts.onRefused?.([...new Set(refusals)]);
  }
  return created;
}

/** Roles taking part in a topic that can work (not disabled). */
export async function activeRoleIds(db: Db, topic: Topic): Promise<string[]> {
  const out: string[] = [];
  for (const p of await topicSvc.participants(db, topic.id, "role")) {
    const r = await topicSvc.getRole(db, p.participantId);
    if (r?.status === "active") out.push(r.id);
  }
  return out;
}

/** Hand an un-mentioned message to the dispatcher (agent/router.ts); the worker picks it up after commit. */
async function queueRoute(db: Db, topic: Topic, msg: Message, user: User): Promise<void> {
  await db
    .insert(messageRoutes)
    .values({ messageId: msg.id, topicId: topic.id, userId: user.id })
    .onConflictDoNothing();
  await wake(db, "tasks");
}

/**
 * A role @-mentioning other roles of the topic asks them to respond (in their conversations here); no permission
 * is needed, only the round limit applies.
 */
export async function dispatchRoleMessage(
  db: Db,
  topic: Topic,
  msg: Message,
  sender: Role,
  task: Task,
): Promise<Task[]> {
  const targets = msg.mentions.filter((m) => m.type === "role" && m.id !== sender.id).map((m) => m.id);
  if (!targets.length) return [];
  // Outside the console only the bot's role works: its @-mentions of other roles are just text.
  if ((await externalRoleId(db, topic.id)) !== undefined) return [];
  const s = settings();
  const limit = Math.min(topic.maxAutoRounds ?? s.maxAutoRounds, s.maxAutoRounds);
  if (msg.round > limit) {
    await systemMessage(
      db,
      topic,
      `Automatic discussion stopped after ${limit} rounds between roles; a person needs to step in.`,
      {
        taskId: task.id,
      },
    );
    await audit(db, "collab.round_limit", {
      actorType: "role",
      actorId: sender.id,
      topicId: topic.id,
      taskId: task.id,
    });
    return [];
  }
  const out: Task[] = [];
  for (const rid of targets) {
    const target = await topicSvc.getRole(db, rid);
    if (!target) continue;
    // Roles of the same topic @ each other freely; contacts bound delegation and messages to other topics.
    const { allowed, refusals } = await authorize(db, topic, task.requesterUserId, [rid], sender.id);
    if (!allowed.length) {
      await systemMessage(db, topic, `Not forwarded: ${refusals.join("; ")}`, { taskId: task.id });
      continue;
    }
    const [role, assignment] = allowed[0];
    const run = await enqueue(db, {
      topic,
      role,
      item: { kind: "message", message_id: msg.id },
      requesterUserId: task.requesterUserId,
      requesterRoleId: sender.id,
      sourceMessage: msg,
      assignment,
      round: msg.round,
    });
    if (run) out.push(run);
  }
  return out;
}

/**
 * Explicit hand-off: only the brief and listed materials travel, never the whole context. A task waits for
 * the result; a conversation goes on and gets the result as a new item when the delegate is done.
 */
export async function delegate(
  db: Db,
  parent: Task,
  sender: Role,
  targetHandle: string,
  instruction: string,
  expectedOutput: string,
  materials: string,
): Promise<Task> {
  const fromConversation = parent.kind === "conversation";
  if (fromConversation) await checkAutoRounds(parent);
  const [target] = await db
    .select()
    .from(roles)
    .where(eq(roles.handle, targetHandle.replace(/^@/, "")))
    .limit(1);
  if (!target) throw new Forbidden(`no role @${targetHandle}`);
  const contacts: string[] = parent.envelope.contacts ?? [];
  if (!contacts.includes("*") && !contacts.includes(target.id))
    throw new Forbidden(`you are not allowed to delegate to @${target.handle}`);
  if (parent.depth + 1 > settings().maxDelegationDepth) throw new Forbidden("delegation depth limit reached");
  const topic = await topicSvc.getTopic(db, parent.topicId);
  if (!(await topicSvc.participant(db, topic.id, "role", target.id)))
    await topicSvc.inviteRole(db, null, topic, target.id, { byRole: sender });
  const { allowed, refusals } = await authorize(db, topic, parent.requesterUserId, [target.id], sender.id);
  if (!allowed.length) throw new Forbidden(`delegation refused: ${refusals.join("; ")}`);
  let brief = `Delegated by @${sender.handle}.\n\nTask:\n${instruction}`;
  if (expectedOutput) brief += `\n\nExpected output:\n${expectedOutput}`;
  if (materials) brief += `\n\nMaterials provided:\n${materials}`;
  return createTask(db, {
    topic,
    role: target,
    requesterUserId: parent.requesterUserId,
    requesterRoleId: sender.id,
    instruction: brief,
    title: plainTitle(instruction).slice(0, 120) || "task",
    parent,
    assignment: allowed[0][1],
    round: parent.round + 1,
    waitsForResult: !fromConversation,
    reportSessionId: fromConversation ? parent.sessionId : null,
  });
}

/**
 * Work a conversation hands out comes back to it and may lead to more: like roles answering each other, the
 * chain is bounded by the automatic rounds limit until a person speaks (their message starts again at 0).
 */
export async function checkAutoRounds(run: Task): Promise<void> {
  const limit = settings().maxAutoRounds;
  if (run.round + 1 > limit)
    throw new Forbidden(`${limit} rounds of automatic work without a person; ask a person before starting more`);
}

/**
 * start_task: the conversation hands a separable piece of its own work to an independent task of the same
 * role, with its own context. The result comes back to the conversation; nothing is posted for it.
 */
export async function startOwnTask(
  db: Db,
  run: Task,
  role: Role,
  brief: string,
  expectedOutput: string,
  materials: string,
  sourceMessageId?: string,
): Promise<Task> {
  if (run.depth + 1 > settings().maxDelegationDepth) throw new Forbidden("task depth limit reached");
  await checkAutoRounds(run);
  const topic = await topicSvc.getTopic(db, run.topicId);
  const sourceId = sourceMessageId ?? run.sourceMessageId;
  const [sourceMessage] = sourceId
    ? await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, sourceId), eq(messages.topicId, topic.id)))
        .limit(1)
    : [];
  if (sourceMessageId && (!sourceMessage || sourceMessage.deletedAt))
    throw new Forbidden("source message must be in this topic");
  let instruction = `Started by your conversation in this topic as a separate task.\n\nTask:\n${brief}`;
  if (expectedOutput) instruction += `\n\nExpected output:\n${expectedOutput}`;
  if (materials) instruction += `\n\nMaterials provided:\n${materials}`;
  return createTask(db, {
    topic,
    role,
    // The message picked only says what the task is about; who asked stays this run's requester, so the model
    // cannot attribute work to someone else.
    requesterUserId: run.requesterUserId,
    requesterRoleId: role.id,
    instruction,
    title: plainTitle(brief).slice(0, 120) || "task",
    sourceMessage: sourceMessage ?? null,
    parent: run,
    assignment: { summary: `@${role.handle}: separate task of its conversation`, trace: [] },
    round: run.round + 1,
    reportSessionId: run.sessionId,
    reportOnly: true,
  });
}

export { users as usersTable };

/** First meaningful line of a (Markdown) message as a plain task title: no heading, quote, list or emphasis marks. */
export function plainTitle(text: string): string {
  const line =
    text
      .trim()
      .split("\n")
      .find((l) => l.trim() && !/^\s*(```|~~~)/.test(l)) ?? "";
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .trim();
}

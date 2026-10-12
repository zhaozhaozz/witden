/** Turning messages into work: who should respond, is it allowed, and what may the work touch. */
import { and, desc, eq } from "drizzle-orm";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  agentSessions,
  computerInstances,
  type Mention,
  type Message,
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
import { externalContext } from "../integrations/links.js";
import { mirrorMessage } from "../integrations/outbound.js";
import { topicLabel } from "../security/labels.js";
import { type RequestContext, resolve } from "../services/assignment.js";
import { audit } from "../services/audit.js";
import { publish, wake } from "../services/events.js";
import * as models from "../services/model-configs.js";
import * as topicSvc from "../services/topics.js";
import { setStatus, textRestricted } from "./control.js";
import { appendStep } from "./transcript.js";

export const MENTION = /(?<![\w@/])@([A-Za-z0-9][A-Za-z0-9_.-]{0,63})/g;

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
    attachments: msg.attachments,
    source: msg.source,
    round: msg.round,
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
  opts: { taskId?: string | null; mentions?: Mention[] } = {},
) {
  return saveMessage(db, topic, "system", null, content, {
    mentions: opts.mentions ?? [],
    taskId: opts.taskId ?? null,
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
): Promise<RequestContext> {
  const ext = await externalContext(db, topic.id);
  return {
    userId,
    topicId: topic.id,
    connectionId: ext.connectionId ?? null,
    conversationId: ext.conversationId ?? null,
    conversationKind: ext.conversationKind ?? "internal",
    requestedRoleIds: requested,
  };
}

export async function authorize(
  db: Db,
  topic: Topic,
  userId: string | null,
  roleIds: string[],
): Promise<{ allowed: [Role, Record<string, any>][]; refusals: string[] }> {
  const decision = await resolve(db, await contextForTopic(db, topic, userId, roleIds));
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
}

export async function createTask(db: Db, o: CreateTaskOptions): Promise<Task> {
  const s = settings();
  if (o.idempotencyKey) {
    const [existing] = await db.select().from(tasks).where(eq(tasks.idempotencyKey, o.idempotencyKey)).limit(1);
    if (existing) return existing;
  }
  const { role, topic, parent = null } = o;
  const found = await models.modelWithProvider(db, role.modelConfigId);
  let labels = [topicLabel(topic.id)];
  if (parent) labels = [...new Set([...parent.labels, ...labels])];
  const budget: Record<string, any> = {
    max_steps: Math.min(role.maxSteps ?? s.maxTaskSteps, s.maxTaskSteps),
    max_tokens: role.maxTokensPerTask,
  };
  if (parent?.budget?.max_tokens) {
    // A delegate cannot spend more than what the delegator had left.
    const left = parent.budget.max_tokens - (parent.usage?.tokens ?? 0);
    budget.max_tokens = Math.max(0, Math.min(budget.max_tokens ?? left, left));
  }
  const session = await sessionFor(db, role.id, topic.id);
  const firstLine = o.instruction.trim().split("\n")[0] || "task";
  const [task] = await db
    .insert(tasks)
    .values({
      id: newId("task"),
      topicId: topic.id,
      sessionId: session.id,
      title: (o.title || firstLine).slice(0, 200),
      instruction: o.instruction,
      requesterUserId: o.requesterUserId,
      requesterRoleId: o.requesterRoleId ?? null,
      sourceMessageId: o.sourceMessage?.id ?? null,
      ownerRoleId: role.id,
      instanceId: role.instanceId,
      parentTaskId: parent && o.waitsForResult ? parent.id : null,
      spawnedByTaskId: parent?.id ?? null,
      depth: parent ? parent.depth + 1 : 0,
      round: o.round ?? 0,
      envelope: buildEnvelope(role, parent),
      labels,
      roleSnapshot: {
        config_version: role.configVersion,
        model_config_id: role.modelConfigId,
        model_name: found ? models.modelLabel(found.model, found.provider) : null,
        system_prompt: role.systemPrompt,
        model_params: role.modelParams,
        instance_id: role.instanceId,
      },
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
  const title = (await textRestricted(db, current)) ? "[restricted]" : current.title;
  await publish(db, "task.created", { ...meta, title }, `topic:${topic.id}`);
  await publish(db, "task.created", meta, "admin");
  await wake(db, "tasks");
  return current;
}

// --- dispatch --------------------------------------------------------------------------------------------

/** A human reply answers tasks that asked this person (or anyone) a question here. */
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
  for (const task of waiting) {
    const wait = task.wait ?? {};
    const asked: string[] = wait.user_ids ?? [];
    if (asked.length && !asked.includes(user.id)) continue;
    if (mentioned.size && !mentioned.has(task.ownerRoleId)) continue;
    await appendStep(db, task, "tool", {
      tool_call_id: wait.tool_call_id,
      name: "ask_human",
      content: `${user.name} replied: ${msg.content}`,
    });
    await setStatus(db, task, "pending", `answered by ${user.name}`, { wait: null });
    resumed.add(task.ownerRoleId);
  }
  return resumed;
}

export async function lastActiveRole(db: Db, topic: Topic): Promise<string | null> {
  const [last] = await db
    .select({ authorId: messages.authorId })
    .from(messages)
    .where(and(eq(messages.topicId, topic.id), eq(messages.authorType, "role")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (last?.authorId && (await topicSvc.participant(db, topic.id, "role", last.authorId))) return last.authorId;
  // Nobody has answered yet: the role whose task is newest here. Never an arbitrary participant; with no
  // work in the thread the assignment rules choose.
  const [recent] = await db
    .select({ roleId: tasks.ownerRoleId })
    .from(tasks)
    .where(eq(tasks.topicId, topic.id))
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  if (recent && (await topicSvc.participant(db, topic.id, "role", recent.roleId))) return recent.roleId;
  return null;
}

/** `@handle` of an existing role that is not in this (internal) topic: say so instead of staying silent. */
async function hintUnknownMentions(db: Db, topic: Topic, msg: Message, user: User): Promise<void> {
  if (topic.source !== "internal") return;
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
  opts: { idempotencyPrefix?: string } = {},
): Promise<Task[]> {
  const mentioned = msg.mentions.filter((m) => m.type === "role").map((m) => m.id);
  await hintUnknownMentions(db, topic, msg, user);
  const resumed = await resumeWaiting(db, topic, msg, user, new Set(mentioned));
  const external = (await contextForTopic(db, topic, user.id, [])).conversationKind !== "internal";
  let explicit = true;
  let candidates: string[];
  if (mentioned.length) {
    candidates = mentioned.filter((r) => !resumed.has(r));
    if (!candidates.length) return [];
  } else if (resumed.size) {
    return [];
  } else if (topic.kind === "dm") {
    candidates = (await topicSvc.participants(db, topic.id, "role")).map((p) => p.participantId);
  } else if (external) {
    // Follow-ups in an external thread go to the role already working there; the first request gets the
    // default role from the assignment rules (empty candidate list).
    const last = await lastActiveRole(db, topic);
    candidates = last ? [last] : [];
  } else {
    // Only roles configured to take part actively react without being mentioned.
    explicit = false;
    candidates = [];
    for (const p of await topicSvc.participants(db, topic.id, "role")) {
      const r = await topicSvc.getRole(db, p.participantId);
      if (r?.responseMode === "active") candidates.push(r.id);
    }
    if (!candidates.length) return [];
  }
  const { allowed, refusals } = await authorize(db, topic, user.id, candidates);
  const created: Task[] = [];
  for (const [role, assignment] of allowed) {
    if (external) await topicSvc.addParticipant(db, topic, "role", role.id);
    created.push(
      await createTask(db, {
        topic,
        role,
        requesterUserId: user.id,
        instruction: msg.content,
        sourceMessage: msg,
        assignment,
        idempotencyKey: opts.idempotencyPrefix ? `${opts.idempotencyPrefix}:${role.id}` : null,
      }),
    );
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
    });
  }
  return created;
}

/** A role @-mentioning other roles asks them to respond, bounded by contacts and round limits. */
export async function dispatchRoleMessage(
  db: Db,
  topic: Topic,
  msg: Message,
  sender: Role,
  task: Task,
): Promise<Task[]> {
  const targets = msg.mentions.filter((m) => m.type === "role" && m.id !== sender.id).map((m) => m.id);
  if (!targets.length) return [];
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
    const contacts: string[] = task.envelope.contacts ?? [];
    if (!contacts.includes("*") && !contacts.includes(rid)) {
      await systemMessage(db, topic, `@${sender.handle} is not allowed to contact @${target.handle}.`, {
        taskId: task.id,
      });
      continue;
    }
    const { allowed, refusals } = await authorize(db, topic, task.requesterUserId, [rid]);
    if (!allowed.length) {
      await systemMessage(db, topic, `Not forwarded: ${refusals.join("; ")}`, { taskId: task.id });
      continue;
    }
    const [role, assignment] = allowed[0];
    out.push(
      await createTask(db, {
        topic,
        role,
        requesterUserId: task.requesterUserId,
        requesterRoleId: sender.id,
        instruction: msg.content,
        sourceMessage: msg,
        parent: task,
        assignment,
        round: msg.round,
      }),
    );
  }
  return out;
}

/** Explicit hand-off: only the brief and listed materials travel, never the whole context. */
export async function delegate(
  db: Db,
  parent: Task,
  sender: Role,
  targetHandle: string,
  instruction: string,
  expectedOutput: string,
  materials: string,
): Promise<Task> {
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
  const { allowed, refusals } = await authorize(db, topic, parent.requesterUserId, [target.id]);
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
    title: instruction.slice(0, 120),
    parent,
    assignment: allowed[0][1],
    round: parent.round + 1,
    waitsForResult: true,
  });
}

export { users as usersTable };

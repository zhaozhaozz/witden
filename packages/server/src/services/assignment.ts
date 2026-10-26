/**
 * Who handles a request, on which computer, and why it may or may not.
 *
 * 1. Outside the console a conversation has one role at work, the only one there: by default the role its
 *    connection's bot stands for (its ``role_id`` setting), or the one a person chose for the topic
 *    (integrations/links.ts externalHandler). Requests go to it, and no other role is brought in. Without one
 *    the conversation takes no requests.
 * 2. In the console the roles asked for: named, picked by the dispatcher, or the target of a role's @-mention or
 *    delegation (always a role of the same topic).
 * 3. Each role is then checked: it exists and is enabled, in a console topic it takes part, the person may use
 *    it (external members only their connection's role, or the one handling their conversation; when a role asks
 *    another role of the topic, the person's
 *    permission is not checked: working with the topic's roles needs none), and it has a computer. A system
 *    administrator role works only in the console, only for people (never for another role) and needs no
 *    computer: its tools act on witden itself.
 *
 * The steps are recorded in a trace, kept with the task, so every assignment can be explained.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { computerInstances, roles, users } from "../db/schema.js";
import { hasPermission, isConsoleUser, mayUseRoleIn, Perm } from "../security/permissions.js";
import { participant } from "./topics.js";

export interface RequestContext {
  userId: string | null;
  topicId?: string | null;
  connectionId?: string | null;
  conversationId?: string | null;
  /** public | private | im | mpim | internal */
  conversationKind: string;
  /** Outside the console: the role at work in the conversation (integrations/links.ts externalHandler), or null. */
  handlerRoleId?: string | null;
  /** It was chosen for the conversation, rather than the connection's own. */
  handlerChosen?: boolean;
  requestedRoleIds: string[];
  /** A role asking another role of the topic: an @-mention or a delegation. */
  byRoleId?: string | null;
}

export interface RoleDecision {
  role_id: string;
  allowed: boolean;
  instance_id: string | null;
  reasons: string[];
}

export interface Decision {
  allowed: boolean;
  candidates: RoleDecision[];
  trace: { step: string; detail: unknown }[];
  reason: string | null;
}

function ctxJson(ctx: RequestContext) {
  return {
    user_id: ctx.userId,
    topic_id: ctx.topicId ?? null,
    connection_id: ctx.connectionId ?? null,
    conversation_id: ctx.conversationId ?? null,
    conversation_kind: ctx.conversationKind,
    by_role_id: ctx.byRoleId ?? null,
  };
}

export async function resolve(db: Db, ctx: RequestContext): Promise<Decision> {
  const trace: Decision["trace"] = [{ step: "request", detail: ctxJson(ctx) }];
  const deny = (reason: string): Decision => {
    trace.push({ step: "result", detail: reason });
    return { allowed: false, candidates: [], trace, reason };
  };
  const [user] = ctx.userId ? await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1) : [];
  if (!user?.isActive) return deny("requester is not a recognised active member");

  const bound = ctx.conversationKind === "internal" ? null : (ctx.handlerRoleId ?? null);
  if (ctx.conversationKind !== "internal" && !bound)
    return deny("this connection's bot has no role yet: an administrator must choose the role it stands for");
  let candidateIds = [...new Set(ctx.requestedRoleIds)];
  if (candidateIds.length) {
    trace.push({ step: "candidates", detail: `asked for: ${candidateIds.join(", ")}` });
  } else if (bound) {
    candidateIds = [bound];
    trace.push({
      step: "candidates",
      detail: ctx.handlerChosen
        ? "the role chosen to handle this conversation"
        : "the role the connection's bot stands for",
    });
  } else {
    return deny("no role was mentioned");
  }

  const candidates: RoleDecision[] = [];
  for (const roleId of candidateIds) candidates.push(await checkRole(db, user, ctx, roleId, bound));
  trace.push({ step: "roles", detail: candidates });
  const ok = candidates.some((c) => c.allowed);
  const reason = ok ? null : candidates.flatMap((c) => c.reasons).join("; ");
  trace.push({ step: "result", detail: ok ? "allowed" : reason });
  return { allowed: ok, candidates, trace, reason };
}

async function checkRole(
  db: Db,
  user: typeof users.$inferSelect,
  ctx: RequestContext,
  roleId: string,
  bound: string | null,
): Promise<RoleDecision> {
  const d: RoleDecision = { role_id: roleId, allowed: false, instance_id: null, reasons: [] };
  const [role] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) {
    d.reasons.push(`role ${roleId} does not exist`);
    return d;
  }
  const label = `@${role.handle}`;
  if (role.status !== "active") d.reasons.push(`${label} is disabled`);
  // Console topics: only roles someone invited. Outside: only the role handling the conversation (it joins on its
  // own).
  if (ctx.conversationKind === "internal" && ctx.topicId && !(await participant(db, ctx.topicId, "role", roleId))) {
    d.reasons.push(`${label} is not a participant of this topic`);
  }
  if (ctx.conversationKind !== "internal" && roleId !== bound)
    d.reasons.push(
      `${label} does not work here: in a Slack, Feishu or GitHub conversation only the role handling it does`,
    );
  const usable = ctx.topicId
    ? await mayUseRoleIn(db, user, roleId, ctx.topicId)
    : await hasPermission(db, user, Perm.ROLE_USE, roleId);
  if (!ctx.byRoleId && !usable) d.reasons.push(`you do not have permission to use ${label}`);
  if (role.systemAdmin) {
    if (ctx.conversationKind !== "internal")
      d.reasons.push(`${label} is a system administrator: it works only in the witden console`);
    if (ctx.byRoleId) d.reasons.push(`${label} is a system administrator: it takes requests only from people`);
    if (!isConsoleUser(user)) d.reasons.push(`${label} is a system administrator: only console accounts may ask it`);
  }
  if (!role.instanceId) {
    if (!role.systemAdmin) d.reasons.push(`${label} has no computer assigned`);
  } else {
    const [inst] = await db.select().from(computerInstances).where(eq(computerInstances.id, role.instanceId)).limit(1);
    if (!inst || inst.status === "deleted") d.reasons.push(`${label}'s computer no longer exists`);
    d.instance_id = role.instanceId;
  }
  d.allowed = d.reasons.length === 0;
  return d;
}

/**
 * Who handles a request, on which computer, and why it may or may not.
 *
 * 1. Outside the console a connection's bot stands for one role (its ``role_id`` setting), the only role that
 *    works there: requests go to it, and no other role is brought in. A connection without a role takes no
 *    requests.
 * 2. In the console the roles asked for: named, picked by the dispatcher, or the target of a role's @-mention or
 *    hand-over.
 * 3. Each role is then checked: it exists and is enabled, in a console topic it takes part, the person may use
 *    it (external members only their connection's role; when a role asks another role, the person's permission
 *    is not checked: an @-mention in the topic needs none, a hand-over is bounded by its contacts), and it has a
 *    computer. A system administrator role works only in the console, only for people
 *    (never for another role) and needs no computer: its tools act on witden itself.
 *
 * The steps are recorded in a trace, kept with the task, so every assignment can be explained.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { computerInstances, connections, roles, users } from "../db/schema.js";
import { hasPermission, isConsoleUser, Perm } from "../security/permissions.js";
import { participant } from "./topics.js";

export interface RequestContext {
  userId: string | null;
  topicId?: string | null;
  connectionId?: string | null;
  conversationId?: string | null;
  /** public | private | im | mpim | internal */
  conversationKind: string;
  requestedRoleIds: string[];
  /** A role asking another role: an @-mention within the topic, or a hand-over limited by its contacts. */
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

/** The role a connection's bot stands for, if it has one. */
export async function connectionRole(db: Db, connectionId: string | null | undefined): Promise<string | null> {
  if (!connectionId) return null;
  const [conn] = await db.select().from(connections).where(eq(connections.id, connectionId)).limit(1);
  const roleId = conn?.settings?.role_id;
  return typeof roleId === "string" && roleId ? roleId : null;
}

export async function resolve(db: Db, ctx: RequestContext): Promise<Decision> {
  const trace: Decision["trace"] = [{ step: "request", detail: ctxJson(ctx) }];
  const deny = (reason: string): Decision => {
    trace.push({ step: "result", detail: reason });
    return { allowed: false, candidates: [], trace, reason };
  };
  const [user] = ctx.userId ? await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1) : [];
  if (!user?.isActive) return deny("requester is not a recognised active member");

  const bound = ctx.conversationKind === "internal" ? null : await connectionRole(db, ctx.connectionId);
  if (ctx.conversationKind !== "internal" && !bound)
    return deny("this connection's bot has no role yet: an administrator must choose the role it stands for");
  let candidateIds = [...new Set(ctx.requestedRoleIds)];
  if (candidateIds.length) {
    trace.push({ step: "candidates", detail: `asked for: ${candidateIds.join(", ")}` });
  } else if (bound) {
    candidateIds = [bound];
    trace.push({ step: "candidates", detail: "the role the connection's bot stands for" });
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
  // Console topics: only roles someone invited. Outside: only the role the bot stands for (it joins on its own).
  if (ctx.conversationKind === "internal" && ctx.topicId && !(await participant(db, ctx.topicId, "role", roleId))) {
    d.reasons.push(`${label} is not a participant of this topic`);
  }
  if (ctx.conversationKind !== "internal" && roleId !== bound)
    d.reasons.push(`${label} does not work here: in a Slack, Feishu or GitHub conversation only the bot's role does`);
  if (!ctx.byRoleId && !(await hasPermission(db, user, Perm.ROLE_USE, roleId)))
    d.reasons.push(`you do not have permission to use ${label}`);
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

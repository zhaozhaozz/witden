/**
 * Who may handle a request, on which computer, and why.
 *
 * Resolution is deterministic and explainable:
 * 1. Every enabled rule whose ``match`` fits the request applies.
 * 2. Restrictions compose by intersection: allowed roles / instances are intersected across rules, denied
 *    roles are unioned, and any matching ``deny`` rule refuses the request. A more specific rule can never
 *    widen what a broader rule forbids.
 * 3. The default role (used when nobody is @-mentioned) comes from the most specific rule that sets one.
 *    Specificity: topic > conversation > user > conversation kind > connection > global; ties by priority
 *    (lower first) then rule id.
 * 4. External conversations without any matching rule are refused (new entry points get nothing by default).
 *    Internal topics fall back to their own participant list.
 * 5. Explicit @-mentions never bypass any of this; the requester also needs ``role.use``.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type AssignmentRule, assignmentRules, computerInstances, roles, users } from "../db/schema.js";
import { BadRequest } from "../errors.js";
import { hasPermission, Perm } from "../security/permissions.js";
import { participant } from "./topics.js";

const SPECIFICITY: [keyof RequestContext, number][] = [
  ["topicId", 32],
  ["conversationId", 16],
  ["userId", 8],
  ["conversationKind", 4],
  ["connectionId", 2],
];
/** JSON keys used in rule.match (snake_case, as stored and exposed by the API). */
const MATCH_KEYS: Record<string, keyof RequestContext> = {
  topic_id: "topicId",
  conversation_id: "conversationId",
  user_id: "userId",
  conversation_kind: "conversationKind",
  connection_id: "connectionId",
};

export interface RequestContext {
  userId: string | null;
  topicId?: string | null;
  connectionId?: string | null;
  conversationId?: string | null;
  /** public | private | im | mpim | internal */
  conversationKind: string;
  requestedRoleIds: string[];
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

export function specificity(rule: AssignmentRule): number {
  return SPECIFICITY.reduce((sum, [key, weight]) => {
    const jsonKey = Object.entries(MATCH_KEYS).find(([, v]) => v === key)?.[0];
    return jsonKey && rule.match[jsonKey] ? sum + weight : sum;
  }, 0);
}

export function validateMatch(match: Record<string, unknown>): Record<string, unknown> {
  const unknown = Object.keys(match).filter((k) => !(k in MATCH_KEYS));
  if (unknown.length) {
    throw new BadRequest(`unknown match keys: ${unknown.join(", ")}; allowed: ${Object.keys(MATCH_KEYS).join(", ")}`);
  }
  return Object.fromEntries(Object.entries(match).filter(([, v]) => v !== null && v !== ""));
}

function matches(rule: AssignmentRule, ctx: RequestContext): boolean {
  return Object.entries(rule.match).every(([k, v]) => {
    const key = MATCH_KEYS[k];
    return !key || v === null || v === "" || ctx[key] === v;
  });
}

function ctxJson(ctx: RequestContext) {
  return {
    user_id: ctx.userId,
    topic_id: ctx.topicId ?? null,
    connection_id: ctx.connectionId ?? null,
    conversation_id: ctx.conversationId ?? null,
    conversation_kind: ctx.conversationKind,
  };
}

const intersect = (current: Set<string> | null, next: string[] | null) =>
  next === null ? current : current === null ? new Set(next) : new Set([...current].filter((x) => next.includes(x)));

export async function resolve(db: Db, ctx: RequestContext): Promise<Decision> {
  const trace: Decision["trace"] = [{ step: "request", detail: ctxJson(ctx) }];
  const rules = (await db.select().from(assignmentRules).where(eq(assignmentRules.enabled, true)))
    .filter((r) => matches(r, ctx))
    .sort((a, b) => specificity(b) - specificity(a) || a.priority - b.priority || a.id.localeCompare(b.id));
  trace.push({
    step: "matched_rules",
    detail: rules.map((r) => ({ id: r.id, name: r.name, effect: r.effect, specificity: specificity(r) })),
  });
  const deny = (reason: string): Decision => {
    trace.push({ step: "result", detail: reason });
    return { allowed: false, candidates: [], trace, reason };
  };
  const [user] = ctx.userId ? await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1) : [];
  if (!user?.isActive) return deny("requester is not a recognised active member");
  const denyRule = rules.find((r) => r.effect === "deny");
  if (denyRule) return deny(`refused by rule '${denyRule.name}'`);

  let allowedRoles: Set<string> | null = null;
  let allowedInstances: Set<string> | null = null;
  const deniedRoles = new Set<string>();
  for (const r of rules) {
    allowedRoles = intersect(allowedRoles, r.allowRoleIds);
    allowedInstances = intersect(allowedInstances, r.allowInstanceIds);
    for (const id of r.denyRoleIds) deniedRoles.add(id);
  }
  if (!rules.length) {
    if (ctx.conversationKind !== "internal")
      return deny("no assignment rule covers this conversation; an administrator must add one");
    trace.push({ step: "fallback", detail: "internal topic without rules: topic participants decide" });
  }
  trace.push({
    step: "restrictions",
    detail: {
      allowed_roles: allowedRoles ? [...allowedRoles].sort() : "unrestricted",
      denied_roles: [...deniedRoles].sort(),
      allowed_instances: allowedInstances ? [...allowedInstances].sort() : "unrestricted",
    },
  });

  let candidateIds = [...new Set(ctx.requestedRoleIds)];
  if (candidateIds.length) {
    trace.push({ step: "candidates", detail: `explicitly requested: ${candidateIds.join(", ")}` });
  } else {
    const def = rules.find((r) => r.defaultRoleId);
    if (!def) return deny("no role was mentioned and no rule defines a default role");
    candidateIds = [def.defaultRoleId!];
    trace.push({ step: "candidates", detail: `default role from rule '${def.name}'` });
  }

  const candidates: RoleDecision[] = [];
  for (const roleId of candidateIds) {
    candidates.push(await checkRole(db, user, ctx, roleId, allowedRoles, deniedRoles, allowedInstances));
  }
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
  allowedRoles: Set<string> | null,
  deniedRoles: Set<string>,
  allowedInstances: Set<string> | null,
): Promise<RoleDecision> {
  const d: RoleDecision = { role_id: roleId, allowed: false, instance_id: null, reasons: [] };
  const [role] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) {
    d.reasons.push(`role ${roleId} does not exist`);
    return d;
  }
  const label = `@${role.handle}`;
  if (role.status !== "active") d.reasons.push(`${label} is disabled`);
  if (deniedRoles.has(roleId)) d.reasons.push(`${label} is denied here by an assignment rule`);
  if (allowedRoles && !allowedRoles.has(roleId)) d.reasons.push(`${label} is not among the roles allowed here`);
  // Internal topics: only roles someone invited. External threads: the rules decide and the dispatcher adds
  // the role to the linked topic.
  if (ctx.conversationKind === "internal" && ctx.topicId && !(await participant(db, ctx.topicId, "role", roleId))) {
    d.reasons.push(`${label} is not a participant of this topic`);
  }
  if (!(await hasPermission(db, user, Perm.ROLE_USE, roleId)))
    d.reasons.push(`you do not have permission to use ${label}`);
  if (!role.instanceId) {
    d.reasons.push(`${label} has no computer assigned`);
  } else {
    const [inst] = await db.select().from(computerInstances).where(eq(computerInstances.id, role.instanceId)).limit(1);
    if (!inst || inst.status === "deleted") d.reasons.push(`${label}'s computer no longer exists`);
    else if (allowedInstances && !allowedInstances.has(inst.id)) {
      d.reasons.push(`${label}'s computer ${inst.name} is not allowed for this request`);
    }
    d.instance_id = role.instanceId;
  }
  d.allowed = d.reasons.length === 0;
  return d;
}

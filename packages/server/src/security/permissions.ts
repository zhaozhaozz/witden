/**
 * Permission checks enforced by the system (never by prompts).
 *
 * Everything is denied unless a grant allows it. Administrators implicitly hold every management
 * permission, but private topics and DMs stay readable by their participants only (see services/topics).
 */
import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { connections, grants, type User, users } from "../db/schema.js";
import { Forbidden } from "../errors.js";

export const Perm = {
  TOPIC_CREATE: "topic.create",
  ROLE_USE: "role.use",
  ROLE_INVITE: "role.invite",
  ROLE_MANAGE: "role.manage",
  INSTANCE_OBSERVE: "instance.observe",
  INSTANCE_CONTROL: "instance.control",
  INSTANCE_MANAGE: "instance.manage",
  TEMPLATE_MANAGE: "template.manage",
  FILE_DOWNLOAD: "file.download",
  RULES_MANAGE: "rules.manage",
  SECRETS_MANAGE: "secrets.manage",
  MODEL_USE: "model.use",
  CONNECTION_MANAGE: "connection.manage",
  TOPIC_PUBLISH: "topic.publish",
  AUDIT_VIEW: "audit.view",
  USER_MANAGE: "user.manage",
  APPROVAL_DECIDE: "approval.decide",
  KNOWLEDGE_READ: "knowledge.read",
  KNOWLEDGE_WRITE: "knowledge.write",
  EMERGENCY_STOP: "emergency.stop",
} as const;
export type Perm = (typeof Perm)[keyof typeof Perm];
export const ALL_PERMS = Object.values(Perm) as Perm[];

/** Resource type a permission is scoped to ("*" = global permission). */
export const PERM_RESOURCE: Partial<Record<Perm, string>> = {
  "role.use": "role",
  "role.invite": "role",
  "instance.observe": "instance",
  "instance.control": "instance",
  "instance.manage": "instance",
  "file.download": "topic",
  "approval.decide": "role",
  "knowledge.read": "space",
  "knowledge.write": "space",
  "model.use": "model",
  "topic.publish": "connection",
};

export function isPerm(value: string): value is Perm {
  return (ALL_PERMS as string[]).includes(value);
}

export async function hasPermission(db: Db, user: User | null | undefined, perm: Perm, resourceId?: string | null) {
  if (!user?.isActive) return false;
  if (user.externalConnectionId) return externalMemberMay(db, user.externalConnectionId, perm, resourceId);
  if (user.isAdmin) return true;
  const rtype = PERM_RESOURCE[perm] ?? "*";
  const resources = resourceId ? ["*", resourceId] : ["*"];
  const rows = await db
    .select({ id: grants.id })
    .from(grants)
    .where(
      and(
        eq(grants.permission, perm),
        inArray(grants.resourceType, [rtype, "*"]),
        inArray(grants.resourceId, resources),
        or(and(eq(grants.subjectType, "user"), eq(grants.subjectId, user.id)), eq(grants.subjectType, "all")),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * External members may use (and bring into a thread) only the roles their connection lists in
 * ``settings.external_role_ids``; grants, including grants to everybody, do not apply to them.
 */
async function externalMemberMay(db: Db, connectionId: string, perm: Perm, roleId?: string | null): Promise<boolean> {
  if (!roleId || (perm !== Perm.ROLE_USE && perm !== Perm.ROLE_INVITE)) return false;
  const [conn] = await db.select().from(connections).where(eq(connections.id, connectionId)).limit(1);
  const allowed: unknown = conn?.settings?.external_role_ids;
  return Array.isArray(allowed) && allowed.includes(roleId);
}

export async function requirePerm(db: Db, user: User | null | undefined, perm: Perm, resourceId?: string | null) {
  if (!(await hasPermission(db, user, perm, resourceId))) {
    throw new Forbidden(`missing permission ${perm}${resourceId ? ` on ${resourceId}` : ""}`);
  }
}

/** Active users holding ``perm`` (explicitly or as admin). */
export async function usersWithPermission(db: Db, perm: Perm, resourceId?: string | null): Promise<Set<string>> {
  const active = await db.select().from(users).where(eq(users.isActive, true));
  const out = new Set<string>();
  for (const u of active) if (await hasPermission(db, u, perm, resourceId)) out.add(u.id);
  return out;
}

export async function grant(
  db: Db,
  perm: Perm,
  opts: { userId?: string | null; resourceId?: string; createdBy?: string | null } = {},
) {
  const subjectType = opts.userId ? "user" : "all";
  const subjectId = opts.userId ?? "*";
  const resourceId = opts.resourceId ?? "*";
  const existing = await db
    .select()
    .from(grants)
    .where(
      and(
        eq(grants.subjectType, subjectType),
        eq(grants.subjectId, subjectId),
        eq(grants.permission, perm),
        eq(grants.resourceId, resourceId),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];
  const [row] = await db
    .insert(grants)
    .values({
      id: newId("grant"),
      subjectType,
      subjectId,
      permission: perm,
      resourceType: PERM_RESOURCE[perm] ?? "*",
      resourceId,
      createdBy: opts.createdBy ?? null,
    })
    .returning();
  return row;
}

/**
 * Who may do what.
 *
 * Everyone who signs in to the console is an administrator: the console is where the roles and computers are
 * configured, and it shows every conversation the roles take part in. The people the roles serve are outside
 * it — Slack / Feishu members and channels. A person from a connected workspace without a console account is
 * an *external member* of that connection and may use only the role its bot stands for, or in a conversation of
 * the connection the role chosen to handle it (mayUseRoleIn). What a role may read and
 * use is decided by its own permissions (tool groups, knowledge spaces, connections): whatever it may read, it may
 * use wherever it works.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { connections, externalThreadLinks, type User, users } from "../db/schema.js";
import { Forbidden } from "../errors.js";
import { externalHandler } from "../integrations/links.js";

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
  SECRETS_MANAGE: "secrets.manage",
  MODEL_USE: "model.use",
  CONNECTION_MANAGE: "connection.manage",
  AUDIT_VIEW: "audit.view",
  USER_MANAGE: "user.manage",
  APPROVAL_DECIDE: "approval.decide",
  KNOWLEDGE_READ: "knowledge.read",
  KNOWLEDGE_WRITE: "knowledge.write",
  EMERGENCY_STOP: "emergency.stop",
} as const;
export type Perm = (typeof Perm)[keyof typeof Perm];
export const ALL_PERMS = Object.values(Perm) as Perm[];

/** A console account (an administrator), as opposed to an external member of a connection. */
export const isConsoleUser = (user: User | null | undefined): boolean => !!user?.isActive && !user.externalConnectionId;

export async function hasPermission(db: Db, user: User | null | undefined, perm: Perm, resourceId?: string | null) {
  if (!user?.isActive) return false;
  if (user.externalConnectionId) return externalMemberMay(db, user.externalConnectionId, perm, resourceId);
  return true;
}

/** External members may use (and bring into a thread) the role their connection's bot stands for; see mayUseRoleIn. */
async function externalMemberMay(db: Db, connectionId: string, perm: Perm, roleId?: string | null): Promise<boolean> {
  if (!roleId || (perm !== Perm.ROLE_USE && perm !== Perm.ROLE_INVITE)) return false;
  const [conn] = await db.select().from(connections).where(eq(connections.id, connectionId)).limit(1);
  return !!conn && conn.settings?.role_id === roleId;
}

/**
 * ROLE_USE for work in a topic. In a conversation of their connection an external member also uses the role a
 * person chose to handle it (integrations/links.ts externalHandler), which may not be the bot's own.
 */
export async function mayUseRoleIn(db: Db, user: User | null | undefined, roleId: string, topicId: string) {
  if (await hasPermission(db, user, Perm.ROLE_USE, roleId)) return true;
  if (!user?.isActive || !user.externalConnectionId) return false;
  if ((await externalHandler(db, topicId))?.roleId !== roleId) return false;
  const [linked] = await db
    .select({ id: externalThreadLinks.id })
    .from(externalThreadLinks)
    .where(
      and(eq(externalThreadLinks.topicId, topicId), eq(externalThreadLinks.connectionId, user.externalConnectionId)),
    )
    .limit(1);
  return !!linked;
}

export async function requirePerm(db: Db, user: User | null | undefined, perm: Perm, resourceId?: string | null) {
  if (!(await hasPermission(db, user, perm, resourceId))) {
    throw new Forbidden(`missing permission ${perm}${resourceId ? ` on ${resourceId}` : ""}`);
  }
}

/** The console accounts: they approve, decide and are told about everything. */
export async function consoleUsers(db: Db): Promise<Set<string>> {
  const active = await db.select().from(users).where(eq(users.isActive, true));
  return new Set(active.filter((u) => !u.externalConnectionId).map((u) => u.id));
}

/** Active users holding ``perm`` on a resource: the console accounts, plus external members it allows. */
export async function usersWithPermission(db: Db, perm: Perm, resourceId?: string | null): Promise<Set<string>> {
  const active = await db.select().from(users).where(eq(users.isActive, true));
  const out = new Set<string>();
  for (const u of active) if (await hasPermission(db, u, perm, resourceId)) out.add(u.id);
  return out;
}

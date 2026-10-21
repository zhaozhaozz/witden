/** Topics, participants and who may see which part of the history. */
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { messages, type Role, roles, type Topic, topicParticipants, topics, type User, users } from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { externalRoleId } from "../integrations/links.js";
import { hasPermission, isConsoleUser, Perm, requirePerm } from "../security/permissions.js";

export async function getTopic(db: Db, id: string): Promise<Topic> {
  const [topic] = await db.select().from(topics).where(eq(topics.id, id)).limit(1);
  if (!topic) throw new NotFound("topic not found");
  return topic;
}

export async function participant(db: Db, topicId: string, type: string, id: string) {
  const [p] = await db
    .select()
    .from(topicParticipants)
    .where(
      and(
        eq(topicParticipants.topicId, topicId),
        eq(topicParticipants.participantType, type),
        eq(topicParticipants.participantId, id),
        isNull(topicParticipants.removedAt),
      ),
    )
    .limit(1);
  return p;
}

export async function participants(db: Db, topicId: string, type?: "user" | "role") {
  const conds = [eq(topicParticipants.topicId, topicId), isNull(topicParticipants.removedAt)];
  if (type) conds.push(eq(topicParticipants.participantType, type));
  return db
    .select()
    .from(topicParticipants)
    .where(and(...conds));
}

/** The console shows every conversation to its accounts; an external member sees only their own. */
export async function canView(db: Db, user: User, topic: Topic): Promise<boolean> {
  if (isConsoleUser(user)) return true;
  return user.isActive && !!(await participant(db, topic.id, "user", user.id));
}

export async function requireView(db: Db, user: User, topic: Topic): Promise<void> {
  if (!(await canView(db, user, topic))) throw new Forbidden("you cannot view this topic");
}

export async function canPost(db: Db, user: User, topic: Topic): Promise<boolean> {
  if (topic.status !== "active" || !(await participant(db, topic.id, "user", user.id))) return false;
  if (topic.kind !== "dm") return true;
  // A DM whose role was disabled keeps its history, read-only; enabling the role opens it again.
  const [p] = await participants(db, topic.id, "role");
  return (p ? await getRole(db, p.participantId) : undefined)?.status === "active";
}

/** Settings, members, cleanup and other management: any console account (all are administrators). */
export async function canAdminister(_db: Db, user: User, _topic: Topic): Promise<boolean> {
  return isConsoleUser(user);
}

export async function addParticipant(
  db: Db,
  topic: Topic,
  type: "user" | "role",
  id: string,
  opts: { invitedBy?: string | null } = {},
) {
  const existing = await participant(db, topic.id, type, id);
  if (existing) return existing;
  const now = new Date();
  const [p] = await db
    .insert(topicParticipants)
    .values({
      id: newId("tp"),
      topicId: topic.id,
      participantType: type,
      participantId: id,
      joinedAt: now,
      invitedBy: opts.invitedBy ?? null,
    })
    .returning();
  return p;
}

/** Removed participants lose access to the whole topic, including earlier history. */
export async function removeParticipant(db: Db, topic: Topic, type: string, id: string): Promise<boolean> {
  const p = await participant(db, topic.id, type, id);
  if (!p) return false;
  await db.update(topicParticipants).set({ removedAt: new Date() }).where(eq(topicParticipants.id, p.id));
  return true;
}

export async function getRole(db: Db, id: string): Promise<Role | undefined> {
  const [role] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  return role;
}

export async function inviteRole(
  db: Db,
  user: User | null,
  topic: Topic,
  roleId: string,
  opts: { byRole?: Role } = {},
) {
  const role = await getRole(db, roleId);
  if (!role) throw new NotFound(`role ${roleId} not found`);
  if (role.status !== "active") throw new BadRequest(`role ${role.handle} is disabled`);
  if (topic.kind === "dm" && (await participants(db, topic.id, "role")).length)
    throw new BadRequest("a DM has exactly one role");
  // A Slack, Feishu or GitHub conversation has one role: the one its bot stands for.
  const bound = await externalRoleId(db, topic.id);
  if (bound !== undefined && bound !== role.id)
    throw new BadRequest("only the role its bot stands for works in a Slack, Feishu or GitHub conversation");
  if (user) await requirePerm(db, user, Perm.ROLE_INVITE, role.id);
  return addParticipant(db, topic, "role", role.id, { invitedBy: user?.id ?? opts.byRole?.id ?? null });
}

export async function createTopic(
  db: Db,
  user: User,
  data: {
    title: string;
    goal?: string;
    responseMode?: string;
    userIds?: string[];
    roleIds?: string[];
    source?: string;
    kind?: "group" | "dm";
  },
): Promise<Topic> {
  await requirePerm(db, user, Perm.TOPIC_CREATE);
  const responseMode = parseResponseMode(data.responseMode ?? "mention");
  if (!data.title?.trim()) throw new BadRequest("title is required");
  const goal = parseGoal(data.goal ?? "");
  const kind = data.kind ?? "group";
  const [topic] = await db
    .insert(topics)
    .values({
      id: newId("top"),
      title: data.title.trim(),
      goal,
      kind,
      responseMode,
      source: data.source ?? "internal",
      createdBy: user.id,
    })
    .returning();
  await addParticipant(db, topic, "user", user.id, { invitedBy: user.id });
  for (const uid of data.userIds ?? []) {
    if (uid === user.id) continue;
    const [u] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
    if (!u) throw new NotFound(`user ${uid} not found`);
    await addParticipant(db, topic, "user", uid, { invitedBy: user.id });
  }
  for (const rid of data.roleIds ?? []) await inviteRole(db, user, topic, rid);
  return topic;
}

/** The person's active DM with the role, if there is one (nothing is created). */
export async function findDm(db: Db, userId: string, roleId: string, source = "internal"): Promise<Topic | undefined> {
  const dms = await db
    .select()
    .from(topics)
    .where(and(eq(topics.kind, "dm"), eq(topics.source, source), eq(topics.status, "active")));
  for (const t of dms) {
    if ((await participant(db, t.id, "user", userId)) && (await participant(db, t.id, "role", roleId))) return t;
  }
  return undefined;
}

export async function getOrCreateDm(db: Db, user: User, role: Role, source = "internal"): Promise<Topic> {
  await requirePerm(db, user, Perm.ROLE_USE, role.id);
  const existing = await findDm(db, user.id, role.id, source);
  if (existing) return existing;
  const [topic] = await db
    .insert(topics)
    .values({
      id: newId("top"),
      title: `${user.name} · ${role.name}`,
      kind: "dm",
      source,
      createdBy: user.id,
    })
    .returning();
  await addParticipant(db, topic, "user", user.id, { invitedBy: user.id });
  await addParticipant(db, topic, "role", role.id, { invitedBy: user.id });
  return topic;
}

/**
 * How roles respond in a group topic. "mention": only when @-mentioned (picked from the composer's list, or
 * by a role through message_role). "auto": a message nobody is @-mentioned in may still reach roles — the
 * only role decides itself whether to answer; with several, the dispatcher picks none, one or more.
 */
export const RESPONSE_MODES = ["mention", "auto"] as const;

export function parseResponseMode(value: unknown): string {
  if (!RESPONSE_MODES.includes(value as (typeof RESPONSE_MODES)[number]))
    throw new BadRequest("response_mode must be mention or auto");
  return String(value);
}

/** A topic's goal: what it is for, read by every role in it and by the dispatcher. */
export function parseGoal(value: unknown): string {
  if (typeof value !== "string" || value.length > 16_000)
    throw new BadRequest("goal must be a string of at most 16000 characters");
  return value;
}

/** A topic's messages, newest page first in time order. Every participant reads the whole history. */
export async function visibleMessages(db: Db, topic: Topic, opts: { limit?: number; before?: Date | null } = {}) {
  const conds = [eq(messages.topicId, topic.id), isNull(messages.deletedAt)];
  if (opts.before) conds.push(lt(messages.createdAt, opts.before));
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.createdAt))
    .limit(opts.limit ?? 100);
  return rows.reverse();
}

export async function roleHandles(db: Db, topicId: string): Promise<Map<string, Role>> {
  const out = new Map<string, Role>();
  for (const p of await participants(db, topicId, "role")) {
    const role = await getRole(db, p.participantId);
    if (role) out.set(role.handle.toLowerCase(), role);
  }
  return out;
}

export async function canDownload(db: Db, user: User, topic: Topic): Promise<boolean> {
  return (
    (await canView(db, user, topic)) &&
    (!!(await participant(db, topic.id, "user", user.id)) ||
      (await hasPermission(db, user, Perm.FILE_DOWNLOAD, topic.id)))
  );
}

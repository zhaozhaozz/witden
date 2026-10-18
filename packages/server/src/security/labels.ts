/**
 * Information-flow labels.
 *
 * Every piece of data an AI task reads carries a label naming where it came from (`topic:<id>`,
 * `user:<id>`, `space:<id>`, `feishu:<connection_id>` or `public`). Each label has a *reader set*: the people allowed to see that
 * data. Before a task sends anything to a destination (a topic, an external channel), the destination's
 * audience must be a subset of the readers of every label the task has read. This stops one person's DM
 * from leaking into a channel and stops delegation from widening access: permissions are checked on the
 * data flow itself, not on which role happens to hold the data.
 *
 * The console accounts (all administrators) read every conversation, so every reader set includes them
 * (`internal`); what is protected is the people outside: Slack / Feishu members and channels.
 *
 * Principals are `u:<user_id>` (console account or external member) or `x:<connection_id>:<external_user_id>`
 * (external account without a user). Universes stand for whole populations: `public`, `internal` (the
 * console accounts) and `ws:<connection_id>` (everyone in an external workspace, e.g. a public Slack channel).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  connections,
  type ExternalConversation,
  externalConversations,
  externalIdentities,
  externalThreadLinks,
  topicParticipants,
  topics,
  users,
} from "../db/schema.js";
import { consoleUsers, Perm, usersWithPermission } from "./permissions.js";

export const PUBLIC = "public";
/** The console accounts. */
export const CONSOLE = "internal";
/** Private conversation member lists older than this are no longer trusted for audience checks. */
export const MEMBERSHIP_TTL_MS = 30 * 60 * 1000;

export interface Readers {
  universes: Set<string>;
  principals: Set<string>;
}

export const readers = (universes: Iterable<string> = [], principals: Iterable<string> = []): Readers => ({
  universes: new Set(universes),
  principals: new Set(principals),
});

const union = (a: Readers, b: Readers): Readers =>
  readers([...a.universes, ...b.universes], [...a.principals, ...b.principals]);

export function describeReaders(r: Readers): string {
  const parts = [...[...r.universes].sort(), ...[...r.principals].sort()];
  return parts.length ? parts.join(", ") : "(nobody)";
}

export const topicLabel = (topicId: string) => `topic:${topicId}`;
export const userLabel = (userId: string) => `user:${userId}`;
export const spaceLabel = (spaceId: string) => `space:${spaceId}`;
/**
 * Data read from a company's Feishu through its app (calendars, documents, bases, sheets…): visible inside that
 * company's Feishu. It may go back to that company's Feishu conversations and the console; anywhere else (another
 * company, Slack, GitHub) needs its release approved.
 */
export const feishuLabel = (connectionId: string) => `feishu:${connectionId}`;

export async function externalPrincipal(db: Db, connectionId: string, externalUserId: string): Promise<string> {
  const [ident] = await db
    .select()
    .from(externalIdentities)
    .where(
      and(eq(externalIdentities.connectionId, connectionId), eq(externalIdentities.externalUserId, externalUserId)),
    )
    .limit(1);
  return ident?.userId ? `u:${ident.userId}` : `x:${connectionId}:${externalUserId}`;
}

export async function conversationReaders(db: Db, conv: ExternalConversation): Promise<Readers> {
  // A public GitHub repository is readable by anyone at all, not just by people in some workspace.
  if (conv.kind === "public") {
    const [conn] = await db.select().from(connections).where(eq(connections.id, conv.connectionId)).limit(1);
    if (conn?.platform === "github") return readers([PUBLIC]);
  }
  // Unknown or stale membership is treated as "everyone in the workspace" so the check fails closed.
  const stale = !conv.membersSyncedAt || Date.now() - conv.membersSyncedAt.getTime() > MEMBERSHIP_TTL_MS;
  if (conv.kind === "public" || stale) return readers([`ws:${conv.connectionId}`]);
  const principals = await Promise.all(conv.memberIds.map((m) => externalPrincipal(db, conv.connectionId, m)));
  return readers([], principals);
}

export async function topicReaders(db: Db, topicId: string): Promise<Readers> {
  const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
  if (!topic) return readers();
  const people = await db
    .select()
    .from(topicParticipants)
    .where(
      and(
        eq(topicParticipants.topicId, topicId),
        eq(topicParticipants.participantType, "user"),
        isNull(topicParticipants.removedAt),
      ),
    );
  let out = readers(
    [CONSOLE],
    people.map((p) => `u:${p.participantId}`),
  );
  const links = await db.select().from(externalThreadLinks).where(eq(externalThreadLinks.topicId, topicId));
  for (const link of links) {
    const [conv] = await db
      .select()
      .from(externalConversations)
      .where(eq(externalConversations.id, link.conversationId))
      .limit(1);
    if (conv) out = union(out, await conversationReaders(db, conv));
  }
  return out;
}

export async function labelReaders(db: Db, label: string): Promise<Readers> {
  if (label === PUBLIC) return readers([PUBLIC]);
  const idx = label.indexOf(":");
  const kind = label.slice(0, idx);
  const ident = label.slice(idx + 1);
  if (kind === "topic") return topicReaders(db, ident);
  if (kind === "user") return readers([CONSOLE], [`u:${ident}`]);
  if (kind === "feishu") return readers([CONSOLE, `ws:${ident}`]);
  if (kind === "space") {
    const ids = await usersWithPermission(db, Perm.KNOWLEDGE_READ, ident);
    return readers(
      [CONSOLE],
      [...ids].map((u) => `u:${u}`),
    );
  }
  return readers(); // unknown labels fail closed
}

async function memberOf(db: Db, principal: string, universe: string): Promise<boolean> {
  if (universe === PUBLIC) return true;
  if (universe === CONSOLE) {
    if (!principal.startsWith("u:")) return false;
    const [u] = await db
      .select()
      .from(users)
      .where(eq(users.id, principal.slice(2)))
      .limit(1);
    return !!u?.isActive && !u.externalConnectionId;
  }
  if (universe.startsWith("ws:")) {
    const connectionId = universe.slice(3);
    if (principal.startsWith(`x:${connectionId}:`)) return true;
    if (principal.startsWith("u:")) {
      const rows = await db
        .select({ id: externalIdentities.id })
        .from(externalIdentities)
        .where(
          and(eq(externalIdentities.connectionId, connectionId), eq(externalIdentities.userId, principal.slice(2))),
        )
        .limit(1);
      return rows.length > 0;
    }
  }
  return false;
}

/** True when everybody in ``audience`` is also in ``allowed``. */
export async function isSubset(db: Db, audience: Readers, allowed: Readers): Promise<boolean> {
  if (allowed.universes.has(PUBLIC)) return true;
  for (const u of audience.universes) if (!allowed.universes.has(u)) return false;
  for (const p of audience.principals) {
    if (allowed.principals.has(p)) continue;
    let ok = false;
    for (const u of allowed.universes) {
      if (await memberOf(db, p, u)) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  return true;
}

export interface FlowDecision {
  allowed: boolean;
  blockedLabels: string[];
  audience: Readers;
  explain(): string;
}

export async function checkFlow(db: Db, labels: string[], audience: Readers): Promise<FlowDecision> {
  const blocked: string[] = [];
  for (const label of new Set(labels)) {
    if (!(await isSubset(db, audience, await labelReaders(db, label)))) blocked.push(label);
  }
  return {
    allowed: blocked.length === 0,
    blockedLabels: blocked,
    audience,
    explain: () =>
      blocked.length === 0
        ? "all sources are visible to the destination audience"
        : `destination audience (${describeReaders(audience)}) is wider than the readers of: ${blocked.join(", ")}`,
  };
}

/** Whether one person may see data carrying all of ``labels`` (e.g. a task's full transcript). */
export async function userCanRead(db: Db, userId: string, labels: string[]): Promise<boolean> {
  const me = readers([], [`u:${userId}`]);
  for (const label of new Set(labels)) {
    if (!(await isSubset(db, me, await labelReaders(db, label)))) return false;
  }
  return true;
}

/**
 * Users who may approve releasing data under ``label`` to a wider audience: the console accounts among the
 * people it came from (the person whose DM or notes it is, the people in the topic), otherwise any console
 * account — an external member cannot approve anything, they have no console.
 */
export async function labelOwners(db: Db, label: string): Promise<Set<string>> {
  const admins = await consoleUsers(db);
  const idx = label.indexOf(":");
  const kind = label.slice(0, idx);
  const ident = label.slice(idx + 1);
  let from: string[] = [];
  if (kind === "user") from = [ident];
  else if (kind === "topic") {
    const rows = await db
      .select()
      .from(topicParticipants)
      .where(
        and(
          eq(topicParticipants.topicId, ident),
          eq(topicParticipants.participantType, "user"),
          isNull(topicParticipants.removedAt),
        ),
      );
    from = rows.map((r) => r.participantId);
  }
  const owners = from.filter((id) => admins.has(id));
  return new Set(owners.length ? owners : admins);
}

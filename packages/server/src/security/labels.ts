/**
 * Information-flow labels.
 *
 * Every piece of data an AI task reads carries a label naming where it came from (`topic:<id>`,
 * `user:<id>`, `space:<id>` or `public`). Each label has a *reader set*: the people allowed to see that
 * data. Before a task sends anything to a destination (a topic, an external channel), the destination's
 * audience must be a subset of the readers of every label the task has read. This stops DM material from
 * leaking into group chats and stops delegation from widening access: permissions are checked on the data
 * flow itself, not on which role happens to hold the data.
 *
 * Principals are `u:<user_id>` (member) or `x:<connection_id>:<external_user_id>` (external account not
 * linked to a member). Universes stand for whole populations: `public`, `internal` (all active members) and
 * `ws:<connection_id>` (everyone in an external workspace, e.g. a public Slack channel).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  type ExternalConversation,
  externalConversations,
  externalIdentities,
  externalThreadLinks,
  topicParticipants,
  topics,
  users,
} from "../db/schema.js";
import { Perm, usersWithPermission } from "./permissions.js";

export const PUBLIC = "public";
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
    [],
    people.map((p) => `u:${p.participantId}`),
  );
  if (topic.kind === "group" && topic.visibility === "internal") out = union(out, readers(["internal"]));
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
  if (kind === "user") return readers([], [`u:${ident}`]);
  if (kind === "space") {
    const ids = await usersWithPermission(db, Perm.KNOWLEDGE_READ, ident);
    return readers(
      [],
      [...ids].map((u) => `u:${u}`),
    );
  }
  return readers(); // unknown labels fail closed
}

async function memberOf(db: Db, principal: string, universe: string): Promise<boolean> {
  if (universe === PUBLIC) return true;
  if (universe === "internal") {
    if (!principal.startsWith("u:")) return false;
    const [u] = await db
      .select()
      .from(users)
      .where(eq(users.id, principal.slice(2)))
      .limit(1);
    return !!u?.isActive;
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

/** Users who may approve releasing data under ``label`` to a wider audience. */
export async function labelOwners(db: Db, label: string): Promise<Set<string>> {
  const idx = label.indexOf(":");
  const kind = label.slice(0, idx);
  const ident = label.slice(idx + 1);
  if (kind === "user") return new Set([ident]);
  if (kind === "topic") {
    const [topic] = await db.select().from(topics).where(eq(topics.id, ident)).limit(1);
    if (!topic) return new Set();
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
    if (topic.kind === "dm") return new Set(rows.map((r) => r.participantId));
    const owners = rows.filter((r) => r.isOwner).map((r) => r.participantId);
    return new Set(owners.length ? owners : rows.map((r) => r.participantId));
  }
  if (kind === "space") return usersWithPermission(db, Perm.KNOWLEDGE_WRITE, ident);
  return new Set();
}

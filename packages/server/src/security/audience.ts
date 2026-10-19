/**
 * Audiences: who can see a topic or an external conversation.
 *
 * Publishing a topic to a Slack channel, a Feishu group or a GitHub repository makes it visible to that
 * conversation's members; when they are more than the people who can see the topic now, the person publishing
 * confirms it (api/integrations.ts). What roles may read and use is decided by their permissions alone
 * (security/permissions.ts and the role's tool groups): material is not tracked by source.
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

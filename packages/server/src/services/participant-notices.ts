import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditLogs, type Message, messages, roles } from "../db/schema.js";

const roleFields = {
  id: roles.id,
  name: roles.name,
  handle: roles.handle,
  color: roles.color,
  avatar_url: roles.avatarUrl,
};

export interface RoleParticipantChange {
  action: "added" | "removed";
  actor_name: string;
  role: { id: string; name: string; handle: string | null; color: string | null; avatar_url: string | null };
}

export async function roleParticipantChange(
  db: Db,
  roleId: string,
  action: RoleParticipantChange["action"],
  actorName: string,
): Promise<RoleParticipantChange> {
  const [role] = await db.select(roleFields).from(roles).where(eq(roles.id, roleId)).limit(1);
  return {
    action,
    actor_name: actorName,
    role: role ?? { id: roleId, name: "已删除角色", handle: null, color: null, avatar_url: null },
  };
}

/** Only system notices expose this snapshot; never return the rest of external_ref. */
export function participantChangeOf(msg: Message): RoleParticipantChange | null {
  if (msg.authorType !== "system" || msg.deletedAt) return null;
  const change = msg.externalRef?.participant_change as RoleParticipantChange | undefined;
  if (!change || !["added", "removed"].includes(change.action) || !change.role?.id) return null;
  const { id, name, handle, color, avatar_url } = change.role;
  return { action: change.action, actor_name: change.actor_name, role: { id, name, handle, color, avatar_url } };
}

const addedSuffix = " added a role to the topic.";
function legacyAction(msg: Message): RoleParticipantChange["action"] | null {
  if (msg.authorType !== "system" || msg.deletedAt || msg.externalRef?.participant_change) return null;
  if (msg.content.endsWith(addedSuffix)) return "added";
  return msg.content === "A role left the topic." ? "removed" : null;
}

/** Old notices and their audit entry used the same transaction timestamp. Match exactly, never by proximity. */
export async function legacyParticipantChanges(db: Db, page: Message[]): Promise<Map<string, RoleParticipantChange>> {
  const candidates = page.filter((msg) => legacyAction(msg));
  const result = new Map<string, RoleParticipantChange>();
  if (!candidates.length) return result;
  const rows = await db
    .select({
      messageId: messages.id,
      auditId: auditLogs.id,
      action: auditLogs.action,
      roleId: sql<string>`${auditLogs.detail}->>'id'`,
      role: roleFields,
    })
    .from(messages)
    .innerJoin(auditLogs, and(eq(auditLogs.topicId, messages.topicId), eq(auditLogs.createdAt, messages.createdAt)))
    .leftJoin(roles, eq(roles.id, sql`${auditLogs.detail}->>'id'`))
    .where(
      and(
        inArray(
          messages.id,
          candidates.map((msg) => msg.id),
        ),
        eq(auditLogs.outcome, "ok"),
        sql`${auditLogs.detail}->>'type' = 'role'`,
        inArray(auditLogs.action, ["topic.participant_add", "topic.participant_remove"]),
        // Include siblings outside this page in the ambiguity check.
        sql`not exists (
        select 1 from messages sibling
        where sibling.id <> ${messages.id} and sibling.topic_id = ${messages.topicId}
          and sibling.created_at = ${messages.createdAt} and sibling.author_type = 'system'
          and sibling.deleted_at is null and sibling.external_ref->'participant_change' is null
          and ((${auditLogs.action} = 'topic.participant_add' and sibling.content like '% added a role to the topic.')
            or (${auditLogs.action} = 'topic.participant_remove' and sibling.content = 'A role left the topic.'))
      )`,
      ),
    );
  const matches = rows.filter((row) => {
    const msg = candidates.find((candidate) => candidate.id === row.messageId)!;
    return row.roleId && row.action === `topic.participant_${legacyAction(msg) === "added" ? "add" : "remove"}`;
  });
  for (const msg of candidates) {
    const found = matches.filter((row) => row.messageId === msg.id);
    // Ambiguous records keep their original text instead of attributing them to the wrong role.
    if (found.length !== 1 || matches.filter((row) => row.auditId === found[0].auditId).length !== 1) continue;
    const row = found[0];
    const action = legacyAction(msg)!;
    result.set(msg.id, {
      action,
      actor_name: action === "added" ? msg.content.slice(0, -addedSuffix.length) : "",
      role: row.role ?? { id: row.roleId, name: "已删除角色", handle: null, color: null, avatar_url: null },
    });
  }
  return result;
}

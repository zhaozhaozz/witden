import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { auditLogs } from "../db/schema.js";
import { redactDeep } from "../security/crypto.js";

export interface AuditEntry {
  actorType?: "user" | "role" | "system" | "external";
  actorId?: string | null;
  outcome?: "ok" | "denied" | "error";
  resourceType?: string | null;
  resourceId?: string | null;
  topicId?: string | null;
  taskId?: string | null;
  roleId?: string | null;
  instanceId?: string | null;
  connectionId?: string | null;
  detail?: Record<string, unknown>;
}

/** Append an audit record: who did what, where. Details are redacted and should hold metadata, not content. */
export async function audit(db: Db, action: string, entry: AuditEntry = {}): Promise<void> {
  await db.insert(auditLogs).values({
    id: newId("aud"),
    action,
    actorType: entry.actorType ?? "system",
    actorId: entry.actorId ?? null,
    outcome: entry.outcome ?? "ok",
    resourceType: entry.resourceType ?? null,
    resourceId: entry.resourceId ?? null,
    topicId: entry.topicId ?? null,
    taskId: entry.taskId ?? null,
    roleId: entry.roleId ?? null,
    instanceId: entry.instanceId ?? null,
    connectionId: entry.connectionId ?? null,
    detail: redactDeep(entry.detail ?? {}) as Record<string, any>,
  });
}

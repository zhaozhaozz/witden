import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { auditLogs } from "../db/schema.js";
import { redactDeep } from "../security/crypto.js";
import { acting } from "./acting.js";

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

/**
 * Append an audit record: who did what, where. Details are redacted and should hold metadata, not content.
 * Changes a system administrator role makes for a person also name the role and its task.
 */
export async function audit(db: Db, action: string, entry: AuditEntry = {}): Promise<void> {
  const as = acting();
  await db.insert(auditLogs).values({
    id: newId("aud"),
    action,
    actorType: entry.actorType ?? "system",
    actorId: entry.actorId ?? null,
    outcome: entry.outcome ?? "ok",
    resourceType: entry.resourceType ?? null,
    resourceId: entry.resourceId ?? null,
    topicId: entry.topicId ?? null,
    taskId: entry.taskId ?? as?.taskId ?? null,
    roleId: entry.roleId ?? as?.roleId ?? null,
    instanceId: entry.instanceId ?? null,
    connectionId: entry.connectionId ?? null,
    detail: redactDeep({ ...(entry.detail ?? {}), ...(as ? { by_role_id: as.roleId } : {}) }) as Record<string, any>,
  });
}

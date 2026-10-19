/**
 * Role memory (memories.scope = "role"): what a role keeps as itself, not tied to one topic or person. Its
 * system prompt lists it wherever the role works — every topic, DM, Slack channel, Feishu chat and GitHub
 * thread — so it changes how the role works for everyone: only work an administrator asked for may add to it.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type Memory, memories, type Task, users } from "../db/schema.js";
import { isConsoleUser } from "../security/permissions.js";

/** Every prompt of the role carries its memory: keep each note short. */
export const ROLE_MEMORY_MAX_CHARS = 1000;
/** How many of the latest notes the system prompt lists; recall searches them all. */
export const ROLE_MEMORY_SHOWN = 30;

/** The role's live notes, oldest first. */
export async function roleMemories(db: Db, roleId: string): Promise<Memory[]> {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.scope, "role"), eq(memories.roleId, roleId), isNull(memories.deletedAt)))
    .orderBy(asc(memories.createdAt));
}

/** Why this task may not add to its role's memory, or null when it may. */
export async function roleMemoryRefusal(db: Db, task: Task): Promise<string | null> {
  const [requester] = task.requesterUserId
    ? await db.select().from(users).where(eq(users.id, task.requesterUserId)).limit(1)
    : [];
  // Someone outside the console must not be able to change how the role works for everyone else.
  if (!isConsoleUser(requester))
    return "role memory changes how you work everywhere, so it can be added only while you work for a witden administrator (a console account); use scope 'topic'";
  return null;
}

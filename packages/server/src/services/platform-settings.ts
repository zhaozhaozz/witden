/** Platform-wide settings edited in the console, stored as one JSON value per key. */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { platformSettings } from "../db/schema.js";

export async function getSetting<T extends Record<string, any>>(db: Db, key: string): Promise<T | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key)).limit(1);
  return (row?.value as T) ?? null;
}

export async function putSetting(db: Db, key: string, value: Record<string, any>, userId: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value, updatedBy: userId })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value, updatedBy: userId, updatedAt: new Date() },
    });
}

/** The model that routes un-mentioned messages in "auto" topics with several roles (agent/router.ts). */
export const DISPATCHER = "dispatcher";
export interface DispatcherSetting {
  model_config_id: string | null;
}

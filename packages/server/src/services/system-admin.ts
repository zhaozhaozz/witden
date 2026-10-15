/**
 * The system administrator role is built in: the platform creates it at start when it is missing, there is only
 * ever one (a partial unique index, migration 0020), and people can neither add another nor disable or copy it.
 * People still configure it like any role: name, prompt, model, tool approvals, limits.
 */
import { asc, eq } from "drizzle-orm";
import { DEFAULT_ADMIN_TOOLS } from "../agent/tools.js";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { modelConfigs, modelProviders, type Role, roles } from "../db/schema.js";
import { audit } from "./audit.js";
import { isSystemOne, unusableReason } from "./model-configs.js";

export const SYSTEM_ADMIN = {
  name: "系统管理员",
  handle: "admin",
  description: "帮你配置 witden：角色、模型、虚拟电脑、通讯接入和知识。",
  systemPrompt: "你是 witden 的系统管理员，用中文和管理员沟通，按他们的要求配置 witden。",
};

/** A model it can work with: the one most active roles use, else any usable chat model. */
async function defaultModel(db: Db): Promise<string | null> {
  const usable = (
    await db
      .select({ model: modelConfigs, provider: modelProviders })
      .from(modelConfigs)
      .innerJoin(modelProviders, eq(modelProviders.id, modelConfigs.providerId))
      .orderBy(asc(modelConfigs.createdAt))
  ).filter((r) => !isSystemOne(r.provider) && !unusableReason(r.model, r.provider));
  const ids = new Set(usable.map((r) => r.model.id));
  const uses = new Map<string, number>();
  for (const r of await db.select().from(roles).where(eq(roles.status, "active"))) {
    if (r.modelConfigId && ids.has(r.modelConfigId)) uses.set(r.modelConfigId, (uses.get(r.modelConfigId) ?? 0) + 1);
  }
  const popular = [...uses.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return popular ?? usable[0]?.model.id ?? null;
}

/** The system administrator, created (and kept enabled) by the platform. */
export async function ensureSystemAdmin(db: Db): Promise<Role> {
  const [existing] = await db.select().from(roles).where(eq(roles.systemAdmin, true)).limit(1);
  if (existing) {
    if (existing.status === "active") return existing;
    const [enabled] = await db.update(roles).set({ status: "active" }).where(eq(roles.id, existing.id)).returning();
    return enabled;
  }
  const taken = new Set((await db.select({ handle: roles.handle }).from(roles)).map((r) => r.handle));
  let handle = SYSTEM_ADMIN.handle;
  for (let i = 2; taken.has(handle); i++) handle = `${SYSTEM_ADMIN.handle}-${i}`;
  const [created] = await db
    .insert(roles)
    .values({
      id: newId("role"),
      ...SYSTEM_ADMIN,
      handle,
      systemAdmin: true,
      modelConfigId: await defaultModel(db),
      allowedTools: DEFAULT_ADMIN_TOOLS,
      approvalRequired: [],
    })
    .returning();
  await audit(db, "role.create", {
    actorType: "system",
    resourceType: "role",
    resourceId: created.id,
    roleId: created.id,
    detail: { system_admin: true },
  });
  return created;
}

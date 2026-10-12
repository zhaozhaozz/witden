/**
 * Per-computer model access. When enabled, the computer's runner serves a local OpenAI- / Anthropic- / System One-compatible
 * endpoint and relays requests to the platform (compute/model-proxy.ts). Programs inside the computer get a
 * key the platform issued for this computer and a list of allowed models; real provider addresses and keys
 * never enter the computer.
 */
import type { ModelProxyConfig } from "@witden/shared";
import { eq, inArray } from "drizzle-orm";
import { settings } from "../config.js";
import { type Db, db as getDb } from "../db/client.js";
import {
  type ComputerInstance,
  computerInstances,
  type ModelConfig,
  type ModelProvider,
  modelConfigs,
  modelProviders,
  type User,
} from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { maybeRuntime } from "../runtime.js";
import { newToken, secretBox } from "../security/crypto.js";
import { hasPermission, Perm, requirePerm } from "../security/permissions.js";
import { audit } from "./audit.js";
import { unusableReason } from "./model-configs.js";

export interface ProxyModel {
  /** The name programs in the computer use: the model id, or "provider/model" when two providers share it. */
  alias: string;
  model: ModelConfig;
  provider: ModelProvider;
}

export async function proxyModels(db: Db, ids: string[]): Promise<ProxyModel[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ model: modelConfigs, provider: modelProviders })
    .from(modelConfigs)
    .innerJoin(modelProviders, eq(modelProviders.id, modelConfigs.providerId))
    .where(inArray(modelConfigs.id, ids));
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.model.model, (count.get(r.model.model) ?? 0) + 1);
  return rows
    .map((r) => ({
      ...r,
      alias: (count.get(r.model.model) ?? 0) > 1 ? `${r.provider.name}/${r.model.model}` : r.model.model,
    }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

/** What the runner is told (null: no local endpoint). */
export async function proxyConfig(db: Db, inst: ComputerInstance): Promise<ModelProxyConfig | null> {
  if (!inst.modelProxyEnabled || !inst.modelProxyKeyEncrypted) return null;
  const models = await proxyModels(db, inst.modelProxyModelIds);
  return {
    port: settings().modelProxyPort,
    key: secretBox().decrypt(inst.modelProxyKeyEncrypted),
    models: models.filter((m) => !unusableReason(m.model, m.provider)).map((m) => m.alias),
  };
}

export async function proxyConfigFor(instanceId: string): Promise<ModelProxyConfig | null> {
  const [inst] = await getDb().select().from(computerInstances).where(eq(computerInstances.id, instanceId)).limit(1);
  return inst ? proxyConfig(getDb(), inst) : null;
}

/** Tell a connected runner about new settings. Call after the change committed. */
export async function pushProxyConfig(instanceId: string): Promise<void> {
  const conn = maybeRuntime()?.hub?.connected(instanceId);
  if (conn) conn.post({ type: "configure", modelProxy: await proxyConfigFor(instanceId) });
}

const mayUseModel = async (db: Db, user: User, id: string) =>
  (await hasPermission(db, user, Perm.SECRETS_MANAGE)) || (await hasPermission(db, user, Perm.MODEL_USE, id));

export async function updateProxy(
  db: Db,
  user: User,
  inst: ComputerInstance,
  data: { enabled?: unknown; modelIds?: unknown },
): Promise<ComputerInstance> {
  await requirePerm(db, user, Perm.INSTANCE_MANAGE, inst.id);
  const update: Partial<ComputerInstance> = {};
  if (data.modelIds !== undefined) {
    if (!Array.isArray(data.modelIds) || !data.modelIds.every((x) => typeof x === "string"))
      throw new BadRequest("model_ids must be a list of model ids");
    const ids = [...new Set(data.modelIds as string[])];
    const found = new Set(
      (
        await db
          .select({ id: modelConfigs.id })
          .from(modelConfigs)
          .where(inArray(modelConfigs.id, ids.length ? ids : [""]))
      ).map((m) => m.id),
    );
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new NotFound(`models not found: ${missing.join(", ")}`);
    // Granting a computer a model needs the right to use that model yourself.
    for (const id of ids.filter((id) => !inst.modelProxyModelIds.includes(id))) {
      if (!(await mayUseModel(db, user, id))) throw new Forbidden(`you may not give computers access to model ${id}`);
    }
    update.modelProxyModelIds = ids;
  }
  if (data.enabled !== undefined) {
    update.modelProxyEnabled = !!data.enabled;
    if (update.modelProxyEnabled && !inst.modelProxyKeyEncrypted) {
      update.modelProxyKeyEncrypted = secretBox().encrypt(newToken("wdm_"));
      update.modelProxyKeyIssuedAt = new Date();
    }
  }
  const [row] = await db.update(computerInstances).set(update).where(eq(computerInstances.id, inst.id)).returning();
  await audit(db, "model_proxy.update", {
    actorType: "user",
    actorId: user.id,
    resourceType: "instance",
    resourceId: inst.id,
    instanceId: inst.id,
    detail: { enabled: row.modelProxyEnabled, models: row.modelProxyModelIds },
  });
  return row;
}

/** A new key; the old one stops working at once. */
export async function rotateProxyKey(db: Db, user: User, inst: ComputerInstance): Promise<ComputerInstance> {
  await requirePerm(db, user, Perm.INSTANCE_MANAGE, inst.id);
  const [row] = await db
    .update(computerInstances)
    .set({ modelProxyKeyEncrypted: secretBox().encrypt(newToken("wdm_")), modelProxyKeyIssuedAt: new Date() })
    .where(eq(computerInstances.id, inst.id))
    .returning();
  await audit(db, "model_proxy.rotate_key", {
    actorType: "user",
    actorId: user.id,
    resourceType: "instance",
    resourceId: inst.id,
    instanceId: inst.id,
  });
  return row;
}

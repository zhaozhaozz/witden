import { and, eq, gte, sql } from "drizzle-orm";
import { buildModel, type ChatModel, probeCapabilities } from "../agent/llm.js";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type ModelConfig, modelConfigs, roles, usageRecords } from "../db/schema.js";
import { BadRequest, Conflict, NotFound } from "../errors.js";
import { secretBox } from "../security/crypto.js";

export const PROVIDERS = new Set(["openai", "anthropic"]);

/** Replaced in tests to plug in scripted models. */
export let modelFactory: (cfg: ModelConfig, apiKey: string | null) => ChatModel = (cfg, key) =>
  buildModel(cfg.provider, cfg.baseUrl, cfg.model, key, cfg.params);
export function setModelFactory(fn: typeof modelFactory): void {
  modelFactory = fn;
}

function validate(data: Record<string, any>): void {
  if (!PROVIDERS.has(data.provider ?? "openai"))
    throw new BadRequest(`provider must be one of ${[...PROVIDERS].join(", ")}`);
  const url = String(data.baseUrl ?? "");
  if (!url.startsWith("http://") && !url.startsWith("https://"))
    throw new BadRequest("base_url must start with http:// or https://");
  if (!String(data.model ?? "").trim()) throw new BadRequest("model is required");
  if (data.params != null && (typeof data.params !== "object" || Array.isArray(data.params))) {
    throw new BadRequest("params must be an object");
  }
}

export async function getConfig(db: Db, id: string): Promise<ModelConfig> {
  const [cfg] = await db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).limit(1);
  if (!cfg) throw new NotFound("model config not found");
  return cfg;
}

async function nameTaken(db: Db, name: string): Promise<boolean> {
  return (
    (await db.select({ id: modelConfigs.id }).from(modelConfigs).where(eq(modelConfigs.name, name)).limit(1)).length > 0
  );
}

export async function createConfig(db: Db, data: Record<string, any>, createdBy: string | null): Promise<ModelConfig> {
  validate(data);
  const name = String(data.name ?? "").trim();
  if (!name) throw new BadRequest("name is required");
  if (await nameTaken(db, name)) throw new Conflict(`model config ${name} already exists`);
  const [cfg] = await db
    .insert(modelConfigs)
    .values({
      id: newId("mdl"),
      name,
      provider: data.provider ?? "openai",
      baseUrl: data.baseUrl,
      model: String(data.model).trim(),
      params: data.params ?? {},
      dailyTokenLimit: data.dailyTokenLimit ?? null,
      apiKeyEncrypted: data.apiKey ? secretBox().encrypt(data.apiKey) : null,
      keyUpdatedAt: data.apiKey ? new Date() : null,
      createdBy,
    })
    .returning();
  return cfg;
}

export async function updateConfig(db: Db, cfg: ModelConfig, data: Record<string, any>): Promise<ModelConfig> {
  const merged = {
    provider: data.provider ?? cfg.provider,
    baseUrl: data.baseUrl ?? cfg.baseUrl,
    model: data.model ?? cfg.model,
    params: data.params ?? cfg.params,
  };
  validate(merged);
  const addressChanged = merged.provider !== cfg.provider || merged.baseUrl !== cfg.baseUrl;
  let endpointChanged = addressChanged || merged.model !== cfg.model;
  const update: Partial<ModelConfig> = { ...merged };
  if (data.name !== undefined && data.name !== cfg.name) {
    if (await nameTaken(db, data.name)) throw new Conflict(`model config ${data.name} already exists`);
    update.name = data.name;
  }
  if ("dailyTokenLimit" in data) update.dailyTokenLimit = data.dailyTokenLimit;
  if (addressChanged && data.apiKey == null && cfg.apiKeyEncrypted) {
    // Never send an existing key to a new endpoint: it must be re-entered for the new address.
    update.apiKeyEncrypted = null;
    update.keyUpdatedAt = new Date();
  }
  if (data.apiKey != null) {
    update.apiKeyEncrypted = data.apiKey ? secretBox().encrypt(data.apiKey) : null;
    update.keyUpdatedAt = new Date();
    endpointChanged = true;
    if (cfg.status === "revoked") update.status = "unchecked";
  }
  if (endpointChanged && cfg.status !== "revoked") {
    update.status = "unchecked";
    update.capabilities = {};
  }
  const [row] = await db.update(modelConfigs).set(update).where(eq(modelConfigs.id, cfg.id)).returning();
  return row;
}

export async function revokeKey(db: Db, cfg: ModelConfig): Promise<ModelConfig> {
  const [row] = await db
    .update(modelConfigs)
    .set({ apiKeyEncrypted: null, keyUpdatedAt: new Date(), status: "revoked" })
    .where(eq(modelConfigs.id, cfg.id))
    .returning();
  return row;
}

export function chatModelFor(cfg: ModelConfig): ChatModel {
  if (cfg.status === "revoked") throw new BadRequest(`model config ${cfg.name} has been revoked`);
  return modelFactory(cfg, cfg.apiKeyEncrypted ? secretBox().decrypt(cfg.apiKeyEncrypted) : null);
}

export async function checkConfig(db: Db, cfg: ModelConfig): Promise<ModelConfig> {
  const caps = await probeCapabilities(chatModelFor(cfg));
  const [row] = await db
    .update(modelConfigs)
    .set({ capabilities: caps, status: caps.chat ? "ok" : "error" })
    .where(eq(modelConfigs.id, cfg.id))
    .returning();
  return row;
}

function dayStart(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function tokensToday(db: Db, opts: { roleId?: string; modelConfigId?: string }): Promise<number> {
  const conds = [gte(usageRecords.createdAt, dayStart())];
  if (opts.roleId) conds.push(eq(usageRecords.roleId, opts.roleId));
  if (opts.modelConfigId) conds.push(eq(usageRecords.modelConfigId, opts.modelConfigId));
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${usageRecords.promptTokens} + ${usageRecords.completionTokens}), 0)::int`,
    })
    .from(usageRecords)
    .where(and(...conds));
  return Number(row?.total ?? 0);
}

export async function rolesUsing(db: Db, cfg: ModelConfig): Promise<string[]> {
  return (await db.select().from(roles).where(eq(roles.modelConfigId, cfg.id))).map((r) => r.handle);
}

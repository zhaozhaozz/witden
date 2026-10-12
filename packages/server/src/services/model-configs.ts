/**
 * Model services. A provider is one endpoint, protocol and key; it offers any number of models, picked from
 * the provider's own model list or entered by hand. Roles, grants, usage records and topic restrictions refer
 * to models (rows of model_configs), never to providers.
 *
 * Chat models (OpenAI-compatible and Anthropic protocols) do the roles' work. System One decision models
 * (protocol "systemone": TypeSafe Jev, Laya) answer typed questions only; the topic dispatcher uses them.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { buildModel, type ChatModel, listModels, probeCapabilities, type RemoteModel } from "../agent/llm.js";
import { type DecisionModel, probeDecisionModel, SystemOneModel } from "../agent/systemone.js";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  type ModelConfig,
  type ModelProvider,
  modelConfigs,
  modelProviders,
  roles,
  usageRecords,
} from "../db/schema.js";
import { BadRequest, Conflict, type ModelError, NotFound } from "../errors.js";
import { secretBox } from "../security/crypto.js";
import { audit } from "./audit.js";
import { DISPATCHER, type DispatcherSetting, getSetting, LAYA_BOOTSTRAP, putSetting } from "./platform-settings.js";

export const PROTOCOLS = new Set(["openai", "anthropic", "systemone"]);
const MODEL_ID = /^\S{1,200}$/;

/** Replaced in tests to plug in scripted models. */
export let modelFactory: (model: ModelConfig, provider: ModelProvider, apiKey: string | null) => ChatModel = (
  model,
  provider,
  key,
) => buildModel(provider.protocol, provider.baseUrl, model.model, key, model.params);
export function setModelFactory(fn: typeof modelFactory): void {
  modelFactory = fn;
}
export let decisionFactory: (model: ModelConfig, provider: ModelProvider, apiKey: string | null) => DecisionModel = (
  model,
  provider,
  key,
) => new SystemOneModel(provider.baseUrl, model.model, key, model.params);
export function setDecisionFactory(fn: typeof decisionFactory): void {
  decisionFactory = fn;
}

/** A System One decision model: answers typed questions, cannot chat. */
export const isSystemOne = (p: ModelProvider | null | undefined) => p?.protocol === "systemone";

/** "provider / model" as people see it in messages and warnings. */
export const modelLabel = (model: ModelConfig, provider?: ModelProvider | null) =>
  provider ? `${provider.name} / ${model.name}` : model.name;

// --- providers ---------------------------------------------------------------------------------------------

function validateAddress(protocol: unknown, baseUrl: unknown): void {
  if (!PROTOCOLS.has(String(protocol))) throw new BadRequest(`protocol must be one of ${[...PROTOCOLS].join(", ")}`);
  const url = String(baseUrl ?? "");
  if (!url.startsWith("http://") && !url.startsWith("https://"))
    throw new BadRequest("base_url must start with http:// or https://");
}

async function providerNameTaken(db: Db, name: string, except?: string): Promise<boolean> {
  const [row] = await db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(eq(modelProviders.name, name))
    .limit(1);
  return !!row && row.id !== except;
}

export async function getProvider(db: Db, id: string): Promise<ModelProvider> {
  const [p] = await db.select().from(modelProviders).where(eq(modelProviders.id, id)).limit(1);
  if (!p) throw new NotFound("model provider not found");
  return p;
}

export async function createProvider(
  db: Db,
  data: Record<string, any>,
  createdBy: string | null,
): Promise<{ provider: ModelProvider; models: ModelConfig[] }> {
  const name = String(data.name ?? "").trim();
  if (!name) throw new BadRequest("name is required");
  const protocol = data.protocol ?? "openai";
  validateAddress(protocol, data.baseUrl);
  if (await providerNameTaken(db, name)) throw new Conflict(`model provider ${name} already exists`);
  const [provider] = await db
    .insert(modelProviders)
    .values({
      id: newId("prv"),
      name,
      protocol,
      baseUrl: String(data.baseUrl).trim(),
      apiKeyEncrypted: data.apiKey ? secretBox().encrypt(data.apiKey) : null,
      keyUpdatedAt: data.apiKey ? new Date() : null,
      createdBy,
    })
    .returning();
  const models = data.models ? await addModels(db, provider, data.models, "manual", createdBy) : [];
  return { provider, models };
}

export async function updateProvider(db: Db, p: ModelProvider, data: Record<string, any>): Promise<ModelProvider> {
  const protocol = data.protocol ?? p.protocol;
  const baseUrl = data.baseUrl !== undefined ? String(data.baseUrl).trim() : p.baseUrl;
  validateAddress(protocol, baseUrl);
  const update: Partial<ModelProvider> = { protocol, baseUrl };
  if (data.name !== undefined && String(data.name).trim() !== p.name) {
    const name = String(data.name).trim();
    if (!name) throw new BadRequest("name is required");
    if (await providerNameTaken(db, name, p.id)) throw new Conflict(`model provider ${name} already exists`);
    update.name = name;
  }
  const addressChanged = protocol !== p.protocol || baseUrl !== p.baseUrl;
  const keyGiven = data.apiKey != null;
  if (addressChanged && !keyGiven && p.apiKeyEncrypted) {
    // Never send an existing key to a new endpoint: it must be re-entered for the new address.
    update.apiKeyEncrypted = null;
    update.keyUpdatedAt = new Date();
  }
  if (keyGiven) {
    update.apiKeyEncrypted = data.apiKey ? secretBox().encrypt(data.apiKey) : null;
    update.keyUpdatedAt = new Date();
  }
  if (addressChanged || keyGiven) {
    // What the models could do was measured against the old endpoint or key.
    if (p.status !== "revoked" || keyGiven) {
      update.status = "unchecked";
      update.statusDetail = null;
    }
    await db
      .update(modelConfigs)
      .set({ status: "unchecked", capabilities: {} })
      .where(eq(modelConfigs.providerId, p.id));
  }
  const [row] = await db.update(modelProviders).set(update).where(eq(modelProviders.id, p.id)).returning();
  return row;
}

export async function revokeKey(db: Db, p: ModelProvider): Promise<ModelProvider> {
  const [row] = await db
    .update(modelProviders)
    .set({ apiKeyEncrypted: null, keyUpdatedAt: new Date(), status: "revoked" })
    .where(eq(modelProviders.id, p.id))
    .returning();
  return row;
}

export async function deleteProvider(db: Db, p: ModelProvider): Promise<void> {
  const used = await rolesUsingProvider(db, p);
  if (used.length) throw new Conflict(`models of ${p.name} are used by roles: ${used.join(", ")}`);
  await db.delete(modelProviders).where(eq(modelProviders.id, p.id));
}

const apiKeyOf = (p: ModelProvider) => (p.apiKeyEncrypted ? secretBox().decrypt(p.apiKeyEncrypted) : null);

/** Ask the provider which models it offers. Calls out over the network: run it outside a transaction. */
export async function fetchRemoteModels(db: Db, p: ModelProvider): Promise<RemoteModel[]> {
  if (p.status === "revoked") throw new BadRequest(`the key of ${p.name} has been revoked; enter a new one first`);
  try {
    const models = await listModels(p.protocol, p.baseUrl, apiKeyOf(p));
    await db
      .update(modelProviders)
      .set({ status: "ok", statusDetail: null, modelsFetchedAt: new Date() })
      .where(eq(modelProviders.id, p.id));
    return models;
  } catch (err) {
    // A self-hosted Laya server simply has no model list: not a fault of the provider.
    const noList = isSystemOne(p) && (err as ModelError).detail?.upstream_status === 404;
    if (!noList)
      await db
        .update(modelProviders)
        .set({ status: "error", statusDetail: (err as Error).message.slice(0, 500) })
        .where(eq(modelProviders.id, p.id));
    throw err;
  }
}

// --- models ------------------------------------------------------------------------------------------------

export async function getModel(db: Db, id: string): Promise<ModelConfig> {
  const [m] = await db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).limit(1);
  if (!m) throw new NotFound("model not found");
  return m;
}

/** Add models to a provider; ones it already has are skipped. Accepts ids or {model, name}. */
export async function addModels(
  db: Db,
  p: ModelProvider,
  items: unknown,
  source: "api" | "manual",
  createdBy: string | null,
): Promise<ModelConfig[]> {
  if (!Array.isArray(items) || !items.length) throw new BadRequest("models must be a non-empty list");
  const wanted = new Map<string, string>();
  for (const item of items) {
    const raw = typeof item === "string" ? { model: item } : (item as Record<string, unknown>);
    const model = String(raw?.model ?? "").trim();
    if (!MODEL_ID.test(model)) throw new BadRequest(`invalid model id ${JSON.stringify(raw?.model ?? item)}`);
    const name = String(raw?.name ?? "").trim() || model;
    if (!wanted.has(model)) wanted.set(model, name.slice(0, 200));
  }
  const added: ModelConfig[] = [];
  for (const [model, name] of wanted) {
    const rows = await db
      .insert(modelConfigs)
      .values({ id: newId("mdl"), providerId: p.id, model, name, source, createdBy })
      .onConflictDoNothing()
      .returning();
    added.push(...rows);
  }
  return added;
}

export async function updateModel(db: Db, m: ModelConfig, data: Record<string, any>): Promise<ModelConfig> {
  const update: Partial<ModelConfig> = {};
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new BadRequest("name must not be empty");
    update.name = name.slice(0, 200);
  }
  if (data.params !== undefined) {
    if (data.params === null || typeof data.params !== "object" || Array.isArray(data.params))
      throw new BadRequest("params must be an object");
    update.params = data.params;
  }
  if ("dailyTokenLimit" in data) {
    const v = data.dailyTokenLimit;
    if (v !== null && (!Number.isInteger(v) || v <= 0))
      throw new BadRequest("daily_token_limit must be a positive integer or null");
    update.dailyTokenLimit = v;
  }
  if (data.enabled !== undefined) update.enabled = !!data.enabled;
  if (!Object.keys(update).length) return m;
  const [row] = await db.update(modelConfigs).set(update).where(eq(modelConfigs.id, m.id)).returning();
  return row;
}

export async function deleteModel(db: Db, m: ModelConfig): Promise<void> {
  const used = await rolesUsing(db, m);
  if (used.length) throw new Conflict(`model ${m.name} is used by roles: ${used.join(", ")}`);
  await db.delete(modelConfigs).where(eq(modelConfigs.id, m.id));
}

/** Why a model cannot be used right now, or null if it can. */
export function unusableReason(m: ModelConfig, p: ModelProvider | null | undefined): string | null {
  if (!p) return `model ${m.name} has no provider`;
  if (p.status === "revoked") return `the key of ${p.name} has been revoked`;
  if (!m.enabled) return `model ${modelLabel(m, p)} is disabled`;
  return null;
}

/** A model together with its provider (null when either is missing). */
export async function modelWithProvider(
  db: Db,
  id: string | null | undefined,
): Promise<{ model: ModelConfig; provider: ModelProvider } | null> {
  if (!id) return null;
  const [row] = await db
    .select({ model: modelConfigs, provider: modelProviders })
    .from(modelConfigs)
    .innerJoin(modelProviders, eq(modelProviders.id, modelConfigs.providerId))
    .where(eq(modelConfigs.id, id))
    .limit(1);
  return row ?? null;
}

async function usableProvider(db: Db, m: ModelConfig): Promise<ModelProvider> {
  const provider = await getProvider(db, m.providerId);
  const reason = unusableReason(m, provider);
  if (reason) throw new BadRequest(reason);
  return provider;
}

export async function chatModelFor(db: Db, m: ModelConfig): Promise<ChatModel> {
  const provider = await usableProvider(db, m);
  if (isSystemOne(provider))
    throw new BadRequest(`${modelLabel(m, provider)} is a System One decision model: it cannot chat`);
  return modelFactory(m, provider, apiKeyOf(provider));
}

export async function decisionModelFor(db: Db, m: ModelConfig): Promise<DecisionModel> {
  const provider = await usableProvider(db, m);
  if (!isSystemOne(provider)) throw new BadRequest(`${modelLabel(m, provider)} is not a System One decision model`);
  return decisionFactory(m, provider, apiKeyOf(provider));
}

/**
 * Chat models: chat, tool calling and vision. Decision models: one question with an obvious answer.
 * Calls the model: run it outside a transaction.
 */
export async function checkModel(db: Db, m: ModelConfig): Promise<ModelConfig> {
  const provider = await getProvider(db, m.providerId);
  const caps = isSystemOne(provider)
    ? await probeDecisionModel(await decisionModelFor(db, m))
    : await probeCapabilities(await chatModelFor(db, m));
  const [row] = await db
    .update(modelConfigs)
    .set({ capabilities: caps, status: (caps.chat ?? caps.decide) ? "ok" : "error" })
    .where(eq(modelConfigs.id, m.id))
    .returning();
  return row;
}

/**
 * WITDEN_LAYA_URL (for example the optional "laya" compose service): add that Laya server as a System One
 * provider with its multilingual model, and make it the dispatcher when none is set. Done once per address,
 * so a provider deleted or a dispatcher changed afterwards stays that way.
 */
export async function bootstrapLaya(db: Db, url: string, apiKey: string | null): Promise<void> {
  const done = await getSetting<{ base_url: string }>(db, LAYA_BOOTSTRAP);
  if (done?.base_url === url) return;
  const [existing] = await db
    .select()
    .from(modelProviders)
    .where(and(eq(modelProviders.protocol, "systemone"), eq(modelProviders.baseUrl, url)))
    .limit(1);
  if (!existing) {
    const name = (await providerNameTaken(db, "Laya")) ? `Laya ${url}` : "Laya";
    const { provider, models } = await createProvider(
      db,
      { name, protocol: "systemone", baseUrl: url, apiKey, models: [{ model: "multilingual", name: "Laya 多语言" }] },
      null,
    );
    await audit(db, "model_provider.create", {
      resourceType: "model_provider",
      resourceId: provider.id,
      detail: { name, protocol: "systemone", base_url: url, models: 1, from: "WITDEN_LAYA_URL" },
    });
    const dispatcher = await getSetting<DispatcherSetting>(db, DISPATCHER);
    if (!dispatcher?.model_config_id) {
      await putSetting(db, DISPATCHER, { model_config_id: models[0].id }, null);
      await audit(db, "settings.dispatcher", { detail: { model_config_id: models[0].id, from: "WITDEN_LAYA_URL" } });
    }
  }
  await putSetting(db, LAYA_BOOTSTRAP, { base_url: url }, null);
}

// --- usage -------------------------------------------------------------------------------------------------

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

export async function rolesUsing(db: Db, m: ModelConfig): Promise<string[]> {
  return (await db.select().from(roles).where(eq(roles.modelConfigId, m.id))).map((r) => r.handle);
}

export async function rolesUsingProvider(db: Db, p: ModelProvider): Promise<string[]> {
  const ids = (
    await db.select({ id: modelConfigs.id }).from(modelConfigs).where(eq(modelConfigs.providerId, p.id))
  ).map((m) => m.id);
  if (!ids.length) return [];
  return (await db.select().from(roles).where(inArray(roles.modelConfigId, ids))).map((r) => r.handle);
}

/**
 * The model catalog: what models.dev (an open database of models and the services that offer them) says about
 * each model, so facts about models (context window, reasoning effort levels) are data an administrator
 * refreshes rather than tables in witden's code.
 *
 * The catalog is fetched whole (WITDEN_MODEL_CATALOG_URL, default https://models.dev/api.json), kept compact in
 * the one row of model_catalog, and matched to each configured model when the model is added, its provider's
 * address changes or the catalog is refreshed. The match is kept on the model (model_configs.catalog), so
 * reading a model's limits needs no lookup.
 *
 * The catalog lists makers (DeepSeek, OpenAI ...) and third parties that resell their models (OpenRouter,
 * SiliconFlow ...), often with other limits. A model is matched, in order, to:
 * 1. The entry of the service the provider is: a catalog provider with the same API host (best path match)
 *    that lists the model id. That is the maker's own data when the provider is the maker, and the third
 *    party's when the administrator chose a third party.
 * 2. Otherwise (an address the catalog does not know, such as a gateway or a proxy) the maker's entry: the
 *    provider named by the model's canonical id ("deepseek/deepseek-v4.1-flash-1017"), or for entries without
 *    one, a provider that is itself a maker. A gateway's "vendor/" prefix on the model id is ignored.
 * 3. Otherwise, when no maker lists the model, the values most services list for it.
 */
import { eq, sql } from "drizzle-orm";
import { fetchImpl } from "../agent/llm.js";
import { type Db, transaction } from "../db/client.js";
import { type ModelConfig, type ModelProvider, modelCatalog, modelConfigs, modelProviders } from "../db/schema.js";
import { BadRequest } from "../errors.js";

export const CATALOG_ID = "models.dev";
export const DEFAULT_CATALOG_URL = "https://models.dev/api.json";

export interface CatalogModel {
  name: string;
  /** "maker/model": the same model across services; null when the catalog gives none. */
  canonical: string | null;
  context: number;
  /** Prompt limit, when the catalog gives one apart from the context (OpenAI's larger models). */
  input: number | null;
  output: number | null;
  /** Reasoning effort levels; [] = the model takes none; null = not stated. */
  efforts: string[] | null;
}

export interface CatalogProvider {
  name: string;
  /** Its API address; null for services reached through their own SDK (OpenAI, Anthropic, Azure ...). */
  api: string | null;
  models: Record<string, CatalogModel>;
}

/** Catalog provider id -> provider. */
export type CatalogData = Record<string, CatalogProvider>;

/** A model's entry in the catalog, as kept on the model (model_configs.catalog, snake_case like the API). */
export interface CatalogMatch {
  /** Catalog provider id and name, e.g. "deepseek" / "DeepSeek". */
  provider: string;
  provider_name: string;
  model: string;
  name: string;
  /**
   * official: the maker's own data; third_party: the data of the third party this provider is;
   * common: no maker lists the model, so the values most services list.
   */
  basis: "official" | "third_party" | "common";
  context: number;
  input: number | null;
  output: number | null;
  efforts: string[] | null;
  fetched_at: string;
}

export interface CatalogStatus {
  /** Where refreshes fetch from; null = refreshing is turned off (WITDEN_MODEL_CATALOG_URL=off). */
  url: string | null;
  source_url: string | null;
  fetched_at: string | null;
  providers: number;
  models: number;
}

// --- reading models.dev --------------------------------------------------------------------------------------

const positive = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/** Effort levels from `reasoning_options` ({type: "effort", values}); a model without reasoning takes none. */
function effortsOf(m: Record<string, any>): string[] | null {
  if (Array.isArray(m.reasoning_options)) {
    const effort = m.reasoning_options.find((o: any) => o?.type === "effort" && Array.isArray(o.values));
    return effort ? effort.values.map(String) : [];
  }
  return m.reasoning === false ? [] : null;
}

/** models.dev's api.json -> the compact catalog; entries without a context limit are left out. */
export function compactCatalog(raw: unknown): CatalogData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new BadRequest("the model catalog is not a JSON object of providers");
  const out: CatalogData = {};
  for (const [pid, p] of Object.entries(raw as Record<string, any>)) {
    if (!p || typeof p !== "object" || !p.models || typeof p.models !== "object") continue;
    const models: Record<string, CatalogModel> = {};
    for (const [mid, m] of Object.entries(p.models as Record<string, any>)) {
      const context = positive(m?.limit?.context);
      if (!m || !context) continue;
      models[mid] = {
        name: typeof m.name === "string" ? m.name : mid,
        canonical: typeof m.canonical_model_id === "string" ? m.canonical_model_id : null,
        context,
        input: positive(m.limit.input),
        output: positive(m.limit.output),
        efforts: effortsOf(m),
      };
    }
    if (Object.keys(models).length)
      out[pid] = {
        name: typeof p.name === "string" ? p.name : pid,
        api: typeof p.api === "string" ? p.api : null,
        models,
      };
  }
  if (!Object.keys(out).length) throw new BadRequest("the model catalog lists no models");
  return out;
}

// --- matching --------------------------------------------------------------------------------------------

interface Entry {
  provider: string;
  id: string;
  model: CatalogModel;
}

interface Index {
  data: CatalogData;
  /** Providers that make models: the makers named in canonical ids. */
  makers: Set<string>;
  /** Lower-case model id -> entries, in catalog order. */
  byId: Map<string, Entry[]>;
  /** Lower-case canonical id -> entries. */
  byCanonical: Map<string, Entry[]>;
  /** Lower-case model part of a canonical id -> canonical ids. */
  canonicalOf: Map<string, string[]>;
  /** API host -> providers with their path segments. */
  byHost: Map<string, { provider: string; path: string[] }[]>;
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

function address(url: string): { host: string; path: string[] } | null {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase().replace(/^www\./, ""), path: u.pathname.split("/").filter(Boolean) };
  } catch {
    return null;
  }
}

export function indexCatalog(data: CatalogData): Index {
  const index: Index = {
    data,
    makers: new Set(),
    byId: new Map(),
    byCanonical: new Map(),
    canonicalOf: new Map(),
    byHost: new Map(),
  };
  for (const [provider, p] of Object.entries(data)) {
    const at = p.api ? address(p.api) : null;
    if (at) push(index.byHost, at.host, { provider, path: at.path });
    for (const [id, model] of Object.entries(p.models)) {
      const entry = { provider, id, model };
      push(index.byId, id.toLowerCase(), entry);
      if (model.canonical) {
        const canonical = model.canonical.toLowerCase();
        const [maker, ...rest] = canonical.split("/");
        if (data[maker]) index.makers.add(maker);
        if (!index.byCanonical.has(canonical)) push(index.canonicalOf, rest.join("/"), canonical);
        push(index.byCanonical, canonical, entry);
      }
    }
  }
  return index;
}

/** The provider that makes this entry's model, when known. */
function makerOf(index: Index, e: Entry): string | null {
  if (e.model.canonical) return e.model.canonical.toLowerCase().split("/")[0];
  return index.makers.has(e.provider) ? e.provider : null;
}

const isOfficial = (index: Index, e: Entry) => makerOf(index, e) === e.provider;

/** The entry of the catalog provider at this API address that lists the model. */
function byAddress(index: Index, baseUrl: string, modelId: string): Entry | null {
  const at = address(baseUrl);
  if (!at) return null;
  let best: { entry: Entry; score: number } | null = null;
  for (const candidate of index.byHost.get(at.host) ?? []) {
    const entry = index.byId.get(modelId.toLowerCase())?.find((e) => e.provider === candidate.provider);
    if (!entry) continue;
    // e.g. open.bigmodel.cn serves both /api/paas/v4 and /api/coding/paas/v4: the longer shared path wins.
    let score = 0;
    while (score < Math.min(at.path.length, candidate.path.length) && at.path[score] === candidate.path[score]) score++;
    if (!best || score > best.score) best = { entry, score };
  }
  return best?.entry ?? null;
}

/** Model ids to look for: as configured, and without a gateway's "vendor/" prefix. */
const idsOf = (modelId: string) => {
  const id = modelId.toLowerCase();
  const bare = id.slice(id.lastIndexOf("/") + 1);
  return bare !== id ? [id, bare] : [id];
};

/** The maker's own entry for the model. */
function byMaker(index: Index, modelId: string): Entry | null {
  for (const id of idsOf(modelId)) {
    const entries = index.byId.get(id) ?? [];
    const own = entries.find((e) => isOfficial(index, e));
    if (own) return own;
    // Listed only by third parties under this id: the maker may list the same model under another id.
    const canonicals = new Set([
      ...entries.flatMap((e) => (e.model.canonical ? [e.model.canonical.toLowerCase()] : [])),
      ...(index.canonicalOf.get(id) ?? []),
    ]);
    for (const canonical of [...canonicals].sort()) {
      const maker = canonical.split("/")[0];
      const entry = index.byCanonical.get(canonical)?.find((e) => e.provider === maker);
      if (entry) return entry;
    }
  }
  return null;
}

/** The entry with the context most services list for the model (the first such entry). */
function mostCommon(index: Index, modelId: string): Entry | null {
  for (const id of idsOf(modelId)) {
    const entries = index.byId.get(id);
    if (!entries?.length) continue;
    const counts = new Map<number, number>();
    for (const e of entries) counts.set(e.model.context, (counts.get(e.model.context) ?? 0) + 1);
    const top = Math.max(...counts.values());
    return entries.find((e) => counts.get(e.model.context) === top) ?? null;
  }
  return null;
}

/** The catalog entry for a model offered at this address (see the top of this file), or null. */
export function matchModel(index: Index, baseUrl: string, modelId: string, fetchedAt: Date): CatalogMatch | null {
  const own = byAddress(index, baseUrl, modelId);
  const maker = own ? null : byMaker(index, modelId);
  const [entry, basis]: [Entry | null, CatalogMatch["basis"]] = own
    ? [own, isOfficial(index, own) ? "official" : "third_party"]
    : maker
      ? [maker, "official"]
      : [mostCommon(index, modelId), "common"];
  if (!entry) return null;
  return {
    provider: entry.provider,
    provider_name: index.data[entry.provider].name,
    model: entry.id,
    name: entry.model.name,
    basis,
    context: entry.model.context,
    input: entry.model.input,
    output: entry.model.output,
    efforts: entry.model.efforts,
    fetched_at: fetchedAt.toISOString(),
  };
}

// --- stored catalog --------------------------------------------------------------------------------------

/** The parsed catalog of this process, until another refresh replaces the row. */
let cached: { fetchedAt: number; index: Index } | null = null;

async function loadIndex(db: Db): Promise<{ index: Index; fetchedAt: Date } | null> {
  const [head] = await db
    .select({ fetchedAt: modelCatalog.fetchedAt })
    .from(modelCatalog)
    .where(eq(modelCatalog.id, CATALOG_ID));
  if (!head) return null;
  if (cached?.fetchedAt !== head.fetchedAt.getTime()) {
    const [full] = await db.select().from(modelCatalog).where(eq(modelCatalog.id, CATALOG_ID));
    if (!full) return null;
    cached = { fetchedAt: full.fetchedAt.getTime(), index: indexCatalog(full.data as CatalogData) };
  }
  return { index: cached.index, fetchedAt: new Date(cached.fetchedAt) };
}

export async function catalogStatus(db: Db, url: string | null): Promise<CatalogStatus> {
  const [row] = await db
    .select({
      sourceUrl: modelCatalog.sourceUrl,
      fetchedAt: modelCatalog.fetchedAt,
      providers: modelCatalog.providers,
      models: modelCatalog.models,
    })
    .from(modelCatalog)
    .where(eq(modelCatalog.id, CATALOG_ID));
  return {
    url,
    source_url: row?.sourceUrl ?? null,
    fetched_at: row?.fetchedAt.toISOString() ?? null,
    providers: row?.providers ?? 0,
    models: row?.models ?? 0,
  };
}

/**
 * Match these models of a provider (all of its models when none are given) and keep what was found; returns
 * the models with it.
 */
export async function matchProviderModels(
  db: Db,
  provider: ModelProvider,
  models?: ModelConfig[],
): Promise<ModelConfig[]> {
  const found = await loadIndex(db);
  const list = models ?? (await db.select().from(modelConfigs).where(eq(modelConfigs.providerId, provider.id)));
  const out: ModelConfig[] = [];
  for (const m of list) {
    // System One decision models answer typed questions: no context window or effort applies.
    const catalog =
      found && provider.protocol !== "systemone"
        ? matchModel(found.index, provider.baseUrl, m.model, found.fetchedAt)
        : null;
    if (JSON.stringify(catalog) !== JSON.stringify(m.catalog ?? null))
      await db.update(modelConfigs).set({ catalog }).where(eq(modelConfigs.id, m.id));
    out.push({ ...m, catalog });
  }
  return out;
}

/**
 * Fetch the catalog, keep it, and match every configured model again. Calls out over the network: run it
 * outside a transaction. Returns how many models it found an entry for.
 */
export async function refreshCatalog(
  url: string,
  fetchedBy: string | null,
): Promise<{ status: CatalogStatus; matched: number; total: number }> {
  let raw: unknown;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    throw new BadRequest(`could not fetch the model catalog from ${url}: ${(err as Error).message}`);
  }
  const data = compactCatalog(raw);
  const providers = Object.keys(data).length;
  const models = Object.values(data).reduce((n, p) => n + Object.keys(p.models).length, 0);
  const fetchedAt = new Date();
  return transaction(async (tx) => {
    const values = { sourceUrl: url, data, providers, models, fetchedAt, fetchedBy };
    await tx
      .insert(modelCatalog)
      .values({ id: CATALOG_ID, ...values })
      .onConflictDoUpdate({ target: modelCatalog.id, set: values });
    // Saves reading back what was just written; keyed by time, so a rolled-back refresh is never used.
    cached = { fetchedAt: fetchedAt.getTime(), index: indexCatalog(data) };
    for (const p of await tx.select().from(modelProviders)) await matchProviderModels(tx, p);
    const [counts] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        matched: sql<number>`count(${modelConfigs.catalog})::int`,
      })
      .from(modelConfigs);
    return { status: await catalogStatus(tx, url), matched: counts.matched, total: counts.total };
  });
}

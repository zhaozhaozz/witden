/** The model catalog (models.dev): matching a configured model to the maker's or a third party's data. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setFetch } from "../src/agent/llm.js";
import { catalogWindow } from "../src/services/context-window.js";
import { compactCatalog, indexCatalog, matchModel } from "../src/services/model-catalog.js";
import { CATALOG, CATALOG_URL, catalogFetch } from "./support/catalog.js";
import { buildWorld, type World } from "./support/world.js";

const index = indexCatalog(compactCatalog(CATALOG));
const at = new Date("2026-10-19T00:00:00Z");
const match = (baseUrl: string, model: string) => matchModel(index, baseUrl, model, at);

describe("matching a model to the catalog", () => {
  it("uses the maker's data for an address the catalog does not know", () => {
    expect(match("https://llm.example/v1", "deepseek-flash")).toEqual({
      provider: "deepseek",
      provider_name: "DeepSeek",
      model: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      basis: "official",
      context: 1_000_000,
      input: null,
      output: 393_216,
      efforts: ["low", "high", "max"],
      fetched_at: at.toISOString(),
    });
    // a gateway's "vendor/" id: found through the third party's entry, answered from the maker's
    expect(match("https://llm.example/v1", "deepseek/deepseek-flash")).toMatchObject({
      provider: "deepseek",
      basis: "official",
      context: 1_000_000,
    });
    // a maker reached through its own SDK has no address in the catalog: matched by its model id
    expect(match("https://api.openai.com/v1", "gpt-6.1-sol")).toMatchObject({ provider: "openai", basis: "official" });
    expect(match("https://api.deepseek.com/v1", "deepseek-flash")).toMatchObject({ basis: "official" });
  });

  it("uses a third party's own data when the provider is that third party", () => {
    expect(match("https://openrouter.ai/api/v1", "deepseek/deepseek-flash")).toMatchObject({
      provider: "openrouter",
      basis: "third_party",
      context: 163_840,
      efforts: ["none", "high", "xhigh"],
    });
    // the third party does not list the id: the maker's data
    expect(match("https://openrouter.ai/api/v1", "deepseek-flash")).toMatchObject({ provider: "deepseek" });
    // one host, two services: the path decides
    expect(match("https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.2")).toMatchObject({
      provider: "zhipuai-coding-plan",
      basis: "third_party",
      context: 128_000,
    });
    expect(match("https://open.bigmodel.cn/api/paas/v4/", "GLM-5.2")).toMatchObject({
      provider: "zhipuai",
      basis: "official",
      context: 200_000,
    });
  });

  it("falls back to what most services list, then to nothing", () => {
    expect(match("https://llm.example/v1", "llama-3.3-70b")).toMatchObject({
      provider: "together",
      basis: "common",
      context: 131_072,
    });
    expect(match("https://llm.example/v1", "my-local-model")).toBeNull();
  });

  it("keeps limits and effort levels, and takes a prompt limit as the window", () => {
    const data = compactCatalog(CATALOG);
    expect(data.broken).toBeUndefined();
    expect(data.openai).toMatchObject({ api: null });
    // reasoning without effort options takes no level; a model without reasoning neither
    expect(
      compactCatalog({ p: { models: { a: { reasoning: true, limit: { context: 8192 } } } } }).p.models.a.efforts,
    ).toBeNull();
    expect(data.zhipuai.models["glm-5.2"].efforts).toEqual([]);
    expect(catalogWindow(match("https://llm.example/v1", "gpt-6.1-sol"))).toBe(922_000);
    expect(() => compactCatalog([])).toThrow();
    expect(() => compactCatalog({ p: { models: {} } })).toThrow();
  });
});

describe("the catalog in the console", () => {
  let w: World;
  beforeEach(async () => {
    w = await buildWorld();
  });
  afterEach(async () => {
    setFetch((...args) => fetch(...args));
    await w.close();
  });
  const admin = (method: string, url: string, json?: unknown) => w.api(method, url, { token: w.adminToken, json });
  const models = async () => (await admin("GET", "/api/models")).body as any[];

  it("is fetched by an administrator and gives every model its window and effort levels", async () => {
    // turned off (WITDEN_MODEL_CATALOG_URL=off): nothing to fetch
    expect((await admin("GET", "/api/model-catalog")).body).toMatchObject({ url: null, fetched_at: null });
    expect((await admin("POST", "/api/model-catalog/refresh")).status).toBe(400);

    w.settings.modelCatalogUrl = CATALOG_URL;
    const gateway = (
      await admin("POST", "/api/model-providers", {
        name: "Gateway",
        base_url: "https://llm.example/v1",
        api_key: "sk-gateway-0123456789",
        models: ["deepseek-flash", "glm-5.2", "my-local-model"],
      })
    ).body;
    // no catalog yet: the conservative default
    expect(gateway.models.map((m: any) => m.context.source)).toEqual(["default", "default", "default"]);

    // the service cannot be reached: the catalog stays as it was
    setFetch(async () => new Response("down", { status: 503 }));
    const failed = await admin("POST", "/api/model-catalog/refresh");
    expect(failed.status).toBe(400);
    expect(failed.body.error.message).toContain("HTTP 503");

    setFetch(catalogFetch());
    const refreshed = await admin("POST", "/api/model-catalog/refresh");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ url: CATALOG_URL, source_url: CATALOG_URL, providers: 8, models: 8 });
    expect(refreshed.body.matched).toBe(2);

    const byModel = Object.fromEntries((await models()).map((m) => [m.model, m]));
    expect(byModel["deepseek-flash"].context).toEqual({ window: 1_000_000, compact_at: 750_000, source: "catalog" });
    expect(byModel["deepseek-flash"].catalog).toMatchObject({ provider_name: "DeepSeek", basis: "official" });
    expect(byModel["deepseek-flash"].effort).toEqual({
      levels: ["low", "high", "max"],
      default: null,
      source: "catalog",
    });
    expect(byModel["glm-5.2"].effort).toEqual({ levels: [], default: null, source: "catalog" });
    expect(byModel["my-local-model"].context.source).toBe("default");
    expect(byModel["my-local-model"].effort.source).toBe("common");
    // what an administrator sets on the model still comes first
    const flash = byModel["deepseek-flash"];
    expect((await admin("PATCH", `/api/models/${flash.id}`, { context_window: 256_000 })).body.context.source).toBe(
      "model",
    );

    // models added later are matched at once; a third party's own entry when the provider is that third party
    const zhipu = (
      await admin("POST", "/api/model-providers", {
        name: "Zhipu",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        api_key: "sk-zhipu-0123456789",
        models: ["glm-5.2"],
      })
    ).body;
    expect(zhipu.models[0].catalog).toMatchObject({ provider: "zhipuai", basis: "official", context: 200_000 });
    // another address is another service
    await admin("PATCH", `/api/model-providers/${zhipu.id}`, {
      base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
    });
    const coding = (await models()).find((m) => m.id === zhipu.models[0].id);
    expect(coding.catalog).toMatchObject({ provider: "zhipuai-coding-plan", basis: "third_party" });
    expect(coding.context.window).toBe(128_000);
    expect((await admin("GET", "/api/model-catalog")).body.fetched_at).toBe(refreshed.body.fetched_at);
  });
});

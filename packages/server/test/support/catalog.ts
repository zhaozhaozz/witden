/** A small model catalog in models.dev's shape (https://models.dev/api.json): makers and third parties. */
export const CATALOG_URL = "https://catalog.test/api.json";

export const CATALOG = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    api: "https://api.deepseek.com",
    models: {
      "deepseek-flash": {
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        canonical_model_id: "deepseek/deepseek-v4.1-flash",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        limit: { context: 1_000_000, output: 393_216 },
      },
    },
  },
  // A third party: its own id for the same model, and its own limits.
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    models: {
      "deepseek/deepseek-flash": {
        id: "deepseek/deepseek-flash",
        name: "DeepSeek Flash",
        canonical_model_id: "deepseek/deepseek-v4.1-flash",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "high", "xhigh"] }],
        limit: { context: 163_840, output: 65_536 },
      },
    },
  },
  // Reached through its own SDK: no API address in the catalog.
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-6.1-sol": {
        id: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        canonical_model_id: "openai/gpt-6.1-sol",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      },
    },
  },
  // One host, two services: the path tells them apart.
  zhipuai: {
    id: "zhipuai",
    name: "Zhipu AI",
    api: "https://open.bigmodel.cn/api/paas/v4",
    models: {
      "glm-5.2": {
        id: "glm-5.2",
        name: "GLM-5.2",
        canonical_model_id: "zhipuai/glm-5.2",
        reasoning: false,
        limit: { context: 200_000, output: 131_072 },
      },
    },
  },
  "zhipuai-coding-plan": {
    id: "zhipuai-coding-plan",
    name: "Zhipu AI Coding Plan",
    api: "https://open.bigmodel.cn/api/coding/paas/v4",
    models: {
      "glm-5.2": {
        id: "glm-5.2",
        name: "GLM-5.2",
        canonical_model_id: "zhipuai/glm-5.2",
        reasoning: false,
        limit: { context: 128_000, output: 32_768 },
      },
    },
  },
  // An open model no maker in the catalog serves: third parties disagree.
  together: {
    id: "together",
    name: "Together",
    api: "https://api.together.xyz/v1",
    models: {
      "llama-3.3-70b": { id: "llama-3.3-70b", name: "Llama 3.3 70B", limit: { context: 131_072, output: 8192 } },
    },
  },
  groq: {
    id: "groq",
    name: "Groq",
    api: "https://api.groq.com/openai/v1",
    models: {
      "llama-3.3-70b": { id: "llama-3.3-70b", name: "Llama 3.3 70B", limit: { context: 32_768, output: 8192 } },
    },
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks",
    api: "https://api.fireworks.ai/inference/v1",
    models: {
      "llama-3.3-70b": { id: "llama-3.3-70b", name: "Llama 3.3 70B", limit: { context: 131_072, output: 16_384 } },
    },
  },
  // Entries without a context limit are left out.
  broken: { id: "broken", name: "Broken", models: { x: { id: "x", name: "X", limit: {} } } },
};

/** Answers the catalog URL with CATALOG; anything else goes to `rest`. */
export const catalogFetch =
  (rest: typeof fetch = async () => new Response("not found", { status: 404 })): typeof fetch =>
  async (url, init) =>
    String(url) === CATALOG_URL ? Response.json(CATALOG) : rest(url, init);

/** Reasoning effort: the levels a service reports per model, the role setting, and where requests carry it. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildModel, setFetch } from "../src/agent/llm.js";
import { withEffort } from "../src/services/effort.js";
import { setModelFactory } from "../src/services/model-configs.js";
import { reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  setFetch((...args) => fetch(...args));
  await w.close();
});

const admin = (method: string, url: string, json?: unknown) => w.api(method, url, { token: w.adminToken, json });

/** A model that passes the capability check. */
const capable = () =>
  setModelFactory(() => ({
    async complete(messages, tools) {
      if (tools?.length) return reply("", [{ id: "c1", name: tools[0].name, arguments: {} }]);
      return reply(Array.isArray(messages[0].content) ? "Red" : "OK");
    },
  }));

describe("reasoning effort", () => {
  it("takes the levels Anthropic reports for each model when its capabilities are checked", async () => {
    const p = (
      await admin("POST", "/api/model-providers", {
        name: "claude",
        protocol: "anthropic",
        base_url: "https://api.anthropic.example",
        api_key: "sk-ant-test-0123456789abcdef",
        models: ["claude-x"],
      })
    ).body;
    setFetch(async () =>
      Response.json({
        data: [
          {
            id: "claude-x",
            display_name: "Claude X",
            capabilities: {
              effort: {
                supported: true,
                low: { supported: true },
                medium: { supported: true },
                high: { supported: true },
                xhigh: { supported: false },
                max: { supported: false },
              },
            },
          },
        ],
        has_more: false,
      }),
    );
    capable();
    const checked = (await admin("POST", `/api/models/${p.models[0].id}/check`)).body;
    expect(checked.capabilities.effort).toEqual({
      levels: ["low", "medium", "high"],
      default: null,
      param: "output_config",
    });

    // a role on it may pick only those
    const refused = await admin("PATCH", `/api/roles/${w.ids.dev}`, {
      model_config_id: p.models[0].id,
      reasoning_effort: "max",
    });
    expect(refused.status).toBe(400);
    expect(refused.raw).toContain("takes effort low, medium, high, not max");
    const ok = await admin("PATCH", `/api/roles/${w.ids.dev}`, {
      model_config_id: p.models[0].id,
      reasoning_effort: "high",
      confirm: true,
    });
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.body.reasoning_effort).toBe("high");
  });

  it("reads OpenRouter-style reasoning info from an OpenAI-compatible model list", async () => {
    const p = (
      await admin("POST", "/api/model-providers", {
        name: "router",
        base_url: "https://openrouter.example/api/v1",
        api_key: "sk-or-test-0123456789",
        models: ["vendor/thinker", "vendor/plain"],
      })
    ).body;
    setFetch(async () =>
      Response.json({
        data: [
          {
            id: "vendor/thinker",
            reasoning: {
              supported_efforts: ["high", "medium", "low", "minimal"],
              default_effort: "medium",
              mandatory: true,
            },
          },
          { id: "vendor/plain" },
        ],
      }),
    );
    capable();
    const [thinker, plain] = p.models;
    expect((await admin("POST", `/api/models/${thinker.id}/check`)).body.capabilities.effort).toEqual({
      levels: ["minimal", "low", "medium", "high"],
      default: "medium",
      param: "reasoning",
    });
    // nothing reported: the common levels are offered and the service decides
    expect((await admin("POST", `/api/models/${plain.id}/check`)).body.capabilities.effort).toBeNull();
    const common = await admin("PATCH", `/api/roles/${w.ids.dev}`, {
      model_config_id: plain.id,
      reasoning_effort: "xhigh",
      confirm: true,
    });
    expect(common.status, common.raw).toBe(200);
    expect((await admin("PATCH", `/api/roles/${w.ids.dev}`, { reasoning_effort: "huge" })).status).toBe(400);
  });

  it("goes where each service takes it, with the role's model parameters", async () => {
    expect(withEffort("anthropic", {}, "high", { max_tokens: 4096 })).toEqual({
      max_tokens: 4096,
      output_config: { effort: "high" },
    });
    expect(withEffort("openai", { effort: { levels: ["low"], default: null, param: "reasoning" } }, "low", {})).toEqual(
      { reasoning: { effort: "low" } },
    );
    expect(withEffort("openai", {}, "minimal", { temperature: 1 })).toEqual({
      temperature: 1,
      reasoning_effort: "minimal",
    });

    // a task of the role sends its effort and its own model parameters (the role's settings at task creation)
    await admin("PATCH", `/api/roles/${w.ids.dev}`, {
      reasoning_effort: "high",
      model_params: { temperature: 0.2 },
      confirm: true,
    });
    const sent: Record<string, any>[] = [];
    setModelFactory((model) => {
      sent.push(model.params as Record<string, any>);
      return { complete: async () => reply("ok") };
    });
    await w.post(w.alice, w.ids.topic, "@dev hello");
    await w.drain();
    expect(sent).toEqual([{ temperature: 0.2, reasoning_effort: "high" }]);
  });
  it("reads DeepSeek's levels from its model list, and falls back to the table of known models", async () => {
    const p = (
      await admin("POST", "/api/model-providers", {
        name: "deepseek",
        base_url: "https://api.deepseek.example",
        api_key: "sk-ds-test-0123456789",
        models: ["deepseek-flash", "gpt-6.1-sol", "my-local-model"],
      })
    ).body;
    const [flash, sol, local] = p.models;
    // before any check: the table of known models, else the common levels
    const listed = (await admin("GET", "/api/models")).body;
    const effortOf = (id: string) => listed.find((m: any) => m.id === id).effort;
    expect(effortOf(flash.id)).toEqual({ levels: ["low", "high", "max"], default: "high", source: "known" });
    expect(effortOf(sol.id)).toEqual({
      levels: ["low", "medium", "high", "xhigh", "max"],
      default: "medium",
      source: "known",
    });
    expect(effortOf(local.id).source).toBe("common");
    const noNone = await admin("PATCH", `/api/roles/${w.ids.dev}`, {
      model_config_id: sol.id,
      reasoning_effort: "none",
    });
    expect(noNone.status).toBe(400);
    // checking asks the service, whose report wins
    setFetch(async () =>
      Response.json({
        data: [{ id: "deepseek-flash", effort: { supported_levels: ["low", "high", "max"], default_level: "high" } }],
      }),
    );
    capable();
    expect((await admin("POST", `/api/models/${flash.id}/check`)).body.effort).toEqual({
      levels: ["low", "high", "max"],
      default: "high",
      source: "service",
    });
  });

  it("gives a service its reasoning_content back on the next turn, and only a service that sent it", async () => {
    setModelFactory((m, provider, key) => buildModel(provider.protocol, provider.baseUrl, m.model, key, m.params));
    const bodies: any[] = [];
    const sse = (events: object[]) =>
      new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1)
        return sse([
          { choices: [{ delta: { reasoning_content: "I should run " } }] },
          { choices: [{ delta: { reasoning_content: "the command." } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "c1", function: { name: "run_command", arguments: '{"command":"echo hi"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]);
      return sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
    });
    await w.post(w.alice, w.ids.topic, "@dev run it");
    await w.drain();
    expect(bodies).toHaveLength(2);
    const assistant = bodies[1].messages.find((m: any) => m.role === "assistant");
    expect(assistant).toMatchObject({ reasoning_content: "I should run the command.", tool_calls: [{ id: "c1" }] });
    // the first request had no earlier turn to give back; nothing else carries the field
    expect(JSON.stringify(bodies[0].messages)).not.toContain("reasoning_content");
  });
});

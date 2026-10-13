/** A computer's model proxy: programs inside call a local endpoint; the platform checks and forwards. */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setFetch } from "../src/agent/llm.js";
import { db } from "../src/db/client.js";
import { usageRecords } from "../src/db/schema.js";
import type { FakeComputer } from "./support/fake-computer.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
let pc: FakeComputer;
let calls: { url: string; headers: Record<string, string>; body: any }[];

const sse = (events: unknown[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });

beforeEach(async () => {
  w = await buildWorld();
  pc = w.manager.computer(w.ids.instance);
  calls = [];
  setFetch(async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    if (String(input).endsWith("/v1/systemone"))
      return Response.json({
        model: "jev-1.13.0",
        answers: { q: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 12, output_tokens: 0 },
      });
    if (body.stream) {
      const events = String(input).endsWith("/v1/messages")
        ? [
            { type: "message_start", message: { usage: { input_tokens: 21, output_tokens: 1 } } },
            { type: "content_block_delta", delta: { text: "hi" } },
            { type: "message_delta", usage: { output_tokens: 9 } },
          ]
        : [
            { choices: [{ delta: { content: "hi" } }] },
            { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
          ];
      return new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({
      id: "r1",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
  });
});
afterEach(async () => {
  setFetch((...args) => fetch(...args));
  await w.close();
});

const admin = (method: string, url: string, json?: unknown) => w.api(method, url, { token: w.adminToken, json });

async function provider(name: string, protocol: string, baseUrl: string, models: string[]) {
  const res = await admin("POST", "/api/model-providers", {
    name,
    protocol,
    base_url: baseUrl,
    api_key: `sk-${name}-real-secret-123456`,
    models,
  });
  expect(res.status, res.raw).toBe(200);
  return res.body;
}

async function enable(modelIds: string[]) {
  const res = await admin("PUT", `/api/instances/${w.ids.instance}/model-proxy`, {
    enabled: true,
    model_ids: modelIds,
  });
  expect(res.status, res.raw).toBe(200);
  await w.waitFor(async () => pc.modelProxy?.key === res.body.key && pc.modelProxy);
  return res.body;
}

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

describe("model proxy", () => {
  it("is off until enabled; the computer gets a local port and its own key, never the provider's", async () => {
    expect(pc.modelProxy).toBeNull();
    expect((await pc.proxy("GET", "/v1/models")).status).toBe(403);
    const p = await provider("openai", "openai", "https://api.openai.example/v1", ["gpt-x"]);
    const out = await enable([p.models[0].id]);
    expect(pc.modelProxy).toEqual({ port: 8686, key: out.key, models: ["gpt-x"] });
    expect(out.key).toMatch(/^wdm_/);
    expect(out.endpoints.openai).toBe("http://127.0.0.1:8686/v1");
    expect(JSON.stringify(pc.modelProxy)).not.toContain("sk-openai");
    // the key is shown on the computer's model access page only, never in the computer listing
    const listed = (await admin("GET", `/api/instances/${w.ids.instance}`)).raw;
    expect(listed).not.toContain("model_proxy_key_encrypted");
    expect(listed).not.toContain(out.key);

    expect((await pc.proxy("GET", "/v1/models", { headers: auth("wdm_wrong") })).status).toBe(401);
    const models = await pc.proxy("GET", "/v1/models", { headers: { "x-api-key": out.key } });
    expect(models.json().data.map((m: any) => m.id)).toEqual(["gpt-x"]);
  });

  it("forwards with the real key and model id, streams the answer back and records usage", async () => {
    const p = await provider("openai", "openai", "https://api.openai.example/v1", ["gpt-x"]);
    const { key } = await enable([p.models[0].id]);
    const res = await pc.proxy("POST", "/v1/chat/completions", {
      headers: auth(key),
      body: { model: "gpt-x", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.status).toBe(200);
    expect(res.json().choices[0].message.content).toBe("ok");
    expect(calls[0].url).toBe("https://api.openai.example/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe("Bearer sk-openai-real-secret-123456");
    expect(calls[0].body.model).toBe("gpt-x");

    const stream = await pc.proxy("POST", "/v1/chat/completions", {
      headers: auth(key),
      body: { model: "gpt-x", stream: true, messages: [] },
    });
    expect(stream.headers["content-type"]).toBe("text/event-stream");
    expect(stream.text).toContain('"content":"hi"');
    expect(stream.text.trim().endsWith("data: [DONE]")).toBe(true);
    await w.waitFor(async () => (await db().select().from(usageRecords)).length === 2);
    const usage = await db().select().from(usageRecords).where(eq(usageRecords.instanceId, w.ids.instance));
    expect(usage.map((u) => [u.promptTokens, u.completionTokens, u.modelConfigId, u.taskId])).toEqual(
      expect.arrayContaining([
        [5, 2, p.models[0].id, null],
        [7, 3, p.models[0].id, null],
      ]),
    );
  });

  it("speaks the Anthropic dialect for Anthropic providers and refuses the wrong endpoint", async () => {
    const a = await provider("claude", "anthropic", "https://api.anthropic.example", ["claude-x"]);
    const o = await provider("openai", "openai", "https://api.openai.example/v1", ["gpt-x"]);
    const { key } = await enable([a.models[0].id, o.models[0].id]);
    const res = await pc.proxy("POST", "/v1/messages", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: { model: "claude-x", stream: true, max_tokens: 10, messages: [] },
    });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://api.anthropic.example/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("sk-claude-real-secret-123456");
    expect(calls[0].headers.authorization).toBeUndefined();
    await w.waitFor(async () => (await db().select().from(usageRecords)).length === 1);
    const [usage] = await db().select().from(usageRecords);
    expect([usage.promptTokens, usage.completionTokens]).toEqual([21, 9]);

    const wrong = await pc.proxy("POST", "/v1/chat/completions", { headers: auth(key), body: { model: "claude-x" } });
    expect(wrong.status).toBe(400);
    expect(wrong.json().error.message).toContain("/v1/messages");
    const missing = await pc.proxy("POST", "/v1/chat/completions", { headers: auth(key), body: { model: "other" } });
    expect(missing.status).toBe(404);
    expect(missing.json().error.message).toContain("allowed: claude-x, gpt-x");
    expect((await pc.proxy("POST", "/v1/images/generations", { headers: auth(key), body: {} })).status).toBe(404);
  });

  it("relays System One decisions (Jev, Laya) to /v1/systemone", async () => {
    const j = await provider("jev", "systemone", "https://api.typesafe.example/v1", ["jev-latest"]);
    const o = await provider("openai", "openai", "https://api.openai.example/v1", ["gpt-x"]);
    const { key } = await enable([j.models[0].id, o.models[0].id]);
    const res = await pc.proxy("POST", "/v1/systemone", {
      headers: auth(key),
      body: { model: "jev-latest", state: "charged twice", questions: { q: { type: "noul" } } },
    });
    expect(res.status).toBe(200);
    expect(res.json().answers.q.noul).toBe(0.9);
    expect(calls[0].url).toBe("https://api.typesafe.example/v1/systemone");
    expect(calls[0].headers.authorization).toBe("Bearer sk-jev-real-secret-123456");
    expect(calls[0].body).toMatchObject({ model: "jev-latest", state: "charged twice" });
    await w.waitFor(async () => (await db().select().from(usageRecords)).length === 1);
    const [usage] = await db().select().from(usageRecords);
    expect([usage.promptTokens, usage.completionTokens, usage.modelConfigId]).toEqual([12, 0, j.models[0].id]);

    const wrong = await pc.proxy("POST", "/v1/chat/completions", { headers: auth(key), body: { model: "jev-latest" } });
    expect([wrong.status, wrong.json().error.message.includes("/v1/systemone")]).toEqual([400, true]);
    const chat = await pc.proxy("POST", "/v1/systemone", { headers: auth(key), body: { model: "gpt-x" } });
    expect([chat.status, chat.json().error.message.includes("/v1/chat/completions")]).toEqual([400, true]);
  });

  it("names clashing models provider/model; limits and disabled models are enforced", async () => {
    const a = await provider("one", "openai", "https://one.example/v1", ["same"]);
    const b = await provider("two", "openai", "https://two.example/v1", ["same"]);
    const { key } = await enable([a.models[0].id, b.models[0].id]);
    expect(pc.modelProxy?.models).toEqual(["one/same", "two/same"]);
    await pc.proxy("POST", "/v1/chat/completions", { headers: auth(key), body: { model: "two/same" } });
    expect(calls[0].url).toBe("https://two.example/v1/chat/completions");
    expect(calls[0].body.model).toBe("same");

    await admin("PATCH", `/api/models/${b.models[0].id}`, { daily_token_limit: 5 });
    const limited = await pc.proxy("POST", "/v1/chat/completions", { headers: auth(key), body: { model: "two/same" } });
    expect(limited.status).toBe(429);
    await admin("PATCH", `/api/models/${a.models[0].id}`, { enabled: false });
    const off = await pc.proxy("POST", "/v1/chat/completions", { headers: auth(key), body: { model: "one/same" } });
    expect(off.status).toBe(403);
  });

  it("a new key replaces the old one at once; turning it off reaches the computer", async () => {
    const p = await provider("openai", "openai", "https://api.openai.example/v1", ["gpt-x"]);
    const { key } = await enable([p.models[0].id]);
    const rotated = (await admin("POST", `/api/instances/${w.ids.instance}/model-proxy/rotate-key`)).body;
    expect(rotated.key).not.toBe(key);
    await w.waitFor(async () => pc.modelProxy?.key === rotated.key);
    expect((await pc.proxy("GET", "/v1/models", { headers: auth(key) })).status).toBe(401);
    expect((await pc.proxy("GET", "/v1/models", { headers: auth(rotated.key) })).status).toBe(200);
    await admin("PUT", `/api/instances/${w.ids.instance}/model-proxy`, { enabled: false });
    await w.waitFor(async () => pc.modelProxy === null);
    expect((await pc.proxy("GET", "/v1/models", { headers: auth(rotated.key) })).status).toBe(403);
  });
});

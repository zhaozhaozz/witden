/** Security primitives, information-flow labels, model configurations and the model wire protocols. */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plainTitle } from "../src/agent/dispatch.js";
import { AnthropicModel, type ChatMessage, imagePart, OpenAICompatibleModel, setFetch } from "../src/agent/llm.js";
import { db } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import {
  connections,
  externalConversations,
  externalIdentities,
  externalThreadLinks,
  modelProviders,
  topicParticipants,
  topics,
} from "../src/db/schema.js";
import { ModelError } from "../src/errors.js";
import { findCredential, hashPassword, redact, SecretBox, verifyPassword } from "../src/security/crypto.js";
import { checkFlow, topicLabel, topicReaders, userLabel } from "../src/security/labels.js";
import { hasPermission, Perm } from "../src/security/permissions.js";
import { setModelFactory } from "../src/services/model-configs.js";
import { createUser } from "../src/services/users.js";
import { type Harness, reply, startHarness } from "./support/harness.js";

describe("crypto", () => {
  it("encrypts secrets and rejects a different key", () => {
    const box = new SecretBox(SecretBox.generateKey());
    const token = box.encrypt("sk-live-123");
    expect(token).not.toContain("sk-live");
    expect(box.decrypt(token)).toBe("sk-live-123");
    expect(() => new SecretBox(SecretBox.generateKey()).decrypt(token)).toThrow("master key");
  });

  it("hashes passwords and masks common secrets", () => {
    const stored = hashPassword("correct horse");
    expect(verifyPassword("correct horse", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
    const out = redact("key sk-abcdefghijklmnopqrstuvwx and xoxb-1234567890-abcdef and password=hunter2hunter");
    for (const s of ["sk-abcdef", "xoxb-123", "hunter2"]) expect(out).not.toContain(s);
    // Files are checked for credentials in known formats only, and named by prefix.
    expect(findCredential("PATH=/bin\0WITDEN_RUNNER_TOKEN=wdr_abcdefghijklmnopqrstuvwx\0")).toBe("wdr_…");
    expect(findCredential("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv")).toBe("sk-…");
    expect(findCredential("password = os.environ['DB_PASSWORD']\nsk-short")).toBeNull();
  });
});

describe("with a database", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  const topic = async (kind: string, userIds: string[]) => {
    const [t] = await db()
      .insert(topics)
      .values({ id: newId("top"), title: "t", kind })
      .returning();
    for (const id of userIds) {
      await db()
        .insert(topicParticipants)
        .values({ id: newId("tp"), topicId: t.id, participantType: "user", participantId: id });
    }
    return t;
  };

  it("console accounts may do everything; external members only use their connection's role", async () => {
    const alice = await createUser(db(), { name: "alice", email: "alice@example.com" });
    expect(alice.isAdmin).toBe(true);
    expect(await hasPermission(db(), alice, Perm.ROLE_USE, "role_x")).toBe(true);
    expect(await hasPermission(db(), alice, Perm.SECRETS_MANAGE)).toBe(true);
    const [conn] = await db()
      .insert(connections)
      .values({ id: newId("conn"), platform: "slack", name: "acme", settings: { role_id: "role_x" } })
      .returning();
    const carol = await createUser(db(), { name: "carol", externalConnectionId: conn.id });
    expect(carol.isAdmin).toBe(false);
    expect(await hasPermission(db(), carol, Perm.ROLE_USE, "role_x")).toBe(true);
    expect(await hasPermission(db(), carol, Perm.ROLE_USE, "role_y")).toBe(false);
    expect(await hasPermission(db(), carol, Perm.TOPIC_CREATE)).toBe(false);
  });

  it("inside the console material flows freely; a channel's outside members may not see a DM or private notes", async () => {
    const alice = await createUser(db(), { name: "alice", email: "a@x.io" });
    const bob = await createUser(db(), { name: "bob", email: "b@x.io" });
    const dm = await topic("dm", [alice.id]);
    const group = await topic("group", [alice.id, bob.id]);
    const flow = async (labels: string[], to: string) => checkFlow(db(), labels, await topicReaders(db(), to));
    expect((await flow([topicLabel(dm.id), userLabel(alice.id)], group.id)).allowed).toBe(true);
    // the group is mirrored into a Slack channel with carol, who has no console account
    const [conn] = await db()
      .insert(connections)
      .values({ id: newId("conn"), platform: "slack", name: "acme" })
      .returning();
    const [conv] = await db()
      .insert(externalConversations)
      .values({
        id: newId("conv"),
        connectionId: conn.id,
        externalId: "G1",
        kind: "private",
        memberIds: ["UCAROL"],
        membersSyncedAt: new Date(),
      })
      .returning();
    await db()
      .insert(externalThreadLinks)
      .values({
        id: newId("lnk"),
        connectionId: conn.id,
        conversationId: conv.id,
        threadKey: "1.0",
        topicId: group.id,
      });
    const decision = await flow([topicLabel(dm.id), topicLabel(group.id)], group.id);
    expect(decision.allowed).toBe(false);
    expect(decision.blockedLabels).toEqual([topicLabel(dm.id)]);
    expect((await flow([userLabel(alice.id)], group.id)).allowed).toBe(false);
    // the channel's own content may go back to the console DM
    expect((await flow([topicLabel(group.id)], dm.id)).allowed).toBe(true);
  });

  it("public and private Slack channels; unknown membership and labels fail closed", async () => {
    const alice = await createUser(db(), { name: "alice", email: "a@x.io" });
    const [conn] = await db()
      .insert(connections)
      .values({ id: newId("conn"), platform: "slack", name: "acme" })
      .returning();
    await db()
      .insert(externalIdentities)
      .values({ id: newId("ext"), connectionId: conn.id, externalUserId: "UALICE", userId: alice.id });
    const [pub] = await db()
      .insert(externalConversations)
      .values({ id: newId("conv"), connectionId: conn.id, externalId: "C1", kind: "public" })
      .returning();
    const [priv] = await db()
      .insert(externalConversations)
      .values({
        id: newId("conv"),
        connectionId: conn.id,
        externalId: "G1",
        kind: "private",
        memberIds: ["UALICE"],
        membersSyncedAt: new Date(),
      })
      .returning();
    const tPublic = await topic("group", []);
    const tPrivate = await topic("group", []);
    for (const [conv, key, t] of [
      [pub, "1.0", tPublic],
      [priv, "2.0", tPrivate],
    ] as const) {
      await db()
        .insert(externalThreadLinks)
        .values({ id: newId("lnk"), connectionId: conn.id, conversationId: conv.id, threadKey: key, topicId: t.id });
    }
    const flow = async (labels: string[], to: string) =>
      (await checkFlow(db(), labels, await topicReaders(db(), to))).allowed;
    // private channel (only alice) -> public channel: blocked; public -> private channel of workspace members: allowed
    expect(await flow([topicLabel(tPrivate.id)], tPublic.id)).toBe(false);
    expect(await flow([topicLabel(tPublic.id)], tPrivate.id)).toBe(true);
    // unknown membership counts as the whole workspace
    await db()
      .update(externalConversations)
      .set({ membersSyncedAt: null })
      .where(eq(externalConversations.id, priv.id));
    expect(await flow([userLabel(alice.id)], tPrivate.id)).toBe(false);
    expect(await flow(["mystery:1"], tPrivate.id)).toBe(false);
  });

  it("login and /me", async () => {
    const me = (await h.api("GET", "/api/auth/me", { token: h.adminToken })).body;
    expect(me.is_admin).toBe(true);
    expect(me.permissions).toContain("secrets.manage");
    expect((await h.api("GET", "/api/auth/me")).status).toBe(401);
    const bad = await h.api("POST", "/api/auth/login", { json: { email: "admin@example.com", password: "nope" } });
    expect(bad.status).toBe(401);
  });

  describe("model providers", () => {
    const admin = (method: string, url: string, json?: unknown) => h.api(method, url, { token: h.adminToken, json });
    const create = async (extra: Record<string, unknown> = {}) => {
      const res = await admin("POST", "/api/model-providers", {
        name: "local",
        base_url: "http://llm.local/v1",
        api_key: "sk-secret-value-123456",
        ...extra,
      });
      expect(res.status, res.raw).toBe(200);
      return res.body;
    };
    afterEach(() => setFetch((...args) => fetch(...args)));

    it("keys are encrypted at rest and never returned; revoking makes its models unusable", async () => {
      const p = await create({ models: ["qwen"] });
      expect(p.has_api_key).toBe(true);
      expect(JSON.stringify(p)).not.toContain("sk-secret");
      expect((await admin("GET", "/api/model-providers")).raw).not.toContain("sk-secret");
      const [stored] = await db().select().from(modelProviders).where(eq(modelProviders.id, p.id));
      expect(stored.apiKeyEncrypted).not.toContain("sk-secret");
      const revoked = (await admin("POST", `/api/model-providers/${p.id}/revoke-key`)).body;
      expect(revoked.status).toBe("revoked");
      expect(revoked.has_api_key).toBe(false);
      const [model] = (await admin("GET", "/api/models")).body;
      expect(model.usable).toBe(false);
      expect((await admin("GET", "/api/audit")).raw).not.toContain("sk-secret");
    });

    it("lists an OpenAI-compatible provider's models; picked and hand-entered models are added once", async () => {
      const p = await create();
      let seen: { url: string; auth: string | null } | null = null;
      setFetch(async (input, init) => {
        seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
        return Response.json({ object: "list", data: [{ id: "qwen-max" }, { id: "qwen-plus" }, { id: "embed-1" }] });
      });
      const remote = (await admin("GET", `/api/model-providers/${p.id}/remote-models`)).body;
      expect(seen).toEqual({ url: "http://llm.local/v1/models", auth: "Bearer sk-secret-value-123456" });
      expect(remote.models.map((m: any) => m.id)).toEqual(["embed-1", "qwen-max", "qwen-plus"]);
      const added = (
        await admin("POST", `/api/model-providers/${p.id}/models`, {
          models: [{ model: "qwen-max" }, { model: "qwen-plus", name: "Qwen Plus" }],
          source: "api",
        })
      ).body;
      expect(added.added.map((m: any) => [m.model, m.name, m.source])).toEqual([
        ["qwen-max", "qwen-max", "api"],
        ["qwen-plus", "Qwen Plus", "api"],
      ]);
      const again = (
        await admin("POST", `/api/model-providers/${p.id}/models`, { models: ["qwen-max", "my-finetune"] })
      ).body;
      expect(again.added.map((m: any) => [m.model, m.source])).toEqual([["my-finetune", "manual"]]);
      expect(again.skipped).toBe(1);
      expect((await admin("POST", `/api/model-providers/${p.id}/models`, { models: ["has space"] })).status).toBe(400);
      const listed = (await admin("GET", `/api/model-providers/${p.id}/remote-models`)).body.models;
      expect(listed.filter((m: any) => m.added).map((m: any) => m.id)).toEqual(["qwen-max", "qwen-plus"]);
      const provider = (await admin("GET", "/api/model-providers")).body.find((x: any) => x.id === p.id);
      expect(provider.status).toBe("ok");
      expect(provider.models.map((m: any) => m.label)).toEqual([
        "local / my-finetune",
        "local / qwen-max",
        "local / Qwen Plus",
      ]);
    });

    it("lists Anthropic models page by page; a failing list is visible on the provider", async () => {
      const p = await create({ name: "claude", protocol: "anthropic", base_url: "https://api.anthropic.example" });
      const urls: string[] = [];
      setFetch(async (input, init) => {
        const url = new URL(String(input));
        urls.push(url.pathname + url.search);
        expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-secret-value-123456");
        return url.searchParams.get("after_id")
          ? Response.json({
              data: [{ id: "model-b", display_name: "Model B", max_input_tokens: 1_000_000 }],
              has_more: false,
            })
          : Response.json({ data: [{ id: "model-a", display_name: "Model A" }], has_more: true, last_id: "model-a" });
      });
      const remote = (await admin("GET", `/api/model-providers/${p.id}/remote-models`)).body;
      // The context window when the service reports it (Anthropic: max_input_tokens).
      expect(remote.models).toEqual([
        { id: "model-a", name: "Model A", added: false, context_window: null },
        { id: "model-b", name: "Model B", added: false, context_window: 1_000_000 },
      ]);
      expect(urls).toEqual(["/v1/models?limit=1000", "/v1/models?limit=1000&after_id=model-a"]);
      setFetch(async () => new Response("invalid x-api-key", { status: 401 }));
      const failed = await admin("GET", `/api/model-providers/${p.id}/remote-models`);
      expect(failed.status).toBe(503);
      const after = (await admin("GET", "/api/model-providers")).body.find((x: any) => x.id === p.id);
      expect(after.status).toBe("error");
      expect(after.status_detail).toContain("HTTP 401");
    });

    it("capability check runs per model; a new key or address puts its models back to unchecked", async () => {
      const p = await create({ models: ["qwen"] });
      const id = p.models[0].id;
      setModelFactory(() => ({
        async complete(messages, tools) {
          if (tools?.length) return reply("", [{ id: "c1", name: tools[0].name, arguments: {} }]);
          return reply(Array.isArray(messages[0].content) ? "Red" : "OK");
        },
      }));
      const ok = (await admin("POST", `/api/models/${id}/check`)).body;
      expect(ok.status).toBe("ok");
      expect(ok.capabilities).toMatchObject({ chat: true, tools: true, vision: true });
      setModelFactory(() => ({ complete: async () => reply("I cannot see images") }));
      const weak = (await admin("POST", `/api/models/${id}/check`)).body;
      expect(weak.capabilities.tools).toBe(false);
      expect(weak.capabilities.errors.tools).toContain("without calling the tool");
      await admin("PATCH", `/api/model-providers/${p.id}`, { api_key: "sk-another-key-7654321" });
      const [model] = (await admin("GET", "/api/models")).body;
      expect([model.status, model.capabilities]).toEqual(["unchecked", {}]);
    });

    it("models in use cannot be deleted; a disabled model is not usable", async () => {
      const p = await create({ models: ["a", "b"] });
      const [a, b] = p.models;
      await admin("POST", "/api/roles", { name: "R", handle: "r", model_config_id: a.id });
      expect((await admin("DELETE", `/api/models/${a.id}`)).status).toBe(409);
      expect((await admin("DELETE", `/api/model-providers/${p.id}`)).status).toBe(409);
      expect(
        (await admin("PATCH", `/api/models/${b.id}`, { enabled: false, daily_token_limit: 1000 })).body,
      ).toMatchObject({ enabled: false, daily_token_limit: 1000, usable: false });
      expect((await admin("DELETE", `/api/models/${b.id}`)).status).toBe(200);
    });

    it("rejects invalid endpoints and protocols", async () => {
      expect((await admin("POST", "/api/model-providers", { name: "x", base_url: "ftp://bad" })).status).toBe(400);
      expect(
        (await admin("POST", "/api/model-providers", { name: "x", base_url: "http://a", protocol: "x" })).status,
      ).toBe(400);
    });
  });
});

describe("model protocols", () => {
  const TOOLS = [{ name: "run_command", description: "run", parameters: { type: "object", properties: {} } }];
  let seen: { url: string; headers: Record<string, string>; body: any };
  const respond = (status: number, payload: unknown) =>
    setFetch(async (input, init) => {
      seen = {
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      };
      return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
    });
  afterEach(() => setFetch((...args) => fetch(...args)));

  it("OpenAI-compatible: tool calls with string or object arguments, usage, params", async () => {
    respond(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { function: { name: "run_command", arguments: { command: "ls" } } }, // Ollama style: object, no id
              { id: "c2", function: { name: "run_command", arguments: '{"command": "pwd"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });
    const model = new OpenAICompatibleModel("http://llm.local/v1/", "qwen", "sk-test-key-1234567890", {
      temperature: 0.2,
    });
    const res = await model.complete([{ role: "user", content: "hi" }], TOOLS);
    expect(seen.url).toBe("http://llm.local/v1/chat/completions");
    expect(seen.headers.authorization).toBe("Bearer sk-test-key-1234567890");
    expect(seen.body.tools[0]).toEqual({ type: "function", function: TOOLS[0] });
    expect(seen.body.temperature).toBe(0.2);
    expect(res.toolCalls.map((c) => c.arguments)).toEqual([{ command: "ls" }, { command: "pwd" }]);
    expect(res.toolCalls[0].id).toMatch(/^call_/);
    expect([res.promptTokens, res.completionTokens]).toEqual([11, 7]);
  });

  it("HTTP errors become model errors", async () => {
    respond(401, "invalid api key");
    await expect(
      new OpenAICompatibleModel("http://llm/v1", "m", null, {}).complete([{ role: "user", content: "x" }]),
    ).rejects.toThrow(ModelError);
  });

  it("Anthropic: system prompt, tool results grouped in one user turn, images", async () => {
    respond(200, {
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", id: "tu1", name: "run_command", input: { command: "ls" } },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: "tool_use",
    });
    const messages: ChatMessage[] = [
      { role: "system", content: "You are @dev" },
      { role: "user", content: "check" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a1", type: "function", function: { name: "screenshot", arguments: "{}" } },
          { id: "a2", type: "function", function: { name: "run_command", arguments: '{"command": "pwd"}' } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "a1",
        content: [{ type: "text", text: "screen" }, imagePart(Buffer.from("\x89PNG\r\n\x1a\nfake", "latin1"))],
      },
      { role: "tool", tool_call_id: "a2", content: "/workspace" },
    ];
    const res = await new AnthropicModel(
      "https://api.anthropic.com",
      "model-x",
      "sk-ant-test-123456789012",
      {},
    ).complete(messages, TOOLS);
    const body = seen.body;
    expect(seen.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen.headers["x-api-key"]).toBe("sk-ant-test-123456789012");
    // Cache breakpoints after the system prompt and on the last block: the next call reads both from the cache.
    expect(body.system).toEqual([{ type: "text", text: "You are @dev", cache_control: { type: "ephemeral" } }]);
    expect(body.tools[0].input_schema).toEqual(TOOLS[0].parameters);
    expect(body.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    const results = body.messages[2].content;
    expect(results.map((r: any) => r.tool_use_id)).toEqual(["a1", "a2"]);
    expect(results[1].cache_control).toEqual({ type: "ephemeral" });
    expect(results[0].cache_control).toBeUndefined();
    expect(results[0].content[1].type).toBe("image");
    expect(body.messages[1].content[1]).toEqual({
      type: "tool_use",
      id: "a2",
      name: "run_command",
      input: { command: "pwd" },
    });
    expect(res.content).toBe("looking");
    expect(res.toolCalls[0].arguments).toEqual({ command: "ls" });
  });

  it("Anthropic: prompt tokens include what the cache served; a gateway that rejects cache_control is asked again without", async () => {
    const bodies: any[] = [];
    setFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (JSON.stringify(body).includes("cache_control"))
        return new Response('{"error":"Extra inputs are not permitted: cache_control"}', { status: 400 });
      return Response.json({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 4 },
      });
    });
    const model = new AnthropicModel("https://gw.example", "claude-x", null, {});
    const res = await model.complete([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect([res.promptTokens, res.cachedTokens, res.completionTokens]).toEqual([330, 300, 4]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].system).toBe("sys");
    expect(bodies[1].messages).toEqual([{ role: "user", content: "hi" }]);
    // Not asked with cache_control again.
    await model.complete([{ role: "user", content: "again" }]);
    expect(bodies).toHaveLength(3);
  });

  it("OpenAI-compatible: cached prompt tokens from prompt_tokens_details or DeepSeek's field", async () => {
    for (const usage of [
      { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } },
      { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 },
    ]) {
      setFetch(async () => Response.json({ choices: [{ message: { content: "ok" } }], usage }));
      const res = await new OpenAICompatibleModel("http://llm/v1", "m", null, {}).complete([
        { role: "user", content: "x" },
      ]);
      expect([res.promptTokens, res.cachedTokens]).toEqual([100, 64]);
    }
  });

  /** An event-stream response delivered in awkward pieces (split mid-line and mid-character). */
  const streamed = (events: unknown[], requests: any[]) =>
    setFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { content: "plain" } }] }));
      const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\r\n\r\n`).join("");
      const bytes = new TextEncoder().encode(text);
      return new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      );
    });

  it("OpenAI-compatible streaming: text deltas, tool calls in pieces, usage from the last chunk", async () => {
    const requests: any[] = [];
    streamed(
      [
        { choices: [{ delta: { role: "assistant", content: "先看" } }] },
        { choices: [{ delta: { content: "一下目录" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "run_", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "command", arguments: '{"comm' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and": "ls"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
        "[DONE]",
      ],
      requests,
    );
    const pieces: string[] = [];
    const model = new OpenAICompatibleModel("http://llm/v1", "m", null, {});
    const res = await model.complete([{ role: "user", content: "hi" }], TOOLS, (t) => pieces.push(t));
    expect(requests[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(pieces).toEqual(["先看", "一下目录"]);
    expect(res.content).toBe("先看一下目录");
    expect(res.toolCalls).toMatchObject([{ id: "c1", name: "run_command", arguments: { command: "ls" } }]);
    expect([res.promptTokens, res.completionTokens, res.finishReason]).toEqual([9, 4, "tool_calls"]);
    // Nobody listening: a plain request, as before.
    expect((await model.complete([{ role: "user", content: "hi" }])).content).toBe("plain");
    expect(requests[1].stream).toBeUndefined();
  });

  it("an endpoint that refuses streaming is asked again without it", async () => {
    const requests: any[] = [];
    setFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return body.stream
        ? new Response("unknown field stream_options", { status: 400 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    const model = new OpenAICompatibleModel("http://llm/v1", "m", null, {});
    expect((await model.complete([{ role: "user", content: "x" }], undefined, () => {})).content).toBe("ok");
    expect((await model.complete([{ role: "user", content: "x" }], undefined, () => {})).content).toBe("ok");
    expect(requests.map((r) => !!r.stream)).toEqual([true, false, false]);
  });

  it("the capability check records the response time", async () => {
    const { probeCapabilities } = await import("../src/agent/llm.js");
    respond(200, { choices: [{ message: { content: "OK" } }] });
    const caps = await probeCapabilities(new OpenAICompatibleModel("http://llm/v1", "m", null, {}));
    expect(caps.chat).toBe(true);
    expect(typeof caps.latency_ms).toBe("number");
  });

  it("System One (Jev, Laya): typed questions about a state; a key only when one is set", async () => {
    const { SystemOneModel, probeDecisionModel } = await import("../src/agent/systemone.js");
    respond(200, {
      model: "jev-1.13.0",
      answers: {
        team: { type: "choice", choice: "billing", probabilities: { billing: 0.95, tech: 0.05 }, confidence: 0.9 },
      },
      usage: { input_tokens: 42, output_tokens: 0 },
    });
    const jev = new SystemOneModel("https://api.typesafe.ai/v1/", "jev-latest", "k", {});
    const res = await jev.decide("charged twice", {
      team: { type: "choice", criteria: { billing: "refunds", tech: "bugs" } },
    });
    expect(seen.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen.headers.authorization).toBe("Bearer k");
    expect(seen.body).toMatchObject({
      model: "jev-latest",
      state: "charged twice",
      questions: { team: { type: "choice" } },
    });
    expect(res).toMatchObject({ model: "jev-1.13.0", inputTokens: 42, outputTokens: 0 });
    expect(res.answers.team.choice).toBe("billing");

    // a self-hosted Laya without LAYA_API_KEY takes no key; params such as max_len go into the body
    const laya = new SystemOneModel("http://laya:8000", "multilingual", null, { max_len: 2048 });
    const caps = await probeDecisionModel(laya);
    expect(seen.url).toBe("http://laya:8000/v1/systemone");
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.body.max_len).toBe(2048);
    expect(caps.decide).toBe(true);
    expect(typeof caps.latency_ms).toBe("number");

    respond(200, { model: "x", answers: {}, usage: {} });
    await expect(laya.decide("s", { q: { type: "noul" } })).rejects.toThrow(/did not answer "q"/);
  });

  it("System One model lists: Jev offers one, a Laya server has none", async () => {
    const { listModels } = await import("../src/agent/llm.js");
    const urls: string[] = [];
    setFetch(async (input) => {
      urls.push(String(input));
      return String(input).startsWith("https://api.typesafe.ai")
        ? Response.json({ models: [{ name: "jev-latest", description: "flagship" }, { name: "jev-1.13.0" }] })
        : new Response('{"detail":"Not Found"}', { status: 404 });
    });
    const listed = await listModels("systemone", "https://api.typesafe.ai", "k");
    expect(listed.map((m) => m.id)).toEqual(["jev-1.13.0", "jev-latest"]);
    await expect(listModels("systemone", "http://laya:8000/v1", null)).rejects.toThrow(/add them by name/);
    expect(urls).toEqual(["https://api.typesafe.ai/v1/models", "http://laya:8000/v1/models"]);
  });

  it("a stream that reports an error fails the call", async () => {
    streamed([{ error: { message: "context too long" } }], []);
    await expect(
      new OpenAICompatibleModel("http://llm/v1", "m", null, {}).complete(
        [{ role: "user", content: "x" }],
        undefined,
        () => {},
      ),
    ).rejects.toThrow(/context too long/);
  });

  it("Anthropic streaming: text and tool-input deltas per content block", async () => {
    const requests: any[] = [];
    streamed(
      [
        { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
        { type: "ping" },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tu1", name: "run_command", input: {} },
        },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' "pwd"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
        { type: "message_stop" },
      ],
      requests,
    );
    const pieces: string[] = [];
    const res = await new AnthropicModel("https://api.anthropic.com", "x", "k", {}).complete(
      [{ role: "user", content: "hi" }],
      TOOLS,
      (t) => pieces.push(t),
    );
    expect(requests[0].stream).toBe(true);
    expect(pieces.join("")).toBe("Let me check.");
    expect(res.content).toBe("Let me check.");
    expect(res.toolCalls).toEqual([{ id: "tu1", name: "run_command", arguments: { command: "pwd" } }]);
    expect([res.promptTokens, res.completionTokens, res.finishReason]).toEqual([12, 20, "tool_use"]);
  });
});

describe("task titles from Markdown messages", () => {
  it("take the first meaningful line without Markdown marks", () => {
    expect(plainTitle("## 发布清单\n\n请看一下")).toBe("发布清单");
    expect(plainTitle("- [ ] 更新 **CHANGELOG**")).toBe("更新 CHANGELOG");
    expect(plainTitle("> 引用 [任务](/tasks) 和 `npm test`")).toBe("引用 任务 和 npm test");
    expect(plainTitle("```bash\nnpm ci\n```")).toBe("npm ci");
    expect(plainTitle("@dev 看看 ![图](x.png)")).toBe("@dev 看看 图");
  });
});

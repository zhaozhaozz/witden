/** Security primitives, information-flow labels, model configurations and the model wire protocols. */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { hashPassword, redact, SecretBox, verifyPassword } from "../src/security/crypto.js";
import { checkFlow, topicLabel, topicReaders, userLabel } from "../src/security/labels.js";
import { grant, hasPermission, Perm } from "../src/security/permissions.js";
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
      .values({ id: newId("top"), title: "t", kind, visibility: "private" })
      .returning();
    for (const id of userIds) {
      await db()
        .insert(topicParticipants)
        .values({ id: newId("tp"), topicId: t.id, participantType: "user", participantId: id });
    }
    return t;
  };

  it("permissions are deny-by-default and resource-scoped", async () => {
    const alice = await createUser(db(), { name: "alice", email: "alice@example.com" });
    expect(await hasPermission(db(), alice, Perm.ROLE_USE, "role_x")).toBe(false);
    await grant(db(), Perm.ROLE_USE, { userId: alice.id, resourceId: "role_x" });
    expect(await hasPermission(db(), alice, Perm.ROLE_USE, "role_x")).toBe(true);
    expect(await hasPermission(db(), alice, Perm.ROLE_USE, "role_y")).toBe(false);
    // baseline grant created at bootstrap
    expect(await hasPermission(db(), alice, Perm.TOPIC_CREATE)).toBe(true);
  });

  it("DM content cannot flow into a group; private memory stays with its owner", async () => {
    const alice = await createUser(db(), { name: "alice", email: "a@x.io" });
    const bob = await createUser(db(), { name: "bob", email: "b@x.io" });
    const dm = await topic("dm", [alice.id]);
    const group = await topic("group", [alice.id, bob.id]);
    const toGroup = await topicReaders(db(), group.id);
    const decision = await checkFlow(db(), [topicLabel(dm.id), topicLabel(group.id)], toGroup);
    expect(decision.allowed).toBe(false);
    expect(decision.blockedLabels).toEqual([topicLabel(dm.id)]);
    expect((await checkFlow(db(), [topicLabel(group.id)], await topicReaders(db(), dm.id))).allowed).toBe(true);
    expect((await checkFlow(db(), [userLabel(alice.id)], await topicReaders(db(), dm.id))).allowed).toBe(true);
    expect((await checkFlow(db(), [userLabel(alice.id)], toGroup)).allowed).toBe(false);
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
          ? Response.json({ data: [{ id: "model-b", display_name: "Model B" }], has_more: false })
          : Response.json({ data: [{ id: "model-a", display_name: "Model A" }], has_more: true, last_id: "model-a" });
      });
      const remote = (await admin("GET", `/api/model-providers/${p.id}/remote-models`)).body;
      expect(remote.models).toEqual([
        { id: "model-a", name: "Model A", added: false },
        { id: "model-b", name: "Model B", added: false },
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

    it("models in use cannot be deleted; members only see models they may use", async () => {
      const p = await create({ models: ["a", "b"] });
      const [a, b] = p.models;
      await admin("POST", "/api/roles", { name: "R", handle: "r", model_config_id: a.id });
      expect((await admin("DELETE", `/api/models/${a.id}`)).status).toBe(409);
      expect((await admin("DELETE", `/api/model-providers/${p.id}`)).status).toBe(409);
      expect(
        (await admin("PATCH", `/api/models/${b.id}`, { enabled: false, daily_token_limit: 1000 })).body,
      ).toMatchObject({ enabled: false, daily_token_limit: 1000, usable: false });
      const bob = await createUser(db(), { name: "bob", email: "bob@x.io", password: "bob-pass-123" });
      await grant(db(), Perm.MODEL_USE, { userId: bob.id, resourceId: a.id });
      const token = await h.login("bob@x.io", "bob-pass-123");
      const seen = (await h.api("GET", "/api/model-providers", { token })).body;
      expect(seen).toEqual([
        {
          id: p.id,
          name: "local",
          protocol: "openai",
          status: "unchecked",
          models: [expect.objectContaining({ id: a.id })],
        },
      ]);
      expect((await h.api("GET", `/api/model-providers/${p.id}/remote-models`, { token })).status).toBe(403);
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
    expect(body.system).toBe("You are @dev");
    expect(body.tools[0].input_schema).toEqual(TOOLS[0].parameters);
    expect(body.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    const results = body.messages[2].content;
    expect(results.map((r: any) => r.tool_use_id)).toEqual(["a1", "a2"]);
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
});

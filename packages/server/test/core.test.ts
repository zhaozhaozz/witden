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
  modelConfigs,
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

  describe("model configs", () => {
    const create = async () => {
      const res = await h.api("POST", "/api/model-configs", {
        token: h.adminToken,
        json: { name: "local", base_url: "http://llm.local/v1", model: "qwen", api_key: "sk-secret-value-123456" },
      });
      expect(res.status, res.raw).toBe(200);
      return res.body;
    };

    it("keys are encrypted at rest and never returned", async () => {
      const cfg = await create();
      expect(cfg.has_api_key).toBe(true);
      expect(JSON.stringify(cfg)).not.toContain("sk-secret");
      expect((await h.api("GET", "/api/model-configs", { token: h.adminToken })).raw).not.toContain("sk-secret");
      const [stored] = await db().select().from(modelConfigs).where(eq(modelConfigs.id, cfg.id));
      expect(stored.apiKeyEncrypted).not.toContain("sk-secret");
      const revoked = (await h.api("POST", `/api/model-configs/${cfg.id}/revoke-key`, { token: h.adminToken })).body;
      expect(revoked.status).toBe("revoked");
      expect(revoked.has_api_key).toBe(false);
      expect((await h.api("GET", "/api/audit", { token: h.adminToken })).raw).not.toContain("sk-secret");
    });

    it("capability check probes chat, tool calling and vision", async () => {
      const cfg = await create();
      setModelFactory(() => ({
        async complete(messages, tools) {
          if (tools?.length) return reply("", [{ id: "c1", name: tools[0].name, arguments: {} }]);
          return reply(Array.isArray(messages[0].content) ? "Red" : "OK");
        },
      }));
      const ok = (await h.api("POST", `/api/model-configs/${cfg.id}/check`, { token: h.adminToken })).body;
      expect(ok.status).toBe("ok");
      expect(ok.capabilities).toMatchObject({ chat: true, tools: true, vision: true });
      setModelFactory(() => ({ complete: async () => reply("I cannot see images") }));
      const weak = (await h.api("POST", `/api/model-configs/${cfg.id}/check`, { token: h.adminToken })).body;
      expect(weak.capabilities.tools).toBe(false);
      expect(weak.capabilities.errors.tools).toContain("without calling the tool");
      expect(weak.capabilities.vision).toBe(false);
    });

    it("rejects invalid endpoints", async () => {
      const res = await h.api("POST", "/api/model-configs", {
        token: h.adminToken,
        json: { name: "x", base_url: "ftp://bad", model: "m" },
      });
      expect(res.status).toBe(400);
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

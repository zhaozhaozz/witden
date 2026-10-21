/**
 * How roles respond in a topic: only when really @-mentioned (default), or automatically — the only role
 * decides itself, several roles go through the dispatcher.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setFetch } from "../src/agent/llm.js";
import { db } from "../src/db/client.js";
import { messageRoutes, topics, usageRecords } from "../src/db/schema.js";
import { call, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

const say = (token: string, topicId: string, content: string, mentions?: { type: string; id: string }[]) =>
  w.api("POST", `/api/topics/${topicId}/messages`, { token, json: mentions ? { content, mentions } : { content } });
const tasksIn = async (topicId: string) =>
  (await w.api("GET", `/api/tasks?topic_id=${topicId}`, { token: w.alice })).body as any[];
const LAYA = "http://laya.test:8000";

/**
 * A System One service (as a self-hosted Laya serves it). The dispatcher's "who" question goes to the handles
 * ``pick`` names — the first most likely, the others less so — or to nobody; other choice questions get their
 * first option. Returns the new model's id and the requests it received.
 */
async function decisionService(pick: (latest: string) => string[] = () => []) {
  const requests: { body: any; headers: Headers }[] = [];
  setFetch(async (input, init) => {
    if (String(input) !== `${LAYA}/v1/systemone`) return new Response('{"detail":"Not Found"}', { status: 404 });
    const body = JSON.parse(String(init?.body));
    requests.push({ body, headers: new Headers(init?.headers) });
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries<any>(body.questions)) {
      if (name !== "who") {
        answers[name] = { type: "choice", choice: Object.keys(q.criteria)[0], probabilities: {}, confidence: 0.8 };
        continue;
      }
      const [top, ...also] = pick(String(body.state));
      const probabilities: Record<string, number> = Object.fromEntries(Object.keys(q.criteria).map((k) => [k, 0.02]));
      if (top) probabilities[top] = 0.6;
      else probabilities.nobody = 0.9;
      for (const h of also) probabilities[h] = 0.35;
      answers.who = { type: "choice", choice: top ?? "nobody", probabilities, confidence: 0.7 };
    }
    return Response.json({ model: "laya-rl-agent", answers, usage: { input_tokens: 40, output_tokens: 0 } });
  });
  const provider = await w.api("POST", "/api/model-providers", {
    token: w.adminToken,
    json: { name: "Laya", protocol: "systemone", base_url: LAYA, api_key: "laya-key", models: ["multilingual"] },
  });
  return { id: provider.body.models[0].id as string, requests };
}

/** An ordinary chat model for the dispatcher, apart from the roles' model (its answers: scripts.dispatcher). */
async function chatDispatcherModel() {
  const provider = await w.api("POST", "/api/model-providers", {
    token: w.adminToken,
    json: {
      name: "Fast",
      protocol: "openai",
      base_url: "https://fast.example/v1",
      api_key: "sk-fast-1234567890",
      models: ["fast-chat"],
    },
  });
  return provider.body.models[0].id as string;
}

describe("mention mode (default)", () => {
  it("only a real @ starts work: picked in the composer, or sent by a role's message_role", async () => {
    expect((await w.api("GET", `/api/topics/${w.ids.topic}`, { token: w.alice })).body.response_mode).toBe("mention");
    await say(w.alice, w.ids.topic, "大家早上好");
    // the console sends the mentions people picked; text that merely contains "@dev" is not one
    await say(w.alice, w.ids.topic, "刚刚 @dev 说了，那么明天发布", []);
    await w.drain();
    expect(await tasksIn(w.ids.topic)).toHaveLength(0);

    w.scripts.dev = (_m, turn) =>
      turn === 0
        ? reply("", [call("message_role", { role: "test", message: "请跑一下回归" })])
        : reply("@test 已经在跑了");
    w.scripts.test = () => reply("回归通过");
    await say(w.alice, w.ids.topic, "@dev 安排一下回归", [{ type: "role", id: w.ids.dev }]);
    await w.drain();
    const owners = (await tasksIn(w.ids.topic)).map((t) => t.owner_role_id).sort();
    // dev's tool call reached test; "@test" in dev's final answer did not start a second test task
    expect(owners).toEqual([w.ids.dev, w.ids.test].sort());
  });

  it("any console account switches the mode, to a known value", async () => {
    const patch = (token: string, json: unknown) => w.api("PATCH", `/api/topics/${w.ids.topic}`, { token, json });
    expect((await patch(w.bob, { response_mode: "mention" })).status).toBe(200);
    expect((await patch(w.alice, { response_mode: "everyone" })).status).toBe(400);
    expect((await patch(w.alice, { response_mode: "auto" })).body.response_mode).toBe("auto");
  });
});

describe("auto mode", () => {
  it("with one role, it sees every message and may decline", async () => {
    const topic = (
      await w.api("POST", "/api/topics", {
        token: w.alice,
        json: { title: "solo", role_ids: [w.ids.dev], response_mode: "auto" },
      })
    ).body;
    w.scripts.dev = (m) => {
      const request =
        String(m.at(-1)?.content ?? "")
          .split("Request from")
          .pop() ?? "";
      return request.includes("哈哈")
        ? reply("", [call("stay_silent", { reason: "small talk" })])
        : reply("好的，我来看");
    };
    await say(w.alice, topic.id, "哈哈，今天天气不错");
    await w.drain();
    let tasks = await tasksIn(topic.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "completed", status_reason: "chose not to reply" });
    const silent = (await w.messages(topic.id)).filter((m: any) => m.author_type === "role");
    expect(silent).toHaveLength(0);

    await say(w.alice, topic.id, "帮我看下构建为什么失败");
    await w.drain();
    tasks = await tasksIn(topic.id);
    expect(tasks).toHaveLength(2);
    expect((await w.messages(topic.id)).some((m: any) => m.content === "好的，我来看")).toBe(true);
  });

  it("an explicit @ is not optional: stay_silent is offered only to messages that arrived automatically", async () => {
    const { toolsFor } = await import("../src/agent/tools.js");
    expect(toolsFor({ tools: [] }).map((t) => t.name)).not.toContain("stay_silent");
    expect(toolsFor({ tools: [], auto: true }).map((t) => t.name)).toContain("stay_silent");
    // A conversation keeps one tool list for every turn; the tool itself refuses after an @ (conversation.test.ts).
    expect(toolsFor({ tools: [], mode: "conversation" }).map((t) => t.name)).toContain("stay_silent");
  });

  it("with several roles, the dispatcher hands a message to none, one or several", async () => {
    const laya = await decisionService((text) =>
      text.includes("回归") ? ["test"] : text.includes("一起") ? ["dev", "analyst"] : [],
    );
    await w.api("PUT", "/api/settings/dispatcher", { token: w.adminToken, json: { model_config_id: laya.id } });
    const goal = "准备十月版本的发布";
    await w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.alice, json: { response_mode: "auto", goal } });
    w.scripts.dev = () => reply("dev 在");
    w.scripts.test = () => reply("回归开始");
    w.scripts.analyst = () => reply("analyst 在");

    await say(w.alice, w.ids.topic, "今天的回归能跑吗？");
    await w.drain();
    let tasks = await tasksIn(w.ids.topic);
    expect(tasks.map((t) => t.owner_role_id)).toEqual([w.ids.test]);
    expect(JSON.stringify((await w.task(tasks[0].id)).assignment)).toContain("@test 0.60");
    // one question: which role (or nobody) should handle the message, which leads the state
    const first = laya.requests[0];
    expect(first.headers.get("authorization")).toBe("Bearer laya-key");
    expect(first.body.model).toBe("multilingual");
    expect(Object.keys(first.body.questions)).toEqual(["who"]);
    expect(first.body.questions.who.type).toBe("choice");
    expect(Object.keys(first.body.questions.who.criteria).sort()).toEqual(["analyst", "dev", "nobody", "test"]);
    expect(first.body.state).toMatch(/: 今天的回归能跑吗？$/);
    // the topic goal goes with the question, as background; the state stays the message
    expect(first.body.questions.who.instructions).toBe(
      `Which role should handle alice's message? The topic is for: ${goal}`,
    );

    await say(w.bob, w.ids.topic, "哈哈，辛苦了");
    await w.drain();
    expect(await tasksIn(w.ids.topic)).toHaveLength(1);

    await say(w.alice, w.ids.topic, "这个问题需要你们一起看看");
    await w.drain();
    tasks = await tasksIn(w.ids.topic);
    expect(tasks.map((t) => t.owner_role_id).sort()).toEqual([w.ids.test, w.ids.dev, w.ids.analyst].sort());
    // only the message itself is judged: earlier replies would draw it to whoever spoke last
    expect(laya.requests[2].body.state).toMatch(/: 这个问题需要你们一起看看$/);

    const routes = await db().select().from(messageRoutes);
    expect(routes.every((r) => r.status === "done")).toBe(true);
    // the dispatcher's own model use is recorded (not tied to a task)
    const usage = await db()
      .select()
      .from(usageRecords)
      .where(and(isNull(usageRecords.taskId), eq(usageRecords.modelConfigId, laya.id)));
    expect(usage.map((u) => u.promptTokens)).toEqual([40, 40, 40]);
  });

  it("dispatcher exceptions stay in console audit, not in the mirrored notice", async () => {
    const laya = await decisionService();
    await w.api("PUT", "/api/settings/dispatcher", { token: w.adminToken, json: { model_config_id: laya.id } });
    await w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.alice, json: { response_mode: "auto" } });
    setFetch(async () => new Response("private upstream failure", { status: 503 }));
    await say(w.alice, w.ids.topic, "请处理这个问题");
    await w.drain();
    const notices = (await w.messages(w.ids.topic)).filter((m: any) => m.author_type === "system");
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toBe("暂时无法自动选择回答的角色，请直接 @ 需要的角色。");
    const logs = (await w.api("GET", "/api/audit?action=routing.failed", { token: w.adminToken })).body;
    expect(logs).toHaveLength(1);
    expect(logs[0].detail.error).toContain("private upstream failure");
  });

  it("without a dispatcher model nobody answers, and people are told once", async () => {
    await w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.alice, json: { response_mode: "auto" } });
    await say(w.alice, w.ids.topic, "有人在吗");
    await say(w.alice, w.ids.topic, "有人在吗？？");
    await w.drain();
    expect(await tasksIn(w.ids.topic)).toHaveLength(0);
    const notes = (await w.messages(w.ids.topic)).filter((m: any) => m.author_type === "system");
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain("no dispatcher model");
  });

  it("the dispatcher model is a platform setting: a System One decision model or a chat model", async () => {
    const laya = await decisionService();
    const put = (token: string, id: string) =>
      w.api("PUT", "/api/settings/dispatcher", { token, json: { model_config_id: id } });
    const get = async () => (await w.api("GET", "/api/settings/dispatcher", { token: w.bob })).body;
    expect((await get()).model_config_id).toBeNull();
    expect((await put(w.adminToken, "mdl_missing")).status).toBe(400);
    expect((await put(w.adminToken, laya.id)).status).toBe(200);
    expect(await get()).toMatchObject({ model_config_id: laya.id, kind: "decision", usable: true });
    const chat = await chatDispatcherModel();
    expect((await put(w.adminToken, chat)).status).toBe(200);
    expect(await get()).toMatchObject({ model_config_id: chat, kind: "chat", usable: true });
    // a disabled model is kept as the setting, but not used, and people are told why
    await w.api("PATCH", `/api/models/${chat}`, { token: w.adminToken, json: { enabled: false } });
    expect((await get()).usable).toBe(false);
    await w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.alice, json: { response_mode: "auto" } });
    await say(w.alice, w.ids.topic, "有人在吗");
    await w.drain();
    expect(await tasksIn(w.ids.topic)).toHaveLength(0);
    const note = (await w.messages(w.ids.topic)).find((m: any) => m.author_type === "system");
    expect(note.content).toContain("the dispatcher model is unavailable");
  });

  it("a chat model dispatches with the topic goal and earlier messages as context, by calling choose_roles", async () => {
    const chat = await chatDispatcherModel();
    await w.api("PUT", "/api/settings/dispatcher", { token: w.adminToken, json: { model_config_id: chat } });
    await w.api("PATCH", `/api/topics/${w.ids.topic}`, {
      token: w.alice,
      json: { response_mode: "auto", goal: "准备十月版本的发布" },
    });
    const asked: { text: string; tools: string[] }[] = [];
    // "可以" alone means nothing; after test's question it is test's answer
    w.scripts.dispatcher = (messages, _turn, tools) => {
      const text = String(messages.at(-1)?.content ?? "");
      asked.push({ text, tools: (tools ?? []).map((t) => t.name) });
      const latest = text.split("Latest message:").pop() ?? "";
      if (latest.includes("一起")) return reply("", [call("choose_roles", { roles: ["@analyst", "dev", "ghost"] })]);
      if (latest.includes("可以") && text.includes("要不要先跑回归"))
        return reply("", [call("choose_roles", { roles: ["test"], reason: "answers test's question" })]);
      if (latest.includes("回归")) return reply('{"roles": ["test"]}'); // a text answer is accepted too
      return reply("", [call("choose_roles", { roles: [] })]);
    };
    w.scripts.dev = () => reply("dev 在");
    w.scripts.analyst = () => reply("analyst 在");
    w.scripts.test = (_m, turn) => (turn === 0 ? reply("要不要先跑回归？") : reply("好"));

    await say(w.alice, w.ids.topic, "今天的回归能跑吗？");
    await w.drain();
    let tasks = await tasksIn(w.ids.topic);
    expect(tasks.map((t) => t.owner_role_id)).toEqual([w.ids.test]);
    expect(asked[0].tools).toEqual(["choose_roles"]);
    expect(asked[0].text).toMatch(/^Topic goal: 准备十月版本的发布\n\nRoles:\n/);
    expect(asked[0].text).toContain("- @test:");
    expect(asked[0].text).toMatch(/Latest message:\n.+: 今天的回归能跑吗？$/);

    await say(w.bob, w.ids.topic, "哈哈，辛苦了");
    await w.drain();
    expect(await tasksIn(w.ids.topic)).toHaveLength(1);

    // test asked a question in its reply; the answer reaches it without an @
    await say(w.alice, w.ids.topic, "可以");
    await w.drain();
    tasks = await tasksIn(w.ids.topic);
    expect(tasks.filter((t) => t.owner_role_id === w.ids.test).length).toBeGreaterThanOrEqual(1);
    const route = (await db().select().from(messageRoutes)).find((r) => r.result?.reason?.includes("answers test"));
    expect(route?.result).toMatchObject({ roles: ["test"] });
    expect(asked.at(-1)!.text).toContain("Earlier messages (oldest first):");

    await say(w.alice, w.ids.topic, "这个问题需要你们一起看看");
    await w.drain();
    const routes = await db().select().from(messageRoutes);
    // unknown handles are dropped; the model's order is kept
    expect(routes.find((r) => r.result?.roles?.includes("analyst"))?.result?.roles).toEqual(["analyst", "dev"]);
    expect(routes.every((r) => r.status === "done")).toBe(true);
    const usage = await db().select().from(usageRecords).where(eq(usageRecords.modelConfigId, chat));
    expect(usage.map((u) => u.taskId)).toEqual([null, null, null, null]);
  });

  it("the dispatcher reads the start of the topic goal, which holds up to 16000 characters", async () => {
    const laya = await decisionService();
    await w.api("PUT", "/api/settings/dispatcher", { token: w.adminToken, json: { model_config_id: laya.id } });
    const patch = (json: unknown) => w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.alice, json });
    expect((await patch({ goal: "x".repeat(16_001) })).status).toBe(400);
    expect((await patch({ goal: 42 })).status).toBe(400);
    // a topic has no other settings: work instructions, a round limit or a model list are not kept
    const saved = await patch({
      response_mode: "auto",
      goal: `${"a".repeat(500)}${"b".repeat(15_500)}`,
      work_instructions: "ignored",
      max_auto_rounds: 2,
      allowed_model_config_ids: [],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.goal).toHaveLength(16_000);
    for (const gone of ["work_instructions", "max_auto_rounds", "allowed_model_config_ids"])
      expect(saved.body).not.toHaveProperty(gone);
    await say(w.alice, w.ids.topic, "有人在吗");
    await w.drain();
    const asked = laya.requests[0].body.questions.who.instructions as string;
    expect(asked).toContain("a".repeat(500));
    expect(asked).not.toContain("ab");
    // a goal already longer (merged work instructions) can be sent back unchanged with a new title
    await db()
      .update(topics)
      .set({ goal: "c".repeat(16_001) })
      .where(eq(topics.id, w.ids.topic));
    expect((await patch({ title: "Release 1.1", goal: "c".repeat(16_001) })).status).toBe(200);
  });

  it("a chat model that does not answer with choose_roles is retried, then people are told", async () => {
    const chat = await chatDispatcherModel();
    await w.api("PUT", "/api/settings/dispatcher", { token: w.adminToken, json: { model_config_id: chat } });
    await w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.alice, json: { response_mode: "auto" } });
    w.scripts.dispatcher = () => reply("I think dev should answer.");
    await say(w.alice, w.ids.topic, "请处理这个问题");
    for (let i = 0; i < 3; i++) await w.drain();
    expect(await tasksIn(w.ids.topic)).toHaveLength(0);
    const notices = (await w.messages(w.ids.topic)).filter((m: any) => m.author_type === "system");
    expect(notices.map((m: any) => m.content)).toEqual(["暂时无法自动选择回答的角色，请直接 @ 需要的角色。"]);
  });

  it("WITDEN_LAYA_URL adds that Laya server once, as the dispatcher when none is set", async () => {
    const { bootstrapLaya } = await import("../src/services/model-configs.js");
    const decisionProviders = async () =>
      ((await w.api("GET", "/api/model-providers", { token: w.adminToken })).body as any[]).filter(
        (p) => p.protocol === "systemone",
      );
    await bootstrapLaya(db(), "http://laya:8000", "laya-key");
    await bootstrapLaya(db(), "http://laya:8000", "laya-key"); // every start calls it
    let providers = await decisionProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ name: "Laya", base_url: "http://laya:8000", has_api_key: true });
    expect(providers[0].models.map((m: any) => m.model)).toEqual(["multilingual"]);
    const laya = providers[0].models[0].id;
    expect((await w.api("GET", "/api/settings/dispatcher", { token: w.bob })).body.model_config_id).toBe(laya);

    // deleted by an administrator: the next start leaves it deleted
    await w.api("DELETE", `/api/model-providers/${providers[0].id}`, { token: w.adminToken });
    await bootstrapLaya(db(), "http://laya:8000", "laya-key");
    expect(await decisionProviders()).toHaveLength(0);

    // a new address is added, but a dispatcher chosen meanwhile stays
    const chosen = await decisionService();
    await w.api("PUT", "/api/settings/dispatcher", { token: w.adminToken, json: { model_config_id: chosen.id } });
    await bootstrapLaya(db(), "http://laya-2:8000", null);
    providers = await decisionProviders();
    expect(providers.map((p: any) => p.base_url).sort()).toEqual(["http://laya-2:8000", LAYA].sort());
    expect((await w.api("GET", "/api/settings/dispatcher", { token: w.bob })).body.model_config_id).toBe(chosen.id);
  });

  it("System One models are checked with a question, and cannot be a role's model", async () => {
    const laya = await decisionService();
    const checked = await w.api("POST", `/api/models/${laya.id}/check`, { token: w.adminToken });
    expect(checked.body.status).toBe("ok");
    expect(checked.body.capabilities).toMatchObject({ decide: true, latency_ms: expect.any(Number) });
    expect(checked.body.capabilities.chat).toBeUndefined();

    const assign = await w.api("PATCH", `/api/roles/${w.ids.dev}`, {
      token: w.adminToken,
      json: { model_config_id: laya.id },
    });
    expect([assign.status, assign.raw.includes("System One")]).toEqual([400, true]);
    // a self-hosted Laya has no model list: the error says to add models by name
    const providers = (await w.api("GET", "/api/model-providers", { token: w.adminToken })).body;
    const remote = await w.api(
      "GET",
      `/api/model-providers/${providers.find((p: any) => p.name === "Laya").id}/remote-models`,
      {
        token: w.adminToken,
      },
    );
    expect([remote.status, remote.raw.includes("add them by name")]).toEqual([503, true]);
    // ...which is normal for Laya, so the provider is not marked as failing
    const after = (await w.api("GET", "/api/model-providers", { token: w.adminToken })).body;
    expect(after.find((p: any) => p.name === "Laya").status).toBe("unchecked");
  });
});

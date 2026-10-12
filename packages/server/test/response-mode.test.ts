/**
 * How roles respond in a topic: only when really @-mentioned (default), or automatically — the only role
 * decides itself, several roles go through the dispatcher.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setFetch } from "../src/agent/llm.js";
import { db } from "../src/db/client.js";
import { messageRoutes, usageRecords } from "../src/db/schema.js";
import { DISPATCHER, putSetting } from "../src/services/platform-settings.js";
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

  it("only owners switch the mode, to a known value", async () => {
    const patch = (token: string, json: unknown) => w.api("PATCH", `/api/topics/${w.ids.topic}`, { token, json });
    expect((await patch(w.bob, { response_mode: "auto" })).status).toBe(403);
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
  });

  it("with several roles, the dispatcher hands a message to none, one or several", async () => {
    const laya = await decisionService((text) =>
      text.includes("回归") ? ["test"] : text.includes("一起") ? ["dev", "analyst"] : [],
    );
    await w.api("PUT", "/api/settings/dispatcher", { token: w.adminToken, json: { model_config_id: laya.id } });
    await w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.alice, json: { response_mode: "auto" } });
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

  it("the dispatcher model is a platform setting, and only System One decision models qualify", async () => {
    const laya = await decisionService();
    const put = (token: string, id: string) =>
      w.api("PUT", "/api/settings/dispatcher", { token, json: { model_config_id: id } });
    expect((await w.api("GET", "/api/settings/dispatcher", { token: w.bob })).body.model_config_id).toBeNull();
    expect((await put(w.bob, laya.id)).status).toBe(403);
    const chat = await put(w.adminToken, w.ids.model);
    expect([chat.status, chat.raw.includes("System One")]).toEqual([400, true]);
    expect((await put(w.adminToken, laya.id)).status).toBe(200);
    expect((await w.api("GET", "/api/settings/dispatcher", { token: w.bob })).body).toMatchObject({
      model_config_id: laya.id,
      usable: true,
    });

    // a chat model left over from an older setting is not used, and people are told why
    await putSetting(db(), DISPATCHER, { model_config_id: w.ids.model }, w.ids.alice);
    expect((await w.api("GET", "/api/settings/dispatcher", { token: w.bob })).body.usable).toBe(false);
    await w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.alice, json: { response_mode: "auto" } });
    await say(w.alice, w.ids.topic, "有人在吗");
    await w.drain();
    const note = (await w.messages(w.ids.topic)).find((m: any) => m.author_type === "system");
    expect(note.content).toContain("not a System One decision model");
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

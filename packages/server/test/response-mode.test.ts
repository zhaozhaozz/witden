/**
 * How roles respond in a topic: only when really @-mentioned (default), or automatically — the only role
 * decides itself, several roles go through the dispatcher.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { messageRoutes, usageRecords } from "../src/db/schema.js";
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
/** The message the dispatcher is asked about (its prompt also quotes recent history). */
const latest = (prompt: string) => prompt.split("Latest message, from").pop() ?? "";

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
    await w.api("PUT", "/api/settings/dispatcher", { token: w.adminToken, json: { model_config_id: w.ids.model } });
    await w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.alice, json: { response_mode: "auto" } });
    const prompts: string[] = [];
    w.scripts.__dispatcher = (m) => {
      const asked = latest(String(m[1].content));
      prompts.push(`${m[0].content}\n${m[1].content}`);
      if (asked.includes("回归")) return reply('{"roles": ["test"], "reason": "回归是测试的职责"}');
      if (asked.includes("一起"))
        return reply('<think>两个人</think>{"roles": ["@dev", "analyst"], "reason": "需要开发和分析"}');
      return reply('{"roles": [], "reason": "闲聊"}');
    };
    w.scripts.dev = () => reply("dev 在");
    w.scripts.test = () => reply("回归开始");
    w.scripts.analyst = () => reply("analyst 在");

    await say(w.alice, w.ids.topic, "今天的回归能跑吗？");
    await w.drain();
    let tasks = await tasksIn(w.ids.topic);
    expect(tasks.map((t) => t.owner_role_id)).toEqual([w.ids.test]);
    const detail = await w.task(tasks[0].id);
    expect(JSON.stringify(detail.assignment)).toContain("回归是测试的职责");
    expect(prompts[0]).toContain("@dev");
    expect(prompts[0]).toContain("今天的回归能跑吗？");

    await say(w.bob, w.ids.topic, "哈哈，辛苦了");
    await w.drain();
    expect(await tasksIn(w.ids.topic)).toHaveLength(1);

    await say(w.alice, w.ids.topic, "这个问题需要你们一起看看");
    await w.drain();
    tasks = await tasksIn(w.ids.topic);
    expect(tasks.map((t) => t.owner_role_id).sort()).toEqual([w.ids.test, w.ids.dev, w.ids.analyst].sort());

    const routes = await db().select().from(messageRoutes);
    expect(routes.every((r) => r.status === "done")).toBe(true);
    // the dispatcher's own model use is recorded (not tied to a task)
    const usage = await db()
      .select()
      .from(usageRecords)
      .where(and(isNull(usageRecords.taskId), eq(usageRecords.modelConfigId, w.ids.model)));
    expect(usage).toHaveLength(3);
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

  it("the dispatcher model is a platform setting", async () => {
    expect((await w.api("GET", "/api/settings/dispatcher", { token: w.bob })).body.model_config_id).toBeNull();
    const denied = await w.api("PUT", "/api/settings/dispatcher", {
      token: w.bob,
      json: { model_config_id: w.ids.model },
    });
    expect(denied.status).toBe(403);
    await w.api("PUT", "/api/settings/dispatcher", { token: w.adminToken, json: { model_config_id: w.ids.model } });
    const got = (await w.api("GET", "/api/settings/dispatcher", { token: w.bob })).body;
    expect(got).toMatchObject({ model_config_id: w.ids.model, usable: true });
  });
});

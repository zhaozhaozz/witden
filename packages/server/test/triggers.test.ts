import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/context.js";
import { toolsFor } from "../src/agent/tools.js";
import { db } from "../src/db/client.js";
import {
  externalThreadLinks,
  outboundMessages,
  roles,
  tasks,
  topics,
  topicTriggers,
  triggerEvents,
  users,
} from "../src/db/schema.js";
import { runFilter, validateFilter } from "../src/services/trigger-filter.js";
import { nextTriggerTime } from "../src/services/trigger-schedule.js";
import { acceptWebhook, processTriggerEvents, queueScheduledTriggers } from "../src/services/triggers.js";
import { call, lastToolResult, reply } from "./support/harness.js";
import { linkChannel } from "./support/outside.js";
import { buildWorld, type World } from "./support/world.js";

const SECRET = "test-webhook-secret-with-at-least-32-chars";
const request = {
  method: "POST",
  path: "/test",
  query: {},
  headers: {},
  body_base64: Buffer.from('{"action":"opened"}').toString("base64"),
};

describe("pure trigger configuration", () => {
  it("evaluates only boolean filters with no host access and stops infinite loops", async () => {
    expect(await runFilter('return request.body.action === "opened";', request)).toBe(true);
    expect(await runFilter('return request.body.action === "closed";', request)).toBe(false);
    expect(
      await runFilter(
        'return typeof process === "undefined" && typeof require === "undefined" && typeof fetch === "undefined";',
        request,
      ),
    ).toBe(true);
    for (const code of [
      'return "yes";',
      "return Promise.resolve(true);",
      "while(true) {}",
      "throw { get message() { while (true) {} } };",
      "return process.env;",
    ])
      await expect(runFilter(code, request)).rejects.toThrow();
    await expect(validateFilter("return (")).rejects.toThrow();
    // Validation compiles, it does not run a valid infinite predicate.
    await expect(validateFilter("while(true) {} ")).resolves.toBeUndefined();
    expect(await runFilter("return true;", request)).toBe(true);
  });

  it("uses IANA zones, advances strictly after now, and rejects invalid schedules", () => {
    const now = new Date("2026-10-19T00:00:00Z");
    expect(nextTriggerTime("0 9 * * 1-5", "Asia/Shanghai", now).toISOString()).toBe("2026-10-19T01:00:00.000Z");
    expect(nextTriggerTime("0 9 * * 1-5", "UTC", now).toISOString()).toBe("2026-10-19T09:00:00.000Z");
    expect(nextTriggerTime("* * * * *", "UTC", now).toISOString()).toBe("2026-10-19T00:01:00.000Z");
    // Spring-forward skips a nonexistent local time without looping or producing an invalid date.
    expect(
      nextTriggerTime("30 2 * * *", "America/New_York", new Date("2026-03-08T06:00:00Z")).getTime(),
    ).toBeGreaterThan(Date.parse("2026-03-08T06:00:00Z"));
    for (const [cron, zone] of [
      ["bad", "UTC"],
      ["* * * * * *", "UTC"],
      ["0 25 * * *", "UTC"],
      ["* * * * *", "Invalid/Zone"],
    ])
      expect(() => nextTriggerTime(cron, zone, now)).toThrow();
  });
});

describe("topic triggers", () => {
  let w: World;
  beforeEach(async () => {
    w = await buildWorld();
  });
  afterEach(async () => {
    await w.close();
  });
  const base = () => `/api/topics/${w.ids.topic}`;
  const create = async (extra: Record<string, unknown> = {}) => {
    const res = await w.api("POST", `${base()}/triggers`, {
      token: w.alice,
      json: { name: "部署通知", kind: "webhook", role_id: w.ids.dev, secret: SECRET, ...extra },
    });
    expect(res.status, res.raw).toBe(200);
    return res.body;
  };
  const receive = (
    id: string,
    raw = '{ "action": "opened", "标题": "测试" }\n',
    headers: Record<string, string> = {},
  ) =>
    w.webhooks("POST", `/api/hooks/${id}?repo=witden`, {
      payload: raw,
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, ...headers },
    });
  const receipts = () => db().select().from(triggerEvents).where(eq(triggerEvents.topicId, w.ids.topic));

  it("persists exact bytes, filters before any model call, redacts credentials, and dispatches once per idempotency key", async () => {
    const trigger = await create({ filter_code: 'return request.body?.action === "opened";' });
    expect(JSON.stringify(trigger)).not.toContain(SECRET);
    expect(trigger.token_hash).toBeUndefined();
    const raw = '{ "action": "opened", "标题": "测试" }\n';
    const [a, b] = await Promise.all([
      receive(trigger.id, raw, { "idempotency-key": "delivery-1", cookie: "session=private" }),
      receive(trigger.id, raw, { "idempotency-key": "delivery-1" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(a.body.id).toBe(b.body.id);
    await w.witden.runtime.drain();
    const [event] = await receipts();
    expect(event.status).toBe("dispatched");
    expect(Buffer.from(event.request!.body_base64, "base64").toString()).toBe(raw);
    expect(event.request!.headers.authorization).toBe("[REDACTED]");
    expect(event.request!.query).toEqual({ repo: "witden" });
    expect(await receipts()).toHaveLength(1);
    const assigned = await db().select().from(tasks).where(eq(tasks.topicId, w.ids.topic));
    expect(assigned).toHaveLength(1);
    expect(assigned[0].ownerRoleId).toBe(w.ids.dev);
    expect(assigned[0].envelope.auto).not.toBe(true);
    const stored = await w.messages(w.ids.topic);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).not.toContain('"标题"');
    expect(stored[0].content).not.toContain("read_webhook_history");
    expect(stored[0].content).not.toContain(event.id);
    expect(stored[0].mentions).toEqual([]);
  });

  it("retains filtered, malformed JSON and binary requests; exceptions and timeouts never start work", async () => {
    let modelCalls = 0;
    w.scripts.dev = () => {
      modelCalls++;
      return reply("unexpected");
    };
    const trigger = await create({ filter_code: 'return request.body?.action === "opened";' });
    expect((await receive(trigger.id, '{"action":"closed"}')).status).toBe(202);
    expect((await receive(trigger.id, "{invalid json")).status).toBe(202);
    const bytes = Buffer.from([0, 255, 1, 254]);
    expect(
      (
        await w.webhooks("POST", `/api/hooks/${trigger.id}`, {
          payload: bytes,
          headers: { "content-type": "application/octet-stream", "x-webhook-token": SECRET },
        })
      ).status,
    ).toBe(202);
    await w.witden.runtime.drain();
    expect((await receipts()).map((r) => r.status)).toEqual(["filtered", "filtered", "filtered"]);
    expect((await receipts()).some((r) => r.request?.body_base64 === bytes.toString("base64"))).toBe(true);
    for (const code of ["while(true) {}", "return 1;", 'throw new Error("body should not leak")']) {
      expect(
        (await w.api("PATCH", `${base()}/triggers/${trigger.id}`, { token: w.alice, json: { filter_code: code } }))
          .status,
      ).toBe(200);
      await receive(trigger.id);
      await w.witden.runtime.drain();
    }
    await w.drain();
    expect(modelCalls).toBe(0);
    expect((await receipts()).filter((r) => r.status === "failed")).toHaveLength(3);
    expect(JSON.stringify((await receipts()).map((r) => r.error))).not.toContain("body should not leak");
    expect(await w.messages(w.ids.topic)).toHaveLength(0);
  });

  it("rejects unauthorized and oversized requests, keeps management off the public listener, and rotates secrets", async () => {
    const trigger = await create();
    expect((await w.webhooks("POST", `/api/hooks/${trigger.id}`, { json: {} })).status).toBe(401);
    expect((await receive(trigger.id, "x".repeat(1024 * 1024 + 1), { "content-type": "text/plain" })).status).toBe(413);
    expect(await receipts()).toHaveLength(0);
    expect((await w.webhooks("GET", `${base()}/triggers`, { token: w.alice })).status).toBe(404);
    expect((await w.api("GET", `${base()}/triggers`)).status).toBe(401);
    const newSecret = `${SECRET}-rotated`;
    expect(
      (await w.api("PATCH", `${base()}/triggers/${trigger.id}`, { token: w.alice, json: { secret: newSecret } }))
        .status,
    ).toBe(200);
    expect((await receive(trigger.id)).status).toBe(401);
    expect((await receive(trigger.id, "{}", { authorization: `Bearer ${newSecret}` })).status).toBe(202);
    await w.witden.runtime.drain();
    expect((await w.api("GET", "/api/audit", { token: w.alice })).raw).not.toContain(newSecret);
  });

  it("offers own-topic raw history to roles, including filtered requests, but never another topic", async () => {
    const trigger = await create({ filter_code: "return false;" });
    const delivery = await receive(trigger.id, '{"keep":"private-to-this-topic"}');
    await w.witden.runtime.drain();
    const tool = toolsFor({ tools: [], mode: "conversation" }).find((t) => t.name === "read_webhook_history")!;
    const ctx = {
      taskId: "unused",
      roleId: w.ids.dev,
      topicId: w.ids.topic,
      toolCallId: "read",
      gateway: w.witden.runtime.gateway!,
      db,
    };
    expect(JSON.parse((await tool.handler(ctx, { id: delivery.body.id, limit: 8 })).content as string)).toMatchObject({
      raw_body: '{"keep":',
      next_offset: 8,
    });
    expect((await tool.handler(ctx, {})).content).toContain(delivery.body.id);
    const other = (
      await w.api("POST", "/api/topics", { token: w.alice, json: { title: "Other", role_ids: [w.ids.dev] } })
    ).body;
    await expect(tool.handler({ ...ctx, topicId: other.id }, { id: delivery.body.id })).rejects.toThrow("没有");
    expect(
      (await w.api("GET", `/api/topics/${other.id}/trigger-events/${delivery.body.id}`, { token: w.alice })).status,
    ).toBe(404);
    await w.api("DELETE", `${base()}/participants/role/${w.ids.dev}`, { token: w.alice });
    await expect(tool.handler(ctx, {})).rejects.toThrow("不在");
  });

  it("gives work instructions and a receipt-reading tool to the existing conversation and mirrors replies to its external channel", async () => {
    const channel = await linkChannel(w, w.ids.topic, []);
    await db()
      .update(externalThreadLinks)
      .set({ threadKey: "__channel__" })
      .where(eq(externalThreadLinks.topicId, w.ids.topic));
    // An administrator often configures a synced channel before participating in it.
    await w.api("DELETE", `${base()}/participants/user/${w.ids.alice}`, { token: w.alice });
    await w.api("PATCH", base(), { token: w.alice, json: { work_instructions: "检查部署结果，仅汇报异常。" } });
    const trigger = await create({ instructions: "本次检查 production" });
    const result = await receive(trigger.id);
    await w.witden.runtime.drain();
    w.scripts.dev = (history, turn) => {
      expect(JSON.stringify(history)).toContain(result.body.id);
      return turn === 0
        ? reply("", [call("read_webhook_history", { id: result.body.id })])
        : reply(`已核查：${lastToolResult(history).includes("opened")}`);
    };
    await w.drain();
    const [task] = await db().select().from(tasks).where(eq(tasks.topicId, w.ids.topic));
    const [role] = await db().select().from(roles).where(eq(roles.id, w.ids.dev));
    const [topic] = await db().select().from(topics).where(eq(topics.id, w.ids.topic));
    expect(await systemPrompt(db(), task, role, topic)).toContain("检查部署结果，仅汇报异常。");
    expect(task.instruction).toContain("本次检查 production");
    expect(task.status).toBe("completed");
    const output = await w.messages(w.ids.topic);
    expect(output.some((m) => m.author_type === "role" && m.content.includes("已核查：true"))).toBe(true);
    const mirrored = await db()
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.connectionId, channel.connectionId));
    expect(mirrored.length).toBeGreaterThanOrEqual(2);
    expect(mirrored.every((m) => m.threadKey === null)).toBe(true);
    expect(JSON.stringify(mirrored)).not.toContain(SECRET);
  });

  it("coalesces missed schedules, does not queue duplicate ticks, and resumes from the next occurrence", async () => {
    const trigger = await create({ kind: "schedule", secret: undefined, cron: "*/5 * * * *", timezone: "UTC" });
    const now = new Date();
    await db()
      .update(topicTriggers)
      .set({ nextRunAt: new Date(now.getTime() - 3600_000) })
      .where(eq(topicTriggers.id, trigger.id));
    await Promise.all([queueScheduledTriggers(now), queueScheduledTriggers(now)]);
    expect(await receipts()).toHaveLength(1);
    const [updated] = await db().select().from(topicTriggers).where(eq(topicTriggers.id, trigger.id));
    expect(updated.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    await Promise.all([processTriggerEvents(), processTriggerEvents()]);
    expect((await receipts())[0].status).toBe("dispatched");
    expect(await db().select().from(tasks).where(eq(tasks.topicId, w.ids.topic))).toHaveLength(1);
    await w.api("PATCH", `${base()}/triggers/${trigger.id}`, { token: w.alice, json: { enabled: false } });
    expect((await db().select().from(topicTriggers).where(eq(topicTriggers.id, trigger.id)))[0].nextRunAt).toBeNull();
    await w.api("PATCH", `${base()}/triggers/${trigger.id}`, { token: w.alice, json: { enabled: true } });
    expect(
      (await db().select().from(topicTriggers).where(eq(topicTriggers.id, trigger.id)))[0].nextRunAt!.getTime(),
    ).toBeGreaterThan(now.getTime());
  });

  it("recovers an expired processing lease without creating two messages", async () => {
    const trigger = await create();
    const delivery = await acceptWebhook(trigger.id, SECRET, request, "recovered");
    await db()
      .update(triggerEvents)
      .set({ status: "processing", attempts: 1, claimedAt: new Date(Date.now() - 120_000), claimToken: "old-claim" })
      .where(eq(triggerEvents.id, delivery.id));
    await Promise.all([processTriggerEvents(), processTriggerEvents()]);
    expect(await receipts()).toHaveLength(1);
    expect((await receipts())[0]).toMatchObject({ status: "dispatched", attempts: 2, claimToken: null });
    expect(await w.messages(w.ids.topic)).toHaveLength(1);
    await processTriggerEvents();
    expect(await w.messages(w.ids.topic)).toHaveLength(1);
  });

  it("checks disabled topics, roles and creators again before dispatch", async () => {
    const trigger = await create();
    await acceptWebhook(trigger.id, SECRET, request, "before-disable");
    await w.api("PATCH", `${base()}/triggers/${trigger.id}`, { token: w.alice, json: { enabled: false } });
    await processTriggerEvents();
    expect((await receipts())[0].status).toBe("skipped");
    expect((await receive(trigger.id)).status).toBe(400);
    await w.api("PATCH", `${base()}/triggers/${trigger.id}`, { token: w.alice, json: { enabled: true } });
    await acceptWebhook(trigger.id, SECRET, request, "before-role-removal");
    await w.api("DELETE", `${base()}/participants/role/${w.ids.dev}`, { token: w.alice });
    await processTriggerEvents();
    expect((await receipts()).find((r) => r.eventKey === "before-role-removal")!.status).toBe("failed");
    await db().update(users).set({ isActive: false }).where(eq(users.id, w.ids.alice));
    await acceptWebhook(trigger.id, SECRET, request, "disabled-creator");
    await processTriggerEvents();
    expect((await receipts()).find((r) => r.eventKey === "disabled-creator")!.status).toBe("failed");
    expect(await db().select().from(tasks).where(eq(tasks.topicId, w.ids.topic))).toHaveLength(0);
    await db().update(topics).set({ status: "archived" }).where(eq(topics.id, w.ids.topic));
    expect((await receive(trigger.id)).status).toBe(400);
  });

  it("validates inputs, previews without storing or dispatching, and keeps history after trigger deletion until explicitly cleared", async () => {
    for (const json of [
      { name: "bad", kind: "schedule", role_id: w.ids.dev, cron: "invalid" },
      { name: "bad", kind: "webhook", role_id: w.ids.dev, secret: "short" },
      { name: "bad", kind: "webhook", role_id: w.ids.dev, secret: SECRET, filter_code: "return (" },
    ])
      expect((await w.api("POST", `${base()}/triggers`, { token: w.alice, json })).status).toBe(400);
    const preview = await w.api("POST", `${base()}/triggers/test-filter`, {
      token: w.alice,
      json: { filter_code: "return request.body.ok === true;", raw_body: '{"ok":true}' },
    });
    expect(preview.body).toEqual({ accepted: true });
    expect(await receipts()).toHaveLength(0);
    const trigger = await create({ filter_code: "return false;" });
    await receive(trigger.id);
    await w.witden.runtime.drain();
    expect((await w.api("DELETE", `${base()}/triggers/${trigger.id}`, { token: w.alice })).status).toBe(200);
    expect(await receipts()).toHaveLength(1);
    expect((await receive(trigger.id)).status).toBe(401);
    expect((await w.api("DELETE", `${base()}/trigger-events`, { token: w.alice })).status).toBe(400);
    expect(
      (await w.api("DELETE", `${base()}/trigger-events`, { token: w.alice, json: { confirm: true } })).status,
    ).toBe(200);
    expect(await receipts()).toHaveLength(0);
  });

  it("paginates tied and sub-millisecond timestamps without skipping receipts, and cleanup removes queued events", async () => {
    const trigger = await create({ filter_code: "return false;" });
    for (let i = 0; i < 3; i++) await acceptWebhook(trigger.id, SECRET, request, `page-${i}`);
    const all = await receipts();
    for (const [i, event] of all.entries())
      await db()
        .update(triggerEvents)
        .set({
          createdAt: sql`'2026-10-19T12:00:00.000123Z'::timestamptz + ${i} * interval '1 microsecond'`,
        })
        .where(eq(triggerEvents.id, event.id));
    let before: string | undefined;
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await w.api("GET", `${base()}/trigger-events?limit=1${before ? `&before=${before}` : ""}`, {
        token: w.alice,
      });
      expect(res.status, res.raw).toBe(200);
      ids.push(...res.body.items.map((event: { id: string }) => event.id));
      before = res.body.next_cursor;
    }
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect((await w.api("GET", `${base()}/trigger-events?limit=NaN`, { token: w.alice })).status).toBe(400);
    expect(
      (
        await w.api("POST", `${base()}/cleanup`, {
          token: w.alice,
          json: { confirm: true, messages: false, memories: false, files: false, trigger_history: true },
        })
      ).status,
    ).toBe(200);
    await processTriggerEvents();
    expect(await receipts()).toHaveLength(0);
    expect(await db().select().from(tasks).where(eq(tasks.topicId, w.ids.topic))).toHaveLength(0);
  });

  it("limits configuration to administrators and group topics, and does not schedule system administrators", async () => {
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    expect(
      (
        await w.api("POST", `/api/topics/${dm.id}/triggers`, {
          token: w.alice,
          json: { name: "dm", kind: "webhook", role_id: w.ids.dev, secret: SECRET },
        })
      ).status,
    ).toBe(400);
    const [systemAdmin] = await db().select().from(roles).where(eq(roles.systemAdmin, true));
    await w.api("POST", `${base()}/participants`, { token: w.alice, json: { type: "role", id: systemAdmin.id } });
    expect(
      (
        await w.api("POST", `${base()}/triggers`, {
          token: w.alice,
          json: { name: "admin", kind: "webhook", role_id: systemAdmin.id, secret: SECRET },
        })
      ).status,
    ).toBe(400);
    const channel = await linkChannel(w, w.ids.topic, []);
    await db().update(users).set({ externalConnectionId: channel.connectionId }).where(eq(users.id, w.ids.alice));
    expect(
      (
        await w.api("POST", `${base()}/triggers`, {
          token: w.alice,
          json: { name: "external", kind: "webhook", role_id: w.ids.dev, secret: SECRET },
        })
      ).status,
    ).toBe(403);
    expect((await w.api("GET", `${base()}/triggers`, { token: w.alice })).status).toBe(403);
  });
});

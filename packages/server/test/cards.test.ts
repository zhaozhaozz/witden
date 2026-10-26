/**
 * Cards: a role posts one (post_card), people act on it in the console, the action reaches the role in the card's
 * thread, and the role changes the card (update_card). The card format, its Markdown version and its Feishu form.
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, messages, outboundMessages } from "../src/db/schema.js";
import { toFeishuCard } from "../src/integrations/feishu-cards.js";
import { actionText, cardMarkdown, checkValues, parseCard } from "../src/services/cards.js";
import { call, lastUser, reply, startHarness } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

const approval = {
  title: "发布审批",
  subtitle: "v0.3.0",
  color: "orange",
  once: true,
  blocks: [
    { type: "fields", items: [{ label: "分支", value: "release/0.3" }] },
    {
      type: "chart",
      kind: "bar",
      title: "构建耗时",
      labels: ["周一", "周二"],
      series: [{ name: "分钟", values: [12, 9] }],
    },
    {
      type: "tabs",
      tabs: [
        {
          label: "测试",
          blocks: [
            {
              type: "table",
              columns: [
                { key: "n", label: "用例" },
                { key: "r", label: "结果" },
              ],
              rows: [{ n: "登录", r: "通过" }],
            },
          ],
        },
        { label: "说明", blocks: [{ type: "text", text: "**全部通过**" }] },
      ],
    },
    {
      type: "input",
      name: "env",
      label: "环境",
      kind: "select",
      required: true,
      options: [
        { value: "prod", label: "生产" },
        { value: "staging", label: "预发" },
      ],
    },
    { type: "input", name: "note", label: "备注", kind: "textarea" },
  ],
  actions: [
    { id: "approve", label: "批准", style: "primary" },
    { id: "reject", label: "拒绝", style: "danger" },
    { id: "ci", label: "CI", url: "https://ci.example.com/1" },
  ],
};

describe("card format", () => {
  it("checks a card and says what to fix", () => {
    expect(parseCard(approval).title).toBe("发布审批");
    expect(() => parseCard({ blocks: [] })).toThrow(/blocks/);
    expect(() => parseCard({ blocks: [{ type: "chart", kind: "bar", labels: [], series: [] }] })).toThrow(
      /invalid card/,
    );
    expect(() =>
      parseCard({
        blocks: [{ type: "input", name: "x", label: "X" }],
        actions: [{ id: "go", label: "Go", url: "https://x.dev" }],
      }),
    ).toThrow(/needs a button/);
    expect(() =>
      parseCard({ blocks: [{ type: "input", name: "Bad Name", label: "X" }], actions: [{ id: "go", label: "Go" }] }),
    ).toThrow(/lower-case/);
    expect(() => parseCard({ blocks: [{ type: "text", text: "x" }], extra: 1 })).toThrow(/invalid card/);
    expect(() =>
      parseCard({
        blocks: [{ type: "input", name: "x", label: "X", kind: "select" }],
        actions: [{ id: "go", label: "Go" }],
      }),
    ).toThrow(/the select x needs options/);
  });

  it("names any block with a title, in the console's order, in Markdown and on Feishu", () => {
    const card = parseCard({
      blocks: [
        { type: "fields", title: "2. 字段", items: [{ label: "a", value: "1" }] },
        { type: "table", title: "3. 表格", columns: [{ key: "k", label: "K" }], rows: [{ k: "x" }] },
        { type: "list", title: "4. 列表", items: [{ title: "一项" }] },
        {
          type: "tabs",
          title: "5. 分页",
          tabs: [
            { label: "甲", blocks: [{ type: "text", text: "甲页" }] },
            { label: "乙", blocks: [{ type: "text", text: "乙页" }] },
          ],
        },
        { type: "app", title: "6. 小应用", html: "<p>x</p>", fallback: "一个小应用" },
      ],
    });
    expect(card.blocks.map((b: any) => b.title)).toEqual(["2. 字段", "3. 表格", "4. 列表", "5. 分页", "6. 小应用"]);
    const text = cardMarkdown(card);
    expect(text).toContain("**3. 表格**\n\n| K |");
    expect(text.indexOf("2. 字段")).toBeLessThan(text.indexOf("3. 表格"));
    expect(text.indexOf("5. 分页")).toBeLessThan(text.indexOf("**甲**"));
    const elements: any[] = (toFeishuCard({ spec: card, state: { actions: [], closed: false } }, "msg_1") as any).body
      .elements;
    const table = elements.findIndex((e) => e.tag === "table");
    expect(elements[table - 1]).toMatchObject({ tag: "markdown", content: expect.stringContaining("3. 表格") });
    const panel = elements.findIndex((e) => e.tag === "collapsible_panel");
    expect(elements[panel - 1].content).toContain("5. 分页");
  });

  it("reads as Markdown where cards are not shown", () => {
    const md = cardMarkdown(parseCard(approval));
    expect(md).toContain("**发布审批**");
    expect(md).toContain("**分支**：release/0.3");
    expect(md).toContain("| 构建耗时 | 分钟 |");
    expect(md).toContain("| 周一 | 12 |");
    expect(md).toContain("| 登录 | 通过 |");
    expect(md).toContain("[CI](https://ci.example.com/1)");
    expect(md).toContain("「批准」");
  });

  it("checks what a form sends", () => {
    const card = parseCard(approval);
    expect(() => checkValues(card, {})).toThrow("「环境」是必填项");
    expect(() => checkValues(card, { env: "dev" })).toThrow("「环境」的选项无效");
    expect(checkValues(card, { env: "prod", note: "ok", stray: 1 })).toEqual({ env: "prod", note: "ok" });
    expect(actionText(card, "批准", { env: "prod", note: "ok" })).toBe(
      "点击了卡片「发布审批」的「批准」\n环境：生产\n备注：ok",
    );
  });

  it("becomes a Feishu card: tables and charts in order, the inputs and buttons as one form", () => {
    const stored = { spec: parseCard(approval), state: { actions: [], closed: false } };
    const card: any = toFeishuCard(stored, "msg_1");
    expect(card).toMatchObject({ schema: "2.0", config: { update_multi: true }, header: { template: "orange" } });
    const tags = card.body.elements.map((e: any) => e.tag);
    expect(tags).toEqual(["markdown", "chart", "collapsible_panel", "collapsible_panel", "form"]);
    expect(card.body.elements[1].chart_spec).toMatchObject({ type: "bar", xField: "label", yField: "value" });
    expect(card.body.elements[2].elements[0]).toMatchObject({
      tag: "table",
      columns: [{ display_name: "用例" }, { display_name: "结果" }],
    });
    const form = card.body.elements[4];
    expect(form.elements.map((e: any) => e.tag)).toEqual([
      "markdown",
      "select_static",
      "markdown",
      "input",
      "column_set",
    ]);
    const [approve, , link] = form.elements[4].columns.map((c: any) => c.elements[0]);
    expect(approve).toMatchObject({
      form_action_type: "submit",
      type: "primary",
      behaviors: [{ type: "callback", value: { witden: "card", m: "msg_1", a: "approve" } }],
    });
    expect(link).toMatchObject({ behaviors: [{ type: "open_url", default_url: "https://ci.example.com/1" }] });
    expect(link.form_action_type).toBeUndefined();
    // closed: the buttons are off and the card says who chose what
    const closed: any = toFeishuCard(
      {
        spec: stored.spec,
        state: {
          actions: [
            { action: "approve", label: "批准", values: {}, user_id: "u", user_name: "alice", at: "", via: "console" },
          ],
          closed: true,
        },
      },
      "msg_1",
    );
    const last = closed.body.elements.at(-1);
    expect(last.content).toContain("alice 选择了「批准」");
    expect(closed.body.elements.at(-2).elements[4].columns[0].elements[0].disabled).toBe(true);
  });
});

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

describe("cards in a topic", () => {
  it("a role posts a card; a person acts on it; the role hears it in the card's thread and changes the card", async () => {
    let seen = "";
    w.scripts.dev = (m, turn) => {
      const said = lastUser(m);
      // first the request, then (a new run) alice's action, as a message from her in the card's thread
      if (!said.includes("点击了卡片"))
        return turn === 0 ? reply("", [call("post_card", { card: approval })]) : reply("卡片已发出");
      seen = said;
      const id = /\[on card (msg_[a-z0-9]+): button approve\]/.exec(said)?.[1];
      return turn === 0 && id
        ? reply("", [
            call("update_card", {
              message_id: id,
              card: {
                title: "发布审批（已批准）",
                color: "green",
                blocks: [{ type: "text", text: "生产环境，今晚发布" }],
              },
            }),
          ])
        : reply("收到，开始发布");
    };
    await w.post(w.alice, w.ids.topic, "@dev 请审批发布");
    await w.drain();
    const msgs = await w.messages(w.ids.topic);
    const card = msgs.find((m: any) => m.card);
    expect(card.card.spec.title).toBe("发布审批");
    expect(card.content).toContain("**发布审批**");

    // required input missing: refused; then a real choice
    const missing = await w.api("POST", `/api/topics/${w.ids.topic}/messages/${card.id}/card-actions`, {
      token: w.alice,
      json: { action: "approve", values: {} },
    });
    expect(missing.status).toBe(400);
    expect(missing.raw).toContain("「环境」是必填项");
    const done = await w.api("POST", `/api/topics/${w.ids.topic}/messages/${card.id}/card-actions`, {
      token: w.alice,
      json: { action: "approve", values: { env: "prod", note: "今晚" } },
    });
    expect(done.status, done.raw).toBe(200);
    expect(done.body.message.card.state).toMatchObject({
      closed: true,
      actions: [{ action: "approve", user_name: "alice" }],
    });
    expect(done.body.reply).toMatchObject({
      reply_to_id: card.id,
      content: "点击了卡片「发布审批」的「批准」\n环境：生产\n备注：今晚",
    });
    // once: a second answer is refused
    const again = await w.api("POST", `/api/topics/${w.ids.topic}/messages/${card.id}/card-actions`, {
      token: w.bob,
      json: { action: "reject", values: { env: "prod" } },
    });
    expect(again.status).toBe(400);
    expect(again.raw).toContain("已经关闭");
    await w.drain();
    // the role read the action, which card and button it was, and changed the card
    expect(seen).toContain(`→ you (in the thread of ${card.id})`);
    expect(seen).toContain(`[on card ${card.id}: button approve]`);
    const [after] = await db().select().from(messages).where(eq(messages.id, card.id));
    expect((after.card as any).spec.title).toBe("发布审批（已批准）");
    expect((after.card as any).state.actions).toHaveLength(1);
    expect(after.content).toContain("alice 选择了「批准」");
    const audits = await db().select().from(auditLogs).where(eq(auditLogs.action, "card.action"));
    expect(audits.map((a) => a.detail)).toEqual([
      expect.objectContaining({ message_id: card.id, action: "approve", via: "console" }),
    ]);
    // the action message stays in the console
    expect(
      await db().select().from(outboundMessages).where(eq(outboundMessages.messageId, done.body.reply.id)),
    ).toEqual([]);
  });

  it("refuses a card that is not valid, telling the role what to fix", async () => {
    let result = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("post_card", { card: { blocks: [{ type: "chart", kind: "bar" }] } })]);
      result = m
        .filter((x) => x.role === "tool")
        .map((x) => String(x.content))
        .join("\n");
      return reply("改用文字");
    };
    await w.post(w.alice, w.ids.topic, "@dev 画个图");
    await w.drain();
    expect(result).toMatch(/invalid card — blocks\.0/);
    expect((await w.messages(w.ids.topic)).some((m: any) => m.card)).toBe(false);
  });
});

describe("card apps", () => {
  const app = {
    type: "app",
    html: '<input id="n" type="range"><b id="out"></b><script>n.oninput = () => (out.textContent = n.value);</script>',
    fallback: "一个滑杆，显示选中的值。",
  };

  it("are checked; their code does not count toward the size other platforms take", () => {
    const big = { ...app, html: `<p>${"x".repeat(40_000)}</p>` };
    expect(parseCard({ title: "App", blocks: [big] }).blocks).toHaveLength(1);
    expect(() => parseCard({ blocks: [{ ...app, html: "x".repeat(70_000) }] })).toThrow(/invalid card/);
    expect(() => parseCard({ blocks: [app, app, app, app] })).toThrow(/at most 3 apps/);
    expect(() => parseCard({ blocks: [{ type: "app", html: "<p>x</p>" }] })).toThrow(/fallback/);
  });

  it("read as their fallback where they cannot run, in Markdown and on Feishu", () => {
    const card = parseCard({ title: "滑杆", blocks: [app] });
    expect(cardMarkdown(card)).toContain("一个滑杆，显示选中的值。");
    expect(cardMarkdown(card)).toContain("交互小应用");
    const feishu: any = toFeishuCard({ spec: card, state: { actions: [], closed: false } }, "msg_1");
    expect(JSON.stringify(feishu)).not.toContain("<script>");
    expect(feishu.body.elements[0].content).toContain("一个滑杆，显示选中的值。");
  });

  it("send an action with their data; the role reads it with the action", async () => {
    w.scripts.dev = (_m, turn) =>
      turn === 0
        ? reply("", [
            call("post_card", { card: { title: "分账", blocks: [app], actions: [{ id: "ok", label: "确认" }] } }),
          ])
        : reply("好");
    await w.post(w.alice, w.ids.topic, "@dev 做个分账器");
    await w.drain();
    const card = (await w.messages(w.ids.topic)).find((m: any) => m.card);
    const url = `/api/topics/${w.ids.topic}/messages/${card.id}/card-actions`;
    const tooBig = await w.api("POST", url, {
      token: w.alice,
      json: { action: "ok", values: {}, app_data: { blob: "x".repeat(5000) } },
    });
    expect(tooBig.status).toBe(400);
    const done = await w.api("POST", url, {
      token: w.alice,
      json: { action: "ok", values: {}, app_data: { n: 4, each: 187 } },
    });
    expect(done.status, done.raw).toBe(200);
    expect(done.body.message.card.state.actions[0]).toMatchObject({ action: "ok", app_data: { n: 4, each: 187 } });
    expect(done.body.reply.content).toBe('点击了卡片「分账」的「确认」\n小应用提交的数据：{"n":4,"each":187}');
  });

  it("cannot navigate their frame anywhere: the console's pages allow no frame to load", async () => {
    const dist = path.resolve(`.tmp/test-data/web-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>witden</title>");
    fs.writeFileSync(path.join(dist, "app.js"), "");
    const h = await startHarness({ webDist: dist });
    try {
      for (const url of ["/", "/topics/t_1"]) {
        const res = await h.witden.app!.inject({ method: "GET", url });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-security-policy"]).toBe("frame-src 'none'");
      }
      const script = await h.witden.app!.inject({ method: "GET", url: "/app.js" });
      expect(script.headers["content-security-policy"]).toBeUndefined();
    } finally {
      await h.close();
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});

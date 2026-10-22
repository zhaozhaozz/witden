import { expect, test } from "@playwright/test";
import { emit, workspace } from "./workspace.fixture";

const webhookText = `Webhook触发：代码检视与 Issue 分诊

## 处理要求

只处理本次事件，保留对应话题中的上下文。

- 先确认事件类型和目标分支。
- **检查变更范围**，完成后在对应位置回复。

\`\`\`json
{"event":"pull_request","action":"opened","base":"main"}
\`\`\`

[查看文档](https://example.com/docs)
`;

test("system notifications use ordinary message headers and Markdown, with the sender taken from their source", async ({
  page,
}) => {
  const { state, errors } = await workspace(page);
  const notice = (id: string, source: string, content: string) => ({
    ...state.messages[0],
    id,
    source,
    content,
    author_type: "system",
    author_id: null,
  });
  state.messages = [
    notice("webhook", "webhook", webhookText),
    notice("schedule", "schedule", "定时触发：每周检查\n\n1. 检查发布状态。\n2. 整理待办。"),
    { ...notice("system", "internal", "这次处理已停止。"), task_id: "task-1" },
    notice("unknown", "future-source", "未知来源通知仍可阅读。"),
    { ...state.messages[0], id: "human", content: "Webhook触发：这只是我输入的文字。" },
  ];
  await page.reload();
  const messages = page.locator(".msg-system");
  await expect(messages).toHaveCount(4);
  const hook = messages.filter({ has: page.getByRole("heading", { name: "处理要求" }) });
  await expect(hook).toHaveCSS("display", "grid");
  await expect(hook.locator(".msg-author")).toHaveText("Webhook");
  await expect(hook.locator(".msg-gutter .avatar-system")).toHaveCount(1);
  await expect(hook.locator(".msg-head time")).toBeVisible();
  await expect(hook.locator(".msg-head .tag")).toHaveCount(0);
  await expect(hook.locator(".msg-text")).not.toHaveCSS("text-align", "center");
  await expect(hook.locator(".msg-text")).toHaveCSS("font-size", "15px");
  await expect(hook.locator("li")).toHaveCount(2);
  await expect(hook.locator("strong")).toHaveText("检查变更范围");
  await expect(hook.locator("pre")).toContainText('"pull_request"');
  await expect(hook.getByRole("link", { name: "查看文档" })).toHaveAttribute("href", "https://example.com/docs");
  expect(await hook.evaluate((el) => getComputedStyle(el, "::before").content)).toBe("none");
  await expect(messages.nth(1).locator(".msg-author")).toHaveText("定时触发");
  await expect(messages.nth(1).locator("ol li")).toHaveCount(2);
  await expect(messages.nth(2).locator(".msg-author")).toHaveText("系统");
  await expect(messages.nth(2).getByRole("link", { name: "任务详情" })).toHaveAttribute("href", "/tasks/task-1");
  await expect(messages.nth(3).locator(".msg-author")).toHaveText("系统");
  await expect(page.locator(".msg-human").filter({ hasText: "这只是我输入的文字" })).toHaveCount(1);
  await hook.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".tmp/system-messages-desktop.png" });
  const avatar = await hook.locator(".msg-gutter .avatar-system").getAttribute("style");
  const next = notice("webhook-next", "webhook", "Webhook触发：检查后续事件\n\n**只处理新的变更。**");
  state.messages.push(next);
  await emit(page, "message.created", next);
  await expect(messages).toHaveCount(5);
  await expect(messages.last().locator(".msg-author")).toHaveText("Webhook");
  expect(await messages.last().locator(".msg-gutter .avatar-system").getAttribute("style")).toBe(avatar);
  await page.reload();
  await expect(messages.last().locator("strong")).toHaveText("只处理新的变更。");
  expect(errors).toEqual([]);
});

test("long system instructions stay readable on narrow screens and deleted notices show only a placeholder", async ({
  page,
}) => {
  const { state, errors } = await workspace(page);
  const hook = {
    ...state.messages[0],
    id: "long-hook",
    author_type: "system",
    source: "webhook",
    content: webhookText + "\n\n" + "非常长的说明用于验证自动换行。".repeat(160),
  };
  state.messages = [
    hook,
    { ...hook, id: "deleted-hook", content: "DELETED BODY", attachments: ["deleted-file"], deleted: true },
  ];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
  const notices = page.locator(".msg-system");
  await expect(notices).toHaveCount(2);
  await expect(notices.first().locator(".msg-author")).toHaveText("Webhook");
  await expect(notices.last()).toContainText("消息已删除");
  await expect(notices.last()).not.toContainText("DELETED BODY");
  await expect(notices.last().locator(".msg-attachments,.msg-images,.msg-approval,.badge-role")).toHaveCount(0);
  await notices.first().locator(".msg-head").scrollIntoViewIfNeeded();
  expect(await notices.first().evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".tmp/system-messages-mobile.png" });
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

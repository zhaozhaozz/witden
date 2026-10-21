import { expect, test } from "@playwright/test";
import { emit, live, progressText, workspace } from "./workspace.fixture";

test("working events retain rendered diagrams and table DOM", async ({ page }) => {
  const { errors } = await workspace(page);
  const diagram = await page.locator(".md-mermaid svg").elementHandle();
  const table = await page.locator(".md-table table").elementHandle();
  await emit(page, "task.step", { task_id: "task-1" });
  await page.waitForTimeout(700);
  expect.soft(await diagram?.evaluate((el) => el.isConnected)).toBe(true);
  expect.soft(await table?.evaluate((el) => el.isConnected)).toBe(true);
  expect(errors).toEqual([]);
});

test("tool transitions keep the streamed progress readable without shrinking it", async ({ page }) => {
  await workspace(page);
  await live(page, { phase: "writing", offset: 0, delta: progressText });
  const body = page.locator(".msg-live .msg-text");
  await expect(body).toContainText("检查项目 12");
  const before = await body.boundingBox();
  await live(page, { phase: "tool", tool: "exec" });
  await expect(page.locator(".msg-live")).toContainText("检查项目 12");
  const after = await page.locator(".msg-live .msg-text").boundingBox({ timeout: 2000 });
  expect(after?.height).toBeGreaterThanOrEqual((before?.height ?? 0) - 1);
  await live(page, { phase: "writing", offset: 0, delta: "检查结果：" });
  await expect(page.locator(".msg-live")).toContainText("检查项目 12");
});

test("refreshing execution history retains rows while a request is pending", async ({ page }) => {
  const { state } = await workspace(page);
  await page.locator(".session-toggle").click();
  await expect(page.locator(".run-item")).toHaveCount(1);
  const row = await page.locator(".run-item").elementHandle();
  state.runDelay = 900;
  state.runStatus = "completed";
  await emit(page, "task.status", { id: "task-1", status: "completed", owner_role_id: "role-1" });
  await page.waitForResponse((r) => r.url().includes("/sessions"));
  await expect(page.locator(".run-item")).toBeVisible();
  expect(await row?.evaluate((el) => el.isConnected)).toBe(true);
});

test("scrolling up during streaming keeps the reading position and draft", async ({ page }) => {
  await workspace(page);
  const input = page.locator(".composer textarea");
  await input.fill("保留这份草稿");
  await live(page, { phase: "writing", offset: 0, delta: progressText.repeat(3) });
  const timeline = page.locator(".timeline");
  await timeline.evaluate((el) => {
    el.scrollTop = 120;
    el.dispatchEvent(new Event("scroll"));
  });
  const before = await timeline.evaluate((el) => el.scrollTop);
  await live(page, { phase: "tool", tool: "exec" });
  await live(page, { phase: "thinking" });
  await page.waitForTimeout(100);
  expect(await timeline.evaluate((el) => el.scrollTop)).toBeCloseTo(before, 0);
  await expect(input).toHaveValue("保留这份草稿");
  await page.getByRole("button", { name: "回到最新" }).click();
  await expect.poll(() => timeline.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
});

test("desktop layout and composer", async ({ page }, info) => {
  const { state, errors } = await workspace(page);
  await page.screenshot({ path: info.outputPath("workspace.png") });
  await page.locator(".composer textarea").fill("@dev");
  await page.getByRole("option").first().click();
  await page.locator(".composer textarea").press("End");
  await page.locator(".composer textarea").pressSequentially(" 请继续检查");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".composer textarea")).toHaveValue("");
  expect(state.sent[0].mentions).toEqual([{ type: "role", id: "role-1" }]);
  expect(errors).toEqual([]);
});

test("narrow screens keep navigation, work details and the draft usable", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { errors } = await workspace(page);
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await page.locator(".composer textarea").fill("窄屏上继续这项工作");
  await page.screenshot({ path: info.outputPath("workspace-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole("button", { name: "打开工作区" }).click();
  await expect(page.getByRole("tab", { name: "设置", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await expect(page.locator(".composer textarea")).toHaveValue("窄屏上继续这项工作");
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "打开导航" })).toBeFocused();
  await expect(page.locator(".composer textarea")).toHaveValue("窄屏上继续这项工作");
  expect(errors).toEqual([]);
});

test("role computer chips stay aligned on hover and keyboard focus", async ({ page }) => {
  await workspace(page);
  const row = page.locator(".side-row").first();
  const chip = row.locator(".mark-chip");
  const before = await chip.boundingBox();
  await row.hover();
  expect((await chip.boundingBox())?.x).toBe(before?.x);
  await row.getByRole("link", { name: "编辑 AI 员工 研发助手" }).focus();
  expect((await chip.boundingBox())?.x).toBe(before?.x);
});

test("stream completion leaves one persisted answer and follows asynchronously rendered content", async ({ page }) => {
  const { state, errors } = await workspace(page);
  const content = "交付完成\n\n```mermaid\nflowchart LR\nA[检查] --> B[完成]\n```";
  await live(page, { phase: "writing", offset: 0, delta: content });
  await expect(page.locator(".msg-live .mono-block")).toContainText("flowchart");
  const answer = {
    ...state.messages[1],
    id: "final",
    task_id: "task-1",
    content,
  };
  state.messages.push(answer);
  state.runStatus = "completed";
  await emit(page, "message.created", answer);
  await emit(page, "task.status", { id: "task-1", status: "completed", owner_role_id: "role-1" });
  await expect(page.locator(".msg-live")).toHaveCount(0);
  await expect(page.locator(".md-mermaid svg")).toHaveCount(2);
  await expect(page.getByText("交付完成", { exact: true })).toHaveCount(1);
  await expect
    .poll(() => page.locator(".timeline").evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThan(2);
  expect(errors).toEqual([]);
});

test("a message image stays open while work status refreshes", async ({ page }) => {
  const { state, errors } = await workspace(page);
  await emit(page, "message.created", {
    ...state.messages[1],
    id: "picture",
    content:
      "![预览](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=)",
  });
  await page.locator(".md-img").click();
  await expect(page.getByRole("dialog", { name: "预览" })).toBeVisible();
  await emit(page, "task.step", { task_id: "task-1" });
  await page.waitForTimeout(700);
  await expect(page.getByRole("dialog", { name: "预览" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("maximizing the computer keeps the conversation draft and computer view mounted", async ({ page }) => {
  const { errors } = await workspace(page);
  await page.locator(".composer textarea").fill("切换布局后继续");
  await page.getByRole("tab", { name: "虚拟电脑" }).click();
  await expect(page.getByText("虚拟电脑未运行", { exact: true })).toBeVisible();
  const computer = await page.locator(".topic-computer").elementHandle();
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.getByRole("button", { name: "打开对话", exact: true }).click();
  await expect(page.locator(".chat-float textarea")).toHaveValue("切换布局后继续");
  await page.getByRole("button", { name: "还原布局", exact: true }).click();
  await expect(page.locator(".composer textarea")).toHaveValue("切换布局后继续");
  expect(await computer?.evaluate((el) => el.isConnected)).toBe(true);
  expect(errors).toEqual([]);
});

test("a link to a work tab opens it even with a closed panel preference on mobile", async ({ page }) => {
  const { errors } = await workspace(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem("witden.topicPanel", "0"));
  await page.goto("/topics/topic-1?panel=files");
  await expect(page.getByRole("tab", { name: "文件", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "关闭工作区" })).toBeVisible();
  expect(errors).toEqual([]);
});

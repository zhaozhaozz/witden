import { expect, test } from "@playwright/test";
import type { TaskStep } from "../src/api/types";
import { emit, live, workspace } from "./workspace.fixture";

const steps: TaskStep[] = [
  { seq: 1, kind: "user", payload: { content: "检查项目并运行测试" } },
  {
    seq: 2,
    kind: "assistant",
    payload: {
      reasoning_content: "先查看项目脚本，再确认测试结果。",
      content: "我会先检查当前实现。",
      tool_calls: [
        {
          id: "cmd-1",
          function: { name: "run_command", arguments: JSON.stringify({ command: "npm test", workdir: "/workspace" }) },
        },
        { id: "cmd-2", function: { name: "run_command", arguments: JSON.stringify({ command: "git diff --check" }) } },
      ],
    },
  },
  {
    seq: 3,
    kind: "tool",
    payload: { tool_call_id: "cmd-1", name: "run_command", content: "[exit code 0]\n48 tests passed" },
  },
  { seq: 4, kind: "tool", payload: { tool_call_id: "cmd-2", name: "run_command", content: "[exit code 0]" } },
];
async function setup(page: Parameters<typeof workspace>[0]) {
  const result = await workspace(page);
  result.state.steps = structuredClone(steps);
  result.state.stats.rounds = 2;
  result.state.stats.commands = 2;
  result.state.stats.tokens = 3840;
  await emit(page, "task.progress", { task_id: "task-1", seq: 4 });
  await expect(page.locator(".execution-stats")).toContainText("3.8K");
  return result;
}

test("collapsed progress shows live totals and a clock without downloading the transcript", async ({ page }) => {
  const { state, errors } = await setup(page);
  await expect(page.locator(".execution-stats")).toContainText("2 轮");
  await expect(page.locator(".execution-stats")).toContainText("2 条命令");
  expect(state.activityRequests.every((q) => !q.includes("steps=true"))).toBe(true);
  expect(state.detailRequests).toEqual([]);
  const summary = await page.locator(".execution-toggle").elementHandle();
  const before = await page.locator(".execution-toggle").boundingBox();
  const statsBefore = await page.locator(".execution-stats").boundingBox();
  await expect(page.locator(".execution-progress")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator(".execution-progress")).toHaveCSS("border-top-width", "0px");
  await live(page, { phase: "tool", tool: "run_command" });
  await expect(page.locator(".execution-status")).toHaveText("正在执行命令");
  state.stats.tokens = 5820;
  state.stats.rounds = 3;
  await emit(page, "task.progress", { task_id: "task-1", seq: 5 });
  await expect(page.locator(".execution-stats")).toContainText("5.8K");
  expect(await summary?.evaluate((el) => el.isConnected)).toBe(true);
  expect((await page.locator(".execution-toggle").boundingBox())?.height).toBe(before?.height);
  expect((await page.locator(".execution-stats").boundingBox())?.x).toBe(statsBefore?.x);
  expect(errors).toEqual([]);
});

test("one row per operation expands actual reasoning, command arguments and the full result inside a fixed height", async ({
  page,
}) => {
  const { state, errors } = await setup(page);
  state.fullSteps.set(3, {
    ...steps[2],
    payload: { ...steps[2].payload, content: "output\n".repeat(800) + "END OF COMPLETE OUTPUT" },
  });
  await page.locator(".execution-toggle").click();
  const scroll = page.getByRole("region", { name: "执行过程" });
  await expect(scroll.locator(".execution-row").filter({ hasText: "npm test" })).toHaveCount(1);
  const before = await scroll.boundingBox();
  await scroll.locator(".execution-row").filter({ hasText: "先查看项目脚本" }).click();
  await expect(scroll.locator(".execution-detail")).toContainText("先查看项目脚本，再确认测试结果。");
  await scroll.locator(".execution-row").filter({ hasText: "npm test" }).click();
  await expect(scroll.locator(".execution-detail").filter({ hasText: "参数" })).toContainText(
    '"workdir": "/workspace"',
  );
  await expect(scroll.locator(".execution-detail").filter({ hasText: "参数" })).toContainText("END OF COMPLETE OUTPUT");
  expect((await scroll.boundingBox())?.height).toBe(before?.height);
  expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(state.detailRequests.filter((s) => s === 2)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("incremental updates preserve open rows and scroll position, and earlier pages remain available", async ({
  page,
}) => {
  const { state, errors } = await setup(page);
  state.steps = Array.from({ length: 205 }, (_, i) => ({
    seq: i + 1,
    kind: "assistant",
    payload: { content: `第 ${i + 1} 步已检查` },
  }));
  await page.locator(".execution-toggle").click();
  const scroll = page.getByRole("region", { name: "执行过程" });
  await expect(scroll.locator(".execution-row").filter({ hasText: "第 106 步" })).toHaveCount(1);
  const row = scroll.locator(".execution-row").filter({ hasText: "第 110 步" });
  await row.click();
  const handle = await row.elementHandle();
  await scroll.evaluate((el) => {
    el.scrollTop = 110;
    el.dispatchEvent(new Event("scroll"));
  });
  const top = await scroll.evaluate((el) => el.scrollTop);
  state.steps.push({ seq: 206, kind: "assistant", payload: { content: "下一步" } });
  await emit(page, "task.progress", { task_id: "task-1", seq: 206 });
  await expect(scroll.locator(".execution-row").filter({ hasText: "下一步" })).toHaveCount(1);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeCloseTo(top, 0);
  expect(await handle?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await scroll.getByRole("button", { name: "加载更早的过程" }).click();
  await expect(scroll.locator(".execution-row").filter({ hasText: "第 6 步" })).toHaveCount(1);
  await scroll.getByRole("button", { name: "加载更早的过程" }).click();
  await expect(scroll.locator(".execution-row").filter({ hasText: "第 1 步" })).toHaveCount(1);
  await expect(scroll.getByRole("button", { name: "加载更早的过程" })).toHaveCount(0);
  expect(state.activityRequests.some((q) => q.includes("after=205"))).toBe(true);
  expect(errors).toEqual([]);
});

test("a completed record stays with its answer, preserves open details and can be reopened after reload", async ({
  page,
}) => {
  const { state, errors } = await setup(page);
  const panel = page.locator('[data-execution-task="task-1"]');
  await panel.locator(".execution-toggle").click();
  const command = panel.locator(".execution-row").filter({ hasText: "npm test" });
  await command.click();
  const handle = await command.elementHandle();
  await expect(panel.locator(".execution-detail")).toContainText("48 tests passed");
  const answer = { ...state.messages[1], id: "answer-1", task_id: "task-1", content: "发布检查已完成。" };
  state.messages.push(answer);
  await emit(page, "message.created", answer);
  const later = { ...state.messages[0], id: "later", content: "接下来检查另外一个项目。" };
  state.messages.push(later);
  await emit(page, "message.created", later);
  state.runStatus = "completed";
  await emit(page, "task.status", { id: "task-1", status: "completed", owner_role_id: "role-1" });
  await expect(panel.locator(".execution-status")).toHaveText("已完成");
  expect(await handle?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(command).toHaveAttribute("aria-expanded", "true");
  expect(await panel.evaluate((el) => el.previousElementSibling?.textContent)).toContain("发布检查已完成");
  expect(await panel.evaluate((el) => el.nextElementSibling?.textContent)).toContain("接下来检查另外一个项目");
  const total = await panel.locator(".execution-stats").innerText();
  await page.waitForTimeout(1100);
  expect(await panel.locator(".execution-stats").innerText()).toBe(total);
  await panel.locator(".execution-toggle").click();
  await expect(panel).toBeVisible();
  await expect(panel.locator(".execution-scroll")).toHaveCount(0);
  await panel.locator(".execution-toggle").click();
  await expect(panel.locator(".execution-scroll")).toContainText("npm test");
  state.activityRequests = [];
  await page.reload();
  await expect(panel.locator(".execution-status")).toHaveText("已完成");
  expect(state.activityRequests.every((q) => !q.includes("steps=true"))).toBe(true);
  expect(await panel.evaluate((el) => el.previousElementSibling?.textContent)).toContain("发布检查已完成");
  expect(await panel.evaluate((el) => el.nextElementSibling?.textContent)).toContain("接下来检查另外一个项目");
  await panel.locator(".execution-toggle").click();
  await expect(panel.locator(".execution-scroll")).toContainText("npm test");
  expect(errors).toEqual([]);
});

test("collapsed completion before the answer remains anchored and later runs keep separate records", async ({
  page,
}) => {
  const { state, errors } = await setup(page);
  const first = page.locator('[data-execution-task="task-1"]');
  state.runStatus = "completed";
  await emit(page, "task.status", { id: "task-1", status: "completed", owner_role_id: "role-1" });
  await expect(first.locator(".execution-status")).toHaveText("已完成");
  await expect(first.locator(".execution-toggle")).toHaveAttribute("aria-expanded", "false");
  const partial = { ...state.messages[1], id: "partial-1", task_id: "task-1", content: "已完成第一项检查。" };
  const answer = { ...partial, id: "answer-1", content: "全部检查完成。" };
  for (const message of [partial, answer]) {
    state.messages.push(message);
    await emit(page, "message.created", message);
  }
  await expect(first).toHaveCount(1);
  expect(await first.evaluate((el) => el.previousElementSibling?.textContent)).toContain("全部检查完成");
  state.otherRuns.set("task-2", { status: "running", rounds: 1, commands: 1, tokens: 2500 });
  await emit(page, "task.created", { id: "task-2", status: "running", owner_role_id: "role-1" });
  const second = page.locator('[data-execution-task="task-2"]');
  await expect(second.locator(".execution-stats")).toContainText("2.5K");
  await expect(first.locator(".execution-stats")).toContainText("3.8K");
  const nextAnswer = { ...answer, id: "answer-2", task_id: "task-2", content: "第二项工作完成。" };
  state.messages.push(nextAnswer);
  await emit(page, "message.created", nextAnswer);
  state.otherRuns.get("task-2")!.status = "completed";
  await emit(page, "task.status", { id: "task-2", status: "completed", owner_role_id: "role-1" });
  await expect(second.locator(".execution-status")).toHaveText("已完成");
  // Forwarded replies link to their source topic; they must not load an unrelated run here.
  state.messages.push({
    ...answer,
    id: "forwarded",
    task_id: "remote-task",
    topic_delivery: { source_topic_id: "elsewhere" },
  } as typeof answer);
  await page.reload();
  await expect(page.locator(".execution-progress")).toHaveCount(2);
  await expect(first.locator(".execution-status")).toHaveText("已完成");
  await expect(second.locator(".execution-status")).toHaveText("已完成");
  expect(await first.evaluate((el) => el.previousElementSibling?.textContent)).toContain("全部检查完成");
  expect(await second.evaluate((el) => el.previousElementSibling?.textContent)).toContain("第二项工作完成");
  await page.locator(".md-mermaid svg").waitFor();
  expect(
    await first.evaluate(
      (el) =>
        el.getBoundingClientRect().top -
        el.previousElementSibling!.querySelector(".msg-text")!.getBoundingClientRect().bottom,
    ),
  ).toBeLessThanOrEqual(12);
  await page.screenshot({ path: ".tmp/retained-execution-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await page.screenshot({ path: ".tmp/retained-execution-mobile.png" });
  expect(errors).toEqual([]);
});

test("desktop and narrow layouts retain a bounded log and respect reduced motion", async ({ page }) => {
  const { errors } = await setup(page);
  await page.locator(".execution-toggle").click();
  const scroll = page.getByRole("region", { name: "执行过程" });
  await scroll.locator(".execution-row").filter({ hasText: "npm test" }).click();
  await expect(scroll.locator(".execution-detail")).toContainText("48 tests passed");
  await page.locator(".execution-toggle").click();
  await page.screenshot({ path: ".tmp/execution-progress-desktop.png" });
  await page.locator(".execution-toggle").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await page.locator(".execution-toggle").scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect((await scroll.boundingBox())!.height).toBeLessThanOrEqual(422);
  await page.locator(".execution-toggle").click();
  await page.screenshot({ path: ".tmp/execution-progress-mobile.png" });
  await page.locator(".execution-toggle").click();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  const summary = await page.locator(".execution-toggle").boundingBox();
  const stats = await page.locator(".execution-stats").boundingBox();
  const status = await page.locator(".execution-status").boundingBox();
  expect(Math.abs(stats!.y + stats!.height / 2 - status!.y - status!.height / 2)).toBeLessThan(1);
  expect(stats!.x + stats!.width).toBeLessThanOrEqual(summary!.x + summary!.width);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator(".execution-status").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  await scroll.focus();
  await expect(scroll).toBeFocused();
  expect(errors).toEqual([]);
});

test("waiting updates the status and failed or uncertain operations are labelled accurately", async ({ page }) => {
  const { state, errors } = await setup(page);
  state.steps[2] = {
    ...state.steps[2],
    payload: { ...state.steps[2].payload, content: "[exit code 2]\ncheck failed" },
  };
  state.steps[3] = { ...state.steps[3], payload: { ...state.steps[3].payload, content: "uncertain: no confirmation" } };
  state.steps[1] = {
    ...state.steps[1],
    payload: { ...state.steps[1].payload, reasoning_content: undefined, content: "" },
  };
  await page.locator(".execution-toggle").click();
  const scroll = page.getByRole("region", { name: "执行过程" });
  await expect(scroll.locator(".execution-row").filter({ hasText: "npm test" })).toContainText("失败");
  await expect(scroll.locator(".execution-row").filter({ hasText: "git diff" })).toContainText("结果不确定");
  await scroll.locator(".execution-row").filter({ hasText: "模型未返回思考文本" }).click();
  await expect(scroll.locator(".execution-detail")).toContainText("模型未返回思考文本。");
  state.runStatus = "waiting_approval";
  await emit(page, "task.status", { id: "task-1", status: "waiting_approval", owner_role_id: "role-1" });
  await expect(page.locator(".execution-status")).toHaveText("等待审批");
  await expect(page.locator(".execution-running")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a failed refresh keeps the log readable and retry catches up without closing details", async ({ page }) => {
  const { state } = await setup(page);
  await page.locator(".execution-toggle").click();
  const row = page.locator(".execution-row").filter({ hasText: "npm test" });
  await row.click();
  const handle = await row.elementHandle();
  state.activityFailure = true;
  await emit(page, "task.progress", { task_id: "task-1", seq: 5 });
  await expect(page.locator(".execution-error")).toContainText("暂时无法更新执行过程");
  await expect(row).toHaveAttribute("aria-expanded", "true");
  state.activityFailure = false;
  state.stats.tokens = 9000;
  await page.locator(".execution-error").getByRole("button", { name: "重试" }).click();
  await expect(page.locator(".execution-stats")).toContainText("9.0K");
  await expect(page.locator(".execution-error")).toHaveCount(0);
  expect(await handle?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(row).toHaveAttribute("aria-expanded", "true");
});

test("a result on a page boundary shows its request and stays expanded when the earlier page joins it", async ({
  page,
}) => {
  const { state, errors } = await setup(page);
  const request = {
    id: "old-command",
    function: { name: "run_command", arguments: JSON.stringify({ command: "earlier command" }) },
  };
  state.steps = Array.from({ length: 205 }, (_, i) => ({
    seq: i + 1,
    kind: "assistant",
    payload: { content: `Step ${i + 1}` },
  }));
  state.steps[104] = { seq: 105, kind: "assistant", payload: { content: "prepare", tool_calls: [request] } };
  state.steps[105] = {
    seq: 106,
    kind: "tool",
    payload: { name: "run_command", tool_call_id: request.id, content: "complete result" },
    request,
  };
  await page.locator(".execution-toggle").click();
  const scroll = page.getByRole("region", { name: "执行过程" });
  const row = scroll.locator(".execution-row").filter({ hasText: "earlier command" });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(scroll.locator(".execution-detail")).toContainText("complete result");
  await expect(scroll.locator(".execution-detail")).toContainText('"command": "earlier command"');
  const handle = await row.elementHandle();
  await scroll.getByRole("button", { name: "加载更早的过程" }).click();
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("aria-expanded", "true");
  expect(await handle?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(scroll.locator(".execution-detail")).toContainText("complete result");
  expect(errors).toEqual([]);
});

test("the preview shows input, output, cache and a weighted hit rate, including zero usage and narrow screens", async ({
  page,
}) => {
  const { state, errors } = await setup(page);
  const stats = page.locator(".execution-stats");
  await expect(stats).toContainText("上行 0");
  await expect(stats).toContainText("下行 0");
  await expect(stats).toContainText("缓存 0");
  await expect(stats).toContainText("缓存命中率 —");
  Object.assign(state.stats, {
    prompt_tokens: 12000,
    completion_tokens: 340,
    cached_tokens: 9060,
    cache_hit_rate: 0.755,
    tokens: 12340,
  });
  await emit(page, "task.progress", { task_id: "task-1", seq: 4 });
  await expect(stats).toContainText("上行 12K");
  await expect(stats).toContainText("下行 340");
  await expect(stats).toContainText("缓存 9.1K");
  await expect(stats).toContainText("缓存命中率 75.5%");
  await expect(stats.locator("[title^='上行']")).toHaveAttribute("title", /12,000 token/);
  await expect(stats.locator("[title^='缓存：']")).toHaveAttribute("title", /9,060 token/);
  await expect(page.locator(".execution-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: ".tmp/execution-tokens-desktop.png" });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole("button", { name: "关闭工作区" }).click();
  const summary = page.getByRole("region", { name: "执行状态与用量，可横向滚动" });
  await summary.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(await summary.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const height = (await summary.boundingBox())!.height;
  await summary.focus();
  await page.keyboard.press("End");
  // Horizontal keyboard scrolling works while the execution process stays collapsed.
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => summary.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await summary.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await page.screenshot({ path: ".tmp/execution-tokens-mobile.png" });
  const hit = stats.locator("[title^='缓存命中率']");
  const hitBox = (await hit.boundingBox())!;
  const summaryBox = (await summary.boundingBox())!;
  expect(hitBox.x).toBeGreaterThanOrEqual(summaryBox.x);
  expect(hitBox.x + hitBox.width).toBeLessThanOrEqual(summaryBox.x + summaryBox.width);
  expect((await summary.boundingBox())!.height).toBe(height);
  await expect(page.locator(".execution-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.locator(".execution-toggle").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "执行过程", exact: true })).toBeVisible();
  state.stats.cached_tokens = 0;
  state.stats.cache_hit_rate = 0;
  state.runStatus = "completed";
  const answer = { ...state.messages[1], id: "token-answer", task_id: "task-1", content: "检查完成。" };
  state.messages.push(answer);
  await emit(page, "message.created", answer);
  await emit(page, "task.status", { id: "task-1", status: "completed", owner_role_id: "role-1" });
  await expect(stats).toContainText("缓存命中率 0%");
  await page.reload();
  await expect(stats).toContainText("上行 12K");
  await expect(stats).toContainText("下行 340");
  await expect(stats).toContainText("缓存命中率 0%");
  expect(errors).toEqual([]);
});

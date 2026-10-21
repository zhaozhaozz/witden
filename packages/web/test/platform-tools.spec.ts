import { expect, test } from "@playwright/test";
import type { TaskStep } from "../src/api/types";
import { emit, workspace } from "./workspace.fixture";

const request = (seq: number, name: string, args: object): TaskStep => ({
  seq,
  kind: "assistant",
  payload: { tool_calls: [{ id: `call-${seq}`, function: { name, arguments: JSON.stringify(args) } }] },
});
const result = (seq: number, requestSeq: number, name: string, content: string): TaskStep => ({
  seq,
  kind: "tool",
  payload: { tool_call_id: `call-${requestSeq}`, name, content },
});
const calls: TaskStep[] = [
  request(1, "update_memory", { title: "发布前检查", id: "memory-1", content: "先运行回归测试，再检查服务连接。" }),
  result(2, 1, "update_memory", "记忆已更新"),
  request(3, "change_config", { method: "PATCH", path: "/api/roles/role-1", body: { description: "负责发布验证" } }),
  result(4, 3, "change_config", "配置已保存"),
  request(5, "send_message", { topic_id: "linked-topic", text: "请协作确认发布计划。" }),
  result(6, 5, "send_message", "消息已送达关联话题"),
  request(7, "run_command", { command: "npm test" }),
  result(8, 7, "run_command", "48 tests passed"),
];

test("platform tools appear directly in chat and expand without opening the full process", async ({ page }) => {
  const { state, errors } = await workspace(page);
  state.steps = structuredClone(calls);
  state.fullSteps.set(2, result(2, 1, "update_memory", "记录内容\n".repeat(800) + "完整结果尾部"));
  await emit(page, "task.progress", { task_id: "task-1", seq: 8 });
  const group = page.getByRole("group", { name: "系统工具调用" });
  await expect(group.locator(".execution-row")).toHaveCount(3);
  await expect(group).toContainText("发布前检查");
  await expect(group).toContainText("/api/roles/role-1");
  await expect(group).toContainText("请协作确认发布计划");
  await expect(group).not.toContainText("npm test");
  await expect(page.locator(".execution-toggle")).toHaveAttribute("aria-expanded", "false");
  expect(state.detailRequests).toEqual([]);
  expect(state.activityRequests.every((q) => q.includes("steps=platform"))).toBe(true);
  const row = group.getByRole("button", { name: /修改记忆/ });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(group.locator(".execution-detail")).toContainText("先运行回归测试");
  await expect(group.locator(".execution-detail")).toContainText("完整结果尾部");
  expect(await group.locator(".execution-detail").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await row.click();
  await group.getByRole("button", { name: /修改 witden 配置/ }).click();
  await expect(group.locator(".execution-detail")).toContainText('"method": "PATCH"');
  await expect(group.locator(".execution-detail")).toContainText("配置已保存");
  await group.getByRole("button", { name: /修改 witden 配置/ }).click();
  await page.screenshot({ path: ".tmp/platform-tools-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await group.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".tmp/platform-tools-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const b of await group.locator(".execution-row").all())
    expect((await b.boundingBox())!.height).toBeLessThanOrEqual(34);
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("pending calls update in place, preserve details after completion, and restore from history", async ({ page }) => {
  const { state, errors } = await workspace(page);
  state.steps = [structuredClone(calls[0])];
  state.runStatus = "waiting_approval";
  await emit(page, "task.status", { id: "task-1", owner_role_id: "role-1", status: "waiting_approval" });
  const group = page.getByRole("group", { name: "系统工具调用" });
  const row = group.locator(".execution-row");
  await expect(row).toContainText("待审批");
  await row.click();
  const handle = await row.elementHandle();
  await expect(group.locator(".execution-detail")).toContainText("尚未返回结果");
  state.steps.push(result(2, 1, "update_memory", "error: approval denied"));
  state.runStatus = "running";
  await emit(page, "task.status", { id: "task-1", owner_role_id: "role-1", status: "running" });
  await emit(page, "task.progress", { task_id: "task-1", seq: 2 });
  await expect(row).toContainText("失败");
  await expect(group.locator(".execution-detail")).toContainText("approval denied");
  expect(await handle?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(row).toHaveAttribute("aria-expanded", "true");
  const answer = { ...state.messages[1], id: "answer", task_id: "task-1", content: "这次记忆修改未获批准。" };
  state.messages.push(answer);
  await emit(page, "message.created", answer);
  state.runStatus = "completed";
  await emit(page, "task.status", { id: "task-1", owner_role_id: "role-1", status: "completed" });
  await expect(page.locator(".execution-status")).toHaveText("已完成");
  expect(await handle?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("失败");
  await row.click();
  await expect(group.locator(".execution-detail")).toContainText("approval denied");
  expect(errors).toEqual([]);
});

test("platform history paginates and keeps a cross-page operation open when its original request is loaded", async ({
  page,
}) => {
  const { state, errors } = await workspace(page);
  state.steps = Array.from({ length: 60 }, (_, i) => [
    request(i * 2 + 1, "remember", { title: `记忆 ${i + 1}`, content: "操作详情" }),
    result(i * 2 + 2, i * 2 + 1, "remember", "已保存"),
  ]).flat();
  // Odd page boundary: request 21 is older than the initial page, result 22 is its first item.
  state.steps.push(request(121, "read_config", { path: "/api/roles" }));
  await emit(page, "task.progress", { task_id: "task-1", seq: 121 });
  const group = page.getByRole("group", { name: "系统工具调用" });
  await expect(group.locator(".execution-row")).toHaveCount(51);
  const row = group.locator(".execution-row").filter({ hasText: "记忆 11" });
  await row.click();
  const handle = await row.elementHandle();
  await group.getByRole("button", { name: "加载更早的系统工具调用" }).click();
  await expect(group.locator(".execution-row")).toHaveCount(61);
  await expect(row).toHaveAttribute("aria-expanded", "true");
  expect(await handle?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(group.getByRole("button", { name: "加载更早的系统工具调用" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

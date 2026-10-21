import { expect, test } from "@playwright/test";
import type { Approval } from "../src/api/types";
import { emit, workspace } from "./workspace.fixture";

const approval = (id: string, overrides: Partial<Approval> = {}): Approval => ({
  id,
  task_id: "task-1",
  topic_id: "topic-1",
  role_id: "role-1",
  action: "exec",
  detail: { tool_call: { name: "exec", arguments: { command: "npm run check" } } },
  status: "pending",
  approver_user_ids: ["user-1"],
  decided_by: null,
  decided_at: null,
  created_at: "2026-10-21T02:00:00Z",
  can_decide: true,
  role: { id: "role-1", name: "研发助手", handle: "dev" },
  ...overrides,
});

test("work has no empty approval block and keeps the global approval entry", async ({ page }) => {
  const { errors } = await workspace(page);
  await expect(page.getByRole("tab", { name: "审批", exact: true })).toHaveCount(0);
  await expect(page.locator(".work-approvals")).toHaveCount(0);
  await expect(page.locator(".work-approval-indicator")).toHaveCount(0);
  await expect(page.locator('.sidebar a[href="/approvals"]')).toBeVisible();
  await expect(page.locator(".side-body > .work-section").first()).toContainText("对话");
  expect(errors).toEqual([]);
});

test("pending approvals come first, survive refresh and disappear after decisions", async ({ page }) => {
  const { state, errors } = await workspace(page);
  state.approvals = [approval("approval-1"), approval("approval-2"), approval("approval-old", { status: "approved" })];
  const notification = Object.assign(
    { ...state.messages[0], id: "approval-message", author_type: "system", content: "等待审批" },
    { approval_id: "approval-1" },
  );
  state.messages.push(notification);
  await emit(page, "message.created", notification);
  await emit(page, "approval.changed", { id: "approval-1", status: "pending" });
  const pending = page.getByRole("region", { name: "待审批" });
  await expect(pending.locator(".approval")).toHaveCount(2);
  await expect(page.locator(".side-body > .work-section").first()).toHaveClass(/work-approvals/);
  await expect(page.locator(".work-approval-indicator")).toHaveAttribute("title", "2 项待审批");
  const note = pending.getByRole("textbox", { name: "审批备注（可选）" }).first();
  await note.fill("确认后执行");
  const card = await pending.locator(".approval").first().elementHandle();
  state.approvalDelay = 700;
  await emit(page, "approval.changed", { id: "approval-2", status: "pending" });
  await page.waitForTimeout(1100);
  expect(await card?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(note).toHaveValue("确认后执行");
  await page.screenshot({ path: ".tmp/work-approvals-desktop.png" });
  await pending.getByRole("button", { name: "批准", exact: true }).first().click();
  await expect(pending.locator(".approval")).toHaveCount(1);
  await expect(page.locator(".msg-approval .approval-approved")).toHaveCount(1);
  await pending.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(pending).toHaveCount(0);
  await expect(page.locator(".work-approval-indicator")).toHaveCount(0);
  expect(state.decisions).toEqual([
    { id: "approval-1", approve: true, note: "确认后执行" },
    { id: "approval-2", approve: false, note: "" },
  ]);
  await expect(page.locator(".session-toggle")).toBeVisible();
  expect(errors).toEqual([]);
});

test("new approvals signal the work tab without switching tabs or exposing unauthorized controls", async ({ page }) => {
  const { state, errors } = await workspace(page);
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  state.approvals = [approval("approval-1", { can_decide: false })];
  await emit(page, "approval.changed", { id: "approval-1", status: "pending" });
  await expect(page.locator(".work-approval-indicator")).toBeVisible();
  await expect(page.getByRole("tab", { name: "记忆", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: /^工作/ }).click();
  const pending = page.getByRole("region", { name: "待审批" });
  await expect(pending).toContainText("等待审批人处理");
  await expect(pending.getByRole("button", { name: /批准|拒绝/ })).toHaveCount(0);
  expect(state.decisions).toEqual([]);
  expect(errors).toEqual([]);
});

test("the former approval link opens work at the top in a narrow DM", async ({ page }) => {
  const { state, errors } = await workspace(page, { dm: true });
  state.approvals = [approval("approval-1")];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/topics/topic-1?panel=approvals");
  await expect(page.getByRole("tab", { name: /^工作/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "待审批" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "审批", exact: true })).toHaveCount(0);
  expect(await page.locator(".side-panel").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: ".tmp/work-approvals-mobile.png" });
  expect(errors).toEqual([]);
});

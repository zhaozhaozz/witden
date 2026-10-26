import { expect, test } from "@playwright/test";
import { workspace } from "./workspace.fixture";

test("an external conversation's settings choose the AI employee working behind the bot", async ({ page }) => {
  const { state, errors } = await workspace(page, { external: true });
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  const people = page.locator(".sidebar-settings-section").first();
  // nobody is invited or removed here: the note points at the setting
  await expect(people).toContainText("「处理的 AI 员工」");
  await expect(people.getByRole("button", { name: /^(邀请|移除)$/ })).toHaveCount(0);
  const handler = page.getByLabel("处理的 AI 员工");
  await expect(handler).toHaveValue("");
  await expect(handler.locator("option").first()).toHaveText("跟随接入默认（@dev）");

  await handler.selectOption("role-2");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("改由 质量助手 @qa 处理");
  await expect(dialog).toContainText("研发助手 @dev 离开这个会话");
  await dialog.getByRole("button", { name: "更换", exact: true }).click();
  await expect.poll(() => state.topicUpdates.length).toBe(1);
  expect(state.topicUpdates[0]).toEqual({ handler_role_id: "role-2" });
  await expect(handler).toHaveValue("role-2");

  // following the connection's again
  await handler.selectOption("");
  await page.getByRole("dialog").getByRole("button", { name: "更换", exact: true }).click();
  await expect.poll(() => state.topicUpdates.length).toBe(2);
  expect(state.topicUpdates[1]).toEqual({ handler_role_id: null });
  await expect(handler).toHaveValue("");
  expect(errors).toEqual([]);
});

test("a console topic has no handling AI employee to choose", async ({ page }) => {
  const { errors } = await workspace(page);
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("处理的 AI 员工")).toHaveCount(0);
  expect(errors).toEqual([]);
});

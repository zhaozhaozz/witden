import { expect, test } from "@playwright/test";
import { workspace } from "./workspace.fixture";

test("group settings combine participants, links and configuration without losing edits", async ({ page }) => {
  const { state, errors } = await workspace(page);
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^(参与者|AI 员工|关联话题)$/ })).toHaveCount(0);
  const sections = page.locator(".sidebar-settings-section");
  await expect(sections.locator(":scope > summary")).toHaveText(["参与者", "关联话题", "话题设置"]);
  const settings = sections.last();
  await settings.getByLabel("标题", { exact: true }).fill("尚未保存的新标题");
  await sections.first().getByRole("button", { name: "移除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "移除", exact: true }).click();
  await expect(sections.first()).toContainText("0 位 AI 员工");
  await expect(settings.getByLabel("标题", { exact: true })).toHaveValue("尚未保存的新标题");
  await settings.locator("summary").click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "继续编辑" }).click();
  await settings.locator("summary").click();
  await expect(settings.getByLabel("标题", { exact: true })).toHaveValue("尚未保存的新标题");
  await settings.getByRole("button", { name: "保存设置" }).click();
  await expect.poll(() => state.topicUpdates.length).toBe(1);
  expect(state.topicUpdates[0]).toMatchObject({ title: "尚未保存的新标题" });
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(page.locator(".memory-groups")).toBeVisible();
  expect(errors).toEqual([]);
});

test("DM settings keep role details, linked topics and history cleanup together", async ({ page }) => {
  const { state, errors } = await workspace(page, { dm: true });
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  const sections = page.locator(".sidebar-settings-section");
  await expect(sections.locator(":scope > summary")).toHaveText(["AI 员工", "关联话题", "私信设置"]);
  await expect(page.getByRole("tab", { name: /^(AI 员工|关联话题)$/ })).toHaveCount(0);
  await expect(sections.first().getByRole("link", { name: "编辑 AI 员工" })).toHaveAttribute("href", "/roles/role-1");
  await expect(sections.last()).toContainText("清空私信记录");
  await expect(sections.last().getByRole("button", { name: "归档话题" })).toHaveCount(0);
  const links = sections.nth(1);
  await links.getByLabel("目标话题").selectOption("topic-2");
  await links.getByRole("button", { name: "关联话题", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认关联" }).click();
  await expect(links.getByRole("link", { name: "设计讨论" })).toBeVisible();
  expect(state.links).toHaveLength(1);
  await page.screenshot({ path: ".tmp/sidebar-settings-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".tmp/sidebar-settings-mobile.png" });
  expect(await page.locator(".side-panel").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await links.getByRole("button", { name: "解除关联" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "解除", exact: true }).click();
  await expect(links).toContainText("尚未关联其他话题");
  expect(state.links).toHaveLength(0);
  expect(errors).toEqual([]);
});

for (const oldPanel of ["people", "role", "links"]) {
  test(`the old ${oldPanel} panel link opens the combined settings`, async ({ page }) => {
    const { errors } = await workspace(page, { dm: oldPanel === "role" });
    await page.goto(`/topics/topic-1?panel=${oldPanel}`);
    await expect(page.getByRole("tab", { name: "设置", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".sidebar-settings-section")).toHaveCount(3);
    expect(errors).toEqual([]);
  });
}

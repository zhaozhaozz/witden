import { expect, test } from "@playwright/test";
import { emit, workspace } from "./workspace.fixture";

test("membership notices show role badges for both joined and departed roles, including live events", async ({
  page,
}) => {
  const { state, errors } = await workspace(page, { noRoles: true });
  const role = { id: "departed-role", name: "质量助手", handle: "qa", color: "#934a71", avatar_url: null };
  const joined = Object.assign(
    { ...state.messages[0], id: "joined", author_type: "system", content: "admin added @qa to the topic." },
    { participant_change: { action: "added", actor_name: "admin", role } },
  );
  const left = {
    ...joined,
    id: "left",
    content: "@qa left the topic.",
    participant_change: { ...joined.participant_change, action: "removed" },
  };
  state.messages = [joined, left];
  await page.reload();
  const notices = page.locator(".msg-system").filter({ has: page.locator(".badge-role") });
  await expect(notices).toHaveCount(2);
  await expect(notices.first().locator(".msg-author")).toHaveText("系统");
  await expect(notices.first().locator(".msg-gutter .avatar-system")).toHaveCount(1);
  await expect(notices.first()).toHaveCSS("display", "grid");
  await expect(notices.first()).toContainText("admin 邀请");
  await expect(notices.first()).toContainText("加入话题");
  await expect(notices.last()).toContainText("离开了话题");
  await expect(notices.last().locator(".badge-role")).toHaveAttribute("title", "质量助手 @qa");
  expect(
    await notices
      .last()
      .locator(".badge-role")
      .evaluate((el) => el.style.getPropertyValue("--badge")),
  ).toBe("#934a71");
  const live = {
    ...joined,
    id: "live",
    participant_change: {
      ...joined.participant_change,
      role: { ...role, id: "new-role", name: "设计助手", handle: "design" },
    },
  };
  state.messages.push(live);
  await emit(page, "message.created", live);
  await expect(notices).toHaveCount(3);
  await expect(notices.last()).toContainText("设计助手");
  await page.screenshot({ path: ".tmp/participant-role-badges-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
  await expect(notices.first()).toBeVisible();
  await page.screenshot({ path: ".tmp/participant-role-badges-mobile.png" });
  expect(errors).toEqual([]);
});

test("long badges fit narrow screens and deleted system messages hide their content", async ({ page }) => {
  const { state, errors } = await workspace(page, { noRoles: true });
  const role = {
    id: "long-role",
    name: "有很长名称的质量检查与验证助手".repeat(5),
    handle: "quality_".repeat(8),
    color: null,
    avatar_url: null,
  };
  const joined = Object.assign(
    { ...state.messages[0], id: "joined", author_type: "system", content: "joined" },
    { participant_change: { action: "added", actor_name: "admin", role } },
  );
  state.messages = [
    joined,
    { ...joined, id: "deleted", content: "", deleted: true },
    { ...joined, id: "old", content: "A role left the topic.", participant_change: null },
  ];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
  await expect(page.locator(".msg-system .badge-role")).toHaveCount(1);
  await expect(page.locator(".msg-system").filter({ hasText: "A role left the topic." })).toHaveCount(1);
  expect(
    await page
      .locator(".msg-system")
      .first()
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".tmp/participant-role-badges-long-mobile.png" });
  expect(errors).toEqual([]);
});

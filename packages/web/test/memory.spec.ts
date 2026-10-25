import { expect, test } from "@playwright/test";
import { emit, workspace } from "./workspace.fixture";

test("sidebar groups topic and each role's memory, showing titles until opened", async ({ page }) => {
  const { state, errors } = await workspace(page, { multipleRoles: true });
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  const notes = page.locator(".memory-groups");
  await expect(notes.getByRole("button", { name: "本周交付约定" })).toBeVisible();
  await expect(notes.getByRole("button", { name: "发布前检查" })).toBeVisible();
  await expect(notes.getByRole("button", { name: "测试覆盖规则" })).toBeVisible();
  await expect(notes.locator(".memory-text:visible")).toHaveCount(0);
  await expect(notes.getByRole("textbox")).toHaveCount(0);
  await notes.getByRole("button", { name: "发布前检查" }).focus();
  await page.keyboard.press("Enter");
  const detail = notes.locator("#memory-mem-role");
  await expect(detail).toContainText("先完成回归测试，再发布。");
  await expect(detail).toContainText("回归");
  await expect(detail).toContainText("林 添加");
  await expect(detail).toContainText("2026");
  const roles = notes.locator(".memory-group").nth(1);
  await roles.locator(":scope > summary").click();
  await expect(detail).toBeHidden();
  await roles.locator(":scope > summary").click();
  await expect(detail).toBeVisible();
  await page.screenshot({ path: ".tmp/memory-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".tmp/memory-mobile.png" });
  const qa = notes.locator(".memory-role").filter({ hasText: "质量助手" });
  await expect(qa.getByRole("button", { name: "发布前检查" })).toHaveCount(0);
  await qa.locator("summary").click();
  await expect(qa.getByRole("button", { name: "测试覆盖规则" })).toBeHidden();
  expect([...new Set(state.memoryRequests)].sort()).toEqual([
    "?scope=role&role_id=role-1",
    "?scope=role&role_id=role-2",
    "?scope=topic&topic_id=topic-1",
  ]);
  expect(errors).toEqual([]);
});

test("background work refresh preserves expanded memory and editing drafts", async ({ page }) => {
  const { state, errors } = await workspace(page);
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  const title = page.getByRole("button", { name: "发布前检查" });
  await title.click();
  const element = await title.elementHandle();
  const detail = page.locator("#memory-mem-role");
  await detail.getByRole("button", { name: "编辑", exact: true }).click();
  await detail.getByRole("textbox", { name: "内容", exact: true }).fill("尚未保存的工作约定");
  state.memoryDelay = 900;
  const beforeRequests = state.memoryRequests.length;
  state.memories.find((m) => m.id === "mem-role")!.content = "AI 员工刚更新的内容";
  await emit(page, "task.step", { task_id: "task-1" });
  await expect.poll(() => state.memoryRequests.length).toBeGreaterThan(beforeRequests);
  await expect(detail.getByRole("textbox", { name: "内容", exact: true })).toHaveValue("尚未保存的工作约定");
  await page.waitForTimeout(1100);
  expect(await element?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(title).toHaveAttribute("aria-expanded", "true");
  await expect(detail.getByRole("textbox", { name: "内容", exact: true })).toHaveValue("尚未保存的工作约定");
  await detail.getByRole("button", { name: "取消" }).click();
  await expect(detail).toContainText("AI 员工刚更新的内容");
  expect(errors).toEqual([]);
});

test("role memory can be added edited and deleted in its own sidebar group", async ({ page }) => {
  const { state, errors } = await workspace(page, { multipleRoles: true });
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  const group = page.locator(".memory-role").filter({ hasText: "研发助手" });
  await group.getByRole("button", { name: "添加 AI 员工记忆" }).click();
  await group.getByRole("textbox", { name: "标题", exact: true }).fill("新增约定");
  await group.getByRole("textbox", { name: "关键词", exact: true }).fill("验证，发布");
  await group.getByRole("textbox", { name: "内容", exact: true }).fill("检查部署结果。");
  await expect(group.getByRole("textbox", { name: "内容", exact: true })).toHaveAttribute("maxlength", "1000");
  await group.getByRole("button", { name: "添加", exact: true }).click();
  const item = group.locator(".memory-list > li").filter({ hasText: "新增约定" });
  await expect(item).toContainText("检查部署结果。");
  expect(state.memories.find((m) => m.title === "新增约定")).toMatchObject({ scope: "role", role_id: "role-1" });
  await item.getByRole("button", { name: "编辑", exact: true }).click();
  await item.getByRole("textbox", { name: "内容", exact: true }).fill("检查所有连接恢复。");
  await item.getByRole("button", { name: "保存", exact: true }).click();
  await expect(item).toContainText("检查所有连接恢复。");
  await expect(item).toContainText("修改");
  await item.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
  await expect(item).toHaveCount(0);
  expect(state.memories.map((m) => m.id)).toEqual(["mem-topic", "mem-role", "mem-role-2"]);
  expect(errors).toEqual([]);
});

test("DM keeps private conversation memory separate from the role's memory", async ({ page }) => {
  const { state, errors } = await workspace(page, { dm: true });
  state.memories = state.memories.filter((m) => m.scope !== "topic");
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  const topic = page.locator(".memory-group").first();
  await expect(topic.locator("summary")).toHaveText("私信记忆");
  await expect(topic).toContainText("暂无私信记忆");
  await expect(page.getByRole("button", { name: "发布前检查" })).toBeVisible();
  await topic.getByRole("button", { name: "添加私信记忆" }).click();
  await topic.getByRole("textbox", { name: "标题", exact: true }).fill("个人偏好");
  await topic.getByRole("textbox", { name: "内容", exact: true }).fill("只在这段私信使用。");
  await topic.getByRole("button", { name: "添加", exact: true }).click();
  expect(state.memories.find((m) => m.title === "个人偏好")).toMatchObject({ scope: "topic", topic_id: "topic-1" });
  expect(errors).toEqual([]);
});

test("memory panel handles no participants and narrow screens with long content", async ({ page }) => {
  const { state, errors } = await workspace(page, { noRoles: true });
  state.memories[0].title = "很长的标题".repeat(15);
  state.memories[0].content = "LongContentWithoutSpaces".repeat(100);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(page.locator(".memory-group").last()).toContainText("这个话题还没有 AI 员工参与");
  await page.getByRole("button", { name: state.memories[0].title }).click();
  await expect(page.locator(".memory-text")).toHaveText(state.memories[0].content);
  expect(await page.locator(".side-panel").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect([...new Set(state.memoryRequests)]).toEqual(["?scope=topic&topic_id=topic-1"]);
  expect(errors).toEqual([]);
});

test("each AI employee's skills show name and description, open to rendered instructions, and can be changed", async ({
  page,
}) => {
  const { state, errors } = await workspace(page, { multipleRoles: true });
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  const skills = page.locator(".memory-group").filter({ has: page.locator("summary", { hasText: "AI 员工技能" }) });
  const dev = skills.locator(".skill-role").filter({ hasText: "研发助手" });
  const release = dev.getByRole("button", { name: /release-check/ });
  await expect(release).toContainText("发布新版本时使用。");
  await expect(skills.locator(".skill-role").filter({ hasText: "质量助手" })).toContainText("review-pr");
  const detail = page.locator("#skill-skill-release");
  await expect(detail).toBeHidden();
  await release.click();
  await expect(detail.getByRole("heading", { name: "步骤" })).toBeVisible();
  await expect(detail).toContainText("AI 员工自己写下");

  await detail.getByRole("button", { name: "编辑", exact: true }).click();
  await detail.getByRole("textbox", { name: "内容", exact: true }).fill("1. 运行完整测试\n2. 打标签");
  await detail.getByRole("button", { name: "保存", exact: true }).click();
  await expect(detail).toContainText("打标签");
  await expect(detail).toContainText("林 修改");

  await dev.getByRole("button", { name: "添加技能" }).click();
  await dev.getByRole("textbox", { name: "名称", exact: true }).fill("Bad Name");
  await expect(dev).toContainText("名称只能用小写字母");
  await expect(dev.getByRole("button", { name: "添加", exact: true })).toBeDisabled();
  await dev.getByRole("textbox", { name: "名称", exact: true }).fill("deploy");
  await dev.getByRole("textbox", { name: "说明", exact: true }).fill("部署到预发环境时使用。");
  await dev.getByRole("textbox", { name: "内容", exact: true }).fill("先确认迁移。");
  await dev.getByRole("button", { name: "添加", exact: true }).click();
  await expect(dev.getByRole("button", { name: /deploy/ })).toContainText("部署到预发环境时使用。");
  expect(state.skills.find((s) => s.name === "deploy")).toMatchObject({ role_id: "role-1" });

  await release.click();
  await expect(detail).toBeHidden();
  await release.click();
  await detail.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
  await expect(release).toHaveCount(0);
  expect(state.skills.map((s) => s.id)).toEqual(["skill-review", "skill-new-2"]);
  expect(state.skillRequests).toContain("DELETE /api/roles/role-1/skills/skill-release");
  expect(errors).toEqual([]);
});

test("a skill's files are listed with size and executable mark, viewed inline, uploaded and deleted; the skill downloads as a package", async ({
  page,
}) => {
  const { state, errors } = await workspace(page, { multipleRoles: true });
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  const skills = page.locator(".memory-group").filter({ has: page.locator("summary", { hasText: "AI 员工技能" }) });
  const dev = skills.locator(".skill-role").filter({ hasText: "研发助手" });
  await dev.getByRole("button", { name: /release-check/ }).click();
  const detail = page.locator("#skill-skill-release");
  const files = detail.locator(".skill-files");
  await expect(files).toContainText("文件 1 个");
  const check = files.locator("li").filter({ hasText: "scripts/check.sh" });
  await expect(check).toContainText("21 B");
  await expect(check.locator(".tag")).toHaveText("可执行");

  await check.getByRole("button", { name: "查看 scripts/check.sh", exact: true }).click();
  await expect(check.locator(".skill-file-text")).toHaveText("#!/bin/sh\nmake check\n");
  await check.getByRole("button", { name: "收起 scripts/check.sh", exact: true }).click();
  await expect(check.locator(".skill-file-text")).toHaveCount(0);

  // Upload: the path starts as the file's name and can be changed; a script is marked executable.
  await files.getByRole("button", { name: "上传文件", exact: true }).click();
  await files.locator('input[type="file"]').setInputFiles({
    name: "tag.sh",
    mimeType: "text/x-sh",
    buffer: Buffer.from("#!/bin/sh\ngit tag\n"),
  });
  const path = files.getByRole("textbox", { name: "文件路径", exact: true });
  await expect(path).toHaveValue("tag.sh");
  await expect(files.getByRole("checkbox", { name: "可执行（脚本）" })).toBeChecked();
  await path.fill("../tag.sh");
  await expect(files).toContainText("路径中不能有空的部分");
  await expect(files.getByRole("button", { name: "上传", exact: true })).toBeDisabled();
  await path.fill("scripts/tag.sh");
  await files.getByRole("button", { name: "上传", exact: true }).click();
  const tag = files.locator("li").filter({ hasText: "scripts/tag.sh" });
  await expect(tag.locator(".tag")).toHaveText("可执行");
  await expect(files).toContainText("文件 2 个");
  expect(state.skillRequests).toContain("PUT /api/roles/role-1/skills/skill-release/files/scripts/tag.sh");

  await check.getByRole("button", { name: "删除 scripts/check.sh", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
  await expect(check).toHaveCount(0);
  expect(state.skillRequests).toContain("DELETE /api/roles/role-1/skills/skill-release/files/scripts/check.sh");

  const download = page.waitForEvent("download");
  await detail.getByRole("button", { name: "下载技能包", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("release-check.tar.gz");
  // the other AI employee's skill has no files
  await skills
    .locator(".skill-role")
    .filter({ hasText: "质量助手" })
    .getByRole("button", { name: /review-pr/ })
    .click();
  await expect(page.locator("#skill-skill-review .skill-files")).toContainText("文件 无");
  expect(errors).toEqual([]);
});

import type { Page } from "@playwright/test";
import type { Approval, Memory, RoleSkill, TaskStep } from "../src/api/types";

const now = "2026-10-20T12:00:00Z";
const computer = { id: "computer-1", name: "workspace", status: "running", color: "#527568" };
const role = { id: "role-1", name: "研发助手", handle: "dev", status: "active", instance: computer, color: "#5b7193" };
const user = { id: "user-1", name: "林", is_admin: true, is_active: true, permissions: [] };
const topic = {
  id: "topic-1",
  title: "产品工作台",
  goal: "一起把想法变成可以使用的产品。",
  kind: "group",
  status: "active",
  source: "internal",
  response_mode: "mention",
  handler_role_id: null as string | null,
  created_at: now,
  updated_at: now,
  last_message_at: now,
  can_post: true,
  participants: [
    { ...role, type: "role", joined_at: now },
    { ...user, type: "user", joined_at: now },
  ],
};
/** A Slack channel: the only kind of topic a console topic or DM may be linked with. */
const designChannel = {
  ...topic,
  id: "topic-2",
  title: "设计讨论",
  source: "slack",
  channel: {
    connection_id: "conn-1",
    connection_name: "Acme Slack",
    platform: "slack",
    conversation_id: "conv-1",
    conversation_kind: "public",
    conversation_name: "design",
    thread_key: "__channel__",
    thread_kind: "channel",
    url: null,
    role_id: role.id,
  },
};
const message = (id: string, content: string, author = "role") => ({
  id,
  content,
  topic_id: topic.id,
  task_id: null as string | null,
  author_type: author,
  author_id: (author === "role" ? role.id : user.id) as string | null,
  mentions: [],
  attachments: [],
  source: "internal",
  created_at: now,
});

export const progressText = Array.from({ length: 12 }, (_, i) => `检查项目 ${i + 1}：确认需求和实现保持一致。`).join(
  "\n",
);

export async function workspace(
  page: Page,
  options: { dm?: boolean; multipleRoles?: boolean; noRoles?: boolean; external?: boolean } = {},
) {
  const otherRole = { ...role, id: "role-2", name: "质量助手", handle: "qa" };
  const currentTopic = {
    ...topic,
    kind: options.dm ? "dm" : "group",
    // A Slack channel of the same connection: its AI employee is chosen in its settings.
    ...(options.external
      ? {
          source: "slack",
          channel: { ...designChannel.channel, conversation_id: "conv-2", conversation_name: "product" },
        }
      : {}),
    participants: options.noRoles
      ? [topic.participants[1]]
      : [...topic.participants, ...(options.multipleRoles ? [{ ...otherRole, type: "role", joined_at: now }] : [])],
  };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  const state = {
    runStatus: "running",
    finishedAt: new Date().toISOString(),
    otherRuns: new Map<string, { status: string; rounds: number; commands: number; tokens: number }>(),
    activityDelay: 0,
    activityFailure: false,
    activityRequests: [] as string[],
    detailRequests: [] as number[],
    steps: [] as TaskStep[],
    fullSteps: new Map<number, TaskStep>(),
    stats: {
      rounds: 0,
      commands: 0,
      tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: 0,
      cache_hit_rate: null as number | null,
      started_at: new Date(Date.now() - 65000).toISOString(),
    },
    runDelay: 0,
    approvalDelay: 0,
    approvals: [] as Approval[],
    decisions: [] as { id: string; approve: boolean; note: string; scope?: "task_run" }[],
    memoryDelay: 0,
    memoryRequests: [] as string[],
    topicUpdates: [] as Record<string, unknown>[],
    memories: [
      {
        id: "mem-topic",
        scope: "topic",
        topic_id: topic.id,
        title: "本周交付约定",
        keywords: ["交付", "验收"],
        content: "周五完成验收。\n完整保留第二行约定。",
      },
      {
        id: "mem-role",
        scope: "role",
        role_id: role.id,
        title: "发布前检查",
        keywords: ["发布", "回归"],
        content: "先完成回归测试，再发布。",
      },
      {
        id: "mem-role-2",
        scope: "role",
        role_id: otherRole.id,
        title: "测试覆盖规则",
        keywords: [],
        content: "覆盖主要流程和边界条件。",
      },
    ].map((m) => ({
      role_id: null,
      topic_id: null,
      space_id: null,
      user_id: null,
      source_message_ids: [],
      created_by_type: "user",
      created_by_id: user.id,
      created_at: now,
      updated_at: null,
      ...m,
    })) as Memory[],
    skillRequests: [] as string[],
    /** The contents of skill files, by URL path. */
    skillFileText: {
      "/api/roles/role-1/skills/skill-release/files/scripts/check.sh": "#!/bin/sh\nmake check\n",
    } as Record<string, string>,
    skills: [
      {
        id: "skill-release",
        role_id: role.id,
        name: "release-check",
        description: "发布新版本时使用。",
        content: "## 步骤\n\n1. 运行完整测试\n2. 更新变更记录",
        created_by_type: "role",
        created_by_id: role.id,
        files: [
          {
            id: "skf-check",
            skill_id: "skill-release",
            path: "scripts/check.sh",
            size: 21,
            sha256: "",
            executable: true,
            updated_by_type: "role",
            updated_by_id: role.id,
            created_at: now,
            updated_at: now,
          },
        ],
      },
      {
        id: "skill-review",
        role_id: otherRole.id,
        name: "review-pr",
        description: "审查拉取请求时使用。",
        content: "先看测试，再看实现。",
        created_by_type: "user",
        created_by_id: user.id,
        files: [],
      },
    ].map((s) => ({
      ...s,
      updated_by_type: s.created_by_type,
      updated_by_id: s.created_by_id,
      created_at: now,
      updated_at: now,
    })) as RoleSkill[],
    sent: [] as Record<string, unknown>[],
    messages: [
      message("m1", "帮我梳理产品发布流程，并检查交付前需要完成的工作。", "user"),
      message(
        "m2",
        "## 发布计划\n\n我们可以从三个阶段开始，逐步确认每个环节的结果。\n\n```mermaid\nflowchart LR\nA[准备] --> B[验证] --> C[发布]\n```\n\n| 阶段 | 需要完成的工作 |\n| --- | --- |\n| 准备 | 核对需求与变更范围 |\n| 验证 | 检查关键流程和边界情况 |\n| 发布 | 确认运行状态与回退方式 |\n\n我会先检查现有实现，再汇总需要你确认的事项。",
      ),
    ],
  };
  await page.addInitScript(() => {
    localStorage.setItem("witden.token", "browser-test");
    if (localStorage.getItem("witden.topicPanel") === null) localStorage.setItem("witden.topicPanel", "1");
    const streams = new Set<FakeEvents>();
    class FakeEvents extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      onopen: (() => void) | null = null;
      constructor(public url: string) {
        super();
        streams.add(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {
        streams.delete(this);
        this.readyState = 2;
      }
    }
    Object.assign(window, {
      EventSource: FakeEvents,
      emitTopic: (type: string, data: unknown) => {
        for (const stream of streams)
          if (stream.url.includes("topic_id="))
            stream.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
      },
    });
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      let json: unknown;
      if (path === "/api/auth/me") json = user;
      else if (path === "/api/users") json = [user];
      else if (path === "/api/roles") json = [role, ...(options.multipleRoles || options.external ? [otherRole] : [])];
      else if (path === "/api/setup") json = { needed: false };
      else if (path === "/api/instances/computer-1")
        json = { ...computer, status: "stopped", spec: { kind: "desktop" }, operator: null };
      else if (path === "/api/topics") json = [currentTopic, designChannel];
      else if (path === "/api/topics/topic-1") {
        if (req.method() === "PATCH") {
          const body = req.postDataJSON();
          state.topicUpdates.push(body);
          Object.assign(currentTopic, body);
        }
        json = currentTopic;
      } else if (path === "/api/topics/topic-1/participants/role/role-1" && req.method() === "DELETE") {
        currentTopic.participants = currentTopic.participants.filter((p) => p.id !== role.id);
        json = currentTopic;
      } else if (path === "/api/memories") {
        state.memoryRequests.push(url.search);
        if (req.method() === "POST") {
          const body = req.postDataJSON();
          const m = {
            ...state.memories[0],
            ...body,
            id: `mem-new-${state.memories.length}`,
            keywords: String(body.keywords).split(/[，,]/).filter(Boolean),
          };
          state.memories.push(m);
          json = m;
        } else {
          await new Promise((r) => setTimeout(r, state.memoryDelay));
          json = state.memories.filter(
            (m) =>
              m.scope === url.searchParams.get("scope") &&
              (m.scope === "role"
                ? m.role_id === url.searchParams.get("role_id")
                : m.topic_id === url.searchParams.get("topic_id")),
          );
        }
      } else if (path.startsWith("/api/memories/")) {
        const id = path.split("/").at(-1);
        if (req.method() === "DELETE") {
          state.memories = state.memories.filter((m) => m.id !== id);
          json = { ok: true };
        } else {
          const body = req.postDataJSON();
          state.memories = state.memories.map((m) =>
            m.id === id
              ? {
                  ...m,
                  ...body,
                  keywords: String(body.keywords).split(/[，,]/).filter(Boolean),
                  updated_at: "2026-10-21T01:00:00Z",
                }
              : m,
          );
          json = state.memories.find((m) => m.id === id);
        }
      } else if (/^\/api\/roles\/[^/]+\/skills\/[^/]+\/(files\/|archive$)/.test(path)) {
        // a skill's files (by path) and its package
        const [, , , , , skillId, kind, ...rest] = path.split("/");
        const filePath = rest.map(decodeURIComponent).join("/");
        state.skillRequests.push(`${req.method()} ${path}`);
        const skill = state.skills.find((s) => s.id === skillId)!;
        if (kind === "archive")
          return route.fulfill({ body: Buffer.from([0x1f, 0x8b, 0x08]), contentType: "application/gzip" });
        if (req.method() === "GET")
          return route.fulfill({ body: state.skillFileText[path] ?? "", contentType: "application/octet-stream" });
        if (req.method() === "PUT") {
          const body = req.postDataBuffer()?.toString("latin1") ?? "";
          const file = {
            ...skill.files[0],
            id: `skf-${filePath}`,
            skill_id: skillId,
            path: filePath,
            size: 12,
            executable: /name="executable"\r\n\r\ntrue/.test(body),
            updated_by_type: "user" as const,
            updated_by_id: user.id,
          };
          skill.files = [...skill.files.filter((f) => f.path !== filePath), file];
          json = file;
        } else {
          skill.files = skill.files.filter((f) => f.path !== filePath);
          json = { ok: true };
        }
      } else if (/^\/api\/roles\/[^/]+\/skills(\/[^/]+)?$/.test(path)) {
        const [, , , roleId, , skillId] = path.split("/");
        state.skillRequests.push(`${req.method()} ${path}`);
        if (req.method() === "POST") {
          const s = {
            ...state.skills[0],
            ...req.postDataJSON(),
            files: [],
            id: `skill-new-${state.skills.length}`,
            role_id: roleId,
            created_by_type: "user",
            created_by_id: user.id,
            updated_by_type: "user",
            updated_by_id: user.id,
          };
          state.skills.push(s);
          json = s;
        } else if (req.method() === "PATCH") {
          state.skills = state.skills.map((s) =>
            s.id === skillId
              ? {
                  ...s,
                  ...req.postDataJSON(),
                  updated_by_type: "user",
                  updated_by_id: user.id,
                  updated_at: "2026-10-21T01:00:00Z",
                }
              : s,
          );
          json = state.skills.find((s) => s.id === skillId);
        } else if (req.method() === "DELETE") {
          state.skills = state.skills.filter((s) => s.id !== skillId);
          json = { ok: true };
        } else json = state.skills.filter((s) => s.role_id === roleId);
      } else if (path === "/api/topics/topic-1/messages") {
        if (req.method() === "POST") {
          const body = req.postDataJSON();
          state.sent.push(body);
          const next = message(`sent-${state.sent.length}`, body.content, "user");
          state.messages.push(next);
          json = { ...next, tasks: [] };
        } else json = state.messages;
      } else if (path === "/api/topics/topic-1/sessions") {
        json = [
          {
            id: "session-1",
            role_id: role.id,
            role,
            runs: 3,
            context_tokens: 8200,
            compact_at: 96000,
            open_run: state.runStatus === "completed" ? null : { id: "task-1", status: state.runStatus },
          },
        ];
      } else if (path === "/api/tasks") {
        if (url.searchParams.has("session_id")) await new Promise((r) => setTimeout(r, state.runDelay));
        json =
          url.searchParams.get("kind") === "task"
            ? []
            : [
                {
                  id: "task-1",
                  title: "检查发布流程",
                  owner_role_id: role.id,
                  status: state.runStatus,
                  kind: "conversation",
                  created_at: now,
                  updated_at: now,
                  requester: user,
                },
              ];
      } else if (/^\/api\/tasks\/[^/]+\/activity$/.test(path)) {
        state.activityRequests.push(url.search);
        if (state.activityFailure)
          return route.fulfill({ status: 503, json: { error: { message: "temporarily unavailable" } } });
        const after = url.searchParams.get("after");
        const before = url.searchParams.get("before");
        const mode = url.searchParams.get("steps");
        const withSteps = mode === "true" || mode === "platform";
        const platformNames = new Set([
          "remember",
          "recall",
          "update_memory",
          "forget",
          "read_config",
          "change_config",
          "send_message",
          "message_role",
          "delegate_task",
          "contact_role",
        ]);
        const platformCalls = (s: TaskStep) =>
          ((s.payload.tool_calls as { id: string; function: { name: string; arguments: unknown } }[]) ?? []).filter(
            (c) => platformNames.has(c.function.name),
          );
        const sourceSteps =
          mode === "platform"
            ? state.steps
                .filter((s) =>
                  s.kind === "assistant"
                    ? platformCalls(s).length
                    : s.kind === "tool" && platformNames.has(String(s.payload.name)),
                )
                .map((s) => (s.kind === "assistant" ? { ...s, payload: { tool_calls: platformCalls(s) } } : s))
            : state.steps;
        const rows = sourceSteps.filter(
          (s) => (!after || s.seq > Number(after)) && (!before || s.seq < Number(before)),
        );
        const id = path.split("/")[3];
        const run = id === "task-1" ? { ...state.stats, status: state.runStatus } : state.otherRuns.get(id);
        if (!run) return route.fulfill({ status: 404, json: { error: { message: "task not found" } } });
        json = {
          id,
          ...state.stats,
          ...run,
          finished_at: ["completed", "failed", "cancelled"].includes(run.status) ? state.finishedAt : null,
          steps: withSteps
            ? (after ? rows.slice(0, 100) : rows.slice(-100)).map((s) => ({
                ...s,
                ...(s.kind === "tool" && mode === "platform"
                  ? { request: state.steps.flatMap(platformCalls).find((c) => c.id === s.payload.tool_call_id) }
                  : {}),
              }))
            : [],
          has_more: withSteps && rows.length > 100,
        };
        await new Promise((r) => setTimeout(r, state.activityDelay));
      } else if (path.startsWith("/api/tasks/task-1/log/")) {
        const seq = Number(path.split("/").at(-1));
        state.detailRequests.push(seq);
        json = state.fullSteps.get(seq) ?? state.steps.find((s) => s.seq === seq);
      } else if (path === "/api/approvals") {
        await new Promise((r) => setTimeout(r, state.approvalDelay));
        json = state.approvals.filter((a) => url.searchParams.get("status") === "all" || a.status === "pending");
      } else if (path.startsWith("/api/approvals/") && path.endsWith("/decide")) {
        const id = path.split("/")[3];
        const body = req.postDataJSON();
        state.decisions.push({ id, ...body });
        state.approvals = state.approvals.map((a) =>
          a.id === id
            ? {
                ...a,
                status: body.approve ? "approved" : "rejected",
                decision_scope: body.approve ? (body.scope ?? "once") : null,
                can_decide: false,
                can_allow_for_task_run: false,
                decided_by: user.id,
                decided_at: now,
              }
            : a,
        );
        json = state.approvals.find((a) => a.id === id);
      } else if (["/api/kill-switches", "/api/topics/topic-1/files"].includes(path)) json = [];
      else {
        errors.push(`Unexpected API request: ${req.method()} ${path}`);
        return route.fulfill({ status: 404, json: { error: { message: path } } });
      }
      await route.fulfill({ json });
    },
  );
  await page.goto("/topics/topic-1");
  await page
    .locator(".md-mermaid svg")
    .waitFor({ timeout: 15_000 })
    .catch(async (error) => {
      throw new Error(`${error.message}\nPage errors: ${errors.join("\n")}\n${await page.locator("body").innerText()}`);
    });
  await page.locator(".session-toggle").waitFor();
  // Let the initial reconnect refresh finish before measuring DOM retention.
  await page.waitForTimeout(650);
  return { state, errors };
}

export async function emit(page: Page, type: string, data: Record<string, unknown>) {
  await page.evaluate(
    ({ type, data }) => {
      (window as unknown as { emitTopic: (type: string, data: unknown) => void }).emitTopic(type, data);
    },
    { type, data },
  );
}

export async function live(page: Page, data: Record<string, unknown>) {
  await emit(page, "task.live", { task_id: "task-1", role_id: "role-1", ...data });
}

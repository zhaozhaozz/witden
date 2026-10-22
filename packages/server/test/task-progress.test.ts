import { afterEach, beforeEach, expect, it } from "vitest";
import { db, transaction } from "../src/db/client.js";
import { taskSteps, usageRecords, users } from "../src/db/schema.js";
import { runtime } from "../src/runtime.js";
import type { BusEvent } from "../src/services/events.js";
import { issueToken } from "../src/services/users.js";
import { call, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});
const get = (id: string, suffix = "/activity", token?: string) =>
  w.api("GET", `/api/tasks/${id}${suffix}`, { token: token ?? w.alice });

it("counts reported model rounds and tokens, and dispatched commands without counting other tools", async () => {
  const events: BusEvent[] = [];
  const stop = runtime().bus.subscribe((e) => events.push(e));
  w.scripts.dev = (_m, turn) =>
    turn === 0
      ? reply("Checking", [call("run_command", { command: "pwd" }), call("read_file", { path: "/missing" })])
      : turn === 1
        ? reply("Start a terminal", [call("terminal_start", { command: "echo hello" })])
        : reply("done");
  const id = (await w.post(w.alice, w.ids.topic, "@dev work")).tasks[0].id;
  await w.drain();
  await new Promise((r) => setTimeout(r, 100));
  stop();
  const r = await get(id);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ rounds: 3, tokens: 45, commands: 2, status: "completed", steps: [] });
  expect(r.body.finished_at).toBeTruthy();
  expect(Date.parse(r.body.started_at)).toBeLessThanOrEqual(Date.parse(r.body.finished_at));
  const progress = events.filter((e) => e.type === "task.progress" && e.data.task_id === id);
  expect(progress.length).toBeGreaterThan(3);
  for (const e of progress) {
    expect(e.channels).toEqual([`topic:${w.ids.topic}`]);
    expect(Object.keys(e.data).sort()).toEqual(["seq", "task_id"]);
  }
  const detail = await get(id, "/activity?steps=true");
  expect(detail.body.steps.some((s: any) => s.kind === "tool" && s.payload.name === "run_command")).toBe(true);
  const commandResult = detail.body.steps.find((s: any) => s.kind === "tool" && s.payload.name === "run_command");
  const full = await get(id, `/log/${commandResult.seq}`);
  expect(full.body.request.function.arguments).toContain("pwd");
  const page = await get(id, `/activity?steps=true&after=${commandResult.seq - 1}`);
  expect(page.body.steps[0].request.function.arguments).toContain("pwd");
});

it("does not count a requested or rejected command as an executed command", async () => {
  await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.alice, json: { approval_required: ["shell"] } });
  w.scripts.dev = (_m, turn) =>
    turn === 0 ? reply("", [call("run_command", { command: "must not run" })]) : reply("stopped");
  const id = (await w.post(w.alice, w.ids.topic, "@dev work")).tasks[0].id;
  await w.drain();
  expect((await get(id)).body).toMatchObject({ rounds: 1, tokens: 15, commands: 0, status: "waiting_approval" });
  const a = (await w.api("GET", "/api/approvals", { token: w.alice })).body.find((a: any) => a.task_id === id);
  expect(
    (await w.api("POST", `/api/approvals/${a.id}/decide`, { token: w.alice, json: { approve: false } })).status,
  ).toBe(200);
  await w.drain();
  expect((await get(id)).body.commands).toBe(0);
  expect(w.manager.computer(w.ids.instance).commands).toEqual([]);
});

it("paginates in both directions without losing steps and expands full stored text with secret and image protection", async () => {
  const id = (await w.post(w.alice, w.ids.topic, "@dev work")).tasks[0].id;
  const full = "line\n".repeat(1200) + "tail marker";
  await db()
    .insert(taskSteps)
    .values(
      Array.from({ length: 205 }, (_, i) => ({
        id: `progress-${i}`,
        taskId: id,
        seq: i + 1,
        kind: "assistant",
        payload: { content: full, reasoning_content: "Actual model reasoning", tool_calls: [] },
      })),
    );
  const recent = (await get(id, "/activity?steps=true")).body;
  expect(recent.steps).toHaveLength(100);
  expect(recent.steps[0].seq).toBe(106);
  expect(recent.has_more).toBe(true);
  expect(recent.steps[0].payload.content).not.toContain("tail marker");
  const middle = (await get(id, "/activity?steps=true&before=106")).body;
  expect(middle.steps[0].seq).toBe(6);
  expect(middle.steps.at(-1).seq).toBe(105);
  const first = (await get(id, "/activity?steps=true&before=6")).body;
  expect(first.steps.map((s: any) => s.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(first.has_more).toBe(false);
  const newer = (await get(id, "/activity?steps=true&after=100")).body;
  expect(newer.steps[0].seq).toBe(101);
  expect(newer.steps.at(-1).seq).toBe(200);
  expect(newer.has_more).toBe(true);
  const last = (await get(id, "/activity?steps=true&after=200")).body;
  expect(last.steps).toHaveLength(5);
  expect(last.has_more).toBe(false);
  expect((await get(id, "/log/205")).body.payload.content).toBe(full);
  await db()
    .insert(taskSteps)
    .values({
      id: "private-image",
      taskId: id,
      seq: 206,
      kind: "tool",
      payload: {
        content: [
          { type: "text", text: "password=supersecret" },
          { type: "image", data: "private-image-bytes" },
        ],
      },
    });
  const detail = (await get(id, "/log/206")).body;
  expect(JSON.stringify(detail)).not.toContain("supersecret");
  expect(JSON.stringify(detail)).not.toContain("private-image-bytes");
  expect(detail.payload.content[1]).toEqual({ type: "image" });
});

it("enforces task visibility for summaries and full details and validates cursors", async () => {
  const id = (await w.post(w.alice, w.ids.topic, "@dev work")).tasks[0].id;
  const [outsider] = await db()
    .insert(users)
    .values({ id: "progress-outsider", name: "Outside", externalConnectionId: "outside-connection" })
    .returning();
  const token = await transaction((tx) => issueToken(tx, outsider));
  for (const path of ["/activity", "/activity?steps=true", "/activity?steps=platform", "/log/1"]) {
    expect((await w.api("GET", `/api/tasks/${id}${path}`)).status).toBe(401);
    expect((await get(id, path, token)).status).toBe(404);
  }
  for (const path of [
    "/activity?after=-1",
    "/activity?before=no",
    "/activity?after=1&before=2",
    "/log/1.5",
    "/activity?steps=invalid",
  ])
    expect((await get(id, path)).status).toBe(400);
  expect((await get(id, "/log/999")).status).toBe(404);
});

it("lists platform requests before approval and keeps rejected results inspectable", async () => {
  await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.alice, json: { approval_required: ["memory"] } });
  w.scripts.dev = (_m, turn) =>
    turn === 0
      ? reply("Working", [call("remember", { scope: "role", title: "Release checks", content: "Run tests" })])
      : reply("stopped");
  const id = (await w.post(w.alice, w.ids.topic, "@dev remember")).tasks[0].id;
  await w.drain();
  const before = (await get(id, "/activity?steps=platform")).body;
  expect(before.status).toBe("waiting_approval");
  expect(before.steps).toHaveLength(1);
  expect(Object.keys(before.steps[0].payload)).toEqual(["tool_calls"]);
  expect(before.steps[0].payload.tool_calls[0].function.name).toBe("remember");
  const approval = (await w.api("GET", "/api/approvals", { token: w.alice })).body.find((a: any) => a.task_id === id);
  await w.api("POST", `/api/approvals/${approval.id}/decide`, { token: w.alice, json: { approve: false } });
  await w.drain();
  const after = (await get(id, `/activity?steps=platform&after=${before.steps[0].seq}`)).body;
  expect(after.steps).toHaveLength(1);
  expect(after.steps[0].kind).toBe("tool");
  expect(after.steps[0].request.function.name).toBe("remember");
  expect(after.steps[0].payload.content).toMatch(/denied|reject/i);
});

it("filters before pagination, omits reasoning and computer calls, and preserves full platform details", async () => {
  const id = (await w.post(w.alice, w.ids.topic, "@dev work")).tasks[0].id;
  const memoryArgs = JSON.stringify({
    title: "Release checks",
    content: "password=supersecret " + "x".repeat(5000) + "END OF MEMORY",
  });
  const request = { id: "memory-call", function: { name: "update_memory", arguments: memoryArgs } };
  await db()
    .insert(taskSteps)
    .values([
      {
        id: "mixed-call",
        taskId: id,
        seq: 1,
        kind: "assistant",
        payload: {
          content: "Private model output",
          reasoning_content: "Private model thought",
          tool_calls: [
            request,
            { id: "command-call", function: { name: "run_command", arguments: '{"command":"pwd"}' } },
          ],
        },
      },
      ...Array.from({ length: 120 }, (_, i) => ({
        id: `thought-${i}`,
        taskId: id,
        seq: i + 2,
        kind: "assistant",
        payload: { content: "Unrelated thought" },
      })),
      {
        id: "memory-result",
        taskId: id,
        seq: 122,
        kind: "tool",
        payload: { name: "update_memory", tool_call_id: request.id, content: "saved" },
      },
      {
        id: "computer-result",
        taskId: id,
        seq: 123,
        kind: "tool",
        payload: { name: "run_command", tool_call_id: "command-call", content: "computer output" },
      },
    ]);
  const recent = (await get(id, "/activity?steps=platform")).body;
  expect(recent.steps.map((s: any) => s.seq)).toEqual([1, 122]);
  expect(recent.has_more).toBe(false);
  expect(recent.steps[0].payload.tool_calls).toHaveLength(1);
  expect(recent.steps[0].payload.tool_calls[0].function.arguments.length).toBeLessThanOrEqual(4000);
  for (const omitted of ["Private model", "run_command", "computer output", "supersecret", "END OF MEMORY"])
    expect(JSON.stringify(recent)).not.toContain(omitted);
  const incremental = (await get(id, "/activity?steps=platform&after=1")).body;
  expect(incremental.steps[0].request.function.name).toBe("update_memory");
  const full = (await get(id, "/log/122")).body;
  expect(full.request.function.arguments).toContain("END OF MEMORY");
  expect(JSON.stringify(full)).not.toContain("supersecret");
  const earlier = (await get(id, "/activity?steps=platform&before=122")).body;
  expect(earlier.steps.map((s: any) => s.seq)).toEqual([1]);
});

it("totals input, output and cache tokens per run and weights the cache hit rate by input", async () => {
  const id = (await w.post(w.alice, w.ids.topic, "@dev work")).tasks[0].id;
  expect((await get(id)).body).toMatchObject({
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    cache_hit_rate: null,
  });
  await db()
    .insert(usageRecords)
    .values([
      { id: "usage-small", taskId: id, promptTokens: 100, completionTokens: 20, cachedTokens: 90 },
      { id: "usage-large", taskId: id, promptTokens: 900, completionTokens: 80, cachedTokens: 90 },
      { id: "usage-other", taskId: "another-run", promptTokens: 9999, completionTokens: 111, cachedTokens: 8888 },
    ]);
  for (const mode of ["", "?steps=true", "?steps=platform"]) {
    expect((await get(id, `/activity${mode}`)).body).toMatchObject({
      rounds: 2,
      tokens: 1100,
      prompt_tokens: 1000,
      completion_tokens: 100,
      cached_tokens: 180,
      cache_hit_rate: 0.18,
    });
  }
  // Cumulative totals can exceed PostgreSQL's 32-bit integer limit even when each call fits it.
  await db()
    .insert(usageRecords)
    .values([
      {
        id: "usage-bulk-1",
        taskId: id,
        promptTokens: 2_000_000_000,
        completionTokens: 2_000_000_000,
        cachedTokens: 2_000_000_000,
      },
      {
        id: "usage-bulk-2",
        taskId: id,
        promptTokens: 2_000_000_000,
        completionTokens: 2_000_000_000,
        cachedTokens: 2_000_000_000,
      },
    ]);
  expect((await get(id)).body).toMatchObject({
    prompt_tokens: 4_000_001_000,
    completion_tokens: 4_000_000_100,
    cached_tokens: 4_000_000_180,
    tokens: 8_000_001_100,
  });
});

it("shows zero cache hits when a completed model call reports no cache usage", async () => {
  w.scripts.dev = () => reply("done");
  const id = (await w.post(w.alice, w.ids.topic, "@dev work")).tasks[0].id;
  await w.drain();
  expect((await get(id)).body).toMatchObject({
    status: "completed",
    prompt_tokens: 10,
    completion_tokens: 5,
    cached_tokens: 0,
    cache_hit_rate: 0,
  });
});

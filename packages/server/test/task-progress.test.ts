import { afterEach, beforeEach, expect, it } from "vitest";
import { db, transaction } from "../src/db/client.js";
import { taskSteps, users } from "../src/db/schema.js";
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
  for (const path of ["/activity", "/activity?steps=true", "/log/1"]) {
    expect((await w.api("GET", `/api/tasks/${id}${path}`)).status).toBe(401);
    expect((await get(id, path, token)).status).toBe(404);
  }
  for (const path of ["/activity?after=-1", "/activity?before=no", "/activity?after=1&before=2", "/log/1.5"])
    expect((await get(id, path)).status).toBe(400);
  expect((await get(id, "/log/999")).status).toBe(404);
});

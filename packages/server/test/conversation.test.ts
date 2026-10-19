/**
 * A role's conversation in a topic: one model context from message to message. Messages that arrive while it
 * works join its run at the next step; the start of its prompt stays the same (so services can reuse their
 * prompt cache); a long context is compacted into a summary at the model's threshold, keeping the system
 * prompt and the tools; separable work runs as a task with its own context and reports back.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPACT_PROMPT, SUMMARY_HEADER } from "../src/agent/conversation.js";
import type { ChatMessage, ToolSchema } from "../src/agent/llm.js";
import { db } from "../src/db/client.js";
import { agentSessions, auditLogs, tasks } from "../src/db/schema.js";
import { ModelError } from "../src/errors.js";
import { recommendedWindow } from "../src/services/context-window.js";
import { call, lastToolResult, lastUser, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

const runsIn = async (topicId: string) =>
  (await db().select().from(tasks).where(eq(tasks.topicId, topicId))).filter((t) => t.kind === "conversation");
const sessionOf = async (roleId: string, topicId: string) =>
  (await w.api("GET", `/api/topics/${topicId}/sessions`, { token: w.alice })).body.find(
    (s: any) => s.role_id === roleId,
  );

describe("one conversation per role and topic", () => {
  it("a message sent while the role works joins its run at the next step, and can change what it does", async () => {
    const pc = w.manager.computer(w.ids.instance);
    const seen: ChatMessage[][] = [];
    let joined: any = null;
    w.scripts.dev = (m, turn) => {
      seen.push(m);
      if (lastUser(m).includes("stop, use staging")) return reply("OK, switching to staging.");
      return turn === 0 ? reply("", [call("run_command", { command: "deploy prod" })]) : reply("deployed to prod");
    };
    pc.execHandler = async (command) => {
      // alice changes her mind while the command is still running
      if (command === "deploy prod") joined = await w.post(w.alice, w.ids.topic, "@dev stop, use staging instead");
      return { exitCode: 0, output: "deploying" };
    };
    const first = await w.post(w.alice, w.ids.topic, "@dev deploy to prod");
    await w.drain();

    // no second, parallel run: the message went to the open one
    expect(joined.tasks).toEqual([
      { id: first.tasks[0].id, owner_role_id: w.ids.dev, status: "running", kind: "conversation", joined: true },
    ]);
    expect(await runsIn(w.ids.topic)).toHaveLength(1);
    // the next model call had the tool result and then the new message, as the latest user turn
    const last = seen.at(-1)!;
    expect(last.map((x) => x.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(last[3].content).toContain("deploying");
    expect(last[4].content).toContain("alice → you: @dev stop, use staging instead");
    const texts = (await w.messages(w.ids.topic)).map((x: any) => x.content);
    expect(texts.at(-1)).toBe("OK, switching to staging.");
    expect(texts).not.toContain("deployed to prod");
  });

  it("keeps the start of the prompt the same: the same system prompt, earlier turns unchanged", async () => {
    const calls: ChatMessage[][] = [];
    w.scripts.dev = (m) => {
      calls.push(m);
      return reply(`answer ${calls.length}`);
    };
    await w.post(w.alice, w.ids.topic, "@dev first question");
    await w.drain();
    await w.post(w.bob, w.ids.topic, "@dev second question");
    await w.drain();
    expect(calls).toHaveLength(2);
    // The second request repeats the first exactly, then adds the answer and what is new.
    expect(calls[1].slice(0, calls[0].length)).toEqual(calls[0]);
    expect(calls[1].slice(calls[0].length).map((x) => x.role)).toEqual(["assistant", "user"]);
    const system = String(calls[0][0].content);
    // Nothing that changes per message is in it: who asks and the time come with the messages.
    expect(system).not.toMatch(/Requested by|Now:/);
    expect(system).toContain("## Your conversation here");
    expect(String(calls[1].at(-1)!.content)).toMatch(/bob → you: @dev second question[\s\S]*Now: \d{4}-/);
    // People present are told once, and again only when that changes.
    expect(String(calls[0][1].content)).toMatch(/People here: (alice, bob|bob, alice)\./);
    expect(String(calls[1].at(-1)!.content)).not.toContain("People here");
  });

  it("compacts a long conversation at the model's threshold; the system prompt and tools stay", async () => {
    await w.api("PATCH", `/api/models/${w.ids.model}`, {
      token: w.adminToken,
      json: { context_window: 8000, compact_tokens: 2000 },
    });
    const calls: { messages: ChatMessage[]; tools?: ToolSchema[] }[] = [];
    w.scripts.dev = (m, turn, tools) => {
      calls.push({ messages: m, tools });
      if (lastUser(m) === COMPACT_PROMPT) return reply("SUMMARY: alice asked for the build; it passed.");
      if (lastUser(m).includes("first")) {
        if (turn === 0) return reply("", [call("run_command", { command: "make" })]);
        // a large context by now: the next call compacts first
        return { ...reply("the build passed"), promptTokens: 3000 };
      }
      return reply("still green");
    };
    await w.post(w.alice, w.ids.topic, "@dev first: run the build");
    await w.drain();
    await w.post(w.alice, w.ids.topic, "@dev is it still green?");
    await w.drain();

    const [compaction, after] = calls.slice(-2);
    // the summary was asked for with the same prompt start (cacheable) and the same tools
    expect(compaction.messages.slice(0, calls[1].messages.length)).toEqual(calls[1].messages);
    expect(compaction.messages.slice(calls[1].messages.length).map((x) => x.content)).toEqual([
      "the build passed",
      COMPACT_PROMPT,
    ]);
    expect(compaction.tools?.map((t) => t.name)).toEqual(calls[0].tools?.map((t) => t.name));
    // afterwards: the same system prompt and tools, then the summary, then what is new
    expect(after.messages[0]).toEqual(calls[0].messages[0]);
    expect(after.tools).toEqual(calls[0].tools);
    expect(after.messages.map((x) => x.role)).toEqual(["system", "user", "user"]);
    expect(after.messages[1].content).toBe(`${SUMMARY_HEADER}\n\nSUMMARY: alice asked for the build; it passed.`);
    expect(after.messages[2].content).toContain("alice → you: @dev is it still green?");
    expect((await w.messages(w.ids.topic)).at(-1).content).toBe("still green");
    const session = await sessionOf(w.ids.dev, w.ids.topic);
    expect([session.compactions, session.compact_at, session.context_window]).toEqual([1, 2000, 8000]);
    const audit = await db().select().from(auditLogs).where(eq(auditLogs.action, "conversation.compact"));
    expect(audit).toHaveLength(1);
    // the steps before the summary stay in the runs' logs
    const firstRun = (await runsIn(w.ids.topic)).sort((a, b) => +a.createdAt - +b.createdAt)[0];
    const log = (await w.api("GET", `/api/tasks/${firstRun.id}/log`, { token: w.alice })).body;
    expect(log.map((s: any) => s.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("a request too long for the model is compacted and asked again once", async () => {
    let n = 0;
    w.scripts.dev = (m, turn) => {
      n++;
      if (lastUser(m) === COMPACT_PROMPT) return reply("SUMMARY: earlier work.");
      if (lastUser(m).includes("first"))
        return turn === 0 ? reply("", [call("run_command", { command: "a" })]) : reply("done");
      // the service refuses anything but the compacted context
      if (m[1].content !== `${SUMMARY_HEADER}\n\nSUMMARY: earlier work.`)
        throw new ModelError("model returned HTTP 400: This model's maximum context length is 8192 tokens");
      // the latest request is still there word for word, after the summary
      return reply(`fits now: ${lastUser(m).includes("alice → you: @dev more")}`);
    };
    await w.post(w.alice, w.ids.topic, "@dev first");
    await w.drain();
    await w.post(w.alice, w.ids.topic, "@dev more");
    await w.drain();
    expect((await w.messages(w.ids.topic)).at(-1).content).toBe("fits now: true");
    expect(n).toBe(5);
  });

  it("start_task runs separate work in its own context; its result comes back to the conversation", async () => {
    let brief = "";
    let taskSystem = "";
    w.scripts.dev = (m, turn) => {
      const last = lastUser(m);
      if (last.includes("Started by your conversation")) {
        brief = last;
        taskSystem = String(m[0].content);
        return reply("research result: 42");
      }
      if (last.includes("Your task")) return reply(`Found: ${/ended:\n(.*)/.exec(last)?.[1]}`);
      return turn === 0
        ? reply("", [call("start_task", { task: "Research the answer", expected_output: "a number" })])
        : reply(`started (${lastToolResult(m).slice(0, 12)})`);
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev find the answer");
    await w.drain();
    const own = (await db().select().from(tasks).where(eq(tasks.spawnedByTaskId, posted.tasks[0].id)))[0];
    expect([own.kind, own.ownerRoleId, own.parentTaskId, own.envelope.report_only]).toEqual([
      "task",
      w.ids.dev,
      null,
      true,
    ]);
    const session = await sessionOf(w.ids.dev, w.ids.topic);
    expect(own.reportSessionId).toBe(session.id);
    expect(brief).toContain("Research the answer");
    expect(taskSystem).toContain("Your final answer goes back to the conversation that started this task");
    expect(taskSystem).not.toContain("## Your conversation here");
    // nothing was posted for the task itself; the conversation reported its result
    const texts = (await w.messages(w.ids.topic)).map((x: any) => x.content);
    expect(texts).toEqual(["@dev find the answer", "started (started task)", "Found: research result: 42"]);
  });

  it("stay_silent is in every turn's tools, and refused when the role was @-mentioned", async () => {
    const results: string[] = [];
    w.scripts.dev = (m, turn, tools) => {
      expect(tools?.map((t) => t.name)).toContain("stay_silent");
      if (turn === 0) return reply("", [call("stay_silent", { reason: "nothing to add" })]);
      results.push(lastToolResult(m));
      return reply("hello alice");
    };
    await w.post(w.alice, w.ids.topic, "@dev hi");
    await w.drain();
    expect(results[0]).toContain("a message @-mentioned you");
    expect((await w.messages(w.ids.topic)).at(-1).content).toBe("hello alice");

    // In a topic that answers automatically, a message without an @ may be left alone.
    const solo = (
      await w.api("POST", "/api/topics", {
        token: w.alice,
        json: { title: "Solo", role_ids: [w.ids.dev], response_mode: "auto" },
      })
    ).body;
    await w.api("PATCH", `/api/topics/${solo.id}`, { token: w.alice, json: { response_mode: "auto" } });
    await w.post(w.alice, solo.id, "lunch anyone?");
    await w.drain();
    const [run] = await runsIn(solo.id);
    expect([run.status, run.statusReason]).toEqual(["completed", "chose not to reply"]);
    expect((await w.messages(solo.id)).map((x: any) => x.content)).toEqual(["lunch anyone?"]);
  });

  it("clearing the context starts the conversation again from the topic", async () => {
    const calls: ChatMessage[][] = [];
    w.scripts.dev = (m) => {
      calls.push(m);
      return reply("the code is 4242");
    };
    await w.post(w.alice, w.ids.topic, "@dev what is the code?");
    await w.drain();
    const session = await sessionOf(w.ids.dev, w.ids.topic);
    expect(session.context_tokens).toBe(15);
    const reset = await w.api("POST", `/api/sessions/${session.id}/reset`, { token: w.bob });
    expect(reset.status, reset.raw).toBe(200);
    expect(reset.body.context_tokens).toBe(0);
    await w.post(w.alice, w.ids.topic, "@dev and now?");
    await w.drain();
    // a fresh context: the topic's latest messages (its own answer among them), not the old turns
    expect(calls[1].map((x) => x.role)).toEqual(["system", "user"]);
    expect(calls[1][1].content).toMatch(/Messages in this topic \(the latest 3[\s\S]*@dev: the code is 4242/);
    const audit = await db().select().from(auditLogs).where(eq(auditLogs.action, "session.reset"));
    expect(audit.map((a) => a.actorId)).toEqual([w.ids.bob]);
  });

  it("a console instruction reaches a working conversation between steps", async () => {
    await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.adminToken, json: { approval_required: ["shell"] } });
    let last = "";
    w.scripts.dev = (m, turn) => {
      last = lastUser(m);
      return turn === 0 && !last.includes("Instruction")
        ? reply("", [call("run_command", { command: "ls" })])
        : reply("ok");
    };
    const id = (await w.post(w.alice, w.ids.topic, "@dev list")).tasks[0].id;
    await w.drain();
    expect((await w.task(id)).status).toBe("waiting_approval");
    const told = await w.api("POST", `/api/tasks/${id}/control`, {
      token: w.alice,
      json: { action: "instruct", note: "only the top level" },
    });
    expect(told.status, told.raw).toBe(200);
    const approval = (await w.api("GET", "/api/approvals", { token: w.bob })).body.find((a: any) => a.task_id === id);
    await w.api("POST", `/api/approvals/${approval.id}/decide`, { token: w.bob, json: { approve: true } });
    await w.drain();
    expect(last).toContain("Instruction from alice in the console: only the top level");
    expect((await w.task(id)).status).toBe("completed");
    // a conversation is the role's: it cannot be handed to another role
    const moved = await w.api("POST", `/api/tasks/${id}/reassign`, { token: w.alice, json: { roleId: w.ids.test } });
    expect(moved.status).toBe(400);
  });

  it("the task list can show tasks without the conversation runs", async () => {
    w.scripts.dev = (m, turn) =>
      lastUser(m).includes("Started by")
        ? reply("done")
        : turn === 0 && !lastUser(m).includes("Your task")
          ? reply("", [call("start_task", { task: "side job" })])
          : reply("ok");
    await w.post(w.alice, w.ids.topic, "@dev go");
    await w.drain();
    const only = (await w.api("GET", `/api/tasks?topic_id=${w.ids.topic}&kind=task`, { token: w.alice })).body;
    expect(only.map((t: any) => [t.kind, t.title])).toEqual([["task", "side job"]]);
    const all = (await w.api("GET", `/api/tasks?topic_id=${w.ids.topic}`, { token: w.alice })).body;
    expect(all.filter((t: any) => t.kind === "conversation").length).toBeGreaterThan(0);
  });
});

describe("work a conversation hands out", () => {
  it("comes back to it, and the chain is bounded until a person speaks", async () => {
    // A conversation that starts a new task every time a result comes back.
    w.scripts.dev = (m, turn) =>
      lastUser(m).includes("Started by")
        ? reply("done")
        : turn === 0
          ? reply("", [call("start_task", { task: "again" })])
          : reply(lastToolResult(m));
    await w.post(w.alice, w.ids.topic, "@dev keep going");
    await w.drain();
    const own = (await db().select().from(tasks).where(eq(tasks.topicId, w.ids.topic))).filter(
      (t) => t.kind === "task",
    );
    expect(own.length).toBe(w.settings.maxAutoRounds);
    expect((await w.messages(w.ids.topic)).at(-1).content).toContain("rounds of automatic work without a person");
  });
});

describe("model context settings", () => {
  it("recommended by model family, reported by the provider, or set on the model", async () => {
    expect(recommendedWindow("claude-opus-4-6")).toBe(1_000_000);
    expect(recommendedWindow("claude-3-5-sonnet-20241022")).toBe(200_000);
    expect(recommendedWindow("deepseek-chat")).toBe(128_000);
    expect(recommendedWindow("gpt-4o-mini")).toBe(128_000);
    expect(recommendedWindow("my-local-model")).toBeNull();
    const model = async () =>
      (await w.api("GET", "/api/model-providers", { token: w.adminToken })).body
        .flatMap((p: any) => p.models)
        .find((m: any) => m.id === w.ids.model);
    // "x" is unknown: a conservative default window, compacted at three quarters
    expect((await model()).context).toEqual({ window: 64_000, compact_at: 48_000, source: "default" });
    const patch = (json: Record<string, unknown>) =>
      w.api("PATCH", `/api/models/${w.ids.model}`, { token: w.adminToken, json });
    expect((await patch({ context_window: 200_000 })).body.context).toEqual({
      window: 200_000,
      compact_at: 150_000,
      source: "model",
    });
    expect((await patch({ compact_tokens: 300_000 })).status).toBe(400);
    expect((await patch({ compact_tokens: 512 })).status).toBe(400);
    expect((await patch({ compact_tokens: 100_000 })).body.context.compact_at).toBe(100_000);
    expect((await patch({ context_window: null, compact_tokens: null })).body.context.source).toBe("default");
    const [s] = await db().select().from(agentSessions).limit(1);
    expect(s ?? null).toBeNull();
  });
});

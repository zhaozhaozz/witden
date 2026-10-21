/**
 * Commands in the virtual computer are never killed by a timeout: run_command leaves one still running in the
 * background (or starts it there), several run at once, and the end of each reaches the work that started it
 * as a notice — a conversation's inbox, a task's next step or its wait, the conversation an ended task reports
 * to — exactly once, also when it ended while the runner was disconnected. Old runners keep the old behaviour.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileCommands } from "../src/agent/commands.js";
import { db } from "../src/db/client.js";
import { agentSessions, backgroundCommands, tasks } from "../src/db/schema.js";
import type { FakeComputer } from "./support/fake-computer.js";
import { call, lastToolResult, lastUser, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
let pc: FakeComputer;
beforeEach(async () => {
  w = await buildWorld();
  pc = w.manager.computer(w.ids.instance);
});
afterEach(async () => {
  await w.close();
});

type Result = { exitCode: number; output: string };

/** Commands named here run until the test ends them; others end at once. */
function longCommands(...names: string[]): Record<string, (r: Result) => void> {
  const finish: Record<string, (r: Result) => void> = {};
  pc.execHandler = (command) =>
    names.includes(command)
      ? new Promise<Result>((resolve) => {
          finish[command] = resolve;
        })
      : undefined;
  return finish;
}

const row = async (id: string) =>
  (await db().select().from(backgroundCommands).where(eq(backgroundCommands.id, id)))[0];
const idIn = (text: string) => /(cmd_[0-9a-z]+)/.exec(text)?.[1] ?? "";
const ended = (id: string) => w.waitFor(async () => ["finished", "lost"].includes((await row(id))?.status ?? ""));

async function inboxOf(roleId: string) {
  const [s] = await db()
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.roleId, roleId), eq(agentSessions.topicId, w.ids.topic)));
  return s.inbox;
}

describe("run_command", () => {
  it("returns the exit code and output of a command that ends in time; nothing is announced later", async () => {
    pc.execHandler = () => ({ exitCode: 2, output: "compiled with 1 error" });
    let result = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("run_command", { command: "make" })]);
      result = lastToolResult(m);
      return reply("done");
    };
    await w.post(w.alice, w.ids.topic, "@dev make");
    await w.drain();
    expect(result).toBe("[exit code 2]\ncompiled with 1 error");
    const [c] = await db().select().from(backgroundCommands);
    expect(c).toMatchObject({ status: "finished", exitCode: 2, background: false, notifiedTo: "foreground" });
    expect((await inboxOf(w.ids.dev)).some((i: any) => i.kind === "command")).toBe(false);
  });

  it("cuts a long output once, to the tool output limit, and names the log that holds all of it", async () => {
    pc.execHandler = () => ({ exitCode: 0, output: `BEGIN${"x".repeat(50_000)}END` });
    let result = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("run_command", { command: "cat big.log" })]);
      result = lastToolResult(m);
      return reply("done");
    };
    await w.post(w.alice, w.ids.topic, "@dev show it");
    await w.drain();
    const [c] = await db().select().from(backgroundCommands);
    expect(result).toContain(
      `[exit code 0] [output cut: 48.8 KB in all, the whole output is in /home/witden/.witden/commands/${c.id}.log]`,
    );
    expect(result).toContain("BEGIN");
    expect(result).toContain("END");
    expect(result.length).toBeLessThan(w.settings.toolOutputLimit + 300);
  });

  it("leaves a command still running at its timeout in the background; its end wakes the conversation", async () => {
    const finish = longCommands("make build");
    const seen: string[] = [];
    w.scripts.dev = (m, turn) => {
      const last = lastUser(m);
      if (last.includes("Background command")) {
        seen.push(last);
        return reply("the build finished");
      }
      if (turn === 0) return reply("", [call("run_command", { command: "make build", timeout_seconds: 1 })]);
      seen.push(lastToolResult(m));
      return reply("it builds in the background");
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev build it");
    await w.drain();
    expect(seen[0]).toContain("[still running after 1s: it goes on in the background as command");
    const id = idIn(seen[0]);
    // not killed: it keeps running, and the run that started it is over
    expect(pc.started.get(id)?.done).toBe(false);
    expect((await w.task(posted.tasks[0].id)).status).toBe("completed");
    expect(await row(id)).toMatchObject({ status: "running", background: true, notifiedAt: null });

    finish["make build"]({ exitCode: 0, output: "BUILD OK" });
    await ended(id);
    await w.drain();
    expect(seen[1]).toContain(`Background command ${id} ended after`);
    expect(seen[1]).toContain("with exit code 0");
    expect(seen[1]).toContain("BUILD OK");
    expect(seen[1]).toContain(`/home/witden/.witden/commands/${id}.log`);
    expect(await row(id)).toMatchObject({ status: "finished", exitCode: 0, notifiedTo: "conversation" });
    const texts = (await w.messages(w.ids.topic)).map((m: any) => m.content);
    expect(texts.slice(-2)).toEqual(["it builds in the background", "the build finished"]);
  });

  it("starts background commands at once, several at a time; command_status lists them and shows one", async () => {
    const finish = longCommands("serve", "watch", "crawl");
    const results: string[] = [];
    w.scripts.dev = (m, turn) => {
      if (lastUser(m).includes("Background command")) return reply("noted");
      const steps = [
        [
          call("run_command", { command: "serve", background: true }),
          call("run_command", { command: "watch", background: true }),
          call("run_command", { command: "crawl", background: true }),
        ],
        [call("command_status", {})],
      ];
      if (turn > 0) results.push(lastToolResult(m));
      return turn < steps.length ? reply("", steps[turn]) : reply("all started");
    };
    await w.post(w.alice, w.ids.topic, "@dev start the services");
    await w.drain();
    const rows = await db().select().from(backgroundCommands);
    expect(rows.map((r) => [r.command, r.status, r.background]).sort()).toEqual([
      ["crawl", "running", true],
      ["serve", "running", true],
      ["watch", "running", true],
    ]);
    expect(results[1]).toContain("3 running");
    for (const r of rows) expect(results[1]).toContain(r.id);

    // one of them, with its output so far
    const serve = rows.find((r) => r.command === "serve")!;
    pc.started.get(serve.id)!.output = "listening on :8080\n";
    let status = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("command_status", { id: serve.id })]);
      status = lastToolResult(m);
      return reply("ok");
    };
    await w.post(w.alice, w.ids.topic, "@dev how is the server?");
    await w.drain();
    expect(status).toContain(`[command ${serve.id}: running for`);
    expect(status).toContain("listening on :8080");
    // other roles' commands are not theirs to see
    w.scripts.test = (m, turn) =>
      turn === 0 ? reply("", [call("command_status", { id: serve.id })]) : reply(lastToolResult(m));
    await w.post(w.alice, w.ids.topic, "@test check it");
    await w.drain();
    expect((await w.messages(w.ids.topic)).at(-1).content).toContain(`no command ${serve.id} of yours`);
    for (const f of Object.values(finish)) f({ exitCode: 0, output: "" });
  });

  it("command_stop stops a command; its end is told in the result, not again as a notice", async () => {
    longCommands("tail -f log");
    let stopped = "";
    w.scripts.dev = (m, turn) => {
      if (lastUser(m).includes("Background command")) return reply("an unexpected notice");
      if (turn === 0) return reply("", [call("run_command", { command: "tail -f log", background: true })]);
      if (turn === 1) return reply("", [call("command_stop", { id: idIn(lastToolResult(m)) })]);
      stopped = lastToolResult(m);
      return reply("stopped");
    };
    await w.post(w.alice, w.ids.topic, "@dev follow the log, then stop");
    await w.drain();
    const id = idIn(stopped);
    expect(stopped).toContain(`stopped command ${id} (1 processes signalled): exit code 143 (SIGTERM)`);
    expect(await row(id)).toMatchObject({
      status: "finished",
      exitCode: 143,
      signal: "SIGTERM",
      notifiedTo: "foreground",
    });
    expect((await inboxOf(w.ids.dev)).some((i: any) => i.kind === "command")).toBe(false);
  });
});

describe("independent tasks", () => {
  it("a task waits for its background command with command_wait and goes on with its notice", async () => {
    const finish = longCommands("npm test");
    let waited = "";
    let tools: string[] = [];
    w.scripts.dev = (m, turn, t) => {
      const last = lastUser(m);
      if (last.includes("Started by your conversation")) {
        tools = (t ?? []).map((x) => x.name);
        if (turn === 0) return reply("", [call("run_command", { command: "npm test", background: true })]);
        if (turn === 1) return reply("", [call("command_wait", { minutes: 10 })]);
        waited = lastToolResult(m);
        return reply("tests passed");
      }
      if (last.includes("Your task")) return reply("the tests passed");
      return turn === 0 ? reply("", [call("start_task", { task: "Run the tests" })]) : reply("started");
    };
    await w.post(w.alice, w.ids.topic, "@dev run the tests");
    await w.drain();
    expect(tools).toContain("command_wait");
    const [task] = await db().select().from(tasks).where(eq(tasks.kind, "task"));
    expect(task).toMatchObject({ status: "waiting_timer", wait: { type: "commands", tool: "command_wait" } });
    const [c] = await db().select().from(backgroundCommands);
    finish["npm test"]({ exitCode: 0, output: "42 passing" });
    await ended(c.id);
    await w.drain();
    expect(waited).toContain(`Background command ${c.id} ended`);
    expect(waited).toContain("42 passing");
    expect((await w.task(task.id)).status).toBe("completed");
    expect(await row(c.id)).toMatchObject({ notifiedTo: "task" });
    // the conversation got the task's result, not the command's notice
    expect((await inboxOf(w.ids.dev)).filter((i: any) => i.kind === "command")).toEqual([]);
  });

  it("a task waiting for its follow-up time is woken when its background command ends", async () => {
    const finish = longCommands("crawl");
    let woken = "";
    w.scripts.dev = (m, turn) => {
      const last = lastUser(m);
      if (last.includes("Started by your conversation")) {
        if (turn === 0) return reply("", [call("run_command", { command: "crawl", background: true })]);
        if (turn === 1) return reply("", [call("follow_up_later", { minutes: 600, reason: "check the crawl" })]);
        woken = lastToolResult(m);
        return reply("crawled");
      }
      if (last.includes("Your task")) return reply("done");
      return turn === 0 ? reply("", [call("start_task", { task: "Crawl" })]) : reply("started");
    };
    await w.post(w.alice, w.ids.topic, "@dev crawl");
    await w.drain();
    const [task] = await db().select().from(tasks).where(eq(tasks.kind, "task"));
    expect(task.status).toBe("waiting_timer");
    finish.crawl({ exitCode: 0, output: "100 pages" });
    await ended((await db().select().from(backgroundCommands))[0].id);
    await w.drain();
    expect(woken).toContain("Woken before your follow-up (check the crawl)");
    expect(woken).toContain("100 pages");
    expect((await w.task(task.id)).status).toBe("completed");
  });

  it("a task still at work reads the notice at its next step; command_wait is only for tasks", async () => {
    const finish = longCommands("fetch data");
    let next = "";
    let conversationTools: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    w.scripts.dev = (m, turn, t) => {
      const last = lastUser(m);
      if (last.includes("Background commands you started ended")) {
        next = last;
        return reply("got the data");
      }
      if (last.includes("Started by your conversation")) {
        if (turn === 0) return reply("", [call("run_command", { command: "fetch data", background: true })]);
        if (turn === 1) {
          // the command ends while the task is busy with something else
          release();
          return reply("", [call("post_progress", { progress: "fetching" })]);
        }
        return reply("", [call("post_progress", { progress: "still working" })]);
      }
      if (last.includes("Your task")) return reply("done");
      conversationTools = (t ?? []).map((x) => x.name);
      return turn === 0 ? reply("", [call("start_task", { task: "Fetch" })]) : reply("started");
    };
    void gate.then(() => finish["fetch data"]({ exitCode: 0, output: "rows: 10" }));
    await w.post(w.alice, w.ids.topic, "@dev fetch");
    await w.drain();
    expect(conversationTools).not.toContain("command_wait");
    expect(conversationTools).toContain("command_status");
    expect(next).toContain("rows: 10");
  });

  it("the end of a command whose task has ended goes to the conversation the task reports to", async () => {
    const finish = longCommands("deploy");
    let notice = "";
    w.scripts.dev = (m, turn) => {
      const last = lastUser(m);
      if (last.includes("Background command")) {
        notice = last;
        return reply("deploy done");
      }
      if (last.includes("Started by your conversation"))
        return turn === 0
          ? reply("", [call("run_command", { command: "deploy", background: true })])
          : reply("deploy started");
      if (last.includes("Your task")) return reply("the deploy is running");
      return turn === 0 ? reply("", [call("start_task", { task: "Deploy" })]) : reply("started");
    };
    await w.post(w.alice, w.ids.topic, "@dev deploy");
    await w.drain();
    const [task] = await db().select().from(tasks).where(eq(tasks.kind, "task"));
    expect(task.status).toBe("completed");
    const [c] = await db().select().from(backgroundCommands);
    finish.deploy({ exitCode: 1, output: "error: quota exceeded" });
    await ended(c.id);
    await w.drain();
    expect(notice).toContain(`Background command ${c.id} ended after`);
    expect(notice).toContain("exit code 1");
    expect(notice).toContain(`It was started by task ${task.id} «`);
    expect(notice).toContain("error: quota exceeded");
    expect(await row(c.id)).toMatchObject({ notifiedTo: "conversation" });
  });
});

describe("robustness", () => {
  it("an end missed while the runner was disconnected is found when it reconnects, and told once", async () => {
    const finish = longCommands("backup");
    const notices: string[] = [];
    w.scripts.dev = (m, turn) => {
      const last = lastUser(m);
      if (last.includes("Background command")) {
        notices.push(last);
        return reply("backup done");
      }
      return turn === 0 ? reply("", [call("run_command", { command: "backup", background: true })]) : reply("started");
    };
    await w.post(w.alice, w.ids.topic, "@dev back it up");
    await w.drain();
    const [c] = await db().select().from(backgroundCommands);
    pc.disconnect();
    finish.backup({ exitCode: 0, output: "3 GB saved" }); // reported to nobody
    await new Promise((r) => setTimeout(r, 50));
    expect((await row(c.id)).status).toBe("running");
    pc.connect(w.manager.hub!);
    await ended(c.id);
    await w.drain();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("3 GB saved");
    const told = (await row(c.id)).notifiedAt;

    // the same end reported again (a repeated event, another reconciliation) changes nothing
    await reconcileCommands(w.witden.runtime.hub!.connected(w.ids.instance)!);
    const { recordEnd } = await import("../src/agent/commands.js");
    await db().transaction((tx) =>
      recordEnd(tx as any, w.ids.instance, c.id, {
        exitCode: 0,
        signal: null,
        lost: false,
        finishedAt: new Date(),
        outputBytes: 1,
        tail: "again",
      }),
    );
    await w.drain();
    expect(notices).toHaveLength(1);
    expect((await row(c.id)).notifiedAt).toEqual(told);
    expect((await inboxOf(w.ids.dev)).filter((i: any) => i.kind === "command")).toHaveLength(1);
  });

  it("a command that died with its computer is reported lost", async () => {
    longCommands("long job");
    const notices: string[] = [];
    w.scripts.dev = (m, turn) => {
      const last = lastUser(m);
      if (last.includes("Background command")) {
        notices.push(last);
        return reply("it was lost");
      }
      return turn === 0
        ? reply("", [call("run_command", { command: "long job", background: true })])
        : reply("started");
    };
    await w.post(w.alice, w.ids.topic, "@dev run the long job");
    await w.drain();
    const [c] = await db().select().from(backgroundCommands);
    // the computer restarted by itself: the runner comes back without the process
    pc.disconnect();
    pc.loseCommands();
    pc.connect(w.manager.hub!);
    await ended(c.id);
    await w.drain();
    expect(await row(c.id)).toMatchObject({ status: "lost", exitCode: null });
    expect(notices[0]).toContain(`Background command ${c.id} was lost`);
  });

  it("stopping the computer loses its running commands and tells their roles", async () => {
    longCommands("server");
    w.scripts.dev = (m, turn) =>
      lastUser(m).includes("Background command")
        ? reply("noted")
        : turn === 0
          ? reply("", [call("run_command", { command: "server", background: true })])
          : reply("started");
    await w.post(w.alice, w.ids.topic, "@dev start the server");
    await w.drain();
    const [c] = await db().select().from(backgroundCommands);
    const stop = await w.api("POST", `/api/instances/${w.ids.instance}/actions`, {
      token: w.adminToken,
      json: { action: "stop" },
    });
    expect(stop.status, stop.raw).toBeLessThan(300);
    await w.drain();
    expect(await row(c.id)).toMatchObject({ status: "lost" });
    expect((await inboxOf(w.ids.dev)).filter((i: any) => i.kind === "command")).toHaveLength(1);
  });

  it("the console lists background commands of a computer, without their output", async () => {
    longCommands("serve");
    w.scripts.dev = (_m, turn) =>
      turn === 0 ? reply("", [call("run_command", { command: "serve", background: true })]) : reply("started");
    await w.post(w.alice, w.ids.topic, "@dev serve");
    await w.drain();
    const listed = await w.api("GET", `/api/instances/${w.ids.instance}/commands`, { token: w.alice });
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ command: "serve", status: "running", role_id: w.ids.dev, exit_code: null });
    expect(listed.body[0]).not.toHaveProperty("tail");
  });
});

describe("computers whose runner predates background commands", () => {
  it("keep the old run_command, and the new tools say the computer needs a reset", async () => {
    pc.commandOps = false;
    pc.disconnect();
    pc.connect(w.manager.hub!);
    await w.waitFor(
      async () =>
        (await w.api("GET", `/api/instances/${w.ids.instance}`, { token: w.adminToken })).body.runner?.connected,
    );
    pc.execHandler = () => ({ exitCode: 0, output: "old runner output" });
    const results: string[] = [];
    let system = "";
    w.scripts.dev = (m, turn) => {
      system = String(m[0].content);
      const steps = [
        call("run_command", { command: "ls" }),
        call("run_command", { command: "serve", background: true }),
        call("command_status", {}),
      ];
      if (turn > 0) results.push(lastToolResult(m));
      return turn < steps.length ? reply("", [steps[turn]]) : reply("done");
    };
    await w.post(w.alice, w.ids.topic, "@dev try");
    await w.drain();
    expect(results[0]).toBe("[exit code 0]\nold runner output");
    expect(results[1]).toContain("predates background commands");
    expect(results[1]).toContain("reset the computer");
    expect(results[2]).toContain("predates background commands");
    expect(pc.commands).toEqual(["ls"]);
    expect(await db().select().from(backgroundCommands)).toEqual([]);
    expect(system).toContain("Its runner is older");
  });
});

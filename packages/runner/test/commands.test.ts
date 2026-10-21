import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CommandInfo, EventMessage } from "@witden/shared";
import { afterAll, describe, expect, it } from "vitest";
import { createRunnerCore, killTree, MemoryTransport, silentLogger } from "../src/index.js";
import { isAlive } from "../src/proc.js";
import { errorCode, makeRunner, ok, processesWithMarker, waitUntil } from "./helpers.js";

const runner = makeRunner("commands");
const { core, hub, home, workdir } = runner;
const marker = `WITDEN_TEST_MARK=${randomUUID()}`;
const env = { WITDEN_TEST_MARK: marker.split("=")[1] };
let seq = 0;
const newId = () => `cmd_test${++seq}_${Date.now()}`;

afterAll(async () => {
  // Nothing started by these tests may survive them.
  await killTree({ pids: processesWithMarker(marker), graceMs: 500 });
  await core.shutdown();
});

const exited = (id: string, from = 0) =>
  hub.waitFor<EventMessage>(
    (m) => m.type === "event" && m.event === "command.exited" && m.data.id === id,
    15_000,
    from,
  );

describe("command.*", () => {
  it("starts at once, keeps the whole output in a log file and reports the exit status", async () => {
    const id = newId();
    const started = ok<CommandInfo>(
      await hub.request("command.start", { id, command: "echo out; echo err >&2; exit 3" }),
    );
    expect(started).toMatchObject({ id, cwd: workdir, logPath: path.join(home, ".witden", "commands", `${id}.log`) });
    const r = ok(await hub.request("command.wait", { id, waitMs: 10_000 }));
    expect(r).toMatchObject({ running: false, exitCode: 3, signal: null, lost: false, output: "out\nerr\n" });
    expect(r.finishedAt).toBeTruthy();
    expect(readFileSync(r.logPath, "utf8")).toBe("out\nerr\n");
    const event = await exited(id);
    expect(event.data).toMatchObject({ exitCode: 3, tail: "out\nerr\n", outputBytes: 8 });
    // starting the same id again changes nothing
    expect(ok(await hub.request("command.start", { id, command: "echo again" }))).toMatchObject({ running: false });
    expect(readFileSync(r.logPath, "utf8")).toBe("out\nerr\n");
  });

  it("is never stopped by a wait that ends or a request that times out", async () => {
    const id = newId();
    const from = hub.messages.length;
    ok(await hub.request("command.start", { id, command: "sleep 1.5; echo finished", env }));
    const r = ok(await hub.request("command.wait", { id, waitMs: 200 }));
    expect(r).toMatchObject({ running: true, exitCode: null });
    // the runner's own deadline ends the request, not the command
    expect(ok(await hub.request("command.wait", { id, waitMs: 60_000 }, { timeoutMs: 1500 }))).toMatchObject({
      running: true,
    });
    expect(processesWithMarker(marker).length).toBeGreaterThan(0);
    const event = await exited(id, from);
    expect(event.data).toMatchObject({ running: false, exitCode: 0, tail: "finished\n" });
  });

  it("runs several commands at the same time", async () => {
    const ids = [newId(), newId(), newId()];
    const started = Date.now();
    for (const id of ids) ok(await hub.request("command.start", { id, command: `sleep 1; echo ${id}` }));
    for (const id of ids)
      expect(ok(await hub.request("command.wait", { id, waitMs: 10_000 }))).toMatchObject({ output: `${id}\n` });
    expect(Date.now() - started).toBeLessThan(2900);
    const listed = ok(await hub.request("command.list", { ids: [...ids, "cmd_unknown"], tailBytes: 100 }));
    expect(listed.commands.map((c: CommandInfo) => [c.id, c.exitCode, c.tail])).toEqual(
      ids.map((id) => [id, 0, `${id}\n`]),
    );
    expect(listed.unknown).toEqual(["cmd_unknown"]);
    expect(ok(await hub.request("command.list")).commands.length).toBeGreaterThanOrEqual(3);
  });

  it("returns the head and the tail of a long output, the log keeps all of it", async () => {
    const id = newId();
    ok(
      await hub.request("command.start", {
        id,
        command: "echo START; head -c 100000 /dev/zero | tr '\\0' a; echo; echo END",
      }),
    );
    const r = ok(await hub.request("command.wait", { id, waitMs: 10_000, outputLimit: 1000 }));
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(1000);
    expect(r.output.startsWith("START")).toBe(true);
    expect(r.output.trimEnd().endsWith("END")).toBe(true);
    expect(r.output).toContain("bytes omitted");
    expect(r.outputBytes).toBe(100_011);
    expect(readFileSync(r.logPath).length).toBe(100_011);
  });

  it("stops the whole tree on command.stop, setsid daemons holding the log included", async () => {
    const id = newId();
    ok(
      await hub.request("command.start", {
        id,
        command: "sleep 300 & (setsid sleep 301 &); echo ready; sleep 302",
        env,
      }),
    );
    await waitUntil(async () => ok(await hub.request("command.wait", { id, waitMs: 0 })).output.includes("ready"));
    await waitUntil(() => processesWithMarker(marker).length >= 3, 5000);
    const r = ok(await hub.request("command.stop", { id }));
    expect(r).toMatchObject({ running: false, exitCode: 143, signal: "SIGTERM", lost: false });
    expect(r.signalled).toBeGreaterThanOrEqual(3);
    await waitUntil(() => processesWithMarker(marker).length === 0, 5000);
  });

  it("interrupts like Ctrl-C", async () => {
    const id = newId();
    ok(
      await hub.request("command.start", {
        id,
        command: "trap 'echo got INT; exit 7' INT; while :; do sleep 0.1; done",
        env,
      }),
    );
    await waitUntil(() => processesWithMarker(marker).length > 0, 5000);
    const r = ok(await hub.request("command.stop", { id, signal: "interrupt" }));
    expect(r).toMatchObject({ running: false, exitCode: 7 });
    expect(readFileSync(r.logPath, "utf8")).toContain("got INT");
    await waitUntil(() => processesWithMarker(marker).length === 0, 5000);
  });

  it("is picked up by the next runner process, which reports how it ended", async () => {
    const restart = makeRunner("commands-restart");
    const id = newId();
    const first = ok<CommandInfo>(
      await restart.hub.request("command.start", { id, command: "sleep 1.5; exit 4", env }),
    );
    await restart.core.shutdown();
    expect(isAlive(first.pid)).toBe(true);
    // a new runner process on the same computer
    const core2 = createRunnerCore({ ...restart.core.options, logger: silentLogger });
    const hub2 = new MemoryTransport(core2);
    try {
      expect(ok(await hub2.request("command.list", { ids: [id] })).commands[0]).toMatchObject({ running: true });
      const event = await hub2.waitFor<EventMessage>(
        (m) => m.type === "event" && m.event === "command.exited" && m.data.id === id,
        10_000,
      );
      expect(event.data).toMatchObject({ exitCode: 4, lost: false });
      expect(ok(await hub2.request("command.wait", { id, waitMs: 0 }))).toMatchObject({ running: false, exitCode: 4 });
    } finally {
      await core2.shutdown();
    }
    // a later runner process still answers for it from its files
    const core3 = createRunnerCore({ ...restart.core.options, logger: silentLogger });
    try {
      const hub3 = new MemoryTransport(core3);
      expect(ok(await hub3.request("command.list", { ids: [id] })).commands[0]).toMatchObject({ exitCode: 4 });
    } finally {
      await core3.shutdown();
    }
  });

  it("reports a command whose computer restarted under it as lost", async () => {
    const restart = makeRunner("commands-lost");
    const dir = restart.core.options.commandsDir;
    await restart.core.shutdown();
    // what a command left behind when the computer stopped: its state, no exit status, no process
    const id = newId();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.log`), "half done\n");
    writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        command: "make",
        cwd: "/",
        pid: 999_999_999,
        startTime: "1",
        startedAt: new Date().toISOString(),
      }),
    );
    const core2 = createRunnerCore({ ...restart.core.options, logger: silentLogger });
    const hub2 = new MemoryTransport(core2);
    try {
      const listed = ok(await hub2.request("command.list", { ids: [id], tailBytes: 100 }));
      expect(listed.commands[0]).toMatchObject({ running: false, lost: true, exitCode: null, tail: "half done\n" });
      expect(existsSync(path.join(dir, `${id}.exit`))).toBe(false);
    } finally {
      await core2.shutdown();
    }
  });

  it("announces itself in hello and rejects bad params", async () => {
    expect((await core.hello()).info.tools).toContain("command");
    expect(errorCode(await hub.request("command.start", { id: "../x", command: "true" }))).toBe("invalid");
    expect(errorCode(await hub.request("command.start", { id: newId(), command: " " }))).toBe("invalid");
    expect(errorCode(await hub.request("command.start", { id: newId(), command: "true", cwd: "missing" }))).toBe(
      "not_found",
    );
    expect(errorCode(await hub.request("command.wait", { id: "cmd_nope", waitMs: 0 }))).toBe("not_found");
    expect(errorCode(await hub.request("command.stop", { id: "cmd_nope" }))).toBe("not_found");
    expect(errorCode(await hub.request("command.list", { ids: "x" }))).toBe("invalid");
  });
});

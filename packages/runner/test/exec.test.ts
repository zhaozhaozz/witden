import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { killTree } from "../src/index.js";
import { errorCode, makeRunner, ok, processesWithMarker, waitUntil } from "./helpers.js";

const { core, hub, workdir } = makeRunner("exec");
const marker = `WITDEN_TEST_MARK=${randomUUID()}`;
const markerEnv = { WITDEN_TEST_MARK: marker.split("=")[1] };

afterAll(async () => {
  // Nothing started by these tests may survive them.
  await killTree({ pids: processesWithMarker(marker), graceMs: 500 });
  await core.shutdown();
});

describe("exec.run", () => {
  it("returns combined output in order and the exit code", async () => {
    const r = ok(await hub.request("exec.run", { command: "echo out; echo err >&2; echo again; exit 3" }));
    expect(r).toMatchObject({
      exitCode: 3,
      output: "out\nerr\nagain\n",
      timedOut: false,
      killed: false,
      truncated: false,
    });
  });

  it("runs in the workdir by default and resolves relative cwd", async () => {
    mkdirSync(path.join(workdir, "sub"), { recursive: true });
    expect(ok(await hub.request("exec.run", { command: "pwd" })).output.trim()).toBe(workdir);
    expect(ok(await hub.request("exec.run", { command: "pwd", cwd: "sub" })).output.trim()).toBe(
      path.join(workdir, "sub"),
    );
    expect(errorCode(await hub.request("exec.run", { command: "pwd", cwd: "missing" }))).toBe("not_found");
  });

  it("passes env and hides the runner token from commands", async () => {
    process.env.WITDEN_RUNNER_TOKEN = "s3cret";
    try {
      const r = ok(
        await hub.request("exec.run", { command: 'echo "[$WITDEN_RUNNER_TOKEN][$FOO]"', env: { FOO: "bar" } }),
      );
      expect(r.output.trim()).toBe("[][bar]");
    } finally {
      delete process.env.WITDEN_RUNNER_TOKEN;
    }
  });

  it("truncates output beyond outputLimit, keeping head and tail", async () => {
    const r = ok(
      await hub.request("exec.run", {
        command: "echo START; head -c 100000 /dev/zero | tr '\\0' a; echo; echo END",
        outputLimit: 1000,
      }),
    );
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(1000);
    expect(r.output.startsWith("START")).toBe(true);
    expect(r.output.trimEnd().endsWith("END")).toBe(true);
    expect(r.output).toContain("bytes omitted");
  });

  it("kills the whole process tree on timeout, including setsid daemons", async () => {
    const started = Date.now();
    const r = ok(
      await hub.request(
        "exec.run",
        { command: "sleep 300 & (setsid sleep 301 &); echo ready; sleep 302", env: markerEnv },
        { timeoutMs: 1500 },
      ),
    );
    expect(r).toMatchObject({ timedOut: true, killed: true, exitCode: null });
    expect(r.output).toContain("ready");
    expect(Date.now() - started).toBeLessThan(8000);
    await waitUntil(() => processesWithMarker(marker).length === 0, 5000);
  });

  it("stops the tree when the request is cancelled", async () => {
    const id = `cancel-${Date.now()}`;
    const pending = hub.request("exec.run", { command: "sleep 60", env: markerEnv }, { id, timeoutMs: 60_000 });
    await waitUntil(() => processesWithMarker(marker).length > 0, 5000);
    core.handleMessage({ type: "cancel", id });
    const r = ok(await pending);
    expect(r).toMatchObject({ killed: true, timedOut: false, exitCode: null });
    await waitUntil(() => processesWithMarker(marker).length === 0, 5000);
  });

  it("does not wait for background processes after the command exits", async () => {
    const started = Date.now();
    const r = ok(await hub.request("exec.run", { command: "sleep 20 & echo done", env: markerEnv }));
    expect(r.output.trim()).toBe("done");
    expect(r.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    await killTree({ pids: processesWithMarker(marker), graceMs: 500 });
  });

  it("rejects bad params", async () => {
    expect(errorCode(await hub.request("exec.run", {}))).toBe("invalid");
    expect(errorCode(await hub.request("exec.run", { command: "  " }))).toBe("invalid");
    expect(errorCode(await hub.request("exec.run", { command: "true", outputLimit: "x" }))).toBe("invalid");
  });
});

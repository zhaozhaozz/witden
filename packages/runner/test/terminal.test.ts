import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmuxArg } from "../src/ops/terminal.js";
import { errorCode, makeRunner, ok, SCRATCH, waitUntil } from "./helpers.js";

const socket = `wdtest-term-${process.pid}`;
const tmuxTmpDir = path.join(SCRATCH, "tmux");
const { core, hub, workdir } = makeRunner("terminal", { tmuxSocket: socket, tmuxTmpDir });
let previousShell: string | undefined;

beforeAll(() => {
  // A predictable shell without the developer's rc files.
  previousShell = process.env.SHELL;
  process.env.SHELL = "/bin/bash";
  mkdirSync(path.join(workdir, "sub"), { recursive: true });
});

afterAll(async () => {
  process.env.SHELL = previousShell;
  spawnSync("tmux", ["-L", socket, "kill-server"], { env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir } });
  await core.shutdown();
});

const read = async (sessionId: string) => ok(await hub.request("terminal.read", { sessionId }));
const outputContains = (sessionId: string, text: string) =>
  waitUntil(async () => (await read(sessionId)).output.includes(text), 10_000);

describe("terminal", () => {
  it("escapes a trailing semicolon for tmux", () => {
    expect(tmuxArg("ls;")).toBe("ls\\;");
    expect(tmuxArg("a\\;")).toBe("a\\\\;");
    expect(tmuxArg("plain")).toBe("plain");
  });

  it("keeps shell state between inputs", async () => {
    const { sessionId } = ok(await hub.request("terminal.create", { command: "cd sub && export FOO=bar" }));
    expect(sessionId).toMatch(/^wd-[0-9a-f]{8}$/);
    ok(await hub.request("terminal.input", { sessionId, text: 'echo "$FOO-$(basename "$PWD")-ok"' }));
    await outputContains(sessionId, "bar-sub-ok");
    // Text ending in ";" must reach the shell unchanged.
    ok(await hub.request("terminal.input", { sessionId, text: "echo semi-$((40+2));" }));
    await outputContains(sessionId, "semi-42");
    const listed = ok(await hub.request("terminal.list")).sessions as any[];
    expect(listed.find((s) => s.sessionId === sessionId)).toMatchObject({ command: "cd sub && export FOO=bar" });
  });

  it("returns the latest maxChars characters of a read (64 KiB by default)", async () => {
    const { sessionId } = ok(await hub.request("terminal.create", {}));
    ok(await hub.request("terminal.input", { sessionId, text: "seq 1 2000" }));
    await outputContains(sessionId, "2000");
    const cut = ok(await hub.request("terminal.read", { sessionId, lines: 3000, maxChars: 100 }));
    expect(cut.output.startsWith("...[earlier output truncated]")).toBe(true);
    expect(cut.output.length).toBeLessThan(140);
    const whole = ok(await hub.request("terminal.read", { sessionId, lines: 3000, maxChars: 1_000_000 }));
    expect(whole.output).toContain("\n1\n");
    expect(whole.output).not.toContain("earlier output truncated");
    ok(await hub.request("terminal.kill", { sessionId }));
  });

  it("reports a running foreground command, interrupts it and kills the session", async () => {
    const { sessionId } = ok(await hub.request("terminal.create", {}));
    ok(await hub.request("terminal.input", { sessionId, text: "sleep 30" }));
    const running = await waitUntil(async () => {
      const r = await read(sessionId);
      return r.running ? r : null;
    });
    expect(running.foreground).toBe("sleep");
    ok(await hub.request("terminal.key", { sessionId, key: "C-c" }));
    await waitUntil(async () => !(await read(sessionId)).running);

    ok(await hub.request("terminal.input", { sessionId, text: "sleep 40" }));
    await waitUntil(async () => (await read(sessionId)).running);
    const killed = ok(await hub.request("terminal.kill", { sessionId }));
    expect(killed.killed).toBeGreaterThanOrEqual(2); // the shell and sleep
    expect(errorCode(await hub.request("terminal.read", { sessionId }))).toBe("not_found");
  });

  it("validates ids and keys", async () => {
    expect(errorCode(await hub.request("terminal.read", { sessionId: "../x" }))).toBe("invalid");
    expect(errorCode(await hub.request("terminal.read", { sessionId: "wd-00000000" }))).toBe("not_found");
    const { sessionId } = ok(await hub.request("terminal.create", {}));
    expect(errorCode(await hub.request("terminal.key", { sessionId, key: "C-c;kill-server" }))).toBe("invalid");
    expect(errorCode(await hub.request("terminal.key", { sessionId, key: "-t" }))).toBe("invalid");
    expect(errorCode(await hub.request("terminal.create", { cwd: "missing-dir" }))).toBe("not_found");
    ok(await hub.request("terminal.kill", { sessionId }));
  });
});

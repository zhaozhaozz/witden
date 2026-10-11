import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResponseMessage } from "@witden/shared";
import { createRunnerCore, MemoryTransport, type RunnerCore, type RunnerOptions, silentLogger } from "../src/index.js";

/** All scratch data of the runner tests lives here (gitignored), never in /tmp. */
export const SCRATCH = fileURLToPath(new URL("../../../.tmp/runner/", import.meta.url));

export interface TestRunner {
  core: RunnerCore;
  hub: MemoryTransport;
  root: string;
  workdir: string;
  home: string;
  stateDir: string;
}

export function makeRunner(name: string, overrides: Partial<RunnerOptions> = {}): TestRunner {
  const root = path.join(SCRATCH, `${name}-${process.pid}-${randomBytes(3).toString("hex")}`);
  const workdir = path.join(root, "work");
  const home = path.join(root, "home");
  const stateDir = overrides.stateDir ?? path.join(home, ".witden-runner");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const core = createRunnerCore({
    instanceId: "inst-test",
    token: "token-test",
    workdir,
    home,
    stateDir,
    display: null,
    streamPorts: [],
    tmuxSocket: `wdtest-${process.pid}`,
    tmuxTmpDir: path.join(SCRATCH, "tmux"),
    chromiumPath: "/nonexistent/chromium",
    logger: silentLogger,
    ...overrides,
  });
  const hub = new MemoryTransport(core);
  return { core, hub, root, workdir, home, stateDir };
}

export function ok<T = Record<string, any>>(response: ResponseMessage): T {
  if (!response.ok) throw new Error(`expected ok, got ${JSON.stringify(response.error)}`);
  return response.result as T;
}

export function errorCode(response: ResponseMessage): string | undefined {
  return response.ok ? undefined : response.error?.code;
}

/** Pids of live processes whose environment contains the given marker. */
export function processesWithMarker(marker: string): number[] {
  const pids: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const env = readFileSync(`/proc/${name}/environ`, "latin1");
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      if (env.includes(marker) && state !== "Z") pids.push(Number(name));
    } catch {
      // gone or not ours
    }
  }
  return pids;
}

export async function waitUntil<T>(fn: () => T | Promise<T>, timeoutMs = 10_000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  } while (Date.now() < deadline);
  throw new Error("condition not met in time");
}

#!/usr/bin/env node
/**
 * Entry of the computer images: `witden-init [service command…]`, or `witden-init --stdio` for the Docker
 * Manager's channel. It runs the image's services (the desktop's supervisord) and the runner, restarting each
 * on its own when it exits, so a runner restart keeps the desktop up.
 *
 * Everything in a computer runs as one user, every command a role runs included, so the runner token is
 * kept out of their reach in two ways:
 * - Only the runner is given the token: services get the environment without it, and the runner leaves it
 *   out of what it starts (context.ts).
 * - Every process holding the token runs from an execute-only binary (/opt/witden/bin/node, and tini as
 *   PID 1). Linux marks such a process not dumpable: its /proc entries (environ, mem, fd) belong to root and
 *   it cannot be traced, so other processes of the same user can read neither its environment nor its
 *   memory. The platform starts these images without Docker's own init (label witden.init=protected), which
 *   would otherwise hold the container's environment as a readable PID 1.
 *
 * The runner it starts is the platform's up-to-date copy when the computer has one, else the image's own (see
 * live.ts); either runs from the same execute-only node with the same environment. When the platform installs
 * another version, the init asks the running runner to restart once it is idle, and starts the new one.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type PickedRunner, pickRunner, RESTART_NOW, sameRunner, UPDATE_SIGNAL } from "./live.js";

export { INIT_PROTOCOL } from "./live.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESTART_MS = 2_000;
const STOP_GRACE_MS = 15_000;
/** How often the platform's copy is looked at for another version. */
const POLL_MS = 20_000;
/** A platform runner exiting this soon after it started, this many times in a row, is set aside. */
const QUICK_EXIT_MS = 60_000;
const QUICK_EXITS = 3;

/** Only the runner may see these. */
export const RUNNER_SECRETS = ["WITDEN_RUNNER_TOKEN"];

function account(): { home: string; user: string; shell: string } {
  try {
    const u = os.userInfo();
    return { home: u.homedir, user: u.username, shell: u.shell ?? "" };
  } catch {
    return { home: "", user: "", shell: "" };
  }
}

/** The environment of the image's services: the container's, without the runner's secrets. */
export function serviceEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const a = account();
  const out: NodeJS.ProcessEnv = { ...env };
  out.HOME ||= a.home;
  out.USER ||= a.user;
  out.LOGNAME ||= a.user;
  if (a.shell) out.SHELL ||= a.shell;
  for (const name of RUNNER_SECRETS) delete out[name];
  return out;
}

/**
 * The runner's environment: the token, and nothing that would make it load code the computer's user can
 * write. CommonJS lookups fall back to $HOME/.node_modules (ws asks for optional add-ons), so HOME is the
 * runner's own read-only directory and the user's home goes in WITDEN_HOME; NODE_OPTIONS and NODE_PATH are
 * dropped. ``dir`` is where the runner bundle lives.
 */
export function runnerEnv(env: NodeJS.ProcessEnv, dir = here): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...serviceEnv(env) };
  for (const name of RUNNER_SECRETS) if (env[name] !== undefined) out[name] = env[name];
  out.WITDEN_HOME = out.HOME;
  out.HOME = dir;
  out.WS_NO_BUFFER_UTIL = "1";
  out.WS_NO_UTF_8_VALIDATE = "1";
  delete out.NODE_OPTIONS;
  delete out.NODE_PATH;
  return out;
}

/** True when this process cannot be inspected by others of its user (see the header). */
export function notDumpable(): boolean {
  try {
    return process.getuid?.() !== 0 && statSync("/proc/self/environ").uid === 0;
  } catch {
    return false;
  }
}

const log = (msg: string) => process.stderr.write(`[witden-init] ${msg}\n`);

/** A child that is started again when it exits, until the init stops. */
export class Kept {
  child: ChildProcess | null = null;

  constructor(
    private readonly name: string,
    private readonly start: () => ChildProcess,
    private readonly stopping: () => boolean,
    /** How long to wait before starting it again, from its exit status and how long it ran. */
    private readonly delay: (code: number | null, ranMs: number) => number = () => RESTART_MS,
  ) {}

  run(): void {
    if (this.stopping()) return;
    const child = this.start();
    this.child = child;
    const startedAt = Date.now();
    let ended = false;
    const end = (why: string, code: number | null) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = null;
      if (this.stopping()) return;
      const ms = this.delay(code, Date.now() - startedAt);
      log(`${this.name} ${why}; restarting${ms ? ` in ${ms / 1000}s` : ""}`);
      setTimeout(() => this.run(), ms);
    };
    child.on("error", (err) => end(`failed to start (${err.message})`, null));
    child.on("exit", (code, signal) => end(`exited with ${signal ?? `status ${code}`}`, code));
  }
}

const label = (r: PickedRunner) =>
  `${r.source === "live" ? "the platform's" : "the image's"} runner${r.version ? ` ${r.version}` : ""}`;

/**
 * Keeps the runner running, picking it anew at every start (live.ts). `poll` looks for another version: the
 * running runner is then asked to restart (UPDATE_SIGNAL); it exits with RESTART_NOW once idle and the new one
 * starts at once. A platform version that keeps exiting right after it starts is set aside for the image's copy
 * until another version is installed.
 */
export class RunnerKeeper {
  readonly kept: Kept;
  running: PickedRunner | null = null;
  private avoid: string | null = null;
  private quickExits = 0;
  private asked = false;

  constructor(
    private readonly pick: (avoid: string | null) => PickedRunner,
    spawnRunner: (runner: PickedRunner) => ChildProcess,
    stopping: () => boolean,
    private readonly restartMs = RESTART_MS,
  ) {
    const start = () => {
      const runner = this.pick(this.avoid);
      this.running = runner;
      this.asked = false;
      log(`starting ${label(runner)}`);
      return spawnRunner(runner);
    };
    this.kept = new Kept("runner", start, stopping, (code, ranMs) => this.exited(code, ranMs));
  }

  private exited(code: number | null, ranMs: number): number {
    const runner = this.running;
    if (code === RESTART_NOW) {
      this.quickExits = 0;
      return 0;
    }
    if (runner?.source !== "live" || ranMs >= QUICK_EXIT_MS) this.quickExits = 0;
    else if (++this.quickExits >= QUICK_EXITS) {
      this.avoid = runner.version;
      this.quickExits = 0;
      log(`${label(runner)} keeps exiting right after it starts; using the image's own until another is installed`);
    }
    return this.restartMs;
  }

  /** Asks the running runner to restart when another one would be picked now. */
  poll(): void {
    const child = this.kept.child;
    if (!child || !this.running || this.asked) return;
    const next = this.pick(this.avoid);
    if (sameRunner(next, this.running)) return;
    this.asked = true;
    log(`${label(next)} is ready; ${label(this.running)} restarts once idle`);
    child.kill(UPDATE_SIGNAL);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const cwd = serviceEnv(process.env).HOME || "/";
  if (!notDumpable())
    log("not started from the execute-only node: other processes of this user may read the runner token");
  const startRunner = (runner: PickedRunner, extra: string[] = []) =>
    spawn(process.execPath, [path.join(runner.dir, "witden-runner.mjs"), ...extra], {
      env: runnerEnv(process.env, runner.dir),
      cwd,
      stdio: "inherit",
    });

  if (args[0] === "--stdio") {
    // One runner on this process's stdin / stdout; it ends with the channel, or makes way for another version
    // (the platform opens a new channel when it needs the computer again).
    const runner = pickRunner(here);
    const child = startRunner(runner, ["--stdio"]);
    const poll = setInterval(() => {
      if (sameRunner(pickRunner(here), runner)) return;
      clearInterval(poll);
      child.kill(UPDATE_SIGNAL);
    }, POLL_MS);
    poll.unref();
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => child.kill(sig));
    child.on("error", (err) => {
      log(`runner failed to start (${err.message})`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    return;
  }

  let stopping = false;
  const kept: Kept[] = [];
  if (args.length) {
    const [cmd, ...rest] = args;
    kept.push(
      new Kept(
        path.basename(cmd),
        () => spawn(cmd, rest, { env: serviceEnv(process.env), cwd, stdio: "inherit" }),
        () => stopping,
      ),
    );
  }
  const runner = new RunnerKeeper(
    (avoid) => pickRunner(here, { avoid }),
    (r) => startRunner(r),
    () => stopping,
  );
  kept.push(runner.kept);
  for (const k of kept) k.run();
  setInterval(() => runner.poll(), POLL_MS);

  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    const alive = kept.map((k) => k.child).filter((c): c is ChildProcess => !!c && c.exitCode === null);
    for (const c of alive) c.kill(signal);
    let left = alive.length;
    if (!left) process.exit(0);
    for (const c of alive)
      c.once("exit", () => {
        if (--left === 0) process.exit(0);
      });
    setTimeout(() => {
      for (const c of alive) c.kill("SIGKILL");
      process.exit(0);
    }, STOP_GRACE_MS).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

// Imported by tests for its helpers; runs only as the entry point.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

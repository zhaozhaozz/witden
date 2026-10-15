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
 */
import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESTART_MS = 2_000;
const STOP_GRACE_MS = 15_000;

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
class Kept {
  child: ChildProcess | null = null;

  constructor(
    private readonly name: string,
    private readonly start: () => ChildProcess,
    private readonly stopping: () => boolean,
  ) {}

  run(): void {
    if (this.stopping()) return;
    const child = this.start();
    this.child = child;
    let ended = false;
    const end = (why: string) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = null;
      if (this.stopping()) return;
      log(`${this.name} ${why}; restarting in ${RESTART_MS / 1000}s`);
      setTimeout(() => this.run(), RESTART_MS);
    };
    child.on("error", (err) => end(`failed to start (${err.message})`));
    child.on("exit", (code, signal) => end(`exited with ${signal ?? `status ${code}`}`));
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const runner = path.join(here, "witden-runner.mjs");
  const cwd = serviceEnv(process.env).HOME || "/";
  if (!notDumpable())
    log("not started from the execute-only node: other processes of this user may read the runner token");

  if (args[0] === "--stdio") {
    // One runner on this process's stdin / stdout; it ends with the channel.
    const child = spawn(process.execPath, [runner, "--stdio"], { env: runnerEnv(process.env), cwd, stdio: "inherit" });
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
  kept.push(
    new Kept(
      "runner",
      () => spawn(process.execPath, [runner], { env: runnerEnv(process.env), cwd, stdio: "inherit" }),
      () => stopping,
    ),
  );
  for (const k of kept) k.run();

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

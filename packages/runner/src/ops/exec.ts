import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { ExecRunResult } from "@witden/shared";
import type { Env, OpContext } from "../context.js";
import { OpError } from "../errors.js";
import { optEnv, optInt, optString, reqString } from "../params.js";
import { fdLinks, killTree } from "../proc.js";
import { resolveUserPath } from "../util.js";

const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const MAX_OUTPUT_LIMIT = 16 * 1024 * 1024;
/** After the shell exits, how long to wait for output still in flight. */
const DRAIN_MS = 300;

/** Keeps the head and the tail of a long output, dropping the middle. */
class OutputCollector {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  total = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headBytes < this.limit) {
      const take = chunk.subarray(0, this.limit - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tail.length > 1 && this.tailBytes - this.tail[0].length >= this.limit) {
      this.tailBytes -= this.tail.shift()!.length;
    }
  }

  result(): { output: string; truncated: boolean } {
    const head = Buffer.concat(this.head);
    if (this.total <= this.limit) return { output: head.toString("utf8"), truncated: false };
    const marker = Buffer.from(`\n... [${this.total - this.limit} bytes omitted] ...\n`);
    if (this.limit < marker.length * 4) return { output: head.toString("utf8"), truncated: true };
    const headPart = Math.floor((this.limit - marker.length) / 2);
    const tailPart = this.limit - marker.length - headPart;
    const tail = Buffer.concat(this.tail);
    const out = Buffer.concat([head.subarray(0, headPart), marker, tail.subarray(tail.length - tailPart)]);
    return { output: out.toString("utf8"), truncated: true };
  }
}

/**
 * exec.run: `/bin/sh -c` in its own session / process group with stdout and stderr combined. On timeout or
 * cancel the whole tree is stopped: the process group, all descendants and anything still holding the output
 * socket (daemons that used setsid and were reparented).
 */
export async function execRun(params: Record<string, unknown>, ctx: OpContext, env: Env): Promise<ExecRunResult> {
  const command = reqString(params, "command");
  if (!command.trim()) throw new OpError("invalid", "command is empty");
  const cwd = resolveUserPath(optString(params, "cwd") ?? env.workdir, env.workdir, env.home);
  const cwdStat = await stat(cwd).catch(() => null);
  if (!cwdStat) throw new OpError("not_found", `working directory ${cwd} does not exist`);
  if (!cwdStat.isDirectory()) throw new OpError("invalid", `${cwd} is not a directory`);
  const limit = optInt(params, "outputLimit", 1, MAX_OUTPUT_LIMIT) ?? DEFAULT_OUTPUT_LIMIT;
  const extraEnv = optEnv(params, "env") ?? {};

  // `exec 2>&1` gives one socket for both streams, so output keeps its real order.
  const child = spawn("/bin/sh", ["-c", 'exec 2>&1; exec /bin/sh -c "$1"', "sh", command], {
    cwd,
    env: env.childEnv({ TERM: "dumb", ...extraEnv }),
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const pid = child.pid;
  const links = new Set(pid ? fdLinks(pid, [1]) : []);
  const collector = new OutputCollector(limit);

  return new Promise<ExecRunResult>((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let killing = false;
    let killed = false;
    let timedOut = false;
    let drainTimer: NodeJS.Timeout | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      ctx.signal.removeEventListener("abort", onAbort);
      const { output, truncated } = collector.result();
      resolve({ exitCode: killed ? null : exitCode, output, timedOut, truncated, killed });
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      if (!settled) collector.push(chunk);
    });
    // Background processes may keep the socket open; keep draining (and discarding) so they never block.
    child.stdout!.on("error", () => {});
    child.on("error", (err) => {
      if (!settled && pid === undefined) {
        settled = true;
        reject(err);
      }
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      if (!killing) drainTimer = setTimeout(finish, DRAIN_MS);
    });
    child.on("close", () => {
      if (!killing) finish();
    });

    const onAbort = async () => {
      if (exited || settled || pid === undefined) return;
      killing = true;
      const count = await killTree({ pids: [pid], pgids: [pid], links, graceMs: 2000 });
      killed = count > 0;
      timedOut = killed && ctx.signal.reason === "timeout";
      // Let the exit event and the last output arrive.
      const waitUntil = Date.now() + 1000;
      while (!exited && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 20));
      setTimeout(finish, exited ? 50 : 0);
    };
    if (ctx.signal.aborted) void onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
}

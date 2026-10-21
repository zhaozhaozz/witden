import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import type { CommandInfo, CommandListResult, CommandOutputResult } from "@witden/shared";
import type { Env, OpContext } from "../context.js";
import { OpError } from "../errors.js";
import type { Logger } from "../log.js";
import { optEnum, optEnv, optInt, optString, reqString } from "../params.js";
import { descendantsOf, isAlive, killTree, listProcs, readStat } from "../proc.js";
import { resolveUserPath } from "../util.js";

const ID = /^[A-Za-z0-9_-]{1,80}$/;
/** How often commands started by an earlier runner process (not our children) are looked at. */
const POLL_MS = 1000;
const DEFAULT_OUTPUT_LIMIT = 12_000;
const MAX_OUTPUT_LIMIT = 4 * 1024 * 1024;
const MAX_WAIT_MS = 24 * 3600_000;
const MAX_TAIL = 64 * 1024;
/** Tail sent with "command.exited". */
const EVENT_TAIL = 2000;
const LIST_LIMIT = 200;
const STOP_WAIT_MS = 3000;

/**
 * The wrapper the command runs under (`sh -c WRAPPER witden-command <command> <log> <exit file>`): it runs the
 * command in its foreground, then writes the exit status atomically. Only the command's own redirection opens
 * the log, so the processes holding the log are the command's, never the wrapper. INT, TERM and HUP are caught
 * with a no-op, so a signal to the whole group ends the command but not the bookkeeping (caught signals are
 * back to their defaults in the command itself).
 */
const WRAPPER =
  'trap : HUP INT TERM; /bin/sh -c "$1" >>"$2" 2>&1 </dev/null; c=$?; echo "$c" >"$3.tmp" && mv -f "$3.tmp" "$3"';

interface Meta {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  /** /proc start time of the wrapper: with the pid it tells the process apart from a later one. */
  startTime: string;
  startedAt: string;
  exitCode?: number | null;
  signal?: string | null;
  finishedAt?: string | null;
  lost?: boolean;
}

interface Entry {
  meta: Meta;
  /** Our child (null for commands an earlier runner process started). */
  child: ChildProcess | null;
  waiters: Set<() => void>;
}

const SIGNALS = new Map(Object.entries(osConstants.signals).map(([name, n]) => [n as number, name]));

/** A shell reports death by signal n as 128 + n. */
function signalOf(code: number | null): string | null {
  return code !== null && code > 128 && code <= 128 + 64 ? (SIGNALS.get(code - 128) ?? null) : null;
}

function checkId(id: string): string {
  if (!ID.test(id)) throw new OpError("invalid", "invalid command id");
  return id;
}

/** UTF-8 text of a byte range, without a character cut in half at either end. */
function utf8(buf: Buffer, from: "start" | "end"): string {
  let b = buf;
  if (from === "end") {
    let i = 0;
    while (i < b.length && i < 4 && (b[i] & 0xc0) === 0x80) i++;
    b = b.subarray(i);
    return b.toString("utf8");
  }
  // A decoder in streaming mode keeps an incomplete last character to itself.
  return new TextDecoder().decode(b, { stream: true });
}

/**
 * Commands that outlive the request that started them (command.*). Each runs detached in its own session
 * with its output in ``<dir>/<id>.log``; ``<id>.exit`` holds its exit status and ``<id>.json`` what the runner
 * knows about it, so a restarted runner picks up where the previous one left off. Nothing here ever stops a
 * command by itself: not a timeout, a lost connection or a runner shutdown — only command.stop.
 */
export class Commands {
  private readonly entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly env: Env,
    readonly dir: string,
    private readonly log: Logger,
    private readonly emit: (event: string, data: Record<string, unknown>) => void,
  ) {}

  private file(id: string, ext: "log" | "exit" | "json"): string {
    return path.join(this.dir, `${id}.${ext}`);
  }

  /**
   * Takes over the commands an earlier runner process started and that had not ended then (their files are
   * in ``dir``). Ended ones are read again only when asked for: their files stay until someone removes them.
   */
  load(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return; // no command ever ran here
    }
    for (const name of names) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      const meta = ID.test(id) ? this.readMeta(id) : null;
      if (meta && !meta.finishedAt) this.entries.set(id, { meta, child: null, waiters: new Set() });
    }
    this.schedule();
  }

  /** What ``<id>.json`` says (null when missing or not ours: the directory is writable by the computer's user). */
  private readMeta(id: string): Meta | null {
    try {
      const raw = JSON.parse(readFileSync(this.file(id, "json"), "utf8"));
      if (raw?.id !== id || !Number.isInteger(raw.pid) || typeof raw.command !== "string") return null;
      return {
        id,
        command: raw.command,
        cwd: String(raw.cwd ?? ""),
        pid: raw.pid,
        startTime: String(raw.startTime ?? ""),
        startedAt: String(raw.startedAt ?? ""),
        ...(raw.finishedAt
          ? {
              exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null,
              signal: typeof raw.signal === "string" ? raw.signal : null,
              finishedAt: String(raw.finishedAt),
              lost: !!raw.lost,
            }
          : {}),
      };
    } catch {
      return null; // half written, or not there
    }
  }

  /** A command this runner knows, or one an earlier runner process recorded. */
  private lookup(id: string): Entry | undefined {
    const known = this.entries.get(id);
    if (known) return known;
    const meta = this.readMeta(id);
    if (!meta) return undefined;
    const entry: Entry = { meta, child: null, waiters: new Set() };
    this.entries.set(id, entry);
    this.schedule();
    return entry;
  }

  /** Stops looking after commands (they keep running; a next runner process takes them over). */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async start(params: Record<string, unknown>, _ctx: OpContext): Promise<CommandInfo> {
    const id = checkId(reqString(params, "id", 100));
    const known = this.lookup(id);
    if (known) return this.info(known);
    const command = reqString(params, "command");
    if (!command.trim()) throw new OpError("invalid", "command is empty");
    const cwd = resolveUserPath(optString(params, "cwd") ?? this.env.workdir, this.env.workdir, this.env.home);
    const cwdStat = await stat(cwd).catch(() => null);
    if (!cwdStat) throw new OpError("not_found", `working directory ${cwd} does not exist`);
    if (!cwdStat.isDirectory()) throw new OpError("invalid", `${cwd} is not a directory`);
    const extraEnv = optEnv(params, "env") ?? {};
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const logPath = this.file(id, "log");
    writeFileSync(logPath, "", { flag: "a", mode: 0o600 });
    const child = spawn("/bin/sh", ["-c", WRAPPER, "witden-command", command, logPath, this.file(id, "exit")], {
      cwd,
      env: this.env.childEnv({ TERM: "dumb", ...extraEnv }),
      detached: true,
      stdio: "ignore",
    });
    if (child.pid === undefined) {
      const err = await new Promise<Error>((resolve) => child.once("error", resolve));
      throw new OpError("failed", `cannot start the command: ${err.message}`);
    }
    // The runner may exit or restart while the command runs.
    child.unref();
    const meta: Meta = {
      id,
      command,
      cwd,
      pid: child.pid,
      startTime: readStat(child.pid)?.startTime ?? "",
      startedAt: new Date().toISOString(),
    };
    const entry: Entry = { meta, child, waiters: new Set() };
    this.entries.set(id, entry);
    this.writeMeta(meta);
    child.on("exit", () => this.check(entry));
    child.on("error", () => this.check(entry));
    this.schedule();
    return this.info(entry);
  }

  /** The command's state and output (head and tail when long), after waiting up to waitMs for it to end. */
  async wait(params: Record<string, unknown>, ctx: OpContext): Promise<CommandOutputResult> {
    const entry = this.get(params);
    const waitMs = optInt(params, "waitMs", 0, MAX_WAIT_MS) ?? 0;
    const limit = optInt(params, "outputLimit", 0, MAX_OUTPUT_LIMIT) ?? DEFAULT_OUTPUT_LIMIT;
    this.check(entry);
    // Leave a second to answer before the request's own deadline.
    const ms = Math.min(waitMs, ctx.deadline - Date.now() - 1000);
    if (!entry.meta.finishedAt && ms > 0) await this.until(entry, ms, ctx.signal);
    return { ...this.info(entry), ...this.excerpt(entry.meta.id, limit) };
  }

  list(params: Record<string, unknown>): CommandListResult {
    const raw = params.ids;
    if (raw !== undefined && (!Array.isArray(raw) || raw.length > 1000 || raw.some((x) => typeof x !== "string")))
      throw new OpError("invalid", "params.ids must be a list of command ids");
    const tailBytes = optInt(params, "tailBytes", 0, MAX_TAIL) ?? 0;
    const unknown: string[] = [];
    let picked: Entry[];
    if (raw) {
      picked = [];
      for (const id of raw as string[]) {
        const entry = ID.test(id) ? this.lookup(id) : undefined;
        if (entry) picked.push(entry);
        else unknown.push(id);
      }
    } else {
      picked = [...this.entries.values()]
        .sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt))
        .slice(0, LIST_LIMIT);
    }
    const commands = picked.map((entry) => {
      this.check(entry);
      const info = this.info(entry);
      return entry.meta.finishedAt && tailBytes ? { ...info, tail: this.tail(entry.meta.id, tailBytes) } : info;
    });
    return { commands, unknown };
  }

  /** Signals the command's processes (never the wrapper, which then records how it ended). */
  async stop(params: Record<string, unknown>, _ctx: OpContext): Promise<CommandInfo & { signalled: number }> {
    const entry = this.get(params);
    const how = optEnum(params, "signal", ["interrupt", "terminate", "kill"] as const) ?? "terminate";
    this.check(entry);
    if (entry.meta.finishedAt) return { ...this.info(entry), signalled: 0 };
    const procs = listProcs();
    const roots = procs.filter((p) => p.ppid === entry.meta.pid).map((p) => p.pid);
    let signalled = 0;
    if (how === "interrupt") {
      // Like Ctrl-C in a terminal: every process of the command gets SIGINT once.
      for (const pid of [...roots, ...descendantsOf(roots, procs)]) {
        try {
          process.kill(pid, "SIGINT");
          signalled++;
        } catch {
          // already gone
        }
      }
    } else {
      // Daemons that left the tree are still found by the log they hold open.
      let links = new Set<string>();
      try {
        links = new Set([realpathSync(this.file(entry.meta.id, "log"))]);
      } catch {
        // log removed: the tree alone
      }
      signalled = await killTree({ pids: roots, links, graceMs: how === "kill" ? 0 : 2000 });
    }
    await this.until(entry, STOP_WAIT_MS);
    return { ...this.info(entry), signalled };
  }

  private get(params: Record<string, unknown>): Entry {
    const id = checkId(reqString(params, "id", 100));
    const entry = this.lookup(id);
    if (!entry) throw new OpError("not_found", `no command ${id} in this computer`);
    return entry;
  }

  /** Resolves when the command has ended, ``ms`` have passed or ``signal`` fired. */
  private async until(entry: Entry, ms: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + ms;
    while (!entry.meta.finishedAt && Date.now() < deadline && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          entry.waiters.delete(done);
          resolve();
        };
        // Look again now and then: a command we did not start ends without an exit event.
        const timer = setTimeout(done, Math.min(250, Math.max(0, deadline - Date.now())));
        entry.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
      this.check(entry);
    }
  }

  private schedule(): void {
    if (this.timer || this.disposed) return;
    if (![...this.entries.values()].some((e) => !e.meta.finishedAt)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const entry of this.entries.values()) this.check(entry);
      this.schedule();
    }, POLL_MS);
    this.timer.unref();
  }

  private alive(entry: Entry): boolean {
    const child = entry.child;
    if (child) return child.exitCode === null && child.signalCode === null;
    return isAlive(entry.meta.pid, entry.meta.startTime || undefined);
  }

  private readExit(id: string): { code: number | null; at: Date } | null {
    try {
      const file = this.file(id, "exit");
      const text = readFileSync(file, "utf8").trim();
      const code = /^\d{1,3}$/.test(text) ? Number(text) : null;
      return { code, at: statSync(file).mtime };
    } catch {
      return null;
    }
  }

  /** Records the end of a command once: from its exit file, or as lost when its wrapper is gone without one. */
  private check(entry: Entry): void {
    if (entry.meta.finishedAt) return;
    try {
      let exit = this.readExit(entry.meta.id);
      if (!exit) {
        if (this.alive(entry)) return;
        // The wrapper writes the file right before it exits.
        exit = this.readExit(entry.meta.id);
      }
      entry.meta = {
        ...entry.meta,
        exitCode: exit?.code ?? null,
        signal: signalOf(exit?.code ?? null),
        finishedAt: (exit?.at ?? new Date()).toISOString(),
        lost: !exit,
      };
      entry.child = null;
      this.writeMeta(entry.meta);
    } catch (err) {
      this.log.warn("cannot check a command", { id: entry.meta.id, error: String(err) });
      return;
    }
    for (const done of [...entry.waiters]) done();
    this.emit("command.exited", { ...this.info(entry), tail: this.tail(entry.meta.id, EVENT_TAIL) });
  }

  private writeMeta(meta: Meta): void {
    const file = this.file(meta.id, "json");
    writeFileSync(`${file}.tmp`, JSON.stringify(meta), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  private info(entry: Entry): CommandInfo {
    const m = entry.meta;
    const logPath = this.file(m.id, "log");
    let outputBytes = 0;
    try {
      outputBytes = statSync(logPath).size;
    } catch {
      // removed by someone in the computer
    }
    return {
      id: m.id,
      command: m.command,
      cwd: m.cwd,
      logPath,
      pid: m.pid,
      startedAt: m.startedAt,
      running: !m.finishedAt,
      exitCode: m.exitCode ?? null,
      signal: m.signal ?? null,
      finishedAt: m.finishedAt ?? null,
      lost: !!m.lost,
      outputBytes,
    };
  }

  /** Bytes [position, position + length) of the log. */
  private read(fd: number, position: number, length: number): Buffer {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, position);
    return buf.subarray(0, n);
  }

  private tail(id: string, bytes: number): string {
    let fd: number;
    try {
      fd = openSync(this.file(id, "log"), "r");
    } catch {
      return "";
    }
    try {
      const size = fstatSync(fd).size;
      const take = Math.min(size, bytes);
      return utf8(this.read(fd, size - take, take), "end");
    } finally {
      closeSync(fd);
    }
  }

  /** The output whole, or its head and tail with a marker between when it is longer than ``limit`` bytes. */
  private excerpt(id: string, limit: number): { output: string; truncated: boolean } {
    let fd: number;
    try {
      fd = openSync(this.file(id, "log"), "r");
    } catch {
      return { output: "", truncated: false };
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= limit) return { output: this.read(fd, 0, size).toString("utf8"), truncated: false };
      const marker = `\n... [${size - limit} bytes omitted] ...\n`;
      const room = Math.max(0, limit - marker.length);
      const head = Math.floor(room / 2);
      const tail = room - head;
      const output = `${utf8(this.read(fd, 0, head), "start")}${marker}${utf8(this.read(fd, size - tail, tail), "end")}`;
      return { output, truncated: true };
    } finally {
      closeSync(fd);
    }
  }
}

import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentReadResult, AgentStartResult } from "@witden/shared";
import type { Env, OpContext } from "../context.js";
import { OpError } from "../errors.js";
import { optBool, optEnv, optInt, optString, reqString } from "../params.js";
import { isAlive, killTree, readStat } from "../proc.js";
import { ByteRing, randomHex, resolveUserPath } from "../util.js";

const RING_BYTES = 256 * 1024;
const POLL_MS = 200;
const EMIT_EVERY_MS = 500;
const MAX_EVENT_CHARS = 64 * 1024;
/** The output log is cut back when it grows past this (its tail is kept in output.prev). */
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const KEEP_FINISHED = 50;
const SESSION_ID = /^ag-[0-9a-f]{4,32}$/;

interface Meta {
  sessionId: string;
  pid: number;
  startTime: string;
  command: string;
  cwd: string;
  createdAt: string;
  requestId: string;
}

interface AgentSession {
  meta: Meta;
  dir: string;
  child: ChildProcess | null;
  stdinOpen: boolean;
  offset: number;
  ring: ByteRing;
  decoder: StringDecoder;
  pending: string;
  lastEmit: number;
  running: boolean;
  exitCode: number | null;
  exitSignal: string | null;
}

/**
 * Third-party agents (e.g. a coding CLI) run as processes inside the computer. They are detached and write to
 * a log file under <stateDir>/agents/<id>/, so a runner restart neither kills them nor loses their output; the
 * runner tails that file into a ring buffer and throttled `agent.output` events, then emits `agent.exit`.
 * Input is only possible from the runner that started the agent (stdin is a pipe).
 */
export class Agents {
  private readonly sessions = new Map<string, AgentSession>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly env: Env,
    private readonly dir: string,
    private readonly emit: (event: string, data: Record<string, unknown>, sessionId: string, requestId: string) => void,
  ) {}

  /** Picks up agents started by a previous runner process. */
  restore(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    const finished: { dir: string; createdAt: string }[] = [];
    for (const name of names) {
      const dir = path.join(this.dir, name);
      let meta: Meta;
      try {
        meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as Meta;
      } catch {
        continue;
      }
      if (!SESSION_ID.test(meta.sessionId)) continue;
      const session = this.newSession(meta, dir, null);
      session.offset = this.preload(session);
      session.running = isAlive(meta.pid, meta.startTime);
      if (!session.running) {
        session.exitCode = readExitCode(dir);
        finished.push({ dir, createdAt: meta.createdAt });
      }
      this.sessions.set(meta.sessionId, session);
    }
    // Forget old finished agents.
    finished.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.sessions.delete(path.basename(old.dir));
      rmSync(old.dir, { recursive: true, force: true });
    }
    this.schedule();
  }

  private newSession(meta: Meta, dir: string, child: ChildProcess | null): AgentSession {
    return {
      meta,
      dir,
      child,
      stdinOpen: false,
      offset: 0,
      ring: new ByteRing(RING_BYTES),
      decoder: new StringDecoder("utf8"),
      pending: "",
      lastEmit: 0,
      running: true,
      exitCode: null,
      exitSignal: null,
    };
  }

  /** Fills the ring from output.prev + output.log; returns the log offset to continue from. */
  private preload(session: AgentSession): number {
    for (const name of ["output.prev", "output.log"]) {
      try {
        const data = readFileSync(path.join(session.dir, name));
        session.ring.push(data);
        if (name === "output.log") return data.length;
      } catch {
        // missing
      }
    }
    return 0;
  }

  async start(params: Record<string, unknown>, ctx: OpContext): Promise<AgentStartResult> {
    const command = reqString(params, "command", 100_000);
    if (!command.trim()) throw new OpError("invalid", "command is empty");
    const prompt = optString(params, "prompt", 10_000_000) ?? "";
    const keepStdin = optBool(params, "keepStdin") ?? false;
    const extraEnv = optEnv(params, "env") ?? {};
    const cwd = resolveUserPath(optString(params, "cwd") ?? this.env.workdir, this.env.workdir, this.env.home);
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) {
      throw new OpError("not_found", `working directory ${cwd} does not exist`);
    }

    const sessionId = `ag-${randomHex(6)}`;
    const dir = path.join(this.dir, sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const exitFile = path.join(dir, "exit");
    const log = openSync(path.join(dir, "output.log"), "a");
    // The wrapper records the exit code so a later runner process can still report it.
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        '/bin/sh -c "$1"; code=$?; echo "$code" > "$2.tmp" && mv "$2.tmp" "$2"; exit "$code"',
        "agent",
        command,
        exitFile,
      ],
      { cwd, env: this.env.childEnv(extraEnv), detached: true, stdio: ["pipe", log, log] },
    );
    closeSync(log);
    const pid = child.pid;
    if (pid === undefined) {
      const err = await new Promise<Error>((resolve) => child.once("error", resolve));
      throw new OpError("failed", `cannot start the agent: ${err.message}`);
    }
    const meta: Meta = {
      sessionId,
      pid,
      startTime: readStat(pid)?.startTime ?? "",
      command,
      cwd,
      createdAt: new Date().toISOString(),
      requestId: ctx.requestId,
    };
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
    const session = this.newSession(meta, dir, child);
    session.stdinOpen = true;
    this.sessions.set(sessionId, session);

    child.stdin!.on("error", () => {
      session.stdinOpen = false;
    });
    child.on("exit", (code, signal) => {
      session.exitSignal = signal;
      this.finish(session, code);
    });
    if (prompt) child.stdin!.write(prompt);
    if (!keepStdin) {
      child.stdin!.end();
      session.stdinOpen = false;
    }
    child.unref();
    this.schedule();
    return { sessionId, pid };
  }

  async input(params: Record<string, unknown>): Promise<{ sessionId: string }> {
    const session = this.get(params);
    const text = optString(params, "text", 10_000_000) ?? "";
    const close = optBool(params, "close") ?? false;
    if (!session.running) throw new OpError("invalid", `agent ${session.meta.sessionId} has exited`);
    if (!session.child || !session.stdinOpen) {
      throw new OpError("invalid", `the stdin of agent ${session.meta.sessionId} is closed`);
    }
    const stdin = session.child.stdin!;
    if (text) await new Promise<void>((resolve, reject) => stdin.write(text, (err) => (err ? reject(err) : resolve())));
    if (close) {
      stdin.end();
      session.stdinOpen = false;
    }
    return { sessionId: session.meta.sessionId };
  }

  async read(params: Record<string, unknown>): Promise<AgentReadResult> {
    const session = this.get(params);
    this.pump(session);
    const maxBytes = optInt(params, "maxBytes", 1, RING_BYTES) ?? RING_BYTES;
    return {
      sessionId: session.meta.sessionId,
      output: session.ring.toBuffer(maxBytes).toString("utf8"),
      running: session.running,
      exitCode: session.exitCode,
    };
  }

  async stop(params: Record<string, unknown>): Promise<{ sessionId: string; killed: number }> {
    const session = this.get(params);
    if (!session.running) return { sessionId: session.meta.sessionId, killed: 0 };
    const { pid } = session.meta;
    const killed = await killTree({ pids: [pid], pgids: [pid], graceMs: 2000 });
    return { sessionId: session.meta.sessionId, killed };
  }

  /** Stops polling; agent processes keep running. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const session of this.sessions.values()) session.child?.stdin?.destroy();
  }

  private get(params: Record<string, unknown>): AgentSession {
    const id = reqString(params, "sessionId", 100);
    const session = this.sessions.get(id);
    if (!session) throw new OpError("not_found", `agent session ${id} not found`);
    return session;
  }

  private schedule(): void {
    if (this.timer || ![...this.sessions.values()].some((s) => s.running)) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref();
  }

  private poll(): void {
    let anyRunning = false;
    for (const session of this.sessions.values()) {
      if (!session.running) continue;
      this.pump(session);
      // Agents adopted from an earlier runner are not our children: watch their pid instead.
      if (!session.child && !isAlive(session.meta.pid, session.meta.startTime)) {
        this.finish(session, readExitCode(session.dir));
      }
      if (session.running) anyRunning = true;
    }
    if (!anyRunning && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Reads new output from the log file into the ring and the pending event text. */
  private pump(session: AgentSession, force = false): void {
    const file = path.join(session.dir, "output.log");
    if (!existsSync(file)) return;
    let fd: number;
    try {
      fd = openSync(file, "r+");
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < session.offset) session.offset = 0;
      while (session.offset < size) {
        const buf = Buffer.alloc(Math.min(1024 * 1024, size - session.offset));
        const n = readSync(fd, buf, 0, buf.length, session.offset);
        if (n <= 0) break;
        const chunk = buf.subarray(0, n);
        session.offset += n;
        session.ring.push(chunk);
        session.pending += session.decoder.write(chunk);
        if (session.pending.length > MAX_EVENT_CHARS) session.pending = session.pending.slice(-MAX_EVENT_CHARS);
      }
      if (session.offset > MAX_LOG_BYTES) {
        writeFileSync(path.join(session.dir, "output.prev"), session.ring.toBuffer());
        ftruncateSync(fd, 0);
        session.offset = 0;
      }
    } finally {
      closeSync(fd);
    }
    const now = Date.now();
    if (session.pending && (force || now - session.lastEmit >= EMIT_EVERY_MS)) {
      session.lastEmit = now;
      const text = session.pending;
      session.pending = "";
      this.emit("agent.output", { text }, session.meta.sessionId, session.meta.requestId);
    }
  }

  private finish(session: AgentSession, code: number | null): void {
    if (!session.running) return;
    this.pump(session, true);
    session.running = false;
    session.stdinOpen = false;
    // The wrapper's exit file holds the agent's own status even when only the wrapper was waited for.
    session.exitCode = readExitCode(session.dir) ?? code;
    this.emit(
      "agent.exit",
      { exitCode: session.exitCode, signal: session.exitSignal },
      session.meta.sessionId,
      session.meta.requestId,
    );
  }
}

function readExitCode(dir: string): number | null {
  try {
    const code = Number.parseInt(readFileSync(path.join(dir, "exit"), "utf8").trim(), 10);
    return Number.isInteger(code) ? code : null;
  } catch {
    return null;
  }
}

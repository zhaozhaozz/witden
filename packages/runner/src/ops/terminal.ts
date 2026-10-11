import { stat } from "node:fs/promises";
import type { TerminalCreateResult, TerminalInfo, TerminalKillResult, TerminalReadResult } from "@witden/shared";
import type { Env, OpContext } from "../context.js";
import { remainingMs } from "../context.js";
import { OpError } from "../errors.js";
import { optBool, optInt, optString, reqString } from "../params.js";
import { descendantsOf, killTree, listProcs, readStat } from "../proc.js";
import { runTool } from "../tools.js";
import { randomHex, resolveUserPath } from "../util.js";

const SESSION_ID = /^wd-[A-Za-z0-9_-]{1,64}$/;
const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,31}$/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish", "ash", "ksh", "tmux"]);
const MAX_READ_CHARS = 64 * 1024;

/**
 * tmux treats an argv element ending in ";" as a command separator; "\;" yields a literal ";". Every
 * user-controlled argument goes through this so text such as "ls;" is typed as is.
 */
export function tmuxArg(value: string): string {
  return value.endsWith(";") ? `${value.slice(0, -1)}\\;` : value;
}

/** Exact-match target for a session's active pane. */
const target = (sessionId: string) => `=${sessionId}:`;

function checkId(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new OpError("invalid", "invalid terminal session id");
  return sessionId;
}

/** Persistent interactive terminals, one tmux session each, on a dedicated tmux server (`tmux -L`). */
export class Terminals {
  constructor(
    private readonly env: Env,
    private readonly socket: string,
    private readonly tmpDir: string | null,
  ) {}

  private async tmux(args: string[], ctx?: OpContext): Promise<{ code: number | null; out: string; err: string }> {
    const extra: Record<string, string> = { TERM: "xterm-256color" };
    if (this.tmpDir) extra.TMUX_TMPDIR = this.tmpDir;
    const env = this.env.childEnv(extra);
    delete env.TMUX; // never talk to a tmux the runner itself might be running in
    const res = await runTool("tmux", ["-L", this.socket, ...args], {
      env,
      cwd: this.env.home,
      signal: ctx?.signal,
      timeoutMs: ctx ? Math.min(remainingMs(ctx), 30_000) : 30_000,
    });
    return { code: res.code, out: res.stdout.toString("utf8"), err: res.stderr.trim() };
  }

  private async checked(args: string[], ctx: OpContext, sessionId?: string): Promise<string> {
    const res = await this.tmux(args, ctx);
    if (res.code === 0) return res.out;
    if (sessionId && /can't find|no server running|error connecting|no such/i.test(res.err)) {
      throw new OpError("not_found", `terminal session ${sessionId} not found`);
    }
    throw new OpError("failed", `tmux ${args[0]} failed: ${res.err || `exit ${res.code}`}`);
  }

  async create(params: Record<string, unknown>, ctx: OpContext): Promise<TerminalCreateResult> {
    const command = optString(params, "command", 100_000) ?? "";
    const cwd = resolveUserPath(optString(params, "cwd") ?? this.env.workdir, this.env.workdir, this.env.home);
    const st = await stat(cwd).catch(() => null);
    if (!st?.isDirectory()) throw new OpError("not_found", `working directory ${cwd} does not exist`);
    const sessionId = `wd-${randomHex(4)}`;
    // history-limit only applies to panes created after it is set, hence the global option first.
    await this.checked(
      [
        "start-server",
        ";",
        "set-option",
        "-g",
        "history-limit",
        "50000",
        ";",
        "new-session",
        "-d",
        "-s",
        sessionId,
        "-x",
        "200",
        "-y",
        "50",
        "-c",
        cwd,
      ],
      ctx,
    );
    const t = target(sessionId);
    await this.checked(
      [
        "set-option",
        "-w",
        "-t",
        t,
        "remain-on-exit",
        "on",
        ";",
        "set-option",
        "-t",
        t,
        "@witden_command",
        Buffer.from(command).toString("base64"),
      ],
      ctx,
      sessionId,
    );
    if (command) {
      await this.checked(["send-keys", "-t", t, "-l", "--", tmuxArg(command)], ctx, sessionId);
      await this.checked(["send-keys", "-t", t, "Enter"], ctx, sessionId);
    }
    return { sessionId };
  }

  async input(params: Record<string, unknown>, ctx: OpContext): Promise<{ sessionId: string }> {
    const sessionId = checkId(reqString(params, "sessionId", 100));
    const text = optString(params, "text", 1_000_000) ?? "";
    const enter = optBool(params, "enter") ?? true;
    if (text) await this.checked(["send-keys", "-t", target(sessionId), "-l", "--", tmuxArg(text)], ctx, sessionId);
    if (enter) await this.checked(["send-keys", "-t", target(sessionId), "Enter"], ctx, sessionId);
    if (!text && !enter) await this.checked(["has-session", "-t", target(sessionId)], ctx, sessionId);
    return { sessionId };
  }

  async key(params: Record<string, unknown>, ctx: OpContext): Promise<{ sessionId: string }> {
    const sessionId = checkId(reqString(params, "sessionId", 100));
    const keys = reqString(params, "key", 1000).trim().split(/\s+/);
    if (!keys[0] || keys.some((k) => !KEY_NAME.test(k))) {
      throw new OpError("invalid", 'key must be tmux key names such as "C-c", "Enter" or "Up"');
    }
    await this.checked(["send-keys", "-t", target(sessionId), ...keys], ctx, sessionId);
    return { sessionId };
  }

  async read(params: Record<string, unknown>, ctx: OpContext): Promise<TerminalReadResult> {
    const sessionId = checkId(reqString(params, "sessionId", 100));
    const lines = optInt(params, "lines", 1, 50_000) ?? 200;
    const out = await this.checked(
      ["capture-pane", "-p", "-J", "-t", target(sessionId), "-S", `-${lines}`],
      ctx,
      sessionId,
    );
    const info = await this.checked(
      ["display-message", "-p", "-t", target(sessionId), "#{pane_pid}\t#{pane_dead}\t#{pane_current_command}"],
      ctx,
      sessionId,
    );
    const [pid, dead, current] = info.trim().split("\t");
    const { running, foreground } = foregroundOf(Number(pid), dead === "1", current ?? "");
    let output = out.replace(/\s+$/, "");
    if (output.length > MAX_READ_CHARS) output = `...[earlier output truncated]\n${output.slice(-MAX_READ_CHARS)}`;
    return { sessionId, output, running, foreground };
  }

  async kill(params: Record<string, unknown>, ctx: OpContext): Promise<TerminalKillResult> {
    const sessionId = checkId(reqString(params, "sessionId", 100));
    const panes = await this.checked(
      ["list-panes", "-s", "-t", target(sessionId), "-F", "#{pane_pid}"],
      ctx,
      sessionId,
    );
    const pids = panes
      .split("\n")
      .map((l) => Number.parseInt(l, 10))
      .filter((p) => p > 0);
    // Snapshot the tree first: killing the session hangs up the shells (interactive shells ignore SIGTERM)
    // and reparents their children, which killTree then still reaches through the snapshot.
    const procs = listProcs();
    const tree = new Set([...pids, ...descendantsOf(pids, procs)]);
    const res = await this.tmux(["kill-session", "-t", target(sessionId)], ctx);
    if (res.code !== 0 && !/can't find|no server/i.test(res.err)) {
      throw new OpError("failed", `tmux kill-session failed: ${res.err}`);
    }
    const signalled = await killTree({ pids: [...tree], graceMs: 2000 });
    return { sessionId, killed: Math.max(tree.size, signalled) };
  }

  async list(_params: Record<string, unknown>, ctx: OpContext): Promise<{ sessions: TerminalInfo[] }> {
    const res = await this.tmux(
      [
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_created}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}\t#{@witden_command}",
      ],
      ctx,
    );
    if (res.code !== 0) {
      if (/no server running|error connecting|No such file/i.test(res.err)) return { sessions: [] };
      throw new OpError("failed", `tmux list-sessions failed: ${res.err}`);
    }
    const sessions: TerminalInfo[] = [];
    for (const line of res.out.split("\n")) {
      const [name, created, pid, dead, current, command] = line.split("\t");
      if (!name || !SESSION_ID.test(name)) continue;
      sessions.push({
        sessionId: name,
        command: Buffer.from(command ?? "", "base64").toString("utf8"),
        createdAt: new Date(Number(created) * 1000).toISOString(),
        running: foregroundOf(Number(pid), dead === "1", current ?? "").running,
      });
    }
    return { sessions };
  }
}

/**
 * A command is running when the terminal's foreground process group is not the shell's own (tpgid in
 * /proc/<shell>/stat); falls back to tmux's pane_current_command when /proc is not readable.
 */
function foregroundOf(panePid: number, dead: boolean, current: string): { running: boolean; foreground: string } {
  if (dead) return { running: false, foreground: "" };
  const shell = panePid > 0 ? readStat(panePid) : null;
  if (shell && shell.tpgid > 0) {
    if (shell.tpgid === shell.pgid) return { running: false, foreground: shell.comm };
    return { running: true, foreground: readStat(shell.tpgid)?.comm ?? current };
  }
  return { running: !SHELLS.has(current) && current !== "", foreground: current };
}

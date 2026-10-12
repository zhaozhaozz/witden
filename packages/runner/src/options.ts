import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStderrLogger, type Logger, parseLogLevel } from "./log.js";

export interface RunnerOptions {
  instanceId: string;
  /** Per-computer secret sent in `hello` (WITDEN_RUNNER_TOKEN). */
  token: string;
  /** Default cwd for commands and base for relative paths. */
  workdir: string;
  home: string;
  /** Journal and other runner state; survives runner restarts. */
  stateDir: string;
  /** X11 display of the desktop, or null when the computer has none. */
  display: string | null;
  vncPort: number;
  vncViewPort: number;
  /** Loopback ports `stream.open` may connect to. */
  streamPorts: number[];
  /** tmux socket name (`tmux -L`). */
  tmuxSocket: string;
  /** TMUX_TMPDIR for the tmux server, null to keep the default. */
  tmuxTmpDir: string | null;
  cdpPort: number;
  chromiumPath: string;
  desktopProfileDir: string;
  downloadsDir: string;
  journalMaxEntries: number;
  journalMaxFileBytes: number;
  maxConcurrent: number;
  logger: Logger;
}

function parsePorts(value: string | undefined, fallback: number[]): number[] {
  if (!value?.trim()) return fallback;
  const ports = value
    .split(",")
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return ports.length ? ports : fallback;
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value ?? "", 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function detectDisplay(env: NodeJS.ProcessEnv): string | null {
  if (env.DISPLAY) return env.DISPLAY;
  return existsSync("/tmp/.X11-unix/X1") ? ":1" : null;
}

/** Fills in defaults from the environment (see images/ for the variables the platform sets). */
export function resolveRunnerOptions(overrides: Partial<RunnerOptions> = {}, env = process.env): RunnerOptions {
  const home = overrides.home ?? (env.HOME || os.homedir());
  const workdir = overrides.workdir ?? (env.WITDEN_WORKDIR || home);
  const stateDir = overrides.stateDir ?? (env.WITDEN_STATE_DIR || path.join(home, ".witden-runner"));
  return {
    instanceId: overrides.instanceId ?? env.WITDEN_INSTANCE_ID ?? "",
    token: overrides.token ?? env.WITDEN_RUNNER_TOKEN ?? "",
    workdir,
    home,
    stateDir,
    display: "display" in overrides ? (overrides.display ?? null) : detectDisplay(env),
    vncPort: overrides.vncPort ?? parsePort(env.WITDEN_VNC_PORT, 5900),
    vncViewPort: overrides.vncViewPort ?? parsePort(env.WITDEN_VNC_VIEW_PORT, 5901),
    streamPorts: overrides.streamPorts ?? parsePorts(env.WITDEN_STREAM_PORTS, [5900, 5901]),
    tmuxSocket: overrides.tmuxSocket ?? (env.WITDEN_TMUX_SOCKET || "witden"),
    tmuxTmpDir: overrides.tmuxTmpDir !== undefined ? overrides.tmuxTmpDir : (env.TMUX_TMPDIR ?? null),
    cdpPort: overrides.cdpPort ?? parsePort(env.WITDEN_CDP_PORT, 9222),
    chromiumPath: overrides.chromiumPath ?? (env.WITDEN_CHROMIUM || "/usr/bin/chromium"),
    desktopProfileDir: overrides.desktopProfileDir ?? path.join(home, ".config", "chromium"),
    downloadsDir: overrides.downloadsDir ?? path.join(home, "Downloads"),
    journalMaxEntries: overrides.journalMaxEntries ?? 500,
    journalMaxFileBytes: overrides.journalMaxFileBytes ?? 16 * 1024 * 1024,
    maxConcurrent: overrides.maxConcurrent ?? 64,
    logger: overrides.logger ?? createStderrLogger(parseLogLevel(env.WITDEN_RUNNER_LOG_LEVEL)),
  };
}

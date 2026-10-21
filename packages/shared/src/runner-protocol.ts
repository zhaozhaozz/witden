/**
 * Protocol between the platform's runner hub (execution gateway side) and the Computer Runner that lives
 * inside every cloud computer.
 *
 * Transport: one WebSocket per computer, dialled *by the runner* to the hub (so computers expose no ports),
 * or the same frames over stdio when the Docker Manager opens a fallback channel for computers without a
 * network route to the hub. Text frames carry JSON messages; binary frames carry raw stream data
 * (VNC tunnels) prefixed with a 4-byte big-endian stream id.
 *
 * Trust: the platform treats the whole computer as possibly compromised. The runner only reports results of
 * operations it was asked to perform; it never grants itself permissions and its claims (for example about
 * approvals) are never trusted by the platform.
 */

export const RUNNER_PROTOCOL_VERSION = 1;

/** First message sent by the runner after the connection opens. */
export interface HelloMessage {
  type: "hello";
  protocol: number;
  instanceId: string;
  /** Per-computer secret injected at creation (WITDEN_RUNNER_TOKEN). */
  token: string;
  runnerVersion: string;
  info: RunnerInfo;
}

export interface RunnerInfo {
  hostname: string;
  user: string;
  uid: number;
  workdir: string;
  /** Present when the computer has an X11 desktop the runner can operate. */
  desktop: { display: string; width: number; height: number; vncPort: number; vncViewPort: number } | null;
  /** True when a CDP endpoint for the desktop browser (or a local Chromium for background sessions) exists. */
  browser: boolean;
  tools: string[];
  /**
   * True when another process of the computer's user could read the runner token (from /proc or the
   * runner's memory): the computer was not started through the protected init of the witden images.
   * Absent from runners that predate the check.
   */
  tokenExposed?: boolean;
}

export interface WelcomeMessage {
  type: "welcome";
  /** Server time, informational. */
  serverTime: string;
  /** The computer's model proxy (absent / null: off). Changes later arrive as `configure`. */
  modelProxy?: ModelProxyConfig | null;
}

/**
 * Optional model proxy: the runner serves an OpenAI- / Anthropic-compatible endpoint on 127.0.0.1 inside the
 * computer and relays every request to the platform over this connection. The platform checks the key and the
 * allowed models and calls the real provider with the real key, which never enters the computer.
 */
export interface ModelProxyConfig {
  /** Loopback port inside the computer. */
  port: number;
  /** Issued by the platform for this computer; only valid through this computer's own runner connection. */
  key: string;
  /** Model names clients may ask for (the platform enforces the list). */
  models: string[];
}

export interface ConfigureMessage {
  type: "configure";
  modelProxy: ModelProxyConfig | null;
}

/** One HTTP request a program inside the computer sent to the local model proxy. */
export interface ProxyRequestMessage {
  type: "proxy.request";
  id: string;
  method: string;
  /** Path and query, e.g. /v1/chat/completions */
  path: string;
  headers: Record<string, string>;
  bodyBase64: string;
}

/** The client went away: stop the upstream call. */
export interface ProxyCancelMessage {
  type: "proxy.cancel";
  id: string;
}

/** Start of the answer to a proxy request; the body follows as chunks (streamed responses stay streamed). */
export interface ProxyResponseMessage {
  type: "proxy.response";
  id: string;
  status: number;
  headers: Record<string, string>;
}

export interface ProxyChunkMessage {
  type: "proxy.chunk";
  id: string;
  dataBase64: string;
}

export interface ProxyEndMessage {
  type: "proxy.end";
  id: string;
  /** Set when the answer broke off midway. */
  error?: string;
}

export interface RequestMessage {
  type: "request";
  /** Unique per request; also the idempotency / journal key. */
  id: string;
  op: RunnerOp;
  params: Record<string, unknown>;
  /** Hard deadline for the operation inside the computer. */
  timeoutMs: number;
}

export interface ResponseMessage {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: RunnerError;
}

export interface RunnerError {
  /** Stable machine code, e.g. "not_found", "timeout", "unsupported", "invalid", "busy", "failed". */
  code: string;
  message: string;
}

/** Unsolicited progress from the runner (terminal output, browser downloads...). */
export interface EventMessage {
  type: "event";
  event: string;
  sessionId?: string;
  requestId?: string;
  data: Record<string, unknown>;
}

export interface CancelMessage {
  type: "cancel";
  /** The request whose process (tree) must be stopped. */
  id: string;
}

export interface StreamOpenMessage {
  type: "stream.open";
  streamId: number;
  /** Only loopback targets inside the computer are allowed (enforced by the runner). */
  port: number;
}

export interface StreamOpenedMessage {
  type: "stream.opened";
  streamId: number;
}

export interface StreamCloseMessage {
  type: "stream.close";
  streamId: number;
  reason?: string;
}

export interface PingMessage {
  type: "ping" | "pong";
  at: number;
}

export type HubToRunner =
  | WelcomeMessage
  | ConfigureMessage
  | RequestMessage
  | CancelMessage
  | StreamOpenMessage
  | StreamCloseMessage
  | ProxyResponseMessage
  | ProxyChunkMessage
  | ProxyEndMessage
  | PingMessage;
export type RunnerToHub =
  | HelloMessage
  | ResponseMessage
  | EventMessage
  | StreamOpenedMessage
  | StreamCloseMessage
  | ProxyRequestMessage
  | ProxyCancelMessage
  | PingMessage;

/** Operations understood by the runner. Params / results are documented per op below. */
export type RunnerOp =
  | "system.info"
  | "exec.run"
  | "terminal.create"
  | "terminal.input"
  | "terminal.key"
  | "terminal.read"
  | "terminal.kill"
  | "terminal.list"
  | "file.read"
  | "file.write"
  | "file.list"
  | "file.move"
  | "file.stat"
  | "screen.capture"
  | "screen.size"
  | "input.mouse"
  | "input.keyboard"
  | "browser.open"
  | "browser.snapshot"
  | "browser.click"
  | "browser.type"
  | "browser.download"
  | "browser.screenshot"
  | "browser.close"
  | "browser.list"
  | "process.list"
  | "journal.get"
  | "command.start"
  | "command.wait"
  | "command.list"
  | "command.stop";

// --- params / results ---------------------------------------------------------------------------------

export interface ExecRunParams {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Bytes of combined stdout/stderr kept; the rest is dropped (truncated=true). */
  outputLimit?: number;
}
export interface ExecRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
  /** True when the process tree was killed (timeout or cancel). */
  killed: boolean;
}

/**
 * Commands that outlive the request that started them (runners whose ``info.tools`` include
 * COMMAND_TOOL; older runners only know exec.run). Each runs detached in its own session with stdout and
 * stderr combined into a log file in the computer; its exit status is written to a file next to it, so a
 * restarted runner still knows how it ended. Nothing stops a command but command.stop.
 */
export const COMMAND_TOOL = "command";

export interface CommandStartParams {
  /** Chosen by the platform (letters, digits, "_" and "-"); names the files. Starting an id twice is a no-op. */
  id: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}
export interface CommandInfo {
  id: string;
  command: string;
  cwd: string;
  /** Combined stdout / stderr, kept whole. */
  logPath: string;
  pid: number;
  startedAt: string;
  running: boolean;
  /** The shell's exit status (128 + n after signal n); null while running or when it is unknown. */
  exitCode: number | null;
  /** Signal name when the exit status says the command was killed by one. */
  signal: string | null;
  finishedAt: string | null;
  /** It ended without an exit status: the computer restarted or its wrapper was killed. */
  lost: boolean;
  outputBytes: number;
  /** End of the output (finished commands, when asked for). */
  tail?: string;
}
export interface CommandWaitParams {
  id: string;
  /** How long to wait for the command to end (0: just look at it). */
  waitMs: number;
  /** Bytes of output returned: the head and the tail of the log when it is longer. */
  outputLimit?: number;
}
export interface CommandOutputResult extends CommandInfo {
  output: string;
  truncated: boolean;
}
export interface CommandListParams {
  /** Only these commands (unknown ones are listed in ``unknown``); default: all, newest first. */
  ids?: string[];
  /** Include the last bytes of the output of finished commands. */
  tailBytes?: number;
}
export interface CommandListResult {
  commands: CommandInfo[];
  unknown: string[];
}
export interface CommandStopParams {
  id: string;
  /** interrupt: SIGINT; terminate (default): SIGTERM, then SIGKILL after a grace period; kill: SIGKILL. */
  signal?: "interrupt" | "terminate" | "kill";
}
/** Event "command.exited": a command ended (also sent for commands started by an earlier runner process). */
export type CommandExitedEvent = CommandInfo;

export interface TerminalCreateParams {
  command?: string;
  cwd?: string;
}
export interface TerminalCreateResult {
  sessionId: string;
}
export interface TerminalInputParams {
  sessionId: string;
  text: string;
  enter?: boolean;
}
export interface TerminalKeyParams {
  sessionId: string;
  /** tmux key name, e.g. "C-c", "Enter", "Up". */
  key: string;
}
export interface TerminalReadParams {
  sessionId: string;
  lines?: number;
}
export interface TerminalReadResult {
  sessionId: string;
  output: string;
  /** A foreground command (other than the shell) is still running. */
  running: boolean;
  foreground: string;
}
export interface TerminalKillResult {
  sessionId: string;
  /** Number of processes that were signalled. */
  killed: number;
}
export interface TerminalInfo {
  sessionId: string;
  command: string;
  createdAt: string;
  running: boolean;
}

export interface FileReadParams {
  path: string;
  maxBytes?: number;
}
export interface FileReadResult {
  path: string;
  size: number;
  contentBase64: string;
}
export interface FileWriteParams {
  path: string;
  contentBase64: string;
  /** Default: overwrite. */
  append?: boolean;
}
export interface FileWriteResult {
  path: string;
  size: number;
}
export interface FileListParams {
  path: string;
}
export interface FileEntry {
  name: string;
  type: "file" | "dir" | "link" | "other";
  size: number;
  mtime: string;
}
export interface FileMoveParams {
  from: string;
  to: string;
}

export interface ScreenCaptureResult {
  pngBase64: string;
  width: number;
  height: number;
}

export interface MouseParams {
  action: "move" | "click" | "double_click" | "drag" | "scroll";
  x: number;
  y: number;
  toX?: number;
  toY?: number;
  button?: "left" | "middle" | "right";
  /** Scroll steps; negative scrolls up. */
  amount?: number;
}
export interface KeyboardParams {
  text?: string;
  /** xdotool key syntax, space separated, e.g. "ctrl+l Return". */
  keys?: string;
}

/**
 * Browser sessions. "desktop" sessions drive the browser people see on the computer's desktop (observable,
 * can be taken over); "background" sessions use a separate headless browser and are always labelled as such.
 */
export interface BrowserOpenParams {
  url: string;
  mode: "desktop" | "background";
  sessionId?: string;
}
export interface BrowserSessionInfo {
  sessionId: string;
  mode: "desktop" | "background";
  url: string;
  title: string;
}
export interface BrowserSnapshotResult extends BrowserSessionInfo {
  /** Visible text (cut only past a guard far above any real page). */
  text: string;
  /** Interactive elements with stable refs usable in click/type for this snapshot. */
  elements: { ref: string; role: string; name: string }[];
  /** More visible interactive elements than the runner gives refs to. */
  moreElements?: boolean;
}
export interface BrowserTargetParams {
  sessionId: string;
  ref?: string;
  selector?: string;
  text?: string;
}
export interface BrowserTypeParams extends BrowserTargetParams {
  value: string;
  submit?: boolean;
}
export interface BrowserDownloadResult {
  path: string;
  size: number;
  suggestedName: string;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

export interface JournalGetParams {
  requestId: string;
}
export interface JournalGetResult {
  /** completed: finished and its response is attached; running: still in progress; unknown: never seen
   *  (e.g. the runner restarted and lost its journal) — the platform must then treat the outcome as uncertain. */
  state: "completed" | "running" | "unknown";
  response?: ResponseMessage;
}

/** Frames for binary stream data: [uint32 streamId][payload]. */
export function encodeStreamFrame(streamId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, streamId, false);
  out.set(payload, 4);
  return out;
}

export function decodeStreamFrame(frame: Uint8Array): { streamId: number; payload: Uint8Array } {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { streamId: view.getUint32(0, false), payload: frame.subarray(4) };
}

/** Operations that only observe state and can be safely repeated after an interruption. */
export const READ_ONLY_OPS: ReadonlySet<RunnerOp> = new Set<RunnerOp>([
  "system.info",
  "terminal.read",
  "terminal.list",
  "file.read",
  "file.list",
  "file.stat",
  "screen.capture",
  "screen.size",
  "browser.snapshot",
  "browser.screenshot",
  "browser.list",
  "process.list",
  "journal.get",
  "command.wait",
  "command.list",
]);

// --- stdio transport ----------------------------------------------------------------------------------
// When a computer has no network route to the hub, the Docker Manager starts `witden-runner --stdio` with
// `docker exec` and relays its stdin/stdout. Frames: [uint8 kind: 1 = JSON text, 2 = binary][uint32 length][payload].

export type StdioFrame = { kind: "text"; payload: Uint8Array } | { kind: "binary"; payload: Uint8Array };

export function encodeStdioFrame(kind: "text" | "binary", payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind === "text" ? 1 : 2;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

export class StdioFrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): StdioFrame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    const frames: StdioFrame[] = [];
    let offset = 0;
    while (merged.length - offset >= 5) {
      const kind = merged[offset];
      const length = new DataView(merged.buffer, merged.byteOffset + offset + 1, 4).getUint32(0, false);
      if (merged.length - offset - 5 < length) break;
      const payload = merged.slice(offset + 5, offset + 5 + length);
      frames.push({ kind: kind === 1 ? "text" : "binary", payload });
      offset += 5 + length;
    }
    this.buffer = merged.slice(offset);
    return frames;
  }
}

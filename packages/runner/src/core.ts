import os from "node:os";
import {
  type HelloMessage,
  READ_ONLY_OPS,
  type ResponseMessage,
  RUNNER_PROTOCOL_VERSION,
  type RunnerInfo,
  type RunnerOp,
  type RunnerToHub,
} from "@witden/shared";
import { createEnv, type Env, type OpContext, type OpHandler } from "./context.js";
import { abortError, OpError, toRunnerError } from "./errors.js";
import { Journal } from "./journal.js";
import type { Logger } from "./log.js";
import { Browsers } from "./ops/browser.js";
import { Desktop } from "./ops/desktop.js";
import { execRun } from "./ops/exec.js";
import { Files } from "./ops/files.js";
import { processList } from "./ops/system.js";
import { Terminals } from "./ops/terminal.js";
import { type RunnerOptions, resolveRunnerOptions } from "./options.js";
import { reqString } from "./params.js";
import { StreamManager } from "./streams.js";
import { isRecord, which } from "./util.js";
import { RUNNER_VERSION } from "./version.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 24 * 3600_000;
/** How long an aborted handler may take to wind down (exec needs ~2 s to escalate to SIGKILL). */
const ABORT_GRACE_MS = 5_000;

/** Where the core sends what it produces; implemented by the WebSocket, stdio and in-memory transports. */
export interface RunnerTransport {
  sendMessage(message: RunnerToHub): void;
  /** A binary stream frame: [uint32 streamId][payload]. */
  sendBinary(frame: Uint8Array): void;
  /** Bytes queued but not yet written (stream sockets pause when this grows). */
  bufferedAmount?(): number;
}

interface Inflight {
  op: string;
  controller: AbortController;
  done: Promise<void>;
}

/** Rejects with the abort error if the handler has not settled `graceMs` after the signal fired. */
function withAbortGrace<T>(promise: Promise<T>, signal: AbortSignal, graceMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const onAbort = () => {
      timer = setTimeout(() => reject(abortError(signal)), graceMs);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Transport-independent runner: takes parsed hub messages, executes operations inside this computer and
 * sends responses, events and stream frames through whichever transport is attached. Requests survive
 * transport changes; their outcome is kept in the journal for `journal.get` and duplicate ids.
 */
export class RunnerCore {
  readonly options: RunnerOptions;
  readonly log: Logger;
  readonly journal: Journal;
  readonly env: Env;
  readonly terminals: Terminals;
  readonly files: Files;
  readonly desktop: Desktop;
  readonly browsers: Browsers;
  readonly streams: StreamManager;
  private transport: RunnerTransport | null = null;
  private readonly inflight = new Map<string, Inflight>();
  private readonly handlers: Record<RunnerOp, OpHandler>;
  private started = false;
  private closing = false;

  constructor(options: RunnerOptions) {
    this.options = options;
    this.log = options.logger;
    this.env = createEnv(options.workdir, options.home, options.logger);
    this.journal = new Journal({
      dir: options.stateDir,
      maxEntries: options.journalMaxEntries,
      maxFileBytes: options.journalMaxFileBytes,
      logger: options.logger,
    });
    this.terminals = new Terminals(this.env, options.tmuxSocket, options.tmuxTmpDir);
    this.files = new Files(this.env);
    this.desktop = new Desktop(this.env, options.display, options.vncPort, options.vncViewPort);
    this.browsers = new Browsers(this.env, {
      display: options.display,
      cdpPort: options.cdpPort,
      chromiumPath: options.chromiumPath,
      profileDir: options.desktopProfileDir,
      downloadsDir: options.downloadsDir,
      stateDir: options.stateDir,
    });
    this.streams = new StreamManager(
      options.streamPorts,
      {
        send: (m) => this.send(m),
        sendBinary: (f) => this.sendBinary(f),
        buffered: () => this.transport?.bufferedAmount?.() ?? 0,
      },
      this.log,
    );

    const t = this.terminals;
    const f = this.files;
    const d = this.desktop;
    const b = this.browsers;
    this.handlers = {
      "system.info": async () => ({
        ...(await this.info()),
        runnerVersion: RUNNER_VERSION,
        protocol: RUNNER_PROTOCOL_VERSION,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
      }),
      "exec.run": (p, ctx) => execRun(p, ctx, this.env),
      "terminal.create": (p, ctx) => t.create(p, ctx),
      "terminal.input": (p, ctx) => t.input(p, ctx),
      "terminal.key": (p, ctx) => t.key(p, ctx),
      "terminal.read": (p, ctx) => t.read(p, ctx),
      "terminal.kill": (p, ctx) => t.kill(p, ctx),
      "terminal.list": (p, ctx) => t.list(p, ctx),
      "file.read": async (p) => f.read(p),
      "file.write": async (p) => f.write(p),
      "file.list": async (p) => f.list(p),
      "file.move": async (p) => f.move(p),
      "file.stat": async (p) => f.stat(p),
      "screen.capture": (p, ctx) => d.capture(p, ctx),
      "screen.size": async (_p, ctx) => d.size(ctx),
      "input.mouse": (p, ctx) => d.mouse(p, ctx),
      "input.keyboard": (p, ctx) => d.keyboard(p, ctx),
      "browser.open": (p, ctx) => b.open(p, ctx),
      "browser.snapshot": (p, ctx) => b.snapshot(p, ctx),
      "browser.click": (p, ctx) => b.click(p, ctx),
      "browser.type": (p, ctx) => b.type(p, ctx),
      "browser.download": (p, ctx) => b.download(p, ctx),
      "browser.screenshot": (p, ctx) => b.screenshot(p, ctx),
      "browser.close": async (p) => b.close(p),
      "browser.list": async () => b.list(),
      "process.list": async () => processList(),
      "journal.get": async (p) => this.journal.get(reqString(p, "requestId", 256)),
    };
  }

  /** Loads the journal left by a previous runner process. Idempotent. */
  start(): this {
    if (this.started) return this;
    this.started = true;
    this.journal.load();
    return this;
  }

  attach(transport: RunnerTransport): void {
    this.transport = transport;
  }

  /** Detaches a transport; its streams are closed, running requests continue (results go to the journal). */
  detach(transport: RunnerTransport): void {
    if (this.transport !== transport) return;
    this.transport = null;
    this.streams.closeAll();
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  async hello(): Promise<HelloMessage> {
    return {
      type: "hello",
      protocol: RUNNER_PROTOCOL_VERSION,
      instanceId: this.options.instanceId,
      token: this.options.token,
      runnerVersion: RUNNER_VERSION,
      info: await this.info(),
    };
  }

  async info(): Promise<RunnerInfo> {
    let user = "";
    try {
      user = os.userInfo().username;
    } catch {
      user = process.env.USER ?? "";
    }
    const desktop = await this.desktop.describe();
    const browser = await this.browsers.available();
    const tools = ["exec", "file", "process", "journal"];
    if (this.options.streamPorts.length) tools.push("stream");
    if (which("tmux")) tools.push("terminal");
    if (desktop && which("import")) tools.push("screen");
    if (desktop && which("xdotool")) tools.push("input");
    if (browser) tools.push("browser");
    return {
      hostname: os.hostname(),
      user,
      uid: process.getuid?.() ?? -1,
      workdir: this.options.workdir,
      desktop,
      browser,
      tools,
    };
  }

  handleText(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.log.warn("ignoring a frame that is not JSON");
      return;
    }
    this.handleMessage(message);
  }

  handleBinary(frame: Uint8Array): void {
    try {
      this.streams.data(frame);
    } catch (err) {
      this.log.warn("bad binary frame", { error: String(err) });
    }
  }

  handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      this.log.warn("ignoring a message that is not an object");
      return;
    }
    try {
      switch (message.type) {
        case "request":
          this.handleRequest(message);
          break;
        case "cancel":
          this.cancel(message.id);
          break;
        case "stream.open":
          this.streams.open(message.streamId, message.port);
          break;
        case "stream.close":
          this.streams.close(message.streamId);
          break;
        case "ping":
          this.send({ type: "pong", at: typeof message.at === "number" ? message.at : Date.now() });
          break;
        case "pong":
          break;
        case "welcome":
          this.log.info("hub accepted the runner", { serverTime: message.serverTime });
          break;
        default:
          this.log.warn("ignoring an unknown message type", { type: String(message.type) });
      }
    } catch (err) {
      this.log.error("failed to handle a message", { error: String(err) });
    }
  }

  cancel(id: unknown): void {
    const entry = typeof id === "string" ? this.inflight.get(id) : undefined;
    if (!entry) {
      this.log.debug("cancel for a request that is not running", { id: String(id) });
      return;
    }
    entry.controller.abort("cancel");
  }

  private handleRequest(message: Record<string, unknown>): void {
    const { id, op } = message;
    if (typeof id !== "string" || !id || id.length > 256) {
      this.log.warn("ignoring a request without a valid id");
      return;
    }
    const known = this.journal.lookup(id);
    if (known) {
      // The original response is sent when it completes (to whichever transport is attached then).
      if (known.state === "running") return;
      // Compacted read-only results are cheaper to recompute than to replay.
      const rerun = known.state === "completed" && known.compacted && READ_ONLY_OPS.has(known.op as RunnerOp);
      if (!rerun) {
        const result = this.journal.get(id);
        if (result.response) this.send(result.response);
        return;
      }
    }
    const params = message.params ?? {};
    if (this.closing) {
      this.send(this.errorResponse(id, new OpError("failed", "the runner is shutting down")));
      return;
    }
    if (this.inflight.size >= this.options.maxConcurrent) {
      this.send(this.errorResponse(id, new OpError("busy", "too many operations are running; retry later")));
      return;
    }
    const raw = message.timeoutMs;
    const timeoutMs =
      typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    this.execute(id, typeof op === "string" ? op : String(op), params, timeoutMs);
  }

  private execute(id: string, op: string, params: unknown, timeoutMs: number): void {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    const ctx: OpContext = {
      requestId: id,
      signal: controller.signal,
      deadline: Date.now() + timeoutMs,
      emit: (event, data, sessionId) => this.send({ type: "event", event, sessionId, requestId: id, data }),
    };
    this.journal.start(id, op);
    // Registered before the body runs: requests that fail synchronously must not leave a stale entry.
    const entry: Inflight = { op, controller, done: Promise.resolve() };
    this.inflight.set(id, entry);
    entry.done = (async () => {
      let response: ResponseMessage;
      try {
        const handler = Object.hasOwn(this.handlers, op) ? this.handlers[op as RunnerOp] : undefined;
        if (!handler) throw new OpError("unsupported", `unknown op "${op}"`);
        if (!isRecord(params)) throw new OpError("invalid", "params must be an object");
        const result = await withAbortGrace(
          Promise.resolve().then(() => handler(params, ctx)),
          controller.signal,
          ABORT_GRACE_MS,
        );
        response = { type: "response", id, ok: true, result: result ?? {} };
      } catch (err) {
        response = this.errorResponse(id, err);
        if (!(err instanceof OpError)) this.log.debug("operation failed", { op, error: String(err) });
      } finally {
        clearTimeout(timer);
      }
      this.inflight.delete(id);
      this.journal.complete(id, op, response);
      this.send(response);
    })();
  }

  private errorResponse(id: string, err: unknown): ResponseMessage {
    return { type: "response", id, ok: false, error: toRunnerError(err) };
  }

  private send(message: RunnerToHub): void {
    if (!this.transport) return;
    try {
      this.transport.sendMessage(message);
    } catch (err) {
      this.log.warn("cannot send to the hub", { error: String(err) });
    }
  }

  private sendBinary(frame: Uint8Array): void {
    if (!this.transport) return;
    try {
      this.transport.sendBinary(frame);
    } catch (err) {
      this.log.warn("cannot send a stream frame", { error: String(err) });
    }
  }

  /** Resolves when every running request has finished. */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()].map((r) => r.done));
  }

  /**
   * Stops accepting requests, aborts running ones (exec trees are killed and journaled as killed), closes
   * streams and browser connections. Terminals and the desktop browser keep running.
   */
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const entry of this.inflight.values()) entry.controller.abort("shutdown");
    await Promise.race([this.drain(), new Promise((r) => setTimeout(r, ABORT_GRACE_MS + 1000))]);
    this.streams.closeAll();
    await this.browsers.dispose();
  }
}

export function createRunnerCore(options: Partial<RunnerOptions> = {}): RunnerCore {
  return new RunnerCore(resolveRunnerOptions(options)).start();
}

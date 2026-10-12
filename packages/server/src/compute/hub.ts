/**
 * Runner hub: the platform end of the connections to the Computer Runners.
 *
 * Runners dial in (computers expose no ports) and authenticate with their per-computer secret; computers
 * without a network route to the hub are reached through a stdio channel the Docker Manager opens with
 * `docker exec`. Either way the hub speaks the runner protocol from @witden/shared. It only relays requests
 * the execution gateway (or an authorised person) issued; nothing here decides permissions.
 */
import { createServer, type Server } from "node:http";
import {
  decodeStreamFrame,
  encodeStdioFrame,
  encodeStreamFrame,
  type HelloMessage,
  type HubToRunner,
  type ProxyCancelMessage,
  type ProxyRequestMessage,
  RUNNER_PROTOCOL_VERSION,
  type RunnerInfo,
  type RunnerOp,
  type RunnerToHub,
  StdioFrameDecoder,
  type WelcomeMessage,
} from "@witden/shared";
import { eq } from "drizzle-orm";
import { type WebSocket, WebSocketServer } from "ws";
import { db, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import { computerInstances } from "../db/schema.js";
import { InstanceUnavailable, WitdenError } from "../errors.js";
import { hashToken, safeEqual } from "../security/crypto.js";
import { audit } from "../services/audit.js";
import { publish } from "../services/events.js";

/** Minimal bidirectional transport (WebSocket, stdio channel, or in-memory for tests). */
export interface HubTransport {
  sendText(text: string): void;
  sendBinary(data: Uint8Array): void;
  close(reason?: string): void;
  onText(listener: (text: string) => void): void;
  onBinary(listener: (data: Uint8Array) => void): void;
  onClose(listener: (reason: string) => void): void;
}

export class RunnerOpError extends WitdenError {
  override status = 502;
  constructor(code: string, message: string) {
    super(message, { code: `runner_${code}` });
    this.runnerCode = code;
  }
  runnerCode: string;
}

/** The connection dropped while an operation was in flight: it may or may not have happened. */
export class OutcomeUncertain extends InstanceUnavailable {
  override code = "outcome_uncertain";
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface StreamHandle {
  streamId: number;
  send(data: Uint8Array): void;
  onData(listener: (data: Uint8Array) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(): void;
}

/**
 * One tunnelled stream. Servers such as VNC speak first, so bytes (and a close) can arrive before the
 * consumer has attached its listeners; they are held until then instead of being dropped.
 */
class StreamEntry {
  private dataFns: ((d: Uint8Array) => void)[] = [];
  private closeFns: ((r: string) => void)[] = [];
  private held: Uint8Array[] = [];
  private closedWith: string | null = null;

  data(payload: Uint8Array): void {
    if (this.dataFns.length) for (const fn of this.dataFns) fn(payload);
    else this.held.push(payload);
  }
  close(reason: string): void {
    if (this.closedWith !== null) return;
    this.closedWith = reason;
    for (const fn of this.closeFns) fn(reason);
  }
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFns.push(fn);
    const held = this.held;
    this.held = [];
    for (const d of held) fn(d);
  }
  onClose(fn: (r: string) => void): void {
    if (this.closedWith !== null) fn(this.closedWith);
    else this.closeFns.push(fn);
  }
}

type EventListener = (event: {
  event: string;
  sessionId?: string;
  requestId?: string;
  data: Record<string, unknown>;
}) => void;

export class RunnerConnection {
  readonly connectedAt = new Date();
  private pending = new Map<string, Pending>();
  private streams = new Map<number, StreamEntry>();
  private streamOpens = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private nextStream = 1;
  private eventListeners = new Set<EventListener>();
  closed = false;

  constructor(
    readonly instanceId: string,
    readonly info: RunnerInfo,
    readonly transport: HubTransport,
    readonly via: "websocket" | "stdio" | "memory",
    private readonly onGone: (conn: RunnerConnection, reason: string) => void,
  ) {
    transport.onText((text) => this.handleText(text));
    transport.onBinary((data) => {
      const { streamId, payload } = decodeStreamFrame(data);
      this.streams.get(streamId)?.data(payload);
    });
    transport.onClose((reason) => this.shutdown(reason));
  }

  private send(msg: HubToRunner): void {
    if (this.closed) throw new InstanceUnavailable("runner connection closed");
    this.transport.sendText(JSON.stringify(msg));
  }

  /** Fire-and-forget message; false when the connection is gone. */
  post(msg: HubToRunner): boolean {
    if (this.closed) return false;
    try {
      this.transport.sendText(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Set by the hub: handles the computer's model proxy traffic. */
  onProxy: ((conn: RunnerConnection, msg: ProxyRequestMessage | ProxyCancelMessage) => void) | null = null;

  private handleText(text: string): void {
    let msg: RunnerToHub;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "response") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new RunnerOpError(msg.error?.code ?? "failed", msg.error?.message ?? "operation failed"));
    } else if (msg.type === "event") {
      for (const fn of this.eventListeners) fn(msg);
    } else if (msg.type === "stream.opened") {
      this.streamOpens.get(msg.streamId)?.resolve();
      this.streamOpens.delete(msg.streamId);
    } else if (msg.type === "stream.close") {
      const opening = this.streamOpens.get(msg.streamId);
      if (opening) {
        opening.reject(new RunnerOpError("failed", msg.reason ?? "stream refused"));
        this.streamOpens.delete(msg.streamId);
      }
      this.streams.get(msg.streamId)?.close(msg.reason ?? "closed");
      this.streams.delete(msg.streamId);
    } else if (msg.type === "proxy.request" || msg.type === "proxy.cancel") {
      this.onProxy?.(this, msg);
    } else if (msg.type === "ping") {
      this.transport.sendText(JSON.stringify({ type: "pong", at: msg.at }));
    }
  }

  /** Send an operation and wait for its result. ``id`` doubles as the runner's journal / idempotency key. */
  request<T = unknown>(
    op: RunnerOp,
    params: Record<string, unknown>,
    timeoutMs: number,
    id = newId("req"),
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The runner enforces its own deadline; give it a grace period before calling the outcome uncertain.
        reject(new OutcomeUncertain(`no answer from the computer for ${op} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs + 15_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.send({ type: "request", id, op, params, timeoutMs });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  cancel(id: string): void {
    if (!this.closed) this.send({ type: "cancel", id });
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async openStream(port: number): Promise<StreamHandle> {
    const streamId = this.nextStream++;
    const entry = new StreamEntry();
    this.streams.set(streamId, entry);
    await new Promise<void>((resolve, reject) => {
      this.streamOpens.set(streamId, { resolve, reject });
      this.send({ type: "stream.open", streamId, port });
      setTimeout(() => {
        if (this.streamOpens.delete(streamId)) reject(new InstanceUnavailable("the computer did not open the stream"));
      }, 10_000);
    });
    return {
      streamId,
      send: (data) => this.transport.sendBinary(encodeStreamFrame(streamId, data)),
      onData: (fn) => entry.onData(fn),
      onClose: (fn) => entry.onClose(fn),
      close: () => {
        if (!this.streams.has(streamId)) return;
        this.streams.delete(streamId);
        if (!this.closed) this.send({ type: "stream.close", streamId });
      },
    };
  }

  shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new OutcomeUncertain(`connection to the computer was lost (${reason})`));
    }
    this.pending.clear();
    for (const [, s] of this.streams) s.close(reason);
    this.streams.clear();
    try {
      this.transport.close(reason);
    } catch {
      /* already closed */
    }
    this.onGone(this, reason);
  }
}

export class RunnerHub {
  private connections = new Map<string, RunnerConnection>();
  private waiters = new Map<string, ((c: RunnerConnection) => void)[]>();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;

  /** Model proxy relay for runner connections (set by the API process). */
  proxyHandler: RunnerConnection["onProxy"] = null;
  /** Extra welcome fields for a computer, e.g. its model proxy settings. */
  welcomeExtras: ((instanceId: string) => Promise<Partial<WelcomeMessage>>) | null = null;

  constructor(private readonly openStdioChannel?: (containerId: string) => Promise<HubTransport>) {}

  connected(instanceId: string): RunnerConnection | undefined {
    const c = this.connections.get(instanceId);
    return c && !c.closed ? c : undefined;
  }

  /** Accept a transport; the runner must send a valid hello first. */
  accept(transport: HubTransport, via: RunnerConnection["via"]): void {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) transport.close("hello timeout");
    }, 10_000);
    transport.onText(async (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let hello: HelloMessage;
      try {
        hello = JSON.parse(text);
      } catch {
        transport.close("invalid hello");
        return;
      }
      const ok = await this.authenticate(hello);
      if (!ok) {
        transport.close("authentication failed");
        return;
      }
      const old = this.connections.get(hello.instanceId);
      const conn = new RunnerConnection(hello.instanceId, hello.info, transport, via, (c, reason) =>
        this.gone(c, reason),
      );
      conn.onProxy = this.proxyHandler;
      this.connections.set(hello.instanceId, conn);
      if (old && old !== conn) old.shutdown("replaced by a new runner connection");
      const extras = await this.welcomeExtras?.(hello.instanceId).catch((err) => {
        console.error("[witden] welcome settings unavailable", err);
        return {};
      });
      const welcome: WelcomeMessage = { type: "welcome", serverTime: new Date().toISOString(), ...extras };
      transport.sendText(JSON.stringify(welcome));
      for (const fn of this.waiters.get(hello.instanceId) ?? []) fn(conn);
      this.waiters.delete(hello.instanceId);
    });
  }

  private async authenticate(hello: HelloMessage): Promise<boolean> {
    if (hello?.type !== "hello" || hello.protocol !== RUNNER_PROTOCOL_VERSION || !hello.instanceId || !hello.token) {
      return false;
    }
    return transaction(async (tx) => {
      const [inst] = await tx
        .select()
        .from(computerInstances)
        .where(eq(computerInstances.id, hello.instanceId))
        .limit(1);
      const valid =
        !!inst &&
        inst.status !== "deleted" &&
        !!inst.runnerTokenHash &&
        safeEqual(inst.runnerTokenHash, hashToken(hello.token));
      if (!valid) {
        await audit(tx, "runner.rejected", { actorType: "system", instanceId: hello.instanceId, outcome: "denied" });
        return false;
      }
      await tx
        .update(computerInstances)
        .set({ runnerConnectedAt: new Date(), runnerInfo: hello.info as any })
        .where(eq(computerInstances.id, inst.id));
      await publish(tx, "instance.runner", { id: inst.id, connected: true }, `instance:${inst.id}`, "admin");
      return true;
    });
  }

  private gone(conn: RunnerConnection, reason: string): void {
    if (this.connections.get(conn.instanceId) === conn) this.connections.delete(conn.instanceId);
    transaction(async (tx) => {
      await publish(
        tx,
        "instance.runner",
        { id: conn.instanceId, connected: false, reason },
        `instance:${conn.instanceId}`,
        "admin",
      );
    }).catch(() => {});
  }

  /**
   * Connection to the runner of ``instanceId``. Computers on a routed network dial in by themselves (wait
   * briefly after a start); computers without a route get a stdio channel through the Docker Manager.
   */
  async connection(
    instanceId: string,
    opts: { containerId: string | null; network: string; waitMs?: number },
  ): Promise<RunnerConnection> {
    const existing = this.connected(instanceId);
    if (existing) return existing;
    if (opts.network !== "bridge" && opts.containerId && this.openStdioChannel) {
      const transport = await this.openStdioChannel(opts.containerId);
      const ready = this.waitFor(instanceId, 15_000);
      this.accept(transport, "stdio");
      return ready;
    }
    return this.waitFor(instanceId, opts.waitMs ?? 20_000);
  }

  private waitFor(instanceId: string, ms: number): Promise<RunnerConnection> {
    const existing = this.connected(instanceId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(instanceId) ?? [];
      const timer = setTimeout(() => {
        this.waiters.set(
          instanceId,
          (this.waiters.get(instanceId) ?? []).filter((f) => f !== done),
        );
        reject(new InstanceUnavailable("the computer's runner is not connected"));
      }, ms);
      const done = (c: RunnerConnection) => {
        clearTimeout(timer);
        resolve(c);
      };
      list.push(done);
      this.waiters.set(instanceId, list);
    });
  }

  disconnect(instanceId: string, reason: string): void {
    this.connected(instanceId)?.shutdown(reason);
  }

  /** WebSocket listener for runners (separate port from the API). */
  async listen(port: number, host: string): Promise<number> {
    this.server = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ server: this.server, path: "/runner", maxPayload: 64 * 1024 * 1024 });
    this.wss.on("connection", (ws) => this.accept(wsTransport(ws), "websocket"));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const addr = this.server.address();
    return typeof addr === "object" && addr ? addr.port : port;
  }

  async close(): Promise<void> {
    for (const c of this.connections.values()) c.shutdown("hub stopping");
    this.wss?.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  status(instanceId: string): { connected: boolean; via?: string; since?: string; info?: RunnerInfo } {
    const c = this.connected(instanceId);
    return c ? { connected: true, via: c.via, since: c.connectedAt.toISOString(), info: c.info } : { connected: false };
  }
}

export function wsTransport(ws: WebSocket): HubTransport {
  return {
    sendText: (text) => ws.send(text),
    sendBinary: (data) => ws.send(data),
    close: (reason) => ws.close(1000, reason?.slice(0, 120)),
    onText: (fn) => ws.on("message", (data, isBinary) => (isBinary ? undefined : fn(data.toString()))),
    onBinary: (fn) =>
      ws.on("message", (data, isBinary) => {
        if (isBinary) fn(data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer));
      }),
    onClose: (fn) => ws.on("close", (_code, reason) => fn(reason.toString() || "closed")),
  };
}

/** Wrap a manager runner channel (raw stdio bytes) into a framed transport. */
export function stdioTransport(channel: import("@witden/shared").RunnerChannel): HubTransport {
  const decoder = new StdioFrameDecoder();
  const text: ((t: string) => void)[] = [];
  const binary: ((d: Uint8Array) => void)[] = [];
  channel.onData((chunk) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.kind === "text") {
        const t = new TextDecoder().decode(frame.payload);
        for (const fn of text) fn(t);
      } else for (const fn of binary) fn(frame.payload);
    }
  });
  return {
    sendText: (t) => channel.send(encodeStdioFrame("text", new TextEncoder().encode(t))),
    sendBinary: (d) => channel.send(encodeStdioFrame("binary", d)),
    close: () => channel.close(),
    onText: (fn) => text.push(fn),
    onBinary: (fn) => binary.push(fn),
    onClose: (fn) => channel.onClose(fn),
  };
}

/** Pair of in-memory transports (tests and in-process fakes). */
export function memoryTransportPair(): [HubTransport, HubTransport] {
  const make = () => ({
    text: [] as ((t: string) => void)[],
    binary: [] as ((d: Uint8Array) => void)[],
    close: [] as ((r: string) => void)[],
    closed: false,
  });
  const a = make();
  const b = make();
  const side = (self: ReturnType<typeof make>, other: ReturnType<typeof make>): HubTransport => ({
    sendText: (t) =>
      queueMicrotask(() => {
        if (!other.closed) for (const fn of other.text) fn(t);
      }),
    sendBinary: (d) =>
      queueMicrotask(() => {
        if (!other.closed) for (const fn of other.binary) fn(d);
      }),
    close: (reason = "closed") => {
      if (self.closed) return;
      self.closed = true;
      other.closed = true;
      queueMicrotask(() => {
        for (const fn of [...self.close, ...other.close]) fn(reason);
      });
    },
    onText: (fn) => self.text.push(fn),
    onBinary: (fn) => self.binary.push(fn),
    onClose: (fn) => self.close.push(fn),
  });
  return [side(a, b), side(b, a)];
}

export { db as hubDb };

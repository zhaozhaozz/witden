import type { RunnerToHub } from "@witden/shared";
import WebSocket from "ws";
import type { RunnerCore, RunnerTransport } from "../core.js";

export interface WebSocketClientOptions {
  url: string;
  /** Interval of application-level pings; the connection is dropped after 3 missed intervals. */
  pingIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Dials the hub and keeps the connection up: sends `hello` on every connect, answers pings, detects dead
 * connections and reconnects with exponential backoff (with jitter).
 */
export class WebSocketClient {
  private ws: WebSocket | null = null;
  private transport: RunnerTransport | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastSeen = 0;
  private readonly pingIntervalMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly core: RunnerCore,
    private readonly options: WebSocketClientOptions,
  ) {
    this.pingIntervalMs = options.pingIntervalMs ?? 15_000;
    this.minBackoffMs = options.minBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1001, "runner stopping");
    this.cleanup();
  }

  private connect(): void {
    const log = this.core.log;
    const ws = new WebSocket(this.options.url, {
      handshakeTimeout: 10_000,
      maxPayload: 128 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.ws = ws;
    let opened = false;

    ws.on("open", () => {
      opened = true;
      this.lastSeen = Date.now();
      const transport: RunnerTransport = {
        sendMessage: (message: RunnerToHub) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        },
        sendBinary: (frame) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
        },
        bufferedAmount: () => ws.bufferedAmount,
      };
      this.core
        .hello()
        .then((hello) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify(hello));
          this.transport = transport;
          this.core.attach(transport);
          log.info("connected to the hub", { url: this.options.url });
        })
        .catch((err) => {
          log.error("cannot build hello", { error: String(err) });
          ws.terminate();
        });
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastSeen > this.pingIntervalMs * 3) {
          log.warn("hub connection timed out");
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", at: Date.now() }));
      }, this.pingIntervalMs);
    });

    ws.on("message", (data, isBinary) => {
      this.lastSeen = Date.now();
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (isBinary) this.core.handleBinary(buf);
      else {
        const text = buf.toString("utf8");
        // A welcome confirms the hub accepted us; only then reset the backoff.
        if (text.includes('"welcome"')) this.attempt = 0;
        this.core.handleText(text);
      }
    });
    ws.on("pong", () => {
      this.lastSeen = Date.now();
    });
    ws.on("error", (err) => {
      log.warn("hub connection error", { error: err.message });
    });
    ws.on("close", (code, reason) => {
      if (opened) log.info("hub connection closed", { code, reason: reason.toString() });
      this.cleanup();
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.transport) this.core.detach(this.transport);
    this.transport = null;
    this.ws = null;
  }

  private scheduleReconnect(): void {
    const base = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** this.attempt);
    const delay = Math.round(base / 2 + (Math.random() * base) / 2);
    this.attempt = Math.min(this.attempt + 1, 16);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

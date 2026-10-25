/**
 * Feishu long connection (长连接): witden connects out to Feishu with the app's ID and secret and receives the
 * events over that connection, so Feishu needs no public address and nothing of witden faces the internet.
 * The protocol is Feishu's own and only its SDKs speak it, so the official Node SDK's WSClient holds the
 * connection; everything after an event arrives is witden's, as for the events URL.
 *
 * Each API process keeps one client per long-connection connection that is not paused. Feishu gives each event
 * to one of an app's connected clients, so several API processes never see an event twice, but another
 * deployment connected with the same app takes a share of its events. An event is answered once it is queued
 * (Feishu waits 3 s); when queueing fails the SDK answers with an error and Feishu pushes the event again.
 *
 * The SDK reconnects by itself after network trouble and gives up when Feishu refuses the app (a wrong secret,
 * for example); a new client is then started after a while, sooner when the credentials change.
 */
import { eq } from "drizzle-orm";
import { db as getDb } from "../db/client.js";
import { connections } from "../db/schema.js";
import type { SocketState } from "./base.js";
import { APP_ID, acceptFeishuEvent, credentials, feishuMode } from "./feishu.js";

/** What witden needs from a long-connection client; tests provide their own (setFeishuClient). */
export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  /** Each event as Feishu sent it (the body the events URL would receive); throwing has it pushed again. */
  onEvent: (payload: unknown) => Promise<unknown>;
  onReady: () => void;
  onReconnecting: () => void;
  onReconnected: () => void;
  /** The client gave up: Feishu refused the app. */
  onError: (err: Error) => void;
  /** The client's error messages, shown as the reason while it is not connected. */
  onLog: (text: string) => void;
}

export interface FeishuClient {
  close(): void;
}

export type FeishuClientFactory = (opts: FeishuClientOptions) => Promise<FeishuClient>;

/** The official SDK's WSClient, loaded on first use: it is large, and most deployments may never need it. */
const sdkClient: FeishuClientFactory = async (o) => {
  if (!APP_ID.test(o.appId)) throw new Error("app_id is not a Feishu App ID (cli_ and 16 hex digits)");
  const lark = await import("@larksuiteoapi/node-sdk");
  // Every event goes to onEvent as it came, instead of to per-type handlers.
  // What onEvent returns (a card click's answer) goes back to Feishu as the event's response.
  class Dispatcher extends lark.EventDispatcher {
    override async invoke(data: unknown): Promise<any> {
      return (await o.onEvent(data)) ?? undefined;
    }
  }
  const quiet = () => {};
  // The SDK hands its log arguments over as one array. After the cause of a failed attempt it logs a bare
  // "connect failed", which would hide the cause.
  let said = "";
  const client = new lark.WSClient({
    appId: o.appId,
    appSecret: o.appSecret,
    source: "witden",
    // A handshake stuck behind a proxy is given up and retried.
    handshakeTimeoutMs: 15_000,
    loggerLevel: lark.LoggerLevel.error,
    logger: {
      error: (...msg: unknown[]) => {
        const text = msg
          .flat()
          .filter((m) => m !== "[ws]")
          .map(String)
          .join(" ");
        if (text === "connect failed" && said) return;
        said = text;
        o.onLog(text);
      },
      warn: quiet,
      info: quiet,
      debug: quiet,
      trace: quiet,
    },
    onReady: () => {
      said = "";
      o.onReady();
    },
    onReconnecting: o.onReconnecting,
    onReconnected: () => {
      said = "";
      o.onReconnected();
    },
    onError: o.onError,
  });
  await client.start({ eventDispatcher: new Dispatcher({ loggerLevel: lark.LoggerLevel.error }) });
  return { close: () => client.close({ force: true }) };
};

let makeClient: FeishuClientFactory = sdkClient;
/** Tests replace the SDK. */
export function setFeishuClient(factory: FeishuClientFactory | null): void {
  makeClient = factory ?? sdkClient;
}

/** Delays before a refused app is tried again; tests shorten them. */
export const feishuTiming = { firstRetryMs: 5000, maxRetryMs: 5 * 60_000 };

class FeishuSocket {
  private current: SocketState = { state: "connecting", since: new Date().toISOString() };
  private client: FeishuClient | null = null;
  /** Bumped whenever a client is given up, so callbacks of an older one are ignored. */
  private generation = 0;
  private stopped = false;
  private failures = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private lastError: string | undefined;

  constructor(
    readonly connectionId: string,
    readonly appId: string,
    readonly appSecret: string,
  ) {}

  /** While (re)connecting, the client's latest complaint says why it is taking long. */
  get state(): SocketState {
    return this.current.state === "connecting" && this.lastError
      ? { ...this.current, error: this.lastError }
      : this.current;
  }

  start(): void {
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.client?.close();
    this.client = null;
  }

  private setState(state: SocketState["state"], error?: string) {
    this.current = { state, since: new Date().toISOString(), ...(error ? { error } : {}) };
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const generation = this.generation;
    const live = () => generation === this.generation && !this.stopped;
    try {
      const client = await makeClient({
        appId: this.appId,
        appSecret: this.appSecret,
        onEvent: (payload) => this.deliver(payload),
        onReady: () => live() && this.connected(),
        onReconnected: () => live() && this.connected(),
        onReconnecting: () => live() && this.setState("connecting"),
        onError: (err) => live() && this.failed(err.message),
        onLog: (text) => {
          if (live()) this.lastError = text;
        },
      });
      if (!live()) return client.close();
      this.client = client;
    } catch (err) {
      if (live()) this.failed((err as Error).message);
    }
  }

  private connected() {
    this.failures = 0;
    this.lastError = undefined;
    this.setState("connected");
  }

  /** Feishu refused the app: drop this client and start another one later. */
  private failed(error: string) {
    this.generation += 1;
    this.client?.close();
    this.client = null;
    this.setState("error", error);
    this.failures += 1;
    const delay = Math.min(feishuTiming.firstRetryMs * 2 ** (this.failures - 1), feishuTiming.maxRetryMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, delay);
  }

  private async deliver(payload: unknown) {
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, this.connectionId)).limit(1);
    // Switched to the events URL or deleted since: the next sync closes this client.
    if (!conn || feishuMode(conn) !== "socket") return;
    try {
      return await acceptFeishuEvent(conn, payload);
    } catch (err) {
      console.error("[witden] Feishu event not queued", err);
      throw err;
    }
  }
}

/** The long connections of this process, kept in line with the Feishu connections in the database. */
class FeishuSockets {
  private readonly sockets = new Map<string, FeishuSocket>();
  private timer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> = Promise.resolve();

  start(): void {
    void this.sync();
    // Changes made through another API process are picked up here.
    this.timer = setInterval(() => void this.sync(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sockets.values()) s.stop();
    this.sockets.clear();
  }

  /** Connect every long-connection connection that is not paused; close the rest and those whose keys changed. */
  sync(): Promise<void> {
    this.syncing = this.syncing.then(
      () => this.reconcile(),
      () => this.reconcile(),
    );
    return this.syncing;
  }

  private async reconcile(): Promise<void> {
    const wanted = new Map<string, { appId: string; appSecret: string }>();
    for (const conn of await getDb().select().from(connections).where(eq(connections.platform, "feishu"))) {
      if (conn.status === "paused" || feishuMode(conn) !== "socket") continue;
      try {
        const c = credentials(conn);
        if (c.app_id && c.app_secret) wanted.set(conn.id, { appId: c.app_id, appSecret: c.app_secret });
      } catch {
        // unreadable credentials (master key changed): nothing to connect with
      }
    }
    for (const [id, socket] of this.sockets) {
      const w = wanted.get(id);
      if (w && w.appId === socket.appId && w.appSecret === socket.appSecret) continue;
      socket.stop();
      this.sockets.delete(id);
    }
    for (const [id, w] of wanted) {
      if (this.sockets.has(id)) continue;
      const socket = new FeishuSocket(id, w.appId, w.appSecret);
      this.sockets.set(id, socket);
      socket.start();
    }
  }

  /** The long connection of a connection, or null when it has none in this process. */
  state(connectionId: string): SocketState | null {
    return this.sockets.get(connectionId)?.state ?? null;
  }
}

export const feishuSockets = new FeishuSockets();

/**
 * Slack Socket Mode: witden opens a WebSocket to Slack with the connection's app-level token (xapp-, scope
 * connections:write) and receives the Events API over it, so Slack needs no public address and nothing of
 * witden faces the internet.
 *
 * Each API process keeps one socket per Socket Mode connection. Slack replaces sockets every few hours and
 * warns about 10 s before closing one: a new socket is opened at once, and the old one is closed when the new
 * one says hello. An envelope is acknowledged once its events are queued (as the HTTP route answers after
 * queueing), so Slack retries anything that was not.
 */
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { db as getDb } from "../db/client.js";
import { connections } from "../db/schema.js";
import { WitdenError } from "../errors.js";
import { acceptSlackEvent, credentials, SlackClient } from "./slack.js";
import { workspaceConnection } from "./slack-install.js";

export interface SocketState {
  state: "connecting" | "connected" | "error";
  since: string;
  /** Why the socket is down: a Slack error code (invalid_auth, missing_scope, link_disabled…) or a message. */
  error?: string;
}

/** Reconnect delays and the liveness ping; tests shorten them. */
export const socketTiming = { firstRetryMs: 1000, maxRetryMs: 60_000, pingMs: 30_000 };

class SlackSocket {
  state: SocketState = { state: "connecting", since: new Date().toISOString() };
  /** The socket Slack said hello on last; others are being replaced or are replacements still connecting. */
  private current: WebSocket | null = null;
  private readonly open = new Set<WebSocket>();
  private stopped = false;
  private failures = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private linkDisabled = false;

  constructor(
    readonly connectionId: string,
    readonly appToken: string,
  ) {}

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const ws of this.open) ws.terminate();
  }

  private setState(state: SocketState["state"], error?: string) {
    this.state = { state, since: new Date().toISOString(), ...(error ? { error } : {}) };
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      url = (await new SlackClient(this.appToken).call("apps.connections.open", {})).url;
    } catch (err) {
      // A replacement that cannot open leaves the current socket serving until Slack closes it.
      if (!this.current) this.retry((err as { error?: string }).error ?? (err as Error).message);
      return;
    }
    if (this.stopped) return;
    const ws = new WebSocket(url);
    this.open.add(ws);
    let alive = true;
    let lastError = "connection closed";
    // Slack does not always close a dead socket; a missed pong ends it so it is replaced.
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, socketTiming.pingMs);
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("message", (data) => void this.receive(ws, String(data)));
    ws.on("error", (err) => {
      lastError = err.message;
    });
    ws.on("close", () => {
      clearInterval(ping);
      this.open.delete(ws);
      if (ws === this.current) this.current = null;
      if (!this.current && !this.open.size && !this.stopped)
        this.retry(this.linkDisabled ? "link_disabled" : lastError);
    });
  }

  private retry(error: string) {
    this.setState("error", error);
    if (this.retryTimer || this.stopped) return;
    this.failures += 1;
    // Socket Mode turned off in the app: check again now and then, in case it is turned back on.
    const delay = this.linkDisabled
      ? socketTiming.maxRetryMs
      : Math.min(socketTiming.firstRetryMs * 2 ** (this.failures - 1), socketTiming.maxRetryMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private async receive(ws: WebSocket, text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      const old = this.current;
      this.current = ws;
      this.failures = 0;
      this.linkDisabled = false;
      this.setState("connected");
      if (old && old !== ws) old.close();
      return;
    }
    if (msg.type === "disconnect") {
      if (msg.reason === "link_disabled") this.linkDisabled = true;
      // Slack is about to close this socket: open the next one now so no event waits.
      else if (ws === this.current && this.open.size === 1) void this.connect();
      return;
    }
    if (!msg.envelope_id) return;
    try {
      if (msg.type === "events_api") await this.deliver(msg.payload);
    } catch (err) {
      // Queueing failed: no acknowledgement, so Slack sends it again. Refusals (e.g. another workspace) are
      // final and acknowledged below.
      if (!(err instanceof WitdenError && err.status < 500)) {
        console.error("[witden] Slack socket event not queued", err);
        return;
      }
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
  }

  private async deliver(payload: any) {
    const [app] = await getDb().select().from(connections).where(eq(connections.id, this.connectionId)).limit(1);
    // One socket per app: events of every workspace it is installed in arrive here.
    if (app) await acceptSlackEvent(await workspaceConnection(getDb(), app, payload?.team_id), payload);
  }
}

/** The sockets of this process, kept in line with the Socket Mode connections in the database. */
class SlackSockets {
  private readonly sockets = new Map<string, SlackSocket>();
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

  /**
   * Open a socket per Socket Mode app (a connection holding an app token) while any of its workspaces is not
   * paused; close the rest and those whose token changed. Workspaces installed through an app have no socket.
   */
  sync(): Promise<void> {
    this.syncing = this.syncing.then(
      () => this.reconcile(),
      () => this.reconcile(),
    );
    return this.syncing;
  }

  private async reconcile(): Promise<void> {
    const wanted = new Map<string, string>();
    const all = await getDb().select().from(connections).where(eq(connections.platform, "slack"));
    for (const c of all) {
      if (c.installOf) continue;
      const family = [c, ...all.filter((x) => x.installOf === c.id)];
      if (family.every((x) => x.status === "paused")) continue;
      try {
        const token = credentials(c).app_token;
        if (token) wanted.set(c.id, token);
      } catch {
        // unreadable credentials (master key changed): nothing to connect with
      }
    }
    for (const [id, socket] of this.sockets) {
      if (wanted.get(id) === socket.appToken) continue;
      socket.stop();
      this.sockets.delete(id);
    }
    for (const [id, token] of wanted) {
      if (this.sockets.has(id)) continue;
      const socket = new SlackSocket(id, token);
      this.sockets.set(id, socket);
      socket.start();
    }
  }

  state(connectionId: string): SocketState | null {
    return this.sockets.get(connectionId)?.state ?? null;
  }
}

export const slackSockets = new SlackSockets();

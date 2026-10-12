import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type {
  ModelProxyConfig,
  ProxyChunkMessage,
  ProxyEndMessage,
  ProxyResponseMessage,
  RunnerToHub,
} from "@witden/shared";
import type { Logger } from "./log.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Where programs in the computer (and login shells, via the image's profile) find the endpoint and key. */
export const ENV_FILE = path.join(".config", "witden", "model-proxy.env");

interface Pending {
  res: http.ServerResponse;
  started: boolean;
}

const sameConfig = (a: ModelProxyConfig | null, b: ModelProxyConfig | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The computer's local model endpoint. Programs inside the computer talk to http://127.0.0.1:<port> with the
 * key the platform issued for this computer; every request is relayed to the platform over the runner's own
 * connection, which checks the key and the allowed models and calls the real provider. No provider address
 * or key ever enters the computer, and the issued key is useless anywhere else.
 */
export class ModelProxy {
  private config: ModelProxyConfig | null = null;
  private server: http.Server | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly home: string,
    private readonly log: Logger,
    private readonly send: (message: RunnerToHub) => boolean,
  ) {}

  get envFile(): string {
    return path.join(this.home, ENV_FILE);
  }

  get port(): number | null {
    return this.config?.port ?? null;
  }

  /** Apply the platform's settings (null: off). Idempotent. */
  async configure(config: ModelProxyConfig | null): Promise<void> {
    if (sameConfig(config, this.config) && (!config || this.server)) return;
    const portChanged = config?.port !== this.config?.port;
    this.config = config;
    this.writeEnvFile();
    if (!config) {
      await this.stop();
      return;
    }
    if (this.server && !portChanged) return;
    await this.stop();
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    }).catch((err) => {
      this.log.error("model proxy cannot listen", { port: config.port, error: String(err) });
      throw err;
    });
    this.server = server;
    this.log.info("model proxy listening", { port: config.port, models: config.models.length });
  }

  private writeEnvFile(): void {
    const file = this.envFile;
    try {
      if (!this.config) {
        fs.rmSync(file, { force: true });
        return;
      }
      const { port, key, models } = this.config;
      const lines = [
        "# Model access provided by witden for this computer. The key only works through the local endpoint below.",
        `OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`,
        `OPENAI_API_KEY=${key}`,
        `ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`,
        `ANTHROPIC_API_KEY=${key}`,
        `WITDEN_MODELS=${models.join(",")}`,
        "",
      ];
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${file}.tmp`, lines.join("\n"), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.log.warn("cannot write the model proxy env file", { file, error: String(err) });
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        fail(res, 413, "request body too large");
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.headersSent || res.writableEnded) return;
      const id = randomUUID();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(", ");
      }
      this.pending.set(id, { res, started: false });
      // The client hung up: stop the upstream call too.
      res.on("close", () => {
        if (this.pending.delete(id)) this.send({ type: "proxy.cancel", id });
      });
      const sent = this.send({
        type: "proxy.request",
        id,
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers,
        bodyBase64: Buffer.concat(chunks).toString("base64"),
      });
      if (!sent) {
        this.pending.delete(id);
        fail(res, 503, "the computer is not connected to the platform right now");
      }
    });
  }

  /** proxy.response / proxy.chunk / proxy.end from the platform. */
  onMessage(message: ProxyResponseMessage | ProxyChunkMessage | ProxyEndMessage): void {
    const p = this.pending.get(message.id);
    if (!p) return;
    if (message.type === "proxy.response") {
      p.started = true;
      p.res.writeHead(message.status, message.headers);
      p.res.flushHeaders();
    } else if (message.type === "proxy.chunk") {
      if (!p.started) {
        p.started = true;
        p.res.writeHead(200);
      }
      p.res.write(Buffer.from(message.dataBase64, "base64"));
    } else {
      this.pending.delete(message.id);
      if (!p.started) fail(p.res, 502, message.error ?? "no answer from the platform");
      else if (message.error) p.res.destroy(new Error(message.error));
      else p.res.end();
    }
  }

  /** The connection to the platform is gone: requests in flight cannot be answered. */
  disconnected(): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      if (!p.started) fail(p.res, 502, "the connection to the platform was lost");
      else p.res.destroy(new Error("the connection to the platform was lost"));
    }
  }

  private async stop(): Promise<void> {
    this.disconnected();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

/** Errors in the shape OpenAI- and Anthropic-style clients both report usefully. */
function fail(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message } }));
}

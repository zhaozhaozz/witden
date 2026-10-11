import type {
  BackupRequest,
  BackupResult,
  ComputerSpec,
  ContainerState,
  ContainerStats,
  CreateComputerResult,
  ManagerApi,
  ManagerErrorBody,
  RemoveComputerRequest,
  RestoreRequest,
  RunnerChannel,
  VolumeUsageRequest,
} from "@witden/shared";
import WebSocket from "ws";
import { RelayChannel, toBytes } from "./channel.js";
import { ERROR_STATUS, isManagerErrorCode, ManagerError, type ManagerErrorCode } from "./errors.js";

export interface ManagerClientOptions {
  /** e.g. http://127.0.0.1:8340 */
  baseUrl: string;
  token: string;
  /** Per-request timeout; backups and image pulls can take minutes. Default 15 minutes. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function codeForStatus(status: number): ManagerErrorCode {
  const match = Object.entries(ERROR_STATUS).find(([, s]) => s === status);
  return match ? (match[0] as ManagerErrorCode) : status >= 500 ? "internal" : "invalid";
}

/** Rebuilds the server-side ManagerError from an HTTP error response. */
function errorFromResponse(status: number, text: string): ManagerError {
  try {
    const body = JSON.parse(text) as Partial<ManagerErrorBody>;
    const code = body.error?.code;
    if (isManagerErrorCode(code)) return new ManagerError(code, body.error?.message ?? code);
  } catch {
    // not a ManagerErrorBody
  }
  return new ManagerError(codeForStatus(status), `manager responded ${status}: ${text.slice(0, 200)}`);
}

/** `ManagerApi` over the manager's HTTP API (see http-server.ts for the routes). */
export class ManagerClient implements ManagerApi {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ManagerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authorization = `Bearer ${options.token}`;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  health(): Promise<{ ok: boolean; docker: string }> {
    return this.call("GET", "/v1/health");
  }

  async ensureImage(image: string): Promise<void> {
    await this.call("POST", "/v1/images/ensure", { image });
  }

  create(spec: ComputerSpec): Promise<CreateComputerResult> {
    return this.call("POST", "/v1/computers", spec);
  }

  async start(containerId: string): Promise<void> {
    await this.call("POST", `${this.computer(containerId)}/start`);
  }

  async stop(containerId: string, timeoutSec?: number): Promise<void> {
    await this.call("POST", `${this.computer(containerId)}/stop`, { timeoutSec });
  }

  async restart(containerId: string, timeoutSec?: number): Promise<void> {
    await this.call("POST", `${this.computer(containerId)}/restart`, { timeoutSec });
  }

  async remove(containerId: string | null, request: RemoveComputerRequest): Promise<void> {
    if (containerId !== null) {
      await this.call("POST", `${this.computer(containerId)}/remove`, request);
    } else if (request.removeVolumes) {
      await this.call("POST", "/v1/volumes/remove", { volumes: request.volumes });
    }
  }

  async state(containerId: string | null): Promise<ContainerState> {
    if (containerId === null) return { exists: false, running: false, status: "missing" };
    return this.call("GET", `${this.computer(containerId)}/state`);
  }

  stats(containerId: string): Promise<ContainerStats> {
    return this.call("GET", `${this.computer(containerId)}/stats`);
  }

  volumeUsage(request: VolumeUsageRequest): Promise<Record<string, number>> {
    return this.call("POST", "/v1/volumes/usage", request);
  }

  backup(containerId: string, request: BackupRequest): Promise<BackupResult> {
    return this.call("POST", `${this.computer(containerId)}/backups`, request);
  }

  restore(request: RestoreRequest): Promise<CreateComputerResult> {
    return this.call("POST", `/v1/backups/${encodeURIComponent(request.backupId)}/restore`, request);
  }

  async deleteBackup(backupId: string): Promise<void> {
    await this.call("DELETE", `/v1/backups/${encodeURIComponent(backupId)}`);
  }

  openRunnerChannel(containerId: string): Promise<RunnerChannel> {
    const url = new URL(`${this.baseUrl}${this.computer(containerId)}/runner-channel`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, { headers: { authorization: this.authorization } });
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: ManagerError) => {
        if (settled) return;
        settled = true;
        reject(err);
        ws.terminate();
      };
      ws.on("unexpected-response", (_req, res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => fail(errorFromResponse(res.statusCode ?? 500, text)));
        res.on("error", () => fail(errorFromResponse(res.statusCode ?? 500, text)));
      });
      ws.on("error", (err) => fail(new ManagerError("unavailable", `runner channel: ${err.message}`)));
      ws.once("open", () => {
        settled = true;
        const channel = new RelayChannel({
          send: (data) => ws.send(data, { binary: true }),
          close: () => ws.close(1000),
        });
        ws.on("message", (data, isBinary) => {
          if (isBinary) channel.emitData(toBytes(data));
        });
        ws.on("close", (code, reason) => channel.emitClose(reason.toString("utf8") || `closed (${code})`));
        resolve(channel);
      });
    });
  }

  private computer(containerId: string): string {
    return `/v1/computers/${encodeURIComponent(containerId)}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: this.authorization };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ManagerError("unavailable", `manager unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw errorFromResponse(res.status, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

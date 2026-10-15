/**
 * A simulated computer for tests: an in-memory runner speaking the real runner protocol, plus a fake Docker
 * Manager that "creates" such computers and makes their runners dial into the hub. Nothing executes anywhere.
 */
import { posix } from "node:path";
import type {
  BackupRequest,
  BackupResult,
  ComputerSpec,
  ContainerState,
  ContainerStats,
  CreateComputerResult,
  ManagerApi,
  ModelProxyConfig,
  RemoveComputerRequest,
  RequestMessage,
  RestoreRequest,
  RunnerChannel,
  VolumeUsageRequest,
} from "@witden/shared";
import { encodeStreamFrame, RUNNER_PROTOCOL_VERSION } from "@witden/shared";
import { type HubTransport, memoryTransportPair, type RunnerHub } from "../../src/compute/hub.js";

export const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export type ExecHandler = (command: string) => { exitCode: number; output: string } | undefined;

export class FakeComputer {
  files = new Map<string, Buffer>();
  commands: string[] = [];
  inputs: Record<string, unknown>[] = [];
  browserActions: Record<string, unknown>[] = [];
  journal = new Map<string, unknown>();
  execHandler: ExecHandler | null = null;
  /** Drop the connection instead of answering the next request with this op (simulates a crash mid-call). */
  dropOn: string | null = null;
  /** Run the next request with this op, journal its result, then drop the connection and reconnect shortly. */
  dropAfter: string | null = null;
  /** Model proxy settings the platform sent (welcome / configure). */
  modelProxy: ModelProxyConfig | null = null;
  private proxyCalls = new Map<
    string,
    { status: number; headers: Record<string, string>; chunks: Buffer[]; done: (error?: string) => void }
  >();
  private proxySeq = 0;
  /** False: the runner has gone quiet (its connection looks open but nothing answers). */
  answersPings = true;
  private transport: HubTransport | null = null;
  private hub: RunnerHub | null = null;
  private sessions = 0;

  constructor(
    readonly instanceId: string,
    readonly spec: ComputerSpec,
  ) {}

  get connected(): boolean {
    return this.transport !== null;
  }

  connect(hub: RunnerHub): void {
    this.hub = hub;
    const [hubSide, runnerSide] = memoryTransportPair();
    hub.accept(hubSide, "memory");
    this.transport = runnerSide;
    runnerSide.onText((text) => void this.handle(JSON.parse(text)));
    runnerSide.onClose(() => {
      if (this.transport === runnerSide) this.transport = null;
    });
    runnerSide.sendText(
      JSON.stringify({
        type: "hello",
        protocol: RUNNER_PROTOCOL_VERSION,
        instanceId: this.instanceId,
        token: this.spec.runner.token,
        runnerVersion: "test",
        info: {
          hostname: this.spec.name,
          user: "witden",
          uid: 1000,
          workdir: this.spec.workdir,
          desktop: null,
          browser: true,
          tools: [],
        },
      }),
    );
  }

  disconnect(): void {
    this.transport?.close("computer stopped");
    this.transport = null;
  }

  /** Resolved against the working directory, as the runner does (``..`` included). */
  private path(p: string): string {
    return posix.resolve(this.spec.workdir, p);
  }

  private reply(id: string, ok: boolean, result?: unknown, error?: { code: string; message: string }) {
    const msg = { type: "response", id, ok, result, error };
    this.journal.set(id, msg);
    this.transport?.sendText(JSON.stringify(msg));
  }

  /** What a program in the computer would get from the local model endpoint (relayed like the real runner). */
  proxy(
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<{ status: number; headers: Record<string, string>; text: string; json: () => any; error?: string }> {
    const id = `px-${++this.proxySeq}`;
    return new Promise((resolve) => {
      const call = {
        status: 0,
        headers: {} as Record<string, string>,
        chunks: [] as Buffer[],
        done: (error?: string) => {
          const text = Buffer.concat(call.chunks).toString("utf8");
          resolve({ status: call.status, headers: call.headers, text, json: () => JSON.parse(text), error });
        },
      };
      this.proxyCalls.set(id, call);
      const body = opts.body === undefined ? "" : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      this.transport?.sendText(
        JSON.stringify({
          type: "proxy.request",
          id,
          method,
          path,
          headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
          bodyBase64: Buffer.from(body).toString("base64"),
        }),
      );
    });
  }

  private async handle(msg: any): Promise<void> {
    if (msg.type === "ping") {
      if (this.answersPings) this.transport?.sendText(JSON.stringify({ type: "pong", at: msg.at }));
      return;
    }
    if (msg.type === "welcome" || msg.type === "configure") {
      this.modelProxy = msg.modelProxy ?? null;
      return;
    }
    if (msg.type === "proxy.response" || msg.type === "proxy.chunk" || msg.type === "proxy.end") {
      const call = this.proxyCalls.get(msg.id);
      if (!call) return;
      if (msg.type === "proxy.response") {
        call.status = msg.status;
        call.headers = msg.headers;
      } else if (msg.type === "proxy.chunk") call.chunks.push(Buffer.from(msg.dataBase64, "base64"));
      else {
        this.proxyCalls.delete(msg.id);
        call.done(msg.error);
      }
      return;
    }
    if (msg.type === "stream.open") {
      this.transport?.sendText(JSON.stringify({ type: "stream.opened", streamId: msg.streamId }));
      this.transport?.sendBinary(encodeStreamFrame(msg.streamId, new TextEncoder().encode("RFB 003.008\n")));
      return;
    }
    if (msg.type !== "request") return;
    const req = msg as RequestMessage;
    if (this.dropAfter === req.op) {
      this.dropAfter = null;
      let msg: unknown;
      try {
        msg = { type: "response", id: req.id, ok: true, result: await this.run(req) };
      } catch (err) {
        msg = { type: "response", id: req.id, ok: false, error: { code: "failed", message: (err as Error).message } };
      }
      this.journal.set(req.id, msg);
      const hub = this.hub;
      this.disconnect();
      setTimeout(() => hub && this.connect(hub), 50);
      return;
    }
    if (this.dropOn === req.op) {
      this.dropOn = null;
      this.journal.set(req.id, "running");
      this.disconnect();
      return;
    }
    try {
      this.reply(req.id, true, await this.run(req));
    } catch (err) {
      this.reply(req.id, false, undefined, { code: (err as any).code ?? "failed", message: (err as Error).message });
    }
  }

  private async run(req: RequestMessage): Promise<unknown> {
    const p = req.params as Record<string, any>;
    switch (req.op) {
      case "exec.run": {
        this.commands.push(p.command);
        const r = this.execHandler?.(p.command) ?? { exitCode: 0, output: `[${this.spec.name}] ran: ${p.command}` };
        return { ...r, timedOut: false, truncated: false, killed: false };
      }
      case "terminal.create":
        this.commands.push(`terminal: ${p.command}`);
        return { sessionId: `wd-${++this.sessions}` };
      case "terminal.read":
        return { sessionId: p.sessionId, output: "$ done", running: false, foreground: "bash" };
      case "terminal.input":
      case "terminal.key":
        return {};
      case "terminal.kill":
        return { sessionId: p.sessionId, killed: 1 };
      case "file.read": {
        const data = this.files.get(this.path(p.path));
        if (!data) throw Object.assign(new Error(`no such file ${p.path}`), { code: "not_found" });
        return { path: this.path(p.path), size: data.length, contentBase64: data.toString("base64") };
      }
      case "file.write": {
        const data = Buffer.from(p.contentBase64, "base64");
        this.files.set(this.path(p.path), data);
        return { path: this.path(p.path), size: data.length };
      }
      case "file.list":
        return [...this.files.keys()]
          .filter((k) => k.startsWith(this.path(p.path)))
          .map((k) => ({ name: k, type: "file", size: 1, mtime: new Date().toISOString() }));
      case "file.move": {
        const data = this.files.get(this.path(p.from));
        if (!data) throw Object.assign(new Error("no such file"), { code: "not_found" });
        this.files.delete(this.path(p.from));
        this.files.set(this.path(p.to), data);
        return {};
      }
      case "screen.capture":
        return { pngBase64: TINY_PNG, width: 1280, height: 800 };
      case "input.mouse":
      case "input.keyboard":
        this.inputs.push({ op: req.op, ...p });
        return {};
      case "browser.open":
        this.browserActions.push({ op: req.op, ...p });
        return { sessionId: p.sessionId ?? `br-${++this.sessions}`, mode: p.mode, url: p.url, title: `Page ${p.url}` };
      case "browser.snapshot":
        return {
          sessionId: p.sessionId,
          mode: "desktop",
          url: "https://example.test",
          title: "Example",
          text: "Quarterly data",
          elements: [{ ref: "e1", role: "link", name: "Download CSV" }],
        };
      case "browser.click":
      case "browser.type":
      case "browser.close":
        this.browserActions.push({ op: req.op, ...p });
        return { url: "https://example.test" };
      case "browser.download":
        this.browserActions.push({ op: req.op, ...p });
        this.files.set("/home/witden/Downloads/data.csv", Buffer.from("a,b\n1,2\n"));
        return { path: "/home/witden/Downloads/data.csv", size: 8, suggestedName: "data.csv" };
      case "journal.get": {
        const entry = this.journal.get(String(p.requestId));
        if (entry === "running") return { state: "running" };
        return entry ? { state: "completed", response: entry } : { state: "unknown" };
      }
      default:
        throw Object.assign(new Error(`unsupported op ${req.op}`), { code: "unsupported" });
    }
  }
}

interface FakeContainer {
  spec: ComputerSpec;
  running: boolean;
  computer: FakeComputer;
}

export class FakeManager implements ManagerApi {
  containers = new Map<string, FakeContainer>();
  backups = new Map<string, Map<string, Buffer>>();
  hub: RunnerHub | null = null;
  private next = 0;

  computer(instanceId: string): FakeComputer {
    const c = [...this.containers.values()].find((x) => x.spec.instanceId === instanceId);
    if (!c) throw new Error(`no computer for ${instanceId}`);
    return c.computer;
  }

  async health() {
    return { ok: true, docker: "fake" };
  }
  async ensureImage() {}
  async create(spec: ComputerSpec): Promise<CreateComputerResult> {
    const id = `fake-${++this.next}`;
    this.containers.set(id, { spec, running: false, computer: new FakeComputer(spec.instanceId, spec) });
    return { containerId: id, warnings: [] };
  }
  private get(id: string): FakeContainer {
    const c = this.containers.get(id);
    if (!c) throw Object.assign(new Error("container not found"), { code: "not_found" });
    return c;
  }
  async start(id: string) {
    const c = this.get(id);
    c.running = true;
    // The runner inside dials the hub by itself, as a real computer would.
    if (this.hub && c.spec.runner.hubUrl) c.computer.connect(this.hub);
  }
  async stop(id: string) {
    const c = this.get(id);
    c.running = false;
    c.computer.disconnect();
  }
  async restart(id: string) {
    await this.stop(id);
    await this.start(id);
  }
  async remove(id: string | null, _req: RemoveComputerRequest) {
    if (!id) return;
    this.containers.get(id)?.computer.disconnect();
    this.containers.delete(id);
  }
  async state(id: string | null): Promise<ContainerState> {
    const c = id ? this.containers.get(id) : undefined;
    return c
      ? { exists: true, running: c.running, status: c.running ? "running" : "exited" }
      : { exists: false, running: false, status: "missing" };
  }
  async stats(): Promise<ContainerStats> {
    return {
      cpuPercent: 1,
      memoryBytes: 1024,
      memoryLimitBytes: null,
      netRxBytes: 0,
      netTxBytes: 0,
      blockReadBytes: 0,
      blockWriteBytes: 0,
      pids: 3,
    };
  }
  async volumeUsage(req: VolumeUsageRequest) {
    return Object.fromEntries(req.volumes.map((v) => [v, 0]));
  }
  async backup(id: string, req: BackupRequest): Promise<BackupResult> {
    this.backups.set(req.backupId, new Map(this.get(id).computer.files));
    return {
      imageRef: `witden-backup:${req.backupId}`,
      archives: Object.fromEntries(req.mounts.map((m, i) => [m, `${i}.tar`])),
      sizeBytes: 1,
    };
  }
  async restore(req: RestoreRequest): Promise<CreateComputerResult> {
    if (req.replaceContainerId) await this.remove(req.replaceContainerId, { volumes: [], removeVolumes: true });
    const created = await this.create(req.spec);
    const files = this.backups.get(req.backupId) ?? new Map();
    const target = this.get(created.containerId).computer;
    for (const [path, data] of files) {
      if (!req.scrubPaths.some((s) => path === s || path.startsWith(`${s}/`))) target.files.set(path, data);
    }
    await this.start(created.containerId);
    return created;
  }
  async deleteBackup(backupId: string) {
    this.backups.delete(backupId);
  }
  async openRunnerChannel(): Promise<RunnerChannel> {
    throw new Error("the fake manager has no stdio channel");
  }
}

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type BackupRequest,
  type BackupResult,
  type ComputerSpec,
  type ContainerState,
  type ContainerStats,
  type CreateComputerResult,
  DEFAULT_CAPS,
  type ManagerApi,
  type NetworkMode,
  type RemoveComputerRequest,
  type RestoreRequest,
  type RunnerChannel,
  type VolumeUsageRequest,
} from "@witden/shared";
import Docker from "dockerode";
import { filterArchive } from "./archive.js";
import { RelayChannel, StdoutDemuxer } from "./channel.js";
import { ManagerError } from "./errors.js";
import {
  DEFAULT_ALLOWED_RUNTIMES,
  validateBackupId,
  validateBackupRequest,
  validateComputerSpec,
  validateContainerRef,
  validateImageRef,
  validateRemoveRequest,
  validateRestoreRequest,
  validateTimeout,
  validateVolumeNames,
} from "./validate.js";

export const LABEL_MANAGED = "witden.managed";
export const LABEL_INSTANCE = "witden.instance";
export const LABEL_PATH = "witden.path";
export const LABEL_BACKUP = "witden.backup";
export const BACKUP_REPOSITORY = "witden-backup";
export const DEFAULT_BRIDGE_NETWORK = "witden-computers";
export const DEFAULT_INTERNAL_NETWORK = "witden-computers-internal";
export const DEFAULT_RUNNER_COMMAND: readonly string[] = [
  "/usr/local/bin/node",
  "/opt/witden/runner/witden-runner.mjs",
  "--stdio",
];
export const DEFAULT_RUNNER_USER = "witden";
export const DEFAULT_HUB_HOST = "witden-hub";

const ICC_OPTION = "com.docker.network.bridge.enable_icc";
const DISK_QUOTA_WARNING = "disk quota not supported by the Docker storage driver; not enforced";
const MISSING: ContainerState = { exists: false, running: false, status: "missing" };

export interface DockerManagerOptions {
  /** Backups live in `<dataDir>/backups/<backupId>/`, scratch files in `<dataDir>/tmp/`. */
  dataDir: string;
  /** Default: a client configured from DOCKER_HOST / DOCKER_TLS_VERIFY / DOCKER_CERT_PATH. */
  docker?: Docker;
  bridgeNetwork?: string;
  internalNetwork?: string;
  /** Runtimes a spec may request (in addition to the daemon default). */
  allowedRuntimes?: readonly string[];
  /** Command started with `docker exec` for the stdio runner channel, and the user it runs as. */
  runnerCommand?: readonly string[];
  runnerUser?: string;
  /** Host name that bridge computers resolve to the Docker host, where the hub is published. */
  hubHost?: string;
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

function dockerMessage(err: unknown): string {
  const e = err as { json?: { message?: unknown }; message?: unknown } | null;
  if (e && typeof e.json === "object" && e.json && typeof e.json.message === "string") return e.json.message;
  if (e && typeof e.message === "string") return e.message;
  return String(err);
}

/** Maps a dockerode failure to a ManagerError (ManagerErrors pass through unchanged). */
function wrap(err: unknown, context: string): ManagerError {
  if (err instanceof ManagerError) return err;
  const message = `${context}: ${dockerMessage(err).trim()}`;
  const status = statusOf(err);
  if (status === 404) return new ManagerError("not_found", message);
  if (status === 409) return new ManagerError("conflict", message);
  return new ManagerError("docker_error", message);
}

function isRunning(info: Docker.ContainerInspectInfo): boolean {
  // A container in a crash/restart loop is not usable even if Docker reports it running.
  return Boolean(info.State?.Running) && !info.State?.Restarting;
}

/** Same arithmetic as `docker stats`. */
export function computeStats(s: any): ContainerStats {
  const cpu = s?.cpu_stats ?? {};
  const pre = s?.precpu_stats ?? {};
  const cpuDelta = (cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
  const online = cpu.online_cpus || 1;
  const mem = s?.memory_stats ?? {};
  const memUsage = (mem.usage ?? 0) - (mem.stats?.inactive_file ?? 0);
  const nets = Object.values(s?.networks ?? {}) as { rx_bytes?: number; tx_bytes?: number }[];
  const blk = (s?.blkio_stats?.io_service_bytes_recursive ?? []) as { op?: string; value?: number }[];
  const io = (op: string) =>
    blk.filter((b) => (b.op ?? "").toLowerCase() === op).reduce((sum, b) => sum + (b.value ?? 0), 0);
  return {
    cpuPercent: sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * online * 10_000) / 100 : 0,
    memoryBytes: Math.max(memUsage, 0),
    memoryLimitBytes: mem.limit ?? null,
    netRxBytes: nets.reduce((sum, n) => sum + (n.rx_bytes ?? 0), 0),
    netTxBytes: nets.reduce((sum, n) => sum + (n.tx_bytes ?? 0), 0),
    blockReadBytes: io("read"),
    blockWriteBytes: io("write"),
    pids: s?.pids_stats?.current ?? null,
  };
}

/**
 * The only witden component with Docker access. Every method validates its input, and only containers,
 * volumes, networks and images labelled `witden.managed=true` (i.e. created here) are ever touched.
 */
export class DockerManager implements ManagerApi {
  readonly docker: Docker;
  private readonly dataDir: string;
  private readonly bridgeNetwork: string;
  private readonly internalNetwork: string;
  private readonly allowedRuntimes: readonly string[];
  private readonly runnerCommand: string[];
  private readonly runnerUser: string;
  private readonly hubHost: string;
  private readonly networkLocks = new Map<string, Promise<void>>();
  private quotaIgnored: Promise<boolean> | null = null;

  constructor(options: DockerManagerOptions) {
    this.docker = options.docker ?? new Docker();
    this.dataDir = path.resolve(options.dataDir);
    this.bridgeNetwork = options.bridgeNetwork || DEFAULT_BRIDGE_NETWORK;
    this.internalNetwork = options.internalNetwork || DEFAULT_INTERNAL_NETWORK;
    this.allowedRuntimes = options.allowedRuntimes ?? DEFAULT_ALLOWED_RUNTIMES;
    this.runnerCommand = [...(options.runnerCommand ?? DEFAULT_RUNNER_COMMAND)];
    this.runnerUser = options.runnerUser || DEFAULT_RUNNER_USER;
    this.hubHost = options.hubHost || DEFAULT_HUB_HOST;
    if (!this.runnerCommand.length) throw new Error("runnerCommand must not be empty");
  }

  async health(): Promise<{ ok: boolean; docker: string }> {
    try {
      const version = await this.docker.version();
      return { ok: true, docker: version.Version };
    } catch (err) {
      return { ok: false, docker: `unreachable: ${dockerMessage(err)}` };
    }
  }

  async ensureImage(image: string): Promise<void> {
    const ref = validateImageRef(image);
    if (await this.inspectImage(ref)) return;
    try {
      const stream = await this.docker.pull(ref);
      const events = await new Promise<{ error?: string; errorDetail?: { message?: string } }[]>((resolve, reject) =>
        this.docker.modem.followProgress(stream, (err: Error | null, out: any[]) => (err ? reject(err) : resolve(out))),
      );
      // Pull failures after the 200 response arrive as progress events, not as an HTTP error.
      const failure = events.find((e) => e?.error || e?.errorDetail);
      if (failure) throw new Error(failure.error ?? failure.errorDetail?.message ?? "pull failed");
    } catch (err) {
      throw wrap(err, `cannot pull image ${ref}`);
    }
  }

  async create(spec: ComputerSpec): Promise<CreateComputerResult> {
    return this.createComputer(validateComputerSpec(spec, { allowedRuntimes: this.allowedRuntimes }));
  }

  async start(containerId: string): Promise<void> {
    const { container } = await this.managedContainer(containerId);
    try {
      await container.start();
    } catch (err) {
      if (statusOf(err) !== 304) throw wrap(err, "cannot start computer");
    }
  }

  async stop(containerId: string, timeoutSec?: number): Promise<void> {
    const t = validateTimeout(timeoutSec);
    const { container } = await this.managedContainer(containerId);
    try {
      await container.stop({ t });
    } catch (err) {
      if (statusOf(err) !== 304) throw wrap(err, "cannot stop computer");
    }
  }

  async restart(containerId: string, timeoutSec?: number): Promise<void> {
    const t = validateTimeout(timeoutSec);
    const { container } = await this.managedContainer(containerId);
    try {
      await container.restart({ t });
    } catch (err) {
      throw wrap(err, "cannot restart computer");
    }
  }

  async remove(containerId: string | null, request: RemoveComputerRequest): Promise<void> {
    const req = validateRemoveRequest(request);
    if (containerId !== null && containerId !== undefined) {
      const info = await this.findManagedContainer(containerId);
      if (info) await this.removeContainer(info.Id);
    }
    if (req.removeVolumes) await this.removeVolumes(req.volumes);
  }

  async state(containerId: string | null): Promise<ContainerState> {
    if (containerId === null || containerId === undefined) return { ...MISSING };
    const info = await this.findManagedContainer(containerId);
    if (!info) return { ...MISSING };
    const s = info.State;
    return {
      exists: true,
      running: isRunning(info),
      status: s.Status,
      error: s.Error || null,
      exitCode: s.ExitCode ?? null,
      oomKilled: Boolean(s.OOMKilled),
      startedAt: s.StartedAt && !s.StartedAt.startsWith("0001-") ? s.StartedAt : null,
    };
  }

  async stats(containerId: string): Promise<ContainerStats> {
    const { container, info } = await this.managedContainer(containerId);
    if (!isRunning(info)) throw new ManagerError("not_running", `computer is not running (${info.State.Status})`);
    try {
      return computeStats(await container.stats({ stream: false }));
    } catch (err) {
      throw wrap(err, "cannot read stats");
    }
  }

  async volumeUsage(request: VolumeUsageRequest): Promise<Record<string, number>> {
    const wanted = new Set(validateVolumeNames((request as VolumeUsageRequest | undefined)?.volumes));
    let df: any;
    try {
      // dockerode's df() cannot pass `type`, which avoids computing image and build-cache sizes.
      df = await new Promise((resolve, reject) =>
        this.docker.modem.dial(
          {
            path: "/system/df?",
            method: "GET",
            options: { type: "volume" },
            statusCodes: { 200: true, 500: "server error" },
          },
          (err: unknown, data: unknown) => (err ? reject(err) : resolve(data)),
        ),
      );
    } catch (err) {
      throw wrap(err, "cannot read disk usage");
    }
    const usage: Record<string, number> = {};
    for (const v of (df?.Volumes ?? df?.VolumeUsage?.Items ?? []) as Docker.VolumeInspectInfo[]) {
      if (!wanted.has(v.Name)) continue;
      if (v.Labels?.[LABEL_MANAGED] !== "true") {
        throw new ManagerError("not_managed", `volume ${v.Name} is not managed by witden`);
      }
      usage[v.Name] = v.UsageData?.Size ?? -1;
    }
    return usage;
  }

  async backup(containerId: string, request: BackupRequest): Promise<BackupResult> {
    const { backupId, mounts } = validateBackupRequest(request);
    const { container, info } = await this.managedContainer(containerId);
    const volumeMounts = new Set((info.Mounts ?? []).filter((m) => m.Type === "volume").map((m) => m.Destination));
    const other = mounts.filter((m) => !volumeMounts.has(m));
    if (other.length) throw new ManagerError("invalid", `not volume mounts of this computer: ${other.join(", ")}`);
    const imageRef = `${BACKUP_REPOSITORY}:${backupId}`;
    if (await this.inspectImage(imageRef)) throw new ManagerError("conflict", `backup ${backupId} already exists`);
    const dir = this.backupDir(backupId);
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ManagerError("conflict", `backup ${backupId} already exists`);
      }
      throw err;
    }
    let committed = false;
    try {
      await container.commit({
        repo: BACKUP_REPOSITORY,
        tag: backupId,
        pause: true,
        // The committed config inherits the container env; do not keep the runner secret in the image.
        changes: [`LABEL ${LABEL_BACKUP}=${backupId}`, "ENV WITDEN_RUNNER_TOKEN="],
      });
      committed = true;
      const archives: Record<string, string> = {};
      let sizeBytes = 0;
      for (const [i, mount] of mounts.entries()) {
        const archiveId = `${i}.tar`;
        const file = path.join(dir, archiveId);
        await pipeline(
          await container.getArchive({ path: mount }),
          createWriteStream(file, { flags: "wx", mode: 0o600 }),
        );
        sizeBytes += (await stat(file)).size;
        archives[mount] = archiveId;
      }
      return { imageRef, archives, sizeBytes };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      if (committed)
        await this.docker
          .getImage(imageRef)
          .remove({ force: true })
          .catch(() => undefined);
      throw wrap(err, `backup ${backupId} failed`);
    }
  }

  async restore(request: RestoreRequest): Promise<CreateComputerResult> {
    const req = validateRestoreRequest(request, { allowedRuntimes: this.allowedRuntimes });
    const { spec } = req;

    // Check everything before the first destructive step.
    const image = await this.inspectImage(req.imageRef);
    if (!image) throw new ManagerError("not_found", `backup image ${req.imageRef} not found`);
    const labels = image.Config?.Labels ?? {};
    if (labels[LABEL_MANAGED] !== "true" || labels[LABEL_BACKUP] !== req.backupId) {
      throw new ManagerError("not_managed", `image ${req.imageRef} is not a witden backup of ${req.backupId}`);
    }
    const archives: [string, string][] = [];
    for (const [mount, archiveId] of Object.entries(req.archives)) {
      const file = path.join(this.backupDir(req.backupId), archiveId);
      try {
        await access(file);
      } catch {
        throw new ManagerError("not_found", `archive ${archiveId} of backup ${req.backupId} not found`);
      }
      archives.push([mount, file]);
    }
    const replaced = req.replaceContainerId ? await this.findManagedContainer(req.replaceContainerId) : null;
    if (replaced && replaced.Config.Labels?.[LABEL_INSTANCE] !== spec.instanceId) {
      throw new ManagerError("invalid", "replaceContainerId belongs to another instance");
    }
    // Old volumes are wiped so the archives are restored into empty volumes.
    const stale = new Set(Object.values(spec.volumes));
    for (const m of replaced?.Mounts ?? []) if (m.Type === "volume" && m.Name) stale.add(m.Name);
    await this.existingVolumes([...stale], spec.instanceId);

    if (replaced) await this.removeContainer(replaced.Id);
    await this.removeVolumes([...stale], spec.instanceId);
    const result = await this.createComputer(spec);
    const container = this.docker.getContainer(result.containerId);
    try {
      for (const [mount, file] of archives) await this.restoreArchive(container, mount, file, req.scrubPaths);
      await container.start();
      // The committed image layer can hold credentials outside the volumes too.
      if (req.scrubPaths.length) await this.scrub(container, req.scrubPaths);
    } catch (err) {
      await this.removeContainer(result.containerId).catch(() => undefined);
      await this.removeVolumes(Object.values(spec.volumes), spec.instanceId).catch(() => undefined);
      throw wrap(err, "restore failed");
    }
    return result;
  }

  async deleteBackup(backupId: string): Promise<void> {
    const id = validateBackupId(backupId);
    const imageRef = `${BACKUP_REPOSITORY}:${id}`;
    const image = await this.inspectImage(imageRef);
    if (image) {
      const labels = image.Config?.Labels ?? {};
      if (labels[LABEL_MANAGED] !== "true" || labels[LABEL_BACKUP] !== id) {
        throw new ManagerError("not_managed", `image ${imageRef} is not a witden backup`);
      }
      try {
        await this.docker.getImage(imageRef).remove({ force: true });
      } catch (err) {
        if (statusOf(err) !== 404) throw wrap(err, `cannot remove ${imageRef}`);
      }
    }
    await rm(this.backupDir(id), { recursive: true, force: true });
  }

  async openRunnerChannel(containerId: string): Promise<RunnerChannel> {
    const { container, info } = await this.managedContainer(containerId);
    if (!isRunning(info)) throw new ManagerError("not_running", `computer is not running (${info.State.Status})`);
    let exec: Docker.Exec;
    let socket: Duplex;
    try {
      exec = await container.exec({
        Cmd: this.runnerCommand,
        // the user the computer was created as; the configured default only for containers without one
        User: info.Config?.User || this.runnerUser,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: false,
        Tty: false,
      });
      socket = await exec.start({ hijack: true, stdin: true });
    } catch (err) {
      if (statusOf(err) === 409) throw new ManagerError("not_running", "computer is not running");
      throw wrap(err, "cannot start the runner");
    }
    const demux = new StdoutDemuxer();
    const channel = new RelayChannel({
      send: (data) => {
        socket.write(data);
      },
      close: () => {
        // EOF on stdin asks the runner to exit; force the socket closed if it does not.
        socket.end();
        setTimeout(() => socket.destroy(), 5_000).unref();
      },
    });
    socket.on("data", (chunk: Buffer) => {
      for (const payload of demux.push(chunk)) channel.emitData(payload);
    });
    socket.on("error", (err) => channel.emitClose(`runner channel failed: ${err.message}`));
    socket.on("close", () => {
      exec.inspect().then(
        (i) => channel.emitClose(i.Running ? "runner channel closed" : `runner exited with code ${i.ExitCode}`),
        () => channel.emitClose("runner channel closed"),
      );
    });
    return channel;
  }

  // --- containers --------------------------------------------------------------------------------------

  private async createComputer(spec: ComputerSpec): Promise<CreateComputerResult> {
    const warnings: string[] = [];
    await this.ensureImage(spec.image);
    const networkMode = await this.networkFor(spec.network);
    const res = spec.resources;
    const hostConfig: Docker.HostConfig = {
      CapDrop: ["ALL"],
      CapAdd: spec.capAdd.length ? [...spec.capAdd] : [...DEFAULT_CAPS],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Init: true,
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: networkMode,
      PublishAllPorts: false,
      // Named volumes only: no bind mounts of host paths, ever.
      Mounts: Object.entries(spec.volumes).map(([target, source]) => ({
        Type: "volume" as const,
        Source: source,
        Target: target,
        ReadOnly: false,
      })),
    };
    if (spec.network === "bridge") hostConfig.ExtraHosts = [`${this.hubHost}:host-gateway`];
    if (res.cpus) hostConfig.NanoCpus = Math.round(res.cpus * 1e9);
    if (res.memoryMb) {
      hostConfig.Memory = res.memoryMb * 1024 * 1024;
      hostConfig.MemorySwap = hostConfig.Memory;
    }
    if (res.pidsLimit) hostConfig.PidsLimit = res.pidsLimit;
    if (spec.runtime) hostConfig.Runtime = spec.runtime;
    if (res.diskGb) {
      if (await this.storageQuotaIgnored()) warnings.push(DISK_QUOTA_WARNING);
      else hostConfig.StorageOpt = { size: `${res.diskGb}G` };
    }
    const options: Docker.ContainerCreateOptions = {
      name: `witden-${spec.name}`,
      Image: spec.image,
      Hostname: spec.name,
      WorkingDir: spec.workdir,
      User: spec.user ?? DEFAULT_RUNNER_USER,
      Env: [
        ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        `WITDEN_INSTANCE_ID=${spec.instanceId}`,
        `WITDEN_RUNNER_TOKEN=${spec.runner.token}`,
        `WITDEN_HUB_URL=${spec.runner.hubUrl ?? ""}`,
      ],
      Labels: { [LABEL_MANAGED]: "true", [LABEL_INSTANCE]: spec.instanceId },
      Tty: false,
      OpenStdin: false,
      AttachStdin: false,
      HostConfig: hostConfig,
    };
    if (spec.command) options.Cmd = spec.command;

    const createdVolumes = await this.ensureVolumes(spec);
    try {
      return { containerId: await this.createContainer(options, warnings), warnings };
    } catch (err) {
      await this.removeVolumes(createdVolumes).catch(() => undefined);
      throw err;
    }
  }

  private async createContainer(options: Docker.ContainerCreateOptions, warnings: string[]): Promise<string> {
    try {
      return (await this.docker.createContainer(options)).id;
    } catch (err) {
      const host = options.HostConfig!;
      if (!host.StorageOpt || !/storage/i.test(dockerMessage(err))) throw wrap(err, "cannot create computer");
      delete host.StorageOpt;
      warnings.push(DISK_QUOTA_WARNING);
    }
    try {
      return (await this.docker.createContainer(options)).id;
    } catch (err) {
      throw wrap(err, "cannot create computer");
    }
  }

  /** The containerd image store accepts `--storage-opt size` but silently ignores it. */
  private storageQuotaIgnored(): Promise<boolean> {
    this.quotaIgnored ??= this.docker.info().then(
      (info: { DriverStatus?: [string, string][] }) =>
        (info.DriverStatus ?? []).some(([key, value]) => key === "driver-type" && value.includes("containerd")),
      () => false,
    );
    return this.quotaIgnored;
  }

  private async findManagedContainer(ref: string): Promise<Docker.ContainerInspectInfo | null> {
    const id = validateContainerRef(ref);
    let info: Docker.ContainerInspectInfo;
    try {
      info = await this.docker.getContainer(id).inspect();
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw wrap(err, "cannot inspect computer");
    }
    if (info.Config?.Labels?.[LABEL_MANAGED] !== "true") {
      throw new ManagerError("not_managed", `container ${id} is not managed by witden`);
    }
    return info;
  }

  private async managedContainer(
    ref: string,
  ): Promise<{ container: Docker.Container; info: Docker.ContainerInspectInfo }> {
    const info = await this.findManagedContainer(ref);
    if (!info) throw new ManagerError("not_found", `computer ${ref} not found`);
    return { container: this.docker.getContainer(info.Id), info };
  }

  private async removeContainer(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ force: true });
    } catch (err) {
      if (statusOf(err) !== 404) throw wrap(err, "cannot remove computer");
    }
  }

  /** Runs a fixed `rm -rf -- <paths>` as root; the only exec besides the runner channel. */
  private async scrub(container: Docker.Container, paths: string[]): Promise<void> {
    const exec = await container.exec({
      Cmd: ["rm", "-rf", "--", ...paths],
      User: "0",
      WorkingDir: "/",
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({});
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", reject);
    });
    const { ExitCode } = await exec.inspect();
    if (ExitCode !== 0) {
      const output = Buffer.concat(chunks)
        .toString("utf8")
        // Drops the multiplexing headers and other control bytes.
        .replace(/\p{Cc}+/gu, " ")
        .slice(0, 500);
      throw new ManagerError("docker_error", `credential scrub failed (exit ${ExitCode}): ${output.trim()}`);
    }
  }

  // --- volumes, networks, images -------------------------------------------------------------------------

  private async ensureVolumes(spec: ComputerSpec): Promise<string[]> {
    const created: string[] = [];
    try {
      for (const [mountPath, name] of Object.entries(spec.volumes)) {
        if ((await this.existingVolumes([name], spec.instanceId)).length) continue;
        await this.docker.createVolume({
          Name: name,
          Labels: { [LABEL_MANAGED]: "true", [LABEL_INSTANCE]: spec.instanceId, [LABEL_PATH]: mountPath },
        });
        created.push(name);
      }
    } catch (err) {
      await this.removeVolumes(created).catch(() => undefined);
      throw wrap(err, "cannot create volume");
    }
    return created;
  }

  /** Returns the volumes that exist; refuses unmanaged ones and, with `instanceId`, other computers' ones. */
  private async existingVolumes(names: string[], instanceId?: string): Promise<string[]> {
    const found: string[] = [];
    for (const name of names) {
      let volume: Docker.VolumeInspectInfo;
      try {
        volume = await this.docker.getVolume(name).inspect();
      } catch (err) {
        if (statusOf(err) === 404) continue;
        throw wrap(err, `cannot inspect volume ${name}`);
      }
      const labels = volume.Labels ?? {};
      if (labels[LABEL_MANAGED] !== "true")
        throw new ManagerError("not_managed", `volume ${name} is not managed by witden`);
      if (instanceId !== undefined && labels[LABEL_INSTANCE] !== instanceId) {
        throw new ManagerError("conflict", `volume ${name} belongs to another computer`);
      }
      found.push(name);
    }
    return found;
  }

  private async removeVolumes(names: string[], instanceId?: string): Promise<void> {
    for (const name of await this.existingVolumes(names, instanceId)) {
      try {
        await this.docker.getVolume(name).remove();
      } catch (err) {
        if (statusOf(err) !== 404) throw wrap(err, `cannot remove volume ${name}`);
      }
    }
  }

  private async networkFor(mode: NetworkMode): Promise<string> {
    if (mode === "none") return "none";
    const internal = mode === "internal";
    const name = internal ? this.internalNetwork : this.bridgeNetwork;
    // Concurrent creates share one ensure call so the network is not created twice.
    let pending = this.networkLocks.get(name);
    if (!pending) {
      pending = this.ensureNetwork(name, internal).finally(() => this.networkLocks.delete(name));
      this.networkLocks.set(name, pending);
    }
    await pending;
    return name;
  }

  private async ensureNetwork(name: string, internal: boolean): Promise<void> {
    let info = await this.inspectNetwork(name);
    if (!info) {
      try {
        // Inter-container traffic disabled: computers cannot reach each other directly.
        await this.docker.createNetwork({
          Name: name,
          Driver: "bridge",
          Internal: internal,
          Labels: { [LABEL_MANAGED]: "true" },
          Options: { [ICC_OPTION]: "false" },
        });
      } catch (err) {
        if (statusOf(err) !== 409) throw wrap(err, `cannot create network ${name}`);
      }
      info = await this.inspectNetwork(name);
      if (!info) throw new ManagerError("docker_error", `network ${name} could not be created`);
    }
    // An existing network of that name must be ours and keep the isolation computers rely on.
    if (info.Labels?.[LABEL_MANAGED] !== "true") {
      throw new ManagerError("not_managed", `network ${name} exists but is not managed by witden`);
    }
    if (Boolean(info.Internal) !== internal || info.Options?.[ICC_OPTION] !== "false") {
      throw new ManagerError("conflict", `network ${name} does not have the expected isolation settings`);
    }
  }

  private async inspectNetwork(name: string): Promise<Docker.NetworkInspectInfo | null> {
    try {
      return await this.docker.getNetwork(name).inspect();
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw wrap(err, `cannot inspect network ${name}`);
    }
  }

  private async inspectImage(ref: string): Promise<Docker.ImageInspectInfo | null> {
    try {
      return await this.docker.getImage(ref).inspect();
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw wrap(err, `cannot inspect image ${ref}`);
    }
  }

  // --- backups -------------------------------------------------------------------------------------------

  private backupDir(backupId: string): string {
    return path.join(this.dataDir, "backups", backupId);
  }

  /** Extracts a volume archive into the (not yet started) container, without the scrubbed paths. */
  private async restoreArchive(
    container: Docker.Container,
    mount: string,
    file: string,
    scrubPaths: string[],
  ): Promise<void> {
    // Docker archives a path as `<basename>/...`, so it is extracted into the parent directory.
    const parent = path.posix.dirname(mount);
    if (!scrubPaths.length) {
      await container.putArchive(file, { path: parent });
      return;
    }
    const tmpDir = path.join(this.dataDir, "tmp");
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const filtered = path.join(tmpDir, `restore-${randomBytes(8).toString("hex")}.tar`);
    try {
      await filterArchive(file, filtered, parent, scrubPaths);
      await container.putArchive(filtered, { path: parent });
    } finally {
      await rm(filtered, { force: true });
    }
  }
}

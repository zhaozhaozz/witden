/**
 * API of the Docker Manager: the only witden component that talks to the Docker daemon.
 *
 * It is deliberately narrow. Callers describe *computers* (validated specs derived from templates), never raw
 * Docker parameters, and the manager refuses anything that would weaken isolation (host mounts, privileged
 * mode, extra capabilities, host networking...). It only touches containers / volumes it labelled itself.
 * Model output never reaches this API: it is called by the platform's instance management code only.
 *
 * Transport: HTTP + JSON under /v1, authenticated with `Authorization: Bearer <WITDEN_MANAGER_TOKEN>`.
 */

export type NetworkMode = "bridge" | "internal" | "none";

export interface ComputerResources {
  cpus?: number | null;
  memoryMb?: number | null;
  pidsLimit?: number | null;
  diskGb?: number | null;
}

export interface ComputerSpec {
  /** Witden instance id; stored as a label. */
  instanceId: string;
  /** Slug used for the container name (`witden-<name>`) and hostname. */
  name: string;
  image: string;
  workdir: string;
  /** Unprivileged user (name or uid[:gid]) everything in the computer runs as; root is refused. Default witden. */
  user?: string | null;
  /** Overrides the image command (e.g. a shell template's long-running command). */
  command?: string[] | null;
  env: Record<string, string>;
  /** Mount path inside the computer -> named volume. Only `witden-` volumes, never host paths. */
  volumes: Record<string, string>;
  resources: ComputerResources;
  network: NetworkMode;
  /** Capabilities from the safe list only; empty = the manager's defaults. */
  capAdd: string[];
  /**
   * Leave out `no-new-privileges`, so setuid programs such as sudo work (the images grant passwordless
   * `sudo apt-get`). Whoever can run them is root inside the computer. Default false.
   */
  allowPrivilegeEscalation?: boolean;
  runtime?: string | null;
  /** How the runner inside reaches the platform. hubUrl null: no network route, use the stdio channel. */
  runner: { token: string; hubUrl: string | null };
}

export interface CreateComputerResult {
  containerId: string;
  warnings: string[];
}

export interface ContainerState {
  exists: boolean;
  running: boolean;
  status: string;
  error?: string | null;
  exitCode?: number | null;
  oomKilled?: boolean;
  startedAt?: string | null;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number | null;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number | null;
}

export interface RemoveComputerRequest {
  volumes: string[];
  removeVolumes: boolean;
}

export interface BackupRequest {
  backupId: string;
  /** Persistent mount paths to archive. */
  mounts: string[];
}

export interface BackupResult {
  /** Image committed from the container's writable layer (installed software). */
  imageRef: string;
  /** mount path -> archive id stored by the manager */
  archives: Record<string, string>;
  sizeBytes: number;
}

export interface RestoreRequest {
  /** Spec of the computer to (re)create; its image is replaced by the backup image. */
  spec: ComputerSpec;
  /** Existing container to replace (restore) or null (clone into a new computer). */
  replaceContainerId: string | null;
  backupId: string;
  imageRef: string;
  archives: Record<string, string>;
  /** Absolute paths (credentials, login state) removed from the archives and from the image layer. */
  scrubPaths: string[];
}

export interface VolumeUsageRequest {
  volumes: string[];
}

export interface ManagerErrorBody {
  error: { code: string; message: string };
}

/** Capabilities a template may request. Everything else (SYS_ADMIN, NET_ADMIN, SYS_PTRACE...) is refused. */
export const SAFE_CAPS: readonly string[] = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "SETGID",
  "SETUID",
  "NET_BIND_SERVICE",
  "NET_RAW",
  "SYS_CHROOT",
  "AUDIT_WRITE",
];

/** Enough for package managers and supervisors that drop privileges. */
export const DEFAULT_CAPS: readonly string[] = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "SETGID",
  "SETUID",
  "NET_BIND_SERVICE",
];

/** Added to the defaults when privilege escalation is allowed: sudo reports every command to the audit log. */
export const ESCALATION_CAPS: readonly string[] = ["AUDIT_WRITE"];

/** Mounting volumes over these would break the OS or expose kernel interfaces. */
export const FORBIDDEN_MOUNTS: readonly string[] = [
  "/",
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/boot",
  "/run",
  "/opt/witden",
];

export const VOLUME_NAME = /^witden-[a-z0-9][a-z0-9-]{1,100}$/;
export const COMPUTER_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A byte channel to a runner started by the manager (stdio transport). */
export interface RunnerChannel {
  send(data: Uint8Array): void;
  onData(listener: (data: Uint8Array) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(): void;
}

/**
 * Operations the platform needs from the manager. Implemented by the manager itself (in-process, for
 * single-process deployments) and by the HTTP client (when the manager runs as its own service).
 */
export interface ManagerApi {
  health(): Promise<{ ok: boolean; docker: string }>;
  ensureImage(image: string): Promise<void>;
  create(spec: ComputerSpec): Promise<CreateComputerResult>;
  start(containerId: string): Promise<void>;
  stop(containerId: string, timeoutSec?: number): Promise<void>;
  restart(containerId: string, timeoutSec?: number): Promise<void>;
  remove(containerId: string | null, request: RemoveComputerRequest): Promise<void>;
  state(containerId: string | null): Promise<ContainerState>;
  stats(containerId: string): Promise<ContainerStats>;
  volumeUsage(request: VolumeUsageRequest): Promise<Record<string, number>>;
  backup(containerId: string, request: BackupRequest): Promise<BackupResult>;
  restore(request: RestoreRequest): Promise<CreateComputerResult>;
  deleteBackup(backupId: string): Promise<void>;
  /** Fallback runner transport through `docker exec` (computers without a network route to the hub). */
  openRunnerChannel(containerId: string): Promise<RunnerChannel>;
}

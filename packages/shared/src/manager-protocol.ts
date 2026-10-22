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

/**
 * System packages installed or removed for the computer by the Docker Manager: a fixed apt command run as root
 * through `docker exec`, so nobody inside the computer needs root. Names only (no options, files or URLs).
 */
export interface PackagesRequest {
  action: "install" | "remove";
  packages: string[];
}

export interface PackagesResult {
  /** apt finished without error (or there was nothing to do). */
  ok: boolean;
  /** Whether each requested package is installed afterwards. */
  installed: Record<string, boolean>;
  /** Packages refused before apt ran, with the reason (e.g. part of the computer's image). */
  refused: Record<string, string>;
  /** Tail of apt's output. */
  output: string;
}

/** A Debian package name (policy 5.6.7), optionally with an architecture. */
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{1,99}(?::[a-z0-9-]{1,20})?$/;
export const MAX_PACKAGES = 100;

/**
 * The witden images list their own packages here (root-owned). They cannot be removed through the platform:
 * the computer depends on them, and a reset would bring them back anyway.
 */
export const IMAGE_PACKAGES_FILE = "/opt/witden/image-packages";

/**
 * The runner the platform keeps up to date: a volume every computer mounts read-only, filled only by the Docker
 * Manager's installer, as root. `current` links to `versions/<version>/`, a complete runner bundle with its
 * manifest.json; witden-init runs it when it is compatible, else the image's own copy (/opt/witden/runner).
 */
export const RUNNER_LIVE_DIR = "/opt/witden/runner-live";

/** manifest.json of a runner bundle (packages/runner/build.mjs). */
export interface RunnerManifest {
  /** Hash of the bundle's files; also the bundle's directory name under `versions/`. */
  version: string;
  /** Lowest Node.js major version the bundle runs on. */
  node: number;
  /** Lowest witden-init protocol the bundle needs (packages/runner/src/live.ts). */
  init: number;
}

export const RUNNER_VERSION_PATTERN = /^[0-9a-f]{12}$/;

/** The manifest when it is well-formed, else null. */
export function parseRunnerManifest(value: unknown): RunnerManifest | null {
  const m = value as Partial<RunnerManifest> | null;
  if (!m || typeof m !== "object") return null;
  if (typeof m.version !== "string" || !RUNNER_VERSION_PATTERN.test(m.version)) return null;
  if (!Number.isInteger(m.node) || !Number.isInteger(m.init)) return null;
  return { version: m.version, node: m.node as number, init: m.init as number };
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
  /** Install or remove system packages in a running computer (as root, with a fixed apt command). */
  packages(containerId: string, request: PackagesRequest): Promise<PackagesResult>;
  /** Fallback runner transport through `docker exec` (computers without a network route to the hub). */
  openRunnerChannel(containerId: string): Promise<RunnerChannel>;
}

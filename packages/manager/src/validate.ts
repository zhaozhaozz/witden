/**
 * Validation of everything that reaches the Docker daemon. Specs come from templates (user input), so anything
 * that could weaken isolation is refused here, before any Docker call: host paths, kernel interfaces, extra
 * capabilities, unknown runtimes or networks, and caller-supplied `WITDEN_*` variables (reserved for the runner).
 */
import {
  type BackupRequest,
  COMPUTER_NAME,
  type ComputerResources,
  type ComputerSpec,
  ENV_KEY,
  FORBIDDEN_MOUNTS,
  type NetworkMode,
  type RemoveComputerRequest,
  type RestoreRequest,
  SAFE_CAPS,
  VOLUME_NAME,
} from "@witden/shared";
import { ManagerError } from "./errors.js";

/** Env keys with this prefix are set by the manager only (WITDEN_INSTANCE_ID, WITDEN_RUNNER_TOKEN, WITDEN_HUB_URL). */
export const RESERVED_ENV_PREFIX = "WITDEN_";
export const NETWORK_MODES: readonly NetworkMode[] = ["bridge", "internal", "none"];
/** Same bounds as the platform's template validation (`services/templates.ts`). */
export const RESOURCE_BOUNDS = {
  cpus: [0.1, 64],
  memoryMb: [128, 262_144],
  pidsLimit: [32, 100_000],
  diskGb: [1, 4096],
} as const;
export const DEFAULT_ALLOWED_RUNTIMES: readonly string[] = ["runc", "runsc", "sysbox-runc", "kata-runtime"];
/** No volume may be mounted anywhere below these (kernel interfaces, the runner installation). */
export const FORBIDDEN_MOUNT_TREES: readonly string[] = ["/proc", "/sys", "/dev", "/opt/witden"];

export const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Container id or name as accepted on the API. */
export const CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Also used as the backup image tag and directory name, so it must be a valid tag and path segment. */
export const BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const ARCHIVE_ID = /^[0-9]{1,4}\.tar$/;
const RUNTIME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MIN_RUNNER_TOKEN = 16;

// Image references, following the grammar of github.com/distribution/reference.
const DOMAIN_PART = "(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])";
const DOMAIN = `(?:${DOMAIN_PART}(?:\\.${DOMAIN_PART})*|\\[[0-9a-fA-F:]+\\])(?::[0-9]+)?`;
const PATH_PART = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const TAG = "[\\w][\\w.-]{0,127}";
const DIGEST = "[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}";
export const IMAGE_REF = new RegExp(`^(?:${DOMAIN}/)?${PATH_PART}(?:/${PATH_PART})*(?::${TAG})?(?:@${DIGEST})?$`);

const LIMITS = { volumes: 32, env: 256, envValue: 32_768, args: 256, arg: 32_768, paths: 256, path: 4096 };

export interface ValidationOptions {
  allowedRuntimes: readonly string[];
}

function invalid(message: string): never {
  throw new ManagerError("invalid", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string, allowed?: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) invalid(`${what} must be an object`);
  if (allowed) {
    const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
    if (unknown.length) invalid(`${what} has unknown fields: ${unknown.join(", ")}`);
  }
  return value;
}

function hasControlChars(s: string): boolean {
  return /\p{Cc}/u.test(s);
}

function str(value: unknown, what: string, max = 1024): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${what} must be a non-empty string`);
  if (value.length > max) invalid(`${what} is too long`);
  return value;
}

function match(value: unknown, re: RegExp, what: string): string {
  if (typeof value !== "string" || !re.test(value)) invalid(`${what} ${JSON.stringify(value)} is not valid`);
  return value;
}

/** Absolute path without `.`/`..`/empty segments or control characters; a trailing slash is dropped. */
export function normalizeAbsolutePath(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) invalid(`${what} must be an absolute path`);
  if (value.length > LIMITS.path || hasControlChars(value)) invalid(`${what} is not a valid path`);
  const path = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  if (path === "/") return path;
  for (const segment of path.slice(1).split("/")) {
    if (segment === "" || segment === "." || segment === "..") invalid(`${what} ${value} must not contain ., .. or //`);
  }
  return path;
}

/** True for forbidden mounts, anything inside a forbidden tree, and ancestors that would shadow them (`/opt`). */
export function isForbiddenPath(path: string): boolean {
  if (FORBIDDEN_MOUNTS.includes(path)) return true;
  if (FORBIDDEN_MOUNT_TREES.some((tree) => path.startsWith(`${tree}/`))) return true;
  return FORBIDDEN_MOUNTS.some((m) => m !== "/" && m.startsWith(`${path}/`));
}

export function validateImageRef(value: unknown, what = "image"): string {
  const image = str(value, what, 512);
  if (!IMAGE_REF.test(image)) invalid(`${what} ${JSON.stringify(image)} is not a valid image reference`);
  return image;
}

export function validateContainerRef(value: unknown): string {
  return match(value, CONTAINER_REF, "container id");
}

export function validateBackupId(value: unknown): string {
  return match(value, BACKUP_ID, "backup id");
}

export function validateTimeout(value: unknown, fallback = 10): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 600) {
    invalid("timeoutSec must be an integer between 0 and 600");
  }
  return value;
}

export function validateVolumeNames(value: unknown): string[] {
  if (!Array.isArray(value)) invalid("volumes must be an array");
  if (value.length > LIMITS.paths) invalid("too many volumes");
  return [...new Set(value.map((v) => match(v, VOLUME_NAME, "volume name")))];
}

function validateResources(value: unknown): ComputerResources {
  const res = record(value, "resources", Object.keys(RESOURCE_BOUNDS));
  const out: ComputerResources = {};
  for (const [key, [lo, hi]] of Object.entries(RESOURCE_BOUNDS) as [keyof ComputerResources, readonly number[]][]) {
    const v = res[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) invalid(`resource ${key} must be a number`);
    if (key !== "cpus" && !Number.isInteger(v)) invalid(`resource ${key} must be an integer`);
    if (v < lo || v > hi) invalid(`resource ${key} must be between ${lo} and ${hi}`);
    out[key] = v;
  }
  return out;
}

function validateEnv(value: unknown): Record<string, string> {
  const env = record(value, "env");
  const keys = Object.keys(env);
  if (keys.length > LIMITS.env) invalid("too many environment variables");
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (!ENV_KEY.test(key)) invalid(`invalid environment variable name ${JSON.stringify(key)}`);
    if (key.startsWith(RESERVED_ENV_PREFIX)) invalid(`environment variable ${key} is reserved for the platform`);
    const v = env[key];
    if (typeof v !== "string" || v.length > LIMITS.envValue || v.includes("\0")) {
      invalid(`environment variable ${key} must be a string without NUL bytes`);
    }
    out[key] = v;
  }
  return out;
}

function validateVolumes(value: unknown): Record<string, string> {
  const volumes = record(value, "volumes");
  const entries = Object.entries(volumes);
  if (entries.length > LIMITS.volumes) invalid("too many volumes");
  const out: Record<string, string> = {};
  const names = new Set<string>();
  for (const [rawPath, name] of entries) {
    const path = normalizeAbsolutePath(rawPath, "mount path");
    if (isForbiddenPath(path)) invalid(`mount path ${path} is not allowed`);
    if (path in out) invalid(`mount path ${path} is listed twice`);
    const volume = match(name, VOLUME_NAME, "volume name");
    if (names.has(volume)) invalid(`volume ${volume} is mounted twice`);
    names.add(volume);
    out[path] = volume;
  }
  return out;
}

function validateCommand(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) invalid("command must be an array of strings");
  if (value.length > LIMITS.args) invalid("command has too many arguments");
  for (const arg of value) {
    if (typeof arg !== "string" || arg.length > LIMITS.arg || arg.includes("\0")) {
      invalid("command must be an array of strings without NUL bytes");
    }
  }
  return value.length ? [...value] : null;
}

function validateCaps(value: unknown): string[] {
  if (!Array.isArray(value)) invalid("capAdd must be an array");
  const bad = value.filter((c) => typeof c !== "string" || !SAFE_CAPS.includes(c));
  if (bad.length) invalid(`capabilities not allowed: ${bad.map(String).join(", ")}; allowed: ${SAFE_CAPS.join(", ")}`);
  return [...new Set(value as string[])];
}

function validateRuntime(value: unknown, allowed: readonly string[]): string | null {
  if (value === undefined || value === null || value === "") return null;
  const runtime = match(value, RUNTIME_NAME, "runtime");
  if (!allowed.includes(runtime)) invalid(`runtime ${runtime} not allowed; allowed: ${allowed.join(", ") || "none"}`);
  return runtime;
}

function validateRunner(value: unknown): ComputerSpec["runner"] {
  const runner = record(value, "runner", ["token", "hubUrl"]);
  const token = str(runner.token, "runner.token", 512);
  if (token.length < MIN_RUNNER_TOKEN || /\s/.test(token) || hasControlChars(token)) {
    invalid(`runner.token must be at least ${MIN_RUNNER_TOKEN} printable characters without spaces`);
  }
  if (runner.hubUrl === null || runner.hubUrl === undefined) return { token, hubUrl: null };
  const hubUrl = str(runner.hubUrl, "runner.hubUrl", 2048);
  let url: URL;
  try {
    url = new URL(hubUrl);
  } catch {
    invalid("runner.hubUrl must be a URL");
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || /\s/.test(hubUrl)) {
    invalid("runner.hubUrl must be an http(s) or ws(s) URL");
  }
  return { token, hubUrl };
}

const SPEC_FIELDS = [
  "instanceId",
  "name",
  "image",
  "workdir",
  "command",
  "env",
  "volumes",
  "resources",
  "network",
  "capAdd",
  "runtime",
  "runner",
] as const;

/** Returns a normalized copy of the spec or throws `ManagerError("invalid")`. Unknown fields are refused. */
export function validateComputerSpec(value: unknown, options: ValidationOptions): ComputerSpec {
  const spec = record(value, "spec", SPEC_FIELDS);
  const network = spec.network;
  if (typeof network !== "string" || !NETWORK_MODES.includes(network as NetworkMode)) {
    invalid(`network must be one of ${NETWORK_MODES.join(", ")}`);
  }
  return {
    instanceId: match(spec.instanceId, INSTANCE_ID, "instanceId"),
    name: match(spec.name, COMPUTER_NAME, "computer name"),
    image: validateImageRef(spec.image),
    workdir: normalizeAbsolutePath(spec.workdir, "workdir"),
    command: validateCommand(spec.command),
    env: validateEnv(spec.env ?? {}),
    volumes: validateVolumes(spec.volumes ?? {}),
    resources: validateResources(spec.resources ?? {}),
    network: network as NetworkMode,
    capAdd: validateCaps(spec.capAdd ?? []),
    runtime: validateRuntime(spec.runtime, options.allowedRuntimes),
    runner: validateRunner(spec.runner),
  };
}

/** Paths removed (as root) from restored archives and the image layer: never system locations. */
export function validateScrubPaths(value: unknown): string[] {
  if (!Array.isArray(value)) invalid("scrubPaths must be an array");
  if (value.length > LIMITS.paths) invalid("too many scrub paths");
  const out = value.map((p) => {
    const path = normalizeAbsolutePath(p, "scrub path");
    if (isForbiddenPath(path)) invalid(`scrub path ${path} is not allowed`);
    return path;
  });
  return [...new Set(out)];
}

export function validateRemoveRequest(value: unknown): RemoveComputerRequest {
  const req = record(value ?? {}, "remove request", ["volumes", "removeVolumes"]);
  if (req.removeVolumes !== undefined && typeof req.removeVolumes !== "boolean") {
    invalid("removeVolumes must be a boolean");
  }
  return { volumes: validateVolumeNames(req.volumes ?? []), removeVolumes: req.removeVolumes === true };
}

export function validateBackupRequest(value: unknown): BackupRequest {
  const req = record(value, "backup request", ["backupId", "mounts"]);
  if (!Array.isArray(req.mounts)) invalid("mounts must be an array");
  if (req.mounts.length > LIMITS.volumes) invalid("too many mounts");
  const mounts = req.mounts.map((m) => normalizeAbsolutePath(m, "mount path"));
  return { backupId: validateBackupId(req.backupId), mounts: [...new Set(mounts)] };
}

/** The spec is validated with its image replaced by `imageRef`; archives may only target the spec's volumes. */
export function validateRestoreRequest(value: unknown, options: ValidationOptions): RestoreRequest {
  const req = record(value, "restore request", [
    "spec",
    "replaceContainerId",
    "backupId",
    "imageRef",
    "archives",
    "scrubPaths",
  ]);
  const imageRef = validateImageRef(req.imageRef, "imageRef");
  const spec = validateComputerSpec({ ...record(req.spec, "spec"), image: imageRef }, options);
  const archives: Record<string, string> = {};
  for (const [rawMount, id] of Object.entries(record(req.archives ?? {}, "archives"))) {
    const mount = normalizeAbsolutePath(rawMount, "archive mount path");
    if (!(mount in spec.volumes)) invalid(`archive for ${mount} does not match a volume of the computer`);
    archives[mount] = match(id, ARCHIVE_ID, "archive id");
  }
  const replace = req.replaceContainerId;
  return {
    spec,
    replaceContainerId: replace === null || replace === undefined ? null : validateContainerRef(replace),
    backupId: validateBackupId(req.backupId),
    imageRef,
    archives,
    scrubPaths: validateScrubPaths(req.scrubPaths ?? []),
  };
}

/**
 * The runner the computers run, kept up to date by the platform. The platform image carries a runner bundle
 * (/opt/witden/runner-dist, built like the computer images' own copy); the manager installs it into the runner
 * volume (compose: witden-runner, mounted into the manager at RUNNER_LIVE_DIR) and mounts that volume read-only
 * into every computer at the same path, where witden-init prefers it to the image's copy
 * (packages/runner/src/live.ts). A new platform image thus updates the runner of every computer, without new
 * computer images or resets.
 *
 * The volume holds `versions/<version>/` (complete bundles with their manifest.json) and `current`, a relative
 * symbolic link to one of them that is switched atomically. Everything in it is root's and writable by nobody
 * else, which witden-init checks: the manager runs as the same uid as the computers' user, so the installer
 * (`installRunner`, this module run as a script) runs as root with `docker exec` in the manager's own container,
 * like the other fixed root commands (docker-manager.ts, `rootExec`).
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunnerManifest, RUNNER_LIVE_DIR, RUNNER_VERSION_PATTERN, type RunnerManifest } from "@witden/shared";
import type Docker from "dockerode";

export const DEFAULT_RUNNER_BUNDLE = "/opt/witden/runner-dist";
/** Versions kept besides the current one: computers still finishing work on an older one keep it. */
const KEEP_VERSIONS = 3;
/** A version replaced less than this long ago is never removed (runners wait at most 10 minutes to switch). */
const PRUNE_GRACE_MS = 3600_000;
const INSTALLER = fileURLToPath(import.meta.url);

export function readManifest(dir: string): RunnerManifest | null {
  try {
    return parseRunnerManifest(JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")));
  } catch {
    return null;
  }
}

/** The version `current` points to, or null. */
export function currentVersion(liveDir: string): string | null {
  try {
    const target = readlinkSync(path.join(liveDir, "current"));
    const version = path.basename(target);
    return target === path.join("versions", version) && readManifest(path.join(liveDir, target))?.version === version
      ? version
      : null;
  } catch {
    return null;
  }
}

/** Copies a bundle: directories 755, files without group / other write; no links or special files. */
function copyBundle(from: string, to: string): void {
  mkdirSync(to, { mode: 0o755 });
  chmodSync(to, 0o755);
  for (const name of readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const st = lstatSync(src);
    if (st.isDirectory()) copyBundle(src, dst);
    else if (st.isFile()) {
      copyFileSync(src, dst);
      chmodSync(dst, st.mode & 0o755);
    } else throw new Error(`${src}: a runner bundle holds only files and directories`);
  }
}

export interface InstallResult {
  version: string;
  /** The bundle was copied (false: that version was there already). */
  copied: boolean;
  /** `current` was switched to it. */
  switched: boolean;
  /** Versions removed. */
  removed: string[];
}

/**
 * Installs the bundle in `bundleDir` into the runner volume at `liveDir` and makes it current; keeps the
 * previous KEEP_VERSIONS versions and anything replaced less than PRUNE_GRACE_MS ago, removes the rest.
 * Runs as root (see the header); synchronous, one installer at a time (the manager runs it at start).
 */
export function installRunner(
  bundleDir: string,
  liveDir: string,
  options: { keep?: number; graceMs?: number; now?: number } = {},
): InstallResult {
  const { keep = KEEP_VERSIONS, graceMs = PRUNE_GRACE_MS, now = Date.now() } = options;
  const manifest = readManifest(bundleDir);
  if (!manifest) throw new Error(`${bundleDir} holds no runner bundle (manifest.json missing or invalid)`);
  const { version } = manifest;
  const versions = path.join(liveDir, "versions");
  mkdirSync(versions, { recursive: true, mode: 0o755 });
  chmodSync(liveDir, 0o755);
  chmodSync(versions, 0o755);
  const dir = path.join(versions, version);
  const stamp = randomBytes(4).toString("hex");

  // Copied next to its place and renamed into it: a version directory is complete or absent.
  let copied = false;
  if (readManifest(dir)?.version !== version) {
    rmSync(dir, { recursive: true, force: true });
    const tmp = path.join(versions, `.${version}-${stamp}`);
    try {
      copyBundle(bundleDir, tmp);
      renameSync(tmp, dir);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    copied = true;
  }

  // The link is replaced by a rename, so `current` always points to a complete version.
  let switched = false;
  if (currentVersion(liveDir) !== version) {
    const link = path.join(liveDir, `.current-${stamp}`);
    symlinkSync(path.join("versions", version), link);
    renameSync(link, path.join(liveDir, "current"));
    // A version's mtime is when it last became current (pruning below goes by it).
    utimesSync(dir, now / 1000, now / 1000);
    switched = true;
  }

  // Leftovers of an installer that stopped halfway.
  for (const name of readdirSync(liveDir)) if (name.startsWith(".current-")) rmSync(path.join(liveDir, name));
  const removed: string[] = [];
  const known: { name: string; at: number }[] = [];
  for (const name of readdirSync(versions)) {
    if (RUNNER_VERSION_PATTERN.test(name)) known.push({ name, at: lstatSync(path.join(versions, name)).mtimeMs });
    else if (name.startsWith(".")) rmSync(path.join(versions, name), { recursive: true, force: true });
  }
  // Newest first: each version stopped being current when the one before it in this order became current.
  known.sort((a, b) => b.at - a.at);
  for (const [i, v] of known.entries()) {
    if (v.name === version || i <= keep) continue;
    if (now - known[i - 1].at < graceMs) continue;
    rmSync(path.join(versions, v.name), { recursive: true, force: true });
    removed.push(v.name);
  }
  return { version, copied, switched, removed };
}

/** This process's container id: Docker mounts /etc/hostname from the container's own directory. */
export function ownContainerId(mountinfo: string): string | null {
  for (const line of mountinfo.split("\n")) {
    const [, , , root, mountPoint] = line.split(" ");
    if (mountPoint !== "/etc/hostname") continue;
    const m = /\/containers\/([0-9a-f]{64})\/hostname$/.exec(root ?? "");
    if (m) return m[1];
  }
  return null;
}

export type RootExec = (container: Docker.Container, cmd: string[]) => Promise<{ code: number; output: string }>;

export interface LiveRunnerOptions {
  /** The bundle to install (the platform image's). */
  bundleDir?: string;
  /** Where the runner volume is mounted in the manager (and in the computers). */
  liveDir?: string;
  /** Runs a fixed command as root in a container (`rootExec`). */
  exec: RootExec;
  /** Default: /proc/self/mountinfo, then the host name (tests replace them). */
  mountinfo?: () => string;
  hostname?: () => string;
}

export interface LiveRunnerStatus {
  /** The runner volume computers get; null when this manager has none (not in a container, or not mounted). */
  volume: string | null;
  /** The version in the volume now. */
  version: string | null;
  install?: InstallResult;
  /** Why the platform's runner is not (or not newly) available. */
  problem?: string;
  /** Docker could not be asked: looked for again when the next computer is created. */
  retry?: boolean;
}

/**
 * Finds the runner volume in the manager's own container and installs the bundle into it when its version is
 * not current. Done once; looking for the volume again after Docker could not be asked.
 */
export class LiveRunner {
  private setup: Promise<LiveRunnerStatus> | null = null;
  private readonly bundleDir: string;
  private readonly liveDir: string;

  constructor(
    private readonly docker: Docker,
    private readonly options: LiveRunnerOptions,
  ) {
    this.bundleDir = options.bundleDir ?? DEFAULT_RUNNER_BUNDLE;
    this.liveDir = options.liveDir ?? RUNNER_LIVE_DIR;
  }

  setUp(): Promise<LiveRunnerStatus> {
    this.setup ??= this.run().catch((err) => {
      this.setup = null;
      const problem = `cannot look for the runner volume: ${String(err?.message ?? err)}`;
      return { volume: null, version: null, problem, retry: true };
    });
    return this.setup;
  }

  async volume(): Promise<string | null> {
    return (await this.setUp()).volume;
  }

  private async ownContainer(): Promise<{ container: Docker.Container; info: Docker.ContainerInspectInfo } | null> {
    let mountinfo = "";
    try {
      mountinfo = this.options.mountinfo ? this.options.mountinfo() : readFileSync("/proc/self/mountinfo", "utf8");
    } catch {
      // not Linux
    }
    const refs = [ownContainerId(mountinfo), this.options.hostname ? this.options.hostname() : os.hostname()];
    for (const ref of refs) {
      if (!ref) continue;
      const container = this.docker.getContainer(ref);
      try {
        return { container, info: await container.inspect() };
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
      }
    }
    return null;
  }

  private async run(): Promise<LiveRunnerStatus> {
    const self = await this.ownContainer();
    const mount = self?.info.Mounts?.find((m) => m.Type === "volume" && m.Destination === this.liveDir && m.Name);
    if (!self || !mount?.Name)
      return { volume: null, version: null, problem: `no runner volume is mounted at ${this.liveDir}` };
    const volume = mount.Name;
    const bundle = readManifest(this.bundleDir);
    if (!bundle)
      return { volume, version: currentVersion(this.liveDir), problem: `no runner bundle in ${this.bundleDir}` };
    if (currentVersion(this.liveDir) === bundle.version) return { volume, version: bundle.version };
    const { code, output } = await this.options.exec(self.container, [
      process.execPath,
      INSTALLER,
      this.bundleDir,
      this.liveDir,
    ]);
    const version = currentVersion(this.liveDir);
    if (code !== 0)
      return { volume, version, problem: `runner install failed (exit ${code}): ${output.trim().slice(-500)}` };
    let install: InstallResult | undefined;
    try {
      install = JSON.parse(output.trim().split("\n").pop() ?? "");
    } catch {
      // reported below by the version check
    }
    return version === bundle.version
      ? { volume, version, install }
      : { volume, version, problem: `the runner volume still holds ${version ?? "nothing"} after the install` };
  }
}

// As a script (root, see the header): node live-runner.js <bundle dir> <runner volume dir>
if (process.argv[1] && INSTALLER === path.resolve(process.argv[1])) {
  const [bundleDir, liveDir] = process.argv.slice(2);
  if (process.getuid?.() !== 0) {
    console.error("the runner installer runs as root: the runner volume holds root's files only");
    process.exit(1);
  }
  if (!bundleDir || !liveDir || !path.isAbsolute(bundleDir) || !path.isAbsolute(liveDir)) {
    console.error("usage: live-runner.js <bundle dir> <runner volume dir> (absolute paths)");
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(installRunner(bundleDir, liveDir))}\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

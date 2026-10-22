/**
 * Which runner witden-init starts (init.ts). The image carries its own copy in /opt/witden/runner; the platform
 * may also keep one up to date in RUNNER_LIVE_DIR, a volume the Docker Manager mounts read-only into the
 * computer and fills as root (packages/manager/src/live-runner.ts). witden-init prefers the platform's copy when
 * its manifest says it runs here and nothing in the computer can have changed it, so a platform update reaches
 * every computer without new images; anything else falls back to the image's copy.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunnerManifest, RUNNER_LIVE_DIR, type RunnerBuild, type RunnerManifest } from "@witden/shared";

/**
 * What this witden-init offers a runner; a bundle's manifest names the lowest protocol it needs. Raise it when a
 * runner comes to rely on something new from the init. Protocol 1: the runner is started as
 * `node <bundle>/witden-runner.mjs [--stdio]` from the execute-only node with `runnerEnv` (HOME its bundle
 * directory, the user's home in WITDEN_HOME); UPDATE_SIGNAL asks it to exit once idle because another version
 * is ready, and exit status RESTART_NOW has it started again at once, the version picked anew.
 */
export const INIT_PROTOCOL = 1;
export const RESTART_NOW = 75;
export const UPDATE_SIGNAL = "SIGUSR2";

export interface PickedRunner {
  /** The bundle directory (real path), with witden-runner.mjs in it. */
  dir: string;
  source: "live" | "image";
  /** From the bundle's manifest; null for an image copy without one. */
  version: string | null;
}

export interface PickOptions {
  liveDir?: string;
  /** Who must own the platform's copy (root; tests use their own uid). */
  owner?: number;
  nodeMajor?: number;
  /** A platform version not to use (it kept failing, see init.ts). */
  avoid?: string | null;
}

export function readManifest(dir: string): RunnerManifest | null {
  try {
    return parseRunnerManifest(JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")));
  } catch {
    return null;
  }
}

/** Owned by `owner` and writable by nobody else; symbolic links and special files do not qualify. */
function sealedEntry(file: string, owner: number): "dir" | "file" | null {
  const st = lstatSync(file);
  if (st.uid !== owner || st.mode & 0o022) return null;
  return st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
}

/** True when `dir` and everything below it is sealed (see `sealedEntry`). */
function sealedTree(dir: string, owner: number): boolean {
  if (sealedEntry(dir, owner) !== "dir") return false;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const kind = sealedEntry(file, owner);
    if (!kind || (kind === "dir" && !sealedTree(file, owner))) return false;
  }
  return true;
}

/** The platform's copy, when present, compatible and sealed; else null. */
export function liveRunner(options: PickOptions = {}): PickedRunner | null {
  const { liveDir = RUNNER_LIVE_DIR, owner = 0, avoid = null } = options;
  const nodeMajor = options.nodeMajor ?? Number(process.versions.node.split(".")[0]);
  try {
    const root = realpathSync(liveDir);
    const versions = path.join(root, "versions");
    const dir = realpathSync(path.join(root, "current"));
    // The code the runner loads, and the directories that decide which code that is.
    if (path.dirname(dir) !== versions) return null;
    if (sealedEntry(root, owner) !== "dir" || sealedEntry(versions, owner) !== "dir") return null;
    const manifest = readManifest(dir);
    if (!manifest || manifest.version !== path.basename(dir) || manifest.version === avoid) return null;
    if (manifest.node > nodeMajor || manifest.init > INIT_PROTOCOL) return null;
    if (sealedEntry(path.join(dir, "witden-runner.mjs"), owner) !== "file" || !sealedTree(dir, owner)) return null;
    return { dir, source: "live", version: manifest.version };
  } catch {
    return null; // no such volume in this computer, or nothing installed yet
  }
}

/** The runner to start: the platform's copy when usable, else the image's (`imageDir`). */
export function pickRunner(imageDir: string, options: PickOptions = {}): PickedRunner {
  return liveRunner(options) ?? { dir: imageDir, source: "image", version: readManifest(imageDir)?.version ?? null };
}

/** Whether two picks run the same code (the same version, wherever it lies). */
export function sameRunner(a: PickedRunner, b: PickedRunner): boolean {
  return a.version !== null || b.version !== null ? a.version === b.version : a.dir === b.dir;
}

/** The bundle this code runs from, as reported to the platform; undefined when not run from a bundle (tests). */
export function runnerBuild(file = fileURLToPath(import.meta.url), liveDir = RUNNER_LIVE_DIR): RunnerBuild | undefined {
  const dir = path.dirname(file);
  const manifest = readManifest(dir);
  if (!manifest) return undefined;
  return { version: manifest.version, source: dir.startsWith(`${liveDir}/`) ? "live" : "image" };
}

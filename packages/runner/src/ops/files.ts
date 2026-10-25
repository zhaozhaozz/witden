import type { Stats } from "node:fs";
import { appendFile, chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  FileEntry,
  FileReadResult,
  FileRemoveResult,
  FileTreeEntry,
  FileTreeResult,
  FileWriteResult,
} from "@witden/shared";
import type { Env } from "../context.js";
import { OpError } from "../errors.js";
import { optBool, optInt, reqString } from "../params.js";
import { resolveUserPath } from "../util.js";

const DEFAULT_READ_MAX = 2 * 1024 * 1024;
const MAX_READ_MAX = 64 * 1024 * 1024;
const MAX_WRITE = 64 * 1024 * 1024;
const MAX_LIST = 5000;

function typeOf(st: Stats): FileEntry["type"] {
  if (st.isSymbolicLink()) return "link";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

/** Files are accessed with the runner user's own rights, so the computer's permissions apply. */
export class Files {
  constructor(private readonly env: Env) {}

  private resolve(params: Record<string, unknown>, key: string): string {
    const value = reqString(params, key, 4096);
    if (!value) throw new OpError("invalid", `params.${key} is empty`);
    return resolveUserPath(value, this.env.workdir, this.env.home);
  }

  async read(params: Record<string, unknown>): Promise<FileReadResult> {
    const file = this.resolve(params, "path");
    const maxBytes = optInt(params, "maxBytes", 0, MAX_READ_MAX) ?? DEFAULT_READ_MAX;
    const st = await stat(file);
    if (st.isDirectory()) throw new OpError("invalid", `${file} is a directory`);
    if (st.size > maxBytes)
      throw new OpError("invalid", `${file} is ${st.size} bytes, larger than maxBytes (${maxBytes})`);
    const data = await readFile(file);
    // Files in /proc and similar report size 0.
    if (data.length > maxBytes) throw new OpError("invalid", `${file} is larger than maxBytes (${maxBytes})`);
    return { path: file, size: data.length, contentBase64: data.toString("base64") };
  }

  async write(params: Record<string, unknown>): Promise<FileWriteResult> {
    const file = this.resolve(params, "path");
    const encoded = reqString(params, "contentBase64", Math.ceil((MAX_WRITE * 4) / 3) + 4);
    const append = optBool(params, "append") ?? false;
    const mode = optInt(params, "mode", 0, 0o777);
    const data = Buffer.from(encoded, "base64");
    await mkdir(path.dirname(file), { recursive: true });
    if (append) await appendFile(file, data);
    else await writeFile(file, data);
    // writeFile keeps an existing file's mode, so the bits are set explicitly.
    if (mode !== undefined) await chmod(file, mode);
    return { path: file, size: (await stat(file)).size };
  }

  /** A directory's regular files at any depth; symbolic links are reported, never followed. */
  async tree(params: Record<string, unknown>): Promise<FileTreeResult> {
    const root = this.resolve(params, "path");
    const raw = params.exclude ?? [];
    if (!Array.isArray(raw) || raw.some((n) => typeof n !== "string"))
      throw new OpError("invalid", "params.exclude must be a list of names");
    const exclude = new Set(raw as string[]);
    if (!(await stat(root)).isDirectory()) throw new OpError("invalid", `${root} is not a directory`);
    const files: FileTreeEntry[] = [];
    const skipped: FileTreeResult["skipped"] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const name of (await readdir(dir)).sort()) {
        if (exclude.has(name)) continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        let st: Stats;
        try {
          st = await lstat(path.join(dir, name));
        } catch {
          continue; // removed meanwhile
        }
        if (st.isDirectory()) await walk(path.join(dir, name), rel);
        else if (st.isFile())
          files.push({ path: rel, size: st.size, mode: (st.mode & 0o7777).toString(8).padStart(4, "0") });
        else skipped.push({ path: rel, type: typeOf(st) });
      }
    };
    await walk(root, "");
    return { path: root, files, skipped };
  }

  /** A file, or a directory with everything in it; nothing there is not an error. */
  async remove(params: Record<string, unknown>): Promise<FileRemoveResult> {
    const target = this.resolve(params, "path");
    // A slip in a path must not empty the computer.
    if (target === path.parse(target).root || target === this.env.home || target === this.env.workdir)
      throw new OpError("invalid", `refusing to remove ${target}`);
    const there = await lstat(target).then(
      () => true,
      () => false,
    );
    await rm(target, { recursive: true, force: true });
    return { path: target, removed: there };
  }

  async list(params: Record<string, unknown>): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
    const dir = this.resolve(params, "path");
    const names = (await readdir(dir)).sort();
    const entries: FileEntry[] = [];
    for (const name of names.slice(0, MAX_LIST)) {
      try {
        const st = await lstat(path.join(dir, name));
        entries.push({ name, type: typeOf(st), size: st.size, mtime: st.mtime.toISOString() });
      } catch {
        // removed meanwhile
      }
    }
    return { path: dir, entries, truncated: names.length > MAX_LIST };
  }

  async move(params: Record<string, unknown>): Promise<{ from: string; to: string }> {
    const from = this.resolve(params, "from");
    const to = this.resolve(params, "to");
    await lstat(from);
    await mkdir(path.dirname(to), { recursive: true });
    try {
      await rename(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      await rm(from, { recursive: true, force: true });
    }
    return { from, to };
  }

  async stat(params: Record<string, unknown>): Promise<FileEntry & { path: string; mode: string; uid: number }> {
    const file = this.resolve(params, "path");
    const st = await lstat(file);
    return {
      path: file,
      name: path.basename(file),
      type: typeOf(st),
      size: st.size,
      mtime: st.mtime.toISOString(),
      mode: (st.mode & 0o7777).toString(8).padStart(4, "0"),
      uid: st.uid,
    };
  }
}

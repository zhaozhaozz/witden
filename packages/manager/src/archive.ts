import { createReadStream, createWriteStream } from "node:fs";
import { posix } from "node:path";
import tar from "tar-stream";

/** True when `path` is one of `scrubPaths` or lies below one of them. */
export function isScrubbed(path: string, scrubPaths: readonly string[]): boolean {
  return scrubPaths.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Absolute path of a tar entry that will be extracted into `parent` (Docker archives are relative to it). */
function entryPath(parent: string, name: string): string {
  const rel = name.replace(/^(\.\/|\/)+/, "").replace(/\/+$/, "");
  return posix.join(parent, rel);
}

/**
 * Copies the tar archive `src` to `dst` without the entries under `scrubPaths`. `parent` is the directory the
 * archive is extracted into, so `parent + entry.name` is the entry's absolute path inside the computer. Hard links
 * pointing at a scrubbed file are dropped too, otherwise they would carry its content along.
 */
export async function filterArchive(
  src: string,
  dst: string,
  parent: string,
  scrubPaths: readonly string[],
): Promise<{ kept: number; dropped: number }> {
  const extract = tar.extract();
  const pack = tar.pack();
  const input = createReadStream(src);
  const output = createWriteStream(dst, { flags: "wx", mode: 0o600 });
  let kept = 0;
  let dropped = 0;

  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      input.destroy();
      extract.destroy();
      pack.destroy();
      output.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    extract.on("entry", (header, stream, next) => {
      const drop =
        isScrubbed(entryPath(parent, header.name), scrubPaths) ||
        (header.type === "link" && !!header.linkname && isScrubbed(entryPath(parent, header.linkname), scrubPaths));
      if (drop) {
        dropped++;
        stream.on("end", () => next());
        stream.resume();
        return;
      }
      kept++;
      stream.pipe(pack.entry({ ...header }, (err) => (err ? fail(err) : next())));
    });
    extract.on("finish", () => pack.finalize());
    input.on("error", fail);
    extract.on("error", fail);
    pack.on("error", fail);
    output.on("error", fail);
    output.on("close", () => (failed ? undefined : resolve()));
    pack.pipe(output);
    input.pipe(extract);
  });
  return { kept, dropped };
}

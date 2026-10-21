import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type Artifact, artifacts } from "../db/schema.js";

const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export function safeName(name: string): string {
  const base = name.trim().split("/").pop() ?? "file";
  return (base.replace(/[^A-Za-z0-9._\- 一-鿿]+/g, "_") || "file").slice(0, 200);
}

export const filesDir = () => path.join(settings().dataDir, "files");
export const artifactPath = (art: Artifact) => path.join(filesDir(), art.storageKey);

/** A file streamed into the data directory, not yet an artifact: saveArtifact moves it into place. */
export interface StagedFile {
  path: string;
  size: number;
  sha256: string;
}

/**
 * Write bytes as they arrive (a download) to a file next to the stored ones, hashing them on the way, so a file
 * of any size needs disk space rather than memory. Throws (leaving nothing behind) when the source fails.
 */
export async function stageFile(source: AsyncIterable<Uint8Array>): Promise<StagedFile> {
  const dir = path.join(filesDir(), ".incoming");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, randomUUID());
  const hash = createHash("sha256");
  let size = 0;
  async function* counted() {
    for await (const chunk of source) {
      hash.update(chunk);
      size += chunk.length;
      yield chunk;
    }
  }
  try {
    await pipeline(Readable.from(counted()), fs.createWriteStream(file));
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  return { path: file, size, sha256: hash.digest("hex") };
}

/** Remove a staged file that did not become an artifact (nothing happens if it did). */
export function discardStaged(staged: StagedFile): void {
  fs.rmSync(staged.path, { force: true });
}

export async function saveArtifact(
  db: Db,
  data: Buffer | StagedFile,
  opts: {
    name: string;
    kind: string;
    topicId?: string | null;
    taskId?: string | null;
    instanceId?: string | null;
    createdByType?: string;
    createdById?: string | null;
    mime?: string | null;
  },
): Promise<Artifact> {
  const id = newId("file");
  const storageKey = `${id.slice(-2)}/${id}`;
  const file = path.join(filesDir(), storageKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size: number;
  let sha256: string;
  if (Buffer.isBuffer(data)) {
    fs.writeFileSync(file, data);
    size = data.length;
    sha256 = createHash("sha256").update(data).digest("hex");
  } else {
    // A staged file is in the same directory tree: moving it is a rename.
    fs.renameSync(data.path, file);
    ({ size, sha256 } = data);
  }
  const [art] = await db
    .insert(artifacts)
    .values({
      id,
      name: safeName(opts.name),
      mime: opts.mime || MIME[path.extname(opts.name).toLowerCase()] || "application/octet-stream",
      size,
      sha256,
      storageKey,
      kind: opts.kind,
      topicId: opts.topicId ?? null,
      taskId: opts.taskId ?? null,
      instanceId: opts.instanceId ?? null,
      createdByType: opts.createdByType ?? "user",
      createdById: opts.createdById ?? null,
    })
    .returning();
  return art;
}

export function deleteArtifactData(art: Artifact): void {
  fs.rmSync(artifactPath(art), { force: true });
}

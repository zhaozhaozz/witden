import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

export async function saveArtifact(
  db: Db,
  data: Buffer,
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
  fs.writeFileSync(file, data);
  const [art] = await db
    .insert(artifacts)
    .values({
      id,
      name: safeName(opts.name),
      mime: opts.mime || MIME[path.extname(opts.name).toLowerCase()] || "application/octet-stream",
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
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

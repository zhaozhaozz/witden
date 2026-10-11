import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { OpError } from "./errors.js";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves a user supplied path: "~" is the home directory, relative paths are relative to the workdir. */
export function resolveUserPath(input: string, workdir: string, home: string): string {
  if (input.includes("\0")) throw new OpError("invalid", "path contains a NUL byte");
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return path.resolve(workdir, input);
}

/** Looks a binary up in PATH (or checks an explicit path). */
export function which(bin: string, envPath = process.env.PATH ?? ""): string | null {
  const candidates = bin.includes("/") ? [bin] : envPath.split(":").map((dir) => path.join(dir || ".", bin));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Width/height from a PNG's IHDR chunk. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Keeps the newest bytes up to a fixed capacity. */
export class ByteRing {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly capacity: number) {}

  push(chunk: Buffer): void {
    if (chunk.length >= this.capacity) {
      this.chunks = [Buffer.from(chunk.subarray(chunk.length - this.capacity))];
      this.size = this.capacity;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.capacity) {
      const first = this.chunks[0];
      const excess = this.size - this.capacity;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  get length(): number {
    return this.size;
  }

  toBuffer(maxBytes = this.capacity): Buffer {
    const all = Buffer.concat(this.chunks, this.size);
    return all.length > maxBytes ? all.subarray(all.length - maxBytes) : all;
  }
}

import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tar from "tar-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { filterArchive, isScrubbed } from "../src/archive.js";
import { RelayChannel, StdoutDemuxer } from "../src/channel.js";
import { computeStats } from "../src/docker-manager.js";

const scratch = path.resolve(
  fileURLToPath(new URL("../../../.tmp/manager", import.meta.url)),
  `archive-${randomBytes(4).toString("hex")}`,
);

type Entry = { name: string; type?: "file" | "directory" | "link" | "symlink"; body?: string; linkname?: string };

async function writeTar(file: string, entries: Entry[]): Promise<void> {
  const pack = tar.pack();
  const done = new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    out.on("close", resolve);
    out.on("error", reject);
    pack.pipe(out);
  });
  for (const e of entries) pack.entry({ name: e.name, type: e.type ?? "file", linkname: e.linkname }, e.body ?? "");
  pack.finalize();
  await done;
}

async function readTar(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const extract = tar.extract();
  createReadStream(file).pipe(extract);
  for await (const entry of extract) {
    const chunks: Buffer[] = [];
    for await (const c of entry) chunks.push(c as Buffer);
    out[entry.header.name] =
      entry.header.type === "file" ? Buffer.concat(chunks).toString() : String(entry.header.type);
  }
  return out;
}

beforeAll(async () => {
  await mkdir(scratch, { recursive: true });
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("filterArchive", () => {
  it("drops scrubbed paths and hard links to them, keeps everything else", async () => {
    // Shaped like `docker cp` of /home/witden: entries are relative to the parent directory /home.
    const src = path.join(scratch, "src.tar");
    const dst = path.join(scratch, "dst.tar");
    await writeTar(src, [
      { name: "witden/", type: "directory" },
      { name: "witden/notes.txt", body: "keep me" },
      { name: "witden/.ssh/", type: "directory" },
      { name: "witden/.ssh/id", body: "SECRET" },
      { name: "witden/.ssh-backup", body: "not a prefix match" },
      { name: "witden/leak", type: "link", linkname: "witden/.ssh/id" },
      { name: "witden/link-to-ssh", type: "symlink", linkname: ".ssh/id" },
      { name: "witden/.config/gh/hosts.yml", body: "token" },
    ]);
    const result = await filterArchive(src, dst, "/home", ["/home/witden/.ssh", "/home/witden/.config/gh"]);
    expect(result).toEqual({ kept: 4, dropped: 4 });
    expect(await readTar(dst)).toEqual({
      "witden/": "directory",
      "witden/notes.txt": "keep me",
      "witden/.ssh-backup": "not a prefix match",
      "witden/link-to-ssh": "symlink",
    });
  });

  it("matches scrub paths against the extraction parent", () => {
    expect(isScrubbed("/home/witden/.ssh/id", ["/home/witden/.ssh"])).toBe(true);
    expect(isScrubbed("/home/witden/.ssh", ["/home/witden/.ssh"])).toBe(true);
    expect(isScrubbed("/home/witden/.sshx", ["/home/witden/.ssh"])).toBe(false);
  });
});

describe("StdoutDemuxer", () => {
  it("returns stdout payloads only, across chunk boundaries", () => {
    const frame = (stream: number, text: string) => {
      const payload = Buffer.from(text);
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const all = Buffer.concat([frame(1, "hello "), frame(2, "noise"), frame(1, "world")]);
    const demux = new StdoutDemuxer();
    const out: string[] = [];
    for (let i = 0; i < all.length; i += 3) {
      for (const p of demux.push(all.subarray(i, i + 3))) out.push(Buffer.from(p).toString());
    }
    expect(out.join("")).toBe("hello world");
  });
});

describe("RelayChannel", () => {
  it("buffers data and close events until listeners are attached", () => {
    const sent: Uint8Array[] = [];
    let closed = 0;
    const channel = new RelayChannel({ send: (d) => sent.push(d), close: () => closed++ });
    channel.emitData(new Uint8Array([1]));
    channel.emitData(new Uint8Array([2]));
    const got: number[] = [];
    channel.onData((d) => got.push(...d));
    expect(got).toEqual([1, 2]);
    channel.send(new Uint8Array([3]));
    channel.emitClose("runner exited with code 0");
    channel.send(new Uint8Array([4]));
    let reason = "";
    channel.onClose((r) => {
      reason = r;
    });
    expect(reason).toBe("runner exited with code 0");
    expect(sent).toHaveLength(1);
    channel.close();
    expect(closed).toBe(0);
  });
});

describe("computeStats", () => {
  it("uses the docker stats arithmetic", () => {
    const stats = computeStats({
      cpu_stats: { cpu_usage: { total_usage: 3_000 }, system_cpu_usage: 20_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
      memory_stats: { usage: 5_000, limit: 10_000, stats: { inactive_file: 1_000 } },
      networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 1, tx_bytes: 2 } },
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: "read", value: 7 },
          { op: "Write", value: 9 },
          { op: "read", value: 3 },
        ],
      },
      pids_stats: { current: 12 },
    });
    expect(stats).toEqual({
      cpuPercent: 80,
      memoryBytes: 4_000,
      memoryLimitBytes: 10_000,
      netRxBytes: 11,
      netTxBytes: 22,
      blockReadBytes: 10,
      blockWriteBytes: 9,
      pids: 12,
    });
  });
});

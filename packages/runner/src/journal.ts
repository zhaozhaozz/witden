import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { JournalGetResult, ResponseMessage } from "@witden/shared";
import type { Logger } from "./log.js";
import { isAlive, selfStat } from "./proc.js";
import { randomHex } from "./util.js";

/** Responses bigger than this are kept in a compacted form (large strings dropped). */
const MAX_ENTRY_BYTES = 128 * 1024;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const COMPACT_STRING_BYTES = 16 * 1024;

type EntryState = "running" | "completed" | "interrupted";

interface Owner {
  boot: string;
  pid: number;
  pst: string;
}

export interface JournalEntry {
  id: string;
  op: string;
  state: EntryState;
  owner: Owner;
  response?: ResponseMessage;
  /** The stored response lost large fields; read-only ops are re-executed instead of replayed. */
  compacted: boolean;
  bytes: number;
}

interface StartRecord {
  k: "start";
  id: string;
  op: string;
  at: number;
  boot: string;
  pid: number;
  pst: string;
}
interface DoneRecord {
  k: "done";
  id: string;
  op: string;
  at: number;
  r: ResponseMessage;
  c?: boolean;
}
type JournalRecord = StartRecord | DoneRecord;

export function interruptedResponse(id: string): ResponseMessage {
  return {
    type: "response",
    id,
    ok: false,
    error: {
      code: "failed",
      message: "the runner stopped while this request was running; its outcome is uncertain",
    },
  };
}

function compact(response: ResponseMessage): { response: ResponseMessage; compacted: boolean; bytes: number } {
  const bytes = JSON.stringify(response).length;
  if (bytes <= MAX_ENTRY_BYTES) return { response, compacted: false, bytes };
  const result: Record<string, unknown> =
    response.result && typeof response.result === "object" && !Array.isArray(response.result)
      ? { ...(response.result as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "string" && value.length > COMPACT_STRING_BYTES) {
      result[key] = key.endsWith("Base64") ? "" : value.slice(0, COMPACT_STRING_BYTES);
      if ("truncated" in result) result.truncated = true;
    } else if (value && typeof value === "object" && JSON.stringify(value).length > COMPACT_STRING_BYTES) {
      result[key] = Array.isArray(value) ? [] : {};
    }
  }
  result.journalCompacted = true;
  const small: ResponseMessage = { ...response, result };
  return { response: small, compacted: true, bytes: JSON.stringify(small).length };
}

/**
 * Request journal: the state of every request (running, or completed with its response), kept in memory and
 * appended to `<stateDir>/journal.jsonl` so a restarted runner can still answer `journal.get` and refuse to run a
 * request id twice. The file is rotated once (journal.jsonl.1) when it grows past `maxFileBytes`.
 */
export class Journal {
  private readonly entries = new Map<string, JournalEntry>();
  private memoryBytes = 0;
  private readonly file: string;
  private readonly rotated: string;
  private readonly owner: Owner;
  private fileIno = -1;
  private fileOffset = 0;

  constructor(private readonly options: { dir: string; maxEntries: number; maxFileBytes: number; logger: Logger }) {
    this.file = path.join(options.dir, "journal.jsonl");
    this.rotated = `${this.file}.1`;
    this.owner = { boot: randomHex(8), pid: process.pid, pst: selfStat()?.startTime ?? "" };
  }

  load(): void {
    this.sync();
    for (const entry of this.entries.values()) this.settleForeign(entry);
    this.evict();
  }

  /** Looks an id up; ids unknown in memory or run by another runner process are refreshed from disk. */
  lookup(id: string): JournalEntry | undefined {
    const entry = this.entries.get(id);
    if (entry && (entry.state !== "running" || entry.owner.boot === this.owner.boot)) return entry;
    this.sync();
    const fresh = this.entries.get(id);
    if (fresh) this.settleForeign(fresh);
    return fresh;
  }

  start(id: string, op: string): void {
    this.set({ id, op, state: "running", owner: this.owner, compacted: false, bytes: 0 });
    this.append({ k: "start", id, op, at: Date.now(), ...this.owner });
  }

  complete(id: string, op: string, response: ResponseMessage): void {
    const { response: stored, compacted, bytes } = compact(response);
    this.set({ id, op, state: "completed", owner: this.owner, response: stored, compacted, bytes });
    this.append({ k: "done", id, op, at: Date.now(), r: stored, ...(compacted ? { c: true } : {}) });
  }

  get(id: string): JournalGetResult {
    const entry = this.lookup(id);
    if (!entry) return { state: "unknown" };
    if (entry.state === "running") return { state: "running" };
    if (entry.state === "interrupted") return { state: "unknown", response: interruptedResponse(id) };
    return { state: "completed", response: entry.response };
  }

  private set(entry: JournalEntry): void {
    const old = this.entries.get(entry.id);
    if (old) {
      this.memoryBytes -= old.bytes;
      this.entries.delete(entry.id);
    }
    this.entries.set(entry.id, entry);
    this.memoryBytes += entry.bytes;
    this.evict();
  }

  private evict(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.options.maxEntries && this.memoryBytes <= MAX_MEMORY_BYTES) break;
      if (entry.state === "running" && entry.owner.boot === this.owner.boot) continue;
      this.entries.delete(id);
      this.memoryBytes -= entry.bytes;
    }
  }

  /** A request started by another runner process is still running only if that process still is. */
  private settleForeign(entry: JournalEntry): void {
    if (entry.state !== "running" || entry.owner.boot === this.owner.boot) return;
    if (!isAlive(entry.owner.pid, entry.owner.pst)) entry.state = "interrupted";
  }

  private apply(record: JournalRecord): void {
    if (record.k === "start") {
      const owner = { boot: record.boot, pid: record.pid, pst: record.pst };
      this.set({ id: record.id, op: record.op, state: "running", owner, compacted: false, bytes: 0 });
    } else if (record.k === "done") {
      const owner = this.entries.get(record.id)?.owner ?? { boot: "", pid: 0, pst: "" };
      const bytes = JSON.stringify(record.r).length;
      this.set({
        id: record.id,
        op: record.op,
        state: "completed",
        owner,
        response: record.r,
        compacted: !!record.c,
        bytes,
      });
    }
  }

  /**
   * Applies records appended since the last sync (by this or another runner process sharing the state dir,
   * e.g. a --stdio runner next to the main one). Re-reads everything after a rotation.
   */
  private sync(): void {
    let st: { ino: number; size: number };
    try {
      st = statSync(this.file);
    } catch {
      return;
    }
    if (st.ino !== this.fileIno) {
      this.fileIno = st.ino;
      this.fileOffset = 0;
      for (const record of this.parse(this.readFrom(this.rotated, 0).text)) this.apply(record);
    }
    if (st.size <= this.fileOffset) return;
    const { text, consumed } = this.readFrom(this.file, this.fileOffset);
    this.fileOffset += consumed;
    for (const record of this.parse(text)) this.apply(record);
  }

  /** Reads complete lines from an offset. */
  private readFrom(file: string, offset: number): { text: string; consumed: number } {
    let buf: Buffer;
    try {
      const fd = openSync(file, "r");
      try {
        const size = fstatSync(fd).size;
        buf = Buffer.alloc(Math.max(0, size - offset));
        let read = 0;
        while (read < buf.length) {
          const n = readSync(fd, buf, read, buf.length - read, offset + read);
          if (n <= 0) break;
          read += n;
        }
        buf = buf.subarray(0, read);
      } finally {
        closeSync(fd);
      }
    } catch {
      return { text: "", consumed: 0 };
    }
    const end = buf.lastIndexOf(0x0a) + 1;
    return { text: buf.subarray(0, end).toString("utf8"), consumed: end };
  }

  private parse(text: string): JournalRecord[] {
    const records: JournalRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as JournalRecord;
        if (record && typeof record.id === "string") records.push(record);
      } catch {
        // torn write from a crash
      }
    }
    return records;
  }

  private append(record: JournalRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    try {
      if (!existsSync(this.options.dir)) mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = statSync(this.file).size;
      } catch {
        // new file
      }
      if (size > 0 && size + line.length > this.options.maxFileBytes) renameSync(this.file, this.rotated);
      appendFileSync(this.file, line, { mode: 0o600 });
    } catch (err) {
      this.options.logger.warn("cannot write the request journal", { error: String(err) });
    }
  }
}

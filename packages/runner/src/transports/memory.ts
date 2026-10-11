import type { ResponseMessage, RunnerOp, RunnerToHub } from "@witden/shared";
import type { RunnerCore, RunnerTransport } from "../core.js";

let nextId = 0;

/**
 * In-process transport: records everything the core sends and lets a test (or an in-process hub) wait for
 * responses and events.
 */
export class MemoryTransport implements RunnerTransport {
  readonly messages: RunnerToHub[] = [];
  readonly binary: Uint8Array[] = [];
  private waiters: { match: (m: RunnerToHub) => boolean; resolve: (m: RunnerToHub) => void }[] = [];
  private binaryWaiters: (() => void)[] = [];

  constructor(readonly core?: RunnerCore) {
    core?.attach(this);
  }

  sendMessage(message: RunnerToHub): void {
    // Round-trip through JSON like a real connection would.
    const copy = JSON.parse(JSON.stringify(message)) as RunnerToHub;
    this.messages.push(copy);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      if (w.match(copy)) w.resolve(copy);
      else this.waiters.push(w);
    }
  }

  sendBinary(frame: Uint8Array): void {
    this.binary.push(frame);
    const waiters = this.binaryWaiters;
    this.binaryWaiters = [];
    for (const w of waiters) w();
  }

  bufferedAmount(): number {
    return 0;
  }

  /** Resolves with the first matching message received at or after index `from` (including future ones). */
  waitFor<T extends RunnerToHub>(match: (m: RunnerToHub) => boolean, timeoutMs = 10_000, from = 0): Promise<T> {
    const existing = this.messages.slice(from).find(match);
    if (existing) return Promise.resolve(existing as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a runner message")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as T);
        },
      });
    });
  }

  waitForBinary(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for binary data")), timeoutMs);
      this.binaryWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Sends a request to the attached core and waits for its response. */
  request(
    op: RunnerOp | string,
    params: Record<string, unknown> = {},
    options: { id?: string; timeoutMs?: number; waitMs?: number } = {},
  ): Promise<ResponseMessage> {
    if (!this.core) throw new Error("MemoryTransport has no core");
    const id = options.id ?? `req-${++nextId}-${Date.now()}`;
    const response = this.waitFor<ResponseMessage>(
      (m) => m.type === "response" && m.id === id,
      options.waitMs ?? (options.timeoutMs ?? 30_000) + 10_000,
      this.messages.length,
    );
    this.core.handleMessage({ type: "request", id, op, params, timeoutMs: options.timeoutMs ?? 30_000 });
    return response;
  }
}

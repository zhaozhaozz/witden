import type { RunnerChannel } from "@witden/shared";
import type { RawData } from "ws";

/** Copies a `ws` message payload into a standalone Uint8Array. */
export function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data);
}

export interface ChannelTransport {
  send(data: Uint8Array): void;
  close(): void;
}

/**
 * `RunnerChannel` over any byte transport. Data and close events that arrive before a listener is registered
 * are kept, so callers can attach listeners after `await openRunnerChannel()` without losing the first bytes.
 */
export class RelayChannel implements RunnerChannel {
  private dataListeners: ((data: Uint8Array) => void)[] = [];
  private closeListeners: ((reason: string) => void)[] = [];
  private pending: Uint8Array[] = [];
  private closedReason: string | null = null;

  constructor(private readonly transport: ChannelTransport) {}

  get closed(): boolean {
    return this.closedReason !== null;
  }

  send(data: Uint8Array): void {
    if (this.closedReason === null) this.transport.send(data);
  }

  onData(listener: (data: Uint8Array) => void): void {
    this.dataListeners.push(listener);
    const pending = this.pending;
    this.pending = [];
    for (const data of pending) listener(data);
  }

  onClose(listener: (reason: string) => void): void {
    if (this.closedReason !== null) listener(this.closedReason);
    else this.closeListeners.push(listener);
  }

  close(): void {
    if (this.closedReason !== null) return;
    this.transport.close();
    this.emitClose("closed");
  }

  /** Called by the transport for every inbound chunk. */
  emitData(data: Uint8Array): void {
    if (this.dataListeners.length === 0) this.pending.push(data);
    else for (const listener of this.dataListeners) listener(data);
  }

  /** Called by the transport once it is gone; later calls are ignored. */
  emitClose(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    const listeners = this.closeListeners;
    this.closeListeners = [];
    for (const listener of listeners) listener(reason);
  }
}

/**
 * Docker multiplexes the output of non-TTY execs: every frame is an 8-byte header (byte 0: stream, 1 = stdout,
 * 2 = stderr; bytes 4-7: big-endian payload length) followed by the payload. Only stdout payloads are returned.
 */
export class StdoutDemuxer {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Uint8Array[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const out: Uint8Array[] = [];
    while (this.buffer.length >= 8) {
      const size = this.buffer.readUInt32BE(4);
      if (this.buffer.length < 8 + size) break;
      if (this.buffer[0] === 1 && size > 0) out.push(new Uint8Array(this.buffer.subarray(8, 8 + size)));
      this.buffer = this.buffer.subarray(8 + size);
    }
    return out;
  }
}

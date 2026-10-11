import { createConnection, type Socket } from "node:net";
import { decodeStreamFrame, encodeStreamFrame, type RunnerToHub } from "@witden/shared";
import type { Logger } from "./log.js";

const CONNECT_TIMEOUT_MS = 10_000;
/** Stream sockets pause while the transport has more than this queued. */
const HIGH_WATER = 4 * 1024 * 1024;

export interface StreamSink {
  send(message: RunnerToHub): void;
  sendBinary(frame: Uint8Array): void;
  buffered(): number;
}

/** Loopback TCP tunnels (e.g. VNC for the human view), multiplexed as binary frames over the hub connection. */
export class StreamManager {
  private readonly sockets = new Map<number, Socket>();
  private resumeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ports: number[],
    private readonly sink: StreamSink,
    private readonly log: Logger,
  ) {}

  get size(): number {
    return this.sockets.size;
  }

  open(streamId: unknown, port: unknown): void {
    if (typeof streamId !== "number" || !Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
      this.log.warn("stream.open with an invalid stream id", { streamId });
      return;
    }
    if (typeof port !== "number" || !this.ports.includes(port)) {
      this.sink.send({ type: "stream.close", streamId, reason: `port ${String(port)} is not allowed` });
      return;
    }
    if (this.sockets.has(streamId)) {
      this.sink.send({ type: "stream.close", streamId, reason: "stream id already in use" });
      this.drop(streamId);
      return;
    }
    const socket = createConnection({ host: "127.0.0.1", port });
    this.sockets.set(streamId, socket);
    let reason = "closed";
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      reason = "connect timeout";
      socket.destroy();
    });
    socket.on("connect", () => {
      socket.setTimeout(0);
      socket.setNoDelay(true);
      this.sink.send({ type: "stream.opened", streamId });
    });
    socket.on("data", (chunk: Buffer) => {
      this.sink.sendBinary(encodeStreamFrame(streamId, chunk));
      if (this.sink.buffered() > HIGH_WATER) this.pauseAll();
    });
    socket.on("error", (err) => {
      reason = err.message;
    });
    socket.on("close", () => {
      // Only report closes the hub did not ask for.
      if (this.sockets.get(streamId) === socket) {
        this.sockets.delete(streamId);
        this.sink.send({ type: "stream.close", streamId, reason });
      }
    });
  }

  data(frame: Uint8Array): void {
    if (frame.byteLength < 4) return;
    const { streamId, payload } = decodeStreamFrame(frame);
    const socket = this.sockets.get(streamId);
    if (!socket) {
      this.log.debug("data for an unknown stream", { streamId });
      return;
    }
    socket.write(payload);
  }

  /** The hub closed the stream. */
  close(streamId: unknown): void {
    if (typeof streamId === "number") this.drop(streamId);
  }

  closeAll(): void {
    for (const id of [...this.sockets.keys()]) this.drop(id);
  }

  private drop(streamId: number): void {
    const socket = this.sockets.get(streamId);
    this.sockets.delete(streamId);
    socket?.destroy();
  }

  private pauseAll(): void {
    for (const socket of this.sockets.values()) socket.pause();
    if (this.resumeTimer) return;
    this.resumeTimer = setInterval(() => {
      if (this.sink.buffered() > HIGH_WATER / 2) return;
      for (const socket of this.sockets.values()) socket.resume();
      clearInterval(this.resumeTimer!);
      this.resumeTimer = null;
    }, 50);
  }
}

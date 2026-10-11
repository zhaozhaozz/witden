import type { Readable, Writable } from "node:stream";
import { encodeStdioFrame, type RunnerToHub, StdioFrameDecoder } from "@witden/shared";
import type { RunnerCore, RunnerTransport } from "../core.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Runner protocol over a byte stream pair (the Docker Manager's `docker exec witden-runner --stdio` channel).
 * Resolves when the input ends; requests still running are left to finish by the caller (see main.ts).
 */
export function serveStdio(
  core: RunnerCore,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const frames = new StdioFrameDecoder();
  const transport: RunnerTransport = {
    sendMessage: (message: RunnerToHub) => {
      output.write(encodeStdioFrame("text", encoder.encode(JSON.stringify(message))));
    },
    sendBinary: (frame) => {
      output.write(encodeStdioFrame("binary", frame));
    },
    bufferedAmount: () => output.writableLength,
  };
  output.on("error", (err) => core.log.warn("stdio output error", { error: err.message }));

  return new Promise((resolve) => {
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      core.detach(transport);
      resolve();
    };
    core
      .hello()
      .then((hello) => {
        transport.sendMessage(hello);
        core.attach(transport);
        input.on("data", (chunk: Buffer) => {
          for (const frame of frames.push(chunk)) {
            if (frame.kind === "text") core.handleText(decoder.decode(frame.payload));
            else core.handleBinary(frame.payload);
          }
        });
        input.on("end", end);
        input.on("close", end);
        input.on("error", end);
      })
      .catch((err) => {
        core.log.error("cannot build hello", { error: String(err) });
        end();
      });
  });
}

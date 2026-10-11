import { spawn } from "node:child_process";
import { abortError, OpError } from "./errors.js";

export interface ToolResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

export interface RunToolOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Stdout beyond this fails the call. */
  maxBytes?: number;
  input?: string | Buffer;
}

/** Runs a helper binary (tmux, xdotool, import...) with an argv array — never through a shell. */
export function runTool(bin: string, args: string[], options: RunToolOptions = {}): Promise<ToolResult> {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError(options.signal));
      return;
    }
    const child = spawn(bin, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = "";
    let failure: Error | null = null;
    const stop = (err: Error) => {
      failure ??= err;
      child.kill("SIGKILL");
    };
    const timer = options.timeoutMs
      ? setTimeout(() => stop(new OpError("timeout", `${bin} timed out`)), options.timeoutMs)
      : null;
    const onAbort = () => stop(abortError(options.signal!));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout!.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) stop(new OpError("failed", `${bin} produced more than ${maxBytes} bytes`));
      else out.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < 65536) stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      failure ??= err.code === "ENOENT" ? new OpError("unsupported", `${bin} is not installed in this computer`) : err;
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else resolve({ code, signal, stdout: Buffer.concat(out), stderr });
    });
    if (options.input !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(options.input);
    }
  });
}

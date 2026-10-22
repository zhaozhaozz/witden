import type { RunnerError } from "@witden/shared";

/** Error codes documented in the runner protocol. */
export type ErrorCode = "not_found" | "timeout" | "unsupported" | "invalid" | "busy" | "failed";

export class OpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpError";
  }
}

const ERRNO_CODES: Record<string, ErrorCode> = {
  ENOENT: "not_found",
  ENOTDIR: "not_found",
  EACCES: "failed",
  EPERM: "failed",
  EROFS: "failed",
  EISDIR: "invalid",
  EEXIST: "invalid",
  ENOTEMPTY: "invalid",
  EINVAL: "invalid",
  ENAMETOOLONG: "invalid",
  ELOOP: "invalid",
  ETIMEDOUT: "timeout",
  EBUSY: "busy",
};

export function toRunnerError(err: unknown): RunnerError {
  if (err instanceof OpError) return { code: err.code, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  const errno = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof errno === "string" && errno in ERRNO_CODES) return { code: ERRNO_CODES[errno], message };
  return { code: "failed", message };
}

/**
 * Maps an aborted request signal (reason "timeout" | "cancel" | "shutdown" | "update") to the error reported to
 * the hub.
 */
export function abortError(signal: AbortSignal): OpError {
  if (signal.reason === "timeout") return new OpError("timeout", "the operation timed out");
  if (signal.reason === "shutdown") return new OpError("failed", "the runner is shutting down");
  if (signal.reason === "update")
    return new OpError("failed", "the runner restarted for an update while this was running; its outcome is uncertain");
  return new OpError("failed", "the operation was cancelled");
}

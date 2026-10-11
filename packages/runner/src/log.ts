export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Logs go to stderr only: stdout carries protocol frames in --stdio mode. */
export function createStderrLogger(level: LogLevel = "info"): Logger {
  const write = (lvl: LogLevel, message: string, extra?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
    process.stderr.write(`${new Date().toISOString()} ${lvl.toUpperCase()} witden-runner: ${message}${suffix}\n`);
  };
  return {
    debug: (m, e) => write("debug", m, e),
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function parseLogLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

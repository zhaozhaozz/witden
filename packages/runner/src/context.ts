import os from "node:os";
import type { Logger } from "./log.js";

/** Per-request context handed to op handlers. */
export interface OpContext {
  requestId: string;
  /** Aborted with reason "timeout", "cancel" or "shutdown". */
  signal: AbortSignal;
  /** Epoch ms by which the operation must be finished. */
  deadline: number;
  emit(event: string, data: Record<string, unknown>, sessionId?: string): void;
}

export type OpHandler = (params: Record<string, unknown>, ctx: OpContext) => Promise<unknown>;

export const remainingMs = (ctx: OpContext, min = 1000) => Math.max(min, ctx.deadline - Date.now());

/** What op modules need to know about the computer. */
export interface Env {
  workdir: string;
  home: string;
  logger: Logger;
  /** Environment for processes the runner starts (runner secrets removed). */
  childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv;
}

const PRIVATE_VARS = ["WITDEN_RUNNER_TOKEN"];

export function createEnv(workdir: string, home: string, logger: Logger): Env {
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {
    // no passwd entry
  }
  return {
    workdir,
    home,
    logger,
    childEnv(extra) {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      if (user) {
        env.USER ??= user;
        env.LOGNAME ??= user;
      }
      for (const name of PRIVATE_VARS) delete env[name];
      return { ...env, ...extra };
    },
  };
}

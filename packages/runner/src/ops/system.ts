import type { ProcessInfo } from "@witden/shared";
import { listProcs, readCmdline } from "../proc.js";

const MAX_PROCESSES = 5000;

/** process.list: every process visible in the computer's /proc. */
export function processList(): { processes: ProcessInfo[]; truncated: boolean } {
  const procs = listProcs().sort((a, b) => a.pid - b.pid);
  const processes = procs.slice(0, MAX_PROCESSES).map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    command: readCmdline(p.pid) || `[${p.comm}]`,
  }));
  return { processes, truncated: procs.length > MAX_PROCESSES };
}

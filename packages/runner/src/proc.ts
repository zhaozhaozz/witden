import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { sleep } from "./util.js";

export interface ProcStat {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  /** Foreground process group of the controlling terminal (-1 without one). */
  tpgid: number;
  state: string;
  /** Start time in clock ticks since boot; with the pid it identifies a process despite pid reuse. */
  startTime: string;
  comm: string;
}

/**
 * Whether a process of this user other than the runner could read ``token``: from the environment of any
 * process it can open, or from the runner itself when the runner can be inspected (its /proc entries are
 * then owned by the user rather than by root). See init.ts for how the computer images prevent both.
 */
export function tokenReadable(token: string): boolean {
  if (!token) return false;
  const uid = process.getuid?.();
  try {
    if (uid !== undefined && uid !== 0 && statSync("/proc/self/environ").uid === uid) return true;
  } catch {
    return false; // no /proc: not Linux, nothing to check
  }
  const needle = Buffer.from(`WITDEN_RUNNER_TOKEN=${token}\0`);
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/environ`).includes(needle)) return true;
    } catch {
      // not ours to read, or gone
    }
  }
  return false;
}

export function readStat(pid: number): ProcStat | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // comm is in parentheses and may itself contain spaces or parentheses.
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close < 0) return null;
  const rest = raw.slice(close + 2).split(" ");
  return {
    pid,
    comm: raw.slice(open + 1, close),
    state: rest[0],
    ppid: Number(rest[1]),
    pgid: Number(rest[2]),
    sid: Number(rest[3]),
    tpgid: Number(rest[5]),
    startTime: rest[19],
  };
}

export function listProcs(): ProcStat[] {
  const procs: ProcStat[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readStat(Number(name));
    if (stat) procs.push(stat);
  }
  return procs;
}

export function readCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

const isDead = (stat: ProcStat | null) => !stat || stat.state === "Z" || stat.state === "X";

/** True if the process exists, is not a zombie and (when given) has the same start time. */
export function isAlive(pid: number, startTime?: string): boolean {
  const stat = readStat(pid);
  return !isDead(stat) && (startTime === undefined || stat!.startTime === startTime);
}

export function selfStat(): ProcStat {
  return readStat(process.pid)!;
}

/** All descendants of the given roots (not including the roots). */
export function descendantsOf(roots: Iterable<number>, procs: ProcStat[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const out = new Set<number>();
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.pop()!;
    for (const child of children.get(pid) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/** Links (e.g. "socket:[123]") of the given fds of a process. */
export function fdLinks(pid: number, fds: number[]): string[] {
  const links: string[] = [];
  for (const fd of fds) {
    try {
      links.push(readlinkSync(`/proc/${pid}/fd/${fd}`));
    } catch {
      // process gone or fd closed
    }
  }
  return links;
}

/** Processes holding any of the given fd links open (finds daemons that escaped the process tree). */
export function fdHolders(links: Set<string>, procs: ProcStat[]): number[] {
  const holders: number[] = [];
  for (const p of procs) {
    if (p.pid === process.pid) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${p.pid}/fd`);
    } catch {
      continue; // other user's process or gone
    }
    for (const fd of fds) {
      try {
        if (links.has(readlinkSync(`/proc/${p.pid}/fd/${fd}`))) {
          holders.push(p.pid);
          break;
        }
      } catch {
        // fd closed meanwhile
      }
    }
  }
  return holders;
}

function protectedPids(procs: ProcStat[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set<number>([0, 1, process.pid]);
  let cur = byPid.get(process.pid);
  while (cur && cur.ppid > 0 && !out.has(cur.ppid)) {
    out.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

export interface KillTreeOptions {
  /** Root processes; their descendants are included. */
  pids: number[];
  /** Process groups whose members are included. */
  pgids?: number[];
  /** Processes holding one of these fd links (see fdLinks) are included. */
  links?: Set<string>;
  /** Time between SIGTERM and SIGKILL. */
  graceMs?: number;
}

/**
 * Stops a process tree: SIGTERM, then SIGKILL after the grace period for whatever is left. The tree is
 * re-collected on every round, so processes that were reparented or forked meanwhile are still covered.
 * Returns the number of distinct processes that were signalled.
 */
export async function killTree(options: KillTreeOptions): Promise<number> {
  const graceMs = options.graceMs ?? 2000;
  const signalled = new Map<number, string>();
  const ownPgid = selfStat()?.pgid;
  const pgids = (options.pgids ?? []).filter((g) => g > 1 && g !== ownPgid);

  const collect = (): ProcStat[] => {
    const procs = listProcs();
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const set = new Set<number>();
    for (const pid of options.pids) set.add(pid);
    for (const p of procs) if (pgids.includes(p.pgid)) set.add(p.pid);
    if (options.links?.size) for (const pid of fdHolders(options.links, procs)) set.add(pid);
    for (const [pid, start] of signalled) if (byPid.get(pid)?.startTime === start) set.add(pid);
    for (const pid of descendantsOf(set, procs)) set.add(pid);
    const skip = protectedPids(procs);
    return [...set].map((pid) => byPid.get(pid)).filter((p): p is ProcStat => !!p && !skip.has(p.pid) && !isDead(p));
  };

  const send = (targets: ProcStat[], signal: NodeJS.Signals) => {
    for (const p of targets) {
      try {
        process.kill(p.pid, signal);
        signalled.set(p.pid, p.startTime);
      } catch {
        // already gone
      }
    }
    // Group signals also reach members forked after the scan.
    for (const pgid of pgids) {
      try {
        process.kill(-pgid, signal);
      } catch {
        // group empty
      }
    }
  };

  send(collect(), "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(100);
    const left = collect();
    if (!left.length) return signalled.size;
    send(
      left.filter((p) => !signalled.has(p.pid)),
      "SIGTERM",
    );
  }
  for (let round = 0; round < 3; round++) {
    const left = collect();
    if (!left.length) break;
    send(left, "SIGKILL");
    await sleep(100);
  }
  return signalled.size;
}

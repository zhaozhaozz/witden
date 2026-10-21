/**
 * Agent worker: claims pending tasks from the PostgreSQL queue (several workers can share it), runs them,
 * keeps their leases alive, resumes waits and recovers tasks whose worker disappeared.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { and, eq, inArray, lt, lte, ne } from "drizzle-orm";
import type { GatewayClient } from "../compute/gateway.js";
import { settings } from "../config.js";
import { type Database, db as getDb, transaction } from "../db/client.js";
import { agentSessions, computerInstances, messageRoutes, tasks } from "../db/schema.js";
import { WAKE_CHANNEL } from "../services/events.js";
import { commandWaitTimedOut, waitingOnEndedCommands, wakeForCommands } from "./commands.js";
import { expireTakeovers, getTask, publishTaskStatus, setStatus } from "./control.js";
import { wakeDue } from "./conversation.js";
import { claimRoutes, routeMessage } from "./router.js";
import { claimNext, collectChildren, TaskRunner } from "./runner.js";
import { lockTask } from "./task-continuation.js";
import { finishHandover } from "./task-handoff.js";
import { appendStep } from "./transcript.js";

const POLL_MS = 2000;
const LEASE_MS = 5 * 60_000;

export class Worker {
  readonly id = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  private running = new Map<string, Promise<void>>();
  private stopped = false;
  /** Scheduling runs by itself only after start(); tests step it with tick() / drain(). */
  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private unlisten: (() => Promise<void>) | null = null;
  private ticking = false;

  constructor(
    private readonly gateway: GatewayClient,
    private readonly opts: { concurrency?: number; deliverOutbound?: () => Promise<unknown> } = {},
  ) {}

  async start(database: Database, opts: { recoverAll?: boolean } = {}): Promise<void> {
    this.started = true;
    if (opts.recoverAll) await this.recoverOrphans(true);
    this.unlisten = await database.listen(WAKE_CHANNEL, (what) => {
      if (what === "outbound") void this.opts.deliverOutbound?.();
      else this.notify();
    });
    this.timer = setInterval(() => this.notify(), POLL_MS);
    this.heartbeat = setInterval(() => void this.renewLeases(), 60_000);
    this.notify();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.unlisten?.();
    await Promise.allSettled([...this.running.values()]);
  }

  notify(): void {
    if (!this.started || this.stopped || this.ticking) return;
    this.ticking = true;
    this.tick()
      .catch((err) => console.error("[witden] worker tick failed", err))
      .finally(() => {
        this.ticking = false;
      });
  }

  /** One scheduling round (also used synchronously by tests via ``drain``). */
  async tick(): Promise<void> {
    await transaction((tx) => expireTakeovers(tx));
    // Messages in "auto" topics waiting for the dispatcher (agent/router.ts).
    await Promise.all((await claimRoutes(getDb(), 5)).map((id) => routeMessage(id)));
    await this.checkWaits();
    await this.recoverOrphans(false);
    const free = (this.opts.concurrency ?? settings().workerConcurrency) - this.running.size;
    for (const id of await claimNext(getDb(), this.id, free, LEASE_MS)) {
      await transaction(async (tx) => {
        const t = await getTask(tx, id);
        if (t) await publishTaskStatus(tx, t);
      });
      const p = new TaskRunner(this.gateway).run(id).finally(async () => {
        // A role handed the task over with this run's last call: it changes hands now, under this run's claim.
        try {
          await transaction((tx) => finishHandover(tx, id, this.id));
        } catch (err) {
          console.error(`[witden] handing over task ${id} failed`, err);
        }
        // The run is over: release the claim now, not when the lease runs out, so the task can be handed over.
        try {
          await getDb()
            .update(tasks)
            .set({ claimedBy: null, leaseUntil: null })
            .where(and(eq(tasks.id, id), eq(tasks.claimedBy, this.id), ne(tasks.status, "running")));
        } catch (err) {
          console.error(`[witden] releasing task ${id} failed`, err);
        }
        // The task may already run again here (handed over and claimed meanwhile): keep that run's entry.
        if (this.running.get(id) === p) this.running.delete(id);
        this.notify();
      });
      this.running.set(id, p);
    }
    if (this.opts.deliverOutbound) await this.opts.deliverOutbound().catch(() => {});
  }

  /** Run everything that is runnable until nothing is left (tests, CLI). */
  async drain(maxRounds = 100): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      await this.tick();
      // Finishing tasks trigger more ticks (notify); wait for all of them, not only the ones started here.
      while (this.running.size || this.ticking) {
        await Promise.allSettled([...this.running.values()]);
        await new Promise((r) => setTimeout(r, 5));
      }
      const pending = await getDb().select({ id: tasks.id }).from(tasks).where(eq(tasks.status, "pending")).limit(1);
      const routes = await getDb()
        .select({ id: messageRoutes.messageId })
        .from(messageRoutes)
        .where(inArray(messageRoutes.status, ["pending", "routing"]))
        .limit(1);
      if (!pending.length && !routes.length) return;
    }
    throw new Error("tasks kept coming back to pending");
  }

  private async renewLeases(): Promise<void> {
    if (!this.running.size) return;
    await getDb()
      .update(tasks)
      .set({ leaseUntil: new Date(Date.now() + LEASE_MS) })
      .where(and(inArray(tasks.id, [...this.running.keys()]), eq(tasks.claimedBy, this.id)));
  }

  /** Tasks whose worker vanished (lease expired) continue from their saved transcript. */
  private async recoverOrphans(all: boolean): Promise<void> {
    const rows = await getDb()
      .select()
      .from(tasks)
      .where(all ? eq(tasks.status, "running") : and(eq(tasks.status, "running"), lt(tasks.leaseUntil, new Date())));
    for (const t of rows) {
      if (this.running.has(t.id)) continue;
      await transaction(async (tx) => {
        const fresh = await getTask(tx, t.id);
        if (fresh?.status === "running")
          await setStatus(tx, fresh, "pending", "resumed after the worker running it stopped");
      });
    }
  }

  /** Resume tasks whose computer is back, whose delegates finished, or whose follow-up time came. */
  async checkWaits(): Promise<void> {
    const db = getDb();
    // Conversations whose follow-ups came due.
    for (const s of await db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(lte(agentSessions.wakeAt, new Date()))) {
      await transaction((tx) => wakeDue(tx, s.id));
    }
    for (const t of await db.select().from(tasks).where(eq(tasks.status, "waiting_children"))) {
      await transaction((tx) => collectChildren(tx, t));
    }
    // Timers that came due (looked at without a lock), and tasks whose background commands ended (agent/commands.ts):
    // only those are locked.
    const now = Date.now();
    const timers = await db
      .select({ id: tasks.id, wait: tasks.wait })
      .from(tasks)
      .where(eq(tasks.status, "waiting_timer"));
    const due = timers.filter((t) => new Date(t.wait?.until ?? 0).getTime() <= now).map((t) => t.id);
    for (const id of new Set([...(await waitingOnEndedCommands(db)), ...due])) {
      await transaction(async (tx) => {
        const fresh = await lockTask(tx, id);
        if (fresh?.status !== "waiting_timer") return;
        // One of its background commands ended (agent/commands.ts): it goes on before its time.
        if (await wakeForCommands(tx, fresh)) return;
        if (new Date(fresh.wait?.until ?? 0).getTime() > Date.now()) return;
        await appendStep(tx, fresh, "tool", {
          tool_call_id: fresh.wait?.tool_call_id,
          name: fresh.wait?.tool ?? "follow_up_later",
          content:
            fresh.wait?.type === "commands"
              ? await commandWaitTimedOut(tx, fresh)
              : `Time to follow up: ${fresh.wait?.note ?? ""}`,
        });
        await setStatus(tx, fresh, "pending", "follow-up time reached", { wait: null });
      });
    }
    for (const t of await db.select().from(tasks).where(eq(tasks.status, "waiting_resource"))) {
      await transaction(async (tx) => {
        const task = await getTask(tx, t.id);
        if (task?.status !== "waiting_resource") return;
        const [inst] = task.instanceId
          ? await tx.select().from(computerInstances).where(eq(computerInstances.id, task.instanceId)).limit(1)
          : [];
        if (!inst || inst.status === "deleted") {
          await setStatus(tx, task, "failed", "the task's computer no longer exists", { error: "instance missing" });
          return;
        }
        if (inst.status === "running" && !inst.pausedAi) {
          // The gateway re-checks everything when the call is retried.
          const keep = Object.fromEntries(Object.entries(task.wait ?? {}).filter(([k]) => ["retry_call"].includes(k)));
          await setStatus(tx, task, "pending", `computer ${inst.name} is available again`, {
            wait: Object.keys(keep).length ? keep : null,
          });
          return;
        }
        if (inst.pausedAi) return; // a person is working on it; wait without a deadline
        const since = new Date(task.wait?.since ?? task.updatedAt).getTime();
        if (Date.now() - since > settings().instanceWaitSeconds * 1000) {
          const { TaskRunner: Runner } = await import("./runner.js");
          await new Runner(this.gateway).failIn(
            tx,
            task,
            `computer ${inst.name} unavailable for too long: ${inst.statusReason ?? inst.status}`,
          );
        }
      });
    }
  }
}

export { inArray };

/** Process-wide services: settings, database, event bus, Docker Manager client, runner hub, background ops. */
import type { ManagerApi } from "@witden/shared";
import type { Settings } from "./config.js";
import type { Database } from "./db/client.js";
import type { EventBus } from "./services/events.js";

export interface RuntimeParts {
  settings: Settings;
  database: Database;
  bus: EventBus;
  manager: ManagerApi;
  /** Set by compute/hub.ts when this process hosts the runner hub (API / all-in-one). */
  hub?: import("./compute/hub.js").RunnerHub;
  /** How a worker reaches the execution gateway (in-process or HTTP). */
  gateway?: import("./compute/gateway.js").GatewayClient;
}

export class Runtime {
  settings: Settings;
  database: Database;
  bus: EventBus;
  manager: ManagerApi;
  hub?: import("./compute/hub.js").RunnerHub;
  gateway?: import("./compute/gateway.js").GatewayClient;
  worker?: import("./agent/worker.js").Worker;
  private pending = new Set<Promise<unknown>>();

  constructor(parts: RuntimeParts) {
    this.settings = parts.settings;
    this.database = parts.database;
    this.bus = parts.bus;
    this.manager = parts.manager;
    this.hub = parts.hub;
    this.gateway = parts.gateway;
  }

  /** Run a background operation (instance lifecycle etc.); failures are logged, never thrown at callers. */
  background(name: string, fn: () => Promise<unknown>): Promise<unknown> {
    const p = fn()
      .catch((err) => console.error(`[witden] background ${name} failed:`, err))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    return p;
  }

  /** Wait for background operations (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

let current: Runtime | null = null;

export function setRuntime(rt: Runtime): void {
  current = rt;
}

export function runtime(): Runtime {
  if (!current) throw new Error("runtime not initialised");
  return current;
}

export function maybeRuntime(): Runtime | null {
  return current;
}

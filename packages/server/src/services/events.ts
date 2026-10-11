/**
 * Live events (messages, task status, steps, computer state) for the console, across processes.
 *
 * Events are sent with PostgreSQL NOTIFY from inside the transaction that changed the data, so they are
 * delivered only after that transaction commits — subscribers (and the per-event permission check of the
 * stream endpoint) never observe state that is not visible yet. The same mechanism wakes workers.
 */
import { sql } from "drizzle-orm";
import type { Database, Db } from "../db/client.js";

export const EVENTS_CHANNEL = "witden_events";
export const WAKE_CHANNEL = "witden_wake";
const MAX_PAYLOAD = 7000;

export interface BusEvent {
  type: string;
  data: Record<string, any>;
  /** e.g. topic:<id>, task:<id>, instance:<id>, admin */
  channels: string[];
}

function shrink(value: unknown, budget: number): unknown {
  if (typeof value === "string") return value.length > budget ? `${value.slice(0, budget)}…` : value;
  if (Array.isArray(value)) return value.map((v) => shrink(v, budget));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, budget)]));
  }
  return value;
}

function encode(event: BusEvent): string {
  let payload = JSON.stringify(event);
  for (const budget of [2000, 500, 100]) {
    if (payload.length <= MAX_PAYLOAD) break;
    payload = JSON.stringify({ ...event, data: { ...(shrink(event.data, budget) as object), truncated: true } });
  }
  return payload.length <= MAX_PAYLOAD
    ? payload
    : JSON.stringify({ type: event.type, data: { truncated: true }, channels: event.channels });
}

/** Publish ``type`` on ``channels`` once the surrounding transaction commits. */
export async function publish(db: Db, type: string, data: Record<string, any>, ...channels: string[]): Promise<void> {
  await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${encode({ type, data, channels })})`);
}

/** Wake workers (``tasks``) or the outbound sender (``outbound``) after commit. */
export async function wake(db: Db, what: "tasks" | "outbound"): Promise<void> {
  await db.execute(sql`select pg_notify(${WAKE_CHANNEL}, ${what})`);
}

type Listener = (event: BusEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private stop: (() => Promise<void>) | null = null;

  async attach(database: Database): Promise<void> {
    this.stop = await database.listen(EVENTS_CHANNEL, (payload) => {
      let event: BusEvent;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      for (const fn of this.listeners) {
        try {
          fn(event);
        } catch {
          /* a broken subscriber must not affect others */
        }
      }
    });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async close(): Promise<void> {
    await this.stop?.();
  }
}

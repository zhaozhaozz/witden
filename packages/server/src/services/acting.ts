/**
 * Who an in-process API call acts for, when a system administrator role makes it (services/config-access.ts):
 * the person it acts for, and the role and task doing it. Kept apart so the database layer can carry it into
 * transactions, whose callbacks the embedded database runs from its own queue.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface Acting {
  userId: string;
  roleId: string;
  taskId: string;
}

const store = new AsyncLocalStorage<Acting>();

/** Set only around calls made by configRequest; requests from outside never carry it. */
export const acting = (): Acting | null => store.getStore() ?? null;

export const runActing = <T>(as: Acting, fn: () => T): T => store.run(as, fn);

/**
 * The in-process request carries a one-time ticket in this header (the HTTP layer does not keep the caller's
 * async context); the ticket exists only in this process's memory, for the duration of that one call.
 */
export const ACTING_HEADER = "x-witden-acting";
const tickets = new Map<string, Acting>();

export function actingTicket(as: Acting): { ticket: string; done: () => void } {
  const ticket = randomBytes(24).toString("hex");
  tickets.set(ticket, as);
  return { ticket, done: () => tickets.delete(ticket) };
}

export const actingFor = (header: unknown): Acting | null =>
  typeof header === "string" ? (tickets.get(header) ?? null) : null;

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { acting, runActing } from "../services/acting.js";
import * as schema from "./schema.js";

export type Schema = typeof schema;
/** A database handle or a transaction; service functions accept either. */
export type Db = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export interface Database {
  kind: "pg" | "pglite";
  db: Db;
  /** LISTEN on a channel; notifications sent inside a transaction arrive after it commits. */
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

const MIGRATIONS = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/db or dist/db -> package root / drizzle
  return path.resolve(here, "..", "..", "drizzle");
})();

export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith("pglite://")) {
    const target = url.slice("pglite://".length);
    if (target !== "memory") fs.mkdirSync(target, { recursive: true });
    const client = target === "memory" ? new PGlite() : new PGlite(target);
    await client.waitReady;
    const db = drizzlePglite(client, { schema }) as unknown as Db;
    await migratePglite(db as any, { migrationsFolder: MIGRATIONS });
    return {
      kind: "pglite",
      db,
      async listen(channel, onPayload) {
        const unsub = await client.listen(channel, onPayload);
        return async () => unsub();
      },
      close: () => client.close(),
    };
  }
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new pg.Pool({ connectionString: url, max: 20 });
    const db = drizzleNodePg(pool, { schema }) as unknown as Db;
    await migrateNodePg(db as any, { migrationsFolder: MIGRATIONS });
    return {
      kind: "pg",
      db,
      async listen(channel, onPayload) {
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        client.on("notification", (n) => {
          if (n.channel === channel && n.payload !== undefined) onPayload(n.payload);
        });
        await client.query(`LISTEN "${channel.replace(/"/g, "")}"`);
        return async () => {
          await client.end();
        };
      },
      close: () => pool.end(),
    };
  }
  throw new Error(`unsupported database url ${url} (use postgres://... or pglite://<dir>|memory)`);
}

let current: Database | null = null;

export function setDatabase(database: Database): void {
  current = database;
}

export function database(): Database {
  if (!current) throw new Error("database not initialised");
  return current;
}

export function db(): Db {
  return database().db;
}

/** Run ``fn`` in a transaction. Inside, only use ``tx`` (PGlite serialises transactions on one connection). */
export function transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  // The embedded database runs queued transactions from its own queue: carry who a call acts for into it.
  const as = acting();
  return db().transaction((tx) => (as ? runActing(as, () => fn(tx as unknown as Db)) : fn(tx as unknown as Db)));
}

/**
 * HTTP plumbing shared by all routes: authentication, one transaction per request (committed before the
 * response is sent), work scheduled after commit, and the snake_case JSON contract of the REST API.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { type Db, db as getDb, transaction } from "../db/client.js";
import type { User } from "../db/schema.js";
import { Unauthorized, WitdenError } from "../errors.js";
import { resolveToken } from "../services/users.js";

export interface Ctx {
  db: Db;
  user: User;
  req: FastifyRequest;
  reply: FastifyReply;
  /** Run after the request transaction committed (background operations reading the new rows). */
  after(fn: () => unknown): void;
}

export function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  // EventSource / WebSocket clients cannot set headers.
  const q = (req.query as Record<string, string> | undefined)?.access_token;
  return q || null;
}

/** Error responses in the API's shape, for every server (console and webhook listener). */
export function sendError(err: FastifyError | Error, _req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof WitdenError) {
    return reply.code(err.status).send({ error: { code: err.code, message: err.message, detail: err.detail } });
  }
  const status = (err as FastifyError).statusCode ?? 500;
  if (status >= 500) console.error("[witden] request failed", err);
  return reply.code(status).send({
    error: { code: status >= 500 ? "internal" : "bad_request", message: err.message, detail: {} },
  });
}

type Handler<T> = (ctx: Ctx) => Promise<T>;

/** Authenticated handler running in one transaction. */
export function authed<T>(fn: Handler<T>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<T> => {
    const afters: (() => unknown)[] = [];
    const result = await transaction(async (db) => {
      const user = await resolveToken(db, extractToken(req));
      if (!user) throw new Unauthorized("authentication required");
      return fn({ db, user, req, reply, after: (f) => afters.push(f) });
    });
    for (const f of afters) await f();
    return result;
  };
}

/** Authenticated handler that must not hold a transaction (long calls: models, computers). */
export function authedNoTx<T>(fn: Handler<T>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<T> => {
    const user = await resolveToken(getDb(), extractToken(req));
    if (!user) throw new Unauthorized("authentication required");
    const afters: (() => unknown)[] = [];
    const result = await fn({ db: getDb(), user, req, reply, after: (f) => afters.push(f) });
    for (const f of afters) await f();
    return result;
  };
}

export const body = (req: FastifyRequest): Record<string, any> => camel((req.body as Record<string, any>) ?? {});
export const params = (req: FastifyRequest) => req.params as Record<string, string>;
export const query = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string | undefined>;

const SECRET_FIELDS = new Set([
  "passwordHash",
  "apiKeyEncrypted",
  "credentialsEncrypted",
  "tokenHash",
  "runnerTokenHash",
  "modelProxyKeyEncrypted",
]);

const toSnake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** Database row -> API object: snake_case keys, ISO dates, secrets removed (nested JSON left as stored). */
export function row(obj: Record<string, any> | null | undefined, exclude: string[] = []): Record<string, any> {
  if (!obj) return obj as any;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELDS.has(k) || exclude.includes(k)) continue;
    out[toSnake(k)] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/** Request body (snake_case) -> service input (camelCase), top level only. */
export function camel(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [toCamel(k), v]));
}

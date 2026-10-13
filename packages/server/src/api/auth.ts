import type { FastifyInstance } from "fastify";
import { settings } from "../config.js";
import { transaction } from "../db/client.js";
import { ALL_PERMS, hasPermission } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { authenticate, issueToken, revokeToken } from "../services/users.js";
import { authed, body, extractToken, row } from "./http.js";

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (req) =>
    transaction(async (db) => {
      const b = body(req);
      const user = await authenticate(db, String(b.email ?? ""), String(b.password ?? ""));
      const token = await issueToken(db, user, { ttlHours: settings().sessionTtlHours });
      await audit(db, "auth.login", { actorType: "user", actorId: user.id });
      return { token, user: row(user) };
    }),
  );

  app.post(
    "/api/auth/logout",
    authed(async ({ db, req }) => {
      const token = extractToken(req);
      if (token) await revokeToken(db, token);
      return { ok: true };
    }),
  );

  app.get(
    "/api/auth/me",
    authed(async ({ db, user }) => {
      const permissions: string[] = [];
      for (const p of ALL_PERMS) if (await hasPermission(db, user, p)) permissions.push(p);
      return { ...row(user), permissions: permissions.sort() };
    }),
  );

  app.post(
    "/api/auth/tokens",
    authed(async ({ db, user, req }) => {
      const b = body(req);
      const token = await issueToken(db, user, { kind: "api", name: b.name, ttlHours: b.ttlHours ?? null });
      await audit(db, "auth.token_created", { actorType: "user", actorId: user.id, detail: { name: b.name } });
      return { token };
    }),
  );
}

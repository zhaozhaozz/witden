import { and, eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { settings } from "../config.js";
import { transaction } from "../db/client.js";
import { grants } from "../db/schema.js";
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
      const global: string[] = [];
      for (const p of ALL_PERMS) if (await hasPermission(db, user, p)) global.push(p);
      const mine = await db
        .select()
        .from(grants)
        .where(or(and(eq(grants.subjectType, "user"), eq(grants.subjectId, user.id)), eq(grants.subjectType, "all")));
      const scoped = mine
        .filter((g) => g.resourceId !== "*")
        .map((g) => ({ permission: g.permission, resource_id: g.resourceId }));
      return {
        ...row(user),
        // Global permissions plus anything held on at least one resource (to show the relevant pages);
        // every action is still checked against the specific resource on the server.
        permissions: [...new Set([...global, ...scoped.map((s) => s.permission)])].sort(),
        global_permissions: global.sort(),
        scoped_permissions: scoped,
      };
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

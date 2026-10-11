/** Members, grants, external identities, audit trail, usage and emergency stop. */
import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { applyKillSwitch, onUserDeactivated, recheckActiveTasks } from "../agent/revocation.js";
import { newId } from "../db/ids.js";
import { auditLogs, externalIdentities, grants, killSwitches, usageRecords, users } from "../db/schema.js";
import { BadRequest, NotFound } from "../errors.js";
import { hashPassword } from "../security/crypto.js";
import { ALL_PERMS, grant, hasPermission, isPerm, PERM_RESOURCE, Perm, requirePerm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { publish } from "../services/events.js";
import { createUser, revokeUserSessions } from "../services/users.js";
import { authed, body, params, query, row } from "./http.js";

export async function adminRoutes(app: FastifyInstance) {
  app.get(
    "/api/users",
    authed(async ({ db, user }) => {
      // Everyone may see the member directory (names) to mention and invite; details need user.manage.
      const rows = await db.select().from(users).orderBy(users.name);
      if (await hasPermission(db, user, Perm.USER_MANAGE)) return rows.map((u) => row(u));
      return rows.map((u) => ({ id: u.id, name: u.name, avatar_url: u.avatarUrl, is_active: u.isActive }));
    }),
  );

  app.post(
    "/api/users",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.USER_MANAGE);
      const b = body(req);
      if (b.isAdmin && !user.isAdmin) throw new BadRequest("only administrators can create administrators");
      const created = await createUser(db, {
        name: b.name,
        email: b.email,
        password: b.password,
        isAdmin: !!b.isAdmin,
      });
      await audit(db, "user.create", {
        actorType: "user",
        actorId: user.id,
        resourceType: "user",
        resourceId: created.id,
      });
      return row(created);
    }),
  );

  app.patch(
    "/api/users/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.USER_MANAGE);
      const [target] = await db
        .select()
        .from(users)
        .where(eq(users.id, params(req).id))
        .limit(1);
      if (!target) throw new NotFound("user not found");
      if (target.isAdmin && !user.isAdmin)
        throw new BadRequest("only administrators can change an administrator account");
      const b = body(req);
      if (b.isAdmin !== undefined && !user.isAdmin) throw new BadRequest("only administrators can change admin status");
      const update: Partial<typeof target> = {};
      if (b.name !== undefined) update.name = b.name;
      if (b.isAdmin !== undefined) update.isAdmin = !!b.isAdmin;
      if (b.password) update.passwordHash = hashPassword(String(b.password));
      if (b.isActive !== undefined) update.isActive = !!b.isActive;
      const [updated] = await db.update(users).set(update).where(eq(users.id, target.id)).returning();
      if (b.isActive === false) {
        // Leaving the team ends access immediately, including tokens and pending work.
        await revokeUserSessions(db, target.id);
        await onUserDeactivated(db, target.id);
      }
      const { password: _p, ...detail } = b;
      await audit(db, "user.update", {
        actorType: "user",
        actorId: user.id,
        resourceType: "user",
        resourceId: target.id,
        detail,
      });
      return row(updated);
    }),
  );

  app.get(
    "/api/grants",
    authed(async ({ db, user }) => {
      await requirePerm(db, user, Perm.USER_MANAGE);
      return (await db.select().from(grants).orderBy(grants.permission)).map((g) => row(g));
    }),
  );

  app.get(
    "/api/permissions",
    authed(async () => ALL_PERMS.map((p) => ({ permission: p, resource_type: PERM_RESOURCE[p] ?? "*" }))),
  );

  app.post(
    "/api/grants",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.USER_MANAGE);
      const b = body(req);
      if (!isPerm(String(b.permission))) throw new BadRequest(`unknown permission ${b.permission}`);
      const g = await grant(db, b.permission, {
        userId: b.userId ?? null,
        resourceId: b.resourceId ?? "*",
        createdBy: user.id,
      });
      await audit(db, "grant.create", {
        actorType: "user",
        actorId: user.id,
        resourceType: "grant",
        resourceId: g.id,
        detail: b,
      });
      return row(g);
    }),
  );

  app.delete(
    "/api/grants/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.USER_MANAGE);
      const [g] = await db
        .select()
        .from(grants)
        .where(eq(grants.id, params(req).id))
        .limit(1);
      if (!g) throw new NotFound("grant not found");
      await db.delete(grants).where(eq(grants.id, g.id));
      // Revocation takes effect on queued and running work too.
      await recheckActiveTasks(db, `permission ${g.permission} revoked`);
      await audit(db, "grant.delete", {
        actorType: "user",
        actorId: user.id,
        resourceType: "grant",
        resourceId: g.id,
        detail: row(g),
      });
      return { ok: true };
    }),
  );

  app.get(
    "/api/identities",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.USER_MANAGE);
      const cid = query(req).connection_id;
      const rows = await db
        .select()
        .from(externalIdentities)
        .where(cid ? eq(externalIdentities.connectionId, cid) : undefined);
      return rows.map((i) => row(i));
    }),
  );

  app.patch(
    "/api/identities/:id",
    authed(async ({ db, user, req }) => {
      // Bind an external account (by its platform user id) to a member. Display names are never trusted.
      await requirePerm(db, user, Perm.USER_MANAGE);
      const [ident] = await db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.id, params(req).id))
        .limit(1);
      if (!ident) throw new NotFound("identity not found");
      const userId = body(req).userId ?? null;
      if (userId && !(await db.select().from(users).where(eq(users.id, userId)).limit(1)).length)
        throw new NotFound("user not found");
      const [updated] = await db
        .update(externalIdentities)
        .set({ userId })
        .where(eq(externalIdentities.id, ident.id))
        .returning();
      await audit(db, "identity.link", {
        actorType: "user",
        actorId: user.id,
        resourceType: "identity",
        resourceId: ident.id,
        connectionId: ident.connectionId,
        detail: { user_id: userId, external_user_id: ident.externalUserId },
      });
      return row(updated);
    }),
  );

  app.get(
    "/api/audit",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.AUDIT_VIEW);
      const q = query(req);
      const conds = [];
      if (q.action) conds.push(like(auditLogs.action, `${q.action}%`));
      if (q.task_id) conds.push(eq(auditLogs.taskId, q.task_id));
      if (q.topic_id) conds.push(eq(auditLogs.topicId, q.topic_id));
      if (q.instance_id) conds.push(eq(auditLogs.instanceId, q.instance_id));
      if (q.role_id) conds.push(eq(auditLogs.roleId, q.role_id));
      const rows = await db
        .select()
        .from(auditLogs)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(auditLogs.createdAt))
        .limit(Math.min(Number(q.limit ?? 200), 1000));
      return rows.map((a) => row(a));
    }),
  );

  app.get(
    "/api/usage",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.AUDIT_VIEW);
      const q = query(req);
      const column = {
        role: usageRecords.roleId,
        task: usageRecords.taskId,
        instance: usageRecords.instanceId,
        model: usageRecords.modelConfigId,
      }[q.group_by ?? "role"];
      if (!column) throw new BadRequest("group_by must be role, task, instance or model");
      const days = Math.max(1, Math.min(Number(q.days ?? 7), 365));
      const rows = await db
        .select({
          key: column,
          prompt: sql<number>`sum(${usageRecords.promptTokens})::int`,
          completion: sql<number>`sum(${usageRecords.completionTokens})::int`,
          calls: sql<number>`count(*)::int`,
        })
        .from(usageRecords)
        .where(gte(usageRecords.createdAt, new Date(Date.now() - days * 86400_000)))
        .groupBy(column);
      return rows.map((r) => ({
        key: r.key,
        prompt_tokens: Number(r.prompt ?? 0),
        completion_tokens: Number(r.completion ?? 0),
        calls: Number(r.calls),
      }));
    }),
  );

  app.get(
    "/api/kill-switches",
    authed(async ({ db, user }) => {
      await requirePerm(db, user, Perm.EMERGENCY_STOP);
      return (await db.select().from(killSwitches).orderBy(desc(killSwitches.createdAt))).map((k) => row(k));
    }),
  );

  app.post(
    "/api/kill-switches",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.EMERGENCY_STOP);
      const b = body(req);
      if (!["global", "connection", "role", "instance", "topic", "task"].includes(b.scope))
        throw new BadRequest("invalid scope");
      if (b.scope !== "global" && !b.targetId) throw new BadRequest("target_id is required for this scope");
      const [ks] = await db
        .insert(killSwitches)
        .values({
          id: newId("kill"),
          scope: b.scope,
          targetId: b.targetId ?? null,
          reason: b.reason ?? "",
          createdBy: user.id,
        })
        .returning();
      const stopped = await applyKillSwitch(db, ks);
      await audit(db, "emergency.stop", {
        actorType: "user",
        actorId: user.id,
        resourceType: b.scope,
        resourceId: b.targetId ?? null,
        detail: { reason: b.reason, tasks_paused: stopped },
      });
      await publish(db, "emergency.stop", row(ks), "admin");
      return { ...row(ks), tasks_paused: stopped };
    }),
  );

  app.post(
    "/api/kill-switches/:id/release",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.EMERGENCY_STOP);
      const [ks] = await db
        .update(killSwitches)
        .set({ active: false, releasedAt: new Date() })
        .where(eq(killSwitches.id, params(req).id))
        .returning();
      if (!ks) throw new NotFound("kill switch not found");
      await audit(db, "emergency.release", {
        actorType: "user",
        actorId: user.id,
        resourceType: ks.scope,
        resourceId: ks.targetId,
      });
      return row(ks);
    }),
  );
}

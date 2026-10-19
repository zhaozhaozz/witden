/** Scoped knowledge / memory. */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { knowledgeSpaces, type Memory, memories, roles, topics, type User } from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { hasPermission, Perm, requirePerm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { ROLE_MEMORY_MAX_CHARS } from "../services/role-memory.js";
import * as topicSvc from "../services/topics.js";
import { authed, body, params, query, row } from "./http.js";

async function canReadMemory(db: Db, user: User, m: Memory): Promise<boolean> {
  if (m.scope === "team") return hasPermission(db, user, Perm.KNOWLEDGE_READ, m.spaceId);
  if (m.scope === "role") return hasPermission(db, user, Perm.ROLE_MANAGE);
  if (m.scope === "topic") {
    const [topic] = m.topicId ? await db.select().from(topics).where(eq(topics.id, m.topicId)).limit(1) : [];
    return !!topic && (await topicSvc.canView(db, user, topic));
  }
  return false;
}

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get(
    "/api/knowledge-spaces",
    authed(async ({ db, user }) => {
      const out = [];
      for (const s of await db.select().from(knowledgeSpaces).orderBy(knowledgeSpaces.name)) {
        if (
          (await hasPermission(db, user, Perm.KNOWLEDGE_READ, s.id)) ||
          (await hasPermission(db, user, Perm.ROLE_MANAGE))
        )
          out.push(row(s));
      }
      return out;
    }),
  );

  app.post(
    "/api/knowledge-spaces",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.ROLE_MANAGE);
      const b = body(req);
      const [space] = await db
        .insert(knowledgeSpaces)
        .values({ id: newId("space"), name: String(b.name), description: b.description ?? "", createdBy: user.id })
        .returning();
      await audit(db, "knowledge.space_create", {
        actorType: "user",
        actorId: user.id,
        resourceType: "space",
        resourceId: space.id,
      });
      return row(space);
    }),
  );

  app.get(
    "/api/memories",
    authed(async ({ db, user, req }) => {
      const q = query(req);
      const conds = [eq(memories.scope, String(q.scope ?? "")), isNull(memories.deletedAt)];
      if (q.role_id) conds.push(eq(memories.roleId, q.role_id));
      if (q.space_id) conds.push(eq(memories.spaceId, q.space_id));
      if (q.topic_id) conds.push(eq(memories.topicId, q.topic_id));
      const out = [];
      for (const m of await db
        .select()
        .from(memories)
        .where(and(...conds))
        .orderBy(desc(memories.createdAt))
        .limit(500)) {
        if (await canReadMemory(db, user, m)) out.push(row(m));
      }
      return out;
    }),
  );

  app.post(
    "/api/memories",
    authed(async ({ db, user, req }) => {
      const b = body(req);
      const base = { id: newId("mem"), content: String(b.content ?? ""), createdByType: "user", createdById: user.id };
      let values: typeof memories.$inferInsert;
      if (b.scope === "team") {
        if (
          !b.spaceId ||
          !(await db.select().from(knowledgeSpaces).where(eq(knowledgeSpaces.id, b.spaceId)).limit(1)).length
        )
          throw new NotFound("knowledge space not found");
        await requirePerm(db, user, Perm.KNOWLEDGE_WRITE, b.spaceId);
        values = { ...base, scope: "team", spaceId: b.spaceId };
      } else if (b.scope === "role") {
        // The role's own memory, shown wherever it works (services/role-memory.ts).
        await requirePerm(db, user, Perm.ROLE_MANAGE);
        if (!b.roleId || !(await db.select().from(roles).where(eq(roles.id, b.roleId)).limit(1)).length)
          throw new NotFound("role not found");
        const content = base.content.trim();
        if (!content) throw new BadRequest("content is required");
        if (content.length > ROLE_MEMORY_MAX_CHARS)
          throw new BadRequest(`keep a role memory under ${ROLE_MEMORY_MAX_CHARS} characters`);
        values = { ...base, content, scope: "role", roleId: b.roleId };
      } else if (b.scope === "topic") {
        const topic = await topicSvc.getTopic(db, String(b.topicId ?? ""));
        if (!(await topicSvc.canPost(db, user, topic))) throw new Forbidden("you are not a participant of this topic");
        values = { ...base, scope: "topic", topicId: topic.id };
      } else throw new BadRequest("scope must be team, role or topic");
      const [m] = await db.insert(memories).values(values).returning();
      await audit(db, "memory.create", {
        actorType: "user",
        actorId: user.id,
        topicId: m.topicId,
        roleId: m.roleId,
        detail: { scope: m.scope, memory: m.id },
      });
      return row(m);
    }),
  );

  app.delete(
    "/api/memories/:id",
    authed(async ({ db, user, req }) => {
      const [m] = await db
        .select()
        .from(memories)
        .where(eq(memories.id, params(req).id))
        .limit(1);
      if (!m || m.deletedAt) throw new NotFound("memory not found");
      let allowed = false;
      if (m.scope === "team") allowed = await hasPermission(db, user, Perm.KNOWLEDGE_WRITE, m.spaceId);
      else if (m.scope === "role") allowed = await hasPermission(db, user, Perm.ROLE_MANAGE);
      else if (m.scope === "topic" && m.topicId)
        allowed =
          (await canReadMemory(db, user, m)) &&
          (await topicSvc.canAdminister(db, user, await topicSvc.getTopic(db, m.topicId)));
      if (!allowed) throw new Forbidden("you cannot delete this memory");
      await db.update(memories).set({ deletedAt: new Date(), content: "" }).where(eq(memories.id, m.id));
      await audit(db, "memory.delete", {
        actorType: "user",
        actorId: user.id,
        detail: { memory: m.id, scope: m.scope },
      });
      return { ok: true };
    }),
  );
}

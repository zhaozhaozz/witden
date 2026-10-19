/**
 * Agent sessions: a role's main conversation in a topic. The console shows how large its context is, when it
 * is compacted, whether it is working, and lets a console account clear the context.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { cancelTree } from "../agent/control.js";
import { openRun, readyItems, resetContext } from "../agent/conversation.js";
import type { Db } from "../db/client.js";
import { type AgentSession, agentSessions, roles } from "../db/schema.js";
import { Forbidden, NotFound } from "../errors.js";
import { audit } from "../services/audit.js";
import * as models from "../services/model-configs.js";
import * as topicSvc from "../services/topics.js";
import { authed, params, row } from "./http.js";

export async function sessionOut(db: Db, s: AgentSession) {
  const [role] = await db.select().from(roles).where(eq(roles.id, s.roleId)).limit(1);
  const found = role?.modelConfigId ? await models.modelWithProvider(db, role.modelConfigId) : null;
  const limits = found && !models.isSystemOne(found.provider) ? models.contextLimits(found.model) : null;
  const run = await openRun(db, s.id);
  return {
    // The inbox and the awaited people are internal bookkeeping.
    ...row(s, ["inbox", "awaiting", "roster", "wakeAt", "cursorAt", "contextFrom"]),
    waiting: readyItems(s).length,
    next_follow_up_at: s.wakeAt?.toISOString() ?? null,
    open_run: run ? { id: run.id, status: run.status } : null,
    context_window: limits?.window ?? null,
    compact_at: limits?.compactAt ?? null,
  };
}

export async function sessionRoutes(app: FastifyInstance) {
  /** Forget the conversation's context (and stop its open run); the topic keeps every message. */
  app.post(
    "/api/sessions/:id/reset",
    authed(async ({ db, user, req }) => {
      const [s] = await db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, params(req).id))
        .limit(1);
      if (!s) throw new NotFound("session not found");
      const topic = await topicSvc.getTopic(db, s.topicId);
      if (!(await topicSvc.canAdminister(db, user, topic)))
        throw new Forbidden("only console accounts can clear a conversation's context");
      const run = await openRun(db, s.id);
      if (run) await cancelTree(db, run, `context cleared by ${user.name}`);
      const [fresh] = await db.select().from(agentSessions).where(eq(agentSessions.id, s.id)).limit(1);
      await resetContext(db, fresh);
      await audit(db, "session.reset", {
        actorType: "user",
        actorId: user.id,
        topicId: s.topicId,
        roleId: s.roleId,
        resourceType: "agent_session",
        resourceId: s.id,
        detail: { stopped_run: run?.id ?? null },
      });
      const [after] = await db.select().from(agentSessions).where(eq(agentSessions.id, s.id)).limit(1);
      return sessionOut(db, after);
    }),
  );
}

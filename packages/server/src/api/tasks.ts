import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { canAllowForTaskRun } from "../agent/approval-scope.js";
import * as approvalSvc from "../agent/approvals.js";
import { taskProgress, taskStepDetail } from "../agent/progress.js";
import { listTaskIterations } from "../agent/task-continuation.js";
import { listTaskUpdates } from "../agent/task-updates.js";
import * as admin from "../agent/tasks-admin.js";
import { taskLog } from "../agent/transcript.js";
import type { Db } from "../db/client.js";
import {
  type Approval,
  approvals,
  auditLogs,
  computerInstances,
  roles,
  type Task,
  tasks,
  toolCalls,
  topics,
  type User,
  users,
} from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { externalContext } from "../integrations/links.js";
import { hasPermission, Perm } from "../security/permissions.js";
import * as topicSvc from "../services/topics.js";
import { authed, body, params, query, row } from "./http.js";

async function canViewTask(db: Db, user: User, task: Task): Promise<boolean> {
  const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
  return (!!topic && (await topicSvc.canView(db, user, topic))) || (await hasPermission(db, user, Perm.AUDIT_VIEW));
}

/** Task text is shown to people who may see its topic (auditors may list tasks without reading them). */
export async function contentVisible(db: Db, user: User | null, task: Task): Promise<boolean> {
  if (!user) return true;
  const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
  return !!topic && (await topicSvc.canView(db, user, topic));
}

export async function taskOut(db: Db, task: Task, opts: { detail?: boolean; viewer?: User } = {}) {
  const exclude =
    opts.detail && opts.viewer && (await hasPermission(db, opts.viewer, Perm.ROLE_MANAGE)) ? [] : ["roleSnapshot"];
  const data: Record<string, any> = row(task, exclude);
  if (!(await contentVisible(db, opts.viewer ?? null, task))) {
    // Titles of delegated work, waits and results are the topic's; only structure stays visible.
    for (const k of ["title", "instruction", "progress", "error", "status_reason", "result"])
      if (data[k]) data[k] = "[restricted]";
    data.wait = task.wait ? { type: task.wait.type } : null;
    data.content_restricted = true;
  }
  const [role] = await db.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
  const [inst] = task.instanceId
    ? await db.select().from(computerInstances).where(eq(computerInstances.id, task.instanceId)).limit(1)
    : [];
  const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
  const [requester] = task.requesterUserId
    ? await db.select().from(users).where(eq(users.id, task.requesterUserId)).limit(1)
    : [];
  data.owner = role
    ? { id: role.id, handle: role.handle, name: role.name, color: role.color, avatar_url: role.avatarUrl }
    : null;
  data.instance = inst ? { id: inst.id, name: inst.name, status: inst.status, color: inst.color } : null;
  data.topic = topic ? { id: topic.id, title: topic.title, kind: topic.kind } : null;
  data.requester = requester ? { id: requester.id, name: requester.name } : null;
  if (opts.detail) {
    const visible = await contentVisible(db, opts.viewer ?? null, task);
    data.iterations = visible ? (await listTaskIterations(db, task.id)).map((i) => row(i)) : [];
    // Progress recorded on the task, oldest first; its text is the topic's like the rest of the task.
    data.updates = visible ? (await listTaskUpdates(db, task.id)).map((u) => row(u)) : [];
    // Work it waits for (delegated by a task) or that it started and gets the result of (a conversation).
    data.children = [];
    for (const c of await db
      .select()
      .from(tasks)
      .where(or(eq(tasks.parentTaskId, task.id), and(eq(tasks.spawnedByTaskId, task.id), eq(tasks.kind, "task"))))) {
      data.children.push({
        id: c.id,
        title: (await contentVisible(db, opts.viewer ?? null, c)) ? c.title : "[restricted]",
        status: c.status,
        owner_role_id: c.ownerRoleId,
      });
    }
    data.approvals = (await db.select().from(approvals).where(eq(approvals.taskId, task.id))).map((a) => ({
      ...row(a, ["detail"]),
      action: a.action,
    }));
  }
  return data;
}

async function approvalOut(db: Db, a: Approval, user: User) {
  const data: Record<string, any> = row(a);
  const decide = await approvalSvc.canDecide(db, user, a);
  // Held content and tool arguments are shown only to people who decide approvals for the role.
  if (!decide)
    data.detail =
      a.action === "disclose"
        ? { sources: a.detail.sources }
        : { tool: a.detail.tool_call?.name, arguments: "[restricted]" };
  data.can_decide = a.status === "pending" && decide;
  const [task] = data.can_decide ? await db.select().from(tasks).where(eq(tasks.id, a.taskId)).limit(1) : [];
  data.can_allow_for_task_run = data.can_decide && canAllowForTaskRun(a, task);
  data.decision_scope = a.status === "approved" ? (a.detail.decision_scope ?? "once") : null;
  const [role] = await db.select().from(roles).where(eq(roles.id, a.roleId)).limit(1);
  data.role = role
    ? { id: role.id, handle: role.handle, name: role.name, color: role.color, avatar_url: role.avatarUrl }
    : null;
  return data;
}

export async function taskRoutes(app: FastifyInstance) {
  app.get(
    "/api/tasks",
    authed(async ({ db, user, req }) => {
      const q = query(req);
      const conds = [];
      if (q.status) conds.push(inArray(tasks.status, q.status.split(",")));
      if (q.topic_id) conds.push(eq(tasks.topicId, q.topic_id));
      if (q.role_id) conds.push(eq(tasks.ownerRoleId, q.role_id));
      // "task": independent tasks only; "conversation": runs of the roles' conversations.
      if (q.kind) conds.push(eq(tasks.kind, q.kind));
      // The runs of one conversation (agent session), newest first: its history in the topic's work panel.
      if (q.session_id) conds.push(eq(tasks.sessionId, q.session_id));
      if (q.mine === "true") conds.push(eq(tasks.requesterUserId, user.id));
      const rows = await db
        .select()
        .from(tasks)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(q.session_id ? desc(tasks.createdAt) : desc(tasks.updatedAt))
        .limit(Math.min(Number(q.limit ?? 200), 1000));
      const out = [];
      for (const t of rows) if (await canViewTask(db, user, t)) out.push(await taskOut(db, t, { viewer: user }));
      return out;
    }),
  );

  const load = async (db: Db, user: User, id: string) => {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!task || !(await canViewTask(db, user, task))) throw new NotFound("task not found");
    return task;
  };

  app.get(
    "/api/tasks/:id",
    authed(async ({ db, user, req }) =>
      taskOut(db, await load(db, user, params(req).id), { detail: true, viewer: user }),
    ),
  );

  app.get(
    "/api/tasks/:id/activity",
    authed(async ({ db, user, req }) => {
      const task = await load(db, user, params(req).id);
      if (!(await contentVisible(db, user, task))) throw new Forbidden("you cannot view this task's execution details");
      const q = query(req);
      const cursor = (key: "after" | "before") => {
        if (q[key] === undefined) return undefined;
        const n = Number(q[key]);
        if (!Number.isSafeInteger(n) || n < 0) throw new BadRequest(`${key} must be a non-negative integer`);
        return n;
      };
      if (q.after !== undefined && q.before !== undefined) throw new BadRequest("use either after or before");
      if (q.steps !== undefined && !["true", "false", "platform"].includes(q.steps))
        throw new BadRequest("steps must be true, false or platform");
      return taskProgress(db, task, {
        after: cursor("after"),
        before: cursor("before"),
        steps: q.steps === "platform" ? "platform" : q.steps === "true",
      });
    }),
  );

  app.get(
    "/api/tasks/:id/log/:seq",
    authed(async ({ db, user, req }) => {
      const task = await load(db, user, params(req).id);
      if (!(await contentVisible(db, user, task))) throw new Forbidden("you cannot view this task's execution details");
      const seq = Number(params(req).seq);
      if (!Number.isSafeInteger(seq) || seq < 1) throw new BadRequest("seq must be a positive integer");
      const step = await taskStepDetail(db, task, seq);
      if (!step) throw new NotFound("step not found");
      return step;
    }),
  );

  app.get(
    "/api/tasks/:id/log",
    authed(async ({ db, user, req }) => {
      const task = await load(db, user, params(req).id);
      if (!(await contentVisible(db, user, task)))
        throw new Forbidden("this task has read material you are not allowed to see, so its execution log is hidden");
      return taskLog(db, task);
    }),
  );

  app.get(
    "/api/tasks/:id/trace",
    authed(async ({ db, user, req }) => {
      // Full chain: who asked from where, assignment reasoning, computer, envelope, audit.
      const task = await load(db, user, params(req).id);
      const visible = await contentVisible(db, user, task);
      const ext = await externalContext(db, task.topicId);
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.taskId, task.id))
        .orderBy(asc(auditLogs.createdAt));
      return {
        task: await taskOut(db, task, { detail: true, viewer: user }),
        source: Object.keys(ext).length
          ? {
              connection_id: ext.connectionId,
              conversation_id: ext.conversationId,
              conversation_kind: ext.conversationKind,
              thread_key: ext.threadKey,
            }
          : { conversation_kind: "internal" },
        assignment: task.assignment,
        envelope: task.envelope,
        session_id: task.sessionId,
        // Execution-gateway journal: which computer operations ran, failed or have an uncertain outcome.
        tool_calls: (
          await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id)).orderBy(asc(toolCalls.createdAt))
        ).map((c) => row(c)),
        audit: rows.map((a) => (visible ? row(a) : { ...row(a, ["detail"]), detail: "[restricted]" })),
      };
    }),
  );

  app.post(
    "/api/tasks/:id/control",
    authed(async ({ db, user, req }) => {
      const task = await load(db, user, params(req).id);
      const b = body(req);
      if (b.expectedRevision !== undefined && (!Number.isInteger(b.expectedRevision) || b.expectedRevision < 1))
        throw new BadRequest("expected_revision must be a positive integer");
      if (
        b.idempotencyKey !== undefined &&
        (typeof b.idempotencyKey !== "string" || !b.idempotencyKey || b.idempotencyKey.length > 200)
      )
        throw new BadRequest("idempotency_key must contain 1..200 characters");
      const updated = await admin.control(db, user, task, String(b.action ?? ""), String(b.note ?? ""), {
        expectedRevision: b.expectedRevision,
        idempotencyKey: b.idempotencyKey,
      });
      return taskOut(db, updated, { detail: true, viewer: user });
    }),
  );

  app.post(
    "/api/tasks/:id/reassign",
    authed(async ({ db, user, req }) => {
      const task = await load(db, user, params(req).id);
      const [target] = await db
        .select()
        .from(roles)
        .where(eq(roles.id, String(body(req).roleId ?? "")))
        .limit(1);
      if (!target) throw new NotFound("role not found");
      const moved = await admin.reassign(db, user, task, target, String(body(req).note ?? ""));
      return taskOut(db, moved, { detail: true, viewer: user });
    }),
  );

  app.get(
    "/api/approvals",
    authed(async ({ db, user, req }) => {
      const q = query(req);
      const status = q.status ?? "pending";
      if (!["pending", "approved", "rejected", "all"].includes(status)) throw new BadRequest("invalid approval status");
      if (status === "all" && !q.topic_id) throw new BadRequest("topic_id is required for all approval statuses");
      const conds = [];
      if (status !== "all") conds.push(eq(approvals.status, status));
      if (q.topic_id) conds.push(eq(approvals.topicId, q.topic_id));
      const out = [];
      for (const a of await db
        .select()
        .from(approvals)
        .where(and(...conds))
        .orderBy(desc(approvals.createdAt))) {
        const [topic] = await db.select().from(topics).where(eq(topics.id, a.topicId)).limit(1);
        if ((await approvalSvc.canDecide(db, user, a)) || (topic && (await topicSvc.canView(db, user, topic))))
          out.push(await approvalOut(db, a, user));
      }
      return out;
    }),
  );

  app.post(
    "/api/approvals/:id/decide",
    authed(async ({ db, user, req }) => {
      const [a] = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, params(req).id))
        .limit(1);
      if (!a) throw new NotFound("approval not found");
      if (!(await approvalSvc.canDecide(db, user, a))) throw new Forbidden("you are not an approver for this request");
      const b = body(req);
      if (typeof b.approve !== "boolean") throw new BadRequest("approve must be a boolean");
      const decided = await approvalSvc.decide(
        db,
        a,
        user,
        b.approve,
        String(b.note ?? ""),
        b.scope === undefined ? "once" : b.scope,
      );
      return approvalOut(db, decided, user);
    }),
  );
}

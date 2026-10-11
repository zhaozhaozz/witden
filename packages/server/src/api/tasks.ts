import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import * as approvalSvc from "../agent/approvals.js";
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
import { Forbidden, NotFound } from "../errors.js";
import { externalContext } from "../integrations/links.js";
import { userCanRead } from "../security/labels.js";
import { hasPermission, Perm } from "../security/permissions.js";
import * as topicSvc from "../services/topics.js";
import { authed, body, params, query, row } from "./http.js";

async function canViewTask(db: Db, user: User, task: Task): Promise<boolean> {
  const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
  return (!!topic && (await topicSvc.canView(db, user, topic))) || (await hasPermission(db, user, Perm.AUDIT_VIEW));
}

/** Task text can carry material from elsewhere: show it only to people who may read every source. */
export async function contentVisible(db: Db, user: User | null, task: Task): Promise<boolean> {
  if (!user) return true;
  const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
  return !!topic && (await topicSvc.canView(db, user, topic)) && (await userCanRead(db, user.id, task.labels));
}

export async function taskOut(db: Db, task: Task, opts: { detail?: boolean; viewer?: User } = {}) {
  const exclude =
    opts.detail && opts.viewer && (await hasPermission(db, opts.viewer, Perm.ROLE_MANAGE)) ? [] : ["roleSnapshot"];
  const data: Record<string, any> = row(task, exclude);
  if (!(await contentVisible(db, opts.viewer ?? null, task))) {
    // Titles of delegated work, waits and results can carry material the task read; only structure stays visible.
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
  data.owner = role ? { id: role.id, handle: role.handle, name: role.name } : null;
  data.instance = inst ? { id: inst.id, name: inst.name, status: inst.status } : null;
  data.topic = topic ? { id: topic.id, title: topic.title, kind: topic.kind } : null;
  data.requester = requester ? { id: requester.id, name: requester.name } : null;
  if (opts.detail) {
    data.children = [];
    for (const c of await db.select().from(tasks).where(eq(tasks.parentTaskId, task.id))) {
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
  const sees = decide && (await approvalSvc.canSeeMaterial(db, user, a));
  // Held content and tool arguments are shown only to deciders who may read what the task has read.
  if (!sees)
    data.detail =
      a.action === "disclose"
        ? { sources: a.detail.sources }
        : { tool: a.detail.tool_call?.name, arguments: "[restricted]" };
  data.can_decide = a.status === "pending" && decide;
  data.can_approve = data.can_decide && sees;
  const [role] = await db.select().from(roles).where(eq(roles.id, a.roleId)).limit(1);
  data.role = role ? { id: role.id, handle: role.handle } : null;
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
      if (q.mine === "true") conds.push(eq(tasks.requesterUserId, user.id));
      const rows = await db
        .select()
        .from(tasks)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(tasks.updatedAt))
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
      // Full chain: who asked from where, assignment reasoning, computer, envelope, labels, audit.
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
        labels: task.labels,
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
      const updated = await admin.control(db, user, task, String(b.action ?? ""), String(b.note ?? ""));
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
      return taskOut(db, await admin.reassign(db, user, task, target), { detail: true, viewer: user });
    }),
  );

  app.get(
    "/api/approvals",
    authed(async ({ db, user, req }) => {
      const status = query(req).status ?? "pending";
      const out = [];
      for (const a of await db
        .select()
        .from(approvals)
        .where(eq(approvals.status, status))
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
      const decided = await approvalSvc.decide(db, a, user, !!b.approve, String(b.note ?? ""));
      return approvalOut(db, decided, user);
    }),
  );
}

/** Templates and computer instances (the management channel, plus human observation / takeover). */
import { and, desc, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { interruptInstanceTasks, pauseInstanceTasks, resumeInstanceTasks } from "../agent/control.js";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  type ComputerInstance,
  computerInstances,
  computerTemplates,
  execSessions,
  instanceBackups,
  roles,
  type Task,
  tasks,
  type User,
} from "../db/schema.js";
import { BadRequest, Conflict, Forbidden, Unavailable } from "../errors.js";
import { runtime } from "../runtime.js";
import { Perm, requirePerm } from "../security/permissions.js";
import { parseColor } from "../services/appearance.js";
import * as svc from "../services/instances.js";
import { currentLease, handBack, keepTakeover, takeOver } from "../services/leases.js";
import { modelLabel, unusableReason } from "../services/model-configs.js";
import * as proxySvc from "../services/model-proxy.js";
import { proxyModels } from "../services/model-proxy.js";
import * as tpl from "../services/templates.js";
import { canView } from "../services/topics.js";
import { authed, authedNoTx, body, params, query, row } from "./http.js";

const canSee = (db: Db, user: User, inst: ComputerInstance) => svc.canObserveInstance(db, user, inst.id);

/** Task text from many topics: only shown to people who may see the task's topic. */
async function taskTitle(db: Db, user: User, task: Task): Promise<string> {
  const { topics } = await import("../db/schema.js");
  const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
  const visible = !!topic && (await canView(db, user, topic));
  return visible ? task.title : "[restricted]";
}

async function instanceOut(db: Db, inst: ComputerInstance, opts: { detail?: boolean; user?: User } = {}) {
  const data: Record<string, any> = row(inst);
  const rs = await db.select().from(roles).where(eq(roles.instanceId, inst.id));
  data.roles = rs.map((r) => ({
    id: r.id,
    name: r.name,
    handle: r.handle,
    status: r.status,
    color: r.color,
    avatar_url: r.avatarUrl,
  }));
  const lease = await currentLease(db, inst.id);
  data.operator = lease
    ? {
        holder_type: lease.holderType,
        holder_id: lease.holderId,
        task_id: lease.taskId,
        reason: lease.reason,
        expires_at: lease.expiresAt.toISOString(),
      }
    : null;
  data.runner = runtime().hub?.status(inst.id) ?? { connected: false };
  if (opts.detail) {
    const active = await svc.activeTasksOn(db, inst.id);
    data.active_tasks = [];
    for (const t of active) {
      data.active_tasks.push({
        id: t.id,
        title: opts.user ? await taskTitle(db, opts.user, t) : "[restricted]",
        status: t.status,
        owner_role_id: t.ownerRoleId,
      });
    }
    data.waiting_tasks = data.active_tasks.filter((t: any) => t.status === "waiting_resource").map((t: any) => t.id);
    data.shared_scope = {
      note: "All roles on this computer share its files, installed software, processes and login state. Work that must stay confidential between roles belongs on separate computers.",
      shared_by_roles: rs.map((r) => r.handle),
      persistent_paths: Object.keys(inst.volumes),
      credential_paths: (inst.spec.credential_paths ?? []).map((p: string) => svc.expandPath(p, inst.spec.user)),
      home: svc.homeOf(inst.spec.user),
    };
  }
  return data;
}

async function templateOut(db: Db, t: typeof computerTemplates.$inferSelect) {
  const count = (
    await db
      .select({ id: computerInstances.id })
      .from(computerInstances)
      .where(and(eq(computerInstances.templateId, t.id), ne(computerInstances.status, "deleted")))
  ).length;
  return { ...row(t), instance_count: count };
}

/** Connection for a person observing or operating a computer (audited by the caller). */
async function humanConnection(inst: ComputerInstance) {
  await svc.ensureUsable(inst);
  const hub = runtime().hub;
  if (!hub) throw new Unavailable("this process does not host the runner hub");
  return hub.connection(inst.id, {
    containerId: inst.containerId,
    network: inst.resources.network ?? "bridge",
    waitMs: 15_000,
  });
}

export async function computerRoutes(app: FastifyInstance) {
  // --- templates ---
  app.get(
    "/api/templates",
    authed(async ({ db }) => {
      const out = [];
      for (const t of await db.select().from(computerTemplates).orderBy(computerTemplates.name))
        out.push(await templateOut(db, t));
      return out;
    }),
  );
  app.get(
    "/api/templates/:id",
    authed(async ({ db, req }) => templateOut(db, await tpl.getTemplate(db, params(req).id))),
  );
  app.post(
    "/api/templates",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.TEMPLATE_MANAGE);
      const t = await tpl.createTemplate(db, body(req), settings(), user.id);
      const { audit } = await import("../services/audit.js");
      await audit(db, "template.create", {
        actorType: "user",
        actorId: user.id,
        resourceType: "template",
        resourceId: t.id,
        detail: { name: t.name, image: t.image },
      });
      return templateOut(db, t);
    }),
  );
  app.patch(
    "/api/templates/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.TEMPLATE_MANAGE);
      let t = await tpl.getTemplate(db, params(req).id);
      const { archived, ...data } = body(req);
      if (archived !== undefined)
        [t] = await db
          .update(computerTemplates)
          .set({ archived: !!archived })
          .where(eq(computerTemplates.id, t.id))
          .returning();
      if (Object.keys(data).length) t = await tpl.updateTemplate(db, t, data, settings());
      const { audit } = await import("../services/audit.js");
      await audit(db, "template.update", {
        actorType: "user",
        actorId: user.id,
        resourceType: "template",
        resourceId: t.id,
        detail: { fields: Object.keys(data), version: t.version },
      });
      return templateOut(db, t);
    }),
  );
  app.post(
    "/api/templates/:id/copy",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.TEMPLATE_MANAGE);
      const t = await tpl.copyTemplate(
        db,
        await tpl.getTemplate(db, params(req).id),
        String(body(req).name ?? ""),
        user.id,
      );
      return templateOut(db, t);
    }),
  );
  app.delete(
    "/api/templates/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.TEMPLATE_MANAGE);
      await tpl.deleteTemplate(db, await tpl.getTemplate(db, params(req).id));
      return { ok: true };
    }),
  );
  app.post(
    "/api/templates/seed-builtin",
    authed(async ({ db, user }) => {
      await requirePerm(db, user, Perm.TEMPLATE_MANAGE);
      await tpl.seedBuiltinTemplates(db, settings());
      return { ok: true };
    }),
  );

  // --- instances ---
  app.get(
    "/api/instances",
    authed(async ({ db, user }) => {
      const out = [];
      for (const i of await svc.instancesNotDeleted(db))
        if (await canSee(db, user, i)) out.push(await instanceOut(db, i));
      return out;
    }),
  );
  app.post(
    "/api/instances",
    authed(async ({ db, user, req, after }) => {
      await requirePerm(db, user, Perm.INSTANCE_MANAGE);
      const b = body(req);
      const template = await tpl.getTemplate(db, b.templateId);
      const color = parseColor(b.color);
      let inst = await svc.createInstance(db, template, String(b.name ?? ""), b.resources ?? {}, user.id);
      if (color) {
        [inst] = await db.update(computerInstances).set({ color }).where(eq(computerInstances.id, inst.id)).returning();
      }
      await svc.recordAudit(db, user.id, "instance.create", inst, {
        template: template.name,
        resources: inst.resources,
      });
      after(() => runtime().background("provision", () => svc.opProvision(inst.id)));
      return instanceOut(db, inst);
    }),
  );
  app.get(
    "/api/instances/:id",
    authed(async ({ db, user, req }) => {
      const inst = await svc.getInstance(db, params(req).id);
      if (!(await canSee(db, user, inst))) await requirePerm(db, user, Perm.INSTANCE_OBSERVE, inst.id);
      return instanceOut(db, inst, { detail: true, user });
    }),
  );
  app.patch(
    "/api/instances/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.INSTANCE_MANAGE, params(req).id);
      const inst = await svc.getInstance(db, params(req).id);
      const b = body(req);
      const update: Partial<ComputerInstance> = {};
      if ("color" in b) update.color = parseColor(b.color);
      // The software list is installed whenever the computer starts (or now, with software/install).
      if ("software" in b) update.software = tpl.validateSoftwareList(b.software);
      if (!Object.keys(update).length) return instanceOut(db, inst, { detail: true, user });
      const [updated] = await db
        .update(computerInstances)
        .set(update)
        .where(eq(computerInstances.id, inst.id))
        .returning();
      await svc.recordAudit(db, user.id, "instance.update", updated, { fields: Object.keys(update) });
      return instanceOut(db, updated, { detail: true, user });
    }),
  );
  app.post(
    "/api/instances/:id/software/install",
    authed(async ({ db, user, req, after }) => {
      await requirePerm(db, user, Perm.INSTANCE_MANAGE, params(req).id);
      const inst = await svc.getInstance(db, params(req).id);
      if (inst.status !== "running") throw new Conflict(`computer ${inst.name} is ${inst.status}; start it first`);
      if (!inst.software.length) throw new BadRequest("the software list is empty");
      await svc.recordAudit(db, user.id, "instance.software_install", inst, { software: inst.software });
      const { installSoftwareList } = await import("../services/software.js");
      after(() => runtime().background("software", () => installSoftwareList(inst.id)));
      return { started: true, software: inst.software };
    }),
  );
  app.patch(
    "/api/instances/:id/resources",
    authed(async ({ db, user, req }) => {
      // New limits apply when the container is recreated (reset); the response says so explicitly.
      await requirePerm(db, user, Perm.INSTANCE_MANAGE, params(req).id);
      const inst = await svc.getInstance(db, params(req).id);
      const resources = tpl.validateResources({ ...inst.resources, ...(body(req).resources ?? {}) });
      const [updated] = await db
        .update(computerInstances)
        .set({ resources })
        .where(eq(computerInstances.id, inst.id))
        .returning();
      await svc.recordAudit(db, user.id, "instance.resources", inst, { resources });
      return { ...(await instanceOut(db, updated)), applies_after: "reset" };
    }),
  );
  app.get(
    "/api/instances/:id/preview/:action",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.INSTANCE_MANAGE, params(req).id);
      const inst = await svc.getInstance(db, params(req).id);
      const keep = query(req).keep_volumes !== "false";
      let out: Record<string, any>;
      if (params(req).action === "reset") out = svc.resetPreview(inst, keep);
      else if (params(req).action === "delete") out = await svc.deletePreview(db, inst);
      else throw new BadRequest("preview is available for reset and delete");
      out.active_tasks = (await svc.activeTasksOn(db, inst.id)).map((t) => t.id);
      return out;
    }),
  );
  app.post(
    "/api/instances/:id/actions",
    authed(async ({ db, user, req, after }) => {
      await requirePerm(db, user, Perm.INSTANCE_MANAGE, params(req).id);
      let inst = await svc.getInstance(db, params(req).id);
      const b = body(req);
      const action = String(b.action);
      const keepVolumes = b.keepVolumes !== false;
      if (["reset", "delete"].includes(action) && !b.confirm) {
        throw new BadRequest("destructive action: call the preview endpoint, then repeat with confirm=true", {
          code: "confirmation_required",
        });
      }
      const ops: Record<string, () => Promise<void>> = {
        start: () => svc.opStart(inst.id),
        stop: () => svc.opStop(inst.id),
        restart: () => svc.opRestart(inst.id),
        reset: () => svc.opReset(inst.id, keepVolumes),
        delete: () => svc.opDelete(inst.id),
      };
      if (!ops[action]) throw new BadRequest("unknown action");
      if (action === "reset")
        [inst] = await db
          .update(computerInstances)
          .set({ status: "creating" })
          .where(eq(computerInstances.id, inst.id))
          .returning();
      if (action === "delete") {
        [inst] = await db
          .update(computerInstances)
          .set({ status: "deleting" })
          .where(eq(computerInstances.id, inst.id))
          .returning();
        for (const r of await db.select().from(roles).where(eq(roles.instanceId, inst.id))) {
          await db
            .update(roles)
            .set({ instanceId: null, configVersion: r.configVersion + 1 })
            .where(eq(roles.id, r.id));
        }
      }
      if (["stop", "reset", "delete"].includes(action)) {
        // Running AI work cannot continue on a computer that goes away.
        await interruptInstanceTasks(db, inst.id, `computer ${inst.name}: ${action} by administrator`);
      }
      await svc.recordAudit(db, user.id, `instance.${action}`, inst, { keep_volumes: keepVolumes });
      after(() => runtime().background(`instance.${action}`, ops[action]));
      return instanceOut(db, inst);
    }),
  );
  app.get(
    "/api/instances/:id/stats",
    authedNoTx(async ({ db, user, req }) => {
      const inst = await svc.getInstance(db, params(req).id);
      if (!(await canSee(db, user, inst))) await requirePerm(db, user, Perm.INSTANCE_OBSERVE, inst.id);
      const out: Record<string, any> = { limits: inst.resources };
      if (inst.status === "running" && inst.containerId) out.usage = await runtime().manager.stats(inst.containerId);
      if (query(req).volumes === "true")
        out.volumes = await runtime().manager.volumeUsage({ volumes: Object.values(inst.volumes) });
      return out;
    }),
  );
  app.get(
    "/api/instances/:id/sessions",
    authed(async ({ db, user, req }) => {
      const inst = await svc.getInstance(db, params(req).id);
      if (!(await canSee(db, user, inst))) await requirePerm(db, user, Perm.INSTANCE_OBSERVE, inst.id);
      const rows = await db
        .select()
        .from(execSessions)
        .where(eq(execSessions.instanceId, inst.id))
        .orderBy(desc(execSessions.createdAt))
        .limit(200);
      return rows.map((s) => row(s));
    }),
  );
  // --- model proxy: a local model endpoint inside the computer, relayed and checked by the platform ---
  const proxyOut = async (db: Db, inst: ComputerInstance) => {
    const port = settings().modelProxyPort;
    return {
      enabled: inst.modelProxyEnabled,
      model_ids: inst.modelProxyModelIds,
      models: (await proxyModels(db, inst.modelProxyModelIds)).map((m) => ({
        id: m.model.id,
        alias: m.alias,
        label: modelLabel(m.model, m.provider),
        protocol: m.provider.protocol,
        usable: !unusableReason(m.model, m.provider),
      })),
      // Like every secret, the key is never shown: the runner writes it into the computer for programs there.
      has_key: !!inst.modelProxyKeyEncrypted,
      key_issued_at: inst.modelProxyKeyIssuedAt?.toISOString() ?? null,
      endpoints: {
        openai: `http://127.0.0.1:${port}/v1`,
        anthropic: `http://127.0.0.1:${port}`,
        systemone: `http://127.0.0.1:${port}`,
      },
      env_file: "~/.config/witden/model-proxy.env",
      runner_connected: !!runtime().hub?.connected(inst.id),
    };
  };
  app.get(
    "/api/instances/:id/model-proxy",
    authed(async ({ db, user, req }) => {
      const inst = await svc.getInstance(db, params(req).id);
      if (!(await canSee(db, user, inst))) await requirePerm(db, user, Perm.INSTANCE_OBSERVE, inst.id);
      return proxyOut(db, inst);
    }),
  );
  app.put(
    "/api/instances/:id/model-proxy",
    authed(async ({ db, user, req, after }) => {
      const inst = await proxySvc.updateProxy(db, user, await svc.getInstance(db, params(req).id), body(req));
      after(() => proxySvc.pushProxyConfig(inst.id));
      return proxyOut(db, inst);
    }),
  );
  app.post(
    "/api/instances/:id/model-proxy/rotate-key",
    authed(async ({ db, user, req, after }) => {
      const inst = await proxySvc.rotateProxyKey(db, user, await svc.getInstance(db, params(req).id));
      after(() => proxySvc.pushProxyConfig(inst.id));
      return proxyOut(db, inst);
    }),
  );
  app.get(
    "/api/instances/:id/screenshot",
    authedNoTx(async ({ db, user, req, reply }) => {
      if (!(await svc.canObserveInstance(db, user, params(req).id))) throw new Forbidden("cannot view this computer");
      const inst = await svc.getInstance(db, params(req).id);
      if (inst.spec.kind !== "desktop") throw new BadRequest("this computer has no desktop");
      const conn = await humanConnection(inst);
      const shot = await conn.request<{ pngBase64: string }>("screen.capture", {}, 30_000);
      reply.header("cache-control", "no-store").type("image/png");
      return Buffer.from(shot.pngBase64, "base64");
    }),
  );
  app.post(
    "/api/instances/:id/takeover",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.INSTANCE_CONTROL, params(req).id);
      const inst = await svc.getInstance(db, params(req).id);
      await takeOver(db, inst, user.id, body(req).reason ?? null);
      await pauseInstanceTasks(db, inst.id, `${user.name} took over computer ${inst.name}`);
      await svc.recordAudit(db, user.id, "instance.takeover", inst, { reason: body(req).reason });
      const { publish } = await import("../services/events.js");
      await publish(db, "instance.operator", { id: inst.id, holder: user.id }, `instance:${inst.id}`, "admin");
      return instanceOut(db, await svc.getInstance(db, inst.id), { detail: true, user });
    }),
  );
  app.post(
    "/api/instances/:id/takeover/keepalive",
    authed(async ({ db, user, req }) => {
      // The console confirms every minute that the person in control is still there (see TAKEOVER_MS).
      const inst = await svc.getInstance(db, params(req).id);
      if (!(await keepTakeover(db, inst, user.id))) throw new Conflict("you are not in control of this computer");
      return { ok: true };
    }),
  );
  app.post(
    "/api/instances/:id/handback",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.INSTANCE_CONTROL, params(req).id);
      const inst = await svc.getInstance(db, params(req).id);
      await handBack(db, inst, user.id, user.isAdmin);
      await resumeInstanceTasks(db, inst.id);
      await svc.recordAudit(db, user.id, "instance.handback", inst);
      const { publish } = await import("../services/events.js");
      await publish(db, "instance.operator", { id: inst.id, holder: null }, `instance:${inst.id}`, "admin");
      return instanceOut(db, await svc.getInstance(db, inst.id), { detail: true, user });
    }),
  );
  app.post(
    "/api/instances/:id/exec",
    authedNoTx(async ({ db, user, req }) => {
      // Operator console for people with instance.control (audited). Runs inside the computer, as its user.
      await requirePerm(db, user, Perm.INSTANCE_CONTROL, params(req).id);
      const inst = await svc.getInstance(db, params(req).id);
      const b = body(req);
      const conn = await humanConnection(inst);
      const timeout = Math.min(Number(b.timeout ?? 60), 600);
      const res = await conn.request<any>(
        "exec.run",
        { command: String(b.command ?? ""), outputLimit: 256 * 1024 },
        timeout * 1000,
      );
      await svc.recordAudit(db, user.id, "instance.exec", inst, { command: b.command, exit_code: res.exitCode });
      return { exit_code: res.exitCode, output: res.output, timed_out: res.timedOut, truncated: res.truncated };
    }),
  );
  app.get(
    "/api/instances/:id/tasks",
    authed(async ({ db, user, req }) => {
      const inst = await svc.getInstance(db, params(req).id);
      if (!(await canSee(db, user, inst))) await requirePerm(db, user, Perm.INSTANCE_OBSERVE, inst.id);
      const rows = await db
        .select()
        .from(tasks)
        .where(eq(tasks.instanceId, inst.id))
        .orderBy(desc(tasks.createdAt))
        .limit(100);
      const out = [];
      for (const t of rows) {
        const title = await taskTitle(db, user, t);
        out.push({
          id: t.id,
          title,
          status: t.status,
          owner_role_id: t.ownerRoleId,
          topic_id: t.topicId,
          progress: title === "[restricted]" ? null : t.progress,
          updated_at: t.updatedAt.toISOString(),
        });
      }
      return out;
    }),
  );

  // --- backups & clones ---
  app.get(
    "/api/instances/:id/backups",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.INSTANCE_MANAGE, params(req).id);
      const rows = await db
        .select()
        .from(instanceBackups)
        .where(eq(instanceBackups.instanceId, params(req).id))
        .orderBy(desc(instanceBackups.createdAt));
      return rows.map((b) => row(b));
    }),
  );
  app.post(
    "/api/instances/:id/backups",
    authed(async ({ db, user, req, after }) => {
      await requirePerm(db, user, Perm.INSTANCE_MANAGE, params(req).id);
      const inst = await svc.getInstance(db, params(req).id);
      if (!inst.containerId) throw new Conflict("instance has no container to back up");
      const [backup] = await db
        .insert(instanceBackups)
        .values({
          id: newId("bak"),
          instanceId: inst.id,
          note: body(req).note ?? null,
          includesCredentials: true,
          createdBy: user.id,
        })
        .returning();
      await svc.recordAudit(db, user.id, "instance.backup", inst, { backup_id: backup.id });
      after(() => runtime().background("backup", () => svc.opBackup(inst.id, backup.id)));
      return row(backup);
    }),
  );
  app.post(
    "/api/instances/:id/restore",
    authed(async ({ db, user, req, after }) => {
      await requirePerm(db, user, Perm.INSTANCE_MANAGE, params(req).id);
      const inst = await svc.getInstance(db, params(req).id);
      const b = body(req);
      const [backup] = await db
        .select()
        .from(instanceBackups)
        .where(eq(instanceBackups.id, String(b.backupId ?? "")))
        .limit(1);
      if (!backup || backup.instanceId !== inst.id) throw new BadRequest("backup does not belong to this instance");
      if (!b.confirm) {
        throw new BadRequest("restoring replaces the current container and persistent data; repeat with confirm=true", {
          code: "confirmation_required",
        });
      }
      await interruptInstanceTasks(db, inst.id, `computer ${inst.name} is being restored from a backup`);
      const [updated] = await db
        .update(computerInstances)
        .set({ status: "creating" })
        .where(eq(computerInstances.id, inst.id))
        .returning();
      await svc.recordAudit(db, user.id, "instance.restore", inst, { backup_id: backup.id });
      after(() => runtime().background("restore", () => svc.opRestore(inst.id, backup.id, false, true)));
      return instanceOut(db, updated);
    }),
  );
  app.post(
    "/api/instances/:id/clone",
    authed(async ({ db, user, req, after }) => {
      // Copy a computer's environment; credentials and login state are scrubbed unless explicitly included.
      await requirePerm(db, user, Perm.INSTANCE_MANAGE, params(req).id);
      await requirePerm(db, user, Perm.INSTANCE_MANAGE);
      const b = body(req);
      if (b.includeCredentials) await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const source = await svc.getInstance(db, params(req).id);
      const template = await tpl.getTemplate(db, source.templateId);
      let target = await svc.createInstance(db, template, String(b.name ?? ""), source.resources, user.id);
      [target] = await db
        .update(computerInstances)
        .set({ spec: source.spec, templateVersion: source.templateVersion })
        .where(eq(computerInstances.id, target.id))
        .returning();
      const [backup] = await db
        .insert(instanceBackups)
        .values({
          id: newId("bak"),
          instanceId: source.id,
          note: `clone to ${b.name}`,
          includesCredentials: true,
          createdBy: user.id,
        })
        .returning();
      await svc.recordAudit(db, user.id, "instance.clone", source, {
        target: target.id,
        include_credentials: !!b.includeCredentials,
      });
      after(() =>
        runtime().background("clone", async () => {
          await svc.opBackup(source.id, backup.id);
          await svc.opRestore(target.id, backup.id, !b.includeCredentials, false);
        }),
      );
      return instanceOut(db, target);
    }),
  );
}

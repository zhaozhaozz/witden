import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { TOOL_GROUPS, TOOLS } from "../agent/tools.js";
import type { Db } from "../db/client.js";
import {
  agentSessions,
  type ComputerInstance,
  computerInstances,
  type ModelConfig,
  type ModelProvider,
  type Role,
  roles,
  topics,
} from "../db/schema.js";
import { hasPermission, Perm, requirePerm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { modelLabel, modelWithProvider, tokensToday, unusableReason } from "../services/model-configs.js";
import * as svc from "../services/roles.js";
import { canView } from "../services/topics.js";
import { authed, body, params, row } from "./http.js";

/** Configuration problems that would make work fail later, shown up front. */
export function roleWarnings(
  role: Role,
  inst: ComputerInstance | undefined,
  cfg: ModelConfig | undefined,
  provider?: ModelProvider,
): string[] {
  const out: string[] = [];
  const caps = cfg?.capabilities ?? {};
  const unusable = cfg ? unusableReason(cfg, provider) : null;
  if (role.runtime === "external") {
    if (!role.runtimeConfig?.command) out.push("external runtime without a command: tasks will fail");
  } else if (!cfg) out.push("no model configured: the role cannot work");
  else if (unusable) out.push(`${unusable}: the role cannot work`);
  else if (cfg.status === "unchecked") out.push(`model ${modelLabel(cfg, provider)} has not been checked yet`);
  if (role.runtime !== "external" && role.allowedTools.length && caps.tools === false)
    out.push("the model cannot call tools: the role can only chat");
  if ((role.allowedTools.includes("desktop") || role.allowedTools.includes("browser")) && caps.vision === false) {
    out.push("the model cannot understand images: screenshots will be refused");
  }
  if (!inst) out.push("no computer assigned: tasks cannot run");
  else if (role.allowedTools.includes("desktop") && inst.spec.kind !== "desktop")
    out.push(`computer ${inst.name} has no desktop`);
  else if (inst.status !== "running") out.push(`computer ${inst.name} is ${inst.status}`);
  return out;
}

async function roleOut(db: Db, role: Role, full: boolean) {
  const data: Record<string, any> = row(role);
  const [inst] = role.instanceId
    ? await db.select().from(computerInstances).where(eq(computerInstances.id, role.instanceId)).limit(1)
    : [];
  const found = await modelWithProvider(db, role.modelConfigId);
  const cfg = found?.model;
  data.instance = inst ? { id: inst.id, name: inst.name, status: inst.status, kind: inst.spec.kind } : null;
  data.model = found
    ? {
        id: found.model.id,
        name: found.model.name,
        label: modelLabel(found.model, found.provider),
        provider: { id: found.provider.id, name: found.provider.name },
        capabilities: found.model.capabilities,
        status: found.model.status,
      }
    : null;
  data.warnings = roleWarnings(role, inst, cfg, found?.provider);
  if (!full) {
    // Members who can merely use a role see its public identity, not its prompt or wiring.
    for (const k of [
      "system_prompt",
      "model_params",
      "allowed_contacts",
      "knowledge_space_ids",
      "approval_required",
      "created_by",
      "runtime_config",
    ])
      delete data[k];
  } else {
    data.tokens_today = await tokensToday(db, { roleId: role.id });
  }
  return data;
}

export async function roleRoutes(app: FastifyInstance) {
  app.get(
    "/api/roles/tool-groups",
    authed(async () => [
      ...Object.entries(TOOL_GROUPS).map(([group, description]) => ({
        group,
        description,
        tools: [...TOOLS.values()].filter((t) => t.group === group).map((t) => t.name),
      })),
      {
        group: null,
        description: "always available",
        tools: [...TOOLS.values()].filter((t) => t.group === null).map((t) => t.name),
      },
    ]),
  );

  app.get(
    "/api/roles",
    authed(async ({ db, user }) => {
      const manage = await hasPermission(db, user, Perm.ROLE_MANAGE);
      const out = [];
      for (const r of await db.select().from(roles).orderBy(roles.name)) {
        if (manage) out.push(await roleOut(db, r, true));
        else if (
          (await hasPermission(db, user, Perm.ROLE_USE, r.id)) ||
          (await hasPermission(db, user, Perm.ROLE_INVITE, r.id))
        ) {
          out.push(await roleOut(db, r, false));
        }
      }
      return out;
    }),
  );

  app.get(
    "/api/roles/:id",
    authed(async ({ db, user, req }) => {
      const role = await svc.getRole(db, params(req).id);
      if (await hasPermission(db, user, Perm.ROLE_MANAGE))
        return { ...(await roleOut(db, role, true)), impact: await svc.impact(db, role) };
      await requirePerm(db, user, Perm.ROLE_USE, role.id);
      return roleOut(db, role, false);
    }),
  );

  /** A role's agent sessions: one per topic, listed only for topics the viewer can read. */
  app.get(
    "/api/roles/:id/sessions",
    authed(async ({ db, user, req }) => {
      const role = await svc.getRole(db, params(req).id);
      const out = [];
      for (const s of await db.select().from(agentSessions).where(eq(agentSessions.roleId, role.id))) {
        const [topic] = await db.select().from(topics).where(eq(topics.id, s.topicId)).limit(1);
        if (topic && (await canView(db, user, topic)))
          out.push({ ...row(s), topic: { id: topic.id, title: topic.title, kind: topic.kind } });
      }
      return out;
    }),
  );

  app.post(
    "/api/roles",
    authed(async ({ db, user, req }) => {
      const role = await svc.createRole(db, user, body(req));
      await audit(db, "role.create", {
        actorType: "user",
        actorId: user.id,
        resourceType: "role",
        resourceId: role.id,
        roleId: role.id,
        detail: { handle: role.handle, instance: role.instanceId, model: role.modelConfigId, runtime: role.runtime },
      });
      return roleOut(db, role, true);
    }),
  );

  app.patch(
    "/api/roles/:id",
    authed(async ({ db, user, req }) => {
      const role = await svc.getRole(db, params(req).id);
      const result = await svc.updateRole(db, user, role, body(req));
      await audit(db, "role.update", {
        actorType: "user",
        actorId: user.id,
        resourceType: "role",
        resourceId: role.id,
        roleId: role.id,
        detail: { changes: result.changes, config_version: result.role.configVersion },
      });
      return { ...(await roleOut(db, result.role, true)), result: { changes: result.changes, impact: result.impact } };
    }),
  );

  app.post(
    "/api/roles/:id/copy",
    authed(async ({ db, user, req }) => {
      const b = body(req);
      const clone = await svc.copyRole(
        db,
        user,
        await svc.getRole(db, params(req).id),
        String(b.handle ?? ""),
        b.name ?? null,
        b.instanceId ?? null,
      );
      await audit(db, "role.copy", {
        actorType: "user",
        actorId: user.id,
        resourceType: "role",
        resourceId: clone.id,
        roleId: clone.id,
        detail: { from: params(req).id },
      });
      return roleOut(db, clone, true);
    }),
  );

  app.post(
    "/api/roles/:id/disable",
    authed(async ({ db, user, req }) => {
      const b = body(req);
      const role = await svc.getRole(db, params(req).id);
      const result = await svc.disableRole(db, user, role, b.onTasks ?? "pause", b.reassignTo ?? null);
      await audit(db, "role.disable", {
        actorType: "user",
        actorId: user.id,
        resourceType: "role",
        resourceId: role.id,
        roleId: role.id,
        detail: result,
      });
      return { ...(await roleOut(db, await svc.getRole(db, role.id), true)), result };
    }),
  );

  app.post(
    "/api/roles/:id/enable",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.ROLE_MANAGE);
      const [role] = await db
        .update(roles)
        .set({ status: "active" })
        .where(eq(roles.id, params(req).id))
        .returning();
      await audit(db, "role.enable", {
        actorType: "user",
        actorId: user.id,
        resourceType: "role",
        resourceId: role.id,
      });
      return roleOut(db, role, true);
    }),
  );
}

export { and };

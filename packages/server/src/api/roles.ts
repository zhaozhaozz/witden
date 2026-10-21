import "@fastify/multipart";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_ALLOWED_TOOLS, DEFAULT_APPROVAL_REQUIRED, TOOL_GROUPS, TOOLS } from "../agent/tools.js";
import { type Db, transaction } from "../db/client.js";
import {
  agentSessions,
  type ComputerInstance,
  computerInstances,
  connections,
  type ModelConfig,
  type ModelProvider,
  type Role,
  roles,
  topics,
} from "../db/schema.js";
import { BadRequest } from "../errors.js";
import { FEISHU_PRODUCTS } from "../integrations/feishu-tools.js";
import { GITHUB_PRODUCTS } from "../integrations/github-tools.js";
import { hasPermission, Perm, requirePerm } from "../security/permissions.js";
import { avatarFile, MAX_AVATAR_BYTES, saveAvatar } from "../services/appearance.js";
import { audit } from "../services/audit.js";
import { effortChoices } from "../services/effort.js";
import { modelLabel, modelWithProvider, tokensToday, unusableReason } from "../services/model-configs.js";
import * as svc from "../services/roles.js";
import { canView } from "../services/topics.js";
import { authed, authedNoTx, body, params, row } from "./http.js";
import { sessionOut } from "./sessions.js";

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
  if (!cfg) out.push("no model configured: the role cannot work");
  else if (unusable) out.push(`${unusable}: the role cannot work`);
  else if (cfg.status === "unchecked") out.push(`model ${modelLabel(cfg, provider)} has not been checked yet`);
  if (role.allowedTools.length && caps.tools === false) out.push("the model cannot call tools: the role can only chat");
  if ((role.allowedTools.includes("desktop") || role.allowedTools.includes("browser")) && caps.vision === false) {
    out.push("the model cannot understand images: screenshots will be refused");
  }
  // A system administrator works on witden itself and needs no computer.
  if (!inst) out.push(...(role.systemAdmin ? [] : ["no computer assigned: tasks cannot run"]));
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
  data.instance = inst
    ? { id: inst.id, name: inst.name, status: inst.status, kind: inst.spec.kind, color: inst.color }
    : null;
  data.model = found
    ? {
        id: found.model.id,
        name: found.model.name,
        label: modelLabel(found.model, found.provider),
        provider: { id: found.provider.id, name: found.provider.name },
        capabilities: found.model.capabilities,
        status: found.model.status,
        effort: effortChoices(found.provider.protocol, found.model),
      }
    : null;
  data.warnings = roleWarnings(role, inst, cfg, found?.provider);
  // Whom a role may contact is decided by topics now; the old list is neither shown nor used.
  delete data.allowed_contacts;
  if (!full) {
    // Members who can merely use a role see its public identity, not its prompt or wiring.
    for (const k of ["system_prompt", "model_params", "knowledge_space_ids", "approval_required", "created_by"])
      delete data[k];
  } else {
    data.tokens_today = await tokensToday(db, { roleId: role.id });
  }
  return data;
}

/** An uploaded avatar, without login: also served on the webhook listener, as Slack fetches role icons itself. */
export async function serveAvatar(req: FastifyRequest, reply: FastifyReply) {
  const found = avatarFile(params(req).file);
  if (!found) return reply.code(404).send({ error: { code: "not_found", message: "no such avatar", detail: {} } });
  return reply
    .header("content-type", found.type)
    .header("cache-control", "public, max-age=31536000, immutable")
    .header("x-content-type-options", "nosniff")
    .send(fs.createReadStream(found.file));
}

export async function roleRoutes(app: FastifyInstance) {
  // The connection tools a role can be given (Feishu, GitHub), per product, and the connections to give them for.
  for (const [platform, products] of [
    ["feishu", FEISHU_PRODUCTS],
    ["github", GITHUB_PRODUCTS],
  ] as const)
    app.get(
      `/api/roles/${platform}-tools`,
      authed(async ({ db, user }) => {
        await requirePerm(db, user, Perm.ROLE_MANAGE);
        const toolsOf = (key: string, mode: string) =>
          [...TOOLS.values()].filter((t) => t.group === `${platform}:${key}:${mode}`).map((t) => t.name);
        const apps = await db.select().from(connections).where(eq(connections.platform, platform));
        return {
          products: products.map((p) => ({
            key: p.key,
            label: p.label,
            description: p.description,
            read: toolsOf(p.key, "read"),
            write: toolsOf(p.key, "write"),
          })),
          apps: apps
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => ({
              id: c.id,
              name: c.name,
              status: c.status,
              // GitHub: as whom it acts, and whether it only authenticates (takes no messages)
              ...(platform === "github" ? { acts_as: c.botUserId, auth_only: !!c.settings.auth_only } : {}),
            })),
        };
      }),
    );

  app.get(
    "/api/roles/tool-groups",
    authed(async () => [
      ...Object.entries(TOOL_GROUPS).map(([group, description]) => {
        const tools = [...TOOLS.values()].filter((t) => t.group === group).map((t) => t.name);
        // What a new role gets: the group's level, and single tools that ask under an allowed group.
        const level = !DEFAULT_ALLOWED_TOOLS.includes(group)
          ? "off"
          : DEFAULT_APPROVAL_REQUIRED.includes(group)
            ? "ask"
            : "allow";
        return {
          group,
          description,
          tools,
          default_level: level,
          default_ask: level === "allow" ? tools.filter((t) => DEFAULT_APPROVAL_REQUIRED.includes(t)) : [],
        };
      }),
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

  // --- avatars: uploaded images are stored by content hash and served without login (img tags, Slack) ---
  app.post(
    "/api/roles/:id/avatar",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.ROLE_MANAGE);
      await svc.getRole(db, params(req).id);
      const file = await req.file({ limits: { fileSize: MAX_AVATAR_BYTES + 1 } });
      if (!file) throw new BadRequest("file is required");
      const url = saveAvatar(await file.toBuffer());
      return transaction(async (tx) => {
        const [role] = await tx
          .update(roles)
          .set({ avatarUrl: url })
          .where(eq(roles.id, params(req).id))
          .returning();
        await audit(tx, "role.avatar", {
          actorType: "user",
          actorId: user.id,
          roleId: role.id,
          detail: { avatar: url },
        });
        return roleOut(tx, role, true);
      });
    }),
  );
  app.delete(
    "/api/roles/:id/avatar",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.ROLE_MANAGE);
      const [role] = await db
        .update(roles)
        .set({ avatarUrl: null })
        .where(eq(roles.id, (await svc.getRole(db, params(req).id)).id))
        .returning();
      await audit(db, "role.avatar", {
        actorType: "user",
        actorId: user.id,
        roleId: role.id,
        detail: { avatar: null },
      });
      return roleOut(db, role, true);
    }),
  );
  /** Store an image and return its URL without assigning it (editors save it with the role's other fields). */
  app.post(
    "/api/avatars",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.ROLE_MANAGE);
      const file = await req.file({ limits: { fileSize: MAX_AVATAR_BYTES + 1 } });
      if (!file) throw new BadRequest("file is required");
      return { avatar_url: saveAvatar(await file.toBuffer()) };
    }),
  );
  app.get("/api/avatars/:file", serveAvatar);

  /** A role's agent sessions: one per topic, listed only for topics the viewer can read. */
  app.get(
    "/api/roles/:id/sessions",
    authed(async ({ db, user, req }) => {
      const role = await svc.getRole(db, params(req).id);
      const out = [];
      for (const s of await db.select().from(agentSessions).where(eq(agentSessions.roleId, role.id))) {
        const [topic] = await db.select().from(topics).where(eq(topics.id, s.topicId)).limit(1);
        if (topic && (await canView(db, user, topic)))
          out.push({ ...(await sessionOut(db, s)), topic: { id: topic.id, title: topic.title, kind: topic.kind } });
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
        detail: { handle: role.handle, instance: role.instanceId, model: role.modelConfigId },
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
      const result = await svc.disableRole(db, user, role, b.onTasks ?? "keep");
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
      const resumed = await svc.resumeKeptTasks(db, role);
      await audit(db, "role.enable", {
        actorType: "user",
        actorId: user.id,
        resourceType: "role",
        resourceId: role.id,
        detail: { resumed_tasks: resumed },
      });
      return roleOut(db, role, true);
    }),
  );
}

export { and };

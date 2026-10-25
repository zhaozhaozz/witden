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
  type RoleSkill,
  type RoleSkillFile,
  roles,
  topics,
  type User,
} from "../db/schema.js";
import { BadRequest, Conflict } from "../errors.js";
import { FEISHU_PRODUCTS } from "../integrations/feishu-tools.js";
import { GITHUB_PRODUCTS } from "../integrations/github-tools.js";
import { hasPermission, Perm, requirePerm } from "../security/permissions.js";
import { avatarFile, MAX_AVATAR_BYTES, saveAvatar } from "../services/appearance.js";
import { audit } from "../services/audit.js";
import { effortChoices } from "../services/effort.js";
import { MAX_UPLOAD_BYTES, mimeOf } from "../services/files.js";
import { modelLabel, modelWithProvider, tokensToday, unusableReason } from "../services/model-configs.js";
import * as skills from "../services/role-skills.js";
import * as svc from "../services/roles.js";
import { canView } from "../services/topics.js";
import { authed, authedNoTx, body, params, query, row } from "./http.js";
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
  if (!full) {
    // Members who can merely use a role see its public identity, not its prompt or wiring.
    for (const k of [
      "system_prompt",
      "model_params",
      "knowledge_space_ids",
      "approval_required",
      "allowed_contacts",
      "created_by",
    ])
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

/** Bodies taken as raw bytes on the routes that accept a file as the request body. */
const RAW_TYPES = ["application/octet-stream", "application/gzip", "application/x-gzip", "application/x-tar"];

const isTrue = (v: unknown) => v === true || v === "true" || v === "1" || v === "on";
const flag = (v: unknown): boolean | undefined => (v === undefined || v === null || v === "" ? undefined : isTrue(v));

/**
 * The file a request carries: multipart (field "file", with an "executable" field before it), the raw body, or
 * JSON { content: text, executable }; ``?executable=`` for the others. At most what people may upload.
 */
async function uploaded(req: FastifyRequest): Promise<{ data: Buffer; executable?: boolean }> {
  const q = query(req);
  let data: Buffer;
  let executable = flag(q.executable);
  if (req.isMultipart()) {
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES + 1 } });
    if (!file) throw new BadRequest("file is required");
    data = await file.toBuffer();
    const field = file.fields.executable as { value?: unknown } | undefined;
    if (field && "value" in field) executable = flag(field.value);
  } else if (Buffer.isBuffer(req.body)) data = req.body;
  else if (typeof req.body === "string") data = Buffer.from(req.body);
  else {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.content !== "string")
      throw new BadRequest("send the file as multipart (field file), as the request body, or as JSON with content");
    data = Buffer.from(b.content);
    if (b.executable !== undefined) executable = flag(b.executable);
  }
  if (data.length > MAX_UPLOAD_BYTES) throw new BadRequest("file too large (50 MB max)");
  return { data, executable };
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

  // --- skills: instructions for kinds of work, listed in every prompt of the role (services/role-skills.ts) ---
  const fileOut = (f: RoleSkillFile) => row(f, ["storageKey"]);
  const skillOut = (s: RoleSkill, files: RoleSkillFile[]) => ({ ...row(s, ["deletedAt"]), files: files.map(fileOut) });
  const withFiles = async (db: Db, s: RoleSkill) => skillOut(s, await skills.filesOf(db, s.id));
  const person = (user: User) => ({ type: "user", id: user.id }) as const;
  /** Role managers keep skills, as they keep role memory. */
  async function skillRole(db: Db, user: User, id: string): Promise<Role> {
    await requirePerm(db, user, Perm.ROLE_MANAGE);
    return svc.getRole(db, id);
  }
  /** The skill a request names, under its role. */
  async function requestSkill(db: Db, user: User, req: FastifyRequest) {
    const role = await skillRole(db, user, params(req).id);
    return { role, skill: await skills.getSkill(db, role.id, params(req).skillId) };
  }
  app.get(
    "/api/roles/:id/skills",
    authed(async ({ db, user, req }) => {
      const role = await skillRole(db, user, params(req).id);
      const rows = await skills.skillsOf(db, role.id);
      const files = await skills.filesBySkill(
        db,
        rows.map((s) => s.id),
      );
      return rows.map((s) => skillOut(s, files.get(s.id) ?? []));
    }),
  );
  app.get(
    "/api/roles/:id/skills/:skillId",
    authed(async ({ db, user, req }) => withFiles(db, (await requestSkill(db, user, req)).skill)),
  );
  app.post(
    "/api/roles/:id/skills",
    authed(async ({ db, user, req }) => {
      const role = await skillRole(db, user, params(req).id);
      const fields = skills.skillFields(body(req)) as skills.SkillFields;
      const skill = await skills.createSkill(db, role, fields, person(user));
      await audit(db, "skill.create", {
        actorType: "user",
        actorId: user.id,
        resourceType: "skill",
        resourceId: skill.id,
        roleId: role.id,
        detail: { skill: skill.name },
      });
      return skillOut(skill, []);
    }),
  );
  app.patch(
    "/api/roles/:id/skills/:skillId",
    authed(async ({ db, user, req }) => {
      const { role, skill } = await requestSkill(db, user, req);
      const fields = skills.skillFields(body(req), { partial: true });
      const updated = await skills.changeSkill(db, skill, fields, person(user));
      await audit(db, "skill.update", {
        actorType: "user",
        actorId: user.id,
        resourceType: "skill",
        resourceId: skill.id,
        roleId: role.id,
        detail: { skill: updated.name, fields: Object.keys(fields) },
      });
      return withFiles(db, updated);
    }),
  );
  // Changes that drop stored file content commit first (services/role-skills.ts: SkillBlobs), so they hold no
  // request transaction.
  app.delete(
    "/api/roles/:id/skills/:skillId",
    authedNoTx(async ({ user, req }) => {
      const blobs = new skills.SkillBlobs();
      return blobs.run(() =>
        transaction(async (db) => {
          const { role, skill } = await requestSkill(db, user, req);
          await skills.deleteSkill(db, skill, blobs);
          await audit(db, "skill.delete", {
            actorType: "user",
            actorId: user.id,
            resourceType: "skill",
            resourceId: skill.id,
            roleId: role.id,
            detail: { skill: skill.name },
          });
          return { ok: true };
        }),
      );
    }),
  );

  // A skill's files: listed with the skill, downloaded, uploaded and deleted one by one under their path.
  const audited = (db: Db, user: User, role: Role, skill: RoleSkill, file: string, change: string) =>
    audit(db, "skill.update", {
      actorType: "user",
      actorId: user.id,
      resourceType: "skill",
      resourceId: skill.id,
      roleId: role.id,
      detail: { skill: skill.name, file, change },
    });
  app.get(
    "/api/roles/:id/skills/:skillId/files",
    authed(async ({ db, user, req }) =>
      (await skills.filesOf(db, (await requestSkill(db, user, req)).skill.id)).map(fileOut),
    ),
  );
  app.get(
    "/api/roles/:id/skills/:skillId/files/*",
    authed(async ({ db, user, req, reply }) => {
      const { skill } = await requestSkill(db, user, req);
      const file = await skills.getSkillFile(db, skill, params(req)["*"]);
      reply
        .header(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(file.path.split("/").pop()!)}`,
        )
        .header("x-content-type-options", "nosniff")
        .type(mimeOf(file.path));
      return skills.skillFileStream(file);
    }),
  );
  app.patch(
    "/api/roles/:id/skills/:skillId/files/*",
    authed(async ({ db, user, req }) => {
      const { role, skill } = await requestSkill(db, user, req);
      const file = await skills.getSkillFile(db, skill, params(req)["*"]);
      const b = body(req);
      if (typeof b.executable !== "boolean") throw new BadRequest("give executable: true or false");
      const updated = await skills.setSkillFileExecutable(db, skill, file, b.executable, person(user));
      await audited(db, user, role, skill, file.path, b.executable ? "executable" : "not executable");
      return fileOut(updated);
    }),
  );
  app.delete(
    "/api/roles/:id/skills/:skillId/files/*",
    authedNoTx(async ({ user, req }) => {
      const blobs = new skills.SkillBlobs();
      return blobs.run(() =>
        transaction(async (db) => {
          const { role, skill } = await requestSkill(db, user, req);
          const file = await skills.getSkillFile(db, skill, params(req)["*"]);
          await skills.deleteSkillFile(db, skill, file, person(user), blobs);
          await audited(db, user, role, skill, file.path, "delete");
          return { ok: true };
        }),
      );
    }),
  );
  /** The whole skill as a .tar.gz: SKILL.md (name and description as front matter, then the content) and its files. */
  app.get(
    "/api/roles/:id/skills/:skillId/archive",
    authed(async ({ db, user, req, reply }) => {
      const { skill } = await requestSkill(db, user, req);
      const files = await skills.filesOf(db, skill.id);
      reply.header("content-disposition", `attachment; filename="${skill.name}.tar.gz"`).type("application/gzip");
      return skills.skillArchive(skill, files);
    }),
  );
  // Uploads come as multipart (like other uploads), as the raw body, or (text only) as JSON: the raw body is parsed
  // for these routes alone.
  await app.register(async (raw) => {
    raw.addContentTypeParser(RAW_TYPES, { parseAs: "buffer" }, (_req, data, done) => done(null, data));
    raw.put(
      "/api/roles/:id/skills/:skillId/files/*",
      authedNoTx(async ({ user, req }) => {
        // Who may, and whether the skill exists, before the upload is read.
        await transaction((db) => requestSkill(db, user, req));
        const path = skills.skillFilePath(params(req)["*"]);
        const up = await uploaded(req);
        const blobs = new skills.SkillBlobs();
        return blobs.run(() =>
          transaction(async (db) => {
            const { role, skill } = await requestSkill(db, user, req);
            const { file, created } = await skills.putSkillFile(
              db,
              skill,
              { path, data: up.data, executable: up.executable },
              person(user),
              blobs,
            );
            await audited(db, user, role, skill, file.path, created ? "add" : "replace");
            return fileOut(file);
          }),
        );
      }),
    );
    /**
     * Create a skill from an archive (.tar.gz or .tar, as downloaded): its name from ?name=, the front matter of
     * SKILL.md or the archive's directory. A skill of that name is replaced only with ?replace=true.
     */
    raw.post(
      "/api/roles/:id/skills/import",
      authedNoTx(async ({ user, req }) => {
        await transaction((db) => skillRole(db, user, params(req).id));
        const q = query(req);
        const { data } = await uploaded(req);
        const blobs = new skills.SkillBlobs();
        return blobs.run(async () => {
          const read = await skills.readSkillArchive(data, blobs);
          const md = skills.parseSkillMarkdown(read.markdown);
          const fields = skills.skillFields({
            name: q.name || md.name || read.dirName || "",
            description: md.description ?? q.description,
            content: md.content,
          }) as skills.SkillFields;
          return transaction(async (db) => {
            const role = await skillRole(db, user, params(req).id);
            const by = person(user);
            const current = await skills.skillByName(db, role.id, fields.name);
            if (current && !isTrue(q.replace))
              throw new Conflict(
                `there is already a skill named ${fields.name}; import with replace=true to replace it`,
              );
            const skill = current
              ? await skills.changeSkill(db, current, fields, by)
              : await skills.createSkill(db, role, fields, by);
            await skills.replaceSkillFiles(db, skill, read.files, by, blobs);
            await audit(db, current ? "skill.update" : "skill.create", {
              actorType: "user",
              actorId: user.id,
              resourceType: "skill",
              resourceId: skill.id,
              roleId: role.id,
              detail: {
                skill: skill.name,
                import: true,
                files: read.files.length,
                ...(current ? { fields: ["description", "content", "files"] } : {}),
              },
            });
            return { ...(await withFiles(db, skill)), skipped: read.skipped };
          });
        });
      }),
    );
  });

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
    // The skills' files are copied as new content (services/role-skills.ts: SkillBlobs): no request transaction.
    authedNoTx(async ({ user, req }) => {
      const b = body(req);
      const blobs = new skills.SkillBlobs();
      return blobs.run(() =>
        transaction(async (db) => {
          const { clone, skills: copied } = await svc.copyRole(
            db,
            user,
            await svc.getRole(db, params(req).id),
            String(b.handle ?? ""),
            b.name ?? null,
            b.instanceId ?? null,
            blobs,
          );
          await audit(db, "role.copy", {
            actorType: "user",
            actorId: user.id,
            resourceType: "role",
            resourceId: clone.id,
            roleId: clone.id,
            detail: { from: params(req).id, skills: copied },
          });
          return roleOut(db, clone, true);
        }),
      );
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

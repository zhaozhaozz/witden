import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ACTIVE, cancelTree, pause } from "../agent/control.js";
import {
  ADMIN_TOOL_GROUPS,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_APPROVAL_REQUIRED,
  TOOL_GROUPS,
  TOOLS,
} from "../agent/tools.js";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  computerInstances,
  knowledgeSpaces,
  memories,
  modelConfigs,
  type Role,
  roles,
  tasks,
  topicParticipants,
  type User,
} from "../db/schema.js";
import { BadRequest, Conflict, NotFound } from "../errors.js";
import { hasPermission, Perm, requirePerm } from "../security/permissions.js";
import { parseAvatarUrl, parseColor } from "./appearance.js";
import { EFFORT_LEVELS, effortChoices } from "./effort.js";
import { getProvider, isSystemOne, modelWithProvider } from "./model-configs.js";

const HANDLE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
/** Changing these alters how a role behaves; running work keeps its snapshot, new work uses the new one. */
const BEHAVIOUR_FIELDS = new Set([
  "systemPrompt",
  "modelConfigId",
  "modelParams",
  "instanceId",
  "allowedTools",
  "systemAdmin",
  "reasoningEffort",
]);
/** Field names as the REST API spells them. */
const apiName = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export async function getRole(db: Db, id: string): Promise<Role> {
  const [role] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!role) throw new NotFound("role not found");
  return role;
}

async function validate(db: Db, user: User, data: Record<string, any>, current?: Role): Promise<Partial<Role>> {
  const out: Partial<Role> = {};
  if ("handle" in data) {
    const handle = String(data.handle ?? "").toLowerCase();
    if (!HANDLE.test(handle)) throw new BadRequest("handle must be 1-32 chars: lowercase letters, digits, _ . -");
    const [clash] = await db.select().from(roles).where(eq(roles.handle, handle)).limit(1);
    if (clash && clash.id !== current?.id) throw new Conflict(`handle @${handle} is taken`);
    out.handle = handle;
  }
  for (const key of [
    "name",
    "description",
    "systemPrompt",
    "maxSteps",
    "maxTokensPerTask",
    "dailyTokenLimit",
    "modelParams",
  ] as const) {
    if (key in data) (out as any)[key] = data[key];
  }
  if ("avatarUrl" in data) out.avatarUrl = parseAvatarUrl(data.avatarUrl);
  if ("color" in data) out.color = parseColor(data.color);
  if ("modelConfigId" in data) {
    if (data.modelConfigId) {
      const [cfg] = await db.select().from(modelConfigs).where(eq(modelConfigs.id, data.modelConfigId)).limit(1);
      if (!cfg) throw new NotFound("model config not found");
      if (isSystemOne(await getProvider(db, cfg.providerId)))
        throw new BadRequest(
          `${cfg.name} is a System One decision model: it cannot chat or use tools, so no role can work with it`,
        );
      if (
        !(await hasPermission(db, user, Perm.SECRETS_MANAGE)) &&
        !(await hasPermission(db, user, Perm.MODEL_USE, cfg.id))
      ) {
        throw new BadRequest(`you may not assign model config ${cfg.name}`);
      }
      out.modelConfigId = cfg.id;
    } else out.modelConfigId = null;
  }
  if ("instanceId" in data) {
    if (data.instanceId) {
      const [inst] = await db
        .select()
        .from(computerInstances)
        .where(eq(computerInstances.id, data.instanceId))
        .limit(1);
      if (!inst || inst.status === "deleted") throw new NotFound("instance not found");
      await requirePerm(db, user, Perm.INSTANCE_MANAGE, inst.id);
      out.instanceId = inst.id;
    } else out.instanceId = null;
  }
  if ("reasoningEffort" in data) {
    const effort = data.reasoningEffort ? String(data.reasoningEffort) : null;
    if (effort && !EFFORT_LEVELS.includes(effort))
      throw new BadRequest(
        `reasoning_effort must be one of ${EFFORT_LEVELS.join(", ")}, or null for the model's default`,
      );
    out.reasoningEffort = effort;
  }
  // The effort must be one the role's model takes (as reported by its service, or the common levels).
  const effort = out.reasoningEffort !== undefined ? out.reasoningEffort : current?.reasoningEffort;
  const modelId = out.modelConfigId !== undefined ? out.modelConfigId : current?.modelConfigId;
  if (effort && modelId && ("reasoningEffort" in data || "modelConfigId" in data)) {
    const found = await modelWithProvider(db, modelId);
    if (found) {
      const { levels, source } = effortChoices(found.provider.protocol, found.model.model, found.model.capabilities);
      if (!levels.includes(effort))
        throw new BadRequest(
          source === "common"
            ? `${effort} is not an effort level for ${found.provider.protocol} models; use ${levels.join(", ")}`
            : `${found.model.name} takes effort ${levels.join(", ") || "(none: it has no effort setting)"}, not ${effort}`,
        );
    }
  }
  // The system administrator is built in (services/system-admin.ts): no role becomes one or stops being one.
  if ("systemAdmin" in data && !!data.systemAdmin !== (current?.systemAdmin ?? false))
    throw new BadRequest(
      "the system administrator is built in: no role can be made one, and it cannot become an ordinary role",
    );
  const admin = current?.systemAdmin ?? false;
  if ("allowedTools" in data) {
    const unknown = (data.allowedTools ?? []).filter((t: string) => !(t in TOOL_GROUPS));
    if (unknown.length)
      throw new BadRequest(
        `unknown tool groups ${unknown.join(", ")}; available: ${Object.keys(TOOL_GROUPS).join(", ")}`,
      );
    out.allowedTools = [...new Set<string>(data.allowedTools)].sort();
  }
  if (!admin && (out.allowedTools ?? current?.allowedTools ?? []).some((t) => ADMIN_TOOL_GROUPS.has(t)))
    throw new BadRequest("the config tools are only for system administrator roles");
  if ("approvalRequired" in data) {
    const unknown = (data.approvalRequired ?? []).filter((t: string) => !(t in TOOL_GROUPS) && !TOOLS.has(t));
    if (unknown.length) throw new BadRequest(`unknown tools ${unknown.join(", ")}`);
    out.approvalRequired = [...new Set<string>(data.approvalRequired)].sort();
  }
  if ("allowedContacts" in data) {
    const contacts = [...new Set<string>(data.allowedContacts ?? [])];
    for (const rid of contacts) {
      if (rid !== "*" && !(await db.select({ id: roles.id }).from(roles).where(eq(roles.id, rid)).limit(1)).length) {
        throw new NotFound(`contact role ${rid} not found`);
      }
    }
    out.allowedContacts = contacts;
  }
  if ("knowledgeSpaceIds" in data) {
    const ids = [...new Set<string>(data.knowledgeSpaceIds ?? [])];
    for (const sid of ids) {
      if (
        !(await db.select({ id: knowledgeSpaces.id }).from(knowledgeSpaces).where(eq(knowledgeSpaces.id, sid)).limit(1))
          .length
      ) {
        throw new NotFound(`knowledge space ${sid} not found`);
      }
    }
    out.knowledgeSpaceIds = ids;
  }
  return out;
}

export async function createRole(db: Db, user: User, data: Record<string, any>): Promise<Role> {
  await requirePerm(db, user, Perm.ROLE_MANAGE);
  if (!data.name || !data.handle) throw new BadRequest("name and handle are required");
  const clean = await validate(db, user, {
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    approvalRequired: DEFAULT_APPROVAL_REQUIRED,
    ...data,
  });
  const [role] = await db
    .insert(roles)
    .values({ id: newId("role"), createdBy: user.id, ...(clean as any) })
    .returning();
  return role;
}

export async function impact(db: Db, role: Role) {
  const active = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.ownerRoleId, role.id), inArray(tasks.status, [...ACTIVE])));
  const [{ topics: topicCount }] = await db
    .select({ topics: sql<number>`count(*)::int` })
    .from(topicParticipants)
    .where(
      and(
        eq(topicParticipants.participantType, "role"),
        eq(topicParticipants.participantId, role.id),
        isNull(topicParticipants.removedAt),
      ),
    );
  const [{ mems }] = await db
    .select({ mems: sql<number>`count(*)::int` })
    .from(memories)
    .where(and(eq(memories.roleId, role.id), isNull(memories.deletedAt)));
  return {
    active_tasks: active.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    topics: Number(topicCount),
    memories: Number(mems),
    notes: [
      "Running and queued tasks keep the prompt, model and computer they started with.",
      "Changing the computer does not move files, installed software or logins; tasks pinned to the old computer must be cancelled or re-run explicitly.",
      "Agent sessions and topic notes stay with their topics.",
    ],
  };
}

export async function updateRole(db: Db, user: User, role: Role, input: Record<string, any>) {
  await requirePerm(db, user, Perm.ROLE_MANAGE);
  const { confirm, activeTasks, ...data } = input;
  const clean = await validate(db, user, data, role);
  const changes = Object.keys(clean).filter(
    (k) => JSON.stringify((role as any)[k]) !== JSON.stringify((clean as any)[k]),
  );
  const behaviour = changes.filter((k) => BEHAVIOUR_FIELDS.has(k));
  const report = await impact(db, role);
  if (behaviour.length && report.active_tasks.length && !confirm) {
    throw new BadRequest(
      "this change affects a role with active work; review the impact and repeat with confirm=true",
      {
        code: "confirmation_required",
        detail: { impact: report, changes: behaviour.map(apiName) },
      },
    );
  }
  if (changes.includes("instanceId") && report.active_tasks.length) {
    if (activeTasks !== "cancel") {
      throw new BadRequest(
        "the role has active tasks pinned to its current computer; pass active_tasks='cancel' to cancel them or wait for them to finish",
        { code: "active_tasks_on_old_instance", detail: { impact: report } },
      );
    }
    for (const t of await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.ownerRoleId, role.id), inArray(tasks.status, [...ACTIVE])))) {
      await cancelTree(db, t, "role moved to another computer");
    }
  }
  const [updated] = await db
    .update(roles)
    .set({ ...(clean as any), ...(behaviour.length ? { configVersion: role.configVersion + 1 } : {}) })
    .where(eq(roles.id, role.id))
    .returning();
  return { role: updated, changes: changes.map(apiName), impact: report };
}

/** Same job on another computer: independent identity and sessions, the same prompt and settings. */
export async function copyRole(
  db: Db,
  user: User,
  role: Role,
  handle: string,
  name: string | null,
  instanceId: string | null,
) {
  if (role.systemAdmin) throw new BadRequest("the system administrator is built in and cannot be copied");
  const clone = await createRole(db, user, {
    name: name || role.name,
    handle,
    avatarUrl: role.avatarUrl,
    color: role.color,
    description: role.description,
    systemPrompt: role.systemPrompt,
    modelConfigId: role.modelConfigId,
    modelParams: role.modelParams,
    reasoningEffort: role.reasoningEffort,
    instanceId,
    allowedTools: role.allowedTools,
    allowedContacts: role.allowedContacts,
    knowledgeSpaceIds: role.knowledgeSpaceIds,
    approvalRequired: role.approvalRequired,
    maxSteps: role.maxSteps,
    maxTokensPerTask: role.maxTokensPerTask,
    dailyTokenLimit: role.dailyTokenLimit,
  });
  return clone;
}

/** Disable a role and decide explicitly what happens to its unfinished work. */
export async function disableRole(db: Db, user: User, role: Role, onTasks: string, reassignTo: string | null) {
  await requirePerm(db, user, Perm.ROLE_MANAGE);
  if (role.systemAdmin) throw new BadRequest("the system administrator is built in and is always available");
  const active = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.ownerRoleId, role.id), inArray(tasks.status, [...ACTIVE])));
  if (onTasks === "cancel") for (const t of active) await cancelTree(db, t, `@${role.handle} was disabled`);
  else if (onTasks === "reassign") {
    const target = await getRole(db, reassignTo ?? "");
    if (target.status !== "active") throw new BadRequest("target role is disabled");
    const { reassign } = await import("../agent/tasks-admin.js");
    for (const t of active) await reassign(db, user, t, target, { byRoleManager: true });
  } else if (onTasks === "pause") for (const t of active) await pause(db, t, `@${role.handle} was disabled`);
  else throw new BadRequest("on_tasks must be cancel, reassign or pause");
  await db.update(roles).set({ status: "disabled" }).where(eq(roles.id, role.id));
  return { affected_tasks: active.map((t) => t.id), on_tasks: onTasks };
}

/**
 * Computer instance lifecycle (management channel). Uses the Docker Manager; AI work never comes through
 * here — it goes through the execution gateway to the runner inside the computer.
 */
import type { ComputerSpec, ContainerState } from "@witden/shared";
import { and, eq, inArray, ne } from "drizzle-orm";
import { type Db, db as getDb, transaction } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  type ComputerInstance,
  type ComputerTemplate,
  computerInstances,
  execSessions,
  instanceBackups,
  roles,
  tasks,
  type User,
} from "../db/schema.js";
import { BadRequest, Conflict, InstanceUnavailable, NotFound } from "../errors.js";
import { runtime } from "../runtime.js";
import { hashToken, newToken } from "../security/crypto.js";
import { hasPermission, Perm } from "../security/permissions.js";
import { audit } from "./audit.js";
import { publish } from "./events.js";
import { validateResources } from "./templates.js";

export const ACTIVE_TASK_STATES = [
  "pending",
  "running",
  "waiting_human",
  "waiting_approval",
  "waiting_children",
  "waiting_resource",
  "waiting_timer",
  "paused",
];
const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;

export async function getInstance(db: Db, id: string): Promise<ComputerInstance> {
  const [inst] = await db.select().from(computerInstances).where(eq(computerInstances.id, id)).limit(1);
  if (!inst || inst.status === "deleted") throw new NotFound("instance not found");
  return inst;
}

export const homeOf = (user: string | null | undefined) => (!user || user === "root" ? "/root" : `/home/${user}`);
export const expandPath = (p: string, user: string | null | undefined) =>
  p.startsWith("~/") ? homeOf(user) + p.slice(1) : p;
const slug = (p: string) =>
  p
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "root";

export async function createInstance(
  db: Db,
  template: ComputerTemplate,
  name: string,
  resources: Record<string, any> | null,
  createdBy: string | null,
): Promise<ComputerInstance> {
  if (!NAME.test(name))
    throw new BadRequest("instance name must be 2-63 chars of lowercase letters, digits and dashes");
  const [taken] = await db
    .select({ id: computerInstances.id })
    .from(computerInstances)
    .where(eq(computerInstances.name, name))
    .limit(1);
  if (taken) throw new Conflict(`instance ${name} already exists`);
  if (template.archived) throw new BadRequest("template is archived");
  const [inst] = await db
    .insert(computerInstances)
    .values({
      id: newId("inst"),
      name,
      templateId: template.id,
      templateVersion: template.version,
      spec: {
        template_id: template.id,
        template_name: template.name,
        image: template.image,
        kind: template.kind,
        workdir: template.workdir,
        user: template.user,
        command: template.command,
        env: template.env,
        persistent_paths: template.persistentPaths,
        credential_paths: template.credentialPaths,
        cap_add: template.capAdd,
        runtime: template.runtime,
        desktop: template.desktop,
        software: template.software,
      },
      resources: validateResources({ ...template.defaultResources, ...(resources ?? {}) }),
      volumes: Object.fromEntries(template.persistentPaths.map((p) => [p, `witden-${name}-${slug(p)}`])),
      status: "creating",
      createdBy,
    })
    .returning();
  return inst;
}

/** Computer spec for the manager. A fresh runner secret is minted each time a container is (re)created. */
function buildSpec(inst: ComputerInstance, runnerToken: string): ComputerSpec {
  const spec = inst.spec;
  const res = inst.resources;
  const network = res.network ?? "bridge";
  return {
    instanceId: inst.id,
    name: inst.name,
    image: spec.image,
    workdir: spec.workdir ?? "/home/witden",
    user: spec.user ?? "witden",
    command: spec.command ?? null,
    env: { ...(spec.env ?? {}) },
    volumes: { ...inst.volumes },
    resources: {
      cpus: res.cpus ?? null,
      memoryMb: res.memory_mb ?? null,
      pidsLimit: res.pids_limit ?? null,
      diskGb: res.disk_gb ?? null,
    },
    network,
    capAdd: spec.cap_add ?? [],
    runtime: spec.runtime ?? null,
    runner: { token: runnerToken, hubUrl: network === "bridge" ? runtime().settings.hubUrlForComputers : null },
  };
}

/** Seeing a computer (details, screen, live view): observing, controlling and managing all include it. */
export async function canObserveInstance(db: Db, user: User, instanceId: string): Promise<boolean> {
  for (const p of [Perm.INSTANCE_OBSERVE, Perm.INSTANCE_CONTROL, Perm.INSTANCE_MANAGE]) {
    if (await hasPermission(db, user, p, instanceId)) return true;
  }
  return false;
}

/** Container stopped, restarted or recreated: none of its terminals, browsers or agents survive. */
async function closeInstanceSessions(tx: Db, instanceId: string): Promise<void> {
  await tx
    .update(execSessions)
    .set({ status: "closed" })
    .where(and(eq(execSessions.instanceId, instanceId), eq(execSessions.status, "open")));
}

async function setStatus(id: string, status: string, reason: string | null, fields: Partial<ComputerInstance> = {}) {
  await transaction(async (tx) => {
    const update: Partial<ComputerInstance> = { status, statusReason: reason, ...fields };
    if (status === "running") update.lastStartedAt = new Date();
    await tx.update(computerInstances).set(update).where(eq(computerInstances.id, id));
    if (["stopped", "deleted", "creating"].includes(status)) await closeInstanceSessions(tx, id);
    await publish(tx, "instance.status", { id, status, reason }, `instance:${id}`, "admin");
  });
}

async function verifyRunning(id: string, containerId: string, warnings: string[] = []) {
  const state = await runtime().manager.state(containerId);
  if (state.running) {
    await setStatus(id, "running", warnings.join("; ") || null);
    return;
  }
  let reason = `container exited (status=${state.status}, exit=${state.exitCode ?? "?"})`;
  if (state.oomKilled) reason += ", killed: out of memory";
  if (state.error) reason += `: ${state.error}`;
  await setStatus(id, "error", reason);
}

/** Create the container (with a fresh runner secret) and start it. */
export async function opProvision(id: string): Promise<void> {
  const inst = await getInstance(getDb(), id);
  const token = newToken("wdr_");
  try {
    await setStatus(id, "creating", null, { runnerTokenHash: hashToken(token) });
    const { containerId, warnings } = await runtime().manager.create(buildSpec(inst, token));
    await setStatus(id, "creating", warnings.join("; ") || null, { containerId });
    await runtime().manager.start(containerId);
    await verifyRunning(id, containerId, warnings);
  } catch (err) {
    await setStatus(id, "error", `provision failed: ${(err as Error).message}`);
  }
}

export async function opStart(id: string): Promise<void> {
  const inst = await getInstance(getDb(), id);
  try {
    if (!(await runtime().manager.state(inst.containerId)).exists) {
      throw new InstanceUnavailable("container is missing; reset the instance to recreate it");
    }
    await runtime().manager.start(inst.containerId!);
    await verifyRunning(id, inst.containerId!);
  } catch (err) {
    await setStatus(id, "error", `start failed: ${(err as Error).message}`);
  }
}

export async function opStop(id: string): Promise<void> {
  const inst = await getInstance(getDb(), id);
  try {
    runtime().hub?.disconnect(id, "computer stopping");
    await runtime().manager.stop(inst.containerId!);
    await setStatus(id, "stopped", "stopped by administrator");
  } catch (err) {
    await setStatus(id, "error", `stop failed: ${(err as Error).message}`);
  }
}

export async function opRestart(id: string): Promise<void> {
  const inst = await getInstance(getDb(), id);
  try {
    runtime().hub?.disconnect(id, "computer restarting");
    await runtime().manager.restart(inst.containerId!);
    await transaction((tx) => closeInstanceSessions(tx, id));
    await verifyRunning(id, inst.containerId!);
  } catch (err) {
    await setStatus(id, "error", `restart failed: ${(err as Error).message}`);
  }
}

/** Recreate from the snapshot spec. Installed software is always lost; volumes only if not kept. */
export async function opReset(id: string, keepVolumes: boolean): Promise<void> {
  const inst = await getInstance(getDb(), id);
  try {
    runtime().hub?.disconnect(id, "computer reset");
    await runtime().manager.remove(inst.containerId, {
      volumes: Object.values(inst.volumes),
      removeVolumes: !keepVolumes,
    });
    await setStatus(id, "creating", "resetting", { containerId: null });
    await opProvision(id);
  } catch (err) {
    await setStatus(id, "error", `reset failed: ${(err as Error).message}`);
  }
}

export async function opDelete(id: string): Promise<void> {
  const [inst] = await getDb().select().from(computerInstances).where(eq(computerInstances.id, id)).limit(1);
  if (!inst) return;
  try {
    runtime().hub?.disconnect(id, "computer deleted");
    await runtime().manager.remove(inst.containerId, { volumes: Object.values(inst.volumes), removeVolumes: true });
    await setStatus(id, "deleted", "deleted", { containerId: null, runnerTokenHash: null });
  } catch (err) {
    await setStatus(id, "error", `delete failed: ${(err as Error).message}`);
  }
}

export function resetPreview(inst: ComputerInstance, keepVolumes: boolean) {
  const paths = Object.keys(inst.volumes);
  return {
    will_clear: [
      "software installed or files changed outside persistent paths (container layer)",
      "running processes, terminal and browser sessions, desktop state",
      ...(keepVolumes ? [] : paths.map((p) => `all data in persistent path ${p}`)),
    ],
    will_keep: [
      ...(keepVolumes ? paths.map((p) => `data in persistent path ${p}`) : []),
      "instance name, resource limits and role assignments",
    ],
  };
}

export async function deletePreview(db: Db, inst: ComputerInstance) {
  const rows = await db.select().from(roles).where(eq(roles.instanceId, inst.id));
  return {
    will_clear: ["the container and everything in it", ...Object.keys(inst.volumes).map((p) => `persistent path ${p}`)],
    roles_detached: rows.map((r) => r.handle),
    note: "backups are kept until deleted separately",
  };
}

export async function activeTasksOn(db: Db, instanceId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.instanceId, instanceId), inArray(tasks.status, ACTIVE_TASK_STATES)));
}

/** Align recorded status with reality (after a host reboot, a crash, or manual docker changes). */
export async function reconcile(): Promise<void> {
  const rows = await getDb()
    .select()
    .from(computerInstances)
    .where(inArray(computerInstances.status, ["running", "stopped", "creating", "error"]));
  for (const inst of rows) {
    if (inst.status === "creating" && !inst.containerId) continue;
    let st: ContainerState;
    try {
      st = await runtime().manager.state(inst.containerId);
    } catch (err) {
      if (inst.status === "running")
        await setStatus(inst.id, "error", `docker manager unreachable: ${(err as Error).message}`);
      continue;
    }
    if (!st.exists && inst.status !== "error") {
      await setStatus(inst.id, "error", "container missing; reset the instance to recreate it");
    } else if (st.exists && st.running && inst.status !== "running" && inst.status !== "creating") {
      await setStatus(inst.id, "running", null);
    } else if (st.exists && !st.running && inst.status === "running") {
      let reason = `container ${st.status} unexpectedly (exit=${st.exitCode ?? "?"})`;
      if (st.oomKilled) reason += ", out of memory";
      await setStatus(inst.id, "error", reason);
    }
  }
}

/** Raise unless the instance is running right now (checked against Docker, not only the database). */
export async function ensureUsable(inst: ComputerInstance): Promise<void> {
  if (inst.status !== "running") {
    throw new InstanceUnavailable(
      `instance ${inst.name} is ${inst.status}${inst.statusReason ? `: ${inst.statusReason}` : ""}`,
    );
  }
  let running = false;
  try {
    running = (await runtime().manager.state(inst.containerId)).running;
  } catch (err) {
    throw new InstanceUnavailable(`docker manager unreachable: ${(err as Error).message}`);
  }
  if (!running) throw new InstanceUnavailable(`instance ${inst.name} container is not running`);
}

// --- backup / restore / clone ---------------------------------------------------------------------------

export async function opBackup(instanceId: string, backupId: string): Promise<void> {
  const inst = await getInstance(getDb(), instanceId);
  try {
    if (!inst.containerId) throw new Conflict("instance has no container");
    const result = await runtime().manager.backup(inst.containerId, { backupId, mounts: Object.keys(inst.volumes) });
    await getDb()
      .update(instanceBackups)
      .set({ imageRef: result.imageRef, archives: result.archives, sizeBytes: result.sizeBytes, status: "complete" })
      .where(eq(instanceBackups.id, backupId));
  } catch (err) {
    await getDb()
      .update(instanceBackups)
      .set({ status: "failed", note: `failed: ${(err as Error).message}` })
      .where(eq(instanceBackups.id, backupId));
    throw err;
  }
}

/** Recreate ``instanceId`` from a backup; credential paths are removed when ``scrub`` is set (clones). */
export async function opRestore(instanceId: string, backupId: string, scrub: boolean, replace: boolean): Promise<void> {
  const inst = await getInstance(getDb(), instanceId);
  const [backup] = await getDb().select().from(instanceBackups).where(eq(instanceBackups.id, backupId)).limit(1);
  if (!backup?.imageRef || backup.status !== "complete") {
    await setStatus(instanceId, "error", "backup is incomplete");
    return;
  }
  const token = newToken("wdr_");
  try {
    runtime().hub?.disconnect(instanceId, "computer restoring");
    await setStatus(instanceId, "creating", "restoring", { runnerTokenHash: hashToken(token) });
    const user = inst.spec.user;
    const { containerId, warnings } = await runtime().manager.restore({
      spec: buildSpec(inst, token),
      replaceContainerId: replace ? inst.containerId : null,
      backupId,
      imageRef: backup.imageRef,
      archives: backup.archives,
      scrubPaths: scrub ? (inst.spec.credential_paths ?? []).map((p: string) => expandPath(p, user)) : [],
    });
    await setStatus(instanceId, "creating", warnings.join("; ") || null, { containerId });
    await verifyRunning(instanceId, containerId, warnings);
  } catch (err) {
    await setStatus(instanceId, "error", `restore failed: ${(err as Error).message}`);
  }
}

export async function recordAudit(
  db: Db,
  userId: string | null,
  action: string,
  inst: ComputerInstance,
  detail: Record<string, unknown> = {},
) {
  await audit(db, action, {
    actorType: "user",
    actorId: userId,
    resourceType: "instance",
    resourceId: inst.id,
    instanceId: inst.id,
    detail,
  });
}

export async function instancesNotDeleted(db: Db) {
  return db
    .select()
    .from(computerInstances)
    .where(ne(computerInstances.status, "deleted"))
    .orderBy(computerInstances.name);
}

/**
 * First run: once a person has connected a model service and picked a model, everything else needed to start
 * is prepared in one go — a desktop computer and an assistant that works on it, and the built-in system
 * administrator gets that model if it has none — with a DM to the assistant. Existing pieces are reused, so
 * finishing twice creates nothing twice.
 */
import { and, eq, sql } from "drizzle-orm";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import { type ComputerInstance, computerTemplates, type Role, roles, type Topic, type User } from "../db/schema.js";
import { BadRequest, NotFound } from "../errors.js";
import { audit } from "./audit.js";
import { createInstance, instancesNotDeleted, recordAudit } from "./instances.js";
import { isSystemOne, modelLabel, modelWithProvider, unusableReason } from "./model-configs.js";
import { getSetting, putSetting } from "./platform-settings.js";
import { createRole } from "./roles.js";
import { ensureSystemAdmin } from "./system-admin.js";
import { seedBuiltinTemplates } from "./templates.js";
import { getOrCreateDm } from "./topics.js";

/** Platform setting: when the first-run guide was finished or skipped, and by whom. */
export const SETUP = "setup";
export interface SetupSetting {
  finished_at?: string;
  skipped_at?: string;
  by: string;
}

const DESKTOP_TEMPLATE = "desktop-browser";

const ASSISTANT = {
  name: "助手",
  handle: "assistant",
  description: "通用助手：用自己的桌面电脑查资料、操作网页、整理文档和运行命令。",
  systemPrompt:
    "你是团队的通用助手，用中文交流。先弄清要做什么再动手；需要上网、查资料或操作网页时，使用你的桌面电脑里的浏览器。做完后说明结果，产出的文件用 share_file 分享到对话里。",
};

/** The guide is offered on a fresh platform: no roles but the built-in one, and nobody finished or skipped it. */
export async function setupStatus(db: Db): Promise<{ needed: boolean; setting: SetupSetting | null }> {
  const setting = await getSetting<SetupSetting>(db, SETUP);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(roles)
    .where(eq(roles.systemAdmin, false));
  return { needed: !setting && count === 0, setting };
}

export async function skipSetup(db: Db, user: User): Promise<void> {
  await putSetting(db, SETUP, { skipped_at: new Date().toISOString(), by: user.id }, user.id);
  await audit(db, "setup.skip", { actorType: "user", actorId: user.id });
}

/** ``base``, or ``base-2``, ``base-3``... whichever is free. */
async function free(taken: (name: string) => Promise<boolean>, base: string): Promise<string> {
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!(await taken(name))) return name;
  }
}

export interface SetupResult {
  computer: ComputerInstance;
  /** The computer was created now and still has to be provisioned (after the transaction commits). */
  provision: boolean;
  admin: Role;
  assistant: Role;
  dm: Topic;
}

export async function finishSetup(db: Db, user: User, modelConfigId: string): Promise<SetupResult> {
  const found = await modelWithProvider(db, modelConfigId);
  if (!found) throw new NotFound("model not found");
  if (isSystemOne(found.provider))
    throw new BadRequest(`${modelLabel(found.model, found.provider)} is a System One decision model and cannot chat`);
  const unusable = unusableReason(found.model, found.provider);
  if (unusable) throw new BadRequest(unusable);

  await seedBuiltinTemplates(db, settings());
  let computer = (await instancesNotDeleted(db)).find((i) => i.spec.kind === "desktop");
  const provision = !computer;
  if (!computer) {
    const [template] = await db
      .select()
      .from(computerTemplates)
      .where(and(eq(computerTemplates.name, DESKTOP_TEMPLATE), eq(computerTemplates.archived, false)))
      .limit(1);
    if (!template) throw new BadRequest(`the built-in template ${DESKTOP_TEMPLATE} is missing or archived`);
    const names = new Set((await instancesNotDeleted(db)).map((i) => i.name));
    computer = await createInstance(db, template, await free(async (n) => names.has(n), "desktop"), null, user.id);
    await recordAudit(db, user.id, "instance.create", computer, { template: template.name, setup: true });
  }

  let admin = await ensureSystemAdmin(db);
  const adminModel = await modelWithProvider(db, admin.modelConfigId);
  if (!adminModel || unusableReason(adminModel.model, adminModel.provider))
    [admin] = await db.update(roles).set({ modelConfigId }).where(eq(roles.id, admin.id)).returning();
  const existing = await db.select().from(roles);
  const handleTaken = async (h: string) => existing.some((r) => r.handle === h);
  const assistant =
    existing.find((r) => !r.systemAdmin && r.status === "active") ??
    (await createRole(db, user, {
      ...ASSISTANT,
      handle: await free(handleTaken, ASSISTANT.handle),
      modelConfigId,
      instanceId: computer.id,
    }));
  const dm = await getOrCreateDm(db, user, assistant);

  await putSetting(db, SETUP, { finished_at: new Date().toISOString(), by: user.id }, user.id);
  await audit(db, "setup.finish", {
    actorType: "user",
    actorId: user.id,
    detail: { model_config_id: modelConfigId, computer: computer.id, admin: admin.id, assistant: assistant.id },
  });
  return { computer, provision, admin, assistant, dm };
}

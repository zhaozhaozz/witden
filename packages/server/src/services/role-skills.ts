/**
 * Role skills: named instructions for a kind of work (how to cut a release, how this team reviews a pull request,
 * how to use an internal tool). Every prompt of the role lists them by name and description, wherever it works;
 * the role reads one whole (read_skill) when a request matches it. People write them in the console, and the role
 * writes its own (save_skill, delete_skill). Like role memory they change how the role works for everyone, so only
 * work a console account asked for may change them (services/role-memory.ts). System administrator roles have none:
 * their work is fixed by their rules and the configuration endpoints.
 */
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type Role, type RoleSkill, roleSkills, type Task } from "../db/schema.js";
import { BadRequest, Conflict, NotFound } from "../errors.js";
import { forConsoleAccount } from "./role-memory.js";

export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Every prompt of the role lists each description: keep them short. */
export const SKILL_DESCRIPTION_MAX_CHARS = 500;
export const SKILL_CONTENT_MAX_CHARS = 64000;
/** Bounds the list in every prompt (at most this many descriptions). */
export const ROLE_SKILLS_MAX = 50;

export interface SkillFields {
  name: string;
  description: string;
  content: string;
}

/** Who wrote a skill: a person in the console, or the role itself. */
export interface SkillActor {
  type: "user" | "role";
  id: string;
}

/**
 * The fields of a new skill (``partial``: of a change, only those given). The name is a slug (lowercased); the
 * description is one line; none may be empty.
 */
export function skillFields(input: Record<string, any>, opts: { partial?: boolean } = {}): Partial<SkillFields> {
  const out: Partial<SkillFields> = {};
  if (!opts.partial || input.name !== undefined) {
    const name = String(input.name ?? "")
      .trim()
      .toLowerCase();
    if (!SKILL_NAME.test(name))
      throw new BadRequest(
        "a skill's name must be 1-64 characters: lowercase letters, digits, . _ - (starting with a letter or digit), e.g. release-check",
      );
    out.name = name;
  }
  if (!opts.partial || input.description !== undefined) {
    // Listed as one line in every prompt of the role.
    const description = String(input.description ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!description) throw new BadRequest("a skill needs a description: when to use it");
    if (description.length > SKILL_DESCRIPTION_MAX_CHARS)
      throw new BadRequest(`keep a skill's description under ${SKILL_DESCRIPTION_MAX_CHARS} characters`);
    out.description = description;
  }
  if (!opts.partial || input.content !== undefined) {
    const content = String(input.content ?? "").trim();
    if (!content) throw new BadRequest("a skill needs content: its instructions");
    if (content.length > SKILL_CONTENT_MAX_CHARS)
      throw new BadRequest(`keep a skill's content under ${SKILL_CONTENT_MAX_CHARS} characters`);
    out.content = content;
  }
  if (opts.partial && !Object.keys(out).length) throw new BadRequest("give a name, description or content to change");
  return out;
}

/** The role's live skills, by name. */
export async function skillsOf(db: Db, roleId: string): Promise<RoleSkill[]> {
  return db
    .select()
    .from(roleSkills)
    .where(and(eq(roleSkills.roleId, roleId), isNull(roleSkills.deletedAt)))
    .orderBy(asc(roleSkills.name));
}

async function live(db: Db, roleId: string, where: ReturnType<typeof eq>): Promise<RoleSkill | undefined> {
  const [skill] = await db
    .select()
    .from(roleSkills)
    .where(and(eq(roleSkills.roleId, roleId), isNull(roleSkills.deletedAt), where))
    .limit(1);
  return skill;
}

export const skillByName = (db: Db, roleId: string, name: string) =>
  live(db, roleId, eq(roleSkills.name, name.trim().toLowerCase()));

export async function getSkill(db: Db, roleId: string, id: string): Promise<RoleSkill> {
  const skill = await live(db, roleId, eq(roleSkills.id, id));
  if (!skill) throw new NotFound("skill not found");
  return skill;
}

/** Why this task may not create, change or delete its role's skills, or null when it may. */
export async function roleSkillRefusal(db: Db, task: Task, role: Role): Promise<string | null> {
  if (role.systemAdmin) return "system administrator roles have no skills";
  if (!(await forConsoleAccount(db, task)))
    return "skills change how you work everywhere, so they can be created, changed or deleted only while you work for a witden administrator (a console account), not for someone outside the console or an automation";
  return null;
}

async function checkName(db: Db, roleId: string, name: string, except?: string): Promise<void> {
  const clash = await skillByName(db, roleId, name);
  if (clash && clash.id !== except) throw new Conflict(`there is already a skill named ${name}`);
}

export async function createSkill(db: Db, role: Role, fields: SkillFields, by: SkillActor): Promise<RoleSkill> {
  if (role.systemAdmin) throw new BadRequest("system administrator roles have no skills");
  await checkName(db, role.id, fields.name);
  const [{ n }] = await db
    .select({ n: count() })
    .from(roleSkills)
    .where(and(eq(roleSkills.roleId, role.id), isNull(roleSkills.deletedAt)));
  if (n >= ROLE_SKILLS_MAX)
    throw new BadRequest(`a role has at most ${ROLE_SKILLS_MAX} skills: change or delete one instead`);
  const [skill] = await db
    .insert(roleSkills)
    .values({
      id: newId("skill"),
      roleId: role.id,
      ...fields,
      createdByType: by.type,
      createdById: by.id,
      updatedByType: by.type,
      updatedById: by.id,
    })
    .returning();
  return skill;
}

export async function changeSkill(
  db: Db,
  skill: RoleSkill,
  fields: Partial<SkillFields>,
  by: SkillActor,
): Promise<RoleSkill> {
  if (fields.name !== undefined) await checkName(db, skill.roleId, fields.name, skill.id);
  const [updated] = await db
    .update(roleSkills)
    .set({ ...fields, updatedByType: by.type, updatedById: by.id, updatedAt: new Date() })
    .where(eq(roleSkills.id, skill.id))
    .returning();
  return updated;
}

/** A deleted skill keeps its name (audit records name it) but none of its text. */
export async function deleteSkill(db: Db, skill: RoleSkill): Promise<void> {
  await db
    .update(roleSkills)
    .set({ deletedAt: new Date(), description: "", content: "" })
    .where(eq(roleSkills.id, skill.id));
}

/** A copied role works the same way: it gets the skills, written by the person who copied it. */
export async function copySkills(db: Db, from: Role, to: Role, by: SkillActor): Promise<number> {
  const skills = await skillsOf(db, from.id);
  for (const s of skills)
    await createSkill(db, to, { name: s.name, description: s.description, content: s.content }, by);
  return skills.length;
}

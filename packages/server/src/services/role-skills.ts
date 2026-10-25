/**
 * Role skills: named instructions for a kind of work (how to cut a release, how this team reviews a pull request,
 * how to use an internal tool). Every prompt of the role lists them by name and description, wherever it works;
 * the role reads one whole (read_skill) when a request matches it. People write them in the console, and the role
 * writes its own (save_skill, delete_skill). Like role memory they change how the role works for everyone, so only
 * work a console account asked for may change them (services/role-memory.ts). System administrator roles have none:
 * their work is fixed by their rules and the configuration endpoints.
 *
 * A skill is a complete package: besides its instructions (role_skills.content) it may carry files (scripts,
 * templates, reference documents) under relative paths, with their executable bits (role_skill_files; the content in
 * the platform's data directory). As a directory, in the role's computer or in an archive, a skill is SKILL.md (the
 * name and description as front matter, then the instructions) next to its files: read_skill writes that directory
 * into the computer (agent/skill-dirs.ts), where the role runs the scripts itself.
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { createGzip, gunzipSync } from "node:zlib";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import tar from "tar-stream";
import yauzl from "yauzl";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type Role, type RoleSkill, type RoleSkillFile, roleSkillFiles, roleSkills, type Task } from "../db/schema.js";
import { BadRequest, Conflict, NotFound } from "../errors.js";
import { readStored, removeStored, storedPath, writeStored } from "./files.js";
import { forConsoleAccount } from "./role-memory.js";

export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A skill's instructions in its directory (in the computer and in an archive). */
export const SKILL_FILE = "SKILL.md";
/** Where read_skill puts the role's skills in its computer, one directory per skill. */
export const SKILLS_DIR = "~/.witden/skills";
/** Left out when a skill is read from a directory or an archive: the directory's version control, not the skill. */
export const SKILL_DIR_EXCLUDE = [".git"];
/** Every prompt of the role lists each description: keep them short. */
export const SKILL_DESCRIPTION_MAX_CHARS = 500;
export const SKILL_CONTENT_MAX_CHARS = 64000;

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

/** A deleted skill keeps its name (audit records name it) but none of its text, and none of its files. */
export async function deleteSkill(db: Db, skill: RoleSkill, blobs: SkillBlobs): Promise<void> {
  const files = await db.delete(roleSkillFiles).where(eq(roleSkillFiles.skillId, skill.id)).returning();
  blobs.drop(files.map((f) => f.storageKey));
  await db
    .update(roleSkills)
    .set({ deletedAt: new Date(), description: "", content: "" })
    .where(eq(roleSkills.id, skill.id));
}

/** A copied role works the same way: it gets the skills with their files, written by the person who copied it. */
export async function copySkills(db: Db, from: Role, to: Role, by: SkillActor, blobs: SkillBlobs): Promise<number> {
  const skills = await skillsOf(db, from.id);
  const files = await filesBySkill(
    db,
    skills.map((s) => s.id),
  );
  for (const s of skills) {
    const copy = await createSkill(db, to, { name: s.name, description: s.description, content: s.content }, by);
    for (const f of files.get(s.id) ?? [])
      await insertFile(db, copy, { path: f.path, executable: f.executable, ...blobs.copy(f.storageKey) }, by);
  }
  return skills.length;
}

// --- files ---------------------------------------------------------------------------------------------------

/**
 * Content written for a change and content it replaces. The content is kept outside the database
 * (services/files.ts), so a change writes new content under new keys before its rows commit, and removes what it
 * replaced only after: a row never names missing content, and a failed or interrupted change leaves at most content
 * nothing names. Store and copy only inside ``run``.
 */
export class SkillBlobs {
  private readonly added: string[] = [];
  private readonly dropped: string[] = [];

  private key(): string {
    const id = newId("skf");
    // Noted before it is written: a write that fails halfway is removed too.
    const key = `skills/${id.slice(-2)}/${id}`;
    this.added.push(key);
    return key;
  }

  store(data: Buffer): StoredContent {
    const storageKey = this.key();
    return { storageKey, ...writeStored(storageKey, data) };
  }

  copy(storageKey: string): StoredContent {
    const data = readStored(storageKey);
    return this.store(data);
  }

  drop(storageKeys: string[]): void {
    this.dropped.push(...storageKeys);
  }

  /** Run the change, its transaction included: if it fails the new content goes, once it is done the replaced. */
  async run<T>(change: () => Promise<T>): Promise<T> {
    let out: T;
    try {
      out = await change();
    } catch (err) {
      for (const k of this.added) removeStored(k);
      throw err;
    }
    for (const k of this.dropped) removeStored(k);
    return out;
  }
}

export interface StoredContent {
  storageKey: string;
  size: number;
  sha256: string;
}

/** A file ready to become part of a skill: its path checked, its content stored. */
export interface StoredSkillFile extends StoredContent {
  path: string;
  executable: boolean;
}

/** The longest name and path a Linux file system takes (NAME_MAX, PATH_MAX). */
const NAME_MAX_BYTES = 255;
const PATH_MAX_BYTES = 4096;

/**
 * A file's path in its skill, from a person, an archive or a directory of the computer: relative and "/"-separated
 * (a "\" counts as one), without empty, "." or ".." parts or control characters, and a path a Linux file system
 * takes. SKILL.md at the top is the instructions (the skill's content), not one of its files.
 */
export function skillFilePath(input: unknown): string {
  const path = String(input ?? "").replace(/\\/g, "/");
  const shown = JSON.stringify(path);
  if (!path) throw new BadRequest("give the file's path in the skill, e.g. scripts/check.sh");
  if (path.startsWith("/"))
    throw new BadRequest(`${shown}: a skill file's path is relative to the skill, e.g. scripts/check.sh`);
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".."))
    throw new BadRequest(`${shown}: a skill file's path has no empty, "." or ".." parts`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\u0000-\u001f\u007f]/.test(path))
    throw new BadRequest(`${shown}: a skill file's path has no control characters`);
  if (parts.some((p) => Buffer.byteLength(p) > NAME_MAX_BYTES) || Buffer.byteLength(path) > PATH_MAX_BYTES)
    throw new BadRequest(`${shown}: too long for a file system (names up to 255 bytes, paths up to 4096)`);
  if (path === SKILL_FILE)
    throw new BadRequest(`${SKILL_FILE} is the skill's instructions: change its content instead`);
  return path;
}

/** A path that cannot sit next to the others: one is a file where the other needs a directory. */
function clashing(paths: Iterable<string>, path: string): string | undefined {
  for (const p of paths) if (path.startsWith(`${p}/`) || p.startsWith(`${path}/`)) return p;
  return undefined;
}

export async function filesOf(db: Db, skillId: string): Promise<RoleSkillFile[]> {
  return db.select().from(roleSkillFiles).where(eq(roleSkillFiles.skillId, skillId)).orderBy(asc(roleSkillFiles.path));
}

/** The files of several skills, by skill id (each list by path). */
export async function filesBySkill(db: Db, skillIds: string[]): Promise<Map<string, RoleSkillFile[]>> {
  const out = new Map<string, RoleSkillFile[]>();
  if (!skillIds.length) return out;
  const rows = await db
    .select()
    .from(roleSkillFiles)
    .where(inArray(roleSkillFiles.skillId, skillIds))
    .orderBy(asc(roleSkillFiles.path));
  for (const f of rows) out.set(f.skillId, [...(out.get(f.skillId) ?? []), f]);
  return out;
}

/** How many files each skill has; skills without files are not in the map. */
export async function fileCounts(db: Db, skillIds: string[]): Promise<Map<string, number>> {
  if (!skillIds.length) return new Map();
  const rows = await db
    .select({ skillId: roleSkillFiles.skillId, n: count() })
    .from(roleSkillFiles)
    .where(inArray(roleSkillFiles.skillId, skillIds))
    .groupBy(roleSkillFiles.skillId);
  return new Map(rows.map((r) => [r.skillId, Number(r.n)]));
}

export async function getSkillFile(db: Db, skill: RoleSkill, path: string): Promise<RoleSkillFile> {
  const [file] = await db
    .select()
    .from(roleSkillFiles)
    .where(and(eq(roleSkillFiles.skillId, skill.id), eq(roleSkillFiles.path, skillFilePath(path))))
    .limit(1);
  if (!file) throw new NotFound(`skill ${skill.name} has no file ${path}`);
  return file;
}

export const skillFileData = (file: RoleSkillFile): Buffer => readStored(file.storageKey);
export const skillFileStream = (file: RoleSkillFile) => fs.createReadStream(storedPath(file.storageKey));

async function insertFile(db: Db, skill: RoleSkill, file: StoredSkillFile, by: SkillActor): Promise<RoleSkillFile> {
  const [row] = await db
    .insert(roleSkillFiles)
    .values({ id: newId("skfile"), skillId: skill.id, ...file, updatedByType: by.type, updatedById: by.id })
    .returning();
  return row;
}

/** A change to a skill's files is a change to the skill: who changed it last, and when. */
async function touch(db: Db, skill: RoleSkill, by: SkillActor): Promise<void> {
  await db
    .update(roleSkills)
    .set({ updatedByType: by.type, updatedById: by.id, updatedAt: new Date() })
    .where(eq(roleSkills.id, skill.id));
}

/**
 * Add a file to a skill, or replace the file at that path (its executable bit kept unless given). Returns the file
 * and whether it is new.
 */
export async function putSkillFile(
  db: Db,
  skill: RoleSkill,
  input: { path: string; data: Buffer; executable?: boolean },
  by: SkillActor,
  blobs: SkillBlobs,
): Promise<{ file: RoleSkillFile; created: boolean }> {
  const path = skillFilePath(input.path);
  const files = await filesOf(db, skill.id);
  const current = files.find((f) => f.path === path);
  const clash = clashing(
    files.map((f) => f.path),
    path,
  );
  if (clash) throw new Conflict(`${path} cannot sit next to ${clash} in skill ${skill.name}`);
  const stored = blobs.store(input.data);
  const executable = input.executable ?? current?.executable ?? false;
  let file: RoleSkillFile;
  if (current) {
    [file] = await db
      .update(roleSkillFiles)
      .set({ ...stored, executable, updatedByType: by.type, updatedById: by.id, updatedAt: new Date() })
      .where(eq(roleSkillFiles.id, current.id))
      .returning();
    blobs.drop([current.storageKey]);
  } else file = await insertFile(db, skill, { path, executable, ...stored }, by);
  await touch(db, skill, by);
  return { file, created: !current };
}

export async function setSkillFileExecutable(
  db: Db,
  skill: RoleSkill,
  file: RoleSkillFile,
  executable: boolean,
  by: SkillActor,
): Promise<RoleSkillFile> {
  const [updated] = await db
    .update(roleSkillFiles)
    .set({ executable, updatedByType: by.type, updatedById: by.id, updatedAt: new Date() })
    .where(eq(roleSkillFiles.id, file.id))
    .returning();
  await touch(db, skill, by);
  return updated;
}

export async function deleteSkillFile(
  db: Db,
  skill: RoleSkill,
  file: RoleSkillFile,
  by: SkillActor,
  blobs: SkillBlobs,
): Promise<void> {
  await db.delete(roleSkillFiles).where(eq(roleSkillFiles.id, file.id));
  blobs.drop([file.storageKey]);
  await touch(db, skill, by);
}

/** The skill's files become exactly these (saved from a directory, imported from an archive). */
export async function replaceSkillFiles(
  db: Db,
  skill: RoleSkill,
  files: StoredSkillFile[],
  by: SkillActor,
  blobs: SkillBlobs,
): Promise<void> {
  const seen = new Set<string>();
  for (const f of files) {
    const clash = seen.has(f.path) ? f.path : clashing(seen, f.path);
    if (clash) throw new BadRequest(`${f.path} cannot sit next to ${clash} in a skill`);
    seen.add(f.path);
  }
  const old = await db.delete(roleSkillFiles).where(eq(roleSkillFiles.skillId, skill.id)).returning();
  blobs.drop(old.map((f) => f.storageKey));
  for (const f of files) await insertFile(db, skill, f, by);
  await touch(db, skill, by);
}

// --- the skill as a directory: SKILL.md and its files --------------------------------------------------------

/** SKILL.md: the name and description as front matter (the common format of skill directories), then the content. */
export function skillMarkdown(skill: Pick<RoleSkill, "name" | "description" | "content">): string {
  // A JSON string is a valid YAML double-quoted scalar, whatever the description holds.
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}\n`;
}

/** One front matter value: quoted or plain, continued on more indented lines, or a block scalar (| or >). */
function frontValue(first: string, rest: string[]): string {
  if (/^[>|][+-]?$/.test(first)) {
    const lines = rest.map((l) => l.trim());
    return (first[0] === ">" ? lines.join(" ") : lines.join("\n")).trim();
  }
  const value = [first, ...rest.map((l) => l.trim())].join(" ").trim();
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.replace(/^"|"$/g, "");
    }
  }
  if (value.startsWith("'")) return value.replace(/^'|'$/g, "").replace(/''/g, "'");
  return value.replace(/\s+#.*$/, "");
}

/**
 * SKILL.md as written by skillMarkdown, by hand or elsewhere: front matter is optional and only its name and
 * description are used; the rest is the content.
 */
export function parseSkillMarkdown(text: string): { name?: string; description?: string; content: string } {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { content: text.replace(/^﻿/, "").trim() };
  const fields: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const rest: string[] = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) rest.push(lines[++i]);
    fields[kv[1]] = frontValue(kv[2].trim(), rest);
  }
  return { name: fields.name, description: fields.description, content: text.slice(m[0].length).trim() };
}

/** The whole skill as a .tar.gz: <name>/SKILL.md and <name>/<path> of each file, executable bits kept. */
export function skillArchive(skill: RoleSkill, files: RoleSkillFile[]): Readable {
  const pack = tar.pack();
  const add = (name: string, data: Buffer, mode: number, mtime: Date) =>
    new Promise<void>((resolve, reject) =>
      pack.entry({ name: `${skill.name}/${name}`, mode, mtime }, data, (err) => (err ? reject(err) : resolve())),
    );
  const gzip = createGzip();
  (async () => {
    await add(SKILL_FILE, Buffer.from(skillMarkdown(skill)), 0o644, skill.updatedAt);
    for (const f of files) await add(f.path, skillFileData(f), f.executable ? 0o755 : 0o644, f.updatedAt);
    pack.finalize();
  })().catch((err) => gzip.destroy(err));
  return Readable.from(pack).pipe(gzip);
}

interface ArchiveEntry {
  name: string;
  data: Buffer;
  mode: number;
}

/** A zip starts with a local file header (or, when empty, with the end of its central directory). */
const isZip = (data: Buffer) =>
  data[0] === 0x50 && data[1] === 0x4b && [3, 5].includes(data[2]) && data[3] === data[2] + 1;

/** What packing on macOS adds next to a folder: no part of the skill. */
const isPackingLeftover = (name: string) => name.split("/")[0] === "__MACOSX" || name.split("/").at(-1) === ".DS_Store";

async function tarEntries(data: Buffer, skipped: string[]): Promise<ArchiveEntry[]> {
  let raw: Buffer;
  try {
    raw = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data;
  } catch {
    throw new BadRequest("the archive is not a valid .tar.gz");
  }
  const entries: ArchiveEntry[] = [];
  const extract = tar.extract();
  extract.end(raw);
  try {
    for await (const entry of extract) {
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(chunk as Buffer);
      const name = entry.header.name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
      if (!name || name.split("/").some((p) => SKILL_DIR_EXCLUDE.includes(p))) continue;
      const type = entry.header.type ?? "file";
      if (type === "file" || type === "contiguous-file")
        entries.push({ name, data: Buffer.concat(chunks), mode: entry.header.mode ?? 0o644 });
      else if (type !== "directory") skipped.push(name);
    }
  } catch {
    throw new BadRequest("the archive is not a valid .tar.gz or .tar");
  }
  return entries;
}

/**
 * The entries of a .zip. Unix file types and modes come from the high half of the external attributes; a zip made
 * where there are none (Windows, some tools) gives 0, and then a file is executable when it starts with "#!", as
 * in an upload from the console.
 */
async function zipEntries(data: Buffer, skipped: string[]): Promise<ArchiveEntry[]> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(data, { lazyEntries: true, strictFileNames: false });
  } catch {
    throw new BadRequest("the archive is not a valid .zip");
  }
  const entries: ArchiveEntry[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", async (entry: yauzl.Entry) => {
        try {
          const name = entry.fileName
            .replace(/\\/g, "/")
            .replace(/^(\.\/)+/, "")
            .replace(/\/+$/, "");
          const unix = entry.versionMadeBy >> 8 === 3 ? entry.externalFileAttributes >>> 16 : 0;
          const type = unix & 0o170000;
          const excluded =
            !name || isPackingLeftover(name) || name.split("/").some((p) => SKILL_DIR_EXCLUDE.includes(p));
          if (excluded || entry.fileName.endsWith("/") || type === 0o040000) {
            // directories need no entry of their own
          } else if ((type && type !== 0o100000) || entry.isEncrypted()) skipped.push(name);
          else {
            const chunks: Buffer[] = [];
            for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer);
            const content = Buffer.concat(chunks);
            const mode = unix & 0o777 ? unix & 0o777 : content.subarray(0, 2).toString() === "#!" ? 0o755 : 0o644;
            entries.push({ name, data: content, mode });
          }
          zip.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zip.readEntry();
    });
  } catch {
    throw new BadRequest("the archive is not a valid .zip");
  } finally {
    zip.close();
  }
  return entries;
}

/**
 * A skill archive (.zip, .tar.gz or .tar): SKILL.md at its top or in its only top-level directory, and the files next
 * to it, their content stored. Entries that are not regular files are left out and named in ``skipped``.
 */
export async function readSkillArchive(
  data: Buffer,
  blobs: SkillBlobs,
): Promise<{ dirName: string | null; markdown: string; files: StoredSkillFile[]; skipped: string[] }> {
  const skipped: string[] = [];
  const entries = isZip(data) ? await zipEntries(data, skipped) : await tarEntries(data, skipped);
  // SKILL.md at the top, or in the one directory everything is in.
  const tops = new Set(entries.map((e) => e.name.split("/")[0]));
  const dirName =
    entries.some((e) => e.name === SKILL_FILE) || tops.size !== 1 ? null : (tops.values().next().value as string);
  const prefix = dirName === null ? "" : `${dirName}/`;
  const markdown = entries.find((e) => e.name === `${prefix}${SKILL_FILE}`);
  if (!markdown) throw new BadRequest(`the archive has no ${SKILL_FILE} at its top or in its only top-level directory`);
  const files: StoredSkillFile[] = [];
  for (const e of entries) {
    if (e === markdown) continue;
    const path = skillFilePath(e.name.slice(prefix.length));
    files.push({ path, executable: (e.mode & 0o111) !== 0, ...blobs.store(e.data) });
  }
  return { dirName, markdown: markdown.data.toString("utf8"), files, skipped };
}

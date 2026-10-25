/**
 * A skill as a directory in the role's own computer (services/role-skills.ts).
 *
 * - read_skill writes the saved skill there whole: ``~/.witden/skills/<name>/`` is removed, then SKILL.md and every
 *   file are written under their paths, executable bits kept. The directory mirrors the saved skill at each read;
 *   what the role changed there is gone unless it saved it first.
 * - save_skill with a directory reads one back: its regular files at any depth (symbolic links and .git left out),
 *   SKILL.md as the instructions.
 * Both go through the execution gateway as the work's own file operations, so they need the work's ``files``
 * permission, like every other file the platform writes into or reads from a computer (agent/tool-output.ts), and a
 * runner with the whole-directory operations (FILE_TREE_TOOL). Only the role's own saved skill is ever written.
 */
import { FILE_TREE_TOOL, type FileRemoveResult, type FileTreeResult, type RunnerOp } from "@witden/shared";
import { eq } from "drizzle-orm";
import { computerInstances, type RoleSkill, type RoleSkillFile, tasks } from "../db/schema.js";
import { BadRequest, Forbidden } from "../errors.js";
import { findCredential } from "../security/crypto.js";
import { MAX_UPLOAD_BYTES } from "../services/files.js";
import {
  SKILL_DIR_EXCLUDE,
  SKILL_FILE,
  SKILLS_DIR,
  type SkillBlobs,
  type StoredSkillFile,
  skillFileData,
  skillFilePath,
  skillMarkdown,
} from "../services/role-skills.js";
import type { ToolContext } from "./tools.js";

/** Why this work cannot use a directory of its computer for a skill, or null when it can. */
export async function cannotUseDirectory(ctx: ToolContext): Promise<string | null> {
  const db = ctx.db();
  const [task] = await db
    .select({ instanceId: tasks.instanceId, envelope: tasks.envelope })
    .from(tasks)
    .where(eq(tasks.id, ctx.taskId))
    .limit(1);
  if (!task?.instanceId) return "you have no virtual computer here";
  if (!((task.envelope as { tools?: string[] }).tools ?? []).includes("files")) return "you may not use files here";
  const [inst] = await db
    .select({ info: computerInstances.runnerInfo })
    .from(computerInstances)
    .where(eq(computerInstances.id, task.instanceId))
    .limit(1);
  const runnerTools = (inst?.info as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(runnerTools) || !runnerTools.includes(FILE_TREE_TOOL))
    return "your computer's runner is older and cannot write or read whole directories (a person can reset the computer, keeping the data in its persistent directories, to update it)";
  return null;
}

/** One file operation of the work, under its own call id: the tool's journal entry stays its own. */
function fileOp<T>(ctx: ToolContext, op: RunnerOp, params: Record<string, unknown>, timeoutMs = 60_000) {
  return ctx.gateway.execute({
    taskId: ctx.taskId,
    toolCallId: `${ctx.toolCallId}:skill`,
    op,
    params,
    timeoutMs,
  }) as Promise<T>;
}

/** Large files are written and read in one operation each: give them the time share_file gives. */
const LARGE_FILE_MS = 120_000;

/**
 * Write the saved skill into the computer: where it is, or why it is not there. Never throws: read_skill returns
 * the instructions either way. Call it outside a transaction.
 */
export async function putSkillDirectory(
  ctx: ToolContext,
  skill: RoleSkill,
  files: RoleSkillFile[],
): Promise<{ dir: string } | { why: string }> {
  try {
    const why = await cannotUseDirectory(ctx);
    if (why) return { why };
    // Removed first: files deleted from the skill, and whatever was left there, must not stay.
    const { path: dir } = await fileOp<FileRemoveResult>(ctx, "file.remove", { path: `${SKILLS_DIR}/${skill.name}` });
    await fileOp(ctx, "file.write", {
      path: `${dir}/${SKILL_FILE}`,
      contentBase64: Buffer.from(skillMarkdown(skill)).toString("base64"),
      mode: 0o644,
    });
    for (const f of files)
      await fileOp(
        ctx,
        "file.write",
        {
          path: `${dir}/${f.path}`,
          contentBase64: skillFileData(f).toString("base64"),
          mode: f.executable ? 0o755 : 0o644,
        },
        LARGE_FILE_MS,
      );
    return { dir };
  } catch (err) {
    return { why: `the skill could not be written into your computer (${(err as Error).message})` };
  }
}

/** What save_skill takes from a directory of the computer; the files' content is stored as it is read. */
export interface DirectoryRead {
  dir: string;
  /** SKILL.md, when the directory has one. */
  markdown: string | null;
  files: StoredSkillFile[];
  /** Entries that are not regular files (symbolic links are never followed). */
  skipped: string[];
}

/**
 * Read a skill from a directory of the computer. A file holding a credential is refused, as share_file refuses it:
 * a skill is copied whole into computers and shown in the console, where it cannot be masked.
 */
export async function readSkillDirectory(
  ctx: ToolContext,
  directory: string,
  blobs: SkillBlobs,
): Promise<DirectoryRead> {
  const why = await cannotUseDirectory(ctx);
  if (why) throw new BadRequest(`${why}, so a skill cannot be saved from a directory; give its content instead`);
  const tree = await fileOp<FileTreeResult>(ctx, "file.tree", { path: directory, exclude: SKILL_DIR_EXCLUDE });
  // Every path and size is checked before anything is read.
  for (const e of tree.files) {
    if (e.path !== SKILL_FILE) skillFilePath(e.path);
    if (e.size > MAX_UPLOAD_BYTES)
      throw new BadRequest(`${e.path} is ${e.size} bytes; a skill file can be at most 50 MB, as an upload`);
  }
  let markdown: string | null = null;
  const files: StoredSkillFile[] = [];
  for (const e of tree.files) {
    const r = await fileOp<{ contentBase64: string }>(
      ctx,
      "file.read",
      { path: `${tree.path}/${e.path}`, maxBytes: MAX_UPLOAD_BYTES },
      LARGE_FILE_MS,
    );
    const data = Buffer.from(r.contentBase64, "base64");
    // latin1 keeps every byte, so tokens are found in binary files too
    const credential = findCredential(data.toString("latin1"));
    if (credential)
      throw new Forbidden(
        `${e.path} contains a credential (${credential}); a skill never holds credentials: have its scripts read them from the computer's environment or files instead`,
      );
    if (e.path === SKILL_FILE) markdown = data.toString("utf8");
    else
      files.push({
        path: skillFilePath(e.path),
        executable: (Number.parseInt(e.mode, 8) & 0o111) !== 0,
        ...blobs.store(data),
      });
  }
  return { dir: tree.path, markdown, files, skipped: tree.skipped.map((s) => s.path) };
}

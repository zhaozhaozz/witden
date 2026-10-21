/**
 * Long tool results: one limit, applied once, here.
 *
 * Contract of ``boundOutput(ctx, name, output)`` (for any tool whose result can be long; command output can use it
 * the same way). Call it outside a transaction: keeping the output goes through the gateway.
 * - Output of at most ``settings().toolOutputLimit`` characters (WITDEN_TOOL_OUTPUT_LIMIT, default 12000) comes
 *   back unchanged.
 * - Longer output is written whole (UTF-8, credentials masked as in every tool result) to
 *   ``~/.witden/tool-output/<tool call id>.txt`` in the AI employee's virtual computer, through the gateway's
 *   ``file.write`` with the work's own file permission. The model gets the head and the tail (about half the
 *   limit each, cut at line ends where close) and, between them, a note:
 *   ``[… <name> output: <N> characters, <L> lines; the middle <M> characters are left out here. The whole output
 *   is in <absolute path>: read it with read_file (offset and limit, in lines), or search it with grep / sed in
 *   run_command. …]``
 * - When it cannot be kept (no computer for this work, no file permission, the computer unavailable or stopped),
 *   the head and the tail come back with a note that says the middle is left out and why.
 * - It never throws. The write goes under its own call id (``<tool call id>:output``), so the gateway's journal
 *   for the tool call, which recovery reads after a crash, keeps the tool's own operation.
 *
 * Results that are themselves a file read (read_file) page instead of going through this, or reading the kept
 * file would make another one.
 */
import { eq } from "drizzle-orm";
import { settings } from "../config.js";
import { tasks } from "../db/schema.js";
import { redact } from "../security/crypto.js";
import type { ToolContext } from "./tools.js";

/** Where kept outputs go, relative to the home directory of the computer's user. */
export const TOOL_OUTPUT_DIR = "~/.witden/tool-output";

/** A tool call id as a file name: models' ids are mostly safe already; anything else becomes "_". */
const fileName = (toolCallId: string) => `${toolCallId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "output"}.txt`;

/** Head and tail of a text for ``budget`` characters, cut at a line end when one is near. */
function ends(text: string, budget: number): { head: string; tail: string } {
  const half = Math.max(1, Math.floor(budget / 2));
  let head = text.slice(0, half);
  let tail = text.slice(text.length - (budget - half));
  const nl = head.lastIndexOf("\n");
  if (nl >= half * 0.8) head = head.slice(0, nl + 1);
  const start = tail.indexOf("\n");
  if (start >= 0 && start <= tail.length * 0.2) tail = tail.slice(start + 1);
  // Never split a surrogate pair (an emoji, a rare character).
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return { head, tail };
}

const lineCount = (text: string) => (text.match(/\n/g)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);

/** Head and tail with a note in between; ``detail`` says where the rest is, or why it is nowhere. */
function shorten(name: string, text: string, limit: number, detail: string): string {
  const { head, tail } = ends(text, limit);
  const left = text.length - head.length - tail.length;
  const size = `${text.length} characters, ${lineCount(text)} lines`;
  return `${head}\n[… ${name} output: ${size}; the middle ${left} characters are left out here. ${detail} …]\n${tail}`;
}

/** Head and tail with a note, keeping nothing: for results that cannot or need not be kept in a computer. */
export function truncateOutput(name: string, text: string, why: string): string {
  const limit = settings().toolOutputLimit;
  return text.length <= limit ? text : shorten(name, text, limit, why);
}

/** Why the work cannot keep a file, or null when it can. */
async function cannotKeep(ctx: ToolContext): Promise<string | null> {
  const [task] = await ctx
    .db()
    .select({ instanceId: tasks.instanceId, envelope: tasks.envelope })
    .from(tasks)
    .where(eq(tasks.id, ctx.taskId))
    .limit(1);
  if (!task?.instanceId) return "You have no virtual computer here, so the whole output was not kept";
  if (!((task.envelope as { tools?: string[] }).tools ?? []).includes("files"))
    return "You may not use files here, so the whole output was not kept";
  return null;
}

export async function boundOutput(ctx: ToolContext, name: string, output: string): Promise<string> {
  const limit = settings().toolOutputLimit;
  if (output.length <= limit) return output;
  // The file holds no more than the model would have been shown: masked like every tool result (agent/runner.ts).
  const text = redact(output);
  if (text.length <= limit) return text;
  let why: string | null;
  try {
    why = await cannotKeep(ctx);
    if (!why) {
      const written = (await ctx.gateway.execute({
        taskId: ctx.taskId,
        toolCallId: `${ctx.toolCallId}:output`,
        op: "file.write",
        params: {
          path: `${TOOL_OUTPUT_DIR}/${fileName(ctx.toolCallId)}`,
          contentBase64: Buffer.from(text).toString("base64"),
        },
        timeoutMs: 60_000,
      })) as { path: string };
      return shorten(
        name,
        text,
        limit,
        `The whole output is in ${written.path}: read it with read_file (offset and limit, in lines), or search it with grep / sed in run_command.`,
      );
    }
  } catch (err) {
    why = `The whole output could not be kept in your computer (${(err as Error).message})`;
  }
  return shorten(name, text, limit, `${why}; ask for less at a time (narrower queries, paging) to see the rest.`);
}

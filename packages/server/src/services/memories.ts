/**
 * Memories (topic notes, role memory, knowledge-space notes) have one format: a short title, a few keywords
 * people would search by, and the content. Roles and people write, change and delete them; recall ranks them
 * by all three, so a query without spaces (as Chinese is written) still finds a note by its keywords.
 */
import type { Memory } from "../db/schema.js";
import { BadRequest } from "../errors.js";

export const TITLE_MAX_CHARS = 100;
export const KEYWORDS_MAX = 10;
export const KEYWORD_MAX_CHARS = 40;

export interface MemoryFields {
  title: string;
  keywords: string[];
  content: string;
}

/** Keywords from a list or from text separated by commas, 、 or spaces: trimmed, without repeats. */
export function parseKeywords(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map(String) : String(value ?? "").split(/[,，、;；\n]+/);
  const out: string[] = [];
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    if (p.length > KEYWORD_MAX_CHARS) throw new BadRequest(`keep each keyword under ${KEYWORD_MAX_CHARS} characters`);
    if (!out.some((k) => k.toLowerCase() === p.toLowerCase())) out.push(p);
  }
  if (out.length > KEYWORDS_MAX) throw new BadRequest(`give at most ${KEYWORDS_MAX} keywords`);
  return out;
}

/**
 * The fields of a new note (``partial``: of a change, only those given). Title and content may not be empty;
 * ``contentLimit`` bounds the content (role memory is in every prompt of its role).
 */
export function memoryFields(
  input: Record<string, any>,
  opts: { partial?: boolean; contentLimit?: number } = {},
): Partial<MemoryFields> {
  const out: Partial<MemoryFields> = {};
  if (!opts.partial || input.title !== undefined) {
    const title = String(input.title ?? "").trim();
    if (!title) throw new BadRequest("title is required");
    if (title.length > TITLE_MAX_CHARS) throw new BadRequest(`keep the title under ${TITLE_MAX_CHARS} characters`);
    out.title = title;
  }
  if (!opts.partial || input.keywords !== undefined) out.keywords = parseKeywords(input.keywords);
  if (!opts.partial || input.content !== undefined) {
    const content = String(input.content ?? "").trim();
    if (!content) throw new BadRequest("content is required");
    if (opts.contentLimit && content.length > opts.contentLimit)
      throw new BadRequest(`keep the content under ${opts.contentLimit} characters`);
    out.content = content;
  }
  if (opts.partial && !Object.keys(out).length) throw new BadRequest("give a title, keywords or content to change");
  return out;
}

/** What a deleted note keeps: nothing of its text. */
export const erased = () => ({ deletedAt: new Date(), title: "", keywords: [] as string[], content: "" });

/** How well a note matches a query: keywords count most, then the title, then words in the content. */
export function memoryScore(m: Pick<Memory, "title" | "keywords" | "content">, query: string): number {
  const q = query.toLowerCase().trim();
  const words = q.split(/\s+/).filter((w) => w.length > 1);
  const title = m.title.toLowerCase();
  const content = m.content.toLowerCase();
  const keywords = m.keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 1);
  let score = 0;
  for (const w of words) {
    score += content.split(w).length - 1;
    // Either way round: a word written without spaces (as Chinese is) may contain the keyword or the title.
    if (title.includes(w) || (title.length > 1 && w.includes(title))) score += 3;
    if (keywords.some((k) => k.includes(w) || w.includes(k))) score += 5;
  }
  return score;
}

/** One note as a role reads it: id, title, keywords, then the content. */
export function memoryLine(m: Pick<Memory, "id" | "title" | "keywords" | "content">, note = ""): string {
  const head = `${m.id}${note ? ` (${note})` : ""} ${m.title || "(untitled)"}${m.keywords.length ? ` [${m.keywords.join(", ")}]` : ""}`;
  return `- ${head}: ${m.content.trim().replace(/\n/g, "\n  ")}`;
}

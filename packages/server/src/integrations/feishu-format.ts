/**
 * Message text between witden (GitHub-flavoured Markdown) and Feishu.
 *
 * Feishu's rich-text message (``post``) renders Markdown in its ``md`` element: CommonMark and the common GFM
 * parts (headings, nested and task lists, fenced code, quotes, tables, links, bold / italic / strikethrough,
 * rules, footnotes). So outgoing Markdown is kept as written and only what Feishu does differently is rewritten,
 * in place, from the parsed positions:
 * - images become links: a Feishu image takes an uploaded image key (a URL makes Feishu refuse the whole
 *   message), and Feishu is not asked to fetch an address a role wrote;
 * - links into witden (``/…``) get the console address: Feishu follows only http(s);
 * - raw HTML shows as written, except ``<u>``: Feishu renders no other HTML, and a role must not be able to
 *   write Feishu's own ``<at user_id="all">``;
 * - headings: Setext ones (unsupported) become ATX; with any H1–H3, H1 becomes H4 and H2–H6 H5, as Feishu shows
 *   big headings at document size in a chat;
 * - Mermaid diagrams get a note linking to witden, where they are drawn;
 * - blocks are separated by a blank line, which Feishu needs around tables and after quotes;
 * - ``@name`` of people linked on the connection become Feishu mentions.
 *
 * Incoming posts are read the other way: text styles, links, code blocks and rules as Markdown.
 */
import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export interface FeishuFormatOptions {
  /** Absolute base for links into witden, e.g. https://witden.example.com */
  baseUrl: string;
  /** Where the message can be seen fully rendered (for diagrams). */
  viewUrl?: string | null;
  /** Names written as ``@name`` → the Feishu open_id to mention. */
  mentions?: Map<string, string>;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const absolute = (url: string, base: string) => (url.startsWith("/") ? base.replace(/\/+$/, "") + url : url);
const escapeLabel = (s: string) => s.replace(/[[\]\\]/g, (c) => `\\${c}`);

/** Markdown (as written in witden) → the text of a Feishu ``md`` element. */
export function toFeishu(markdown: string, opts: FeishuFormatOptions): string {
  const tree: Root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const edits: Edit[] = [];
  const at = (n: Nodes) => [n.position?.start.offset, n.position?.end.offset] as const;
  let bigHeadings = false;
  const headings: Nodes[] = [];
  const mentions = [...(opts.mentions ?? new Map()).entries()].sort((a, b) => b[0].length - a[0].length);

  const walk = (node: Nodes) => {
    const [start, end] = at(node);
    if (start !== undefined && end !== undefined)
      switch (node.type) {
        case "heading":
          headings.push(node);
          if (node.depth <= 3) bigHeadings = true;
          break;
        case "image": {
          const label = node.alt?.trim() || "图片";
          const url = absolute(node.url, opts.baseUrl);
          edits.push({
            start,
            end,
            text: /^https?:/i.test(url) ? `[🖼 ${escapeLabel(label)}](${url})` : `\\[图片：${escapeLabel(label)}\\]`,
          });
          return;
        }
        case "imageReference":
          // ![alt][ref] → [🖼 alt][ref]: the definition keeps the address
          if (markdown.startsWith("![", start)) edits.push({ start, end: start + 2, text: "[🖼 " });
          break;
        case "link":
        case "definition": {
          const slice = markdown.slice(start, end);
          // the address follows the label: `](url` in a link, `]: url` in a definition
          const after = node.type === "link" ? slice.lastIndexOf("](") : slice.indexOf("]:");
          const web = /^https?:/i.test(node.url) || node.url.startsWith("/");
          if (node.type === "link" && slice.startsWith("[") && after > 0 && !web) {
            // Feishu links only to http(s) (``javascript:``, ``mailto:``…): the label alone
            edits.push({ start, end: start + 1, text: "" }, { start: start + after, end, text: "" });
            break;
          }
          if (!node.url.startsWith("/")) break;
          const i = after < 0 ? -1 : slice.indexOf(node.url, after);
          if (i >= 0)
            edits.push({ start: start + i, end: start + i + node.url.length, text: absolute(node.url, opts.baseUrl) });
          break;
        }
        case "html":
          if (!/^<\/?u>$/i.test(node.value.trim()))
            edits.push({ start, end, text: markdown.slice(start, end).replace(/</g, "&lt;") });
          return;
        case "code":
          if (node.lang?.toLowerCase() === "mermaid") {
            const where = opts.viewUrl ? `，[在 witden 中查看](${opts.viewUrl})` : "";
            edits.push({ start, end: start, text: `*流程图（飞书不能显示图形${where}）：*\n\n` });
          }
          return;
        case "text": {
          if (!mentions.length) break;
          let text = markdown.slice(start, end);
          for (const [name, openId] of mentions)
            text = text.split(`@${name}`).join(`<at user_id="${openId}">${name.replace(/[<>]/g, "")}</at>`);
          if (text !== markdown.slice(start, end)) edits.push({ start, end, text });
          return;
        }
      }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);

  for (const h of headings) {
    if (h.type !== "heading") continue;
    const [start, end] = at(h);
    if (start === undefined || end === undefined) continue;
    const depth = bigHeadings ? (h.depth === 1 ? 4 : 5) : h.depth;
    const atx = /^#{1,6}/.exec(markdown.slice(start, end));
    if (atx) {
      if (depth !== h.depth) edits.push({ start, end: start + atx[0].length, text: "#".repeat(depth) });
      continue;
    }
    // Setext: "Title\n=====" → "#### Title"
    const contentEnd = h.children.at(-1)?.position?.end.offset;
    if (contentEnd === undefined) continue;
    edits.push({ start, end: start, text: `${"#".repeat(depth)} ` });
    edits.push({ start: contentEnd, end, text: "" });
  }

  // Each top-level block with its edits, blocks one blank line apart.
  const sorted = edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const blocks: string[] = [];
  for (const block of tree.children) {
    const [start, end] = at(block);
    if (start === undefined || end === undefined) continue;
    let out = "";
    let pos = start;
    for (const e of sorted) {
      if (e.start < start || e.end > end || e.start < pos) continue;
      out += markdown.slice(pos, e.start) + e.text;
      pos = e.end;
    }
    blocks.push(out + markdown.slice(pos, end));
  }
  return blocks.join("\n\n").trim();
}

/** Wrap text in a Markdown mark, keeping surrounding spaces outside it (``** a **`` is not bold). */
function marked(m: string, text: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  return match?.[2] ? `${match[1]}${m}${match[2]}${m}${match[3]}` : text;
}

/** One element of an incoming post as Markdown; @ stays the mention key, replaced like in a text message. */
function postElement(el: any): string {
  switch (el?.tag) {
    case "at":
      return el.user_id ?? `@${el.user_name ?? ""}`;
    case "img":
      return "[图片]";
    case "media":
      return "[视频]";
    case "hr":
      return "\n---\n";
    case "code_block":
      return `\n\`\`\`${el.language ?? ""}\n${String(el.text ?? "").replace(/\n$/, "")}\n\`\`\`\n`;
    case "md":
      return String(el.text ?? "");
    case "a": {
      const text = String(el.text ?? el.href ?? "");
      return /^https?:/i.test(el.href ?? "") ? `[${escapeLabel(text)}](${el.href})` : text;
    }
    default: {
      let text = String(el?.text ?? "");
      const style: string[] = Array.isArray(el?.style) ? el.style : [];
      if (style.includes("lineThrough")) text = marked("~~", text);
      if (style.includes("italic")) text = marked("*", text);
      if (style.includes("bold")) text = marked("**", text);
      return text;
    }
  }
}

/** An incoming post (``{title, content}``, or the same per language) as Markdown; null without one. */
export function fromFeishuPost(content: any): string | null {
  const post = Array.isArray(content?.content)
    ? content
    : (Object.values(content ?? {}).find((v: any) => v?.content) as any);
  if (!post) return null;
  const lines: string[] = post.title ? [String(post.title)] : [];
  for (const paragraph of post.content ?? [])
    lines.push((Array.isArray(paragraph) ? paragraph : []).map(postElement).join(""));
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

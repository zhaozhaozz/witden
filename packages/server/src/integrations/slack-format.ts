/**
 * Message text between witden (GitHub-flavoured Markdown) and Slack (mrkdwn).
 *
 * Slack's mrkdwn has *bold*, _italic_, ~strike~, `code`, ``` blocks, > quotes and <url|links>, but no headings,
 * lists, tables or images, and it needs &, < and > escaped. Outgoing Markdown is parsed and rewritten into
 * that: headings become bold lines, lists get bullet characters, tables become aligned monospace blocks,
 * images and Mermaid diagrams become links back to witden. Incoming mrkdwn is turned into Markdown so the
 * console renders it the way Slack showed it.
 */
import type { List, ListItem, Nodes, Parents, PhrasingContent, Root, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export interface SlackFormatOptions {
  /** Absolute base for relative links and platform files, e.g. https://witden.example.com */
  baseUrl: string;
  /** Where the message can be seen fully rendered (used for diagrams). */
  viewUrl?: string | null;
}

// Slack only applies *bold* etc. when the marks sit at word boundaries; next to CJK text or other words a
// zero-width space supplies the boundary. Ones that end up next to whitespace are removed again.
const ZW = "​";
const BULLETS = ["•", "◦", "▪"];

export const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text of a subtree (for link labels, headings and table cells). */
function plain(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.type === "html" ? "" : node.value;
  if (node.type === "image") return node.alt ?? "";
  if (node.type === "break") return " ";
  return "children" in node ? (node.children as Nodes[]).map(plain).join("") : "";
}

function absolute(url: string, base: string): string {
  return url.startsWith("/") ? base.replace(/\/+$/, "") + url : url;
}

/** Wrap each non-blank line in a Slack mark, keeping surrounding spaces outside it. */
function mark(m: string, text: string, nested: boolean): string {
  return text
    .split("\n")
    .map((line) => {
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(line);
      if (!match?.[2]) return line;
      const pad = nested ? "" : ZW;
      return `${match[1]}${pad}${m}${match[2]}${m}${pad}${match[3]}`;
    })
    .join("\n");
}

function inline(nodes: PhrasingContent[], opts: SlackFormatOptions, nested = false): string {
  return nodes.map((n) => phrasing(n, opts, nested)).join("");
}

function phrasing(node: PhrasingContent, opts: SlackFormatOptions, nested: boolean): string {
  switch (node.type) {
    case "text":
      return escapeSlack(node.value);
    case "strong":
      return mark("*", inline(node.children, opts, true), nested);
    case "emphasis":
      return mark("_", inline(node.children, opts, true), nested);
    case "delete":
      return mark("~", inline(node.children, opts, true), nested);
    case "inlineCode":
      return `\`${escapeSlack(node.value.replace(/`/g, "ˋ"))}\``;
    case "break":
      return "\n";
    case "link": {
      const url = absolute(node.url, opts.baseUrl);
      const label = plain(node).trim();
      if (!/^(https?:|mailto:)/i.test(url)) return escapeSlack(label || node.url);
      return !label || label === node.url ? `<${url}>` : `<${url}|${escapeSlack(label)}>`;
    }
    case "image": {
      const label = node.alt?.trim() || "图片";
      const url = absolute(node.url, opts.baseUrl);
      if (!/^https?:/i.test(url)) return `[图片：${escapeSlack(label)}]`;
      return `<${url}|🖼 ${escapeSlack(label)}>`;
    }
    case "html":
      return escapeSlack(node.value);
    case "footnoteReference":
      return `[^${escapeSlack(node.identifier)}]`;
    default:
      return "children" in node ? inline(node.children as PhrasingContent[], opts, nested) : escapeSlack(plain(node));
  }
}

/** Display width in a monospace font: CJK and other wide characters take two columns. */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      c >= 0x1f300
        ? 2
        : 1;
  }
  return w;
}

/** Tables have no Slack form: an aligned monospace block keeps them readable. */
function table(node: Table): string {
  const rows = node.children.map((r) => r.children.map((c) => plain(c).replace(/\s+/g, " ").trim()));
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(1, ...rows.map((r) => width(r[i] ?? ""))));
  const cell = (s: string, i: number) => {
    const gap = " ".repeat(widths[i] - width(s));
    return node.align?.[i] === "right" ? gap + s : s + gap;
  };
  const line = (r: string[]) =>
    widths
      .map((_, i) => cell(r[i] ?? "", i))
      .join(" | ")
      .trimEnd();
  const out = [line(rows[0] ?? []), widths.map((w) => "-".repeat(w)).join("-|-"), ...rows.slice(1).map(line)];
  return `\`\`\`\n${escapeSlack(out.join("\n"))}\n\`\`\``;
}

function list(node: List, opts: SlackFormatOptions, depth: number): string {
  const indent = "    ".repeat(depth);
  return node.children
    .map((item: ListItem, i) => {
      const marker =
        item.checked === true
          ? "☑"
          : item.checked === false
            ? "☐"
            : node.ordered
              ? `${(node.start ?? 1) + i}.`
              : BULLETS[depth % BULLETS.length];
      const parts = item.children.map((c) =>
        c.type === "list" ? { nested: true, text: list(c, opts, depth + 1) } : { nested: false, text: block(c, opts) },
      );
      let first = true;
      const lines: string[] = [];
      for (const p of parts) {
        if (p.nested) {
          lines.push(p.text);
          continue;
        }
        for (const l of p.text.split("\n")) {
          lines.push(first ? `${indent}${marker} ${l}` : `${indent}   ${l}`);
          first = false;
        }
      }
      if (first) lines.unshift(`${indent}${marker}`);
      return lines.join("\n");
    })
    .join("\n");
}

function block(node: Nodes, opts: SlackFormatOptions): string {
  switch (node.type) {
    case "root":
      return children(node, opts);
    case "paragraph":
      return inline(node.children, opts);
    case "heading":
      return mark("*", escapeSlack(plain(node).trim()), false);
    case "thematicBreak":
      return "──────────";
    case "blockquote":
      return children(node, opts, "\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "code":
      if (node.lang?.toLowerCase() === "mermaid") {
        const where = opts.viewUrl ? `，<${opts.viewUrl}|在 witden 中查看>` : "";
        return `${ZW}_流程图（Slack 不能显示图形${where}）：_\n\`\`\`\n${escapeSlack(node.value)}\n\`\`\``;
      }
      return `\`\`\`\n${escapeSlack(node.value)}\n\`\`\``;
    case "list":
      return list(node, opts, 0);
    case "table":
      return table(node);
    case "html":
      return escapeSlack(node.value);
    case "definition":
      return "";
    case "footnoteDefinition":
      return `[^${escapeSlack(node.identifier)}]: ${children(node, opts, " ")}`;
    default:
      return "children" in node ? children(node as Parents, opts) : escapeSlack(plain(node));
  }
}

function children(node: Parents, opts: SlackFormatOptions, sep = "\n\n"): string {
  return (node.children as Nodes[])
    .map((c) => block(c, opts))
    .filter((s) => s !== "")
    .join(sep);
}

/** Markdown (as written in witden) → Slack mrkdwn. */
export function toSlack(markdown: string, opts: SlackFormatOptions): string {
  const tree: Root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return block(tree, opts)
    .replace(new RegExp(`(^|\\s)${ZW}`, "gm"), "$1")
    .replace(new RegExp(`${ZW}(?=\\s|$)`, "gm"), "")
    .trim();
}

// --- Slack → witden ------------------------------------------------------------------------------------

/**
 * Slack mrkdwn → Markdown. ``names`` maps Slack user ids to the names shown for <@U…> mentions.
 * Code spans and blocks are kept as they are.
 */
export function fromSlack(text: string, names: Map<string, string> = new Map()): string {
  // Split out code first: ```blocks``` (also written inline in Slack) and `spans`.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        if (!part.startsWith("```")) return unescapeSlack(part);
        const body = part.slice(3, -3).replace(/^\n/, "").replace(/\n$/, "");
        return `\n\`\`\`\n${unescapeSlack(body)}\n\`\`\`\n`;
      }
      return prose(part, names);
    })
    .join("")
    .replace(/^\n+|\n+$/g, "");
}

const unescapeSlack = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function prose(text: string, names: Map<string, string>): string {
  let out = text.replace(/<([^<>]+)>/g, (_m, inner: string) => {
    const [target, label] = inner.split("|", 2);
    if (target.startsWith("@")) return `@${label || names.get(target.slice(1)) || target.slice(1)}`;
    if (target.startsWith("#")) return `#${label || target.slice(1)}`;
    if (target.startsWith("!subteam^")) return label || "@group";
    if (target.startsWith("!date^")) return label || "";
    if (target.startsWith("!")) return `@${target.slice(1)}`;
    const url = target.replace(/^mailto:/, "");
    if (target.startsWith("mailto:")) return label || url;
    return label && label !== target ? `[${label.replace(/[[\]]/g, "\\$&")}](${target})` : target;
  });
  out = out
    // Slack bullets ("• item", indented "◦ item") become Markdown lists
    .replace(/^([ \t]*)[•◦▪▫‣] +/gm, (_m, sp: string) => `${"  ".repeat(Math.floor(sp.length / 4))}- `)
    // a leading # is just text in Slack
    .replace(/^(\s*)#/gm, "$1\\#")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1**$2**")
    .replace(/(^|[^\w~])~(?=\S)([^~\n]*?\S)~(?![\w~])/g, "$1~~$2~~")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1*$2*");
  return unescapeSlack(out);
}

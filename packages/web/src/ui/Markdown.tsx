/**
 * Message bodies as Markdown (GitHub style): headings, lists, tables, task lists, code, links and images,
 * plus ```mermaid blocks drawn as diagrams. Raw HTML is never rendered, and links and image sources go
 * through react-markdown's URL filter (no javascript: URLs); images may also be inline base64 rasters.
 *
 * Images under /api/files/<id> are platform files: they are fetched with the signed-in session and shown
 * from an object URL, since <img> cannot send the Authorization header.
 */
import { type ReactNode, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import { Link } from "react-router-dom";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { api } from "../api/client";

const MENTION = /@[A-Za-z0-9一-鿿][A-Za-z0-9_.\-一-鿿]*/g;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/**
 * `@handle` in ordinary text becomes <span class="mention"> (code and links are left alone). With ``tokens``
 * only those (the people and roles the message really mentions) are highlighted; other "@…" stay text.
 */
function remarkMentions(opts: { tokens?: string[] } = {}) {
  const only = opts.tokens ? new Set(opts.tokens.map((t) => t.toLowerCase())) : null;
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== "text" || !child.value?.includes("@")) {
        walk(child);
        return [child];
      }
      const out: MdNode[] = [];
      let last = 0;
      for (const m of child.value.matchAll(MENTION)) {
        const at = m.index ?? 0;
        if (at > 0 && /[A-Za-z0-9._-]/.test(child.value[at - 1])) continue; // an e-mail address, not a mention
        if (only && !only.has(m[0].slice(1).toLowerCase())) continue;
        if (at > last) out.push({ type: "text", value: child.value.slice(last, at) });
        out.push({
          type: "mention",
          data: { hName: "span", hProperties: { className: ["mention"] } },
          children: [{ type: "text", value: m[0] }],
        });
        last = at + m[0].length;
      }
      if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
      return out;
    });
  };
  return (tree: MdNode) => walk(tree);
}

const RASTER_DATA = /^data:image\/(png|jpe?g|gif|webp);base64,/i;

function urlTransform(url: string, key: string): string {
  if (key === "src" && RASTER_DATA.test(url)) return url;
  return defaultUrlTransform(url);
}

// --- images --------------------------------------------------------------------------------------------

const FILE_URL = /^\/api\/files\/([A-Za-z0-9_-]+)$/;
const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const fileUrls = new Map<string, Promise<string>>();

/** Object URL for a platform image file, fetched once per page load. Only raster images are shown. */
export function fileImageUrl(fileId: string): Promise<string> {
  let p = fileUrls.get(fileId);
  if (!p) {
    p = api.blob(`/api/files/${encodeURIComponent(fileId)}`).then((blob) => {
      if (!RASTER_TYPES.has(blob.type)) throw new Error("不是可以预览的图片");
      return URL.createObjectURL(blob);
    });
    p.catch(() => fileUrls.delete(fileId));
    fileUrls.set(fileId, p);
  }
  return p;
}

export function isPreviewableImage(mime: string | undefined): boolean {
  return !!mime && RASTER_TYPES.has(mime.toLowerCase());
}

/** A full-window view of an image; click or Esc closes it. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={alt || "图片"} onClick={onClose} onKeyDown={() => {}}>
      <img src={src} alt={alt} />
    </div>
  );
}

/** An image in a message: external URLs load directly, platform files through the session. */
export function MessageImage({ src, alt, fileId }: { src?: string; alt?: string; fileId?: string }) {
  const id = fileId ?? (src ? FILE_URL.exec(src)?.[1] : undefined);
  const [url, setUrl] = useState<string | null>(id ? null : (src ?? null));
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fileImageUrl(id)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (error) return <span className="md-img-missing">图片无法显示：{error}</span>;
  if (!url) return <span className="md-img-loading">图片加载中…</span>;
  return (
    <>
      <button type="button" className="md-img" title="点击放大" onClick={() => setOpen(true)}>
        <img src={url} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />
      </button>
      {open ? <Lightbox src={url} alt={alt ?? ""} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

// --- mermaid -------------------------------------------------------------------------------------------

type MermaidApi = typeof import("mermaid").default;
let mermaidLoader: Promise<MermaidApi> | null = null;
let diagramSeq = 0;

/** Mermaid is large: load it the first time a diagram appears. */
function loadMermaid(): Promise<MermaidApi> {
  mermaidLoader ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      // Labels as SVG text: no HTML (and so no images or links) inside diagram nodes.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: "neutral",
      fontFamily: "inherit",
    });
    return m.default;
  });
  return mermaidLoader;
}

function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    loadMermaid()
      .then(async (mermaid) => {
        await mermaid.parse(code);
        const out = await mermaid.render(`mmd-${++diagramSeq}`, code);
        if (!cancelled) setSvg(out.svg);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message.split("\n")[0]);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);
  if (error) {
    return (
      <div className="md-mermaid-error">
        <div className="small text-bad">流程图无法绘制：{error}</div>
        <pre className="mono-block">{code}</pre>
      </div>
    );
  }
  if (!svg) return <div className="md-mermaid md-mermaid-loading">正在绘制流程图…</div>;
  return (
    <div
      className="md-mermaid"
      // Mermaid's strict security level sanitises the SVG it produces (no scripts, no raw HTML labels).
      // biome-ignore lint/security/noDangerouslySetInnerHtml: output of mermaid.render in strict mode
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// --- renderer ------------------------------------------------------------------------------------------

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

const textOf = (n: HastNode | undefined): string =>
  !n ? "" : n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join("");

function components(streaming: boolean): Components {
  return {
    pre({ node, children }) {
      const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "code");
      const classes = code?.properties?.className;
      const isMermaid = Array.isArray(classes) && classes.includes("language-mermaid");
      // While an answer is still streaming the diagram is incomplete: show its source until it is done.
      if (isMermaid && !streaming) return <Mermaid code={textOf(code).replace(/\n$/, "")} />;
      return <pre className="mono-block">{children}</pre>;
    },
    a({ href, children }) {
      if (href?.startsWith("/") && !href.startsWith("/api/")) return <Link to={href}>{children}</Link>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    img({ src, alt }) {
      return <MessageImage src={typeof src === "string" ? src : undefined} alt={alt} />;
    },
    table({ children }) {
      return (
        <div className="md-table">
          <table>{children}</table>
        </div>
      );
    },
  };
}

export function Markdown({
  content,
  streaming = false,
  trailing,
  mentions,
}: {
  content: string;
  /** Tokens (handle or name, without "@") of what the message really mentions; others are not highlighted. */
  mentions?: string[];
  /** The text is still being written: diagrams stay as source and ``trailing`` (a caret) follows the text. */
  streaming?: boolean;
  trailing?: ReactNode;
}) {
  const key = mentions?.join("\u0000");
  // Rebuilt when the mentioned tokens change (compared by content, not array identity).
  const plugins = useMemo(
    // Chat habit: a single line break in a message is a line break, not a space.
    () => [
      remarkGfm,
      remarkBreaks,
      [remarkMentions, { tokens: mentions }] as [typeof remarkMentions, { tokens?: string[] }],
    ],
    [key],
  );
  return (
    <div className={`msg-text md${streaming ? " md-streaming" : ""}`}>
      <ReactMarkdown remarkPlugins={plugins} components={components(streaming)} urlTransform={urlTransform}>
        {content}
      </ReactMarkdown>
      {trailing}
    </div>
  );
}

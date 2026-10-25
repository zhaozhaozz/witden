import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * A card's app (the server's services/cards.ts, block ``app``): HTML, CSS and JavaScript a role wrote, run in a
 * sandboxed frame so it updates by itself as people use it.
 *
 * The frame is ``sandbox="allow-scripts"`` without ``allow-same-origin``: an opaque origin that cannot read the
 * console's storage (its login), call its API or touch its page; no forms, pop-ups, dialogs or top-level
 * navigation. Its content security policy allows no network at all — no fetch, no outside scripts, styles, fonts
 * or images (data: URLs only). Nor can it navigate its frame to another page to carry data out: the console's pages
 * allow no frame to load anything (``frame-src 'none'``, set by the server; srcdoc is not loaded, so apps run). A
 * navigation all the same (blocked, it loads an error page) is caught as a second load and the app is reset.
 *
 * The policy does not cover WebRTC, which can reach any STUN / TURN server. The bridge removes it from the app's
 * window and, since a frame of the app's own would have a fresh window with WebRTC again, removes any frame the app
 * adds, disables the ways to add one the removal would not see (shadow roots, document.write, setHTMLUnsafe), and
 * stops the app if a frame exists all the same. This is the console's best effort, not a boundary the browser keeps.
 *
 * The app talks to the console only through ``window.witden`` (a bridge injected before its own code):
 * ``state`` / ``setState`` keep its state for this reader (in this browser), ``send(action, data)`` asks to submit
 * one of the card's actions with data — the console asks the person first. The console checks each message comes
 * from this frame and never runs anything the app sends.
 */
export interface AppBlock {
  html: string;
  fallback: string;
  height?: number;
}

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'";

/** The console's look, so apps match it without writing their own styles. */
const BASE_CSS = `
:root { color-scheme: light; --ink: #262d31; --ink-2: #505c62; --ink-3: #717c82; --line: #dfe4e2; --paper: #f3f4f3;
  --surface: #ffffff; --accent: #345c73; --accent-2: #386b8b; --ok: #1e7d4b; --bad: #b42f2a; --wait: #a2600a;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100; --series-5: #e87ba4; --series-6: #008300; }
* { box-sizing: border-box; }
html, body { background: transparent; }
body { margin: 8px; color: var(--ink); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
h1, h2, h3 { margin: 0 0 8px; line-height: 1.3; } h1 { font-size: 20px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
p { margin: 0 0 8px; }
button { font: inherit; padding: 5px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); cursor: pointer; }
button:hover { border-color: var(--accent-2); } button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { background: var(--bad); border-color: var(--bad); color: #fff; } button:disabled { opacity: 0.5; cursor: default; }
input, select, textarea { font: inherit; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); }
input[type="range"] { width: 100%; padding: 0; border: 0; accent-color: var(--accent); }
input[type="checkbox"], input[type="radio"] { accent-color: var(--accent); }
label { display: inline-flex; gap: 6px; align-items: center; }
table { border-collapse: collapse; width: 100%; } th, td { padding: 4px 8px; border-bottom: 1px solid var(--line); text-align: left; }
th { color: var(--ink-3); font-size: 12px; font-weight: 500; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.muted { color: var(--ink-3); } .big { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .grid { display: grid; gap: 8px; }
`;

/** Runs in the frame before the app's own code: the only way it talks to the console. */
const BRIDGE = `(function () {
  var post = function (type, extra) { parent.postMessage(Object.assign({ witden: 1, type: type }, extra || {}), "*"); };
  // No WebRTC, and no frame of the app's own (its window would have WebRTC again): frames are removed as they are
  // added, before they load; the ways to add one out of the observer's sight are disabled.
  window.RTCPeerConnection = window.webkitRTCPeerConnection = undefined;
  var no = function () { throw new Error("not available in a witden app"); };
  Element.prototype.attachShadow = no;
  Document.prototype.write = Document.prototype.writeln = no;
  if (Element.prototype.setHTMLUnsafe) Element.prototype.setHTMLUnsafe = no;
  if (window.ShadowRoot && ShadowRoot.prototype.setHTMLUnsafe) ShadowRoot.prototype.setHTMLUnsafe = no;
  if (Document.parseHTMLUnsafe) Document.parseHTMLUnsafe = no;
  var FRAMES = "iframe,frame,object,embed";
  var unframe = function () {
    document.querySelectorAll(FRAMES).forEach(function (f) { f.remove(); });
    if (window.length > 0) post("stop");
  };
  new MutationObserver(unframe).observe(document, { childList: true, subtree: true });
  setInterval(unframe, 500);
  // Saves only count once the saved state was handed over: an app that renders (and saves) while it starts
  // must not overwrite what the reader had.
  var ready = false;
  var api = {
    state: undefined,
    setState: function (s) { api.state = s; if (ready) post("state", { state: s }); },
    send: function (action, data) { post("action", { action: String(action), data: data === undefined ? null : data }); }
  };
  window.witden = api;
  window.addEventListener("message", function (e) {
    if (e.source !== parent || !e.data || e.data.witden !== 1 || e.data.type !== "init") return;
    api.state = e.data.state;
    ready = true;
    window.dispatchEvent(new CustomEvent("witden:ready", { detail: { state: e.data.state } }));
  });
  var size = function () {
    var b = document.body; if (!b) return;
    post("size", { height: Math.ceil(b.getBoundingClientRect().height) + 16 });
  };
  window.addEventListener("load", function () {
    post("ready"); size();
    if (window.ResizeObserver) new ResizeObserver(size).observe(document.body);
  });
})();`;

/** The frame's whole page: the policy first, then the look and the bridge, then the app. */
export function appDocument(html: string): string {
  // A whole page written by the app keeps its body; its own head would only come after ours anyway.
  const body = html
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?(html|head|body)[^>]*>/gi, "")
    .replace(/<meta[^>]*http-equiv[^>]*>/gi, "")
    // declarative shadow roots are made by the parser, out of the bridge's sight
    .replace(/\bshadowroot(mode)?\s*=/gi, "data-shadowroot=");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${BASE_CSS}</style><script>${BRIDGE}</script></head><body>${body}</body></html>`;
}

const MAX_STATE = 50_000;

export function AppFrame({
  app,
  storageKey,
  onSend,
}: {
  app: AppBlock;
  /** Where this reader's app state is kept (localStorage). */
  storageKey: string;
  /** The app asks to submit an action with data. */
  onSend: (action: string, data: unknown) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const [height, setHeight] = useState(app.height ?? 240);
  const [full, setFull] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // an app that navigates away each time it starts is stopped after a couple of tries; one that has a frame of its
  // own (the bridge could not remove it) at once
  const restarts = useRef(0);
  const [stopped, setStopped] = useState<string | null>(null);
  const doc = useMemo(() => appDocument(app.html), [app.html]);
  const send = useRef(onSend);
  send.current = onSend;

  const restart = useCallback((why: string | null) => {
    loads.current = 0;
    setNotice(why);
    setGeneration((g) => g + 1);
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const d = e.data;
      if (d?.witden !== 1 || typeof d.type !== "string") return;
      if (d.type === "ready") {
        let state: unknown;
        try {
          const raw = localStorage.getItem(storageKey);
          state = raw ? JSON.parse(raw) : undefined;
        } catch {
          state = undefined;
        }
        win.postMessage({ witden: 1, type: "init", state }, "*");
      } else if (d.type === "size" && typeof d.height === "number") {
        setHeight(Math.max(60, Math.min(1200, Math.round(d.height))));
      } else if (d.type === "state") {
        try {
          const raw = JSON.stringify(d.state ?? null);
          if (raw.length <= MAX_STATE) localStorage.setItem(storageKey, raw);
        } catch {
          // a state that cannot be stored (or a full storage) is simply not kept
        }
      } else if (d.type === "action" && typeof d.action === "string") {
        send.current(d.action.slice(0, 40), d.data);
      } else if (d.type === "stop") {
        setStopped("这个小应用试图在自己里面再打开页面，已停止运行。");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [storageKey]);

  return (
    <div className={full ? "wapp wapp-full" : "wapp"}>
      <div className="wapp-bar">
        <span
          className="small muted"
          title="由 AI 员工编写，在隔离的沙箱中运行：拿不到你的账号和控制台里的数据，不能请求网络。不要在小应用中输入密码或密钥。"
        >
          小应用 · 沙箱中运行
        </span>
        <span className="wapp-tools">
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            onClick={() => {
              localStorage.removeItem(storageKey);
              restart(null);
            }}
            title="清除这个小应用保存的状态并重新开始"
          >
            重置
          </button>
          <button type="button" className="btn btn-xs btn-ghost" onClick={() => setFull((f) => !f)}>
            {full ? "退出全屏" : "全屏"}
          </button>
        </span>
      </div>
      {notice && !stopped ? <div className="wapp-notice small">{notice}</div> : null}
      {stopped ? (
        <div className="wapp-notice small">{stopped}</div>
      ) : (
        <iframe
          key={generation}
          ref={frame}
          className="wapp-frame"
          title="小应用"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={doc}
          style={full ? undefined : { height }}
          onLoad={() => {
            // a second load means the app navigated away from its page: start it again
            loads.current += 1;
            if (loads.current <= 1) return;
            restarts.current += 1;
            if (restarts.current > 2) setStopped("这个小应用反复试图打开别的页面，已停止运行。");
            else restart("小应用试图打开别的页面，已阻止并重新载入。");
          }}
        />
      )}
    </div>
  );
}

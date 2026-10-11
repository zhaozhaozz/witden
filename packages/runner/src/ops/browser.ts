import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { access, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BrowserDownloadResult, BrowserSessionInfo, BrowserSnapshotResult } from "@witden/shared";
import type { Browser, BrowserContext, Download, Locator, Page } from "playwright-core";
import type { Env, OpContext } from "../context.js";
import { remainingMs } from "../context.js";
import { OpError } from "../errors.js";
import { optBool, optEnum, optString, reqString } from "../params.js";
import { listProcs, readCmdline } from "../proc.js";
import { pngSize, randomHex, sleep, which } from "../util.js";

type Playwright = typeof import("playwright-core");
type Mode = "desktop" | "background";

const MODES = ["desktop", "background"] as const;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REF = /^e\d{1,6}$/;
const REF_ATTR = "data-witden-ref";
const MAX_TEXT = 8000;
const MAX_ELEMENTS = 300;
const BLANK_URLS = new Set(["about:blank", "chrome://newtab/", "chrome://new-tab-page/"]);

/**
 * Runs inside the page: tags visible interactive elements with data-witden-ref="eN" (refs from earlier snapshots
 * are cleared) and returns them with their role / accessible name, plus the visible text.
 */
const SNAPSHOT_SCRIPT = `((opts) => {
  const ATTR = ${JSON.stringify(REF_ATTR)};
  for (const el of document.querySelectorAll("[" + ATTR + "]")) el.removeAttribute(ATTR);
  const selector = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=menuitem]",
    "[role=option]", "[role=switch]", "[role=textbox]", "[role=combobox]", "[role=searchbox]", "[role=slider]",
    "[contenteditable='']", "[contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])"
  ].join(",");
  const clean = (s) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  const implicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox" || t === "radio") return t;
      if (t === "range") return "slider";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "generic";
  };
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = clean(by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).innerText || "").join(" "));
      if (t) return t;
    }
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    for (const a of ["alt", "title", "placeholder"]) {
      const v = el.getAttribute(a);
      if (v) return clean(v);
    }
    const text = clean(el.innerText || el.textContent);
    if (text) return text;
    if (typeof el.value === "string" && el.value) return clean(el.value);
    return clean(el.getAttribute("name") || el.getAttribute("href") || "");
  };
  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= opts.maxElements) break;
    if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
    const ref = "e" + ++n;
    el.setAttribute(ATTR, ref);
    elements.push({ ref, role: el.getAttribute("role") || implicitRole(el), name: nameOf(el) });
  }
  const full = (document.body && document.body.innerText) || "";
  const text = full.length > opts.maxText ? full.slice(0, opts.maxText) + "\\n...[text truncated]" : full;
  return { text, elements };
})`;

interface Session {
  id: string;
  mode: Mode;
  page: Page;
}

export interface BrowserOptions {
  display: string | null;
  cdpPort: number;
  chromiumPath: string;
  profileDir: string;
  downloadsDir: string;
  stateDir: string;
}

function normalizeUrl(input: string): string {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
  try {
    new URL(url);
  } catch {
    throw new OpError("invalid", `invalid URL: ${input}`);
  }
  return url;
}

function safeFileName(name: string): string {
  const base = path.basename(name.replace(/[\\/\0]/g, "_")).trim();
  return !base || base === "." || base === ".." ? "download" : base.slice(0, 200);
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
}

/**
 * Browser sessions via playwright-core (optional dependency, loaded on first use).
 * - desktop: the Chromium on the computer's desktop, driven over CDP so people watch (and can take over) the
 *   same tabs; started on the desktop when nothing listens on the CDP port.
 * - background: a separate headless Chromium; results always say mode "background".
 */
export class Browsers {
  private playwright: Promise<Playwright | null> | null = null;
  private desktop: Promise<Browser> | null = null;
  private background: Promise<{ browser: Browser; context: BrowserContext }> | null = null;
  private readonly sessions = new Map<string, Session>();
  /** Downloads taken by a browser.download request (not auto-saved). */
  private readonly claimed = new WeakSet<Download>();

  constructor(
    private readonly env: Env,
    private readonly options: BrowserOptions,
  ) {}

  private loadPlaywright(): Promise<Playwright | null> {
    this.playwright ??= import("playwright-core")
      .then((mod) => ((mod as { chromium?: unknown }).chromium ? mod : (mod as { default: Playwright }).default))
      .catch(() => null);
    return this.playwright;
  }

  private async pw(): Promise<Playwright> {
    const pw = await this.loadPlaywright();
    if (!pw) throw new OpError("unsupported", "browser automation is not available (playwright-core is missing)");
    return pw;
  }

  private get cdpUrl(): string {
    return `http://127.0.0.1:${this.options.cdpPort}`;
  }

  private async cdpReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async available(): Promise<boolean> {
    if (!(await this.loadPlaywright())) return false;
    return !!which(this.options.chromiumPath) || (await this.cdpReachable());
  }

  // --- browsers ---------------------------------------------------------------------------------------

  private desktopBrowser(ctx: OpContext): Promise<Browser> {
    this.desktop ??= this.connectDesktop(ctx).catch((err) => {
      this.desktop = null;
      throw err;
    });
    return this.desktop;
  }

  private async connectDesktop(ctx: OpContext): Promise<Browser> {
    const pw = await this.pw();
    if (!(await this.cdpReachable())) await this.launchDesktopChromium(ctx);
    const browser = await pw.chromium.connectOverCDP(this.cdpUrl, { timeout: remainingMs(ctx) });
    browser.on("disconnected", () => {
      this.desktop = null;
      for (const [id, s] of this.sessions) if (s.mode === "desktop") this.sessions.delete(id);
    });
    const context = browser.contexts()[0];
    if (context) this.autoSaveDownloads(context);
    return browser;
  }

  /** Starts the desktop Chromium with remote debugging, detached so it outlives runner restarts. */
  private async launchDesktopChromium(ctx: OpContext): Promise<void> {
    if (!this.options.display) throw new OpError("unsupported", "this computer has no desktop browser");
    const bin = which(this.options.chromiumPath);
    if (!bin) throw new OpError("unsupported", `Chromium is not installed (${this.options.chromiumPath})`);
    if (desktopChromiumRunning(this.options.profileDir)) {
      throw new OpError(
        "failed",
        `Chromium is already running on the desktop without remote debugging (port ${this.options.cdpPort}); close it and retry`,
      );
    }
    const profile = this.options.profileDir;
    mkdirSync(profile, { recursive: true });
    // Locks left by a previous container (other hostname) would make Chromium refuse the profile.
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      await rm(path.join(profile, lock), { force: true });
    }
    mkdirSync(this.options.stateDir, { recursive: true });
    const log = openSync(path.join(this.options.stateDir, "chromium-desktop.log"), "w");
    const child = spawn(
      bin,
      [
        `--remote-debugging-port=${this.options.cdpPort}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--start-maximized",
      ],
      {
        detached: true,
        stdio: ["ignore", log, log],
        cwd: this.env.home,
        env: this.env.childEnv({ DISPLAY: this.options.display }),
      },
    );
    closeSync(log);
    let exited: string | null = null;
    child.on("error", (err) => {
      exited = err.message;
    });
    child.on("exit", (code, signal) => {
      exited = `exit ${code ?? signal}`;
    });
    child.unref();
    const deadline = Date.now() + Math.min(remainingMs(ctx), 30_000);
    while (Date.now() < deadline) {
      if (await this.cdpReachable()) return;
      if (exited) break;
      if (ctx.signal.aborted) break;
      await sleep(250);
    }
    if (await this.cdpReachable()) return;
    throw new OpError(
      "failed",
      `desktop Chromium did not open its debugging port${exited ? ` (${exited})` : ""}; see ~/.witden-runner/chromium-desktop.log`,
    );
  }

  private backgroundContext(ctx: OpContext): Promise<BrowserContext> {
    this.background ??= (async () => {
      const pw = await this.pw();
      const bin = which(this.options.chromiumPath);
      if (!bin) throw new OpError("unsupported", `Chromium is not installed (${this.options.chromiumPath})`);
      const env = this.env.childEnv();
      delete env.DISPLAY;
      const browser = await pw.chromium.launch({
        executablePath: bin,
        headless: true,
        args: ["--disable-dev-shm-usage", "--no-first-run"],
        env: env as Record<string, string>,
        timeout: remainingMs(ctx),
      });
      browser.on("disconnected", () => {
        this.background = null;
        for (const [id, s] of this.sessions) if (s.mode === "background") this.sessions.delete(id);
      });
      const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
      return { browser, context };
    })().catch((err) => {
      this.background = null;
      throw err;
    });
    return this.background.then((b) => b.context);
  }

  /** While connected over CDP, Playwright receives every desktop download; keep the ones people start. */
  private autoSaveDownloads(context: BrowserContext): void {
    const watch = (page: Page) =>
      page.on("download", (download) => {
        void (async () => {
          await download.path().catch(() => null);
          if (this.claimed.has(download)) return;
          await mkdir(this.options.downloadsDir, { recursive: true });
          const dest = await uniquePath(this.options.downloadsDir, safeFileName(download.suggestedFilename()));
          await download.saveAs(dest);
        })().catch((err) => this.env.logger.warn("cannot keep a desktop download", { error: String(err) }));
      });
    context.pages().forEach(watch);
    context.on("page", watch);
  }

  private async newPage(mode: Mode, ctx: OpContext): Promise<Page> {
    if (mode === "background") return (await this.backgroundContext(ctx)).newPage();
    const browser = await this.desktopBrowser(ctx);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    // Reuse an empty tab (e.g. the one a fresh browser opens) instead of piling up new ones.
    const owned = new Set([...this.sessions.values()].map((s) => s.page));
    const blank = context.pages().find((p) => !owned.has(p) && BLANK_URLS.has(p.url()));
    return blank ?? (await context.newPage());
  }

  // --- sessions ---------------------------------------------------------------------------------------

  private session(params: Record<string, unknown>): Session {
    const id = reqString(params, "sessionId", 100);
    const session = this.sessions.get(id);
    if (!session || session.page.isClosed()) {
      this.sessions.delete(id);
      throw new OpError("not_found", `browser session ${id} not found`);
    }
    return session;
  }

  private async info(session: Session): Promise<BrowserSessionInfo> {
    return {
      sessionId: session.id,
      mode: session.mode,
      url: session.page.url(),
      title: await session.page.title().catch(() => ""),
    };
  }

  private async locate(page: Page, params: Record<string, unknown>): Promise<Locator> {
    const ref = optString(params, "ref", 20);
    const selector = optString(params, "selector", 2000);
    const text = optString(params, "text", 1000);
    if (ref) {
      if (!REF.test(ref)) throw new OpError("invalid", "ref must look like e12 (from browser.snapshot)");
      const loc = page.locator(`[${REF_ATTR}="${ref}"]`).first();
      if ((await loc.count()) === 0) {
        throw new OpError("not_found", `element ${ref} is no longer on the page; take a new snapshot`);
      }
      return loc;
    }
    if (selector) return page.locator(selector).first();
    if (text) return page.getByText(text).first();
    throw new OpError("invalid", "one of ref, selector or text is required");
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
  }

  async open(params: Record<string, unknown>, ctx: OpContext): Promise<BrowserSessionInfo> {
    const url = normalizeUrl(reqString(params, "url", 2_000_000));
    const mode: Mode = optEnum(params, "mode", MODES) ?? (this.options.display ? "desktop" : "background");
    const requested = optString(params, "sessionId", 100);
    if (requested !== undefined && !SESSION_ID.test(requested)) throw new OpError("invalid", "invalid session id");
    let session = requested ? this.sessions.get(requested) : undefined;
    if (session?.page.isClosed()) {
      this.sessions.delete(session.id);
      session = undefined;
    }
    if (session && session.mode !== mode) {
      throw new OpError("invalid", `session ${session.id} is a ${session.mode} session`);
    }
    if (!session) {
      const page = await this.newPage(mode, ctx);
      const created: Session = { id: requested ?? `br-${randomHex(4)}`, mode, page };
      session = created;
      this.sessions.set(created.id, created);
      page.on("close", () => {
        if (this.sessions.get(created.id)?.page === page) this.sessions.delete(created.id);
      });
    }
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: remainingMs(ctx) });
    if (mode === "desktop") await session.page.bringToFront().catch(() => {});
    return this.info(session);
  }

  async snapshot(params: Record<string, unknown>, _ctx: OpContext): Promise<BrowserSnapshotResult> {
    const session = this.session(params);
    const data = (await session.page.evaluate(
      `${SNAPSHOT_SCRIPT}(${JSON.stringify({ maxText: MAX_TEXT, maxElements: MAX_ELEMENTS })})`,
    )) as Pick<BrowserSnapshotResult, "text" | "elements">;
    return { ...(await this.info(session)), text: data.text, elements: data.elements };
  }

  async click(params: Record<string, unknown>, ctx: OpContext): Promise<BrowserSessionInfo> {
    const session = this.session(params);
    const loc = await this.locate(session.page, params);
    await loc.click({ timeout: remainingMs(ctx) });
    await this.settle(session.page);
    return this.info(session);
  }

  async type(params: Record<string, unknown>, ctx: OpContext): Promise<BrowserSessionInfo> {
    const session = this.session(params);
    const value = reqString(params, "value", 1_000_000);
    const submit = optBool(params, "submit") ?? false;
    const loc = await this.locate(session.page, params);
    try {
      await loc.fill(value, { timeout: remainingMs(ctx) });
    } catch (err) {
      if (!/not an <input>|not editable|contenteditable/i.test(String(err))) throw err;
      await loc.click({ timeout: remainingMs(ctx) });
      await session.page.keyboard.type(value);
    }
    if (submit) await loc.press("Enter", { timeout: remainingMs(ctx) });
    await this.settle(session.page);
    return this.info(session);
  }

  async download(params: Record<string, unknown>, ctx: OpContext): Promise<BrowserDownloadResult> {
    const session = this.session(params);
    const loc = await this.locate(session.page, params);
    const timeout = remainingMs(ctx);
    const [download] = await Promise.all([
      session.page.waitForEvent("download", {
        timeout,
        predicate: (d) => {
          this.claimed.add(d);
          return true;
        },
      }),
      loc.click({ timeout }),
    ]);
    const suggestedName = download.suggestedFilename();
    await mkdir(this.options.downloadsDir, { recursive: true });
    const dest = await uniquePath(this.options.downloadsDir, safeFileName(suggestedName));
    await download.saveAs(dest);
    const failure = await download.failure();
    if (failure) throw new OpError("failed", `download failed: ${failure}`);
    const size = (await stat(dest)).size;
    ctx.emit("browser.download", { path: dest, size, suggestedName }, session.id);
    return { path: dest, size, suggestedName };
  }

  async screenshot(params: Record<string, unknown>, ctx: OpContext): Promise<Record<string, unknown>> {
    const session = this.session(params);
    const png = await session.page.screenshot({ type: "png", timeout: remainingMs(ctx) });
    return { sessionId: session.id, mode: session.mode, pngBase64: png.toString("base64"), ...pngSize(png) };
  }

  async close(params: Record<string, unknown>): Promise<{ sessionId: string; closed: boolean }> {
    const id = reqString(params, "sessionId", 100);
    const session = this.sessions.get(id);
    if (!session) throw new OpError("not_found", `browser session ${id} not found`);
    this.sessions.delete(id);
    await session.page.close().catch(() => {});
    if (session.mode === "background" && ![...this.sessions.values()].some((s) => s.mode === "background")) {
      const bg = this.background;
      this.background = null;
      await bg?.then((b) => b.browser.close()).catch(() => {});
    }
    return { sessionId: id, closed: true };
  }

  async list(): Promise<{ sessions: BrowserSessionInfo[] }> {
    const sessions: BrowserSessionInfo[] = [];
    for (const [id, session] of this.sessions) {
      if (session.page.isClosed()) this.sessions.delete(id);
      else sessions.push(await this.info(session));
    }
    return { sessions };
  }

  /** Disconnects from the desktop browser (it keeps running) and closes the background one. */
  async dispose(): Promise<void> {
    const desktop = this.desktop;
    const background = this.background;
    this.desktop = null;
    this.background = null;
    await desktop?.then((b) => b.close()).catch(() => {});
    await background?.then((b) => b.browser.close()).catch(() => {});
  }
}

/** A desktop Chromium (not headless, not a helper process) using the given profile is running. */
function desktopChromiumRunning(profileDir: string): boolean {
  for (const p of listProcs()) {
    if (!p.comm.startsWith("chromium") && !p.comm.startsWith("chrome")) continue;
    const cmd = readCmdline(p.pid);
    if (cmd.includes("--type=") || cmd.includes("--headless")) continue;
    const dir = /--user-data-dir=(\S+)/.exec(cmd)?.[1];
    if (!dir || path.resolve(dir) === path.resolve(profileDir)) return true;
  }
  return false;
}

/**
 * Two addresses. The console address (WITDEN_PUBLIC_URL) is where people open the console; links in messages
 * point there, and it is not meant to be reachable from the internet. The public address is what Slack,
 * GitHub and Feishu send events to: it must forward to the webhook listener (api/webhooks.ts), which serves
 * the event webhooks and nothing else. It is set in the console after a check, and falls back to the console
 * address for deployments that never set one.
 *
 * Also manages the optional Cloudflare Tunnel: the console writes the tunnel token to a file the "tunnel"
 * compose service reads (cloudflared --token-file), and reads the tunnel's state from its metrics server.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import { secretBox } from "../security/crypto.js";
import { getSetting, putSetting } from "./platform-settings.js";

export const PUBLIC_URL = "public_url";
const PROBE_PURPOSE = "public-url-probe";

/** The public address platforms send events to (and fetch role avatars from), without a trailing slash. */
export async function webhookBase(db: Db): Promise<string> {
  const saved = await getSetting<{ url: string }>(db, PUBLIC_URL);
  return (saved?.url ?? settings().publicUrl).replace(/\/+$/, "");
}

/** Where people open the console: the base of links in messages, never the public address. */
export const consoleBase = (): string => settings().publicUrl.replace(/\/+$/, "");

export async function savePublicUrl(db: Db, url: string | null, userId: string): Promise<void> {
  await putSetting(db, PUBLIC_URL, url ? { url } : {}, userId);
}

/** The webhook listener's answer to GET /api/integrations/probe: proves the request reached this deployment. */
export const probeAnswer = (nonce: string) => ({ witden: true, proof: secretBox().proof(PROBE_PURPOSE, nonce) });

let probeFetch: typeof fetch = (...args) => fetch(...args);
/** Tests replace the network. */
export function setProbeFetch(f: typeof fetch): void {
  probeFetch = f;
}

export type CheckProblem =
  | "format"
  | "https"
  | "private"
  | "dns"
  | "tls"
  | "unreachable"
  | "timeout"
  | "redirect"
  | "http"
  | "not_witden"
  | "other_instance"
  | "console_exposed";

export interface UrlCheck {
  ok: boolean;
  /** The address as it will be saved: scheme and host only. */
  url: string;
  problem?: CheckProblem;
  detail?: string;
  /** The failure may come from this server's own network (e.g. no hairpin NAT), so saving anyway is allowed. */
  overridable?: boolean;
  /** This server's DNS did not resolve the host; it was checked at this address from public DNS. */
  publicDns?: string;
}

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_NOT_YET_VALID",
]);

const privateHost = (host: string) =>
  host === "localhost" ||
  !host.includes(".") ||
  /\.(local|internal|lan|home|localhost)$/.test(host) ||
  host.startsWith("[") ||
  /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
    host,
  );

/** A failed request, in the words of the check (fetch reports the cause's code). */
function failure(url: string, err: unknown): UrlCheck {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const code = e.cause?.code ?? "";
  const detail = e.cause?.message ?? e.message;
  if (e.name === "TimeoutError" || e.name === "AbortError")
    return { ok: false, url, problem: "timeout", overridable: true };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return { ok: false, url, problem: "dns", detail, overridable: true };
  if (TLS_CODES.has(code) || /certificate|self.signed/i.test(detail)) return { ok: false, url, problem: "tls", detail };
  return { ok: false, url, problem: "unreachable", detail: code || detail, overridable: true };
}

/** An IPv4 address of ``host`` in public DNS (Cloudflare's DNS over HTTPS, reached by IP), or null. */
async function publicIPv4(host: string): Promise<string | null> {
  try {
    const res = await probeFetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { Answer?: { type: number; data: string }[] };
    return data.Answer?.find((a) => a.type === 1)?.data ?? null;
  } catch {
    return null;
  }
}

/** GET ``url`` connected to ``address`` instead of resolving its host; the TLS name and Host header stay. */
function fetchAt(url: string, address: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          opts.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)) as never,
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers.set(k, v);
          const status = res.statusCode ?? 502;
          resolve(new Response([204, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
        });
      },
    );
    // Fail the way fetch does, so the failure is described the same.
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
    req.on("error", (err) =>
      reject(err.name === "TimeoutError" ? err : Object.assign(new TypeError("fetch failed"), { cause: err })),
    );
  });
}

let pinnedFetch = fetchAt;
/** Tests replace the connection to a given address. */
export function setPinnedFetch(f: typeof fetchAt): void {
  pinnedFetch = f;
}

/**
 * Check that platforms can send events to ``raw``: an https origin on a public host that answers, through
 * whatever proxy or tunnel is in front, with this deployment's own proof for a fresh nonce from the webhook
 * listener, and that does not reach the console. When this server's own DNS cannot resolve the host (some
 * networks drop records), the host is looked up in public DNS, which is what the platforms use.
 */
export async function checkPublicUrl(raw: string): Promise<UrlCheck> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, url: raw.trim(), problem: "format", detail: "not a URL" };
  }
  const url = u.origin;
  if (u.protocol !== "https:") return { ok: false, url, problem: "https" };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash)
    return { ok: false, url, problem: "format", detail: "only the scheme and host, without a path" };
  if (privateHost(u.hostname)) return { ok: false, url, problem: "private" };

  const probe = `/api/integrations/probe?nonce=${randomBytes(16).toString("hex")}`;
  const nonce = probe.split("=")[1];
  let get = (p: string) => probeFetch(`${url}${p}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  let publicDns: string | undefined;
  let res: Response;
  try {
    res = await get(probe);
  } catch (err) {
    const failed = failure(url, err);
    if (failed.problem !== "dns") return failed;
    const address = await publicIPv4(u.hostname);
    if (!address) return failed;
    publicDns = address;
    get = (p) => pinnedFetch(`${url}${p}`, address);
    try {
      res = await get(probe);
    } catch (again) {
      return { ...failure(url, again), publicDns };
    }
  }
  const via = publicDns ? { publicDns } : {};
  if (res.status >= 300 && res.status < 400)
    return { ok: false, url, problem: "redirect", detail: res.headers.get("location") ?? "", ...via };
  if (!res.ok) return { ok: false, url, problem: "http", detail: `HTTP ${res.status}`, ...via };
  const body = (await res.json().catch(() => null)) as { witden?: boolean; proof?: string; listener?: string } | null;
  // Forwarded to the console's port: the whole console would be public.
  if (body?.witden && body.listener === "console")
    return { ok: false, url, problem: "console_exposed", detail: "console port", ...via };
  if (!body?.witden || typeof body.proof !== "string") return { ok: false, url, problem: "not_witden", ...via };
  if (body.proof !== secretBox().proof(PROBE_PURPOSE, nonce))
    return { ok: false, url, problem: "other_instance", ...via };
  // The proxy may still route other paths to the console; the webhook listener has no /api/health.
  try {
    const hit = await get("/api/health");
    const health = (await hit.json().catch(() => null)) as { ok?: boolean; version?: string } | null;
    if (hit.ok && health?.ok && health.version)
      return { ok: false, url, problem: "console_exposed", detail: "/api/health", ...via };
  } catch {
    // nothing answered there: fine
  }
  return { ok: true, url, ...via };
}

// --- Cloudflare Tunnel ------------------------------------------------------------------------------------

/** The parts of a tunnel token that are not secret: the account and the tunnel it belongs to. */
export interface TunnelToken {
  account: string;
  tunnel: string;
}

/** Find a tunnel token in what was pasted (the token itself or the whole install command) and decode it. */
export function parseTunnelToken(pasted: string): { token: string; info: TunnelToken } | null {
  for (const candidate of pasted.match(/eyJ[A-Za-z0-9+/_-]+=*/g) ?? []) {
    try {
      const v = JSON.parse(Buffer.from(candidate, "base64").toString("utf8"));
      if (typeof v.a === "string" && typeof v.t === "string" && typeof v.s === "string")
        return { token: candidate, info: { account: v.a, tunnel: v.t } };
    } catch {
      // not this one
    }
  }
  return null;
}

/** Write the token where the tunnel service reads it; replaced atomically, readable by its non-root user. */
export function writeTunnelToken(token: string | null): void {
  const file = settings().tunnelTokenFile;
  if (!file) throw new Error("this deployment has no tunnel service");
  if (!token) {
    fs.rmSync(file, { force: true });
    return;
  }
  const tmp = path.join(path.dirname(file), `.token-${process.pid}`);
  fs.writeFileSync(tmp, token, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function savedTunnelToken(): TunnelToken | null {
  const file = settings().tunnelTokenFile;
  if (!file || !fs.existsSync(file)) return null;
  return parseTunnelToken(fs.readFileSync(file, "utf8"))?.info ?? null;
}

export interface TunnelStatus {
  /** The deployment runs with a tunnel service (WITDEN_TUNNEL_TOKEN_FILE is set). */
  available: boolean;
  token: TunnelToken | null;
  /** not_running: no answer from cloudflared; connecting: started, not connected to Cloudflare yet. */
  state: "not_running" | "connecting" | "connected";
  /** Published routes of the tunnel, and the origin they should point at. */
  routes: { hostname: string; service: string }[];
  origin: string | null;
}

let metricsFetch: typeof fetch = (...args) => fetch(...args);
export function setTunnelMetricsFetch(f: typeof fetch): void {
  metricsFetch = f;
}

export async function tunnelStatus(): Promise<TunnelStatus> {
  const s = settings();
  const out: TunnelStatus = {
    available: !!s.tunnelTokenFile,
    token: savedTunnelToken(),
    state: "not_running",
    routes: [],
    origin: s.tunnelOrigin,
  };
  if (!s.tunnelMetricsUrl) return out;
  const base = s.tunnelMetricsUrl.replace(/\/+$/, "");
  try {
    const ready = await metricsFetch(`${base}/ready`, { signal: AbortSignal.timeout(3000) });
    out.state = ready.ok ? "connected" : "connecting";
    // The routes added in the Cloudflare dashboard arrive as the tunnel's remote configuration.
    const config = (await (await metricsFetch(`${base}/config`, { signal: AbortSignal.timeout(3000) })).json()) as {
      config?: { ingress?: { hostname?: string; service?: string }[] };
    };
    out.routes = (config.config?.ingress ?? [])
      .filter((r) => r.hostname)
      .map((r) => ({ hostname: r.hostname!, service: r.service ?? "" }));
  } catch {
    // cloudflared is not running (no token yet, or the compose profile is off)
  }
  return out;
}

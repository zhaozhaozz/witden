/**
 * The public address of this deployment: what Slack, GitHub and Feishu send events to, and the base of links
 * in messages sent out. An address set in the console (checked first) takes precedence over WITDEN_PUBLIC_URL.
 *
 * Also manages the optional Cloudflare Tunnel: the console writes the tunnel token to a file the "tunnel"
 * compose service reads (cloudflared --token-file), and reads the tunnel's state from its metrics server.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import { secretBox } from "../security/crypto.js";
import { getSetting, putSetting } from "./platform-settings.js";

export const PUBLIC_URL = "public_url";
const PROBE_PURPOSE = "public-url-probe";

/** The public address without a trailing slash. */
export async function publicBase(db: Db): Promise<string> {
  const saved = await getSetting<{ url: string }>(db, PUBLIC_URL);
  return (saved?.url ?? settings().publicUrl).replace(/\/+$/, "");
}

export async function savePublicUrl(db: Db, url: string | null, userId: string): Promise<void> {
  await putSetting(db, PUBLIC_URL, url ? { url } : {}, userId);
}

/** Answer for GET /api/integrations/probe: proves the request reached this deployment. */
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
  | "other_instance";

export interface UrlCheck {
  ok: boolean;
  /** The address as it will be saved: scheme and host only. */
  url: string;
  problem?: CheckProblem;
  detail?: string;
  /** The failure may come from this server's own network (e.g. no hairpin NAT), so saving anyway is allowed. */
  overridable?: boolean;
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

/**
 * Check that platforms can send events to ``raw``: an https origin on a public host that answers, through
 * whatever proxy or tunnel is in front, with this deployment's own proof for a fresh nonce.
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

  const nonce = randomBytes(16).toString("hex");
  let res: Response;
  try {
    res = await probeFetch(`${url}/api/integrations/probe?nonce=${nonce}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const code = e.cause?.code ?? "";
    const detail = e.cause?.message ?? e.message;
    if (e.name === "TimeoutError" || e.name === "AbortError")
      return { ok: false, url, problem: "timeout", overridable: true };
    if (code === "ENOTFOUND" || code === "EAI_AGAIN")
      return { ok: false, url, problem: "dns", detail, overridable: true };
    if (TLS_CODES.has(code) || /certificate|self.signed/i.test(detail))
      return { ok: false, url, problem: "tls", detail };
    return { ok: false, url, problem: "unreachable", detail: code || detail, overridable: true };
  }
  if (res.status >= 300 && res.status < 400)
    return { ok: false, url, problem: "redirect", detail: res.headers.get("location") ?? "" };
  if (!res.ok) return { ok: false, url, problem: "http", detail: `HTTP ${res.status}` };
  const body = (await res.json().catch(() => null)) as { witden?: boolean; proof?: string } | null;
  if (!body?.witden || typeof body.proof !== "string") return { ok: false, url, problem: "not_witden" };
  if (body.proof !== secretBox().proof(PROBE_PURPOSE, nonce)) return { ok: false, url, problem: "other_instance" };
  return { ok: true, url };
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

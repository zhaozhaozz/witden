import path from "node:path";

/** Runtime settings, read from environment variables prefixed with WITDEN_. */
export interface Settings {
  dataDir: string;
  /** postgres://... for PostgreSQL; pglite://<dir> or pglite://memory for the embedded engine. */
  databaseUrl: string;
  /** Master key (base64, 32 bytes) for credentials at rest; generated into dataDir when empty. */
  secretKey: string | null;
  host: string;
  port: number;
  /** Default public address; an address set in the console (services/public-url.ts) takes precedence. */
  publicUrl: string;
  corsOrigins: string[];
  /** Cloudflare Tunnel (the optional "tunnel" compose service): where to write its token, where its metrics
   * server answers, and the address its routes should point at. Empty file path = no tunnel service. */
  tunnelTokenFile: string | null;
  tunnelMetricsUrl: string | null;
  tunnelOrigin: string | null;
  /** Listener for the routes the internet may reach (event webhooks, the address check, avatars) and
   * nothing else; the public address forwards here. 0 = no such listener. */
  webhookPort: number;
  webhookHost: string;
  /** Port of the runner hub (computers dial in here); separate from the API port. */
  hubPort: number;
  hubHost: string;
  /** URL computers use to reach the hub (resolved inside the computer). */
  hubUrlForComputers: string;
  /** Loopback port of the model proxy inside computers. */
  modelProxyPort: number;
  /** A Laya decision server (e.g. the optional "laya" compose service) to add as a System 1 model on start. */
  layaUrl: string | null;
  layaApiKey: string | null;
  /** Where the model catalog (services/model-catalog.ts) is fetched from; null ("off") = never fetched. */
  modelCatalogUrl: string | null;
  /** Remote Docker Manager; empty = run the manager in-process (single-host deployments). */
  managerUrl: string | null;
  managerToken: string | null;
  /** Shared secret for internal calls (worker -> execution gateway). */
  internalToken: string | null;
  /** api | worker | all */
  processRole: "api" | "worker" | "all";
  /** URL of the API used by a separate worker process to reach the execution gateway. */
  apiUrlForWorker: string;
  workerConcurrency: number;
  sessionTtlHours: number;
  bootstrapAdminEmail: string | null;
  bootstrapAdminPassword: string | null;
  bootstrapAdminName: string;
  maxDelegationDepth: number;
  maxAutoRounds: number;
  instanceWaitSeconds: number;
  toolOutputLimit: number;
  allowedRuntimes: string[];
  /** The built-in templates' computer images are <imageRepo>/computer-shell:<imageTag> (and computer-desktop);
   * Compose points these at the published images, a source checkout keeps the local `make images` names. */
  imageRepo: string;
  imageTag: string;
  webDist: string | null;
}

const env = (key: string): string | undefined => {
  const v = process.env[`WITDEN_${key}`];
  return v === undefined || v === "" ? undefined : v;
};
const int = (key: string, def: number): number => {
  const v = env(key);
  return v === undefined ? def : Number.parseInt(v, 10);
};
const list = (key: string, def: string[]): string[] => {
  const v = env(key);
  return v === undefined
    ? def
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
};

/** models.dev unless set; "off" turns fetching off (offline deployments). */
const catalogUrl = (v: string | undefined): string | null =>
  v === undefined ? "https://models.dev/api.json" : v.toLowerCase() === "off" ? null : v;

export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  const dataDir = path.resolve(overrides.dataDir ?? env("DATA_DIR") ?? "./data");
  const port = overrides.port ?? int("PORT", 8320);
  const base: Settings = {
    dataDir,
    databaseUrl: env("DATABASE_URL") ?? `pglite://${path.join(dataDir, "pg")}`,
    secretKey: env("SECRET_KEY") ?? null,
    host: env("HOST") ?? "0.0.0.0",
    port,
    publicUrl: env("PUBLIC_URL") ?? `http://localhost:${port}`,
    corsOrigins: list("CORS_ORIGINS", []),
    tunnelTokenFile: env("TUNNEL_TOKEN_FILE") ?? null,
    tunnelMetricsUrl: env("TUNNEL_METRICS_URL") ?? null,
    tunnelOrigin: env("TUNNEL_ORIGIN") ?? null,
    webhookPort: int("WEBHOOK_PORT", 8325),
    webhookHost: env("WEBHOOK_HOST") ?? env("HOST") ?? "0.0.0.0",
    hubPort: int("HUB_PORT", 8330),
    hubHost: env("HUB_HOST") ?? "0.0.0.0",
    hubUrlForComputers: env("HUB_URL_FOR_COMPUTERS") ?? "ws://witden-hub:8330/runner",
    modelProxyPort: int("MODEL_PROXY_PORT", 8686),
    layaUrl: env("LAYA_URL") ?? null,
    layaApiKey: env("LAYA_API_KEY") ?? null,
    modelCatalogUrl: catalogUrl(env("MODEL_CATALOG_URL")),
    managerUrl: env("MANAGER_URL") ?? null,
    managerToken: env("MANAGER_TOKEN") ?? null,
    internalToken: env("INTERNAL_TOKEN") ?? null,
    processRole: (env("PROCESS_ROLE") as Settings["processRole"]) ?? "all",
    apiUrlForWorker: env("API_URL_FOR_WORKER") ?? `http://127.0.0.1:${port}`,
    workerConcurrency: int("WORKER_CONCURRENCY", 4),
    sessionTtlHours: int("SESSION_TTL_HOURS", 24 * 7),
    bootstrapAdminEmail: env("BOOTSTRAP_ADMIN_EMAIL") ?? null,
    bootstrapAdminPassword: env("BOOTSTRAP_ADMIN_PASSWORD") ?? null,
    bootstrapAdminName: env("BOOTSTRAP_ADMIN_NAME") ?? "admin",
    maxDelegationDepth: int("MAX_DELEGATION_DEPTH", 3),
    maxAutoRounds: int("MAX_AUTO_ROUNDS", 8),
    instanceWaitSeconds: int("INSTANCE_WAIT_SECONDS", 300),
    toolOutputLimit: int("TOOL_OUTPUT_LIMIT", 12_000),
    allowedRuntimes: list("ALLOWED_RUNTIMES", ["runc", "runsc", "sysbox-runc", "kata-runtime"]),
    imageRepo: (env("IMAGE_REPO") ?? "witden").replace(/\/+$/, ""),
    imageTag: env("IMAGE_TAG") ?? "latest",
    webDist: env("WEB_DIST") ?? null,
  };
  return { ...base, ...overrides };
}

let current: Settings | null = null;

export function settings(): Settings {
  if (!current) current = loadSettings();
  return current;
}

export function setSettings(s: Settings): void {
  current = s;
}

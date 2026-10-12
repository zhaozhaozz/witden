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
  publicUrl: string;
  corsOrigins: string[];
  /** Port of the runner hub (computers dial in here); separate from the API port. */
  hubPort: number;
  hubHost: string;
  /** URL computers use to reach the hub (resolved inside the computer). */
  hubUrlForComputers: string;
  /** Loopback port of the model proxy inside computers. */
  modelProxyPort: number;
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
  maxTaskSteps: number;
  maxDelegationDepth: number;
  maxAutoRounds: number;
  instanceWaitSeconds: number;
  toolOutputLimit: number;
  allowedRuntimes: string[];
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
    hubPort: int("HUB_PORT", 8330),
    hubHost: env("HUB_HOST") ?? "0.0.0.0",
    hubUrlForComputers: env("HUB_URL_FOR_COMPUTERS") ?? "ws://witden-hub:8330/runner",
    modelProxyPort: int("MODEL_PROXY_PORT", 8686),
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
    maxTaskSteps: int("MAX_TASK_STEPS", 60),
    maxDelegationDepth: int("MAX_DELEGATION_DEPTH", 3),
    maxAutoRounds: int("MAX_AUTO_ROUNDS", 8),
    instanceWaitSeconds: int("INSTANCE_WAIT_SECONDS", 300),
    toolOutputLimit: int("TOOL_OUTPUT_LIMIT", 12_000),
    allowedRuntimes: list("ALLOWED_RUNTIMES", ["runc", "runsc", "sysbox-runc", "kata-runtime"]),
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

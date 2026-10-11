import { FORBIDDEN_MOUNTS, SAFE_CAPS } from "@witden/shared";
import { and, eq, ne } from "drizzle-orm";
import type { Settings } from "../config.js";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type ComputerTemplate, computerInstances, computerTemplates } from "../db/schema.js";
import { BadRequest, Conflict, NotFound } from "../errors.js";

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const NETWORK_MODES = new Set(["bridge", "internal", "none"]);

export const DEFAULT_CREDENTIAL_PATHS = [
  "~/.ssh",
  "~/.gnupg",
  "~/.netrc",
  "~/.git-credentials",
  "~/.aws",
  "~/.docker",
  "~/.kube",
  "~/.config/gh",
  "~/.config/chromium",
  "~/.config/google-chrome",
  "~/.mozilla",
  "~/.local/share/keyrings",
];

export const RESOURCE_BOUNDS: Record<string, [number, number]> = {
  cpus: [0.1, 64],
  memory_mb: [128, 262_144],
  pids_limit: [32, 100_000],
  disk_gb: [1, 4096],
};

export function validateResources(res: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, [lo, hi]] of Object.entries(RESOURCE_BOUNDS)) {
    const raw = res[key];
    if (raw === undefined || raw === null) continue;
    const value = key === "cpus" ? Number(raw) : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(value)) throw new BadRequest(`resource ${key} must be a number`);
    if (value < lo || value > hi) throw new BadRequest(`resource ${key} must be between ${lo} and ${hi}`);
    out[key] = value;
  }
  const network = res.network ?? "bridge";
  if (!NETWORK_MODES.has(network)) throw new BadRequest(`network must be one of ${[...NETWORK_MODES].join(", ")}`);
  out.network = network;
  return out;
}

export type TemplateInput = Partial<Omit<ComputerTemplate, "id" | "createdAt" | "updatedAt" | "version">>;

/** Templates are user input that ends up in container config; reject anything that weakens isolation. */
export function validateTemplate(data: Record<string, any>, settings: Settings): TemplateInput {
  const image = String(data.image ?? "").trim();
  if (!image || /\s/.test(image)) throw new BadRequest("image is required and must not contain spaces");
  const kind = data.kind ?? "shell";
  if (!["shell", "desktop"].includes(kind)) throw new BadRequest("kind must be shell or desktop");
  const paths: string[] = data.persistentPaths ?? data.persistent_paths ?? [];
  for (const p of paths) {
    if (typeof p !== "string" || !p.startsWith("/") || p.includes("..")) {
      throw new BadRequest(`persistent path ${JSON.stringify(p)} must be an absolute path`);
    }
    const trimmed = p.replace(/\/+$/, "") || "/";
    if (FORBIDDEN_MOUNTS.includes(trimmed)) throw new BadRequest(`persistent path ${p} is not allowed`);
  }
  const credentialPaths: string[] = data.credentialPaths ?? data.credential_paths ?? DEFAULT_CREDENTIAL_PATHS;
  for (const p of credentialPaths) {
    if (typeof p !== "string" || !(p.startsWith("/") || p.startsWith("~/")) || p.includes("..")) {
      throw new BadRequest(`credential path ${JSON.stringify(p)} must be absolute or start with ~/`);
    }
  }
  const caps: string[] = data.capAdd ?? data.cap_add ?? [];
  const badCaps = caps.filter((c) => !SAFE_CAPS.includes(c));
  if (badCaps.length) {
    throw new BadRequest(`capabilities not allowed: ${badCaps.join(", ")}; allowed: ${SAFE_CAPS.join(", ")}`);
  }
  const runtime = data.runtime || null;
  if (runtime && !settings.allowedRuntimes.includes(runtime)) {
    throw new BadRequest(`runtime ${runtime} not allowed; allowed: ${settings.allowedRuntimes.join(", ")}`);
  }
  const env: Record<string, string> = data.env ?? {};
  for (const key of Object.keys(env)) {
    if (!ENV_KEY.test(key)) throw new BadRequest(`invalid environment variable name ${JSON.stringify(key)}`);
    if (key.startsWith("WITDEN_")) throw new BadRequest(`environment variable ${key} is reserved`);
  }
  const command = data.command ?? null;
  if (command !== null && (!Array.isArray(command) || !command.every((c: unknown) => typeof c === "string"))) {
    throw new BadRequest("command must be a list of strings");
  }
  const workdir = data.workdir || "/home/witden";
  if (!workdir.startsWith("/")) throw new BadRequest("workdir must be absolute");
  const user = data.user || "witden";
  if (user === "root" || user === "0") {
    // AI actions run as this user through the runner; root would void the computer's own permission model.
    throw new BadRequest("computers run AI work as an unprivileged user; root is not allowed");
  }
  return {
    name: String(data.name ?? "").trim(),
    description: data.description ?? "",
    image,
    kind,
    workdir,
    user,
    command,
    env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])),
    persistentPaths: [...new Set(paths)],
    credentialPaths: [...new Set(credentialPaths)],
    software: [...(data.software ?? [])],
    defaultResources: validateResources(data.defaultResources ?? data.default_resources ?? {}),
    capAdd: caps,
    runtime,
    desktop: kind === "desktop" ? (data.desktop ?? { display: ":1", width: 1280, height: 800 }) : null,
  };
}

export async function getTemplate(db: Db, id: string): Promise<ComputerTemplate> {
  const [tpl] = await db.select().from(computerTemplates).where(eq(computerTemplates.id, id)).limit(1);
  if (!tpl) throw new NotFound("template not found");
  return tpl;
}

async function nameTaken(db: Db, name: string, exceptId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: computerTemplates.id })
    .from(computerTemplates)
    .where(
      exceptId
        ? and(eq(computerTemplates.name, name), ne(computerTemplates.id, exceptId))
        : eq(computerTemplates.name, name),
    )
    .limit(1);
  return rows.length > 0;
}

export async function createTemplate(db: Db, data: Record<string, any>, settings: Settings, createdBy: string | null) {
  const clean = validateTemplate(data, settings);
  if (!clean.name) throw new BadRequest("name is required");
  if (await nameTaken(db, clean.name)) throw new Conflict(`template ${clean.name} already exists`);
  const [tpl] = await db
    .insert(computerTemplates)
    .values({ id: newId("tpl"), createdBy, ...(clean as any) })
    .returning();
  return tpl;
}

export async function updateTemplate(db: Db, tpl: ComputerTemplate, data: Record<string, any>, settings: Settings) {
  const merged = { ...tpl, ...data };
  const clean = validateTemplate(merged, settings);
  if (clean.name && clean.name !== tpl.name && (await nameTaken(db, clean.name, tpl.id))) {
    throw new Conflict(`template ${clean.name} already exists`);
  }
  // Existing instances keep their snapshot; only new instances use the new version.
  const [row] = await db
    .update(computerTemplates)
    .set({ ...(clean as any), version: tpl.version + 1 })
    .where(eq(computerTemplates.id, tpl.id))
    .returning();
  return row;
}

export async function copyTemplate(db: Db, tpl: ComputerTemplate, newName: string, createdBy: string | null) {
  if (await nameTaken(db, newName)) throw new Conflict(`template ${newName} already exists`);
  const { id: _id, createdAt: _c, updatedAt: _u, version: _v, ...rest } = tpl;
  const [row] = await db
    .insert(computerTemplates)
    .values({ ...rest, id: newId("tpl"), name: newName, createdBy })
    .returning();
  return row;
}

export async function deleteTemplate(db: Db, tpl: ComputerTemplate): Promise<void> {
  const inUse = await db
    .select({ id: computerInstances.id })
    .from(computerInstances)
    .where(and(eq(computerInstances.templateId, tpl.id), ne(computerInstances.status, "deleted")))
    .limit(1);
  if (inUse.length) throw new Conflict("template still has instances; delete them first or archive the template");
  await db.delete(computerTemplates).where(eq(computerTemplates.id, tpl.id));
}

export const BUILTIN_TEMPLATES: Record<string, any>[] = [
  {
    name: "dev-shell",
    description:
      "Development computer: Debian with git, Python, Node.js, build tools and tmux. The runner and every AI " +
      "action run as the unprivileged user 'witden'; install tools user-locally or bake them into a template.",
    image: "witden/computer-shell:latest",
    kind: "shell",
    workdir: "/home/witden",
    user: "witden",
    persistentPaths: ["/home/witden"],
    software: ["bash", "git", "python3", "nodejs", "build-essential", "tmux", "curl", "ripgrep"],
    defaultResources: { cpus: 2, memory_mb: 4096, pids_limit: 2048, network: "bridge" },
  },
  {
    name: "desktop-browser",
    description:
      "Linux desktop (Xvfb + Fluxbox) with Chromium. AI actions and people watching over noVNC use the same " +
      "desktop; background browser sessions are shown separately.",
    image: "witden/computer-desktop:latest",
    kind: "desktop",
    workdir: "/home/witden",
    user: "witden",
    persistentPaths: ["/home/witden"],
    software: ["chromium", "fluxbox", "xdotool", "imagemagick", "tmux", "x11vnc"],
    defaultResources: { cpus: 2, memory_mb: 4096, pids_limit: 4096, network: "bridge" },
    desktop: { display: ":1", width: 1280, height: 800, vnc_port: 5900, vnc_view_port: 5901 },
  },
];

export async function seedBuiltinTemplates(db: Db, settings: Settings): Promise<void> {
  for (const data of BUILTIN_TEMPLATES) {
    if (!(await nameTaken(db, data.name))) await createTemplate(db, data, settings, null);
  }
}

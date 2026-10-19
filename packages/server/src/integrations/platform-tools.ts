/**
 * Tools a role uses through a connection's own credentials: a company's Feishu (feishu-tools.ts) or a GitHub
 * account or App (github-tools.ts). The role never holds those credentials; the platform makes each call.
 *
 * Permission is per connection and product, kept in the role's tool lists as
 * ``<platform>:<connection>:<product>:read|write``; a write group in ``approval_required`` asks a person first.
 * Each tool belongs to the group ``<platform>:<product>:<mode>``: ``toolsFor`` offers it when the task holds that
 * product and mode for at least one connection, and the call's ``app`` picks which when there are several.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type Connection, connections } from "../db/schema.js";
import { BadRequest } from "../errors.js";
import { FEISHU_PRODUCTS } from "./feishu-tools.js";
import { GITHUB_PRODUCTS } from "./github-tools.js";

export type ToolMode = "read" | "write";

/** The platforms whose connections roles can be given tools of, and their products. */
export const TOOL_PLATFORMS: Record<string, { name: string; label: string; products: { key: string }[] }> = {
  feishu: { name: "Feishu", label: "飞书", products: FEISHU_PRODUCTS },
  github: { name: "GitHub", label: "GitHub", products: GITHUB_PRODUCTS },
};

export interface Grant {
  platform: string;
  connectionId: string;
  product: string;
  mode: ToolMode;
}

export const grantGroup = (platform: string, connectionId: string, product: string, mode: ToolMode) =>
  `${platform}:${connectionId}:${product}:${mode}`;

export function parseGrant(group: string): Grant | null {
  const m = /^([a-z]+):([^:]+):([a-z]+):(read|write)$/.exec(group);
  if (!m || !TOOL_PLATFORMS[m[1]]?.products.some((p) => p.key === m[3])) return null;
  return { platform: m[1], connectionId: m[2], product: m[3], mode: m[4] as ToolMode };
}

/** A tool group of connection tools (``<platform>:<product>:<mode>``, or ``<platform>:apps`` for the listing). */
export const isConnectionToolGroup = (group: string | null) => !!group && !!TOOL_PLATFORMS[group.split(":")[0]];

/** The connections a task may use a product of in a mode, from its envelope's tool groups. */
export function grantedApps(tools: string[], platform: string, product: string, mode: ToolMode): string[] {
  const out: string[] = [];
  for (const g of tools) {
    const p = parseGrant(g);
    if (p && p.platform === platform && p.product === product && p.mode === mode) out.push(p.connectionId);
  }
  return out;
}

/** The connection a call uses: the one named, or the only one the task may use for it. */
export function chosenApp(tools: string[], platform: string, product: string, mode: ToolMode, app: unknown) {
  const granted = grantedApps(tools, platform, product, mode);
  if (typeof app === "string" && app) return granted.includes(app) ? app : null;
  return granted.length === 1 ? granted[0] : null;
}

/** Whether a tool group is offered to a task: ``<platform>:apps`` when it holds any grant of the platform. */
export function groupOffered(group: string, tools: string[]): boolean {
  const [platform, product, mode] = group.split(":");
  if (product === "apps") return tools.some((t) => parseGrant(t)?.platform === platform);
  return grantedApps(tools, platform, product, mode as ToolMode).length > 0;
}

/**
 * Whether a call needs a person's approval: its connection's group asks. A connection not named among several
 * counts as asking if any of them asks (the call fails anyway until it names one).
 */
export function grantNeedsApproval(envelope: Record<string, any>, group: string, args: any): boolean {
  const [platform, product, mode] = group.split(":");
  if (product === "apps") return false;
  const asking = new Set<string>(envelope.approval_required ?? []);
  const tools: string[] = envelope.tools ?? [];
  const app = chosenApp(tools, platform, product, mode as ToolMode, args?.app);
  const apps = app ? [app] : grantedApps(tools, platform, product, mode as ToolMode);
  return apps.some((a) => asking.has(grantGroup(platform, a, product, mode as ToolMode)));
}

/** The connection a call uses, checked: granted to the task for this product and mode, of the platform, active. */
export async function connectionFor(
  db: Db,
  tools: string[],
  platform: string,
  product: string,
  mode: ToolMode,
  app: unknown,
): Promise<Connection> {
  const label = TOOL_PLATFORMS[platform]?.name ?? platform;
  const granted = grantedApps(tools, platform, product, mode);
  const id = chosenApp(tools, platform, product, mode, app);
  if (!id) {
    if (typeof app === "string" && app)
      throw new BadRequest(`you may not use ${product} (${mode}) of the ${label} connection ${app}`);
    throw new BadRequest(
      granted.length
        ? `several ${label} connections are open to you for ${product}: name one with "app" (${granted.join(", ")}; ${platform}_apps lists them)`
        : `you may not use ${label} ${product} (${mode})`,
    );
  }
  const [conn] = await db.select().from(connections).where(eq(connections.id, id)).limit(1);
  if (conn?.platform !== platform) throw new BadRequest(`the ${label} connection ${id} is no longer there`);
  if (conn.status === "paused") throw new BadRequest(`the ${label} connection ${conn.name} is paused`);
  return conn;
}

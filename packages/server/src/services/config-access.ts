/**
 * How a system administrator role reads and changes witden's configuration.
 *
 * It calls the same REST API as the console, in the API process, as the person who asked it (always a console
 * account): every check, validation and audit record applies as if that person had clicked it, and audit
 * records also name the role and task. Only the configuration endpoints listed here are open to it. Secrets
 * stay out of reach both ways: the API never returns them, request bodies naming a secret are refused (a
 * person enters keys in the console), and responses are scrubbed once more. Accounts (console users and the
 * platform accounts linked to them) are managed by people only.
 */
import { eq } from "drizzle-orm";
import { transaction } from "../db/client.js";
import { memories, roles, tasks, topics, users } from "../db/schema.js";
import { BadRequest, Forbidden } from "../errors.js";
import { externalContext } from "../integrations/links.js";
import { runtime } from "../runtime.js";
import { redactDeep } from "../security/crypto.js";
import { isConsoleUser } from "../security/permissions.js";
import { ACTING_HEADER, type Acting, actingTicket } from "./acting.js";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Endpoint {
  method: Method;
  path: string;
  /** What it is for and the fields it takes, shown to the role. */
  note?: string;
}

/** The configuration areas of the console and their endpoints, in the order the role reads them. */
const AREAS: { title: string; endpoints: Endpoint[] }[] = [
  {
    title: "Roles",
    endpoints: [
      { method: "GET", path: "/api/roles", note: "every role with its model, computer and configuration warnings" },
      { method: "GET", path: "/api/roles/:id" },
      { method: "GET", path: "/api/roles/tool-groups", note: "tool permission groups" },
      {
        method: "GET",
        path: "/api/roles/feishu-tools",
        note: "Feishu tools by product and the Feishu apps; a role gets them per app in allowed_tools as feishu:<connection>:<product>:read|write (a write group in approval_required asks first)",
      },
      {
        method: "GET",
        path: "/api/roles/github-tools",
        note: "GitHub tools by product and the GitHub connections; granted per connection like the Feishu tools (github:<connection>:<product>:read|write)",
      },
      {
        method: "POST",
        path: "/api/roles",
        note: 'name, handle, description, system_prompt, model_config_id, reasoning_effort (one of the levels in the model\'s capabilities.effort, or null for its default), model_params, instance_id, allowed_tools (groups), approval_required (groups or tools), allowed_contacts (role ids or "*"), knowledge_space_ids, max_steps, max_tokens_per_task, daily_token_limit, color',
      },
      { method: "PATCH", path: "/api/roles/:id", note: "any of the fields above" },
      { method: "POST", path: "/api/roles/:id/copy", note: "name, handle" },
      { method: "POST", path: "/api/roles/:id/disable", note: "on_tasks: pause | cancel | reassign, reassign_to" },
      { method: "POST", path: "/api/roles/:id/enable" },
    ],
  },
  {
    title: "Models",
    endpoints: [
      { method: "GET", path: "/api/model-providers", note: "model services and their models" },
      { method: "GET", path: "/api/models" },
      {
        method: "POST",
        path: "/api/model-providers",
        note: "name, protocol (openai | anthropic | systemone), base_url, models (names); a person enters the API key",
      },
      { method: "PATCH", path: "/api/model-providers/:id", note: "name, base_url" },
      { method: "POST", path: "/api/model-providers/:id/revoke-key" },
      { method: "DELETE", path: "/api/model-providers/:id" },
      { method: "GET", path: "/api/model-providers/:id/remote-models", note: "models the service itself lists" },
      { method: "POST", path: "/api/model-providers/:id/models", note: "models (names), source: api | manual" },
      { method: "PATCH", path: "/api/models/:id", note: "name, enabled, params, daily_token_limit" },
      { method: "DELETE", path: "/api/models/:id" },
      { method: "POST", path: "/api/models/:id/check", note: "check what the model can do" },
      { method: "GET", path: "/api/settings/dispatcher" },
      { method: "PUT", path: "/api/settings/dispatcher", note: "model_config_id (a System One model) or null" },
    ],
  },
  {
    title: "Computers",
    endpoints: [
      { method: "GET", path: "/api/templates" },
      { method: "GET", path: "/api/templates/:id" },
      {
        method: "POST",
        path: "/api/templates",
        note:
          "name, description, image, kind (shell | desktop), workdir, persistent_paths, software, default_resources. " +
          "What a computer has comes from its image (witden/computer-shell: git, Python with pip and venv, " +
          "Node.js with npm, build-essential, ripgrep, no desktop; witden/computer-desktop: the same plus a desktop " +
          "and Chromium) and from its software list. software: Debian package names (as for apt-get install) a new " +
          "computer of the template starts its own list with; the platform installs what is missing whenever the " +
          "computer starts. Do not list what the image already has",
      },
      { method: "PATCH", path: "/api/templates/:id" },
      { method: "POST", path: "/api/templates/:id/copy" },
      { method: "DELETE", path: "/api/templates/:id" },
      { method: "POST", path: "/api/templates/seed-builtin" },
      { method: "GET", path: "/api/instances", note: "computers" },
      { method: "GET", path: "/api/instances/:id" },
      { method: "POST", path: "/api/instances", note: "template_id, name, resources, color" },
      {
        method: "PATCH",
        path: "/api/instances/:id",
        note: "color, software (the computer's own software list: Debian package names installed whenever it starts)",
      },
      { method: "POST", path: "/api/instances/:id/software/install", note: "install the software list now" },
      { method: "PATCH", path: "/api/instances/:id/resources", note: "cpus, memory_mb, ..." },
      { method: "GET", path: "/api/instances/:id/preview/:action", note: "what reset or delete would remove" },
      {
        method: "POST",
        path: "/api/instances/:id/actions",
        note: "action: start | stop | restart | reset | delete (reset and delete need confirm: true)",
      },
      { method: "GET", path: "/api/instances/:id/stats" },
      { method: "GET", path: "/api/instances/:id/model-proxy" },
      { method: "PUT", path: "/api/instances/:id/model-proxy", note: "enabled, model_ids" },
      { method: "POST", path: "/api/instances/:id/model-proxy/rotate-key" },
      { method: "GET", path: "/api/instances/:id/backups" },
      { method: "POST", path: "/api/instances/:id/backups" },
      { method: "POST", path: "/api/instances/:id/restore" },
      { method: "POST", path: "/api/instances/:id/clone" },
    ],
  },
  {
    title: "Connections (Slack, Feishu, GitHub)",
    endpoints: [
      { method: "GET", path: "/api/connections" },
      { method: "GET", path: "/api/integrations/capabilities" },
      { method: "GET", path: "/api/connections/:id/conversations" },
      {
        method: "PATCH",
        path: "/api/connections/:id",
        note: "name, status (active | paused), settings: role_id (the role its bot stands for, the only one working in its conversations), auto_provision_users, auth_only (GitHub: authenticates the GitHub tools only, takes no messages), feishu_mode (Feishu: socket = long connection, http = events URL, which needs a verification token only a person can enter), bot_requests (Feishu: other bots @-mentioning the bot go to its role)",
      },
      { method: "POST", path: "/api/connections/:id/test", note: "test the saved credentials" },
      { method: "GET", path: "/api/connections/:id/feishu-scopes", note: "permissions Feishu has granted the app" },
      { method: "DELETE", path: "/api/connections/:id", note: "a Slack connection is one workspace; its app stays" },
      { method: "GET", path: "/api/slack-apps", note: "Slack apps and the workspaces each is installed in" },
      { method: "PATCH", path: "/api/slack-apps/:id", note: "name" },
      { method: "DELETE", path: "/api/slack-apps/:id", note: "only an app no workspace uses any more" },
      { method: "GET", path: "/api/settings/public-url" },
      { method: "POST", path: "/api/settings/public-url/check", note: "url" },
      { method: "PUT", path: "/api/settings/public-url", note: "url" },
      { method: "GET", path: "/api/settings/tunnel", note: "Cloudflare Tunnel status" },
    ],
  },
  {
    title: "Knowledge and role memory",
    endpoints: [
      { method: "GET", path: "/api/knowledge-spaces" },
      { method: "POST", path: "/api/knowledge-spaces", note: "name, description" },
      {
        method: "GET",
        path: "/api/memories",
        note: "?scope=team&space_id= (team knowledge) or ?scope=role&role_id= (a role's memory, shown to it wherever it works)",
      },
      {
        method: "POST",
        path: "/api/memories",
        note: "scope team + space_id, or scope role + role_id; title, keywords (list), content",
      },
      { method: "PATCH", path: "/api/memories/:id", note: "title, keywords, content (only those to change)" },
      { method: "DELETE", path: "/api/memories/:id", note: "team knowledge or role memory" },
    ],
  },
  {
    title: "Operations (read only)",
    endpoints: [
      { method: "GET", path: "/api/kill-switches", note: "emergency stops" },
      { method: "GET", path: "/api/usage" },
      { method: "GET", path: "/api/audit", note: "who changed what" },
    ],
  },
];

const ENDPOINTS = AREAS.flatMap((a) => a.endpoints).map((e) => ({
  ...e,
  pattern: new RegExp(`^${e.path.replace(/:[a-z_]+/g, "[^/]+")}$`),
}));

/** Team knowledge and role memory are configuration; topic notes are conversation material. */
const MEMORY_SCOPES = new Set(["team", "role"]);

/** Fields that carry a secret. A person enters these in the console; they never pass through a role. */
const SECRET_KEYS = new Set([
  "token_hash",
  "password",
  "api_key",
  "apikey",
  "credentials",
  "token",
  "bot_token",
  "app_token",
  "signing_secret",
  "webhook_secret",
  "verification_token",
  "app_secret",
  "client_secret",
  "private_key",
  "secret",
  "key",
]);

const secretKeyIn = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = secretKeyIn(v);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k.toLowerCase())) return k;
      const found = secretKeyIn(v);
      if (found) return found;
    }
  }
  return null;
};

/** Drop any field that is named like a secret (the API returns none; this is a second line). */
const scrub = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !SECRET_KEYS.has(k.toLowerCase()))
        .map(([k, v]) => [k, scrub(v)]),
    );
  }
  return value;
};

/** The endpoint catalogue for the role's tool descriptions. */
export function configCatalog(methods: "read" | "change"): string {
  const parts: string[] = [];
  for (const area of AREAS) {
    const lines = area.endpoints
      .filter((e) => (methods === "read" ? e.method === "GET" : e.method !== "GET"))
      .map((e) => `- ${methods === "read" ? "" : `${e.method} `}${e.path}${e.note ? ` — ${e.note}` : ""}`);
    if (lines.length) parts.push(`${area.title}:\n${lines.join("\n")}`);
  }
  return parts.join("\n");
}

export interface ConfigRequest {
  taskId: string;
  toolCallId: string;
  method: string;
  path: string;
  body?: unknown;
}

export interface ConfigResponse {
  status: number;
  body: unknown;
}

/** The task may still act: running, owned by an active system administrator, asked by a console account, in the console. */
async function actingFor(taskId: string): Promise<Acting> {
  return transaction(async (db) => {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (task?.status !== "running") throw new Forbidden("the task is not running");
    const [role] = await db.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
    if (!role?.systemAdmin || role.status !== "active")
      throw new Forbidden("only an active system administrator role may change the configuration");
    const [user] = task.requesterUserId
      ? await db.select().from(users).where(eq(users.id, task.requesterUserId)).limit(1)
      : [];
    if (!isConsoleUser(user)) throw new Forbidden("only a console account may have the configuration changed");
    const [topic] = await db.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
    if (!topic || (await externalContext(db, topic.id)).conversationKind)
      throw new Forbidden("a system administrator works only in the console");
    return { userId: user!.id, roleId: role.id, taskId: task.id };
  });
}

/** Refuse what a system administrator role may not do even though the person it acts for could. */
async function guard(method: Method, pathname: string, query: URLSearchParams, body: unknown): Promise<void> {
  const secret = secretKeyIn(body);
  if (secret)
    throw new Forbidden(
      `"${secret}" is a secret field. A person enters secrets in the console; they never pass through a role`,
    );
  if (body && typeof body === "object" && "system_admin" in body)
    throw new Forbidden("only a person in the console can make a role a system administrator or change that");
  const roleId = pathname.match(/^\/api\/roles\/([^/]+)/)?.[1];
  if (roleId && roleId !== "tool-groups" && method !== "GET") {
    // Its own settings (and other administrators') are its guardrails: only people change them.
    const [role] = await transaction((db) => db.select().from(roles).where(eq(roles.id, roleId)).limit(1));
    if (role?.systemAdmin) throw new Forbidden("system administrator roles are configured by people only");
  }
  const memoryId = pathname.match(/^\/api\/memories\/([^/]+)$/)?.[1];
  if (pathname === "/api/memories" || memoryId) {
    let scope: unknown;
    let memoryRoleId: unknown;
    if (memoryId) {
      const [m] = await transaction((db) => db.select().from(memories).where(eq(memories.id, memoryId)).limit(1));
      if (!m) return; // the API answers that it does not exist
      scope = m.scope;
      memoryRoleId = m.roleId;
    } else if (method === "GET") {
      scope = query.get("scope");
      memoryRoleId = query.get("role_id");
    } else {
      const b = body as Record<string, unknown> | null;
      scope = b?.scope;
      memoryRoleId = b?.role_id ?? b?.roleId;
    }
    if (!MEMORY_SCOPES.has(String(scope)))
      throw new Forbidden(
        "only team knowledge (scope team) and role memory (scope role) are configuration; topic notes are not",
      );
    if (scope === "role" && method !== "GET" && memoryRoleId) {
      const [role] = await transaction((db) =>
        db
          .select()
          .from(roles)
          .where(eq(roles.id, String(memoryRoleId)))
          .limit(1),
      );
      if (role?.systemAdmin) throw new Forbidden("system administrator roles are configured by people only");
    }
  }
}

/**
 * Run one configuration call for a system administrator's task, in this (the API) process. Returns the API's
 * status and body; refusals are thrown.
 */
export async function configRequest(req: ConfigRequest): Promise<ConfigResponse> {
  const app = runtime().app;
  if (!app) throw new BadRequest("no API in this process");
  const method = String(req.method ?? "GET").toUpperCase() as Method;
  const url = new URL(String(req.path ?? ""), "http://witden.internal");
  if (url.origin !== "http://witden.internal" || !url.pathname.startsWith("/api/"))
    throw new BadRequest("path must be an /api/... path of this witden");
  const endpoint = ENDPOINTS.find((e) => e.method === method && e.pattern.test(url.pathname));
  if (!endpoint) throw new Forbidden(`${method} ${url.pathname} is not a configuration endpoint open to roles`);
  const body = method === "GET" || method === "DELETE" ? undefined : (req.body ?? {});
  await guard(method, url.pathname, url.searchParams, body);
  const who = await actingFor(req.taskId);
  const { ticket, done } = actingTicket(who);
  const res = await app
    .inject({
      method,
      url: url.pathname + url.search,
      headers: { [ACTING_HEADER]: ticket },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    })
    .finally(done);
  let parsed: unknown = res.body;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    // not JSON: keep the text
  }
  return { status: res.statusCode, body: redactDeep(scrub(parsed)) };
}

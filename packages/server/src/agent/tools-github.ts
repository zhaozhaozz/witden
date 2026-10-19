/**
 * The GitHub tools roles call (permissions: integrations/platform-tools.ts; client, labels, audiences:
 * integrations/github-tools.ts). Each belongs to ``github:<product>:<mode>``; ``app`` picks the connection (an
 * account token or an App) when several are open. Writes name their destination so the information-flow check
 * runs before them (runner.ts).
 */
import { eq } from "drizzle-orm";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import { type Connection, connections, tasks } from "../db/schema.js";
import { BadRequest } from "../errors.js";
import { GithubAdapter } from "../integrations/github.js";
import {
  explainGithubError,
  GITHUB_PRODUCTS,
  githubClient,
  githubLabel,
  repoAudience,
  repoLabels,
  repoName,
} from "../integrations/github-tools.js";
import { connectionFor, grantedApps, parseGrant, type ToolMode } from "../integrations/platform-tools.js";
import type { ToolContext, ToolResult, ToolSpec } from "./tools.js";

const str = { type: "string" };
const int = { type: "integer" };
const strs = { type: "array", items: str };
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: "object", properties, required });
const appArg = {
  type: "string",
  description: "GitHub connection id to use; needed only when several are open to you (see github_apps)",
};
const repoArg = { type: "string", description: "owner/repo" };

function clip(text: string, limit = settings().toolOutputLimit): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

async function envelopeTools(db: Db, taskId: string): Promise<string[]> {
  const [task] = await db.select({ envelope: tasks.envelope }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return (task?.envelope as { tools?: string[] } | undefined)?.tools ?? [];
}

const connOf = async (ctx: ToolContext, product: string, mode: ToolMode, app: unknown) => {
  const db = ctx.db();
  return connectionFor(db, await envelopeTools(db, ctx.taskId), "github", product, mode, app);
};

async function call(conn: Connection, repo: string, method: string, path: string, body?: unknown) {
  return (await (await githubClient(conn, repo)).request(method, path, body)).data;
}

/**
 * A GitHub tool on one repository: the connection is checked against the task's grants, GitHub's refusals are
 * explained, what is read from a private repository is labelled, and a write names its audience.
 */
function githubTool(
  name: string,
  product: string,
  mode: ToolMode,
  description: string,
  properties: Record<string, any>,
  required: string[],
  run: (conn: Connection, repo: string, args: Record<string, any>) => Promise<unknown>,
): ToolSpec {
  return {
    name,
    group: `github:${product}:${mode}`,
    description,
    parameters: obj({ repo: repoArg, ...properties, app: appArg }, ["repo", ...required]),
    ...(mode === "write"
      ? {
          destination: async (ctx: ToolContext, args: Record<string, any>) =>
            repoAudience(await connOf(ctx, product, mode, args.app), repoName(args.repo)),
        }
      : {}),
    handler: async (ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> => {
      const conn = await connOf(ctx, product, mode, args.app);
      let repo: string;
      try {
        repo = repoName(args.repo);
      } catch (err) {
        throw new BadRequest((err as Error).message);
      }
      try {
        const out = await run(conn, repo, args);
        return {
          content: clip(typeof out === "string" ? out : JSON.stringify(out, null, 1)),
          labels: await repoLabels(conn, repo),
        };
      } catch (err) {
        if (err instanceof BadRequest) throw err;
        // A failure says nothing of the repository's content, but its name may be private: label it all the same.
        const labels = await repoLabels(conn, repo).catch(() => [githubLabel(conn.id)]);
        return { content: `error: ${explainGithubError(err as Error)}`, labels };
      }
    },
  };
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const issueOut = (i: any) => ({
  number: i.number,
  title: i.title,
  state: i.state,
  user: i.user?.login,
  labels: (i.labels ?? []).map((l: any) => l.name ?? l),
  assignees: (i.assignees ?? []).map((a: any) => a.login),
  updated_at: i.updated_at,
  url: i.html_url,
});

const appsTool: ToolSpec = {
  name: "github_apps",
  group: "github:apps",
  description:
    "List the GitHub connections (accounts or Apps) whose tools you may use, as whom they act, and what you may do with each.",
  parameters: obj({}),
  handler: async (ctx) => {
    const db = ctx.db();
    const tools = await envelopeTools(db, ctx.taskId);
    const ids = [
      ...new Set(
        tools
          .map(parseGrant)
          .filter((g) => g?.platform === "github")
          .map((g) => g!.connectionId),
      ),
    ];
    const lines: string[] = [];
    for (const id of ids) {
      const [conn] = await db.select().from(connections).where(eq(connections.id, id)).limit(1);
      if (conn?.platform !== "github") continue;
      const can = GITHUB_PRODUCTS.flatMap((p) =>
        (["read", "write"] as ToolMode[])
          .filter((m) => grantedApps(tools, "github", p.key, m).includes(id))
          .map((m) => `${p.key} ${m}`),
      );
      lines.push(
        `- ${conn.name} (app: ${id}; acts as ${conn.botUserId ?? "?"}${conn.status === "paused" ? "; paused" : ""}): ${can.join(", ")}`,
      );
    }
    return { content: lines.join("\n") || "no GitHub connection is open to you" };
  },
};

export const GITHUB_TOOLS: ToolSpec[] = [
  appsTool,
  // --- code and files
  {
    name: "github_repos",
    group: "github:repo:read",
    description: "List the repositories this GitHub connection can reach.",
    parameters: obj({ app: appArg }),
    handler: async (ctx, args) => {
      const conn = await connOf(ctx, "repo", "read", args.app);
      try {
        const repos = await new GithubAdapter().repositories(conn);
        return {
          content: clip(JSON.stringify(repos, null, 1)),
          labels: repos.some((r) => r.private) ? [githubLabel(conn.id)] : [],
        };
      } catch (err) {
        return { content: `error: ${explainGithubError(err as Error)}`, labels: [githubLabel(conn.id)] };
      }
    },
  },
  githubTool(
    "github_read_path",
    "repo",
    "read",
    "Read a file of a repository, or list a directory (path empty for the top), at a branch, tag or commit.",
    { path: str, ref: str },
    [],
    async (conn, repo, a) => {
      const path = String(a.path ?? "").replace(/^\/+/, "");
      const data = await call(
        conn,
        repo,
        "GET",
        `/repos/${repo}/contents/${encodeURI(path)}${a.ref ? `?ref=${encodeURIComponent(String(a.ref))}` : ""}`,
      );
      if (Array.isArray(data))
        return data.map((e: any) => ({ name: e.name, type: e.type, path: e.path, size: e.size }));
      if (data?.encoding === "base64") return Buffer.from(String(data.content), "base64").toString("utf8");
      return { type: data?.type, path: data?.path, size: data?.size, note: "not a text file GitHub returns inline" };
    },
  ),
  githubTool(
    "github_write_file",
    "repo",
    "write",
    "Create or replace a file on a branch (a commit with the message given).",
    { path: str, content: str, message: str, branch: str },
    ["path", "content", "message"],
    async (conn, repo, a) => {
      const path = String(a.path).replace(/^\/+/, "");
      const ref = a.branch ? `?ref=${encodeURIComponent(String(a.branch))}` : "";
      const existing = await call(conn, repo, "GET", `/repos/${repo}/contents/${encodeURI(path)}${ref}`).catch(
        () => null,
      );
      const data = await call(conn, repo, "PUT", `/repos/${repo}/contents/${encodeURI(path)}`, {
        message: String(a.message),
        content: b64(String(a.content)),
        ...(a.branch ? { branch: String(a.branch) } : {}),
        ...(existing?.sha ? { sha: existing.sha } : {}),
      });
      return { commit: data?.commit?.sha, url: data?.content?.html_url };
    },
  ),
  githubTool(
    "github_create_branch",
    "repo",
    "write",
    "Create a branch from another (default: the repository's default branch).",
    { branch: str, from: str },
    ["branch"],
    async (conn, repo, a) => {
      const from = a.from ? String(a.from) : (await call(conn, repo, "GET", `/repos/${repo}`)).default_branch;
      const base = await call(conn, repo, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(from)}`);
      await call(conn, repo, "POST", `/repos/${repo}/git/refs`, {
        ref: `refs/heads/${String(a.branch)}`,
        sha: base.object.sha,
      });
      return { branch: String(a.branch), from, sha: base.object.sha };
    },
  ),
  // --- issues
  githubTool(
    "github_issue_list",
    "issues",
    "read",
    "List issues of a repository (pull requests left out), newest activity first.",
    {
      state: { type: "string", enum: ["open", "closed", "all"] },
      labels: { type: "string", description: "comma-separated" },
      limit: int,
    },
    [],
    async (conn, repo, a) => {
      const q = new URLSearchParams({
        state: String(a.state ?? "open"),
        per_page: String(Math.min(Math.max(Number(a.limit ?? 30), 1), 100)),
        sort: "updated",
        ...(a.labels ? { labels: String(a.labels) } : {}),
      });
      const data = await call(conn, repo, "GET", `/repos/${repo}/issues?${q}`);
      return (data ?? []).filter((i: any) => !i.pull_request).map(issueOut);
    },
  ),
  githubTool(
    "github_issue_get",
    "issues",
    "read",
    "Read an issue (or pull request) with its comments.",
    { number: int },
    ["number"],
    async (conn, repo, a) => {
      const issue = await call(conn, repo, "GET", `/repos/${repo}/issues/${Number(a.number)}`);
      const comments = await call(conn, repo, "GET", `/repos/${repo}/issues/${Number(a.number)}/comments?per_page=50`);
      return {
        ...issueOut(issue),
        body: issue.body,
        comments: (comments ?? []).map((c: any) => ({ user: c.user?.login, body: c.body, at: c.created_at })),
      };
    },
  ),
  githubTool(
    "github_issue_create",
    "issues",
    "write",
    "Open an issue.",
    { title: str, body: str, labels: strs, assignees: strs },
    ["title"],
    async (conn, repo, a) => {
      const data = await call(conn, repo, "POST", `/repos/${repo}/issues`, {
        title: String(a.title),
        ...(a.body ? { body: String(a.body) } : {}),
        ...(Array.isArray(a.labels) ? { labels: a.labels.map(String) } : {}),
        ...(Array.isArray(a.assignees) ? { assignees: a.assignees.map(String) } : {}),
      });
      return { number: data?.number, url: data?.html_url };
    },
  ),
  githubTool(
    "github_issue_comment",
    "issues",
    "write",
    "Comment on an issue.",
    { number: int, body: str },
    ["number", "body"],
    async (conn, repo, a) => {
      const data = await call(conn, repo, "POST", `/repos/${repo}/issues/${Number(a.number)}/comments`, {
        body: String(a.body),
      });
      return { comment: data?.id, url: data?.html_url };
    },
  ),
  githubTool(
    "github_issue_update",
    "issues",
    "write",
    "Change an issue: state (open / closed), title, body, labels or assignees.",
    {
      number: int,
      state: { type: "string", enum: ["open", "closed"] },
      title: str,
      body: str,
      labels: strs,
      assignees: strs,
    },
    ["number"],
    async (conn, repo, a) => {
      const change: Record<string, unknown> = {};
      for (const k of ["state", "title", "body"]) if (a[k] !== undefined) change[k] = String(a[k]);
      for (const k of ["labels", "assignees"]) if (Array.isArray(a[k])) change[k] = a[k].map(String);
      const data = await call(conn, repo, "PATCH", `/repos/${repo}/issues/${Number(a.number)}`, change);
      return issueOut(data);
    },
  ),
  // --- pull requests
  githubTool(
    "github_pr_list",
    "pulls",
    "read",
    "List pull requests of a repository.",
    { state: { type: "string", enum: ["open", "closed", "all"] }, limit: int },
    [],
    async (conn, repo, a) => {
      const q = new URLSearchParams({
        state: String(a.state ?? "open"),
        per_page: String(Math.min(Math.max(Number(a.limit ?? 30), 1), 100)),
      });
      const data = await call(conn, repo, "GET", `/repos/${repo}/pulls?${q}`);
      return (data ?? []).map((p: any) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        draft: p.draft,
        user: p.user?.login,
        head: p.head?.ref,
        base: p.base?.ref,
        url: p.html_url,
      }));
    },
  ),
  githubTool(
    "github_pr_get",
    "pulls",
    "read",
    "Read a pull request: description, state and the files it changes (with their diffs, shortened).",
    { number: int },
    ["number"],
    async (conn, repo, a) => {
      const pr = await call(conn, repo, "GET", `/repos/${repo}/pulls/${Number(a.number)}`);
      const files = await call(conn, repo, "GET", `/repos/${repo}/pulls/${Number(a.number)}/files?per_page=100`);
      return {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        merged: pr.merged,
        mergeable: pr.mergeable,
        head: pr.head?.ref,
        base: pr.base?.ref,
        body: pr.body,
        files: (files ?? []).map((f: any) => ({
          file: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ? clip(String(f.patch), 2000) : undefined,
        })),
      };
    },
  ),
  githubTool(
    "github_pr_create",
    "pulls",
    "write",
    "Open a pull request from a branch (into the default branch unless base is given).",
    { title: str, head: str, base: str, body: str, draft: { type: "boolean" } },
    ["title", "head"],
    async (conn, repo, a) => {
      const base = a.base ? String(a.base) : (await call(conn, repo, "GET", `/repos/${repo}`)).default_branch;
      const data = await call(conn, repo, "POST", `/repos/${repo}/pulls`, {
        title: String(a.title),
        head: String(a.head),
        base,
        ...(a.body ? { body: String(a.body) } : {}),
        ...(a.draft ? { draft: true } : {}),
      });
      return { number: data?.number, url: data?.html_url };
    },
  ),
  githubTool(
    "github_pr_comment",
    "pulls",
    "write",
    "Comment on a pull request.",
    { number: int, body: str },
    ["number", "body"],
    async (conn, repo, a) => {
      const data = await call(conn, repo, "POST", `/repos/${repo}/issues/${Number(a.number)}/comments`, {
        body: String(a.body),
      });
      return { comment: data?.id, url: data?.html_url };
    },
  ),
  githubTool(
    "github_pr_merge",
    "pulls",
    "write",
    "Merge a pull request (merge, squash or rebase).",
    { number: int, method: { type: "string", enum: ["merge", "squash", "rebase"] } },
    ["number"],
    async (conn, repo, a) => {
      const data = await call(conn, repo, "PUT", `/repos/${repo}/pulls/${Number(a.number)}/merge`, {
        merge_method: String(a.method ?? "merge"),
      });
      return { merged: data?.merged, sha: data?.sha, message: data?.message };
    },
  ),
  // --- actions
  githubTool(
    "github_actions_runs",
    "actions",
    "read",
    "List recent workflow runs of a repository, optionally of one branch or status.",
    { branch: str, status: str, limit: int },
    [],
    async (conn, repo, a) => {
      const q = new URLSearchParams({
        per_page: String(Math.min(Math.max(Number(a.limit ?? 20), 1), 100)),
        ...(a.branch ? { branch: String(a.branch) } : {}),
        ...(a.status ? { status: String(a.status) } : {}),
      });
      const data = await call(conn, repo, "GET", `/repos/${repo}/actions/runs?${q}`);
      return (data?.workflow_runs ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        branch: r.head_branch,
        event: r.event,
        url: r.html_url,
        created_at: r.created_at,
      }));
    },
  ),
  githubTool(
    "github_actions_rerun",
    "actions",
    "write",
    "Run a workflow run again.",
    { run_id: int },
    ["run_id"],
    async (conn, repo, a) => {
      await call(conn, repo, "POST", `/repos/${repo}/actions/runs/${Number(a.run_id)}/rerun`);
      return { rerun: Number(a.run_id) };
    },
  ),
  githubTool(
    "github_workflow_dispatch",
    "actions",
    "write",
    "Start a workflow that can be run by hand (workflow_dispatch), on a branch or tag, with its inputs.",
    {
      workflow: { type: "string", description: "file name (e.g. deploy.yml) or id" },
      ref: str,
      inputs: { type: "object" },
    },
    ["workflow", "ref"],
    async (conn, repo, a) => {
      await call(
        conn,
        repo,
        "POST",
        `/repos/${repo}/actions/workflows/${encodeURIComponent(String(a.workflow))}/dispatches`,
        {
          ref: String(a.ref),
          ...(a.inputs ? { inputs: a.inputs } : {}),
        },
      );
      return { dispatched: String(a.workflow), ref: String(a.ref) };
    },
  ),
];

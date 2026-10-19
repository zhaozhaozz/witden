/**
 * GitHub tools: what roles can do on GitHub through a connection's account token or App, without the credentials
 * (permissions per connection and product: platform-tools.ts; the tools: agent/tools-github.ts). A connection may
 * be set to authenticate only (``auth_only``): it takes no messages and serves just these tools, e.g. a person's own
 * account doing what they would otherwise do by hand.
 *
 * What a tool reads from a public repository is public; from a private one it is labelled as that connection's
 * (``github:<connection>``). Writing to a repository sends task material to its readers — everyone for a public
 * one — so the information-flow check runs before a write (runner.ts, ``destination``).
 */
import type { Connection } from "../db/schema.js";
import { PUBLIC, type Readers, readers } from "../security/labels.js";
import { GithubAdapter, type GithubClient } from "./github.js";

export interface GithubProduct {
  key: string;
  label: string;
  /** What a role can do with it, for the role editor. */
  description: string;
}

/** The products roles can be given (the GitHub tools), in the order the console shows them. */
export const GITHUB_PRODUCTS: GithubProduct[] = [
  {
    key: "repo",
    label: "代码与文件",
    description: "列出能访问的仓库，读取文件和目录；在分支上提交文件、新建分支",
  },
  { key: "issues", label: "Issue", description: "查看 issue 和评论；新建 issue、评论、修改状态和标签" },
  {
    key: "pulls",
    label: "Pull request",
    description: "查看 pull request 及改动的文件；新建 pull request、评论、合并",
  },
  { key: "actions", label: "Actions", description: "查看工作流运行情况；重新运行、手动触发工作流" },
];

export const githubLabel = (connectionId: string) => `github:${connectionId}`;

/** owner/repo, as GitHub writes it. */
export function repoName(value: unknown): string {
  const s = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .split("/")
    .slice(0, 2)
    .join("/");
  if (!/^[\w.-]+\/[\w.-]+$/.test(s)) throw new Error("a repository is written owner/repo");
  return s;
}

export const githubClient = (conn: Connection, repo: string): Promise<GithubClient> =>
  new GithubAdapter().client(conn, repo);

const visibility = new Map<string, { private: boolean; at: number }>();

/** Whether a repository is private (asked of GitHub, kept ten minutes). */
export async function isPrivate(conn: Connection, repo: string): Promise<boolean> {
  const key = `${conn.id}:${repo}`;
  const hit = visibility.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.private;
  const { data } = await (await githubClient(conn, repo)).request("GET", `/repos/${repo}`);
  visibility.set(key, { private: !!data?.private, at: Date.now() });
  return !!data?.private;
}

/** Labels for what was read from a repository: none when public. */
export async function repoLabels(conn: Connection, repo: string): Promise<string[]> {
  return (await isPrivate(conn, repo)) ? [githubLabel(conn.id)] : [];
}

/** Who sees what is written to a repository: everyone, or (private) the people of that connection. */
export async function repoAudience(conn: Connection, repo: string): Promise<Readers> {
  return (await isPrivate(conn, repo)) ? readers([`ws:${conn.id}`]) : readers([PUBLIC]);
}

/** GitHub's answers to a call that went wrong, said so a role can tell the person what to do. */
export function explainGithubError(err: Error): string {
  const m = err.message;
  if (/HTTP 401/.test(m)) return `${m}\n(凭据无效或已过期：请在接入的“编辑”中换上新的 Token。)`;
  if (/HTTP 403/.test(m))
    return `${m}\n(没有权限：Token 缺少所需的权限，fine-grained token 没有选中这个仓库，或组织还没有批准这个 Token；GitHub App 需要相应权限并安装到这个仓库。)`;
  if (/HTTP 404/.test(m)) return `${m}\n(找不到：仓库、文件或编号不存在，或这个账号看不到这个私有仓库。)`;
  if (/HTTP 422/.test(m)) return `${m}\n(GitHub 不接受这次请求的内容，见上面的说明。)`;
  return m;
}

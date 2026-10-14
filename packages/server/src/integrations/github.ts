/**
 * GitHub adapter: webhooks in, REST API out. It acts either as a **GitHub App** (app id + private key: a JWT
 * buys a short-lived token per installation, and replies come from ``<app>[bot]``) or as a **bot account**
 * (a user or machine account whose token the connection holds).
 *
 * A repository is a conversation (public or private) and an issue or pull request is a thread: one topic per
 * issue / PR. Comments that @-mention the bot account ask the roles for work; replies are posted as comments.
 * Public repositories are readable by anyone, so material from inside witden needs approval before it is
 * posted there (security/labels.ts).
 */
import { createHmac, createPrivateKey, createSign } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  artifacts,
  type Connection,
  type ExternalConversation,
  externalConversations,
  externalIdentities,
  type Message,
  type OutboundMessage,
  roles,
  users,
} from "../db/schema.js";
import { BadRequest, Unauthorized } from "../errors.js";
import { safeEqual } from "../security/crypto.js";
import { publicBase } from "../services/public-url.js";
import { type Adapter, type InboundAction, register } from "./base.js";
import type { InboundMessage } from "./inbound.js";
import { credentials } from "./slack.js";

const API = "https://api.github.com";
const MEMBERS_TTL_MS = 10 * 60_000;

/** Tests replace this to intercept HTTP. */
export let githubFetch: typeof fetch = (...args) => fetch(...args);
export function setGithubFetch(fn: typeof fetch): void {
  githubFetch = fn;
}

/** Webhook signature: ``X-Hub-Signature-256: sha256=<HMAC-SHA256 of the raw body with the webhook secret>``. */
export function verifySignature(secret: string, body: Buffer, signature: string): void {
  if (!secret) throw new Unauthorized("connection has no webhook secret");
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  if (!safeEqual(expected, signature ?? "")) throw new Unauthorized("bad GitHub signature");
}

export class GithubClient {
  constructor(private readonly token: string) {}

  async request(method: string, path: string, body?: unknown): Promise<{ data: any; next: string | null }> {
    const res = await githubFetch(path.startsWith("http") ? path : API + path, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "witden",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    return { data: text ? JSON.parse(text) : null, next };
  }
}

/** A GitHub App's JWT: RS256, valid ten minutes, issued a minute early to absorb clock drift. */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(now / 1000) - 60;
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat, exp: iat + 600, iss: appId })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(createPrivateKey(privateKey));
  return `${unsigned}.${sig.toString("base64url")}`;
}

/** Credentials for one of the two ways in: ``app_id`` + ``private_key``, or ``token``; always ``webhook_secret``. */
export function checkCredentials(creds: Record<string, string>): void {
  if (!creds.webhook_secret) throw new BadRequest("missing credentials: webhook_secret");
  if (creds.app_id || creds.private_key) {
    if (!/^\d+$/.test(creds.app_id ?? "")) throw new BadRequest("app_id must be the GitHub App's numeric id");
    try {
      createPrivateKey(creds.private_key ?? "");
    } catch {
      throw new BadRequest("private_key must be the GitHub App's private key (PEM)");
    }
  } else if (!creds.token) throw new BadRequest("missing credentials: app_id and private_key, or token");
}

/** Installation tokens, per connection and installation, renewed five minutes before they expire. */
const installationTokens = new Map<string, { token: string; expiresAt: number }>();
/** Which installation covers a repository: learned from webhooks, otherwise looked up. */
const repoInstallations = new Map<string, number>();

/** "owner/repo" and an issue / PR number from a stored conversation id and thread key. */
function issuePath(repo: string, thread: string | null): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(thread ?? ""))
    throw new BadRequest("not a GitHub issue thread");
  return `/repos/${repo}/issues/${thread}`;
}

export class GithubAdapter implements Adapter {
  platform = "github";

  static isApp = (conn: Connection) => !!credentials(conn).app_id;

  /** The app itself (for /app endpoints). */
  private appClient(conn: Connection): GithubClient {
    const creds = credentials(conn);
    return new GithubClient(appJwt(creds.app_id, creds.private_key));
  }

  /** A client for work on ``repo``: the bot account's token, or the app's token for the installation covering it. */
  async client(conn: Connection, repo: string): Promise<GithubClient> {
    const creds = credentials(conn);
    if (!creds.app_id) {
      if (!creds.token) throw new BadRequest("GitHub connection has no token");
      return new GithubClient(creds.token);
    }
    const repoKey = `${conn.id}:${repo}`;
    let installation = repoInstallations.get(repoKey);
    if (!installation) {
      const { data } = await this.appClient(conn).request("GET", `/repos/${repo}/installation`);
      installation = Number(data.id);
      repoInstallations.set(repoKey, installation);
    }
    const tokenKey = `${conn.id}:${installation}`;
    const cached = installationTokens.get(tokenKey);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return new GithubClient(cached.token);
    try {
      const { data } = await this.appClient(conn).request("POST", `/app/installations/${installation}/access_tokens`);
      const expiresAt = Date.parse(data.expires_at) || Date.now() + 60 * 60_000;
      installationTokens.set(tokenKey, { token: data.token, expiresAt });
      return new GithubClient(data.token);
    } catch (err) {
      repoInstallations.delete(repoKey); // uninstalled or moved: look it up again next time
      throw err;
    }
  }

  /**
   * Who the bot is: an app is addressed as @<app-slug> and comments as <app-slug>[bot]; a bot account by its
   * login. Its own comments are recognised and never answered.
   */
  async test(_db: Db, conn: Connection) {
    if (GithubAdapter.isApp(conn)) {
      const app = (await this.appClient(conn).request("GET", "/app")).data;
      const installations = (await this.appClient(conn).request("GET", "/app/installations?per_page=100")).data;
      conn.botUserId = String(app.slug);
      conn.externalWorkspaceId = String(app.id);
      return { app: app.slug, name: app.name, installations: (installations ?? []).length };
    }
    const { data } = await (await this.client(conn, "")).request("GET", "/user");
    conn.botUserId = String(data.login);
    conn.externalWorkspaceId = String(data.id);
    return { login: data.login, id: data.id, type: data.type };
  }

  private async render(db: Db, conn: Connection, msg: Message): Promise<string> {
    const base = await publicBase(db);
    // GitHub renders Markdown itself; system notices are set in italics.
    let text =
      msg.authorType === "system"
        ? msg.content
            .split("\n")
            .map((l) => (l.trim() ? `_${l.trim()}_` : l))
            .join("\n")
        : msg.content;
    for (const m of msg.mentions ?? []) {
      if (m.type !== "user") continue;
      const [ident] = await db
        .select()
        .from(externalIdentities)
        .where(and(eq(externalIdentities.connectionId, conn.id), eq(externalIdentities.userId, m.id)))
        .limit(1);
      const [user] = await db.select().from(users).where(eq(users.id, m.id)).limit(1);
      if (ident?.displayName && user) text = text.split(`@${user.name}`).join(`@${ident.displayName}`);
    }
    if (msg.attachments?.length) {
      const files = await db.select().from(artifacts).where(inArray(artifacts.id, msg.attachments));
      const byId = new Map(files.map((f) => [f.id, f]));
      const links = msg.attachments.map((a) => `📎 [${byId.get(a)?.name ?? "文件"}](${base}/api/files/${a})`);
      text += `${text ? "\n\n" : ""}${links.join("\n")}`;
    }
    // One account fronts every role: say who is speaking. No "@handle" here: on GitHub that pings a person.
    if (msg.authorType === "role") {
      const [role] = msg.authorId ? await db.select().from(roles).where(eq(roles.id, msg.authorId)).limit(1) : [];
      text = `**${role?.name ?? "role"}** (\`${role?.handle ?? "role"}\`)\n\n${text}`;
    } else if (msg.authorType === "user") {
      const [user] = msg.authorId ? await db.select().from(users).where(eq(users.id, msg.authorId)).limit(1) : [];
      text = `**${user?.name ?? "member"}** (witden)\n\n${text}`;
    }
    return text;
  }

  async send(db: Db, conn: Connection, out: OutboundMessage, msg: Message): Promise<string | null> {
    const body = await this.render(db, conn, msg);
    const { data } = await (await this.client(conn, out.conversationExternalId)).request(
      "POST",
      `${issuePath(out.conversationExternalId, out.threadKey)}/comments`,
      { body },
    );
    return String(data.id);
  }

  /** Publishing a topic into a repository opens an issue; its number is the thread. */
  async postRoot(conn: Connection, repo: string, text: string): Promise<string> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new BadRequest("a GitHub repository is written owner/repo");
    const [title, ...rest] = text.split("\n");
    const { data } = await (await this.client(conn, repo)).request("POST", `/repos/${repo}/issues`, {
      title: title.replace(/^Topic:\s*/, "").slice(0, 250) || "witden",
      body: rest.join("\n"),
    });
    return String(data.number);
  }

  async reply(conn: Connection, repo: string, thread: string, text: string): Promise<void> {
    await (await this.client(conn, repo)).request("POST", `${issuePath(repo, thread)}/comments`, {
      body: `_${text}_`,
    });
  }

  async conversationKind(db: Db, conn: Connection, repo: string, hint: string | null): Promise<[string, string]> {
    if (hint) return [hint, repo];
    const [conv] = await db
      .select()
      .from(externalConversations)
      .where(and(eq(externalConversations.connectionId, conn.id), eq(externalConversations.externalId, repo)))
      .limit(1);
    if (conv) return [conv.kind, repo];
    const { data } = await (await this.client(conn, repo)).request("GET", `/repos/${repo}`);
    return [data.private ? "private" : "public", repo];
  }

  /** Private repositories: their collaborators are who can read what is posted there. */
  async syncMembers(db: Db, conn: Connection, conv: ExternalConversation, force = false): Promise<void> {
    if (conv.kind === "public") return;
    if (!force && conv.membersSyncedAt && Date.now() - conv.membersSyncedAt.getTime() < MEMBERS_TTL_MS) return;
    const members: string[] = [];
    let next: string | null = `/repos/${conv.externalId}/collaborators?per_page=100`;
    // Listing collaborators needs push access; without it the list stays unknown and checks fail closed.
    for (let page = 0; next && page < 20; page++) {
      const r: { data: any; next: string | null } = await (await this.client(conn, conv.externalId)).request(
        "GET",
        next,
      );
      members.push(...(r.data ?? []).map((u: any) => String(u.id)));
      next = r.next;
    }
    await db
      .update(externalConversations)
      .set({ memberIds: members.filter((m) => m !== conn.externalWorkspaceId), membersSyncedAt: new Date() })
      .where(eq(externalConversations.id, conv.id));
  }

  /** Translate a webhook delivery (``{event, delivery, payload}``) into actions. */
  async parse(_db: Db, conn: Connection, input: any): Promise<InboundAction[]> {
    const { event, payload } = input ?? {};
    const repo = String(payload?.repository?.full_name ?? "");
    if (!repo) return [];
    // A GitHub App's webhooks name the installation: replies to this repository use its token.
    if (payload.installation?.id) repoInstallations.set(`${conn.id}:${repo}`, Number(payload.installation.id));
    const kind = payload.repository.private ? "private" : "public";
    const issue = payload.issue ?? payload.pull_request;
    if (!issue) return [];
    const isPr = !!payload.pull_request || !!issue.pull_request;
    const thread = {
      kind: isPr ? "pull_request" : "issue",
      title: String(issue.title ?? ""),
      url: String(issue.html_url ?? ""),
    };
    const bot = conn.botUserId ?? "";
    const isBot = (u: any) => !u || u.type === "Bot" || (bot && String(u.login).toLowerCase() === bot.toLowerCase());
    // "@login" as a word of its own; a fresh regex each time (a global one keeps state between calls)
    const login = bot.replace(/[^\w-]/g, "");
    const mention = (flags: string) => new RegExp(`(^|[^\\w-])@${login}(?![\\w-])`, flags);
    const addressed = (text: string) => !!login && mention("i").test(text);
    const clean = (text: string) => (login ? text.replace(mention("gi"), "$1") : text).trim();
    const message = (key: string, ts: string, author: any, text: string): InboundAction => {
      const msg: InboundMessage = {
        connectionId: conn.id,
        eventKey: key,
        conversationId: repo,
        conversationKind: kind,
        conversationName: repo,
        threadKey: String(issue.number),
        messageTs: ts,
        userId: String(author.id),
        userName: String(author.login),
        text: clean(text),
        addressed: addressed(text),
        thread,
      };
      return { kind: "message", message: msg };
    };

    if (event === "issue_comment") {
      const c = payload.comment ?? {};
      if (isBot(c.user)) return [];
      const ts = `comment-${c.id}`;
      if (payload.action === "created") return [message(`comment:${c.id}`, ts, c.user, String(c.body ?? ""))];
      if (payload.action === "edited")
        return [{ kind: "edit", connectionId: conn.id, conversationId: repo, ts, text: clean(String(c.body ?? "")) }];
      if (payload.action === "deleted") return [{ kind: "delete", connectionId: conn.id, conversationId: repo, ts }];
      return [];
    }
    if ((event === "issues" || event === "pull_request") && payload.action === "opened") {
      if (isBot(issue.user)) return [];
      const text = `**${issue.title ?? ""}**\n\n${issue.body ?? ""}`;
      return [message(`opened:${repo}#${issue.number}`, `opened-${issue.id}`, issue.user, text)];
    }
    return [];
  }
}

register("github", () => new GithubAdapter());

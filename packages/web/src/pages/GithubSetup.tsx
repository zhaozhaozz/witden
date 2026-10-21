import { type ReactNode, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api/client";
import type { Connection } from "../api/types";
import { fmtRelative } from "../lib/format";
import { useAction } from "../ui/feedback";
import { CopyText, Field, Section, Toggle } from "../ui/kit";
import { PublicAddressStep } from "./PublicAddress";
import {
  AccessStep,
  randomSecret,
  SetupSteps,
  TryStep,
  useLiveConnection,
  useSteps,
  WebhookStatus,
} from "./setupParts";

type Mode = "app" | "token";
type StepKey = "address" | "create" | "install" | "account" | "credentials" | "webhook" | "access" | "try" | "grant";

const STEP_TITLES: Record<StepKey, string> = {
  address: "准备公网事件地址",
  create: "在 GitHub 中创建 App",
  install: "把 App 安装到仓库",
  account: "准备机器人账号和 Token",
  credentials: "填写 Token 并测试连接",
  webhook: "在仓库中添加 Webhook",
  access: "选择机器人代表的 AI 员工",
  try: "在 GitHub 中试一试",
  grant: "给 AI 员工授权",
};

/**
 * GitHub pushes events to the public events URL either way; an app is created in one go from a manifest. An
 * account that only authenticates (``auth``) takes no events: no public address, webhook or role.
 */
const FLOW: Record<Mode | "auth", StepKey[]> = {
  app: ["address", "create", "install", "access", "try"],
  token: ["address", "account", "credentials", "webhook", "access", "try"],
  auth: ["account", "credentials", "grant"],
};
const flowOf = (mode: Mode, authOnly: boolean) => (mode === "token" && authOnly ? FLOW.auth : FLOW[mode]);

type StepNumber = (k: StepKey) => number;

/** What the app may do in the repositories it is installed in, and why witden asks for it. */
const PERMISSIONS: [string, string, string][] = [
  ["Issues", "Read and write", "读取 issue，以评论回复"],
  ["Pull requests", "Read and write", "读取 pull request，以评论回复"],
  ["Metadata", "Read-only", "读取仓库信息和协作者：私有仓库据此判断谁能看到回复"],
];

const EVENTS: [string, string, string][] = [
  ["issues", "Issues", "新建的 issue（正文中 @ 机器人时交给 AI 员工）"],
  ["issue_comment", "Issue comments", "issue 和 pull request 中的评论"],
  ["pull_request", "Pull requests", "新建的 pull request"],
];

/**
 * The manifest posted to GitHub while it creates the app: the browser returns with a one-time code, and this
 * (kept in the tab's session storage) ties that return to the connection and proves it answers this request.
 */
export const MANIFEST_KEY = "witden.github-manifest";

export type ManifestReturn = { code: string } | { error: string };

interface AppInfo {
  app: string;
  name: string;
  html_url?: string;
  owner?: string | null;
}

interface TestResult {
  ok: boolean;
  error?: string;
  app?: string;
  name?: string;
  accounts?: string[];
  login?: string;
}

function appManifest(name: string, eventsUrl: string, redirectUrl: string) {
  return {
    name,
    // GitHub requires a homepage; the public address is the only one it can reach.
    url: new URL(eventsUrl).origin,
    description: "witden 的机器人：在 issue 和 pull request 中 @ 它，把工作交给 witden 中的 AI 员工。",
    hook_attributes: { url: eventsUrl, active: true },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: { issues: "write", pull_requests: "write", metadata: "read" },
    default_events: EVENTS.map(([e]) => e),
  };
}

/** GitHub takes the manifest as a form POST; it then sends this tab back to ``redirect_url`` with a code. */
function sendManifest(manifest: object, org: string | null, state: string): void {
  const form = document.createElement("form");
  form.method = "post";
  form.action = `https://github.com/${org ? `organizations/${encodeURIComponent(org)}/` : ""}settings/apps/new?state=${state}`;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(manifest);
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

/** GitHub only delivers webhooks to an HTTPS address it can reach. */
function reachableByGithub(url: string | null | undefined): boolean {
  try {
    const u = new URL(url ?? "");
    return (
      u.protocol === "https:" &&
      !/^(localhost|127\.|10\.|0\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname) &&
      !u.hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

// GitHub's answers to the connection test, explained.
const GITHUB_ERRORS: [RegExp, string][] = [
  [/HTTP 401/, "Token 不正确或已过期，请重新生成后填写。"],
  [/HTTP 403/, "Token 的权限不够，或组织还没有批准这个 Token。"],
  [
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i,
    "witden 服务器连不上 api.github.com，请检查服务器的网络或代理设置。",
  ],
];

/**
 * Guided GitHub setup shown in the page itself. As a GitHub App (the default) witden hands GitHub the app's
 * settings in one go and fetches its credentials when the browser comes back (``manifest``); as a bot account
 * the token and the repository webhook are set up by hand. ``initial`` resumes an existing connection.
 */
export function GithubSetup({
  initial,
  manifest,
  onCreated,
  onClose,
}: {
  initial: Connection | null;
  manifest?: ManifestReturn | null;
  onCreated: (c: Connection) => void;
  onClose: (c: Connection | null) => void;
}) {
  const [conn, setConn] = useState(initial);
  const [mode, setMode] = useState<Mode>(initial?.github_auth ?? "app");
  // Token mode only: the account is no bot, it just authenticates the GitHub tools roles are given.
  const [authOnly, setAuthOnly] = useState(!!initial?.settings.auth_only);
  const flow = flowOf(mode, authOnly);
  /** Where to start: the first step, or where an existing connection left off. */
  const startOf = (m: Mode, a: boolean): StepKey => {
    if (!initial) return flowOf(m, a)[0];
    if (manifest || m === "app") return initial.has_credentials ? "install" : "create";
    if (a) return initial.bot_user_id ? "grant" : "credentials";
    return initial.bot_user_id ? "webhook" : "credentials";
  };
  const { step, setStep, reached, setReached, go, num } = useSteps(flow, manifest ? "create" : startOf(mode, authOnly));
  const restart = (m: Mode, a: boolean) => {
    setStep(startOf(m, a));
    setReached(flowOf(m, a).indexOf(startOf(m, a)));
  };
  const [address, setAddress] = useState<string | null>(null);
  const [app, setApp] = useState<AppInfo | null>(null);
  const [accounts, setAccounts] = useState<string[] | null>(null);
  const [login, setLogin] = useState<string | null>(null);
  // The webhook secret made in this visit (bot account): shown to copy into GitHub, never read back later.
  const [secret, setSecret] = useState<string | null>(null);
  // Only what GitHub sends from now on counts (an app's first ping arrives before witden has its secret).
  const [since] = useState(() => new Date().toISOString());
  const bot = conn?.bot_user_id ?? null;
  const update = (c: Connection) => setConn(c);

  const body: Partial<Record<StepKey, ReactNode>> = {
    address: (
      <PublicAddressStep
        onNext={(url) => {
          setAddress(url);
          go(mode === "app" ? "create" : "account");
        }}
      />
    ),
    create: (
      <CreateAppStep
        conn={conn}
        manifest={manifest ?? null}
        num={num}
        onCreated={(c) => {
          update(c);
          onCreated(c);
        }}
        onDone={(c, info) => {
          update(c);
          setApp(info);
          go("install");
        }}
      />
    ),
    install: conn ? (
      <InstallStep conn={conn} since={since} onAccounts={setAccounts} onNext={() => go("access")} />
    ) : null,
    account: <AccountStep authOnly={authOnly} onNext={() => go("credentials")} />,
    credentials: (
      <TokenStep
        conn={conn}
        authOnly={authOnly}
        onCreated={(c) => {
          update(c);
          onCreated(c);
        }}
        onSecret={setSecret}
        onTested={(c, who) => {
          update(c);
          setLogin(who);
          go(authOnly ? "grant" : "webhook");
        }}
      />
    ),
    grant: conn ? <GrantStep conn={conn} onDone={() => onClose(conn)} /> : null,
    webhook: conn ? (
      <WebhookStep conn={conn} secret={secret} since={since} onSecret={setSecret} onNext={() => go("access")} />
    ) : null,
    access: conn ? (
      <AccessStep
        conn={conn}
        intro="一个 GitHub App（或机器人账号）就是一个机器人。选择它代表 witden 中的哪位 AI 员工：在 issue 和 pull request 中 @ 它的评论都交给这位 AI 员工处理，回复以它的身份发出。需要多位 AI 员工时，为每位 AI 员工各建一个 App（在 witden 中各是一个接入）。"
        account="GitHub 账号"
        onSaved={(c) => {
          update(c);
          go("try");
        }}
      />
    ) : null,
    try: conn ? (
      <TryStep
        conn={conn}
        platform="GitHub"
        where="同一个 issue 或 pull request 中（以评论回复）"
        accessStep={num("access")}
        idle={
          mode === "app"
            ? `检查第 ${num("install")} 步 App 是否安装到了这个仓库。`
            : `检查第 ${num("webhook")} 步的 Webhook 是否收到了 ping，事件是否选对。`
        }
        steps={
          <>
            <li>
              打开{mode === "app" ? "安装了 App 的" : "添加了 Webhook 的"}仓库中的一个 issue 或 pull
              request，也可以新建一个。
            </li>
            <li>
              发表评论 <code>@{bot ?? "机器人"} 你好</code>；新建 issue 时在正文中 @ 它也可以。
            </li>
          </>
        }
        onDone={() => onClose(conn)}
      />
    ) : null,
  };
  const summary: Partial<Record<StepKey, string>> = {
    address: address ? `公网事件地址：${address}` : undefined,
    create: app ? `GitHub App「${app.name}」，@${app.app}` : bot ? `GitHub App @${bot}` : undefined,
    install: accounts?.length ? `已安装到：${accounts.join("、")}` : undefined,
    credentials: login || bot ? `${authOnly ? "GitHub 账号" : "机器人账号"} @${login || bot}` : undefined,
  };

  return (
    <Section
      title="接入 GitHub"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => onClose(conn)}>
          {conn ? "稍后继续" : "取消"}
        </button>
      }
    >
      {authOnly ? (
        <p className="setup-intro">
          按下面 {flow.length} 步接入一个 GitHub 账号，只作为认证：witden 不接收它的消息，也不需要公网地址和
          Webhook。获得授权的 AI 员工可以用这个账号的身份在 GitHub 中做事，例如代替本人提 issue、开 pull request、查看
          Actions；Token 由 witden 保管，不交给 AI 员工或电脑。
        </p>
      ) : (
        <p className="setup-intro">
          按下面 {flow.length} 步把 GitHub 接入 witden。完成后，在仓库的 issue 和 pull request 中 @
          机器人，就能把工作交给 witden 中的 AI 员工：一个 issue 或 pull request 是 witden 中的一个话题，AI
          员工以评论回复。GitHub 把事件推送到 witden 的公网事件地址，所以先要准备一个公网地址。
        </p>
      )}
      {initial ? null : (
        <div className="setup-modes">
          <div className="segmented">
            {(
              [
                ["app", "GitHub App（推荐）"],
                ["token", "机器人账号 Token"],
              ] as [Mode, string][]
            ).map(([m, label]) => (
              <button
                type="button"
                key={m}
                className={m === mode ? "seg seg-on" : "seg"}
                onClick={() => {
                  setMode(m);
                  restart(m, authOnly);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="small muted">
            {mode === "app"
              ? "以 App 的身份工作，回复显示为“名称[bot]”；按安装授权到仓库，令牌自动续期。witden 把 App 的设置一次交给 GitHub，凭据自动取回，不需要手动复制。"
              : authOnly
                ? "这个账号不当机器人使用，只给 AI 员工的 GitHub 工具提供认证（在 AI 员工的权限中按接入授权）。"
                : "以一个 GitHub 账号的身份工作：需要手动创建 Token，并在仓库中添加 Webhook。"}
          </p>
          {mode === "token" ? (
            <Toggle
              checked={authOnly}
              onChange={(v) => {
                setAuthOnly(v);
                restart(mode, v);
              }}
              label="只作为认证（不当机器人使用）"
            />
          ) : null}
        </div>
      )}
      <SetupSteps
        flow={flow}
        step={step}
        reached={reached}
        title={(k) => (authOnly && k === "account" ? "准备账号和 Token" : STEP_TITLES[k])}
        summary={summary}
        body={body}
        // Once the credentials work, every later step can be opened.
        unlocked={(_k, i) => !!bot && i > flow.indexOf(mode === "app" ? "create" : "credentials")}
        onOpen={setStep}
      />
    </Section>
  );
}

function CreateAppStep({
  conn,
  manifest,
  num,
  onCreated,
  onDone,
}: {
  conn: Connection | null;
  manifest: ManifestReturn | null;
  num: StepNumber;
  onCreated: (c: Connection) => void;
  onDone: (c: Connection, app: AppInfo) => void;
}) {
  const { run, busy } = useAction();
  const [name, setName] = useState(conn?.name ?? "GitHub");
  const [appName, setAppName] = useState(() => `witden-${randomSecret().slice(0, 4)}`);
  const [owner, setOwner] = useState<"user" | "org">("user");
  const [org, setOrg] = useState("");
  const [error, setError] = useState<string | null>(manifest && "error" in manifest ? manifest.error : null);
  const [exchanging, setExchanging] = useState(false);
  const exchanged = useRef(false);
  const code = manifest && "code" in manifest ? manifest.code : null;

  // Back from GitHub with a code: fetch the new app's credentials, once.
  useEffect(() => {
    if (!conn || !code || exchanged.current) return;
    exchanged.current = true;
    setExchanging(true);
    api
      .post<AppInfo>(`/api/connections/${conn.id}/github-app`, { code })
      .then(async (info) => {
        const fresh = (await api.get<Connection[]>("/api/connections")).find((c) => c.id === conn.id) ?? conn;
        onDone(fresh, info);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setExchanging(false));
  }, [conn, code, onDone]);

  const ready = !!name.trim() && !!appName.trim() && (owner === "user" || /^[\w.-]+$/.test(org.trim()));

  const create = async () => {
    let c = conn;
    if (!c) {
      c =
        (await run(() =>
          api.post<Connection>("/api/connections", { platform: "github", name: name.trim(), credentials: {} }),
        )) ?? null;
      if (!c) return;
      onCreated(c);
    } else if (name.trim() !== c.name) {
      const id = c.id;
      c = (await run(() => api.patch<Connection>(`/api/connections/${id}`, { name: name.trim() }))) ?? null;
      if (!c) return;
    }
    if (!c.events_url) return;
    const state = randomSecret();
    sessionStorage.setItem(MANIFEST_KEY, JSON.stringify({ state, conn: c.id }));
    const back = `${window.location.origin}/connections?github_app=${encodeURIComponent(c.id)}`;
    sendManifest(appManifest(appName.trim(), c.events_url, back), owner === "org" ? org.trim() : null, state);
  };

  if (exchanging) return <p>正在从 GitHub 取回 App 的凭据…</p>;
  return (
    <>
      <p>
        witden 把 App 需要的设置（事件地址、权限、订阅的事件）一次交给 GitHub。点击下面的按钮后在 GitHub 中确认，GitHub
        创建 App 后会跳回这里，witden 自动取回 App ID、私钥和 Webhook Secret，不需要手动复制。
      </p>
      {error ? (
        <div className="callout callout-bad" role="alert">
          <b>没能取回 App 的凭据：</b>
          {error}
          <div className="small">
            GitHub 返回的代码只能用一次，并且一小时内有效。App 可能已经创建好了：可以在 GitHub 的 Settings → Developer
            settings → GitHub Apps 中删除它后重新创建，或者在下面手动填写它的凭据。
          </div>
        </div>
      ) : null}
      {conn && !reachableByGithub(conn.events_url) ? (
        <div className="callout callout-wait">
          GitHub 只能把事件发到公网可以访问的 HTTPS 地址，这个接入的事件地址（{conn.events_url}）不满足。请回到第{" "}
          {num("address")} 步准备公网事件地址。
        </div>
      ) : null}
      <div className="form form-narrow">
        <Field label="接入名称" hint="在 witden 中区分不同的接入，例如公司或组织的名称。">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="App 名称"
          hint="GitHub 上所有 App 的名称都不能重复，最多 34 个字符。大家在 issue 中用“@名称”召唤它（字母转为小写，空格转为 -）。之后也可以在 GitHub 中修改。"
        >
          <input value={appName} maxLength={34} onChange={(e) => setAppName(e.target.value)} />
        </Field>
        <Field label="App 属于" hint="属于组织的 App 由组织管理，需要你是组织的所有者或 App 管理员。">
          <select value={owner} onChange={(e) => setOwner(e.target.value as "user" | "org")}>
            <option value="user">我的个人账号</option>
            <option value="org">一个组织</option>
          </select>
        </Field>
        {owner === "org" ? (
          <Field label="组织名" hint="github.com/ 后面的组织名，例如 acme。">
            <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="acme" />
          </Field>
        ) : null}
      </div>
      <ol className="setup-list">
        <li>
          点击{" "}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!ready || busy}
            onClick={() => void create()}
          >
            在 GitHub 中创建 App ↗
          </button>
          。如果还没有登录 GitHub，先登录。
        </li>
        <li>
          GitHub 显示 App 的名称和设置，点击 <b>Create GitHub App for …</b>。名称已被使用时，GitHub 会提示修改。
        </li>
        <li>GitHub 跳回 witden，这里会自动进入下一步。</li>
      </ol>
      <details className="setup-more">
        <summary>App 申请的权限和订阅的事件</summary>
        <table className="table table-compact">
          <tbody>
            {PERMISSIONS.map(([p, level, why]) => (
              <tr key={p}>
                <td>{p}</td>
                <td>{level}</td>
                <td>{why}</td>
              </tr>
            ))}
            {EVENTS.map(([e, label, why]) => (
              <tr key={e}>
                <td>事件</td>
                <td>{label}</td>
                <td>{why}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">App 设为私有（只能安装到创建它的账号或组织），只能看到和回复它被安装到的仓库。</p>
      </details>
      <ManualApp conn={conn} onCreated={onCreated} onDone={onDone} />
    </>
  );
}

/** An app made by hand (or before): its settings to check, and its three credentials. */
function ManualApp({
  conn,
  onCreated,
  onDone,
}: {
  conn: Connection | null;
  onCreated: (c: Connection) => void;
  onDone: (c: Connection, app: AppInfo) => void;
}) {
  const { run, busy } = useAction();
  const [appId, setAppId] = useState("");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState(() => randomSecret());
  const [result, setResult] = useState<TestResult | null>(null);
  const ready = /^\d+$/.test(appId.trim()) && key.includes("PRIVATE KEY") && !!secret.trim();

  const save = async () => {
    const credentials = { app_id: appId.trim(), private_key: key.trim(), webhook_secret: secret.trim() };
    let c = conn;
    if (!c) {
      c =
        (await run(() =>
          api.post<Connection>("/api/connections", { platform: "github", name: "GitHub", credentials }),
        )) ?? null;
      if (!c) return;
      onCreated(c);
    } else {
      const id = c.id;
      c = (await run(() => api.patch<Connection>(`/api/connections/${id}`, { credentials }))) ?? null;
      if (!c) return;
    }
    const id = c.id;
    const out = await run(() => api.post<TestResult>(`/api/connections/${id}/test`));
    if (!out) return;
    setResult(out);
    if (!out.ok) return;
    const fresh = (await api.get<Connection[]>("/api/connections")).find((x) => x.id === id) ?? c;
    onDone(fresh, { app: out.app ?? "", name: out.name ?? out.app ?? "" });
  };

  return (
    <details className="setup-more">
      <summary>已经有 GitHub App，或无法跳转回来：手动填写凭据</summary>
      <p className="small">
        在 App 的设置页面（GitHub → Settings → Developer settings → GitHub Apps → 选择 App）中确认：
      </p>
      <ul className="setup-list small">
        <li>
          <b>Webhook URL</b> 是这个接入的事件地址：
          {conn?.events_url ? <CopyText text={conn.events_url} /> : "（填写凭据保存后显示，再回来填到 GitHub）"}
        </li>
        <li>
          <b>Webhook secret</b> 与下面填写的相同（可以用下面生成的值）。
        </li>
        <li>
          <b>Permissions</b>：{PERMISSIONS.map(([p, level]) => `${p} ${level}`).join("，")}；<b>Subscribe to events</b>
          ：{EVENTS.map(([, label]) => label).join("、")}。
        </li>
      </ul>
      <div className="form form-narrow">
        <Field label="App ID" hint="App 设置页面 About 中的数字。">
          <input className="mono" value={appId} onChange={(e) => setAppId(e.target.value)} />
        </Field>
        <Field label="Private key" hint="在 App 设置页面底部 Private keys 中生成，下载的 .pem 文件的全部内容。">
          <textarea
            rows={4}
            className="mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="-----BEGIN RSA PRIVATE KEY-----"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <Field label="Webhook Secret" hint="与 App 设置中的 Webhook secret 相同。保存后不能再查看。">
          <input className="mono" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={() => void save()}>
            {busy ? "正在测试…" : "保存并测试连接"}
          </button>
        </div>
      </div>
      {result && !result.ok ? (
        <div className="callout callout-bad" role="alert">
          连接失败：{result.error}。请检查 App ID 和私钥是否属于同一个 App。
        </div>
      ) : null}
    </details>
  );
}

function InstallStep({
  conn: initial,
  since,
  onAccounts,
  onNext,
}: {
  conn: Connection;
  since: string;
  onAccounts: (a: string[]) => void;
  onNext: () => void;
}) {
  const conn = useLiveConnection(initial);
  const [accounts, setAccounts] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ask GitHub where the app is installed while this step is open.
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const out = await api.post<TestResult>(`/api/connections/${initial.id}/test`);
        if (stopped) return;
        if (out.ok) {
          setAccounts(out.accounts ?? []);
          onAccounts(out.accounts ?? []);
          setError(null);
        } else setError(out.error ?? "未知错误");
      } catch (err) {
        if (!stopped) setError(errorMessage(err));
      }
    };
    void check();
    const timer = window.setInterval(check, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [initial.id, onAccounts]);
  const slug = conn.bot_user_id ?? "";
  const installed = !!accounts?.length;

  return (
    <>
      <p>App 只能看到、回复它被安装到的仓库。把它安装到需要的个人账号或组织，并选择仓库。</p>
      <ol className="setup-list">
        <li>
          点击{" "}
          <a
            className="btn btn-sm btn-primary"
            href={`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`}
            target="_blank"
            rel="noreferrer"
          >
            安装 App ↗
          </a>
          ，选择账号或组织。
        </li>
        <li>
          选择 <b>All repositories</b>，或选择 <b>Only select repositories</b> 后勾选仓库，点击 <b>Install</b>。
        </li>
        <li>回到这里，witden 每 5 秒检查一次安装情况。</li>
      </ol>
      {installed ? (
        <div className="callout">已安装到：{accounts.join("、")}。之后在 GitHub 中增加或调整仓库也会生效。</div>
      ) : (
        <div className="small muted setup-events">{error ? `检查失败：${error}` : "还没有安装。"}</div>
      )}
      <WebhookStatus
        conn={conn}
        platform="GitHub"
        since={since}
        idle="安装后 GitHub 会给 witden 发一条安装事件，收到后这里会显示。"
        accepted={(at) =>
          `${fmtRelative(at)}，收到了 GitHub 发来的事件，签名正确：事件地址和 Webhook Secret 都没问题。`
        }
        fix="App 设置中的 Webhook secret 与 witden 保存的不一致：在 App 设置中重新设置 Webhook secret，并在接入的“编辑”中填写同一个值。"
      />
      <div className="setup-next">
        <button type="button" className="btn btn-primary" disabled={!installed} onClick={onNext}>
          已安装，下一步
        </button>
        {installed ? null : <span className="small muted">安装到至少一个账号或组织后继续。</span>}
      </div>
    </>
  );
}

/** What roles may do with an account that only authenticates, and the token permissions each needs. */
const TOOL_PERMISSIONS: [string, string, string][] = [
  ["Contents", "代码与文件", "读取：Read-only；提交文件、新建分支：Read and write"],
  ["Issues", "Issue", "查看：Read-only；新建、评论、修改：Read and write"],
  ["Pull requests", "Pull request", "查看：Read-only；新建、评论、合并：Read and write"],
  ["Actions", "Actions", "查看运行：Read-only；重新运行、手动触发：Read and write"],
];

function AccountStep({ authOnly, onNext }: { authOnly: boolean; onNext: () => void }) {
  if (authOnly)
    return (
      <>
        <p>
          可以用本人的账号（AI 员工代替本人操作，GitHub 上显示为本人），也可以用一个单独的账号。AI
          员工能做的不会超过这个账号和 Token 的权限，也不会超过在 AI 员工权限中授予的范围。
        </p>
        <ol className="setup-list">
          <li>
            用这个账号创建 Token，二选一：
            <ul>
              <li>
                <b>Fine-grained token（推荐）：</b>打开{" "}
                <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                  新建 fine-grained token ↗
                </a>
                。Resource owner 选择仓库所在的账号或组织（组织可能需要管理员批准）；Repository access
                只选需要的仓库；Permissions 只给 AI 员工要用的（见下表，Metadata 会自动设为
                Read-only）。设置有效期后生成，复制 <code>github_pat_</code> 开头的 Token。
              </li>
              <li>
                <b>Classic token：</b>打开{" "}
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=witden"
                  target="_blank"
                  rel="noreferrer"
                >
                  新建 classic token ↗
                </a>
                （已勾选 repo 和 workflow 权限，能访问这个账号的所有仓库），设置有效期后生成，复制 <code>ghp_</code>{" "}
                开头的 Token。
              </li>
            </ul>
          </li>
        </ol>
        <table className="table table-compact">
          <tbody>
            {TOOL_PERMISSIONS.map(([p, label, level]) => (
              <tr key={p}>
                <td>{p}</td>
                <td>{label}</td>
                <td>{level}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="callout callout-wait">
          Token 过期后 AI 员工的 GitHub 工具会失败；到期前请在接入的“编辑”中换上新的 Token。
        </div>
        <div className="setup-next">
          <button type="button" className="btn btn-primary" onClick={onNext}>
            已拿到 Token，下一步
          </button>
        </div>
      </>
    );
  return (
    <>
      <p>
        机器人账号就是一个普通的 GitHub 账号：大家在 issue 中 @ 它，AI 员工以它的身份回复。建议为 witden
        单独注册一个账号（例如 acme-witden），不要用个人账号。
      </p>
      <ol className="setup-list">
        <li>注册或登录这个账号，让它能访问要接入的仓库：私有仓库需要把它加为协作者（Write 权限）或组织成员。</li>
        <li>
          用这个账号创建 Token，二选一：
          <ul>
            <li>
              <b>Fine-grained token（推荐）：</b>打开{" "}
              <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                新建 fine-grained token ↗
              </a>
              。Resource owner 选择仓库所在的账号或组织（组织可能需要管理员批准）；Repository access
              选择仓库；Permissions 中把 Issues 和 Pull requests 设为 Read and write（Metadata 会自动设为
              Read-only）。设置有效期后生成，复制 <code>github_pat_</code> 开头的 Token。
            </li>
            <li>
              <b>Classic token：</b>打开{" "}
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&description=witden"
                target="_blank"
                rel="noreferrer"
              >
                新建 classic token ↗
              </a>
              （已勾选 repo 权限），设置有效期后生成，复制 <code>ghp_</code> 开头的 Token。
            </li>
          </ul>
        </li>
      </ol>
      <div className="callout callout-wait">Token 过期后 AI 员工无法回复；到期前请在接入的“编辑”中换上新的 Token。</div>
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          已拿到 Token，下一步
        </button>
      </div>
    </>
  );
}

function TokenStep({
  conn,
  authOnly,
  onCreated,
  onSecret,
  onTested,
}: {
  conn: Connection | null;
  /** The account only authenticates: no webhook secret is made. */
  authOnly: boolean;
  onCreated: (c: Connection) => void;
  onSecret: (s: string) => void;
  onTested: (c: Connection, login: string) => void;
}) {
  const { run, busy } = useAction();
  const [name, setName] = useState(conn?.name ?? "GitHub");
  const [token, setToken] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const odd = !!token.trim() && !/^(ghp_|github_pat_)/.test(token.trim());
  const ready = !!name.trim() && (conn ? true : !!token.trim());
  const hint = result && !result.ok ? GITHUB_ERRORS.find(([re]) => re.test(result.error ?? ""))?.[1] : null;

  const submit = async () => {
    let c = conn;
    if (!c) {
      // witden makes the webhook secret; the next step shows it to copy into GitHub.
      const webhookSecret = authOnly ? null : randomSecret();
      c =
        (await run(() =>
          api.post<Connection>("/api/connections", {
            platform: "github",
            name: name.trim(),
            credentials: { token: token.trim(), ...(webhookSecret ? { webhook_secret: webhookSecret } : {}) },
            ...(authOnly ? { settings: { auth_only: true } } : {}),
          }),
        )) ?? null;
      if (!c) return;
      if (webhookSecret) onSecret(webhookSecret);
      onCreated(c);
    } else if (token.trim() || name.trim() !== c.name) {
      const id = c.id;
      c =
        (await run(() =>
          api.patch<Connection>(`/api/connections/${id}`, {
            name: name.trim(),
            ...(token.trim() ? { credentials: { token: token.trim() } } : {}),
          }),
        )) ?? null;
      if (!c) return;
    }
    const id = c.id;
    const out = await run(() => api.post<TestResult>(`/api/connections/${id}/test`));
    if (!out) return;
    setResult(out);
    if (!out.ok) return;
    const fresh = (await api.get<Connection[]>("/api/connections")).find((x) => x.id === id) ?? c;
    onTested(fresh, out.login ?? "");
  };

  return (
    <>
      <p>
        {authOnly
          ? "把账号的 Token 填到这里。witden 加密保存它，保存后不能再查看，也不会交给 AI 员工或电脑。"
          : "把机器人账号的 Token 填到这里。witden 加密保存它，保存后不能再查看；同时生成下一步要用的 Webhook Secret。"}
      </p>
      <form
        className="form form-narrow"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void submit();
        }}
      >
        <Field label="接入名称" hint="在 witden 中区分不同的接入，例如公司或组织的名称。">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label={authOnly ? "账号的 Token" : "机器人账号的 Token"}
          hint={
            odd ? (
              <span className="text-wait">GitHub 的 Token 通常以 github_pat_ 或 ghp_ 开头，请确认复制完整。</span>
            ) : conn ? (
              "留空保持不变"
            ) : undefined
          }
        >
          <input
            type="password"
            className="mono"
            autoComplete="off"
            placeholder="github_pat_… 或 ghp_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <div className="setup-next">
          <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
            {busy ? "正在测试…" : "保存并测试连接"}
          </button>
        </div>
      </form>
      {result && !result.ok ? (
        <div className="callout callout-bad" role="alert">
          <b>连接失败。</b>
          {hint ?? "请检查 Token 后重试。"}
          <div className="small">GitHub 返回：{result.error}</div>
        </div>
      ) : null}
    </>
  );
}

/** The account takes no messages: roles use it once they are given its GitHub tools. */
function GrantStep({ conn, onDone }: { conn: Connection; onDone: () => void }) {
  return (
    <>
      <p>接入已经可以使用。它不接收消息；要让 AI 员工用这个账号在 GitHub 中做事：</p>
      <ol className="setup-list">
        <li>
          打开 <b>AI 员工管理</b>，编辑要授权的 AI 员工，在 <b>权限</b> 的 GitHub 部分找到「{conn.name}」。
        </li>
        <li>
          按类别（代码与文件、Issue、Pull
          request、Actions）勾选读取或写入。写入可以设为“需询问”：每次写入前在控制台批准。
        </li>
        <li>多个 GitHub 接入（例如不同的人或组织）分别授权，一个接入的权限不会用到另一个接入上。</li>
      </ol>
      <p className="small muted">
        AI 员工要把私有仓库或其他话题中的内容写到更多人能看到的地方（例如公开仓库的
        issue）之前，会先请内容的所有者在控制台批准。
      </p>
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          完成
        </button>
      </div>
    </>
  );
}

function WebhookStep({
  conn: initial,
  secret,
  since,
  onSecret,
  onNext,
}: {
  conn: Connection;
  secret: string | null;
  since: string;
  onSecret: (s: string) => void;
  onNext: () => void;
}) {
  const conn = useLiveConnection(initial);
  const { run, busy } = useAction();
  const [target, setTarget] = useState("");
  const t = target.trim();
  const hooks = /^[\w.-]+\/[\w.-]+$/.test(t)
    ? `https://github.com/${t}/settings/hooks/new`
    : /^[\w.-]+$/.test(t)
      ? `https://github.com/organizations/${t}/settings/hooks/new`
      : null;

  // The stored secret cannot be shown: a new one replaces it, to copy into GitHub.
  const regenerate = async () => {
    const s = randomSecret();
    const out = await run(() =>
      api.patch<Connection>(`/api/connections/${initial.id}`, { credentials: { webhook_secret: s } }),
    );
    if (out) onSecret(s);
  };

  return (
    <>
      <p>让 GitHub 把仓库中的事件推送给 witden：在仓库（或整个组织）中添加一个 Webhook。</p>
      {reachableByGithub(conn.events_url) ? null : (
        <div className="callout callout-wait">
          GitHub 只能把事件发到公网可以访问的 HTTPS 地址，下面的地址不满足，请回到第 1 步准备公网事件地址。
        </div>
      )}
      <div className="form form-narrow">
        <Field
          label="仓库或组织"
          hint="填 owner/repo 为一个仓库添加；只填组织名则为组织下所有仓库添加（需要组织所有者权限）。"
        >
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="acme/api" />
        </Field>
      </div>
      <div className="setup-field">
        <span className="field-label">Payload URL</span>
        <CopyText text={conn.events_url ?? ""} />
      </div>
      <div className="setup-field">
        <span className="field-label">Secret</span>
        {secret ? (
          <CopyText text={secret} />
        ) : (
          <span className="small">
            witden 保存的 Secret 不能再查看。{" "}
            <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void regenerate()}>
              生成新的 Secret
            </button>
          </span>
        )}
      </div>
      <ol className="setup-list">
        <li>
          打开{" "}
          {hooks ? (
            <a href={hooks} target="_blank" rel="noreferrer">
              添加 Webhook ↗
            </a>
          ) : (
            <>
              仓库的 <b>Settings → Webhooks → Add webhook</b>
            </>
          )}
          。
        </li>
        <li>
          <b>Payload URL</b> 填上面的地址；<b>Content type</b> 选 <code>application/json</code>；<b>Secret</b>{" "}
          填上面的值；SSL verification 保持 Enable。
        </li>
        <li>
          <b>Which events</b> 选择 <b>Let me select individual events</b>，取消默认的 Pushes，勾选{" "}
          {EVENTS.map(([, label]) => label).join("、")}；保持 <b>Active</b>，点击 <b>Add webhook</b>。
        </li>
      </ol>
      <WebhookStatus
        conn={conn}
        platform="GitHub"
        since={since}
        idle="添加后 GitHub 会立即发送一个 ping，收到后这里会显示（每 3 秒刷新）。"
        accepted={(at) => `${fmtRelative(at)}，收到了 GitHub 的请求，签名正确。`}
        fix={
          <>
            Webhook 的 Secret 与 witden 保存的不一致。生成新的 Secret，在 GitHub 中编辑这个 Webhook 换上，再在 Recent
            Deliveries 中点击 Redeliver。{" "}
            <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void regenerate()}>
              生成新的 Secret
            </button>
          </>
        }
      />
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          已添加 Webhook，下一步
        </button>
      </div>
    </>
  );
}

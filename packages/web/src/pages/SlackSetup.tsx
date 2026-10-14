import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Connection, Role, Rule } from "../api/types";
import { fmtRelative } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useDirectory } from "../lib/session";
import { useAction } from "../ui/feedback";
import { CopyText, Field, FieldGroup, Loaded, MultiPick, Section, Tag } from "../ui/kit";
import {
  ConnectionSettingsFields,
  Identities,
  INBOUND_STATUS,
  type InboundEvent,
  lastRejected,
  settingsOf,
} from "./connectionParts";
import { PublicAddressStep } from "./PublicAddress";

const BOT_SCOPES: [string, string][] = [
  ["app_mentions:read", "收到频道中 @机器人 的消息"],
  ["channels:history", "读取机器人所在公开频道的消息"],
  ["groups:history", "读取机器人所在私有频道的消息"],
  ["im:history", "读取与机器人的私信"],
  ["mpim:history", "读取机器人所在多人私信的消息"],
  ["channels:read", "读取公开频道的名称"],
  ["groups:read", "读取私有频道的名称"],
  ["im:read", "读取私信会话的信息"],
  ["mpim:read", "读取多人私信会话的信息"],
  ["chat:write", "发送角色的回复"],
  ["chat:write.customize", "以角色自己的名称和头像发言（可在设置中关闭）"],
  ["users:read", "读取发消息的人的名字"],
  ["files:read", "读取消息中的文件"],
];

const BOT_EVENTS: [string, string][] = [
  ["app_mention", "频道中有人 @机器人"],
  ["message.channels", "机器人所在公开频道的消息（同一 thread 的后续消息）"],
  ["message.groups", "机器人所在私有频道的消息"],
  ["message.im", "与机器人的私信"],
  ["message.mpim", "机器人所在多人私信的消息"],
];

/**
 * Everything the Slack app needs except the event subscription: Slack rejects bot events without a
 * Request URL, and the URL only works once this connection holds the app's signing secret.
 */
function slackManifest(name: string) {
  return {
    display_information: { name },
    features: {
      // People can message the bot from its Messages tab.
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: { scopes: { bot: BOT_SCOPES.map(([s]) => s) } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}

/** Slack only delivers events to an HTTPS address reachable from the internet. */
function reachableBySlack(url: string): boolean {
  try {
    const u = new URL(url);
    const local =
      u.hostname === "localhost" ||
      u.hostname.endsWith(".local") ||
      u.hostname === "[::1]" ||
      /^(127\.|10\.|0\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
    return u.protocol === "https:" && !local;
  } catch {
    return false;
  }
}

// Slack's error codes from auth.test, explained.
const SLACK_ERRORS: [RegExp, string][] = [
  [
    /invalid_auth|not_authed/,
    "Bot Token 不正确。请复制 OAuth & Permissions 页面中以 xoxb- 开头的 Bot User OAuth Token。",
  ],
  [
    /account_inactive|token_revoked|app_uninstalled|team_disabled/,
    "应用已被卸载或令牌已失效。请在 Slack 中重新安装应用，再复制新的 Bot Token。",
  ],
  [
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i,
    "witden 服务器连不上 slack.com，请检查服务器的网络或代理设置。",
  ],
];

/** Why a role cannot take work yet (the dispatcher refuses roles without a computer or a model). */
function missingSetup(r: Role): string | undefined {
  const missing = [r.instance_id ? null : "分配电脑", r.model_config_id ? null : "配置模型"].filter(Boolean);
  return missing.length ? `还没有${missing.join("和")}，暂时不能工作` : undefined;
}

const STEPS = [
  "准备公网事件地址",
  "在 Slack 中创建应用",
  "填写凭据并测试连接",
  "在 Slack 中订阅事件",
  "选择处理请求的角色",
  "在 Slack 中试一试",
];
const [ADDRESS, APP, CREDENTIALS, EVENTS, ACCESS, TRY] = STEPS.map((_, i) => i);

interface TestResult {
  ok: boolean;
  error?: string;
  team?: string;
  bot?: string;
}

/**
 * Guided Slack setup shown in the page itself. It starts with the public address Slack will send events to;
 * the connection is created at the credentials step, once the app exists; ``initial`` resumes the guide
 * for an existing connection.
 */
export function SlackSetup({
  initial,
  onCreated,
  onClose,
}: {
  initial: Connection | null;
  onCreated: (c: Connection) => void;
  onClose: (c: Connection | null) => void;
}) {
  const [conn, setConn] = useState(initial);
  const start = initial ? (initial.bot_user_id ? EVENTS : CREDENTIALS) : ADDRESS;
  const [step, setStep] = useState(start);
  const [reached, setReached] = useState(start);
  const [botName, setBotName] = useState("witden");
  const [address, setAddress] = useState<string | null>(null);
  const [tested, setTested] = useState<TestResult | null>(null);
  const go = (n: number) => {
    setStep(n);
    setReached((r) => Math.max(r, n));
  };
  const bot = tested?.bot ?? (initial ? null : botName);

  const body: ReactNode[] = [
    <PublicAddressStep
      key="address"
      onNext={(url) => {
        setAddress(url);
        go(APP);
      }}
    />,
    <AppStep key="app" name={botName} onName={setBotName} onNext={() => go(CREDENTIALS)} />,
    <CredentialsStep
      key="credentials"
      conn={conn}
      result={tested}
      onCreated={(c) => {
        setConn(c);
        onCreated(c);
      }}
      onTested={(c, r) => {
        setConn(c);
        setTested(r);
        if (r.ok) go(EVENTS);
      }}
    />,
    conn ? (
      <EventsStep key="events" conn={conn} onNext={() => go(ACCESS)} onFixSecret={() => setStep(CREDENTIALS)} />
    ) : null,
    conn ? (
      <AccessStep
        key="access"
        conn={conn}
        onSaved={(c) => {
          setConn(c);
          go(TRY);
        }}
      />
    ) : null,
    conn ? <TryStep key="try" conn={conn} bot={bot} onDone={() => onClose(conn)} /> : null,
  ];
  const summary = [
    address ? `公网事件地址：${address}` : null,
    initial ? null : `应用名称：${botName}`,
    tested?.ok ? `已连接到工作区「${tested.team ?? "?"}」，机器人 @${tested.bot ?? "?"}` : conn ? conn.name : null,
    null,
    null,
    null,
  ];

  return (
    <Section
      title="接入 Slack"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => onClose(conn)}>
          {conn ? "稍后继续" : "取消"}
        </button>
      }
    >
      <p className="setup-intro">
        按下面 {STEPS.length} 步把 Slack 接入 witden，需要 Slack
        工作区的应用管理权限（或由工作区管理员批准安装）。完成后，工作区里的人可以在频道或私信中 @ 机器人，把工作交给
        witden 中的角色：每个 Slack thread 对应 witden 中的一个话题，角色的回复发回同一个 thread。
      </p>
      <ol className="setup-steps">
        {STEPS.map((title, i) => {
          const state = i === step ? "current" : i < reached ? "done" : "todo";
          // Steps after the credentials need a connection that works; from then on any of them can be opened.
          const open =
            i !== step && (i <= reached || (i >= EVENTS && !!conn?.bot_user_id)) ? () => setStep(i) : undefined;
          return (
            <li key={title} className={`setup-step setup-${state}`}>
              <button type="button" className="setup-head" disabled={!open} onClick={open}>
                <span className="setup-num" aria-hidden>
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span className="setup-title">{title}</span>
                {state === "done" && summary[i] ? <span className="setup-summary">{summary[i]}</span> : null}
              </button>
              {state === "current" ? <div className="setup-body">{body[i]}</div> : null}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

function AppStep({ name, onName, onNext }: { name: string; onName: (v: string) => void; onNext: () => void }) {
  const manifest = JSON.stringify(slackManifest(name.trim() || "witden"), null, 2);
  const url = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifest)}`;
  return (
    <>
      <p>
        先在 Slack 中为 witden 创建一个应用。下面的按钮会打开
        Slack，并预先填好应用清单：名称、机器人用户、需要的权限，以及允许大家私信机器人。
      </p>
      <Field
        label="机器人名称"
        hint="在 Slack 中显示的名字，大家用“@名称”召唤它；最多 35 个字符，之后也可以在 Slack 中修改。"
      >
        <input value={name} maxLength={35} onChange={(e) => onName(e.target.value)} />
      </Field>
      <ol className="setup-list">
        <li>
          点击{" "}
          <a className="btn btn-sm btn-primary" href={url} target="_blank" rel="noreferrer">
            在 Slack 中创建应用 ↗
          </a>
          ，选择要接入的工作区，点击 <b>Next</b>，确认清单后点击 <b>Create</b>。
        </li>
        <li>
          在应用页面左侧打开 <b>Install App</b>，点击 <b>Install to Workspace</b>，再点击 <b>Allow</b>。
          如果工作区要求审批，等工作区管理员批准后再继续。
        </li>
      </ol>
      <div className="callout callout-wait">
        <b>安装完成后先停在这里，回到 witden。</b>下一步要把 Bot Token 和 Signing Secret 填到 witden。先不要设置 Event
        Subscriptions：事件地址要等 witden 保存了 Signing Secret 后才能通过 Slack 的验证，放在第 {EVENTS + 1} 步。
      </div>
      <details className="setup-more">
        <summary>按钮打不开预填页面？手动粘贴清单</summary>
        <p className="small">
          打开{" "}
          <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
            api.slack.com/apps
          </a>
          ，选择 <b>Create New App → From a manifest</b>，选择工作区，切换到 <b>JSON</b>，用下面的内容替换默认清单。
        </p>
        <CopyText text={manifest} label="应用清单（JSON）" />
        <pre className="mono-block">{manifest}</pre>
      </details>
      <details className="setup-more">
        <summary>清单申请的权限分别做什么</summary>
        <table className="table table-compact">
          <tbody>
            {BOT_SCOPES.map(([s, d]) => (
              <tr key={s}>
                <td>
                  <code>{s}</code>
                </td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">
          机器人只能读到它所在频道和私信中的消息；witden 只同步有人 @ 机器人的 thread（可在设置中调整）。
        </p>
      </details>
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          已安装，去填写凭据
        </button>
      </div>
    </>
  );
}

function CredentialsStep({
  conn,
  result,
  onCreated,
  onTested,
}: {
  conn: Connection | null;
  result: TestResult | null;
  onCreated: (c: Connection) => void;
  onTested: (c: Connection, r: TestResult) => void;
}) {
  const { run, busy } = useAction();
  const [name, setName] = useState(conn?.name ?? "Slack");
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const wrongToken = !!token.trim() && !token.trim().startsWith("xoxb-");
  // Slack shows several tokens and secrets; an app-level token here fails every event's signature check.
  const secretIsToken = /^(xapp-|xox[a-z]-)/.test(secret.trim());
  const secretOdd = !!secret.trim() && !secretIsToken && !/^[0-9a-f]{32}$/.test(secret.trim());
  const ready = !!name.trim() && !wrongToken && !secretIsToken && (conn ? true : !!token.trim() && !!secret.trim());
  const hint = result && !result.ok ? SLACK_ERRORS.find(([re]) => re.test(result.error ?? ""))?.[1] : null;

  const submit = async () => {
    const credentials = Object.fromEntries(
      Object.entries({ bot_token: token.trim(), signing_secret: secret.trim() }).filter(([, v]) => v),
    );
    let saved = conn;
    if (!saved) {
      saved =
        (await run(() =>
          api.post<Connection>("/api/connections", { platform: "slack", name: name.trim(), credentials }),
        )) ?? null;
      if (!saved) return;
      onCreated(saved);
    } else if (Object.keys(credentials).length || name.trim() !== saved.name) {
      saved =
        (await run(() =>
          api.patch<Connection>(`/api/connections/${saved!.id}`, {
            name: name.trim(),
            ...(Object.keys(credentials).length ? { credentials } : {}),
          }),
        )) ?? null;
      if (!saved) return;
    }
    const id = saved.id;
    const out = await run(() => api.post<TestResult>(`/api/connections/${id}/test`));
    if (!out) return;
    // The test records the workspace and bot (or the error) on the connection.
    const fresh = (await api.get<Connection[]>("/api/connections")).find((c) => c.id === id) ?? saved;
    onTested(fresh, out);
  };

  return (
    <>
      <p>把应用的两项凭据填到这里。witden 加密保存它们，保存后不能再查看。</p>
      <ul className="setup-list">
        <li>
          <b>Bot User OAuth Token</b>：应用的 <b>OAuth &amp; Permissions</b> 页面，以 <code>xoxb-</code> 开头。witden
          用它读取消息和发送回复。
        </li>
        <li>
          <b>Signing Secret</b>：应用的 <b>Basic Information</b> 页面 → <b>App Credentials</b>，点击 Show 后复制。witden
          用它确认收到的事件确实来自 Slack。注意不要填 App-Level Token（xapp- 开头）、Client Secret 或 Verification
          Token，Signing Secret 是 32 位十六进制字符。
        </li>
      </ul>
      <form
        className="form form-narrow"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void submit();
        }}
      >
        <Field label="接入名称" hint="在 witden 中区分不同的接入，例如公司或工作区的名称。">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Bot User OAuth Token"
          hint={
            wrongToken ? (
              <span className="text-bad">
                这不是 Bot Token：Bot Token 以 xoxb- 开头（xoxp- 是用户令牌，xapp- 是应用级令牌）。
              </span>
            ) : conn ? (
              "留空保持不变"
            ) : undefined
          }
        >
          <input
            type="password"
            className="mono"
            autoComplete="off"
            placeholder="xoxb-…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <Field
          label="Signing Secret"
          hint={
            secretIsToken ? (
              <span className="text-bad">
                这是 Slack 的令牌，不是 Signing Secret（xapp- 开头的是 App-Level Token）。Signing Secret 在 Basic
                Information → App Credentials 中，是 32 位十六进制字符。
              </span>
            ) : secretOdd ? (
              <span className="text-wait">
                Signing Secret 通常是 32 位十六进制字符，请确认复制的是 App Credentials 中的 Signing Secret。
              </span>
            ) : conn ? (
              "留空保持不变"
            ) : undefined
          }
        >
          <input
            type="password"
            className="mono"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
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
          {hint ?? "请检查凭据后重试。"}
          <div className="small">Slack 返回：{result.error}</div>
        </div>
      ) : null}
    </>
  );
}

function EventsStep({
  conn: initial,
  onNext,
  onFixSecret,
}: {
  conn: Connection;
  onNext: () => void;
  onFixSecret: () => void;
}) {
  const [conn, setConn] = useState(initial);
  // Follow Slack's calls to the events URL while this step is open.
  useEffect(() => {
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const fresh = (await api.get<Connection[]>("/api/connections")).find((c) => c.id === initial.id);
        if (fresh && !stopped) setConn(fresh);
      } catch {
        // the next poll retries
      }
    }, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [initial.id]);
  const url = conn.events_url ?? "";
  const rejected = lastRejected(conn);
  return (
    <>
      <p>让 Slack 把消息推送给 witden：在应用中填写 witden 的事件地址，并订阅需要的事件。</p>
      {reachableBySlack(url) ? null : (
        <div className="callout callout-wait">
          Slack 只能把事件发到公网可以访问的 HTTPS 地址，下面的地址不满足，Slack 会验证失败。请回到第 {ADDRESS + 1}{" "}
          步准备公网事件地址。
        </div>
      )}
      <div className="setup-field">
        <span className="field-label">事件地址</span>
        <CopyText text={url} />
      </div>
      <ol className="setup-list">
        <li>
          打开应用的 <b>Event Subscriptions</b> 页面，打开 <b>Enable Events</b>。
        </li>
        <li>
          把事件地址粘贴到 <b>Request URL</b>，等待显示 <b>Verified</b>
          。验证失败时，检查地址能否从公网访问，以及上一步的 Signing Secret 是否正确。
        </li>
        <li>
          展开 <b>Subscribe to bot events</b>，点击 <b>Add Bot User Event</b>，逐个添加下面 5 个事件：
          <table className="table table-compact setup-table">
            <tbody>
              {BOT_EVENTS.map(([e, d]) => (
                <tr key={e}>
                  <td>
                    <code>{e}</code>
                  </td>
                  <td>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </li>
        <li>
          点击页面底部的 <b>Save Changes</b>。如果页面顶部提示重新安装应用（reinstall your app），按提示重新安装。
        </li>
      </ol>
      {rejected ? (
        <div className="callout callout-bad" role="alert">
          {fmtRelative(rejected.at)}，witden 收到了 Slack 的请求，但校验没有通过：{rejected.reason}。这通常是第{" "}
          {CREDENTIALS + 1} 步的 Signing Secret 填错了：它在应用的 Basic Information → App Credentials 中，是 32
          位十六进制字符，不是 xapp- 开头的 App-Level Token。改好后在 Slack 中点击 Request URL 旁的 Retry。{" "}
          <button type="button" className="btn btn-xs" onClick={onFixSecret}>
            重新填写 Signing Secret
          </button>
        </div>
      ) : conn.webhook?.verified_at ? (
        <div className="callout">{fmtRelative(conn.webhook.verified_at)}，Slack 验证了事件地址，可以继续订阅事件。</div>
      ) : (
        <div className="small muted setup-events">
          还没有收到 Slack 的请求。在 Slack 中填写 Request URL 后，这里会显示验证结果（每 3 秒刷新）。
        </div>
      )}
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          已显示 Verified 并保存，下一步
        </button>
      </div>
    </>
  );
}

function AccessStep({ conn, onSaved }: { conn: Connection; onSaved: (c: Connection) => void }) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const rules = useResource(() => api.get<Rule[]>("/api/rules"), []);
  const [roles, setRoles] = useState<string[]>([]);
  const [defaultRole, setDefaultRole] = useState("");
  const [settings, setSettings] = useState(settingsOf(conn));
  // Rules for this connection, and rules with no conditions (they cover every request).
  const covering = (rules.data ?? []).filter(
    (r) => r.enabled && r.effect === "allow" && (r.match.connection_id === conn.id || !Object.keys(r.match).length),
  );
  const needRule = rules.data !== undefined && !covering.length;
  const chosenDefault = roles.includes(defaultRole) ? defaultRole : (roles[0] ?? "");

  const save = async () => {
    const out = await run(async () => {
      if (needRule && roles.length)
        await api.post("/api/rules", {
          name: `${conn.name}：默认分配`,
          match: { connection_id: conn.id },
          allow_role_ids: roles,
          default_role_id: chosenDefault,
        });
      return api.patch<Connection>(`/api/connections/${conn.id}`, { settings });
    }, "已保存");
    if (out) onSaved(out);
  };

  return (
    <>
      <p>
        来自 Slack 的请求要经过<b>分配规则</b>
        ：没有匹配的规则时一律拒绝。规则决定这个接入可以使用哪些角色，以及消息中没有指定角色时交给谁。
      </p>
      <Loaded res={rules}>
        {() =>
          needRule ? (
            <div className="form form-narrow">
              <FieldGroup label="可以处理 Slack 请求的角色">
                <MultiPick
                  columns={2}
                  options={dir.roles
                    .filter((r) => r.status === "active")
                    .map((r) => ({
                      value: r.id,
                      label: `${r.name} @${r.handle}`,
                      hint: missingSetup(r),
                    }))}
                  value={roles}
                  onChange={setRoles}
                  empty="还没有可用的角色，请先在“角色”中创建"
                />
              </FieldGroup>
              <Field label="默认角色" hint="消息中没有指定角色（例如 @机器人 role:dev）时交给它。">
                <select value={chosenDefault} disabled={!roles.length} onChange={(e) => setDefaultRole(e.target.value)}>
                  {roles.map((id) => (
                    <option key={id} value={id}>
                      {dir.roleLabel(id)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : (
            <div className="callout">
              已有覆盖这个接入的规则：
              <ul>
                {covering.map((r) => (
                  <li key={r.id}>
                    {r.name}：可以使用{" "}
                    {r.allow_role_ids
                      ? r.allow_role_ids.map((id) => dir.roleLabel(id)).join("、") || "（无）"
                      : "所有角色"}
                    ；默认角色 {r.default_role_id ? dir.roleLabel(r.default_role_id) : "无"}
                    {Object.keys(r.match).length ? null : <Tag tone="off">对所有来源生效</Tag>}
                  </li>
                ))}
              </ul>
              需要调整时到 <Link to="/rules">分配规则</Link> 中修改。
            </div>
          )
        }
      </Loaded>
      <h3 className="setup-sub">谁可以使用</h3>
      <p className="small muted">
        默认只有把 Slack 账号关联到 witden
        管理员账号的人可以使用（最后一步可以直接关联你自己的账号）。要让工作区里的其他人也能使用，开启“允许未关联的人使用”。
      </p>
      <div className="form form-narrow">
        <ConnectionSettingsFields platform="slack" value={settings} onChange={setSettings} />
      </div>
      <div className="setup-next">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || rules.data === undefined}
          onClick={() => void save()}
        >
          保存，下一步
        </button>
        {needRule && !roles.length ? (
          <span className="small text-bad">不选角色也可以继续，但添加规则之前，来自 Slack 的请求都会被拒绝。</span>
        ) : null}
      </div>
    </>
  );
}

function TryStep({ conn, bot, onDone }: { conn: Connection; bot: string | null; onDone: () => void }) {
  const [events, setEvents] = useState<InboundEvent[] | null>(null);
  // Watch the connection's inbound events while this step is open.
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const rows = await api.get<InboundEvent[]>(`/api/connections/${conn.id}/inbound`);
        if (!stopped) setEvents(rows);
      } catch {
        // keep the last list; the next poll retries
      }
    };
    void load();
    const timer = window.setInterval(load, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [conn.id]);
  const recent = (events ?? []).slice(0, 5);
  // What to do next depends on how the latest message was handled.
  const latest = recent[0];
  const name = bot ? `@${bot}` : "@机器人";

  return (
    <>
      <ol className="setup-list">
        <li>
          在 Slack 的一个频道中发送 <code>/invite {name}</code>，把机器人邀请进来。
        </li>
        <li>
          在频道中发送 <code>{name} 你好</code>；也可以在 Slack 左侧的 Apps 中找到机器人，直接给它发私信。
        </li>
        <li>回到这里查看 witden 收到的消息和处理结果（每 3 秒刷新）。</li>
      </ol>
      <div className="setup-events">
        {events === null ? (
          <span className="muted small">正在读取…</span>
        ) : recent.length ? (
          <ul className="plain-list">
            {recent.map((e) => (
              <li key={e.id}>
                <span className="muted small">{fmtRelative(e.received_at)}</span>{" "}
                <Tag tone={INBOUND_STATUS[e.status]?.[1] ?? "info"}>{INBOUND_STATUS[e.status]?.[0] ?? e.status}</Tag>
                {e.detail ? <span className="small muted"> {e.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted small">
            还没有收到消息。发了消息后这里一直没有变化时，检查第 {EVENTS + 1} 步的 Request URL 是否显示
            Verified，事件是否已订阅并保存。
          </span>
        )}
      </div>
      {latest?.status === "dispatched" ? (
        <div className="callout">
          已交给角色处理。角色的回复会出现在 Slack 的同一个 thread 中，也可以在 witden 的会话列表中查看。
        </div>
      ) : null}
      {latest?.status === "not_assigned" ? (
        <div className="callout callout-wait">
          witden 收到了请求，但没有交给角色：{latest.detail}。常见原因是角色还没有分配电脑或模型（在
          <Link to="/roles">角色管理</Link>中设置），或者不在<Link to="/rules">分配规则</Link>
          允许的角色中。处理后在 Slack 中再发一次；Slack 的 thread 中也会收到这条说明。
        </div>
      ) : null}
      {latest?.status === "ignored" ? (
        <div className="callout">这条消息没有 @ 机器人。witden 默认只处理有人 @ 机器人的 thread。</div>
      ) : null}
      {latest?.status === "unlinked_user" ? (
        <>
          <div className="callout callout-wait">
            发消息的 Slack 账号还没有关联 witden 账号，所以没有交给角色。在下面把你自己的 Slack 账号关联到你的 witden
            账号，然后在 Slack 中再发一次；其他人可以在第 {ACCESS + 1} 步开启“允许未关联的人使用”。
          </div>
          <Identities key={events?.length} conn={conn} />
        </>
      ) : null}
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          完成
        </button>
      </div>
    </>
  );
}

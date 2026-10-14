import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Connection, Role } from "../api/types";
import { fmtRelative } from "../lib/format";
import { useDirectory } from "../lib/session";
import { useAction } from "../ui/feedback";
import { CopyText, Field, Section, Tag } from "../ui/kit";
import {
  ConnectionSettingsFields,
  Identities,
  INBOUND_STATUS,
  type InboundEvent,
  lastRejected,
  SLACK_FIELD_HELP,
  settingsOf,
  socketText,
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
 * The Slack app's manifest. With Socket Mode it subscribes to the events too; through the events URL it
 * cannot: Slack rejects bot events without a Request URL, and the URL only works once this connection holds
 * the app's signing secret.
 */
function slackManifest(name: string, mode: Mode) {
  return {
    display_information: { name },
    features: {
      // People can message the bot from its Messages tab.
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: { scopes: { bot: BOT_SCOPES.map(([s]) => s) } },
    settings:
      mode === "socket"
        ? {
            event_subscriptions: { bot_events: BOT_EVENTS.map(([e]) => e) },
            org_deploy_enabled: false,
            socket_mode_enabled: true,
            token_rotation_enabled: false,
          }
        : { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
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

// Slack's error codes from the connection test, explained (the app-level token's first).
const SLACK_ERRORS: [RegExp, string][] = [
  [
    /apps\.connections\.open failed: (invalid_auth|not_authed|token_revoked)/,
    "App-Level Token 不正确或已撤销。请复制 Basic Information → App-Level Tokens 中 xapp- 开头的令牌。",
  ],
  [
    /apps\.connections\.open failed: missing_scope/,
    "App-Level Token 缺少 connections:write 权限。请在 App-Level Tokens 中重新生成，并添加 connections:write。",
  ],
  [/apps\.connections\.open failed: not_allowed_token_type/, "这里要填 App-Level Token（xapp- 开头）。"],
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

type Mode = "socket" | "http";
type StepKey = "address" | "app" | "credentials" | "events" | "access" | "try";

const STEP_TITLES: Record<StepKey, string> = {
  address: "准备公网事件地址",
  app: "在 Slack 中创建应用",
  credentials: "填写凭据并测试连接",
  events: "在 Slack 中订阅事件",
  access: "选择机器人代表的角色",
  try: "在 Slack 中试一试",
};

/** Socket Mode needs no public address and subscribes to events in the manifest. */
const FLOW: Record<Mode, StepKey[]> = {
  socket: ["app", "credentials", "access", "try"],
  http: ["address", "app", "credentials", "events", "access", "try"],
};

/** A step's number in the current flow, for texts that point at another step. */
type StepNumber = (k: StepKey) => number;

interface TestResult {
  ok: boolean;
  error?: string;
  team?: string;
  bot?: string;
}

/**
 * Guided Slack setup shown in the page itself. Socket Mode (the default) needs no public address; the events
 * URL starts with one. The connection is created at the credentials step, once the app exists; ``initial``
 * resumes the guide for an existing connection, in that connection's mode.
 */
export function SlackSetup({
  initial,
  initialMode,
  onCreated,
  onClose,
}: {
  initial: Connection | null;
  /** Open on this way of connecting (e.g. to switch an existing connection to Socket Mode). */
  initialMode?: Mode;
  onCreated: (c: Connection) => void;
  onClose: (c: Connection | null) => void;
}) {
  const [conn, setConn] = useState(initial);
  // An existing connection's way when the guide opened; choosing the other way switches it in place.
  const was: Mode | null = initial ? (initial.slack_mode ?? "http") : null;
  /** Where to start in a way's flow: the first step, or where an existing connection left off. */
  const startOf = (m: Mode): StepKey =>
    !initial || m !== was ? FLOW[m][0] : initial.bot_user_id ? (m === "socket" ? "access" : "events") : "credentials";
  const [mode, setMode] = useState<Mode>(initialMode ?? was ?? "socket");
  const flow = FLOW[mode];
  const switching = !!was && mode !== was;
  // The new way's credential is still missing until the credentials step saves it.
  const unsaved = !!conn && (conn.slack_mode ?? "http") !== mode;
  const [step, setStep] = useState<StepKey>(startOf(mode));
  const [reached, setReached] = useState(flow.indexOf(startOf(mode)));
  const [botName, setBotName] = useState("witden");
  const [address, setAddress] = useState<string | null>(null);
  const [tested, setTested] = useState<TestResult | null>(null);
  const go = (k: StepKey) => {
    setStep(k);
    setReached((r) => Math.max(r, flow.indexOf(k)));
  };
  const num: StepNumber = (k) => flow.indexOf(k) + 1;
  const bot = tested?.bot ?? (initial ? null : botName);
  const afterCredentials = mode === "socket" ? "access" : "events";

  const body: Record<StepKey, ReactNode> = {
    address: (
      <PublicAddressStep
        onNext={(url) => {
          setAddress(url);
          go("app");
        }}
      />
    ),
    app: switching ? (
      <SwitchAppStep to={mode} num={num} onNext={() => go("credentials")} />
    ) : (
      <AppStep mode={mode} name={botName} onName={setBotName} num={num} onNext={() => go("credentials")} />
    ),
    credentials: (
      <CredentialsStep
        mode={mode}
        conn={conn}
        unsaved={unsaved}
        result={tested}
        onCreated={(c) => {
          setConn(c);
          onCreated(c);
        }}
        onTested={(c, r) => {
          setConn(c);
          setTested(r);
          if (r.ok) go(afterCredentials);
        }}
      />
    ),
    events: conn ? (
      <EventsStep conn={conn} num={num} onNext={() => go("access")} onFixSecret={() => setStep("credentials")} />
    ) : null,
    access: conn ? (
      <AccessStep
        conn={conn}
        onSaved={(c) => {
          setConn(c);
          go("try");
        }}
      />
    ) : null,
    try: conn ? <TryStep conn={conn} bot={bot} num={num} onDone={() => onClose(conn)} /> : null,
  };
  const summary: Partial<Record<StepKey, string>> = {
    address: address ? `公网事件地址：${address}` : undefined,
    app: switching
      ? mode === "socket"
        ? "已打开 Socket Mode"
        : "已关闭 Socket Mode"
      : initial
        ? undefined
        : `应用名称：${botName}`,
    credentials: tested?.ok ? `已连接到工作区「${tested.team ?? "?"}」，机器人 @${tested.bot ?? "?"}` : conn?.name,
  };

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
        {switching
          ? `按下面 ${flow.length} 步把这个接入切换到${mode === "socket" ? " Socket Mode" : "事件地址"}，需要 Slack 工作区的应用管理权限。频道、私信、机器人代表的角色和已关联的账号都保持不变。`
          : `按下面 ${flow.length} 步把 Slack 接入 witden，需要 Slack 工作区的应用管理权限（或由工作区管理员批准安装）。完成后，工作区里的人可以在频道或私信中 @ 机器人，把工作交给 witden 中的角色：一个频道是 witden 中的一个话题，和 Slack 中看到的一致，角色在提问的地方（频道里或 thread 里）回答。`}
      </p>
      <div className="setup-modes">
        <div className="segmented">
          {(
            [
              ["socket", "Socket Mode（推荐，不需要公网地址）"],
              ["http", "事件地址（HTTP，需要公网地址）"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              type="button"
              key={m}
              className={m === mode ? "seg seg-on" : "seg"}
              onClick={() => {
                setMode(m);
                setStep(startOf(m));
                setReached(FLOW[m].indexOf(startOf(m)));
              }}
            >
              {label}
              {m === was ? "（当前）" : ""}
            </button>
          ))}
        </div>
        <p className="small muted">
          {switching
            ? `从${was === "socket" ? " Socket Mode " : "事件地址"}切换到${mode === "socket" ? " Socket Mode" : "事件地址"}：沿用原来的 Slack 应用，不需要重新创建。在第 ${num("credentials")} 步保存新的凭据之前，原来的方式继续工作。`
            : was
              ? `这个接入目前使用${was === "socket" ? " Socket Mode" : "事件地址（HTTP）"}。选择另一种方式即可在这里切换。`
              : mode === "socket"
                ? "witden 主动连到 Slack 接收消息：不需要公网地址，witden 在公网上什么都不暴露。"
                : "Slack 把消息推送到 witden 的公网事件地址：需要一个只转发到事件端口的 HTTPS 地址。"}
        </p>
      </div>
      <ol className="setup-steps">
        {flow.map((key, i) => {
          const at = flow.indexOf(step);
          const state = key === step ? "current" : i < reached ? "done" : "todo";
          // Steps after the credentials need a connection that works; from then on any of them can be opened.
          const open =
            i !== at && (i <= reached || (i > flow.indexOf("credentials") && !!conn?.bot_user_id))
              ? () => setStep(key)
              : undefined;
          return (
            <li key={key} className={`setup-step setup-${state}`}>
              <button type="button" className="setup-head" disabled={!open} onClick={open}>
                <span className="setup-num" aria-hidden>
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span className="setup-title">
                  {key === "app" && switching
                    ? mode === "socket"
                      ? "让原来的 Slack 应用打开 Socket Mode"
                      : "让原来的 Slack 应用改用事件地址"
                    : STEP_TITLES[key]}
                </span>
                {state === "done" && summary[key] ? <span className="setup-summary">{summary[key]}</span> : null}
              </button>
              {state === "current" ? <div className="setup-body">{body[key]}</div> : null}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

function AppStep({
  mode,
  name,
  onName,
  num,
  onNext,
}: {
  mode: Mode;
  name: string;
  onName: (v: string) => void;
  num: StepNumber;
  onNext: () => void;
}) {
  const manifest = JSON.stringify(slackManifest(name.trim() || "witden", mode), null, 2);
  const url = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifest)}`;
  return (
    <>
      <p>
        先在 Slack 中为 witden 创建一个应用。下面的按钮会打开
        Slack，并预先填好应用清单：名称、机器人用户、需要的权限、允许大家私信机器人
        {mode === "socket" ? "，以及 Socket Mode 和要订阅的事件" : ""}。
      </p>
      <Field
        label="机器人名称"
        hint="在 Slack 中显示的名字，大家用“@名称”召唤它。这个机器人会代表 witden 中的一个角色，建议用那个角色的名字；最多 35 个字符，之后也可以在 Slack 中修改。"
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
        {mode === "socket" ? (
          <li>
            生成 App-Level Token：打开应用的 <b>Basic Information</b> 页面 → <b>App-Level Tokens</b>，点击{" "}
            <b>Generate Token and Scopes</b>，名称随意（例如 witden），点击 <b>Add Scope</b> 选择{" "}
            <code>connections:write</code>，再点击 <b>Generate</b>，复制 <code>xapp-</code> 开头的令牌。如果创建应用时
            Slack 已经弹出 <code>xapp-</code> 开头、带 <code>connections:write</code> 的令牌，直接用它即可。
          </li>
        ) : null}
      </ol>
      {mode === "socket" ? (
        <div className="callout callout-wait">
          <b>拿到两个令牌后回到 witden：</b>OAuth &amp; Permissions 页面中 <code>xoxb-</code> 开头的 Bot User OAuth
          Token，和 <code>xapp-</code> 开头的 App-Level Token。Socket Mode 不需要 Signing Secret、Request URL
          或公网地址。
        </div>
      ) : (
        <div className="callout callout-wait">
          <b>安装完成后先停在这里，回到 witden。</b>下一步要把 Bot Token 和 Signing Secret 填到 witden。Slack
          列出的令牌中只用得到 xoxb- 开头的 Bot Token；Signing Secret 不在其中，下一步会说明在哪里复制。先不要设置 Event
          Subscriptions：事件地址要等 witden 保存了 Signing Secret 后才能通过 Slack 的验证，放在第 {num("events")} 步。
        </div>
      )}
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
          机器人只能读到它所在频道和私信中的消息；witden 记录这些频道和私信中的所有 thread，只有 @
          机器人的消息才交给角色。
        </p>
      </details>
      {mode === "socket" ? <SocketFaq /> : null}
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          {mode === "socket" ? "已安装并生成令牌，去填写凭据" : "已安装，去填写凭据"}
        </button>
      </div>
    </>
  );
}

/** What tends to go wrong with Socket Mode, and what to do about it. */
function SocketFaq({ open }: { open?: boolean }) {
  return (
    <details className="setup-more" open={open}>
      <summary>可能遇到的问题</summary>
      <ul className="setup-list">
        <li>
          <b>打开 Socket Mode 时 Slack 弹出了一个窗口：</b>这是在生成 App-Level Token。名称随意，确认 scope 中有{" "}
          <code>connections:write</code>（没有就点 Add Scope 添加），点击 Generate，复制 <code>xapp-</code> 开头的令牌。
        </li>
        <li>
          <b>已经有 xapp- 开头的令牌（例如之前误填进 Signing Secret 的那个）：</b>只要带 <code>connections:write</code>{" "}
          就可以直接用。在 Basic Information → App-Level Tokens 中点开令牌能看到它的 scope。
        </li>
        <li>
          <b>测试提示缺少 connections:write，或令牌不正确：</b>在 App-Level Tokens 中重新生成一个带{" "}
          <code>connections:write</code> 的令牌，完整复制后再填。
        </li>
        <li>
          <b>连接状态显示“应用没有打开 Socket Mode”：</b>Slack 应用的 Socket Mode 开关是关着的。打开后，witden
          会在一分钟内自动连上。
        </li>
        <li>
          <b>已连接，但发消息没有反应：</b>
          <ul>
            <li>
              Event Subscriptions 中的 Enable Events 没打开，或 5 个事件没添加、没点 Save
              Changes。之前用事件地址时，如果 Request URL 没验证通过，事件订阅很可能没保存成功，需要重新添加。
            </li>
            <li>页面顶部提示重新安装应用（reinstall your app），但还没有重新安装。</li>
            <li>
              机器人没被邀请进频道：在频道中发送 <code>/invite @机器人名称</code>。
            </li>
          </ul>
        </li>
        <li>
          <b>切换的一两分钟里消息丢失：</b>打开 Socket Mode 后，Slack 只通过连接发送消息；在 witden
          连上之前发给机器人的消息可能收不到，连上后重发即可。
        </li>
        <li>
          <b>一个 Slack 应用只给一个 witden 用：</b>多个程序同时用同一个应用的 Socket Mode 时，Slack
          会把每条消息只发给其中一个连接，其他的收不到。演示环境和正式环境请各建一个 Slack 应用。
        </li>
        <li>
          <b>网络：</b>witden 服务器需要能访问 Slack（出站 443 端口）；不需要公网地址，也不需要开放任何入站端口。
        </li>
        <li>
          <b>原来的事件地址：</b>Slack 会保留原来的 Request URL，但打开 Socket Mode 后不再使用。如果公网事件地址和
          Cloudflare Tunnel 只为 Slack 准备，之后可以停用。
        </li>
      </ul>
    </details>
  );
}

/** Switching an existing connection: change the Slack app it already has instead of creating one. */
function SwitchAppStep({ to, num, onNext }: { to: Mode; num: StepNumber; onNext: () => void }) {
  if (to === "http")
    return (
      <>
        <p>沿用原来的 Slack 应用，不需要重新创建。在应用的设置页面（api.slack.com/apps → 选择这个应用）中：</p>
        <ol className="setup-list">
          <li>
            左侧打开 <b>Socket Mode</b>，关闭 <b>Enable Socket Mode</b>。打开时 Slack
            只通过连接发送消息，不会使用事件地址。
          </li>
          <li>
            左侧打开 <b>Basic Information</b> → <b>App Credentials</b>，复制 <b>Signing Secret</b>，下一步填写。
          </li>
          <li>Request URL 和事件订阅在第 {num("events")} 步配置。</li>
        </ol>
        <div className="callout callout-wait">
          关闭 Socket Mode 后，到第 {num("events")} 步 Slack 验证事件地址之前，发给机器人的消息会收不到。
        </div>
        <div className="setup-next">
          <button type="button" className="btn btn-primary" onClick={onNext}>
            已关闭 Socket Mode，下一步
          </button>
        </div>
      </>
    );
  const manifest = JSON.stringify({ settings: slackManifest("witden", "socket").settings }, null, 2);
  return (
    <>
      <p>
        沿用原来的 Slack 应用，不需要重新创建，也不需要重新填写 Bot Token。在应用的设置页面（api.slack.com/apps →
        选择这个应用）中：
      </p>
      <ol className="setup-list">
        <li>
          左侧打开 <b>Socket Mode</b>，打开 <b>Enable Socket Mode</b>。如果应用还没有 App-Level Token，Slack
          会弹出窗口引导生成：名称随意，确认 scope 中有 <code>connections:write</code>，点击 <b>Generate</b>，复制{" "}
          <code>xapp-</code> 开头的令牌。
        </li>
        <li>
          左侧打开 <b>Event Subscriptions</b>：确认 <b>Enable Events</b> 已打开（Socket Mode 下不再需要 Request
          URL），在 <b>Subscribe to bot events</b> 中有下面 5 个事件，缺的点击 Add Bot User Event 补上，然后点击{" "}
          <b>Save Changes</b>：
          <div className="small">
            {BOT_EVENTS.map(([e]) => (
              <code key={e} className="setup-chip">
                {e}
              </code>
            ))}
          </div>
        </li>
        <li>如果页面顶部提示重新安装应用（reinstall your app），按提示重新安装。</li>
      </ol>
      <div className="callout callout-wait">
        打开 Socket Mode 后，Slack 只通过连接发送消息：尽快在第 {num("credentials")} 步填入 App-Level Token，witden
        连上之前发给机器人的消息可能收不到。
      </div>
      <details className="setup-more">
        <summary>也可以直接修改应用清单</summary>
        <p className="small">
          在应用左侧打开 <b>App Manifest</b>，切换到 JSON，把其中的 <code>settings</code> 换成下面的内容，点击 Save
          Changes。之后仍需按第 1 步生成 App-Level Token。
        </p>
        <CopyText text={manifest} label="settings（JSON）" />
        <pre className="mono-block">{manifest}</pre>
      </details>
      <SocketFaq />
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          已打开 Socket Mode 并拿到令牌，下一步
        </button>
      </div>
    </>
  );
}

function CredentialsStep({
  mode,
  conn,
  unsaved,
  result,
  onCreated,
  onTested,
}: {
  mode: Mode;
  conn: Connection | null;
  /** An existing connection switching ways: the new way's credential is required. */
  unsaved: boolean;
  result: TestResult | null;
  onCreated: (c: Connection) => void;
  onTested: (c: Connection, r: TestResult) => void;
}) {
  const { run, busy } = useAction();
  const [name, setName] = useState(conn?.name ?? "Slack");
  const [token, setToken] = useState("");
  // The second credential: the app-level token (Socket Mode) or the signing secret (events URL).
  const [secret, setSecret] = useState("");
  const key = mode === "socket" ? "app_token" : "signing_secret";
  const wrongToken = !!token.trim() && !token.trim().startsWith("xoxb-");
  const wrongAppToken = mode === "socket" && !!secret.trim() && !secret.trim().startsWith("xapp-");
  // Slack shows several tokens and secrets; an app-level token here fails every event's signature check.
  const secretIsToken = mode === "http" && /^(xapp-|xox[a-z]-)/.test(secret.trim());
  const secretOdd = mode === "http" && !!secret.trim() && !secretIsToken && !/^[0-9a-f]{32}$/.test(secret.trim());
  const ready =
    !!name.trim() &&
    !wrongToken &&
    !wrongAppToken &&
    !secretIsToken &&
    (conn ? !unsaved || !!secret.trim() : !!token.trim() && !!secret.trim());
  const hint = result && !result.ok ? SLACK_ERRORS.find(([re]) => re.test(result.error ?? ""))?.[1] : null;

  const submit = async () => {
    const credentials = Object.fromEntries(
      Object.entries({ bot_token: token.trim(), [key]: secret.trim() }).filter(([, v]) => v),
    );
    let saved = conn;
    // Switching ways: try the new credential before saving it, so a wrong one leaves the old way working.
    if (saved && unsaved) {
      const id = saved.id;
      const tried = await run(() => api.post<TestResult>(`/api/connections/${id}/test`, { credentials }));
      if (!tried) return;
      if (!tried.ok) return onTested(saved, tried);
    }
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
      <p>
        {unsaved
          ? mode === "socket"
            ? "填写 App-Level Token 后，这个接入改用 Socket Mode：原来的 Signing Secret 会被删除，Slack 的消息改由 witden 主动建立的连接接收。Bot Token 不变，可以留空。"
            : "填写 Signing Secret 后，这个接入改用事件地址：原来的 App-Level Token 会被删除，witden 断开与 Slack 的连接。Bot Token 不变，可以留空。"
          : "把应用的两项凭据填到这里。witden 加密保存它们，保存后不能再查看。"}
        {mode === "socket" ? "保存后 witden 会测试令牌，并与 Slack 建立连接。" : ""}
      </p>
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
          description={SLACK_FIELD_HELP.bot_token}
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
        {mode === "socket" ? (
          <Field
            label="App-Level Token"
            description={SLACK_FIELD_HELP.app_token}
            hint={
              wrongAppToken ? (
                <span className="text-bad">这不是 App-Level Token：它以 xapp- 开头（xoxb- 开头的是 Bot Token）。</span>
              ) : conn && !unsaved ? (
                "留空保持不变"
              ) : undefined
            }
          >
            <input
              type="password"
              className="mono"
              autoComplete="off"
              placeholder="xapp-…"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
        ) : (
          <Field
            label="Signing Secret"
            description={SLACK_FIELD_HELP.signing_secret}
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
              ) : conn && !unsaved ? (
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
        )}
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
  num,
  onNext,
  onFixSecret,
}: {
  conn: Connection;
  num: StepNumber;
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
          Slack 只能把事件发到公网可以访问的 HTTPS 地址，下面的地址不满足，Slack 会验证失败。请回到第 {num("address")}{" "}
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
          {num("credentials")} 步的 Signing Secret 填错了：它在应用的 Basic Information → App Credentials 中，是 32
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
  const [settings, setSettings] = useState(settingsOf(conn));
  // A system administrator works only in the console, never as a bot.
  const roles = dir.roles.filter((r) => !r.system_admin && (r.status === "active" || r.id === settings.role_id));

  const save = async () => {
    const out = await run(() => api.patch<Connection>(`/api/connections/${conn.id}`, { settings }), "已保存");
    if (out) onSaved(out);
  };

  return (
    <>
      <p>
        一个 Slack 应用就是工作区里的一个机器人。选择它代表 witden
        中的哪个角色：发给这个机器人的消息都交给这个角色处理，回复以机器人的名字和头像发出。需要多个角色时，为每个角色各建一个
        Slack 应用（在 witden 中各是一个接入）。
      </p>
      <div className="pick setup-roles" role="radiogroup" aria-label="机器人代表的角色">
        {roles.length ? (
          roles.map((r) => (
            <label key={r.id} className={`pick-item${settings.role_id === r.id ? " pick-on" : ""}`}>
              <input
                type="radio"
                name="bot-role"
                checked={settings.role_id === r.id}
                onChange={() => setSettings({ ...settings, role_id: r.id })}
              />
              <span className="pick-text">
                <span>
                  {r.name} @{r.handle}
                </span>
                {missingSetup(r) ? <span className="pick-hint">{missingSetup(r)}</span> : null}
              </span>
            </label>
          ))
        ) : (
          <span className="muted small">
            还没有可用的角色，请先在<Link to="/roles">角色管理</Link>中创建。
          </span>
        )}
      </div>
      <h3 className="setup-sub">谁可以使用</h3>
      <p className="small muted">
        默认只有把 Slack 账号关联到 witden
        管理员账号的人可以使用（最后一步可以直接关联你自己的账号）。要让工作区里的其他人也能使用，开启“允许未关联的人使用”。
      </p>
      <div className="form form-narrow">
        <ConnectionSettingsFields platform="slack" value={settings} onChange={setSettings} chooseRole={false} />
      </div>
      <div className="setup-next">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !settings.role_id}
          onClick={() => void save()}
        >
          保存，下一步
        </button>
        {settings.role_id ? null : <span className="small muted">选择一个角色后继续。</span>}
      </div>
    </>
  );
}

function TryStep({
  conn: initial,
  bot,
  num,
  onDone,
}: {
  conn: Connection;
  bot: string | null;
  num: StepNumber;
  onDone: () => void;
}) {
  const [events, setEvents] = useState<InboundEvent[] | null>(null);
  const [conn, setConn] = useState(initial);
  const socket = conn.slack_mode === "socket";
  // Watch the connection's inbound events (and, in Socket Mode, its socket) while this step is open.
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const [rows, all] = await Promise.all([
          api.get<InboundEvent[]>(`/api/connections/${initial.id}/inbound`),
          api.get<Connection[]>("/api/connections"),
        ]);
        if (stopped) return;
        setEvents(rows);
        const fresh = all.find((c) => c.id === initial.id);
        if (fresh) setConn(fresh);
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
  }, [initial.id]);
  const recent = (events ?? []).slice(0, 5);
  const link = socketText(conn.socket);
  // What to do next depends on how the latest message was handled.
  const latest = recent[0];
  const name = bot ? `@${bot}` : "@机器人";

  return (
    <>
      {socket ? (
        <p className="small">
          与 Slack 的连接（Socket Mode）：<Tag tone={link.tone}>{link.text}</Tag>
        </p>
      ) : null}
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
            还没有收到消息。
            {socket
              ? "发了消息后这里一直没有变化时，检查上面的连接状态，以及机器人是否已被邀请进频道。"
              : `发了消息后这里一直没有变化时，检查第 ${num("events")} 步的 Request URL 是否显示 Verified，事件是否已订阅并保存。`}
          </span>
        )}
      </div>
      {latest?.status === "dispatched" ? (
        <div className="callout">
          已交给角色处理。角色会在提问的地方（频道里或 thread 里）回复，也可以在 witden 的会话列表中查看。
        </div>
      ) : null}
      {latest?.status === "not_assigned" ? (
        <div className="callout callout-wait">
          witden 收到了请求，但没有交给角色：{latest.detail}。常见原因是机器人代表的角色还没有分配电脑或模型（在
          <Link to="/roles">角色管理</Link>中设置），或者这个接入还没有选择角色（第 {num("access")} 步）。处理后在 Slack
          中再发一次；Slack 中提问的地方也会收到这条说明。
        </div>
      ) : null}
      {latest?.status === "stored" ? (
        <div className="callout">这条消息没有 @ 机器人：witden 记录了它，但只有 @ 机器人的消息才交给角色。</div>
      ) : null}
      {latest?.status === "unlinked_user" ? (
        <>
          <div className="callout callout-wait">
            发消息的 Slack 账号还没有关联 witden 账号，所以没有交给角色。在下面把你自己的 Slack 账号关联到你的 witden
            账号，然后在 Slack 中再发一次；其他人可以在第 {num("access")} 步开启“允许未关联的人使用”。
          </div>
          <Identities key={events?.length} conn={conn} />
        </>
      ) : null}
      {socket ? <SocketFaq open={!!events && !events.length} /> : null}
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          完成
        </button>
      </div>
    </>
  );
}

import { type ReactNode, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { AuditEntry, Connection, ExternalConversation, OutboundMessage, SlackApp } from "../api/types";
import { useConfigChanged } from "../lib/configEvents";
import { CONVERSATION_KIND, fmtDateTime, fmtRelative, genericStatus, PLATFORM_LABEL } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useAuth, useDirectory } from "../lib/session";
import { useChanged, useLeaveGuard, useUnsavedChanges } from "../lib/unsaved";
import { useAction, useFeedback } from "../ui/feedback";
import {
  CopyText,
  Empty,
  Field,
  JsonBlock,
  KV,
  Loaded,
  PageHeader,
  Section,
  StatusChip,
  Tabs,
  Tag,
  Toggle,
} from "../ui/kit";
import { ResizeHandle } from "../ui/resize";
import {
  ConnectionSettingsFields,
  CREDENTIAL_FIELDS,
  FEISHU_FIELDS,
  GITHUB_AUTH_ONLY_FIELDS,
  GITHUB_FIELDS,
  Identities,
  INBOUND_STATUS,
  type InboundEvent,
  lastRejected,
  missingScopes,
  SLACK_FIELD_HELP,
  SLACK_FIELDS,
  settingsOf,
  socketText,
} from "./connectionParts";
import { FeishuSetup } from "./FeishuSetup";
import { FeishuScopeCheck } from "./feishuParts";
import { GithubSetup, MANIFEST_KEY, type ManifestReturn } from "./GithubSetup";
import { SlackAppDetail } from "./SlackApps";
import { SlackInstall } from "./SlackInstall";
import { SlackSetup } from "./SlackSetup";
import { WebhookSourcesPanel } from "./WebhookSourcesPanel";

type CapabilityMatrix = Record<string, Record<string, unknown>>;

const CAP_ROWS: [string, string][] = [
  ["status", "支持程度"],
  ["account_types", "账号类型"],
  ["conversations", "会话类型"],
  ["threads", "话题 / thread"],
  ["mentions", "@ 与选择 AI 员工"],
  ["files", "文件"],
  ["edits_deletes", "编辑与删除"],
  ["limits", "限制"],
];

const CAP_STATUS: Record<string, { label: string; tone: "ok" | "wait" | "off" }> = {
  supported: { label: "已支持", tone: "ok" },
  experimental: { label: "实验性", tone: "wait" },
  planned: { label: "计划中", tone: "off" },
};

// Every platform is set up with its step-by-step guide.
const PLATFORM_CHOICES: [string, string, string][] = [
  ["slack", "Slack", "在频道和私信中 @ 机器人。按步骤引导完成设置，默认不需要公网地址。"],
  [
    "github",
    "GitHub",
    "在 issue 和 pull request 中 @ 机器人，以 GitHub App 或机器人账号的身份回复。按步骤引导完成设置，App 一键创建；需要公网地址。",
  ],
  ["feishu", "飞书（实验性）", "在群聊和私聊中 @ 机器人。按步骤引导完成设置，默认使用长连接，不需要公网地址。"],
];

/** A new connection (``conn`` null) or the guide resumed for an existing one. */
interface Setup {
  platform: string | null;
  conn: Connection | null;
  /** Slack, Feishu: open the guide on this way of connecting (to switch an existing connection). */
  mode?: "socket" | "http";
  /** GitHub: the browser came back from creating the app. */
  manifest?: ManifestReturn;
  /** Slack: install this app in another workspace. */
  installApp?: SlackApp;
}

/** New Slack connections: a new Slack app, or an app witden has installed in another workspace. */
function SlackStart({
  setup,
  apps,
  onCreated,
  onClose,
}: {
  setup: Setup;
  apps: SlackApp[];
  onCreated: (c: Connection) => void;
  onClose: (c: Connection | null) => void;
}) {
  const [install, setInstall] = useState(!!setup.installApp);
  const choice =
    !setup.conn && apps.length ? (
      <div className="setup-modes">
        <div className="segmented">
          <button type="button" className={install ? "seg" : "seg seg-on"} onClick={() => setInstall(false)}>
            新建一个 Slack 应用
          </button>
          <button type="button" className={install ? "seg seg-on" : "seg"} onClick={() => setInstall(true)}>
            把已有的应用安装到另一个工作区
          </button>
        </div>
        <p className="small muted">
          {install
            ? "同一个应用可以装进多个工作区（例如不同的组织），不必为每个工作区各建一个应用。"
            : "在一个工作区中新建 Slack 应用。之后也可以把它安装到更多工作区。"}
        </p>
      </div>
    ) : null;
  return install ? (
    <SlackInstall
      apps={apps}
      app={setup.installApp ?? null}
      header={choice}
      onInstalled={onCreated}
      onClose={onClose}
    />
  ) : (
    <SlackSetup initial={setup.conn} initialMode={setup.mode} header={choice} onCreated={onCreated} onClose={onClose} />
  );
}

/**
 * GitHub sends the browser back here after creating an app from the guide's manifest
 * (``?github_app=<connection>&code=…&state=…``). The state must be the one this tab sent.
 */
function manifestReturn(params: URLSearchParams): { conn: string; manifest: ManifestReturn } | null {
  const conn = params.get("github_app");
  if (!conn) return null;
  let sent: { state?: string; conn?: string } = {};
  try {
    sent = JSON.parse(sessionStorage.getItem(MANIFEST_KEY) ?? "{}");
  } catch {
    // treated as not sent from this tab
  }
  sessionStorage.removeItem(MANIFEST_KEY);
  const code = params.get("code");
  if (!code) return { conn, manifest: { error: "GitHub 没有返回代码" } };
  if (sent.conn !== conn || !sent.state || sent.state !== params.get("state"))
    return { conn, manifest: { error: "这次跳转不是从这个页面发起的（校验码不一致），已忽略。请重新创建 App" } };
  return { conn, manifest: { code } };
}

export default function ConnectionsPage() {
  const res = useResource(() => api.get<Connection[]>("/api/connections"), []);
  const caps = useResource(() => api.get<CapabilityMatrix>("/api/integrations/capabilities"), []);
  const apps = useResource(() => api.get<SlackApp[]>("/api/slack-apps"), []);
  useConfigChanged(["connections"], () => Promise.all([res.reload(), apps.reload()]));
  const [selected, setSelected] = useState<string | null>(null);
  // A Slack app shown instead of a connection (app ids may equal a connection's: apps made before had theirs).
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [showCaps, setShowCaps] = useState(false);
  const [params, setParams] = useSearchParams();
  // Another item or a guide takes the open form (editing a connection or an app) away.
  const guard = useLeaveGuard();

  useEffect(() => {
    if (!selected && !selectedApp && res.data?.length) setSelected(res.data[0].id);
  }, [res.data, selected, selectedApp]);

  // Back from GitHub: resume that connection's guide with the code, and drop it from the address bar.
  useEffect(() => {
    // Read (and so use up) the state only once the connection it names can be shown.
    if (!res.data || !params.get("github_app")) return;
    const back = manifestReturn(params);
    if (!back) return;
    setParams({}, { replace: true });
    const conn = res.data.find((c) => c.id === back.conn);
    if (conn) setSetup({ platform: "github", conn, manifest: back.manifest });
  }, [params, res.data, setParams]);

  const current = selectedApp ? null : (res.data?.find((c) => c.id === selected) ?? null);
  const currentApp = selectedApp ? (apps.data?.find((a) => a.id === selectedApp) ?? null) : null;
  const reload = () => {
    void res.reload();
    void apps.reload();
  };
  const showConnection = (id: string) => {
    setSelectedApp(null);
    setSelected(id);
  };
  const openConnection = (id: string) => guard(() => showConnection(id));
  const openApp = (id: string) =>
    guard(() => {
      setSelected(null);
      setSelectedApp(id);
    });
  const startSetup = (s: Setup) => guard(() => setSetup(s));
  const closeSetup = (c: Connection | null) => {
    setSetup(null);
    if (c) showConnection(c.id);
    reload();
  };
  // Slack workspaces are listed under their app; other connections on their own.
  const listed = (rows: Connection[]) => {
    const appIds = new Set((apps.data ?? []).map((a) => a.id));
    return {
      others: rows.filter((c) => c.platform !== "slack" || !c.slack_app || !appIds.has(c.slack_app.id)),
      apps: (apps.data ?? []).map((a) => ({ app: a, workspaces: rows.filter((c) => c.slack_app?.id === a.id) })),
    };
  };
  const item = (c: Connection) => (
    <button
      type="button"
      className={`conn-item${c.id === selected && !selectedApp ? " conn-on" : ""}`}
      onClick={() => openConnection(c.id)}
    >
      <span className="conn-name">
        {c.name}
        <Tag>{c.slack_app ? "Slack 工作区" : (PLATFORM_LABEL[c.platform] ?? c.platform)}</Tag>
      </span>
      <StatusChip meta={genericStatus(c.status)} compact />
      {c.status_reason ? (
        <span className={`reason reason-${c.status === "error" ? "bad" : "info"}`}>{c.status_reason}</span>
      ) : null}
    </button>
  );

  return (
    <div className="page">
      <PageHeader
        title="通讯接入"
        sub="把 Slack、飞书、GitHub 的机器人接入进来。每个机器人代表一位 AI 员工：机器人所在频道和私信中的消息都会记录下来，@ 机器人的消息交给它代表的 AI 员工。"
        actions={
          <>
            <button type="button" className="btn btn-sm" onClick={() => setShowCaps((v) => !v)}>
              {showCaps ? "收起能力对照" : "各平台能力对照"}
            </button>
            {setup ? null : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => startSetup({ platform: null, conn: null })}
              >
                新建接入
              </button>
            )}
          </>
        }
      />
      <WebhookSourcesPanel />
      {showCaps ? (
        <Section title="各平台能力对照">
          <p className="small muted">
            平台不支持的消息类型或操作不会表现为已同步；下表列出每个平台实际同步的范围和替代行为。
          </p>
          <Loaded res={caps}>{(m) => <CapabilityTable matrix={m} />}</Loaded>
        </Section>
      ) : null}
      {setup?.platform === "slack" ? (
        <SlackStart
          setup={setup}
          apps={apps.data ?? []}
          onCreated={(c) => {
            showConnection(c.id);
            reload();
          }}
          onClose={closeSetup}
        />
      ) : setup?.platform === "github" ? (
        <GithubSetup
          initial={setup.conn}
          manifest={setup.manifest}
          onCreated={(c) => {
            setSelected(c.id);
            void res.reload();
          }}
          onClose={closeSetup}
        />
      ) : setup?.platform === "feishu" ? (
        <FeishuSetup
          initial={setup.conn}
          initialMode={setup.mode}
          onCreated={(c) => {
            setSelected(c.id);
            void res.reload();
          }}
          onClose={closeSetup}
        />
      ) : setup ? (
        <Section
          title="新建接入"
          actions={
            <button type="button" className="btn btn-sm" onClick={() => setSetup(null)}>
              取消
            </button>
          }
        >
          <p className="setup-intro">选择要接入的平台。</p>
          <PlatformPicker onPick={(platform) => setSetup({ platform, conn: null })} />
        </Section>
      ) : (
        <Loaded res={res}>
          {(rows) =>
            rows.length || apps.data?.length ? (
              <div className="split">
                <ResizeHandle name="connections" side="start" min={180} max={480} />
                <ul className="conn-list">
                  {listed(rows).apps.map(({ app, workspaces }) => (
                    <li key={`app:${app.id}`}>
                      <button
                        type="button"
                        className={`conn-item conn-app${app.id === selectedApp ? " conn-on" : ""}`}
                        onClick={() => openApp(app.id)}
                      >
                        <span className="conn-name">
                          {app.name}
                          <Tag>Slack 应用</Tag>
                        </span>
                        <span className="small muted">
                          {workspaces.length ? `${workspaces.length} 个工作区` : "还没有安装到工作区"}
                        </span>
                      </button>
                      {workspaces.length ? (
                        <ul className="conn-subs">
                          {workspaces.map((c) => (
                            <li key={c.id}>{item(c)}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                  {listed(rows).others.map((c) => (
                    <li key={c.id}>{item(c)}</li>
                  ))}
                </ul>
                {currentApp ? (
                  <SlackAppDetail
                    key={`app:${currentApp.id}`}
                    app={currentApp}
                    onChanged={(a) => {
                      apps.setData((prev) => prev?.map((x) => (x.id === a.id ? a : x)));
                      void res.reload();
                    }}
                    onDeleted={() => {
                      setSelectedApp(null);
                      reload();
                    }}
                    onInstall={() => startSetup({ platform: "slack", conn: null, installApp: currentApp })}
                    onOpenWorkspace={openConnection}
                  />
                ) : null}
                {current ? (
                  <ConnectionDetail
                    key={current.id}
                    conn={current}
                    onChanged={(c) => {
                      res.setData((prev) => prev?.map((x) => (x.id === c.id ? c : x)));
                      void apps.reload();
                    }}
                    onDeleted={() => {
                      setSelected(null);
                      reload();
                    }}
                    onGuide={(mode) => startSetup({ platform: current.platform, conn: current, mode })}
                    onOpenApp={openApp}
                  />
                ) : null}
              </div>
            ) : (
              <Section title="还没有接入任何通讯平台">
                <p className="setup-intro">
                  接入后，AI 员工以机器人的身份在这些平台上工作：大家在频道、私信、issue 中 @ 机器人，就能把工作交给
                  witden 中的 AI 员工。选择要接入的平台开始设置：
                </p>
                <PlatformPicker onPick={(platform) => setSetup({ platform, conn: null })} />
              </Section>
            )
          }
        </Loaded>
      )}
    </div>
  );
}

function PlatformPicker({ onPick }: { onPick: (platform: string) => void }) {
  return (
    <div className="platform-cards">
      {PLATFORM_CHOICES.map(([key, label, hint]) => (
        <button type="button" key={key} className="platform-card" onClick={() => onPick(key)}>
          <span className="platform-name">{label}</span>
          <span className="small muted">{hint}</span>
        </button>
      ))}
    </div>
  );
}

function CapabilityTable({ matrix }: { matrix: CapabilityMatrix }) {
  const platforms = Object.keys(matrix);
  const cell = (v: unknown, key: string) => {
    if (key === "status" && typeof v === "string") {
      const s = CAP_STATUS[v];
      return s ? <Tag tone={s.tone}>{s.label}</Tag> : v;
    }
    if (Array.isArray(v))
      return v.length ? (
        <ul className="plain-list">
          {v.map((x, i) => (
            <li key={i}>{String(x)}</li>
          ))}
        </ul>
      ) : (
        <span className="muted">—</span>
      );
    if (v === undefined || v === null || v === "") return <span className="muted">—</span>;
    if (typeof v === "object") return <JsonBlock value={v} />;
    return String(v);
  };
  const extraKeys = Array.from(new Set(platforms.flatMap((p) => Object.keys(matrix[p] ?? {})))).filter(
    (k) => !CAP_ROWS.some(([r]) => r === k),
  );
  return (
    <div className="table-wrap">
      <table className="table cap-table">
        <thead>
          <tr>
            <th />
            {platforms.map((p) => (
              <th key={p}>{PLATFORM_LABEL[p] ?? p}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...CAP_ROWS, ...extraKeys.map((k) => [k, k] as [string, string])].map(([key, label]) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              {platforms.map((p) => (
                <td key={p}>{cell(matrix[p]?.[key], key)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConnectionDetail({
  conn,
  onChanged,
  onDeleted,
  onGuide,
  onOpenApp,
}: {
  conn: Connection;
  onChanged: (c: Connection) => void;
  onDeleted: () => void;
  /** Open the step-by-step setup, optionally (Slack) on the other way of connecting. */
  onGuide: (mode?: "socket" | "http") => void;
  /** Slack: show the app this workspace is installed in. */
  onOpenApp: (appId: string) => void;
}) {
  const { can } = useAuth();
  const dir = useDirectory();
  const { confirm, toast } = useFeedback();
  const { run, busy } = useAction();
  const [tab, setTab] = useState("conversations");
  const [editing, setEditing] = useState(false);
  const rejected = lastRejected(conn);
  // A GitHub account that only authenticates the GitHub tools: no bot, no events, no role.
  const authOnly = conn.platform === "github" && !!conn.settings?.auth_only;

  if (editing)
    return (
      <div className="conn-detail">
        <Section title={`编辑 ${conn.name}`}>
          <ConnectionForm
            conn={conn}
            platform={conn.platform}
            onCancel={() => setEditing(false)}
            onSaved={(c) => {
              setEditing(false);
              onChanged(c);
            }}
          />
        </Section>
      </div>
    );

  return (
    <div className="conn-detail">
      <Section
        title={
          <span>
            {conn.name} <Tag>{PLATFORM_LABEL[conn.platform] ?? conn.platform}</Tag>
          </span>
        }
        actions={
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={() => onGuide()}>
              设置引导
            </button>
            {conn.slack_app ? (
              <button type="button" className="btn btn-sm" onClick={() => onOpenApp(conn.slack_app!.id)}>
                查看应用
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                const out = await run(() =>
                  api.post<{ ok: boolean; error?: string; missing_scopes?: string[] }>(
                    `/api/connections/${conn.id}/test`,
                  ),
                );
                if (!out) return;
                const lacking = out.ok ? missingScopes(out.missing_scopes) : null;
                if (lacking) toast(`连接正常，但${lacking}`, "bad");
                else if (out.ok) toast("连接正常", "ok");
                else toast(`连接失败：${out.error ?? "未知错误"}`, "bad");
                const fresh = await api.get<Connection[]>("/api/connections");
                const next = fresh.find((c) => c.id === conn.id);
                if (next) onChanged(next);
              }}
            >
              测试连接
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                const next = conn.status === "paused" ? "active" : "paused";
                if (next === "paused") {
                  const ok = await confirm({
                    title: `暂停 ${conn.name}`,
                    body: <p>暂停后不再处理来自这个接入的消息，也不会向它发送消息。</p>,
                    confirmLabel: "暂停",
                    danger: true,
                  });
                  if (!ok) return;
                }
                const out = await run(
                  () => api.patch<Connection>(`/api/connections/${conn.id}`, { status: next }),
                  next === "paused" ? "已暂停" : "已恢复",
                );
                if (out) onChanged(out);
              }}
            >
              {conn.status === "paused" ? "恢复" : "暂停"}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
              编辑
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger-ghost"
              disabled={busy}
              onClick={async () => {
                const ok = await confirm({
                  title: `删除接入 ${conn.name}`,
                  body: <p>删除后会移除它的会话、身份映射和投递记录。已同步到内部话题的消息保留。</p>,
                  confirmLabel: "删除",
                  danger: true,
                });
                if (!ok) return;
                const out = await run(() => api.del(`/api/connections/${conn.id}`), "接入已删除");
                if (out) onDeleted();
              }}
            >
              删除
            </button>
          </div>
        }
      >
        <div className={`status-banner${conn.status === "error" ? " status-banner-bad" : ""}`}>
          <StatusChip meta={genericStatus(conn.status)} compact />
          <div className="status-banner-text">
            {conn.status_reason ??
              (conn.status === "active"
                ? authOnly
                  ? "只作为认证：不接收消息，供获得授权的 AI 员工使用 GitHub 工具"
                  : "正在接收和发送消息"
                : "")}
          </div>
        </div>
        {!conn.bot_user_id ? (
          <div className="callout callout-wait">
            这个接入还没有完成设置：{conn.has_credentials ? "凭据还没有通过测试" : "还没有凭据"}。{" "}
            <button type="button" className="btn btn-xs" onClick={() => onGuide()}>
              继续设置
            </button>
          </div>
        ) : null}
        {authOnly ? (
          <div className="callout">
            这个账号不当机器人使用：witden 不接收它的消息，也不需要 Webhook。要让 AI 员工用它在 GitHub
            中做事（读代码、提 issue、开 pull request 等），在“AI 员工管理 → 编辑 → 权限”的 GitHub 部分为 AI
            员工勾选这个接入的读取或写入，并选择写入是否需要询问。Token 不交给 AI 员工或电脑。
          </div>
        ) : conn.settings?.role_id ? null : (
          <div className="callout callout-bad" role="alert">
            这个机器人还没有选择代表的 AI 员工，发给它的请求都会被拒绝。{" "}
            <button type="button" className="btn btn-xs" onClick={() => setEditing(true)}>
              选择 AI 员工
            </button>
          </div>
        )}
        {conn.platform === "slack" && conn.slack_mode === "http" ? (
          <div className="callout">
            这个工作区所属的应用使用事件地址，需要公网地址。改用 Socket Mode 后，witden 主动连到
            Slack，不需要公网地址，应用的所有工作区都随之改用；设置引导会说明如何让 Slack 应用打开 Socket Mode。{" "}
            <button type="button" className="btn btn-xs" onClick={() => onGuide("socket")}>
              改用 Socket Mode
            </button>
          </div>
        ) : null}
        {conn.platform === "feishu" && conn.feishu_mode === "http" ? (
          <div className="callout">
            这个接入使用事件地址，需要公网地址。改用长连接后，witden
            主动连到飞书，不需要公网地址；设置引导会说明如何在飞书开发者后台修改订阅方式。{" "}
            <button type="button" className="btn btn-xs" onClick={() => onGuide("socket")}>
              改用长连接
            </button>
          </div>
        ) : null}
        {rejected ? (
          <div className="callout callout-bad" role="alert">
            {fmtRelative(rejected.at)}，witden 收到了 {PLATFORM_LABEL[conn.platform] ?? conn.platform}{" "}
            发来的请求，但校验没有通过：
            {rejected.reason}。请检查接入的密钥（Slack 的 Signing Secret、GitHub 的 Webhook Secret、飞书的 Verification
            Token）是否与平台后台一致，可以点击“编辑”重新填写。
          </div>
        ) : null}
        <KV
          items={
            authOnly
              ? [
                  ["凭据", conn.has_credentials ? "已设置（不可查看）" : <span className="text-bad">未设置</span>],
                  ["接入方式", "账号 Token，只作为认证（不当机器人使用）"],
                  [
                    "GitHub 账号",
                    conn.bot_user_id ? (
                      <code className="id">{conn.bot_user_id}</code>
                    ) : (
                      <span className="muted">首次测试后获取</span>
                    ),
                  ],
                ]
              : [
                  ["凭据", conn.has_credentials ? "已设置（不可查看）" : <span className="text-bad">未设置</span>],
                  [
                    "机器人代表的 AI 员工",
                    typeof conn.settings?.role_id === "string" && conn.settings.role_id ? (
                      dir.roleLabel(conn.settings.role_id)
                    ) : (
                      <span className="text-bad">未选择</span>
                    ),
                  ],
                  ...(conn.platform === "slack"
                    ? [
                        [
                          "接入方式",
                          conn.slack_mode === "socket" ? "Socket Mode（不需要公网地址）" : "事件地址（HTTP）",
                        ] as [string, ReactNode],
                        [
                          "所属的 Slack 应用",
                          conn.slack_app ? (
                            <button type="button" className="btn btn-xs" onClick={() => onOpenApp(conn.slack_app!.id)}>
                              {conn.slack_app.name}
                            </button>
                          ) : (
                            <span className="text-bad">没有</span>
                          ),
                        ] as [string, ReactNode],
                      ]
                    : []),
                  ...(conn.platform === "feishu"
                    ? [
                        [
                          "接入方式",
                          conn.feishu_mode === "socket" ? "长连接（不需要公网地址）" : "事件地址（HTTP）",
                        ] as [string, ReactNode],
                        [
                          "其他机器人的消息",
                          conn.settings?.bot_requests
                            ? `@ 这个机器人时交给 AI 员工（连续 ${conn.bot_request_limit ?? 8} 次机器人请求后，等有人发言再继续）`
                            : "只作为上下文，不交给 AI 员工",
                        ] as [string, ReactNode],
                      ]
                    : []),
                  (conn.slack_mode ?? conn.feishu_mode) === "socket"
                    ? [
                        conn.platform === "slack" ? "与 Slack 的连接" : "与飞书的连接",
                        <Tag key="socket" tone={socketText(conn.socket, conn.platform).tone}>
                          {socketText(conn.socket, conn.platform).text}
                        </Tag>,
                      ]
                    : ["事件地址", conn.events_url ? <CopyText text={conn.events_url} /> : null],
                  [
                    "外部工作空间",
                    conn.external_workspace_id ? (
                      <code className="id">{conn.external_workspace_id}</code>
                    ) : (
                      <span className="muted">首次测试后获取</span>
                    ),
                  ],
                  [
                    "机器人账号",
                    conn.bot_user_id ? (
                      <code className="id">{conn.bot_user_id}</code>
                    ) : (
                      <span className="muted">首次测试后获取</span>
                    ),
                  ],
                  ...(conn.platform === "github"
                    ? [
                        [
                          "接入方式",
                          conn.github_auth === "app"
                            ? "GitHub App"
                            : conn.github_auth === "token"
                              ? "机器人账号 Token"
                              : "还没有设置（在设置引导中创建 App）",
                        ] as [string, string],
                      ]
                    : []),
                  [
                    "外部成员",
                    conn.settings?.auto_provision_users
                      ? "开启：未关联的人自动成为外部成员，可以使用机器人代表的 AI 员工"
                      : "关闭：未关联的人不能使用，需要管理员关联身份",
                  ],
                ]
          }
        />
        <p className="small muted">
          {PLATFORM_LABEL[conn.platform] ?? conn.platform}
          {authOnly
            ? " Token 的创建和所需权限见“设置引导”。"
            : conn.platform === "github"
              ? " App 的安装、Webhook 和试用步骤见“设置引导”。"
              : conn.platform === "slack"
                ? " 应用的事件订阅、权限和试用步骤见“设置引导”。"
                : "应用的权限、事件订阅、版本发布和试用步骤见“设置引导”。"}
        </p>
      </Section>
      {conn.platform === "feishu" ? (
        <Section title="飞书应用的权限">
          <p className="small muted">
            向飞书查询这个应用现在开通了哪些权限。基础权限决定能否收发消息、显示名字；扩展决定 AI
            员工能用哪些飞书工具（在 AI 员工的权限中按应用设置）。
          </p>
          <FeishuScopeCheck conn={conn} />
        </Section>
      ) : null}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "conversations", label: "会话" },
          { key: "identities", label: "身份关联", hidden: !can("user.manage") },
          { key: "outbound", label: "投递记录" },
          { key: "inbound", label: "收到的事件" },
          { key: "diagnostics", label: "诊断记录" },
        ]}
      />
      {tab === "conversations" ? <Conversations conn={conn} /> : null}
      {tab === "identities" ? <Identities conn={conn} /> : null}
      {tab === "outbound" ? <Outbound conn={conn} /> : null}
      {tab === "inbound" ? <Inbound conn={conn} /> : null}
      {tab === "diagnostics" ? <Diagnostics conn={conn} /> : null}
    </div>
  );
}

function Diagnostics({ conn }: { conn: Connection }) {
  const res = useResource(() => api.get<AuditEntry[]>(`/api/connections/${conn.id}/diagnostics`), [conn.id]);
  const stages: Record<string, string> = {
    download: "接收附件",
    upload: "上传附件",
    send: "发送附件",
    format: "消息格式回退",
  };
  return (
    <>
      <div className="toolbar">
        <span className="small muted">
          最近 200 条诊断，仅在控制台显示，不发送到外部聊天。消息整体发送失败请查看“投递记录”。
        </span>
        <button type="button" className="btn btn-xs" onClick={() => void res.reload()}>
          刷新
        </button>
      </div>
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>环节</th>
                    <th>原因与处理方法</th>
                    <th>话题</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => {
                    const detail = typeof entry.detail === "string" ? {} : entry.detail;
                    return (
                      <tr key={entry.id}>
                        <td className="nowrap">{fmtDateTime(entry.created_at)}</td>
                        <td>
                          {stages[String(detail.stage)] ?? String(detail.stage ?? "")}
                          <div className="small muted">{String(detail.file_name ?? "")}</div>
                        </td>
                        <td className="small">
                          <div>{String(detail.error ?? "")}</div>
                          {typeof detail.hint === "string" ? <p>{detail.hint}</p> : null}
                        </td>
                        <td>{entry.topic_id ? <a href={`/topics/${entry.topic_id}`}>查看话题</a> : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="暂无诊断记录" hint="附件收发失败和消息格式回退会在这里记录。" />
          )
        }
      </Loaded>
    </>
  );
}

function Conversations({ conn }: { conn: Connection }) {
  const res = useResource(
    () => api.get<(ExternalConversation & { threads?: number })[]>(`/api/connections/${conn.id}/conversations`),
    [conn.id],
  );
  return (
    <Loaded res={res}>
      {(rows) =>
        rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>会话</th>
                  <th>类型</th>
                  <th>关联话题</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="strong">{c.name ?? c.external_id}</div>
                      <div className="small muted">
                        <code className="id">{c.external_id}</code> · 内部 ID <code className="id">{c.id}</code>
                      </div>
                    </td>
                    <td>{CONVERSATION_KIND[c.kind] ?? c.kind}</td>
                    <td>{c.threads ?? 0} 个</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="还没有会话" hint="机器人被邀请进频道或收到私信后，会话会出现在这里。" />
        )
      }
    </Loaded>
  );
}

function Outbound({ conn }: { conn: Connection }) {
  const { run } = useAction();
  const [status, setStatus] = useState("failed");
  const res = useResource(
    () => api.get<OutboundMessage[]>(`/api/connections/${conn.id}/outbound`, { status: status || undefined }),
    [conn.id, status],
  );
  return (
    <>
      <div className="toolbar">
        <div className="segmented">
          {[
            ["failed", "失败"],
            ["blocked", "已拦截"],
            ["pending", "待发送"],
            ["sent", "已送达"],
            ["", "全部"],
          ].map(([k, v]) => (
            <button type="button" key={k} className={k === status ? "seg seg-on" : "seg"} onClick={() => setStatus(k)}>
              {v}
            </button>
          ))}
        </div>
        <span className="small muted">重试使用同一个幂等键，不会重复发送已送达的消息，也不会重复执行任务。</span>
      </div>
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>目标</th>
                    <th>状态</th>
                    <th>错误</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.id}>
                      <td className="nowrap" title={fmtDateTime(o.created_at)}>
                        {fmtRelative(o.created_at)}
                      </td>
                      <td>
                        <code className="id">{o.conversation_external_id}</code>
                        {o.thread_key ? <div className="small muted">thread {o.thread_key}</div> : null}
                      </td>
                      <td>
                        <StatusChip meta={genericStatus(o.status)} compact />
                        <div className="small muted">尝试 {o.attempts} 次</div>
                      </td>
                      <td className="small">{o.last_error ?? <span className="muted">—</span>}</td>
                      <td>
                        {o.status === "failed" || o.status === "blocked" ? (
                          <button
                            type="button"
                            className="btn btn-xs"
                            onClick={async () => {
                              const out = await run(
                                () => api.post<OutboundMessage>(`/api/outbound/${o.id}/retry`),
                                "已重新排队发送",
                              );
                              if (out) res.setData((prev) => prev?.map((x) => (x.id === o.id ? out : x)));
                            }}
                          >
                            重试
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={status === "failed" ? "没有失败的投递" : "没有记录"} />
          )
        }
      </Loaded>
    </>
  );
}

function Inbound({ conn }: { conn: Connection }) {
  const res = useResource(() => api.get<InboundEvent[]>(`/api/connections/${conn.id}/inbound`), [conn.id]);
  return (
    <Loaded res={res}>
      {(rows) =>
        rows.length ? (
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>事件</th>
                  <th>处理结果</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap" title={fmtDateTime(e.received_at)}>
                      {fmtRelative(e.received_at)}
                    </td>
                    <td>
                      <code className="id">{e.event_key}</code>
                    </td>
                    <td>
                      <Tag tone={INBOUND_STATUS[e.status]?.[1] ?? "info"}>
                        {INBOUND_STATUS[e.status]?.[0] ?? e.status}
                      </Tag>
                      {e.detail ? <div className="small muted">{e.detail}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="还没有收到事件" hint="平台推送的事件会被去重后记录在这里，便于排查“机器人为什么没反应”。" />
        )
      }
    </Loaded>
  );
}

/** Create (``conn`` null) or edit a connection, shown in the page. */
function ConnectionForm({
  conn,
  platform,
  onCancel,
  onSaved,
}: {
  conn: Connection | null;
  platform: string;
  onCancel: () => void;
  onSaved: (c: Connection) => void;
}) {
  const { run, busy } = useAction();
  const [name, setName] = useState(conn?.name ?? "");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState(settingsOf(conn));
  const [githubAuth, setGithubAuth] = useState<"app" | "token">(conn?.github_auth ?? "app");
  const [slackMode, setSlackMode] = useState<"socket" | "http">(conn?.slack_mode ?? "socket");
  const [feishuMode, setFeishuMode] = useState<"socket" | "http">(conn?.feishu_mode ?? "socket");
  // A Slack workspace's own credential is its bot token; the app's keys are edited on the app.
  const workspace = platform === "slack" && !!conn;
  // GitHub: an account that only authenticates the GitHub tools is no bot (no webhook, no role).
  const authOnly = platform === "github" && githubAuth === "token" && !!settings.auth_only;
  const fields: [string, string][] = workspace
    ? [["bot_token", "Bot User OAuth Token"]]
    : platform === "github"
      ? authOnly
        ? GITHUB_AUTH_ONLY_FIELDS
        : GITHUB_FIELDS[githubAuth]
      : platform === "slack"
        ? SLACK_FIELDS[slackMode]
        : platform === "feishu"
          ? FEISHU_FIELDS[feishuMode]
          : (CREDENTIAL_FIELDS[platform] ?? []);
  // Switching an existing connection to the other way needs that way's keys; the key both ways share stays.
  const switching =
    !!conn &&
    ((platform === "github" && (conn.github_auth ?? "token") !== githubAuth) ||
      (platform === "slack" && (conn.slack_mode ?? "http") !== slackMode) ||
      (platform === "feishu" && (conn.feishu_mode ?? "http") !== feishuMode));
  const shared =
    platform === "github" ? ["webhook_secret"] : platform === "feishu" ? ["app_id", "app_secret"] : ["bot_token"];
  // An account that only authenticated has no webhook secret yet: becoming a bot needs one.
  const becomingBot = !!conn?.settings?.auth_only && !authOnly;
  // New connections need every field; an existing one keeps what is left empty.
  const required = fields.filter(
    ([k]) => !conn || (switching && !shared.includes(k)) || (becomingBot && k === "webhook_secret"),
  );
  const missing = required.some(([k]) => !creds[k]?.trim());
  const disabled = busy || !name.trim() || missing || (!authOnly && !settings.role_id);
  const [changed] = useChanged({ name, creds, settings, githubAuth, slackMode, feishuMode });

  const submit = async (): Promise<boolean> => {
    if (disabled) return false;
    const filled = Object.fromEntries(Object.entries(creds).filter(([, v]) => v.trim()));
    // Feishu: the way is a setting; switching to the long connection drops the verification token.
    const saved =
      platform === "feishu"
        ? { ...settings, feishu_mode: feishuMode }
        : platform === "github"
          ? { ...settings, auth_only: authOnly }
          : settings;
    const out = await run(
      () =>
        conn
          ? api.patch<Connection>(`/api/connections/${conn.id}`, {
              name: name.trim(),
              settings: saved,
              ...(Object.keys(filled).length ? { credentials: filled } : {}),
            })
          : api.post<Connection>("/api/connections", {
              platform,
              name: name.trim(),
              credentials: filled,
              settings: saved,
            }),
      conn ? "已保存" : "接入已创建，请把事件地址配置到平台后台，然后测试连接",
    );
    if (out) onSaved(out);
    return !!out;
  };
  useUnsavedChanges(changed, submit);

  return (
    <form
      className="form form-narrow"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="名称" hint="在 witden 中区分不同的接入。">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`例如：公司 ${PLATFORM_LABEL[platform] ?? platform}`}
        />
      </Field>
      {platform === "github" ? (
        <Field
          label="接入方式"
          hint={
            githubAuth === "app"
              ? "以 GitHub App 身份工作：回复显示为 <应用名>[bot]，按安装授权到仓库，令牌自动续期。"
              : "以一个 GitHub 账号（建议单独的机器账号）的身份工作，使用它的 Token。"
          }
        >
          <select value={githubAuth} onChange={(e) => (setGithubAuth(e.target.value as "app" | "token"), setCreds({}))}>
            <option value="app">GitHub App（推荐）</option>
            <option value="token">机器人账号 Token</option>
          </select>
        </Field>
      ) : null}
      {platform === "github" && githubAuth === "token" ? (
        <Toggle
          checked={authOnly}
          onChange={(v) => setSettings({ ...settings, auth_only: v })}
          label="只作为认证（不当机器人使用）"
          hint="开启后不接收 GitHub 的消息，也不需要 Webhook；这个账号只给获得授权的 AI 员工使用 GitHub 工具（在 AI 员工的权限中按接入设置），例如代替本人提 issue、开 pull request。Token 不交给 AI 员工或电脑。"
        />
      ) : null}
      {workspace ? (
        <p className="small muted">
          这里只填这个工作区的机器人令牌。应用的令牌、接入方式和 OAuth 凭据在应用「{conn?.slack_app?.name ?? "?"}
          」中修改。
        </p>
      ) : null}
      {platform === "slack" && !workspace ? (
        <Field
          label="接入方式"
          hint={
            slackMode === "socket"
              ? "witden 主动连到 Slack 接收消息，不需要公网地址。"
              : "Slack 把消息推送到 witden 的公网事件地址，需要 Signing Secret。"
          }
        >
          <select value={slackMode} onChange={(e) => (setSlackMode(e.target.value as "socket" | "http"), setCreds({}))}>
            <option value="socket">Socket Mode（推荐）</option>
            <option value="http">事件地址（HTTP）</option>
          </select>
        </Field>
      ) : null}
      {platform === "feishu" ? (
        <Field
          label="接入方式"
          hint={
            feishuMode === "socket"
              ? "witden 主动连到飞书接收消息，不需要公网地址。保存后还要在飞书开发者后台把订阅方式改为“使用长连接接收事件”。"
              : "飞书把消息推送到 witden 的公网事件地址，需要 Verification Token。"
          }
        >
          <select
            value={feishuMode}
            onChange={(e) => (setFeishuMode(e.target.value as "socket" | "http"), setCreds({}))}
          >
            <option value="socket">长连接（推荐）</option>
            <option value="http">事件地址（HTTP）</option>
          </select>
        </Field>
      ) : null}
      {fields.map(([k, label]) => (
        <Field
          key={k}
          label={label}
          description={platform === "slack" ? SLACK_FIELD_HELP[k] : undefined}
          hint={
            conn && (!switching || shared.includes(k)) && !(becomingBot && k === "webhook_secret")
              ? "留空保持不变"
              : undefined
          }
        >
          {k === "private_key" ? (
            <textarea
              rows={4}
              className="mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
              value={creds[k] ?? ""}
              onChange={(e) => setCreds({ ...creds, [k]: e.target.value })}
            />
          ) : (
            <input
              type="password"
              autoComplete="off"
              className="mono"
              value={creds[k] ?? ""}
              onChange={(e) => setCreds({ ...creds, [k]: e.target.value })}
            />
          )}
        </Field>
      ))}
      {authOnly ? null : (
        <ConnectionSettingsFields
          platform={platform}
          value={settings}
          onChange={setSettings}
          botLimit={conn?.bot_request_limit}
        />
      )}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={disabled}>
          {busy ? "处理中…" : conn ? "保存" : "创建接入"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        {authOnly || settings.role_id ? null : (
          <span className="small muted">选择机器人代表的 AI 员工后才能保存。</span>
        )}
      </div>
    </form>
  );
}

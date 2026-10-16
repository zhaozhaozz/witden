import { type ReactNode, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { Connection, ExternalConversation, OutboundMessage } from "../api/types";
import { CONVERSATION_KIND, fmtDateTime, fmtRelative, genericStatus, PLATFORM_LABEL } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useAuth, useDirectory } from "../lib/session";
import { useAction, useFeedback } from "../ui/feedback";
import { CopyText, Empty, Field, JsonBlock, KV, Loaded, PageHeader, Section, StatusChip, Tabs, Tag } from "../ui/kit";
import { ResizeHandle } from "../ui/resize";
import {
  ConnectionSettingsFields,
  CREDENTIAL_FIELDS,
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
import { GithubSetup, MANIFEST_KEY, type ManifestReturn } from "./GithubSetup";
import { SlackInstall } from "./SlackInstall";
import { SlackSetup } from "./SlackSetup";

type CapabilityMatrix = Record<string, Record<string, unknown>>;

const CAP_ROWS: [string, string][] = [
  ["status", "支持程度"],
  ["account_types", "账号类型"],
  ["conversations", "会话类型"],
  ["threads", "话题 / thread"],
  ["mentions", "@ 与选择角色"],
  ["files", "文件"],
  ["role_identity", "角色身份显示"],
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
  ["feishu", "飞书（实验性）", "在群聊和私聊中 @ 机器人。按步骤引导完成设置，需要公网地址。"],
];

/** A new connection (``conn`` null) or the guide resumed for an existing one. */
interface Setup {
  platform: string | null;
  conn: Connection | null;
  /** Slack: open the guide on this way of connecting (to switch an existing connection). */
  mode?: "socket" | "http";
  /** GitHub: the browser came back from creating the app. */
  manifest?: ManifestReturn;
  /** Slack: install the app this connection holds in another workspace. */
  installApp?: Connection;
}

/**
 * New Slack connections: a new Slack app, or an app witden already has installed in another workspace. A
 * workspace installed that way resumes the installation guide.
 */
function SlackStart({
  setup,
  rows,
  onCreated,
  onClose,
}: {
  setup: Setup;
  rows: Connection[];
  onCreated: (c: Connection) => void;
  onClose: (c: Connection | null) => void;
}) {
  // Connections holding a Slack app (not ones installed through another).
  const apps = rows.filter((c) => c.platform === "slack" && !c.install_of && c.has_credentials);
  const [install, setInstall] = useState(!!setup.installApp || !!setup.conn?.install_of);
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
      installed={setup.conn?.install_of ? setup.conn : null}
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
  const [selected, setSelected] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [showCaps, setShowCaps] = useState(false);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    if (!selected && res.data?.length) setSelected(res.data[0].id);
  }, [res.data, selected]);

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

  const current = res.data?.find((c) => c.id === selected) ?? null;
  const closeSetup = (c: Connection | null) => {
    setSetup(null);
    if (c) setSelected(c.id);
    void res.reload();
  };

  return (
    <div className="page">
      <PageHeader
        title="通讯接入"
        sub="把 Slack、飞书、GitHub 的机器人接入进来。每个机器人代表一个角色：机器人所在频道和私信中的消息都会记录下来，@ 机器人的消息交给它代表的角色。"
        actions={
          <>
            <button type="button" className="btn btn-sm" onClick={() => setShowCaps((v) => !v)}>
              {showCaps ? "收起能力对照" : "各平台能力对照"}
            </button>
            {setup ? null : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setSetup({ platform: null, conn: null })}
              >
                新建接入
              </button>
            )}
          </>
        }
      />
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
          rows={res.data ?? []}
          onCreated={(c) => {
            setSelected(c.id);
            void res.reload();
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
            rows.length ? (
              <div className="split">
                <ResizeHandle name="connections" side="start" min={180} max={480} />
                <ul className="conn-list">
                  {rows.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`conn-item${c.id === selected ? " conn-on" : ""}`}
                        onClick={() => setSelected(c.id)}
                      >
                        <span className="conn-name">
                          {c.name}
                          <Tag>{PLATFORM_LABEL[c.platform] ?? c.platform}</Tag>
                        </span>
                        <StatusChip meta={genericStatus(c.status)} compact />
                        {c.status_reason ? (
                          <span className={`reason reason-${c.status === "error" ? "bad" : "info"}`}>
                            {c.status_reason}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
                {current ? (
                  <ConnectionDetail
                    key={current.id}
                    conn={current}
                    onChanged={(c) => res.setData((prev) => prev?.map((x) => (x.id === c.id ? c : x)))}
                    onDeleted={() => {
                      setSelected(null);
                      void res.reload();
                    }}
                    onGuide={(mode) => setSetup({ platform: current.platform, conn: current, mode })}
                    onInstall={() => setSetup({ platform: "slack", conn: null, installApp: current })}
                  />
                ) : null}
              </div>
            ) : (
              <Section title="还没有接入任何通讯平台">
                <p className="setup-intro">
                  接入后，角色以机器人的身份在这些平台上工作：大家在频道、私信、issue 中 @ 机器人，就能把工作交给 witden
                  中的角色。选择要接入的平台开始设置：
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
  onInstall,
}: {
  conn: Connection;
  onChanged: (c: Connection) => void;
  onDeleted: () => void;
  /** Open the step-by-step setup, optionally (Slack) on the other way of connecting. */
  onGuide: (mode?: "socket" | "http") => void;
  /** Slack: install this connection's app in another workspace. */
  onInstall: () => void;
}) {
  const { can } = useAuth();
  const dir = useDirectory();
  const { confirm, toast } = useFeedback();
  const { run, busy } = useAction();
  const [tab, setTab] = useState("conversations");
  const [editing, setEditing] = useState(false);
  const rejected = lastRejected(conn);

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
            {conn.platform === "slack" && !conn.install_of && conn.has_credentials ? (
              <button type="button" className="btn btn-sm" onClick={onInstall}>
                安装到其他工作区
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
            {conn.status_reason ?? (conn.status === "active" ? "正在接收和发送消息" : "")}
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
        {conn.settings?.role_id ? null : (
          <div className="callout callout-bad" role="alert">
            这个机器人还没有选择代表的角色，发给它的请求都会被拒绝。{" "}
            <button type="button" className="btn btn-xs" onClick={() => setEditing(true)}>
              选择角色
            </button>
          </div>
        )}
        {conn.install_of ? (
          <div className="callout">
            这个工作区是通过应用「{conn.app_connection?.name ?? "?"}
            」安装的：它只保存自己的机器人令牌，接收消息用的是那个应用的
            {conn.slack_mode === "socket" ? "连接（Socket Mode）" : "事件地址"}
            。应用的令牌、接入方式等在那个接入中修改；需要更换这里的令牌时，重新安装一次即可。
          </div>
        ) : null}
        {conn.platform === "slack" && conn.slack_mode === "http" && !conn.install_of ? (
          <div className="callout">
            这个接入使用事件地址，需要公网地址。改用 Socket Mode 后，witden 主动连到
            Slack，不需要公网地址；设置引导会说明如何让原来的 Slack 应用打开 Socket Mode。{" "}
            <button type="button" className="btn btn-xs" onClick={() => onGuide("socket")}>
              改用 Socket Mode
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
          items={[
            ["凭据", conn.has_credentials ? "已设置（不可查看）" : <span className="text-bad">未设置</span>],
            [
              "机器人代表的角色",
              typeof conn.settings?.role_id === "string" && conn.settings.role_id ? (
                dir.roleLabel(conn.settings.role_id)
              ) : (
                <span className="text-bad">未选择</span>
              ),
            ],
            ...(conn.platform === "slack"
              ? [
                  ["接入方式", conn.slack_mode === "socket" ? "Socket Mode（不需要公网地址）" : "事件地址（HTTP）"] as [
                    string,
                    ReactNode,
                  ],
                  conn.install_of
                    ? (["所属的应用", conn.app_connection?.name ?? "?"] as [string, ReactNode])
                    : ([
                        "安装到的其他工作区",
                        conn.installs?.length ? (
                          conn.installs.map((i) => i.name).join("、")
                        ) : (
                          <span className="muted">没有（可以点击“安装到其他工作区”）</span>
                        ),
                      ] as [string, ReactNode]),
                ]
              : []),
            conn.slack_mode === "socket"
              ? [
                  "与 Slack 的连接",
                  <Tag key="socket" tone={socketText(conn.socket).tone}>
                    {socketText(conn.socket).text}
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
                ? "开启：未关联的人自动成为外部成员，可以使用机器人代表的角色"
                : "关闭：未关联的人不能使用，需要管理员关联身份",
            ],
            [
              "角色身份显示",
              `机器人就是它代表的角色，回复不另加名称；被请来协作的其他角色${
                conn.platform === "github"
                  ? "在评论开头写角色名称"
                  : conn.platform === "slack" && conn.settings?.custom_identity
                    ? "以自己的名称和头像发言"
                    : "在消息前写角色名称"
              }`,
            ],
          ]}
        />
        <p className="small muted">
          {PLATFORM_LABEL[conn.platform] ?? conn.platform}
          {conn.platform === "github"
            ? " App 的安装、Webhook 和试用步骤见“设置引导”。"
            : conn.platform === "slack"
              ? " 应用的事件订阅、权限和试用步骤见“设置引导”。"
              : "应用的权限、事件订阅、版本发布和试用步骤见“设置引导”。"}
        </p>
      </Section>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "conversations", label: "会话" },
          { key: "identities", label: "身份关联", hidden: !can("user.manage") },
          { key: "outbound", label: "投递记录" },
          { key: "inbound", label: "收到的事件" },
        ]}
      />
      {tab === "conversations" ? <Conversations conn={conn} /> : null}
      {tab === "identities" ? <Identities conn={conn} /> : null}
      {tab === "outbound" ? <Outbound conn={conn} /> : null}
      {tab === "inbound" ? <Inbound conn={conn} /> : null}
    </div>
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
  // A Slack workspace installed through an app gets its token by installing; the rest is the app's.
  const installed = !!conn?.install_of;
  const fields = installed
    ? []
    : platform === "github"
      ? GITHUB_FIELDS[githubAuth]
      : platform === "slack"
        ? SLACK_FIELDS[slackMode]
        : (CREDENTIAL_FIELDS[platform] ?? []);
  // Switching an existing connection to the other way needs that way's keys; the key both ways share stays.
  const switching =
    !!conn &&
    ((platform === "github" && (conn.github_auth ?? "token") !== githubAuth) ||
      (platform === "slack" && (conn.slack_mode ?? "http") !== slackMode));
  const shared = platform === "github" ? "webhook_secret" : "bot_token";
  // New connections need every field; an existing one keeps what is left empty.
  const required = fields.filter(([k]) => !conn || (switching && k !== shared));
  const missing = required.some(([k]) => !creds[k]?.trim());
  const disabled = busy || !name.trim() || missing || !settings.role_id;

  const submit = async () => {
    const filled = Object.fromEntries(Object.entries(creds).filter(([, v]) => v.trim()));
    const out = await run(
      () =>
        conn
          ? api.patch<Connection>(`/api/connections/${conn.id}`, {
              name: name.trim(),
              settings,
              ...(Object.keys(filled).length ? { credentials: filled } : {}),
            })
          : api.post<Connection>("/api/connections", {
              platform,
              name: name.trim(),
              credentials: filled,
              settings,
            }),
      conn ? "已保存" : "接入已创建，请把事件地址配置到平台后台，然后测试连接",
    );
    if (out) onSaved(out);
  };

  return (
    <form
      className="form form-narrow"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) void submit();
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
      {installed ? (
        <p className="small muted">
          这个工作区通过应用「{conn?.app_connection?.name ?? "?"}
          」安装，凭据只有它自己的机器人令牌；需要更换时重新安装一次。
        </p>
      ) : null}
      {platform === "slack" && !installed ? (
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
      {fields.map(([k, label]) => (
        <Field
          key={k}
          label={label}
          description={platform === "slack" ? SLACK_FIELD_HELP[k] : undefined}
          hint={conn && (!switching || k === shared) ? "留空保持不变" : undefined}
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
      <ConnectionSettingsFields platform={platform} value={settings} onChange={setSettings} />
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={disabled}>
          {busy ? "处理中…" : conn ? "保存" : "创建接入"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        {settings.role_id ? null : <span className="small muted">选择机器人代表的角色后才能保存。</span>}
      </div>
    </form>
  );
}

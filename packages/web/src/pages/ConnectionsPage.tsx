import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Connection, ExternalConversation, ExternalIdentity, OutboundMessage } from "../api/types";
import { CONVERSATION_KIND, fmtDateTime, fmtRelative, genericStatus, PLATFORM_LABEL, SYNC_MODE } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useAuth, useDirectory } from "../lib/session";
import { useAction, useFeedback } from "../ui/feedback";
import {
  CopyText,
  Empty,
  Field,
  FormModal,
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

const CREDENTIAL_FIELDS: Record<string, [string, string][]> = {
  slack: [
    ["bot_token", "Bot Token（xoxb-…）"],
    ["signing_secret", "Signing Secret"],
  ],
  feishu: [
    ["app_id", "App ID"],
    ["app_secret", "App Secret"],
    ["verification_token", "Verification Token"],
  ],
};

export default function ConnectionsPage() {
  const res = useResource(() => api.get<Connection[]>("/api/connections"), []);
  const caps = useResource(() => api.get<CapabilityMatrix>("/api/integrations/capabilities"), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCaps, setShowCaps] = useState(false);

  useEffect(() => {
    if (!selected && res.data?.length) setSelected(res.data[0].id);
  }, [res.data, selected]);

  const current = res.data?.find((c) => c.id === selected) ?? null;

  return (
    <div className="page">
      <PageHeader
        title="通讯接入"
        sub="把 Slack、飞书等平台的机器人接入进来。接入平台不等于导入全部消息：每个会话可以单独设置同步范围，外部请求还要经过分配规则。"
        actions={
          <>
            <button type="button" className="btn btn-sm" onClick={() => setShowCaps((v) => !v)}>
              {showCaps ? "收起能力对照" : "各平台能力对照"}
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
              新建接入
            </button>
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
                />
              ) : null}
            </div>
          ) : (
            <Empty
              title="还没有接入任何通讯平台"
              hint="创建 Slack 应用（或飞书应用）并填写凭据，再把事件地址配置到平台后台。"
              action={
                <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                  新建接入
                </button>
              }
            />
          )
        }
      </Loaded>
      {creating ? (
        <ConnectionEditor
          conn={null}
          onClose={() => setCreating(false)}
          onSaved={(c) => {
            setCreating(false);
            setSelected(c.id);
            void res.reload();
          }}
        />
      ) : null}
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
}: {
  conn: Connection;
  onChanged: (c: Connection) => void;
  onDeleted: () => void;
}) {
  const { can } = useAuth();
  const { confirm, toast } = useFeedback();
  const { run, busy } = useAction();
  const [tab, setTab] = useState("conversations");
  const [editing, setEditing] = useState(false);

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
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                const out = await run(() =>
                  api.post<{ ok: boolean; error?: string } & Record<string, unknown>>(
                    `/api/connections/${conn.id}/test`,
                  ),
                );
                if (!out) return;
                if (out.ok) toast("连接正常", "ok");
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
        <KV
          items={[
            ["凭据", conn.has_credentials ? "已设置（不可查看）" : <span className="text-bad">未设置</span>],
            ["事件地址", conn.events_url ? <CopyText text={conn.events_url} /> : null],
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
            ["新会话默认同步", SYNC_MODE[conn.settings?.default_sync_mode ?? "mentions"]],
            [
              "自动创建成员",
              conn.settings?.auto_provision_users ? "是：未关联的外部账号自动创建内部成员" : "否：需要管理员关联身份",
            ],
            ["角色身份显示", conn.settings?.custom_identity ? "用角色自己的名称和头像发消息" : "在消息前加角色名称"],
          ]}
        />
        {conn.platform === "slack" ? (
          <p className="small muted">
            把事件地址填到 Slack 应用的 Event Subscriptions，并订阅
            app_mention、message.channels、message.groups、message.im 等事件。
          </p>
        ) : null}
      </Section>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "conversations", label: "会话与同步" },
          { key: "identities", label: "身份关联", hidden: !can("user.manage") },
          { key: "outbound", label: "投递记录" },
          { key: "inbound", label: "收到的事件" },
        ]}
      />
      {tab === "conversations" ? <Conversations conn={conn} /> : null}
      {tab === "identities" ? <Identities conn={conn} /> : null}
      {tab === "outbound" ? <Outbound conn={conn} /> : null}
      {tab === "inbound" ? <Inbound conn={conn} /> : null}
      {editing ? (
        <ConnectionEditor
          conn={conn}
          onClose={() => setEditing(false)}
          onSaved={(c) => {
            setEditing(false);
            onChanged(c);
          }}
        />
      ) : null}
    </div>
  );
}

function Conversations({ conn }: { conn: Connection }) {
  const { run } = useAction();
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
                  <th>同步范围</th>
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
                    <td>
                      <select
                        value={c.sync_mode}
                        aria-label="同步范围"
                        onChange={async (e) => {
                          const mode = e.target.value as ExternalConversation["sync_mode"];
                          const out = await run(
                            () =>
                              api.patch<ExternalConversation>(`/api/connections/${conn.id}/conversations/${c.id}`, {
                                sync_mode: mode,
                              }),
                            "同步范围已更新",
                          );
                          if (out) res.setData((prev) => prev?.map((x) => (x.id === c.id ? { ...x, ...out } : x)));
                        }}
                      >
                        {Object.entries(SYNC_MODE).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </td>
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

function Identities({ conn }: { conn: Connection }) {
  const dir = useDirectory();
  const { run } = useAction();
  const res = useResource(() => api.get<ExternalIdentity[]>("/api/identities", { connection_id: conn.id }), [conn.id]);
  return (
    <>
      <p className="small muted side-note">
        外部账号按平台用户 ID 关联到内部成员，不按显示名称判断身份。未关联的账号无法使用需要授权的角色。
      </p>
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>外部账号</th>
                    <th>平台用户 ID</th>
                    <th>关联成员</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.id}>
                      <td>
                        {i.display_name ?? <span className="muted">（无显示名）</span>}
                        {i.is_bot ? <Tag tone="off">机器人</Tag> : null}
                      </td>
                      <td>
                        <code className="id">{i.external_user_id}</code>
                      </td>
                      <td>
                        <select
                          value={i.user_id ?? ""}
                          aria-label="关联成员"
                          onChange={async (e) => {
                            const out = await run(
                              () =>
                                api.patch<ExternalIdentity>(`/api/identities/${i.id}`, {
                                  user_id: e.target.value || null,
                                }),
                              e.target.value ? "已关联" : "已解除关联",
                            );
                            if (out) res.setData((prev) => prev?.map((x) => (x.id === i.id ? out : x)));
                          }}
                        >
                          <option value="">未关联</option>
                          {dir.users.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                              {u.email ? `（${u.email}）` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="还没有外部账号" hint="有人在平台上与机器人互动后，账号会出现在这里等待关联。" />
          )
        }
      </Loaded>
    </>
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

// Outcomes recorded by the server's inbound handler (integrations/inbound.ts).
const INBOUND_STATUS: Record<string, [string, "ok" | "wait" | "off" | "bad"]> = {
  processing: ["处理中", "wait"],
  dispatched: ["已交给角色", "ok"],
  stored: ["已同步（未 @ 机器人）", "ok"],
  ignored: ["已忽略（不在同步范围）", "off"],
  sync_off: ["会话不同步", "off"],
  connection_paused: ["接入已暂停", "off"],
  unknown_connection: ["接入不存在", "bad"],
  unlinked_user: ["账号未关联成员", "bad"],
  failed: ["处理失败", "bad"],
};

interface InboundEvent {
  id: string;
  event_key: string;
  status: string;
  detail: string | null;
  received_at: string;
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

function ConnectionEditor({
  conn,
  onClose,
  onSaved,
}: {
  conn: Connection | null;
  onClose: () => void;
  onSaved: (c: Connection) => void;
}) {
  const { run, busy } = useAction();
  const [platform, setPlatform] = useState(conn?.platform ?? "slack");
  const [name, setName] = useState(conn?.name ?? "");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [autoProvision, setAutoProvision] = useState(!!conn?.settings?.auto_provision_users);
  const [customIdentity, setCustomIdentity] = useState(!!conn?.settings?.custom_identity);
  const [syncMode, setSyncMode] = useState(conn?.settings?.default_sync_mode ?? "mentions");
  const fields = CREDENTIAL_FIELDS[platform] ?? [];
  const missing = !conn && fields.some(([k]) => !creds[k]?.trim());

  return (
    <FormModal
      title={conn ? `编辑 ${conn.name}` : "新建接入"}
      busy={busy}
      width={620}
      disabled={!name.trim() || missing}
      onClose={onClose}
      onSubmit={async () => {
        const filled = Object.fromEntries(Object.entries(creds).filter(([, v]) => v.trim()));
        const settings = {
          auto_provision_users: autoProvision,
          custom_identity: customIdentity,
          default_sync_mode: syncMode,
        };
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
      }}
    >
      <div className="form-row">
        <Field label="平台">
          <select value={platform} disabled={!!conn} onChange={(e) => (setPlatform(e.target.value), setCreds({}))}>
            <option value="slack">Slack</option>
            <option value="feishu">飞书（实验性）</option>
          </select>
        </Field>
        <Field label="名称">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：公司 Slack" />
        </Field>
      </div>
      {fields.map(([k, label]) => (
        <Field key={k} label={label} hint={conn ? "留空保持不变" : undefined}>
          <input
            type="password"
            autoComplete="off"
            className="mono"
            value={creds[k] ?? ""}
            onChange={(e) => setCreds({ ...creds, [k]: e.target.value })}
          />
        </Field>
      ))}
      <Field label="新会话默认同步范围" hint="接入平台不等于导入全部消息">
        <select value={syncMode} onChange={(e) => setSyncMode(e.target.value as typeof syncMode)}>
          {Object.entries(SYNC_MODE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Toggle
        checked={autoProvision}
        onChange={setAutoProvision}
        label="自动为未关联的外部账号创建内部成员（默认无任何权限）"
      />
      <Toggle
        checked={customIdentity}
        onChange={setCustomIdentity}
        label="以角色自己的名称和头像发送消息（Slack 需要 chat:write.customize）"
      />
    </FormModal>
  );
}

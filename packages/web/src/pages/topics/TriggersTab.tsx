import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { Topic } from "../../api/types";
import { copyToClipboard } from "../../lib/clipboard";
import { fmtTime } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import { CopyText, Empty, Field, FormModal, Loaded, Modal, Tag } from "../../ui/kit";
import type { WebhookSource } from "../WebhookSourcesPanel";

interface Trigger {
  id: string;
  name: string;
  kind: "webhook" | "schedule";
  enabled: boolean;
  role_id: string;
  source_id?: string | null;
  instructions: string;
  filter_code: string;
  cron: string | null;
  timezone: string;
  next_run_at: string | null;
  webhook_url: string | null;
}

interface TriggerEvent {
  id: string;
  trigger_name: string;
  kind: string;
  status: string;
  error: string | null;
  created_at: string;
  scheduled_at: string | null;
  task_id: string | null;
  request?: {
    method: string;
    path: string;
    headers: Record<string, unknown>;
    query: Record<string, unknown>;
    body_base64: string;
  } | null;
}
interface EventPage {
  items: TriggerEvent[];
  next_cursor: string | null;
}

const STATUS: Record<string, string> = {
  queued: "等待处理",
  processing: "过滤 / 处理中",
  dispatched: "已投递到话题",
  filtered: "已过滤",
  failed: "处理失败",
  skipped: "已跳过",
};
const makeSecret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, "0")).join("");

export function TriggersTab({ topic, version }: { topic: Topic; version: number }) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const { confirm } = useFeedback();
  const [editing, setEditing] = useState<Trigger | "new" | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [before, setBefore] = useState<string | undefined>();
  const [kind, setKind] = useState("");
  const base = `/api/topics/${topic.id}`;
  const triggers = useResource(() => api.get<Trigger[]>(`${base}/triggers`), [topic.id]);
  const events = useResource(
    () => api.get<EventPage>(`${base}/trigger-events`, { before, kind }),
    [topic.id, before, kind],
  );
  useEffect(() => {
    void triggers.reload();
    void events.reload();
  }, [version]);
  const reload = () => {
    void triggers.reload();
    void events.reload();
  };

  return (
    <div className="settings">
      <p className="small muted">
        收到事件或到达计划时间后，交给指定角色处理。先在「设置 → 工作说明」中写清工作用途。
        {topic.channel
          ? "这个话题对应外部频道：处理角色就是机器人代表的角色，处理结果同步到频道。"
          : "需要同步到其他话题时，由角色用关联话题发送。"}
      </p>
      {topic.status === "archived" ? <p className="notice">话题已归档，触发器暂停接收和发起工作。</p> : null}
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={topic.status !== "active"}
        onClick={() => setEditing("new")}
      >
        添加触发器
      </button>
      <Loaded res={triggers}>
        {(rows) =>
          rows.length ? (
            <ul className="task-cards">
              {rows.map((trigger) => (
                <li className="task-card" key={trigger.id}>
                  <div className="task-card-head">
                    <strong>{trigger.name}</strong>
                    <Tag tone={trigger.enabled ? "ok" : "off"}>{trigger.enabled ? "启用" : "停用"}</Tag>
                  </div>
                  <p className="small">
                    {trigger.kind === "webhook" ? "Webhook" : "定时"} ·{" "}
                    {dir.roleById.get(trigger.role_id)?.name ?? "角色已删除"}
                  </p>
                  {trigger.kind === "schedule" ? (
                    <p className="small muted">
                      <code>{trigger.cron}</code> · {trigger.timezone}
                      <br />
                      下次：{trigger.next_run_at ? fmtTime(trigger.next_run_at) : "—"}（本地时间）
                    </p>
                  ) : (
                    <CopyText text={trigger.webhook_url ?? ""} />
                  )}
                  <div className="btn-row">
                    <button type="button" className="btn btn-xs" onClick={() => setEditing(trigger)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs"
                      disabled={busy}
                      onClick={async () => {
                        if (await run(() => api.patch(`${base}/triggers/${trigger.id}`, { enabled: !trigger.enabled })))
                          reload();
                      }}
                    >
                      {trigger.enabled ? "停用" : "启用"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs btn-danger"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `删除触发器「${trigger.name}」？`,
                            body: <p>停止后续触发，已有历史记录会保留。</p>,
                            danger: true,
                            confirmLabel: "删除",
                          })
                        ) {
                          if (await run(() => api.del(`${base}/triggers/${trigger.id}`))) reload();
                        }
                      }}
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="还没有触发器" hint="添加 webhook 接收外部事件，或用定时触发安排周期工作。" />
          )
        }
      </Loaded>

      <section className="settings-block">
        <h4>触发历史</h4>
        <div className="btn-row">
          <select
            aria-label="触发类型"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setBefore(undefined);
            }}
          >
            <option value="">全部类型</option>
            <option value="webhook">Webhook</option>
            <option value="schedule">定时</option>
          </select>
          <button type="button" className="btn btn-xs" onClick={reload}>
            刷新
          </button>
          <button
            type="button"
            className="btn btn-xs btn-danger"
            disabled={busy}
            onClick={async () => {
              if (
                await confirm({
                  title: "永久清空触发历史？",
                  body: (
                    <p>
                      删除原始请求和未处理事件。已发起的工作和话题消息保留；发送方再次提交同一事件编号时会作为新请求处理。
                    </p>
                  ),
                  danger: true,
                  confirmLabel: "永久清空",
                })
              ) {
                if (await run(() => api.del(`${base}/trigger-events`, { confirm: true }))) {
                  setBefore(undefined);
                  reload();
                }
              }
            }}
          >
            清空历史
          </button>
        </div>
        <Loaded res={events}>
          {(page) => (
            <>
              {page.items.length ? (
                <ul className="task-cards">
                  {page.items.map((event) => (
                    <li key={event.id} className="task-card">
                      <div className="task-card-head">
                        <strong>{event.trigger_name}</strong>
                        <Tag tone={event.status === "failed" ? "bad" : "off"}>
                          {STATUS[event.status] ?? event.status}
                        </Tag>
                      </div>
                      <p className="small muted">
                        {fmtTime(event.created_at)} · {event.kind === "webhook" ? "Webhook" : "定时"}
                      </p>
                      {event.error ? <p className="small">{event.error}</p> : null}
                      <div className="btn-row">
                        <button type="button" className="btn btn-xs" onClick={() => setDetail(event.id)}>
                          查看记录
                        </button>
                        {event.task_id ? (
                          <Link className="btn btn-xs" to={`/tasks/${event.task_id}`}>
                            处理过程
                          </Link>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title="没有触发记录" hint="被过滤的 webhook 也会保留在这里，所属话题的角色可以查询。" />
              )}
              <div className="btn-row">
                <button type="button" className="btn btn-xs" disabled={!before} onClick={() => setBefore(undefined)}>
                  回到最新
                </button>
                <button
                  type="button"
                  className="btn btn-xs"
                  disabled={page.items.length < 30 || !page.next_cursor}
                  onClick={() => setBefore(page.next_cursor ?? undefined)}
                >
                  更早记录
                </button>
              </div>
            </>
          )}
        </Loaded>
      </section>
      {editing ? (
        <TriggerEditor
          topic={topic}
          trigger={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}
      {detail ? <EventDetail topicId={topic.id} id={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}

function TriggerEditor({
  topic,
  trigger,
  onClose,
  onSaved,
}: {
  topic: Topic;
  trigger?: Trigger;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const { toast } = useFeedback();
  const roles = (topic.participants ?? []).filter(
    (p) => p.type === "role" && p.status === "active" && !dir.roleById.get(p.id)?.system_admin,
  );
  const [kind, setKind] = useState<Trigger["kind"]>(trigger?.kind ?? "webhook");
  const sources = useResource(() => api.get<WebhookSource[]>("/api/webhook-sources"), []);
  const [sourceId, setSourceId] = useState(trigger?.source_id ?? "");
  const [name, setName] = useState(trigger?.name ?? "");
  const [roleId, setRoleId] = useState(trigger?.role_id ?? roles[0]?.id ?? "");
  const [instructions, setInstructions] = useState(trigger?.instructions ?? "");
  const [secret, setSecret] = useState(trigger ? "" : makeSecret);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [copyingSecret, setCopyingSecret] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const secretInput = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState(trigger?.filter_code ?? "");
  const [cron, setCron] = useState(trigger?.cron ?? "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(
    trigger?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const [sample, setSample] = useState('{"action":"opened"}');
  const [testResult, setTestResult] = useState<string | null>(null);
  const base = `/api/topics/${topic.id}/triggers`;
  return (
    <FormModal
      title={trigger ? "编辑触发器" : "添加触发器"}
      width={720}
      onClose={onClose}
      busy={busy}
      disabled={
        !name.trim() ||
        !roleId ||
        (kind === "webhook" &&
          !sourceId &&
          ((!trigger && !secret) || (!!secret && (secret.length < 24 || !copiedSecret))))
      }
      submitLabel="保存触发器"
      onSubmit={async () => {
        const data = {
          name,
          role_id: roleId,
          instructions,
          ...(kind === "webhook"
            ? { filter_code: code, ...(sourceId ? { source_id: sourceId } : secret ? { secret } : {}) }
            : { cron, timezone }),
        };
        const result = await run(
          () => (trigger ? api.patch(`${base}/${trigger.id}`, data) : api.post(base, { ...data, kind })),
          "触发器已保存",
        );
        if (result) onSaved();
      }}
    >
      <Field label="名称">
        <input
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：部署通知 / 每日巡检"
          autoFocus
        />
      </Field>
      <Field label="类型">
        <select disabled={!!trigger} value={kind} onChange={(e) => setKind(e.target.value as Trigger["kind"])}>
          <option value="webhook">Webhook</option>
          <option value="schedule">定时</option>
        </select>
      </Field>
      <Field label="处理角色" hint="交给这个角色处理，不受话题的「主动 @ / 自动」模式影响。">
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">请选择</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} @{r.handle}
            </option>
          ))}
        </select>
      </Field>
      {!trigger ? (
        <p className="small muted">保存后你会加入这个话题；你退出话题或账号停用后，触发器不再发起新工作。</p>
      ) : null}
      {!roles.length ? <p className="notice">请先在「参与者」中邀请一个普通角色。</p> : null}
      <Field label="本次触发的补充说明" hint="可留空，角色会同时参考话题设置中的「工作说明」。">
        <textarea rows={3} maxLength={16000} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </Field>
      {kind === "schedule" ? (
        <>
          <Field
            label="Cron"
            hint="五段：分 时 日 月 周。例如 0 9 * * 1-5 表示工作日 09:00，*/30 * * * * 表示每 30 分钟。"
          >
            <input value={cron} onChange={(e) => setCron(e.target.value)} />
          </Field>
          <Field label="时区" hint="例如 Asia/Shanghai 或 UTC。">
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </Field>
          <p className="small muted">
            服务停机错过多次计划时，恢复后补一次，然后按正常计划继续。停用后重新启用，从下次计划开始。
          </p>
        </>
      ) : (
        <>
          <Field label="Webhook 来源" hint="推荐复用共享来源；在“通讯接入 → Webhook 来源”中创建和管理密钥。">
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="" disabled={!!trigger?.source_id}>
                独立入口（兼容旧配置）
              </option>
              {(sources.data ?? []).map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                  {source.enabled ? "" : "（停用）"}
                </option>
              ))}
            </select>
            {sources.error ? <p className="notice">来源列表加载失败，请在通讯接入中重试。</p> : null}
            {trigger && !trigger.source_id && sourceId ? (
              <p className="notice">
                改用共享来源后，这个触发器自己的密钥和地址会作废，且不能改回；原来往这个地址发送的一方需要改用来源的地址和密钥。
              </p>
            ) : null}
          </Field>
          {trigger?.webhook_url ? (
            <CopyText text={trigger.webhook_url} />
          ) : (
            <p className="small muted">
              保存后显示 webhook 地址。公网事件地址应转发到事件端口（默认 8325），可在「公网地址」中设置。
            </p>
          )}
          {!sourceId ? (
            <>
              <Field
                label={trigger ? "更换密钥（留空保留）" : "Webhook 密钥"}
                hint="发送时用 Authorization: Bearer <密钥>，或 X-Webhook-Token 请求头。密钥保存后无法读回。"
              >
                <input
                  ref={secretInput}
                  type={manualCopy ? "text" : "password"}
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => {
                    setSecret(e.target.value);
                    setCopiedSecret(false);
                  }}
                  minLength={24}
                  maxLength={256}
                />
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => {
                      setSecret(makeSecret());
                      setCopiedSecret(false);
                      setManualCopy(false);
                    }}
                  >
                    生成新密钥
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={!secret || copyingSecret}
                    onClick={async () => {
                      setCopyingSecret(true);
                      const copied = await copyToClipboard(secret);
                      setCopyingSecret(false);
                      // The input may have changed while the browser was waiting for clipboard permission.
                      if (secretInput.current?.value !== secret) return;
                      if (copied) {
                        setCopiedSecret(true);
                        setManualCopy(false);
                        toast("密钥已复制，请保存到发送方", "ok");
                      } else {
                        setCopiedSecret(false);
                        setManualCopy(true);
                        requestAnimationFrame(() => {
                          if (secretInput.current?.value === secret) {
                            secretInput.current.focus();
                            secretInput.current.select();
                          }
                        });
                      }
                    }}
                  >
                    {copyingSecret ? "复制中…" : "复制密钥"}
                  </button>
                </div>
              </Field>
              {manualCopy ? (
                <p className="notice" role="status">
                  浏览器未允许自动复制，已显示密钥。请手动复制上方密钥，保存后勾选「已妥善保存此密钥」。
                </p>
              ) : null}
              {secret ? (
                <label className="check">
                  <input type="checkbox" checked={copiedSecret} onChange={(e) => setCopiedSecret(e.target.checked)} />
                  已妥善保存此密钥
                </label>
              ) : null}
            </>
          ) : (
            <p className="small muted">使用共享来源的地址和密钥，这个触发器不保存自己的密钥。</p>
          )}
          <Field
            label="前置过滤（JavaScript）"
            hint="留空表示全部通过。填写函数体，使用 request.body 读取 JSON、request.raw_body 读取原文、request.headers 读取请求头。必须返回 true 或 false；不能联网或读文件，超时 / 出错时不交给角色。"
          >
            <textarea
              className="mono"
              rows={6}
              maxLength={16000}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setTestResult(null);
              }}
              placeholder={'return request.body?.action === "opened";'}
              spellCheck={false}
            />
          </Field>
          <Field label="测试请求正文" hint="仅测试过滤结果，不保存请求、不触发角色。">
            <textarea
              className="mono"
              rows={3}
              maxLength={64000}
              value={sample}
              onChange={(e) => {
                setSample(e.target.value);
                setTestResult(null);
              }}
            />
          </Field>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={async () => {
              setTestResult(null);
              const result = await run(() =>
                api.post<{ accepted: boolean }>(`${base}/test-filter`, { filter_code: code, raw_body: sample }),
              );
              if (result) setTestResult(result.accepted ? "通过：将交给角色" : "过滤：只保留记录");
            }}
          >
            测试过滤
          </button>
          {testResult ? <p role="status">{testResult}</p> : null}
          <p className="small muted">
            支持 POST，每次最多 1 MiB。原始正文会保存，请勿发送无关凭据。Authorization、Cookie
            等认证请求头会被遮盖；相同 Idempotency-Key 的重试只处理一次。
          </p>
        </>
      )}
    </FormModal>
  );
}

function EventDetail({ topicId, id, onClose }: { topicId: string; id: string; onClose: () => void }) {
  const res = useResource(() => api.get<TriggerEvent>(`/api/topics/${topicId}/trigger-events/${id}`), [topicId, id]);
  return (
    <Modal title="触发记录" width={800} onClose={onClose}>
      <Loaded res={res}>
        {(event) => (
          <>
            <p>
              <strong>{event.trigger_name}</strong> · {STATUS[event.status] ?? event.status}
            </p>
            <p className="small muted">
              编号：{event.id}
              <br />
              接收时间：{fmtTime(event.created_at)}
              {event.scheduled_at ? `；计划时间：${fmtTime(event.scheduled_at)}` : ""}
            </p>
            {event.error ? <p className="notice">{event.error}</p> : null}
            {event.request ? (
              <>
                <h4>请求信息</h4>
                <pre className="trigger-request">
                  {JSON.stringify(
                    {
                      method: event.request.method,
                      path: event.request.path,
                      query: event.request.query,
                      headers: event.request.headers,
                    },
                    null,
                    2,
                  )}
                </pre>
                <h4>原始正文（UTF-8 预览）</h4>
                <pre className="trigger-request">
                  {new TextDecoder().decode(Uint8Array.from(atob(event.request.body_base64), (c) => c.charCodeAt(0))) ||
                    "（空正文）"}
                </pre>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    const bytes = Uint8Array.from(atob(event.request!.body_base64), (c) => c.charCodeAt(0));
                    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `${id}.bin`;
                    link.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  下载原始正文
                </button>
              </>
            ) : (
              <p className="muted">定时触发没有 HTTP 请求正文。</p>
            )}
          </>
        )}
      </Loaded>
    </Modal>
  );
}

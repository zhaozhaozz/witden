import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { copyToClipboard } from "../lib/clipboard";
import { fmtTime } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useDirectory } from "../lib/session";
import { useAction, useFeedback } from "../ui/feedback";
import { CopyText, Empty, Field, FormModal, Loaded, Modal, Section, Tag } from "../ui/kit";

export interface WebhookSource {
  id: string;
  name: string;
  enabled: boolean;
  webhook_url: string;
  allowed_role_ids: string[];
  rules: { id: string; topic_id: string; name: string; enabled: boolean }[];
}
const secretValue = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, "0")).join("");

export function WebhookSourcesPanel() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookSource | "new" | null>(null);
  const [history, setHistory] = useState<WebhookSource | null>(null);
  const sources = useResource(() => api.get<WebhookSource[]>("/api/webhook-sources"), [], open);
  const { run, busy } = useAction();
  const { confirm } = useFeedback();
  return (
    <Section
      title="Webhook 来源"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "管理来源"}
        </button>
      }
    >
      <p className="small muted">
        一个来源可以供多个话题的触发器使用。只接收事件，不回传工作结果；需要角色处理时，把触发器建在内部话题。
      </p>
      {open ? (
        <>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
            添加来源
          </button>
          <Loaded res={sources}>
            {(rows) =>
              rows.length ? (
                <ul className="task-cards">
                  {rows.map((source) => (
                    <li key={source.id} className="task-card">
                      <div className="task-card-head">
                        <strong>{source.name}</strong>
                        <Tag tone={source.enabled ? "ok" : "off"}>{source.enabled ? "启用" : "停用"}</Tag>
                      </div>
                      <CopyText text={source.webhook_url} />
                      <p className="small muted">
                        {source.rules.length} 个触发器使用这个来源；按来源去重，各触发器分别处理。
                      </p>
                      {source.rules.map((r) => (
                        <p className="small" key={r.id}>
                          <Link to={`/topics/${r.topic_id}`}>{r.name}</Link>
                          {r.enabled ? "" : "（停用）"}
                        </p>
                      ))}
                      <div className="btn-row">
                        <button type="button" className="btn btn-xs" onClick={() => setEditing(source)}>
                          编辑
                        </button>
                        <button type="button" className="btn btn-xs" onClick={() => setHistory(source)}>
                          接收记录
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy}
                          onClick={async () => {
                            if (
                              source.enabled &&
                              source.rules.length &&
                              !(await confirm({
                                title: "停用共享来源？",
                                body: <p>使用这个来源的触发器都不再接收新事件。</p>,
                                confirmLabel: "停用",
                                cancelLabel: "返回",
                              }))
                            )
                              return;
                            if (
                              await run(() =>
                                api.patch(`/api/webhook-sources/${source.id}`, { enabled: !source.enabled }),
                              )
                            )
                              void sources.reload();
                          }}
                        >
                          {source.enabled ? "停用" : "启用"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-danger-ghost"
                          disabled={busy || source.rules.length > 0}
                          onClick={async () => {
                            if (
                              !(await confirm({
                                title: `删除「${source.name}」？`,
                                body: <p>来源将不再可用，已有接收记录保留。</p>,
                                confirmLabel: "删除",
                                cancelLabel: "返回",
                              }))
                            )
                              return;
                            if (await run(() => api.del(`/api/webhook-sources/${source.id}`))) void sources.reload();
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title="还没有共享来源" hint="旧话题 Webhook 仍可使用；创建共享来源后，在话题触发器中选择它。" />
              )
            }
          </Loaded>
        </>
      ) : null}
      {editing ? (
        <SourceEditor
          source={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void sources.reload();
          }}
        />
      ) : null}
      {history ? <SourceHistory source={history} onClose={() => setHistory(null)} /> : null}
    </Section>
  );
}

function SourceEditor({
  source,
  onClose,
  onSaved,
}: {
  source?: WebhookSource;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(source?.name ?? "");
  const [secret, setSecret] = useState(source ? "" : secretValue);
  const [saved, setSaved] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const secretInput = useRef<HTMLInputElement>(null);
  const [roleIds, setRoleIds] = useState(source?.allowed_role_ids ?? []);
  const dir = useDirectory();
  const { run, busy } = useAction();
  const { toast } = useFeedback();
  return (
    <FormModal
      title={source ? "编辑 Webhook 来源" : "添加 Webhook 来源"}
      onClose={onClose}
      busy={busy}
      disabled={!name.trim() || (!source && !secret) || (!!secret && (secret.length < 24 || !saved))}
      submitLabel="保存来源"
      onSubmit={async () => {
        const payload = { name, allowed_role_ids: roleIds, ...(secret ? { secret } : {}) };
        if (
          await run(
            () =>
              source
                ? api.patch(`/api/webhook-sources/${source.id}`, payload)
                : api.post("/api/webhook-sources", payload),
            "来源已保存",
          )
        )
          onSaved();
      }}
    >
      <Field label="来源名称">
        <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field
        label={source ? "更换密钥（留空保留）" : "密钥"}
        hint="服务端只保存哈希。保存后无法读回；发送方使用 Authorization: Bearer 或 X-Webhook-Token。"
      >
        <input
          ref={secretInput}
          type={showSecret ? "text" : "password"}
          autoComplete="new-password"
          value={secret}
          maxLength={256}
          onChange={(e) => {
            setSecret(e.target.value);
            setSaved(false);
            setManualCopy(false);
          }}
        />
      </Field>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-xs"
          onClick={() => {
            setSecret(secretValue());
            setSaved(false);
            setManualCopy(false);
          }}
        >
          生成新密钥
        </button>
        <button
          type="button"
          className="btn btn-xs"
          disabled={!secret}
          onClick={async () => {
            const copied = await copyToClipboard(secret);
            // The secret may have changed while the browser was asking for clipboard access.
            if (secretInput.current?.value !== secret) return;
            if (copied) {
              setSaved(true);
              setManualCopy(false);
              toast("密钥已复制，请保存到发送方", "ok");
            } else {
              // As in the trigger editor: show it, select it, and let the person confirm it is saved.
              setSaved(false);
              setShowSecret(true);
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
          复制密钥
        </button>
        <button type="button" className="btn btn-xs" onClick={() => setShowSecret((v) => !v)}>
          {showSecret ? "隐藏" : "显示"}
        </button>
      </div>
      {manualCopy ? (
        <p className="notice" role="status">
          浏览器未允许自动复制，已显示密钥。请手动复制上方密钥，保存后勾选「已妥善保存密钥」。
        </p>
      ) : null}
      {secret ? (
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          已妥善保存密钥
        </label>
      ) : null}
      <Field
        label="允许自主订阅的角色"
        hint="角色还需要“自动化管理”权限，才能自己新建使用这个来源的触发器；它们拿不到密钥。管理员在控制台配置触发器时不受这个限制。"
      >
        <div>
          {dir.roles
            .filter((r) => !r.system_admin)
            .map((r) => (
              <label className="check" key={r.id}>
                <input
                  type="checkbox"
                  checked={roleIds.includes(r.id)}
                  onChange={(e) =>
                    setRoleIds((prev) => (e.target.checked ? [...prev, r.id] : prev.filter((id) => id !== r.id)))
                  }
                />
                {r.name} @{r.handle}
              </label>
            ))}
        </div>
      </Field>
    </FormModal>
  );
}

interface Receipt {
  id: string;
  event_key: string | null;
  created_at: string;
  deliveries: {
    id: string;
    topic_id: string;
    trigger_name: string;
    status: string;
    error: string | null;
    task_id: string | null;
  }[];
  request?: {
    method: string;
    path: string;
    headers: Record<string, unknown>;
    query: Record<string, unknown>;
    body_base64: string;
  };
}
function SourceHistory({ source, onClose }: { source: WebhookSource; onClose: () => void }) {
  const [before, setBefore] = useState<string | undefined>();
  const [detail, setDetail] = useState<Receipt | null>(null);
  const { run } = useAction();
  const res = useResource(
    () =>
      api.get<{ items: Receipt[]; next_cursor: string | null }>(`/api/webhook-sources/${source.id}/events`, { before }),
    [source.id, before],
  );
  return (
    <Modal title={`${source.name} · 接收记录`} width={800} onClose={onClose}>
      <Loaded res={res}>
        {(page) => (
          <>
            {page.items.length ? (
              <ul className="task-cards">
                {page.items.map((r) => (
                  <li className="task-card" key={r.id}>
                    <strong>{fmtTime(r.created_at)}</strong>
                    <p className="small">{r.event_key ?? "没有幂等标识"}</p>
                    {r.deliveries.map((d) => (
                      <p className="small" key={d.id}>
                        <Link to={`/topics/${d.topic_id}`}>{d.trigger_name}</Link> · {d.status}
                        {d.error ? `：${d.error}` : ""}
                        {d.task_id ? (
                          <>
                            {" "}
                            · <Link to={`/tasks/${d.task_id}`}>执行记录</Link>
                          </>
                        ) : null}
                      </p>
                    ))}
                    {!r.deliveries.length ? <p className="small muted">接收时没有启用的触发器。</p> : null}
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={async () => {
                        const result = await run(() =>
                          api.get<Receipt>(`/api/webhook-sources/${source.id}/events/${r.id}`),
                        );
                        if (result) setDetail(result);
                      }}
                    >
                      查看原始请求
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="没有接收记录" />
            )}
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => {
                  setBefore(undefined);
                  void res.reload();
                }}
              >
                最新
              </button>
              <button
                type="button"
                className="btn btn-xs"
                disabled={!page.next_cursor}
                onClick={() => setBefore(page.next_cursor ?? undefined)}
              >
                更早
              </button>
            </div>
          </>
        )}
      </Loaded>
      {detail?.request ? (
        <section className="settings-block">
          <h4>原始请求 · {detail.id}</h4>
          <pre className="trigger-request">
            {JSON.stringify(
              {
                method: detail.request.method,
                path: detail.request.path,
                headers: detail.request.headers,
                query: detail.request.query,
              },
              null,
              2,
            )}
          </pre>
          <pre className="trigger-request">
            {new TextDecoder().decode(Uint8Array.from(atob(detail.request.body_base64), (c) => c.charCodeAt(0)))}
          </pre>
        </section>
      ) : null}
    </Modal>
  );
}

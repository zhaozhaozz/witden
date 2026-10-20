import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
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
  /** False for sources made before secrets were kept encrypted: only the hash exists, so it cannot be shown. */
  secret_readable: boolean;
  allowed_role_ids: string[];
  rules: { id: string; topic_id: string; name: string; enabled: boolean }[];
}

/** Where a topic's 触发器 tab sends people to add a source; the source's card leads back to that topic. */
export const newSourceLink = (topicId: string) => `/connections?webhook_source=new&from_topic=${topicId}`;
export const sourceLink = (sourceId: string) => `/connections?webhook_source=${sourceId}`;

/**
 * Every webhook trigger receives through one of these sources. The server generates each source's secret; its
 * card shows the address and lets console accounts copy the secret, so neither is ever typed into a form.
 */
export function WebhookSourcesPanel() {
  const [params, setParams] = useSearchParams();
  const fromTopic = params.get("from_topic");
  // ?webhook_source=new opens the add form, ?webhook_source=<id> points at that source's card.
  const [focus] = useState(() => params.get("webhook_source"));
  const [open, setOpen] = useState(!!focus);
  const [editing, setEditing] = useState<WebhookSource | "new" | null>(focus === "new" ? "new" : null);
  const [history, setHistory] = useState<WebhookSource | null>(null);
  const [highlight, setHighlight] = useState(focus === "new" ? null : focus);
  const [created, setCreated] = useState<string | null>(null);
  // Secrets shown on this page (just generated, or fetched on request), by source id.
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const sources = useResource(() => api.get<WebhookSource[]>("/api/webhook-sources"), [], open);
  const { run, busy } = useAction();
  const { confirm } = useFeedback();
  const showSecret = (id: string, secret: string | null) =>
    setSecrets(({ [id]: _, ...rest }) => (secret ? { ...rest, [id]: secret } : rest));

  useEffect(() => {
    if (!focus) return;
    params.delete("webhook_source");
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (highlight && sources.data) document.getElementById(`whs-${highlight}`)?.scrollIntoView({ block: "center" });
  }, [highlight, sources.data]);

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
        所有 Webhook
        触发器都通过来源接收：来源提供地址和密钥，在话题的「触发器」中选择来源、指定处理角色。一个来源可以供多个话题的触发器使用，各自过滤和处理；来源只接收事件，不回传工作结果。
      </p>
      {open ? (
        <>
          {fromTopic ? (
            <p className="notice">
              添加来源并把地址和密钥配置到发送方后，点来源卡片上的「回到话题添加触发器」继续。{" "}
              <Link to={`/topics/${fromTopic}?panel=triggers`}>直接回到话题</Link>
            </p>
          ) : null}
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
            添加来源
          </button>
          <Loaded res={sources}>
            {(rows) =>
              rows.length ? (
                <ul className="task-cards">
                  {rows.map((source) => (
                    <li
                      key={source.id}
                      id={`whs-${source.id}`}
                      className={`task-card${source.id === highlight ? " task-card-focus" : ""}`}
                    >
                      <div className="task-card-head">
                        <strong>{source.name}</strong>
                        <Tag tone={source.enabled ? "ok" : "off"}>{source.enabled ? "启用" : "停用"}</Tag>
                      </div>
                      {source.id === created ? (
                        <p className="notice" role="status">
                          来源已添加。把地址和密钥配置到发送方，密钥放在 Authorization: Bearer 或 X-Webhook-Token
                          请求头中。
                        </p>
                      ) : null}
                      <dl className="kv kv-compact">
                        <div className="kv-row">
                          <dt>地址</dt>
                          <dd>
                            <CopyText text={source.webhook_url} />
                          </dd>
                        </div>
                        <div className="kv-row">
                          <dt>密钥</dt>
                          <dd>
                            <SourceSecret
                              source={source}
                              secret={secrets[source.id]}
                              onSecret={(secret) => showSecret(source.id, secret)}
                            />
                          </dd>
                        </div>
                      </dl>
                      <p className="small muted">
                        {source.rules.length} 个触发器使用这个来源；按来源去重，各触发器分别处理。
                      </p>
                      {source.rules.map((r) => (
                        <p className="small" key={r.id}>
                          <Link to={`/topics/${r.topic_id}?panel=triggers`}>{r.name}</Link>
                          {r.enabled ? "" : "（停用）"}
                        </p>
                      ))}
                      <div className="btn-row">
                        {fromTopic ? (
                          <Link
                            className="btn btn-xs btn-primary"
                            to={`/topics/${fromTopic}?panel=triggers&webhook_source=${source.id}`}
                          >
                            回到话题添加触发器
                          </Link>
                        ) : null}
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
                                title: "停用来源？",
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
                          title={source.rules.length ? "先删除使用这个来源的触发器" : undefined}
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
                <Empty
                  title="还没有 Webhook 来源"
                  hint="添加来源后，把它的地址和密钥配置到发送方，再在话题的「触发器」中选择它。"
                />
              )
            }
          </Loaded>
        </>
      ) : null}
      {editing ? (
        <SourceEditor
          source={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            if (saved.secret) {
              // A new source: show its card with the address and the secret ready to copy.
              showSecret(saved.id, saved.secret);
              setCreated(saved.id);
              setHighlight(saved.id);
            }
            void sources.reload();
          }}
        />
      ) : null}
      {history ? <SourceHistory source={history} onClose={() => setHistory(null)} /> : null}
    </Section>
  );
}

/**
 * The secret is fetched only when someone copies or shows it (each read is audited). Regenerating invalidates
 * the old one at once.
 */
function SourceSecret({
  source,
  secret,
  onSecret,
}: {
  source: WebhookSource;
  secret?: string;
  onSecret: (secret: string | null) => void;
}) {
  const { run, busy } = useAction();
  const { confirm, toast } = useFeedback();
  const read = () => run(() => api.get<{ secret: string }>(`/api/webhook-sources/${source.id}/secret`));
  return (
    <span className="inline-list">
      {secret ? (
        <>
          <CopyText text={secret} />
          <button type="button" className="btn btn-xs" onClick={() => onSecret(null)}>
            隐藏
          </button>
        </>
      ) : source.secret_readable ? (
        <>
          <code className="id">••••••••••••••••</code>
          <button
            type="button"
            className="btn btn-xs"
            disabled={busy}
            onClick={async () => {
              const r = await read();
              if (!r) return;
              if (await copyToClipboard(r.secret)) toast("密钥已复制", "ok");
              else {
                // The browser refused the write after the request: show it, and its copy button takes over.
                onSecret(r.secret);
                toast("浏览器未允许自动复制，已显示密钥，请再点一次复制", "info");
              }
            }}
          >
            复制
          </button>
          <button
            type="button"
            className="btn btn-xs"
            disabled={busy}
            onClick={async () => {
              const r = await read();
              if (r) onSecret(r.secret);
            }}
          >
            显示
          </button>
        </>
      ) : (
        <span className="small muted">
          这个来源的密钥只保存了哈希，无法显示；发送方已保存的密钥仍然有效，需要复制时请重新生成。
        </span>
      )}
      <button
        type="button"
        className="btn btn-xs"
        disabled={busy}
        onClick={async () => {
          if (
            !(await confirm({
              title: "重新生成密钥？",
              body: <p>旧密钥立即失效，所有往这个来源发送的一方都要换成新密钥。</p>,
              confirmLabel: "重新生成",
              cancelLabel: "返回",
            }))
          )
            return;
          const r = await run(
            () => api.post<{ secret: string }>(`/api/webhook-sources/${source.id}/secret`),
            "已生成新密钥",
          );
          if (r) onSecret(r.secret);
        }}
      >
        重新生成
      </button>
    </span>
  );
}

function SourceEditor({
  source,
  onClose,
  onSaved,
}: {
  source?: WebhookSource;
  onClose: () => void;
  onSaved: (saved: WebhookSource & { secret?: string }) => void;
}) {
  const [name, setName] = useState(source?.name ?? "");
  const [roleIds, setRoleIds] = useState(source?.allowed_role_ids ?? []);
  const dir = useDirectory();
  const { run, busy } = useAction();
  return (
    <FormModal
      title={source ? "编辑 Webhook 来源" : "添加 Webhook 来源"}
      onClose={onClose}
      busy={busy}
      disabled={!name.trim()}
      submitLabel={source ? "保存来源" : "添加来源"}
      onSubmit={async () => {
        const payload = { name, allowed_role_ids: roleIds };
        const saved = await run(
          () =>
            source
              ? api.patch<WebhookSource>(`/api/webhook-sources/${source.id}`, payload)
              : api.post<WebhookSource & { secret: string }>("/api/webhook-sources", payload),
          source ? "来源已保存" : "来源已添加",
        );
        if (saved) onSaved(saved);
      }}
    >
      <Field label="来源名称" hint="例如发送事件的系统：GitHub Actions、监控告警。">
        <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      {source ? null : (
        <p className="small muted">密钥由系统生成。添加后，地址和密钥显示在来源卡片上，随时可以复制。</p>
      )}
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

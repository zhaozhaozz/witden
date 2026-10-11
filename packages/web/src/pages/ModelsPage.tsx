import { useState } from "react";
import { api } from "../api/client";
import type { ModelConfig } from "../api/types";
import { fmtNumber, fmtRelative, genericStatus } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useAction, useFeedback } from "../ui/feedback";
import { Capability, Empty, Field, FormModal, Handle, Loaded, PageHeader, StatusChip } from "../ui/kit";

export default function ModelsPage() {
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const [editing, setEditing] = useState<ModelConfig | "new" | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const res = useResource(() => api.get<ModelConfig[]>("/api/model-configs"), []);

  const replace = (m: ModelConfig) => res.setData((prev) => prev?.map((x) => (x.id === m.id ? { ...x, ...m } : x)));

  return (
    <div className="page">
      <PageHeader
        title="模型"
        sub="保存多套模型配置供不同角色使用。密钥加密保存且不会返回到页面；能够使用某个角色的成员不会因此获得它的密钥。"
        actions={
          <button className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
            新建模型配置
          </button>
        }
      />
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <div className="card-grid">
              {rows.map((m) => {
                const caps = m.capabilities ?? {};
                const errors = Object.entries(caps.errors ?? {});
                return (
                  <article key={m.id} className="card">
                    <header className="card-head">
                      <div>
                        <h3>{m.name}</h3>
                        <div className="small muted">
                          {m.provider === "anthropic" ? "Anthropic 协议" : "OpenAI 兼容协议"} · <code className="id">{m.model}</code>
                        </div>
                      </div>
                      <StatusChip meta={genericStatus(m.status)} compact />
                    </header>
                    <div className="small">
                      <code className="id break">{m.base_url}</code>
                    </div>
                    <div className="caps">
                      <Capability label="对话" value={caps.chat} error={caps.errors?.chat} falseLabel="不可用" />
                      <Capability label="工具调用" value={caps.tools} error={caps.errors?.tools} />
                      <Capability label="图像理解" value={caps.vision} error={caps.errors?.vision} />
                    </div>
                    {errors.length ? (
                      <ul className="warn-list">
                        {errors.map(([k, v]) => (
                          <li key={k}>
                            {k === "chat" ? "连接" : k === "tools" ? "工具调用" : k === "vision" ? "图像理解" : k}：{v}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {caps.tools === false || caps.vision === false ? (
                      <p className="small text-bad">
                        {caps.tools === false ? "不支持工具调用：使用它的角色只能对话。" : ""}
                        {caps.vision === false ? "不支持图像理解：桌面操作类任务会被拒绝。" : ""}
                      </p>
                    ) : null}
                    <dl className="kv kv-compact">
                      <div className="kv-row">
                        <dt>密钥</dt>
                        <dd>
                          {m.status === "revoked" ? (
                            <span className="text-bad">已撤销</span>
                          ) : m.has_api_key ? (
                            <>已设置{m.key_updated_at ? <span className="muted">（{fmtRelative(m.key_updated_at)}更新）</span> : null}</>
                          ) : (
                            <span className="muted">未设置</span>
                          )}
                        </dd>
                      </div>
                      <div className="kv-row">
                        <dt>今日用量</dt>
                        <dd>
                          {fmtNumber(m.tokens_today ?? 0)} tokens
                          {m.daily_token_limit ? <span className="muted"> / 上限 {fmtNumber(m.daily_token_limit)}</span> : null}
                        </dd>
                      </div>
                      <div className="kv-row">
                        <dt>使用的角色</dt>
                        <dd className="inline-list">
                          {m.used_by_roles?.length ? m.used_by_roles.map((h) => <Handle key={h} handle={h} />) : <span className="muted">无</span>}
                        </dd>
                      </div>
                      <div className="kv-row">
                        <dt>上次检测</dt>
                        <dd>{caps.checked_at ? fmtRelative(caps.checked_at) : <span className="muted">从未</span>}</dd>
                      </div>
                    </dl>
                    <footer className="card-foot">
                      <div className="btn-row">
                        <button
                          className="btn btn-xs btn-primary"
                          disabled={checking === m.id}
                          onClick={async () => {
                            setChecking(m.id);
                            const out = await run(() => api.post<ModelConfig>(`/api/model-configs/${m.id}/check`));
                            setChecking(null);
                            if (out) replace(out);
                          }}
                        >
                          {checking === m.id ? "检测中…" : "检测能力"}
                        </button>
                        <button className="btn btn-xs" onClick={() => setEditing(m)}>
                          编辑
                        </button>
                        {m.has_api_key && m.status !== "revoked" ? (
                          <button
                            className="btn btn-xs btn-danger-ghost"
                            disabled={busy}
                            onClick={async () => {
                              const ok = await confirm({
                                title: `撤销 ${m.name} 的密钥`,
                                body: <p>撤销后，使用这个配置的角色会立即无法调用模型，直到设置新的密钥。</p>,
                                danger: true,
                                confirmLabel: "撤销密钥",
                              });
                              if (!ok) return;
                              const out = await run(() => api.post<ModelConfig>(`/api/model-configs/${m.id}/revoke-key`), "密钥已撤销");
                              if (out) replace(out);
                            }}
                          >
                            撤销密钥
                          </button>
                        ) : null}
                        <button
                          className="btn btn-xs btn-danger-ghost"
                          disabled={busy || !!m.used_by_roles?.length}
                          title={m.used_by_roles?.length ? "仍有角色在使用，先为它们更换模型" : undefined}
                          onClick={async () => {
                            const ok = await confirm({ title: `删除 ${m.name}`, danger: true, confirmLabel: "删除" });
                            if (!ok) return;
                            const out = await run(() => api.del(`/api/model-configs/${m.id}`), "已删除");
                            if (out) void res.reload();
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </footer>
                  </article>
                );
              })}
            </div>
          ) : (
            <Empty
              title="还没有模型配置"
              hint="填写自有或第三方模型服务的地址、模型名称和密钥，保存后检测它是否支持工具调用和图像理解。"
              action={
                <button className="btn btn-primary" onClick={() => setEditing("new")}>
                  新建模型配置
                </button>
              }
            />
          )
        }
      </Loaded>
      {editing ? (
        <ModelEditor
          model={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void res.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function ModelEditor({ model, onClose, onSaved }: { model: ModelConfig | null; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(model?.name ?? "");
  const [provider, setProvider] = useState(model?.provider ?? "openai");
  const [baseUrl, setBaseUrl] = useState(model?.base_url ?? "");
  const [modelName, setModelName] = useState(model?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [params, setParams] = useState(model?.params && Object.keys(model.params).length ? JSON.stringify(model.params, null, 2) : "");
  const [limit, setLimit] = useState(model?.daily_token_limit?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    let parsed: unknown = {};
    if (params.trim()) {
      try {
        parsed = JSON.parse(params);
      } catch {
        setError("参数不是有效的 JSON");
        return;
      }
    }
    const body: Record<string, unknown> = {
      name: name.trim(),
      provider,
      base_url: baseUrl.trim(),
      model: modelName.trim(),
      params: parsed,
      daily_token_limit: limit.trim() ? Number(limit) : null,
    };
    // The key is write-only: omit it to keep the stored one.
    if (apiKey) body.api_key = apiKey;
    const out = await run(
      () => (model ? api.patch(`/api/model-configs/${model.id}`, body) : api.post("/api/model-configs", body)),
      model ? "已保存。地址、模型或密钥变化后需要重新检测能力" : "已创建，请检测能力",
    );
    if (out) onSaved();
  };

  return (
    <FormModal
      title={model ? `编辑 ${model.name}` : "新建模型配置"}
      busy={busy}
      width={620}
      disabled={!name.trim() || !baseUrl.trim() || !modelName.trim()}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {error ? <div className="error-note">{error}</div> : null}
      <div className="form-row">
        <Field label="名称">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：内部 Qwen" />
        </Field>
        <Field label="接口协议">
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </Field>
      </div>
      <Field label="API 地址" hint="例如 https://llm.internal.example.com/v1">
        <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field label="模型名称">
        <input className="mono" value={modelName} onChange={(e) => setModelName(e.target.value)} />
      </Field>
      <Field label="API 密钥" hint={model?.has_api_key ? "已设置密钥；留空保持不变" : "可选；自部署服务不需要时留空"}>
        <input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      <div className="form-row">
        <Field label="参数（JSON）" hint='例如 {"temperature": 0.3, "max_tokens": 4096}'>
          <textarea className="mono" rows={3} value={params} onChange={(e) => setParams(e.target.value)} />
        </Field>
        <Field label="每日 token 上限" hint="留空不限">
          <input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
        </Field>
      </div>
    </FormModal>
  );
}

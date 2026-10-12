import { useMemo, useState } from "react";
import { api } from "../api/client";
import type { ModelConfig, ModelProtocol, ModelProvider, RemoteModel } from "../api/types";
import { fmtNumber, fmtRelative, genericStatus } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useAction, useFeedback } from "../ui/feedback";
import {
  Capability,
  Empty,
  ErrorNote,
  Field,
  FormModal,
  Handle,
  Loaded,
  Loading,
  PageHeader,
  StatusChip,
  Tag,
  Toggle,
} from "../ui/kit";

const PROTOCOL_LABEL: Record<ModelProtocol, string> = { openai: "OpenAI 兼容协议", anthropic: "Anthropic 协议" };
const PROVIDER_STATUS: Record<ModelProvider["status"], { label: string; tone: "ok" | "bad" | "info" }> = {
  unchecked: { label: "未获取模型列表", tone: "info" },
  ok: { label: "连接正常", tone: "ok" },
  error: { label: "获取模型列表失败", tone: "bad" },
  revoked: { label: "密钥已撤销", tone: "bad" },
};

type Dialog =
  | { kind: "provider"; provider: ModelProvider | null }
  | { kind: "remote"; provider: ModelProvider }
  | { kind: "manual"; provider: ModelProvider }
  | { kind: "model"; model: ModelConfig };

export default function ModelsPage() {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const res = useResource(() => api.get<ModelProvider[]>("/api/model-providers"), []);
  const done = () => {
    setDialog(null);
    void res.reload();
  };

  return (
    <div className="page">
      <PageHeader
        title="模型"
        sub="按服务商管理模型：一个服务商（地址、协议、密钥）下可以有多个模型，模型可以从服务商的接口获取，也可以手动填写。密钥加密保存且不会返回到页面；能够使用某个角色的成员不会因此获得它的密钥。"
        actions={
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => setDialog({ kind: "provider", provider: null })}
          >
            添加服务商
          </button>
        }
      />
      <Loaded res={res}>
        {(providers) =>
          providers.length ? (
            <div className="provider-list">
              {providers.map((p) => (
                <ProviderCard key={p.id} provider={p} onDialog={setDialog} onChanged={() => void res.reload()} />
              ))}
            </div>
          ) : (
            <Empty
              title="还没有模型服务商"
              hint="添加自有或第三方模型服务（OpenAI 兼容接口或 Anthropic 接口）的地址和密钥，再从它的模型列表里选择模型，或手动填写模型名称。"
              action={
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setDialog({ kind: "provider", provider: null })}
                >
                  添加服务商
                </button>
              }
            />
          )
        }
      </Loaded>
      {dialog?.kind === "provider" ? (
        <ProviderEditor provider={dialog.provider} onClose={() => setDialog(null)} onSaved={done} />
      ) : null}
      {dialog?.kind === "remote" ? (
        <RemoteModelsDialog provider={dialog.provider} onClose={() => setDialog(null)} onSaved={done} />
      ) : null}
      {dialog?.kind === "manual" ? (
        <ManualModelsDialog provider={dialog.provider} onClose={() => setDialog(null)} onSaved={done} />
      ) : null}
      {dialog?.kind === "model" ? (
        <ModelEditor model={dialog.model} onClose={() => setDialog(null)} onSaved={done} />
      ) : null}
    </div>
  );
}

function ProviderCard({
  provider: p,
  onDialog,
  onChanged,
}: {
  provider: ModelProvider;
  onDialog: (d: Dialog) => void;
  onChanged: () => void;
}) {
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const manage = p.base_url !== undefined;
  const status = PROVIDER_STATUS[p.status] ?? { label: p.status, tone: "info" as const };
  const inUse = p.models.some((m) => m.used_by_roles?.length);

  return (
    <article className="section provider-card">
      <header className="provider-head">
        <div className="provider-title">
          <h2>{p.name}</h2>
          <span className="small muted">{PROTOCOL_LABEL[p.protocol] ?? p.protocol}</span>
          {manage ? <code className="id break small">{p.base_url}</code> : null}
        </div>
        <StatusChip meta={status} compact />
      </header>
      {manage ? (
        <div className="provider-meta small">
          <span>
            密钥：
            {p.status === "revoked" ? (
              <span className="text-bad">已撤销</span>
            ) : p.has_api_key ? (
              <>
                已设置
                {p.key_updated_at ? <span className="muted">（{fmtRelative(p.key_updated_at)}更新）</span> : null}
              </>
            ) : (
              <span className="muted">未设置</span>
            )}
          </span>
          <span>
            模型列表：
            {p.models_fetched_at ? (
              `${fmtRelative(p.models_fetched_at)}获取`
            ) : (
              <span className="muted">尚未从接口获取</span>
            )}
          </span>
        </div>
      ) : null}
      {p.status === "error" && p.status_detail ? <p className="small text-bad">{p.status_detail}</p> : null}

      {p.models.length ? (
        <div className="table-wrap">
          <table className="table model-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>能力</th>
                <th>状态</th>
                <th className="num">今日用量</th>
                <th>使用的角色</th>
                {manage ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {p.models.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  manage={manage}
                  onEdit={() => onDialog({ kind: "model", model: m })}
                  onChanged={onChanged}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted">这个服务商下还没有模型。从接口获取模型列表，或手动填写模型名称。</p>
      )}

      {manage ? (
        <footer className="card-foot">
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-xs btn-primary"
              disabled={p.status === "revoked"}
              title={p.status === "revoked" ? "密钥已撤销，先在编辑中设置新密钥" : undefined}
              onClick={() => onDialog({ kind: "remote", provider: p })}
            >
              从接口获取模型
            </button>
            <button type="button" className="btn btn-xs" onClick={() => onDialog({ kind: "manual", provider: p })}>
              手动添加模型
            </button>
            <button type="button" className="btn btn-xs" onClick={() => onDialog({ kind: "provider", provider: p })}>
              编辑服务商
            </button>
            {p.has_api_key && p.status !== "revoked" ? (
              <button
                type="button"
                className="btn btn-xs btn-danger-ghost"
                disabled={busy}
                onClick={async () => {
                  const ok = await confirm({
                    title: `撤销 ${p.name} 的密钥`,
                    body: <p>撤销后，使用这个服务商任何模型的角色都会立即无法调用模型，直到设置新的密钥。</p>,
                    danger: true,
                    confirmLabel: "撤销密钥",
                  });
                  if (!ok) return;
                  if (await run(() => api.post(`/api/model-providers/${p.id}/revoke-key`), "密钥已撤销")) onChanged();
                }}
              >
                撤销密钥
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-xs btn-danger-ghost"
              disabled={busy || inUse}
              title={inUse ? "仍有角色在使用它的模型，先为它们更换模型" : undefined}
              onClick={async () => {
                const ok = await confirm({
                  title: `删除服务商 ${p.name}`,
                  body: <p>它下面的 {p.models.length} 个模型会一起删除。</p>,
                  danger: true,
                  confirmLabel: "删除",
                });
                if (!ok) return;
                if (await run(() => api.del(`/api/model-providers/${p.id}`), "已删除")) onChanged();
              }}
            >
              删除服务商
            </button>
          </div>
        </footer>
      ) : null}
    </article>
  );
}

function ModelRow({
  model: m,
  manage,
  onEdit,
  onChanged,
}: {
  model: ModelConfig;
  manage: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const [checking, setChecking] = useState(false);
  const caps = m.capabilities ?? {};
  const errors = Object.entries(caps.errors ?? {});
  return (
    <tr className={m.enabled ? undefined : "row-off"}>
      <td>
        <div className="model-name">
          <strong>{m.name}</strong>
          <Tag title={m.source === "api" ? "从服务商的模型列表中选择" : "手动填写"}>
            {m.source === "api" ? "接口" : "手动"}
          </Tag>
        </div>
        {m.name !== m.model ? <code className="id small">{m.model}</code> : null}
        {Object.keys(m.params ?? {}).length ? <div className="small muted mono">{JSON.stringify(m.params)}</div> : null}
      </td>
      <td>
        <div className="caps">
          <Capability label="对话" value={caps.chat} error={caps.errors?.chat} falseLabel="不可用" />
          <Capability label="工具" value={caps.tools} error={caps.errors?.tools} />
          <Capability label="图像" value={caps.vision} error={caps.errors?.vision} />
        </div>
        {errors.length ? (
          <div className="small text-bad" title={errors.map(([k, v]) => `${k}: ${v}`).join("\n")}>
            {caps.chat === false ? "连接失败" : "部分能力不可用"}（悬停查看原因）
          </div>
        ) : null}
        <div className="small muted">{caps.checked_at ? `${fmtRelative(caps.checked_at)}检测` : "从未检测"}</div>
      </td>
      <td>{m.enabled ? <StatusChip meta={genericStatus(m.status)} compact /> : <Tag>已停用</Tag>}</td>
      <td className="num">
        {fmtNumber(m.tokens_today ?? 0)}
        {m.daily_token_limit ? <div className="small muted">上限 {fmtNumber(m.daily_token_limit)}</div> : null}
      </td>
      <td>
        <span className="inline-list">
          {m.used_by_roles?.length ? (
            m.used_by_roles.map((h) => <Handle key={h} handle={h} />)
          ) : (
            <span className="muted">无</span>
          )}
        </span>
      </td>
      {manage ? (
        <td className="row-actions">
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-xs"
              disabled={checking || !m.usable}
              title={m.usable ? "用三个小请求检测对话、工具调用和图像理解" : "模型已停用或服务商密钥已撤销"}
              onClick={async () => {
                setChecking(true);
                const out = await run(() => api.post<ModelConfig>(`/api/models/${m.id}/check`));
                setChecking(false);
                if (out) onChanged();
              }}
            >
              {checking ? "检测中…" : "检测能力"}
            </button>
            <button type="button" className="btn btn-xs" onClick={onEdit}>
              编辑
            </button>
            <button
              type="button"
              className="btn btn-xs btn-danger-ghost"
              disabled={busy || !!m.used_by_roles?.length}
              title={m.used_by_roles?.length ? "仍有角色在使用，先为它们更换模型" : undefined}
              onClick={async () => {
                const ok = await confirm({ title: `删除模型 ${m.label}`, danger: true, confirmLabel: "删除" });
                if (!ok) return;
                if (await run(() => api.del(`/api/models/${m.id}`), "已删除")) onChanged();
              }}
            >
              删除
            </button>
          </div>
        </td>
      ) : null}
    </tr>
  );
}

function ProviderEditor({
  provider,
  onClose,
  onSaved,
}: {
  provider: ModelProvider | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { run, busy } = useAction();
  const [name, setName] = useState(provider?.name ?? "");
  const [protocol, setProtocol] = useState<ModelProtocol>(provider?.protocol ?? "openai");
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");

  const addressChanged = !!provider && (protocol !== provider.protocol || baseUrl.trim() !== provider.base_url);
  const submit = async () => {
    const body: Record<string, unknown> = { name: name.trim(), protocol, base_url: baseUrl.trim() };
    // The key is write-only: omit it to keep the stored one.
    if (apiKey) body.api_key = apiKey;
    if (!provider) {
      const list = parseModelLines(models);
      if (list.length) body.models = list;
    }
    const out = await run(
      () =>
        provider ? api.patch(`/api/model-providers/${provider.id}`, body) : api.post("/api/model-providers", body),
      provider ? "已保存" : "已添加服务商",
    );
    if (out) onSaved();
  };

  return (
    <FormModal
      title={provider ? `编辑服务商 ${provider.name}` : "添加模型服务商"}
      busy={busy}
      width={620}
      disabled={!name.trim() || !baseUrl.trim()}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <div className="form-row">
        <Field label="名称">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：内部 vLLM、DeepSeek" />
        </Field>
        <Field label="接口协议">
          <select value={protocol} onChange={(e) => setProtocol(e.target.value as ModelProtocol)}>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </Field>
      </div>
      <Field
        label="API 地址"
        hint={
          protocol === "anthropic"
            ? "例如 https://api.anthropic.com（不含 /v1）"
            : "例如 https://llm.internal.example.com/v1（模型列表取自 {地址}/models）"
        }
      >
        <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field
        label="API 密钥"
        hint={
          addressChanged && provider?.has_api_key
            ? "地址或协议变了：已保存的密钥不会发往新地址，请重新填写"
            : provider?.has_api_key
              ? "已设置密钥；留空保持不变"
              : "可选；自部署服务不需要时留空"
        }
      >
        <input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      {provider ? (
        <p className="small muted">更换地址或密钥后，这个服务商下的模型需要重新检测能力。</p>
      ) : (
        <Field label="模型（可选）" hint="每行一个模型名称，可写成「模型名称 | 显示名」；也可以保存后从接口获取">
          <textarea className="mono" rows={3} value={models} onChange={(e) => setModels(e.target.value)} />
        </Field>
      )}
    </FormModal>
  );
}

/** "model-id" or "model-id | display name" per line. */
function parseModelLines(text: string): { model: string; name?: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [model, ...rest] = line.split("|");
      const name = rest.join("|").trim();
      return name ? { model: model.trim(), name } : { model: model.trim() };
    });
}

function RemoteModelsDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: ModelProvider;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { run, busy } = useAction();
  const res = useResource(
    () => api.get<{ models: RemoteModel[] }>(`/api/model-providers/${provider.id}/remote-models`),
    [provider.id],
  );
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (res.data?.models ?? []).filter(
      (m) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q),
    );
  }, [res.data, filter]);
  const selectable = shown.filter((m) => !m.added);
  const allPicked = selectable.length > 0 && selectable.every((m) => picked.has(m.id));
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const submit = async () => {
    const byId = new Map((res.data?.models ?? []).map((m) => [m.id, m]));
    const models = [...picked].map((id) => ({
      model: id,
      ...(byId.get(id)?.name ? { name: byId.get(id)?.name } : {}),
    }));
    const out = await run(
      () => api.post(`/api/model-providers/${provider.id}/models`, { models, source: "api" }),
      `已添加 ${models.length} 个模型`,
    );
    if (out) onSaved();
  };

  return (
    <FormModal
      title={`从 ${provider.name} 获取模型`}
      busy={busy}
      width={640}
      submitLabel={picked.size ? `添加所选（${picked.size}）` : "添加所选"}
      disabled={!picked.size}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {res.loading && !res.data ? <Loading label="正在向服务商查询模型列表" /> : null}
      {res.error ? (
        <ErrorNote
          error={`获取失败：${res.error}。可以检查地址和密钥，或改为手动添加模型。`}
          onRetry={() => void res.reload()}
        />
      ) : null}
      {res.data ? (
        <>
          <div className="remote-toolbar">
            <input
              type="search"
              placeholder={`在 ${res.data.models.length} 个模型中筛选`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Toggle
              checked={allPicked}
              disabled={!selectable.length}
              label={filter ? "全选筛选结果" : "全选"}
              onChange={(on) => {
                for (const m of selectable) toggle(m.id, on);
              }}
            />
          </div>
          {shown.length ? (
            <ul className="remote-models">
              {shown.map((m) => (
                <li key={m.id}>
                  <label className={m.added ? "muted" : undefined}>
                    <input
                      type="checkbox"
                      checked={m.added || picked.has(m.id)}
                      disabled={m.added}
                      onChange={(e) => toggle(m.id, e.target.checked)}
                    />
                    <code className="id">{m.id}</code>
                    {m.name && m.name !== m.id ? <span className="small">{m.name}</span> : null}
                    {m.added ? <Tag>已添加</Tag> : null}
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">
              {res.data.models.length ? "没有匹配的模型" : "服务商没有返回任何模型，可以手动添加。"}
            </p>
          )}
        </>
      ) : null}
    </FormModal>
  );
}

function ManualModelsDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: ModelProvider;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { run, busy } = useAction();
  const [text, setText] = useState("");
  const list = parseModelLines(text);
  const submit = async () => {
    const out = await run(
      () =>
        api.post<{ added: ModelConfig[]; skipped: number }>(`/api/model-providers/${provider.id}/models`, {
          models: list,
        }),
      "已添加（已存在的模型会跳过）",
    );
    if (out) onSaved();
  };
  return (
    <FormModal
      title={`手动添加模型到 ${provider.name}`}
      busy={busy}
      width={560}
      submitLabel={list.length ? `添加（${list.length}）` : "添加"}
      disabled={!list.length}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <Field
        label="模型名称"
        hint="每行一个，填写服务商接口使用的模型名称；可写成「模型名称 | 显示名」。已存在的会跳过。"
      >
        <textarea
          className="mono"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"qwen2.5-72b-instruct\ndeepseek-chat | DeepSeek V3"}
        />
      </Field>
    </FormModal>
  );
}

function ModelEditor({ model, onClose, onSaved }: { model: ModelConfig; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(model.name);
  const [params, setParams] = useState(
    Object.keys(model.params ?? {}).length ? JSON.stringify(model.params, null, 2) : "",
  );
  const [limit, setLimit] = useState(model.daily_token_limit?.toString() ?? "");
  const [enabled, setEnabled] = useState(model.enabled);
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
    const out = await run(
      () =>
        api.patch(`/api/models/${model.id}`, {
          name: name.trim() || model.model,
          params: parsed,
          daily_token_limit: limit.trim() ? Number(limit) : null,
          enabled,
        }),
      "已保存",
    );
    if (out) onSaved();
  };

  return (
    <FormModal
      title={`编辑模型 ${model.label}`}
      busy={busy}
      width={560}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {error ? <div className="error-note">{error}</div> : null}
      <Field label="模型名称（接口使用）">
        <input className="mono" value={model.model} disabled />
      </Field>
      <Field label="显示名">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={model.model} />
      </Field>
      <div className="form-row">
        <Field label="参数（JSON）" hint='调用时附带，例如 {"temperature": 0.3, "max_tokens": 4096}'>
          <textarea className="mono" rows={3} value={params} onChange={(e) => setParams(e.target.value)} />
        </Field>
        <Field label="每日 token 上限" hint="留空不限">
          <input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
        </Field>
      </div>
      <Toggle
        checked={enabled}
        onChange={setEnabled}
        label={enabled ? "启用：角色可以使用这个模型" : "停用：使用它的角色会无法工作，直到重新启用"}
      />
    </FormModal>
  );
}

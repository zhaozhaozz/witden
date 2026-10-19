import { useState } from "react";
import { api } from "../api/client";
import type { ModelConfig, ModelProtocol, ModelProvider } from "../api/types";
import { useConfigChanged } from "../lib/configEvents";
import { fmtLatency, fmtNumber, fmtRelative, fmtTokens, genericStatus, SYSTEM_ONE_HINT } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useDirectory } from "../lib/session";
import { useChanged, useUnsavedChanges } from "../lib/unsaved";
import { useAction, useFeedback } from "../ui/feedback";
import {
  Capability,
  Empty,
  Field,
  FormModal,
  Handle,
  Loaded,
  PageHeader,
  RoleBadge,
  StatusChip,
  Tag,
  Toggle,
} from "../ui/kit";
import {
  addModels,
  type ModelChoice,
  ModelPicker,
  type ServiceDraft,
  ServiceFields,
  saveService,
  serviceDraft,
  serviceReady,
} from "./modelParts";

/** Where a model's context window came from (shown on hover, and as the default in the editor). */
const CONTEXT_SOURCE: Record<string, string> = {
  model: "在这里设置的值",
  provider: "服务商报告的值",
  family: "已知模型的推荐值",
  default: "未知模型的保守默认值",
};

const PROTOCOL_LABEL: Record<ModelProtocol, string> = {
  openai: "OpenAI 兼容协议",
  anthropic: "Anthropic 协议",
  systemone: "System One 协议（Jev、Laya）",
};
const PROVIDER_STATUS: Record<ModelProvider["status"], { label: string; tone: "ok" | "bad" | "info" }> = {
  unchecked: { label: "未获取模型列表", tone: "info" },
  ok: { label: "连接正常", tone: "ok" },
  error: { label: "获取模型列表失败", tone: "bad" },
  revoked: { label: "密钥已撤销", tone: "bad" },
};

type Dialog =
  | { kind: "provider"; provider: ModelProvider | null }
  | { kind: "models"; provider: ModelProvider }
  | { kind: "model"; model: ModelConfig; systemOne: boolean };

export default function ModelsPage() {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const res = useResource(() => api.get<ModelProvider[]>("/api/model-providers"), []);
  useConfigChanged(["models"], res.reload);
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
              hint="添加自有或第三方模型服务（OpenAI 兼容接口、Anthropic 接口，或 TypeSafe Jev、Laya 等 System One 接口）的地址和密钥，再从它的模型列表里选择模型，或手动填写模型名称。"
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
        <ProviderEditor
          provider={dialog.provider}
          onClose={() => setDialog(null)}
          onSaved={(saved, created) => {
            void res.reload();
            // A new service: go straight on to choosing its models.
            setDialog(created ? { kind: "models", provider: saved } : null);
          }}
        />
      ) : null}
      {dialog?.kind === "models" ? (
        <AddModelsDialog provider={dialog.provider} onClose={() => setDialog(null)} onSaved={done} />
      ) : null}
      {dialog?.kind === "model" ? (
        <ModelEditor model={dialog.model} systemOne={dialog.systemOne} onClose={() => setDialog(null)} onSaved={done} />
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
      {p.protocol === "systemone" ? <p className="small muted">{SYSTEM_ONE_HINT}</p> : null}

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
                  systemOne={p.protocol === "systemone"}
                  manage={manage}
                  onEdit={() => onDialog({ kind: "model", model: m, systemOne: p.protocol === "systemone" })}
                  onChanged={onChanged}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted">这个服务商下还没有模型。点击“添加模型”，从它的模型列表中选择，或填写模型名称。</p>
      )}

      {manage ? (
        <footer className="card-foot">
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-xs btn-primary"
              disabled={p.status === "revoked"}
              title={p.status === "revoked" ? "密钥已撤销，先在编辑中设置新密钥" : undefined}
              onClick={() => onDialog({ kind: "models", provider: p })}
            >
              添加模型
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
  systemOne,
  manage,
  onEdit,
  onChanged,
}: {
  model: ModelConfig;
  /** A System One decision model: checked with one question, no chat, tools or images. */
  systemOne: boolean;
  manage: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const dir = useDirectory();
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
          {systemOne ? (
            <Capability label="决策" value={caps.decide} error={caps.errors?.decide} falseLabel="不可用" />
          ) : (
            <>
              <Capability label="对话" value={caps.chat} error={caps.errors?.chat} falseLabel="不可用" />
              <Capability label="工具" value={caps.tools} error={caps.errors?.tools} />
              <Capability label="图像" value={caps.vision} error={caps.errors?.vision} />
            </>
          )}
        </div>
        {errors.length ? (
          <div className="small text-bad" title={errors.map(([k, v]) => `${k}: ${v}`).join("\n")}>
            {systemOne || caps.chat === false ? "检测未通过" : "部分能力不可用"}（悬停查看原因）
          </div>
        ) : null}
        {caps.latency_ms !== undefined && (caps.chat || caps.decide) ? (
          <div className="small muted">响应 {fmtLatency(caps.latency_ms)}</div>
        ) : null}
        {m.effort && m.effort.source !== "common" ? (
          <div className="small muted" title={m.effort.source === "service" ? "模型服务报告" : "witden 已知的模型"}>
            {m.effort.levels.length ? `思考程度：${m.effort.levels.join(" · ")}` : "没有思考程度设置"}
          </div>
        ) : null}
        {m.context ? (
          <div className="small muted" title={CONTEXT_SOURCE[m.context.source]}>
            上下文 {fmtTokens(m.context.window)} · {fmtTokens(m.context.compact_at)} 时整理对话
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
            m.used_by_roles.map((h) => {
              const r = dir.roles.find((x) => x.handle === h);
              return r ? <RoleBadge key={h} role={r} compact /> : <Handle key={h} handle={h} />;
            })
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
              title={
                !m.usable
                  ? "模型已停用或服务商密钥已撤销"
                  : systemOne
                    ? "用一个答案明确的问题检测连接、回答是否正确和响应时间"
                    : "用三个小请求检测对话、工具调用和图像理解"
              }
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

/** Add or edit a service with the same form as the first-run guide (modelParts.tsx). */
function ProviderEditor({
  provider,
  onClose,
  onSaved,
}: {
  provider: ModelProvider | null;
  onClose: () => void;
  onSaved: (saved: ModelProvider, created: boolean) => void;
}) {
  const { run, busy } = useAction();
  const [value, setValue] = useState<ServiceDraft>(() => serviceDraft(provider));
  const [changed] = useChanged(value);
  const submit = async (): Promise<boolean> => {
    const out = await run(() => saveService(value, provider), provider ? "已保存" : "已添加服务商");
    if (out) onSaved(out, !provider);
    return !!out;
  };
  useUnsavedChanges(changed, submit);
  return (
    <FormModal
      title={provider ? `编辑服务商 ${provider.name}` : "添加模型服务商"}
      busy={busy}
      width={640}
      submitLabel={provider ? "保存" : "添加，下一步选择模型"}
      disabled={!value.name.trim() || !serviceReady(value, provider)}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {provider ? <p className="small muted">更换地址或密钥后，这个服务商下的模型需要重新检测能力。</p> : null}
      <ServiceFields value={value} onChange={setValue} existing={provider} decision />
    </FormModal>
  );
}

/** Choose models from the service's list or by name (the same picker as the first-run guide). */
function AddModelsDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: ModelProvider;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { run, busy } = useAction();
  const [choices, setChoices] = useState<ModelChoice[]>([]);
  const submit = async () => {
    const out = await run(() => addModels(provider, choices), `已添加（已存在的模型会跳过）`);
    if (out) onSaved();
  };
  return (
    <FormModal
      title={`为 ${provider.name} 添加模型`}
      busy={busy}
      width={640}
      submitLabel={choices.length ? `添加（${choices.length}）` : "添加"}
      disabled={!choices.length}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {provider.protocol === "systemone" ? <p className="small muted">{SYSTEM_ONE_MODELS}</p> : null}
      <ModelPicker provider={provider} multiple onChange={setChoices} />
    </FormModal>
  );
}

const SYSTEM_ONE_MODELS =
  "Jev 一般选 jev-latest；自部署的 Laya 没有模型列表，中文对话填 multilingual，纯英文可填 english。";

function ModelEditor({
  model,
  systemOne,
  onClose,
  onSaved,
}: {
  model: ModelConfig;
  systemOne: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { run, busy } = useAction();
  const [name, setName] = useState(model.name);
  const [params, setParams] = useState(
    Object.keys(model.params ?? {}).length ? JSON.stringify(model.params, null, 2) : "",
  );
  const [limit, setLimit] = useState(model.daily_token_limit?.toString() ?? "");
  const [ctxWindow, setCtxWindow] = useState(model.context_window?.toString() ?? "");
  const [compact, setCompact] = useState(model.compact_tokens?.toString() ?? "");
  const [enabled, setEnabled] = useState(model.enabled);
  const [error, setError] = useState<string | null>(null);
  const [changed] = useChanged({ name, params, limit, ctxWindow, compact, enabled });
  // What applies when a field is left empty: the provider's report or the recommendation for the model.
  const effective = model.context;
  const shownWindow = ctxWindow.trim() ? Number(ctxWindow) : model.context_window ? null : effective?.window;

  const submit = async (): Promise<boolean> => {
    let parsed: unknown = {};
    if (params.trim()) {
      try {
        parsed = JSON.parse(params);
      } catch {
        setError("参数不是有效的 JSON");
        return false;
      }
    }
    const out = await run(
      () =>
        api.patch(`/api/models/${model.id}`, {
          name: name.trim() || model.model,
          params: parsed,
          daily_token_limit: limit.trim() ? Number(limit) : null,
          ...(systemOne
            ? {}
            : {
                context_window: ctxWindow.trim() ? Number(ctxWindow) : null,
                compact_tokens: compact.trim() ? Number(compact) : null,
              }),
          enabled,
        }),
      "已保存",
    );
    if (out) onSaved();
    return !!out;
  };
  useUnsavedChanges(changed, submit);

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
        <Field
          label="参数（JSON）"
          hint={
            systemOne
              ? '调用时附带，例如 Laya 的 {"max_len": 2048}（一次读入的最大 token 数）'
              : '调用时附带，例如 {"temperature": 0.3, "max_tokens": 4096}'
          }
        >
          <textarea className="mono" rows={3} value={params} onChange={(e) => setParams(e.target.value)} />
        </Field>
        <Field label="每日 token 上限" hint="留空不限">
          <input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
        </Field>
      </div>
      {systemOne ? null : (
        <div className="form-row">
          <Field
            label="上下文长度（tokens）"
            hint={
              effective && !model.context_window
                ? `留空按${CONTEXT_SOURCE[effective.source]}：${fmtNumber(effective.window)}`
                : "留空按服务商报告或已知模型的推荐值"
            }
          >
            <input
              type="number"
              min={1024}
              value={ctxWindow}
              placeholder={effective && !model.context_window ? String(effective.window) : ""}
              onChange={(e) => setCtxWindow(e.target.value)}
            />
          </Field>
          <Field
            label="整理对话的阈值（tokens）"
            hint={`角色在一个话题里的对话达到这个大小时，把前面的内容压缩成摘要；留空为上下文长度的 3/4${
              shownWindow ? `（${fmtNumber(Math.floor(shownWindow * 0.75))}）` : ""
            }`}
          >
            <input type="number" min={1024} value={compact} onChange={(e) => setCompact(e.target.value)} />
          </Field>
        </div>
      )}
      <Toggle
        checked={enabled}
        onChange={setEnabled}
        label={
          systemOne
            ? enabled
              ? "启用：可以用作话题调度模型"
              : "停用：用它做话题调度时，自动模式的多角色话题不会把消息交给角色"
            : enabled
              ? "启用：角色可以使用这个模型"
              : "停用：使用它的角色会无法工作，直到重新启用"
        }
      />
    </FormModal>
  );
}

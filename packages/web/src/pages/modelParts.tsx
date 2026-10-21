import { useMemo, useState } from "react";
import { api } from "../api/client";
import type { ModelConfig, ModelProtocol, ModelProvider, RemoteModel } from "../api/types";
import { useResource } from "../lib/hooks";
import { ErrorNote, Field, Loading, Tag } from "../ui/kit";

/**
 * Model services, shared by the first-run guide and the models page: one form for a service (with presets for
 * the common ones), one picker for its models, one model select. There is no second way to set these up.
 */

export interface ServicePreset {
  key: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  /** A System One decision model service (not offered where a chat model is needed). */
  decision?: boolean;
  hint?: string;
}

export const SERVICE_PRESETS: ServicePreset[] = [
  { key: "openai", label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1" },
  { key: "anthropic", label: "Anthropic（Claude）", protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  { key: "deepseek", label: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com" },
  {
    key: "qwen",
    label: "通义千问（阿里云百炼）",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  { key: "kimi", label: "Kimi（月之暗面）", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1" },
  { key: "zhipu", label: "智谱 GLM", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { key: "openrouter", label: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  {
    key: "jev",
    label: "TypeSafe Jev",
    protocol: "systemone",
    baseUrl: "https://api.typesafe.ai",
    decision: true,
  },
  {
    key: "laya",
    label: "Laya（自部署）",
    protocol: "systemone",
    baseUrl: "",
    decision: true,
    hint: "自部署的 Laya 填 http://主机:8000；用 Compose 中的 Laya 服务时，它会被自动添加，不需要在这里填写。",
  },
  {
    key: "custom",
    label: "其他服务",
    protocol: "openai",
    baseUrl: "",
    hint: "OpenAI 兼容接口（如 vLLM、Ollama）填写含 /v1 的地址；Anthropic 接口不含 /v1。地址要能从 witden 服务器访问到。",
  },
];

/** A service as the form edits it. */
export interface ServiceDraft {
  preset: string;
  name: string;
  protocol: ModelProtocol;
  baseUrl: string;
  /** Write-only: empty keeps a saved key. */
  apiKey: string;
}

export function serviceDraft(provider?: ModelProvider | null): ServiceDraft {
  if (provider)
    return {
      preset: "custom",
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.base_url ?? "",
      apiKey: "",
    };
  const first = SERVICE_PRESETS[0];
  return { preset: first.key, name: first.label, protocol: first.protocol, baseUrl: first.baseUrl, apiKey: "" };
}

const presetOf = (key: string) =>
  SERVICE_PRESETS.find((p) => p.key === key) ?? SERVICE_PRESETS[SERVICE_PRESETS.length - 1];

/** The service form: presets for a new one, then protocol (for other services), name, address and key. */
export function ServiceFields({
  value,
  onChange,
  existing,
  decision = false,
  showName = true,
}: {
  value: ServiceDraft;
  onChange: (next: ServiceDraft) => void;
  /** Editing a saved service: no presets; its key stays unless a new one is entered. */
  existing?: ModelProvider | null;
  /** Offer System One decision model services too. */
  decision?: boolean;
  showName?: boolean;
}) {
  const preset = presetOf(value.preset);
  const presets = SERVICE_PRESETS.filter((p) => decision || !p.decision);
  const set = (patch: Partial<ServiceDraft>) => onChange({ ...value, ...patch });
  const choose = (p: ServicePreset) =>
    set({
      preset: p.key,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      // The name follows the preset until someone types their own.
      name: !value.name || value.name === preset.label ? (p.key === "custom" ? "" : p.label) : value.name,
    });
  const addressChanged =
    !!existing && (value.protocol !== existing.protocol || value.baseUrl.trim() !== (existing.base_url ?? ""));
  const keyHint =
    existing?.has_api_key && addressChanged
      ? "地址或协议变了：已保存的密钥不会发往新地址，请重新填写"
      : existing?.has_api_key
        ? "已设置密钥（不可查看）；留空保持不变"
        : value.protocol === "systemone"
          ? "Jev 填 TypeSafe 或 OpenRouter 的密钥；自部署的 Laya 填它的 LAYA_API_KEY，未设置时留空"
          : `在模型服务的控制台中创建。witden 加密保存，之后在任何地方都不会显示出来${
              value.preset === "custom" ? "；自部署的服务不需要时留空" : ""
            }`;
  return (
    <>
      {existing ? null : (
        <Field label="模型服务" hint="选择常见服务会自动填好地址和协议；列表里没有的选“其他服务”">
          <select value={value.preset} onChange={(e) => choose(presetOf(e.target.value))}>
            <optgroup label="对话模型">
              {presets
                .filter((p) => !p.decision && p.key !== "custom")
                .map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
            </optgroup>
            {decision ? (
              <optgroup label="调度用的决策模型（System One）">
                {presets
                  .filter((p) => p.decision)
                  .map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
              </optgroup>
            ) : null}
            <option value="custom">其他服务</option>
          </select>
        </Field>
      )}
      {existing || value.preset === "custom" ? (
        <Field label="接口协议">
          <select value={value.protocol} onChange={(e) => set({ protocol: e.target.value as ModelProtocol })}>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
            {decision || value.protocol === "systemone" ? (
              <option value="systemone">System One（TypeSafe Jev、Laya）</option>
            ) : null}
          </select>
        </Field>
      ) : null}
      {showName ? (
        <Field label="名称" hint="在 witden 中区分不同的服务">
          <input value={value.name} onChange={(e) => set({ name: e.target.value })} placeholder="例如：内部 vLLM" />
        </Field>
      ) : null}
      <Field label="API 地址" hint={preset.hint && !existing ? preset.hint : undefined}>
        <input className="mono" value={value.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
      </Field>
      <Field label="API Key" hint={keyHint}>
        <input
          type="password"
          autoComplete="new-password"
          value={value.apiKey}
          onChange={(e) => set({ apiKey: e.target.value })}
        />
      </Field>
    </>
  );
}

/** A key is needed for the presets of hosted services; other services may not use one. */
export const serviceReady = (value: ServiceDraft, existing?: ModelProvider | null) =>
  !!value.baseUrl.trim() &&
  (!!value.apiKey || !!existing?.has_api_key || value.preset === "custom" || value.preset === "laya");

/** Create the service (under a free name) or save changes to it. */
export async function saveService(value: ServiceDraft, existing?: ModelProvider | null): Promise<ModelProvider> {
  const body: Record<string, unknown> = { protocol: value.protocol, base_url: value.baseUrl.trim() };
  if (value.apiKey) body.api_key = value.apiKey;
  if (existing)
    return api.patch<ModelProvider>(`/api/model-providers/${existing.id}`, { ...body, name: value.name.trim() });
  const taken = new Set((await api.get<ModelProvider[]>("/api/model-providers")).map((p) => p.name));
  const base = value.name.trim() || "模型服务";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
  return api.post<ModelProvider>("/api/model-providers", { ...body, name });
}

/** Models chosen in the picker: from the service's list, or typed by name ("id" or "id | display name"). */
export interface ModelChoice {
  model: string;
  name?: string;
  fromList: boolean;
  /** The context window the service's list reported for it. */
  contextWindow?: number;
  /** Its largest answer in tokens, as the service's list reported it. */
  maxOutput?: number;
}

function typedModels(text: string): ModelChoice[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [model, ...rest] = line.split("|");
      const name = rest.join("|").trim();
      return { model: model.trim(), ...(name ? { name } : {}), fromList: false };
    });
}

/** Pick models from the service's own list, or type their names; one model or several. */
export function ModelPicker({
  provider,
  multiple,
  onChange,
}: {
  provider: ModelProvider;
  multiple: boolean;
  onChange: (choices: ModelChoice[]) => void;
}) {
  const res = useResource(
    () => api.get<{ models: RemoteModel[] }>(`/api/model-providers/${provider.id}/remote-models`),
    [provider.id],
  );
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const remote = res.data?.models ?? [];
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return remote.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q));
  }, [remote, filter]);
  const emit = (ids: string[], text: string) => {
    setPicked(ids);
    setTyped(text);
    const byId = new Map(remote.map((m) => [m.id, m]));
    const fromList = ids.map((id) => ({
      model: id,
      ...(byId.get(id)?.name ? { name: byId.get(id)!.name! } : {}),
      ...(byId.get(id)?.context_window ? { contextWindow: byId.get(id)!.context_window! } : {}),
      ...(byId.get(id)?.max_output_tokens ? { maxOutput: byId.get(id)!.max_output_tokens! } : {}),
      fromList: true,
    }));
    const typedOnes = typedModels(text).filter((t) => !ids.includes(t.model));
    onChange(
      multiple ? [...fromList, ...typedOnes] : (typedOnes[0] && !ids.length ? [typedOnes[0]] : fromList).slice(0, 1),
    );
  };
  const toggle = (id: string, on: boolean) =>
    emit(multiple ? (on ? [...picked, id] : picked.filter((x) => x !== id)) : on ? [id] : [], multiple ? typed : "");
  const selectable = shown.filter((m) => !m.added);
  const allPicked = multiple && selectable.length > 0 && selectable.every((m) => picked.includes(m.id));

  return (
    <>
      {res.loading && !res.data ? <Loading label="正在向服务查询模型列表" /> : null}
      {res.error ? (
        <ErrorNote
          error={`没能取到模型列表：${res.error}。可以检查地址和 API Key，或在下面直接填写模型名称。`}
          onRetry={() => void res.reload()}
        />
      ) : null}
      {remote.length ? (
        <>
          <div className="remote-toolbar">
            <input
              type="search"
              placeholder={`在 ${remote.length} 个模型中筛选`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {multiple ? (
              <label className="small">
                <input
                  type="checkbox"
                  checked={allPicked}
                  disabled={!selectable.length}
                  onChange={(e) =>
                    emit(
                      e.target.checked
                        ? [...new Set([...picked, ...selectable.map((m) => m.id)])]
                        : picked.filter((id) => !selectable.some((m) => m.id === id)),
                      typed,
                    )
                  }
                />{" "}
                {filter ? "全选筛选结果" : "全选"}
              </label>
            ) : null}
          </div>
          <ul className="remote-models">
            {shown.slice(0, 500).map((m) => (
              <li key={m.id}>
                <label className={m.added && multiple ? "muted" : undefined}>
                  <input
                    type={multiple ? "checkbox" : "radio"}
                    name="model-pick"
                    checked={(m.added && multiple) || picked.includes(m.id)}
                    disabled={m.added && multiple}
                    onChange={(e) => toggle(m.id, e.target.checked)}
                  />
                  <code className="id">{m.id}</code>
                  {m.name && m.name !== m.id ? <span className="small">{m.name}</span> : null}
                  {m.added ? <Tag>已添加</Tag> : null}
                </label>
              </li>
            ))}
          </ul>
          {shown.length ? null : <p className="small muted">没有匹配的模型</p>}
        </>
      ) : res.data ? (
        <p className="small muted">服务没有返回任何模型，可以在下面填写模型名称。</p>
      ) : null}
      <Field
        label={remote.length ? "或填写模型名称" : "模型名称"}
        hint={
          multiple
            ? "每行一个，填写服务接口使用的名称；可写成「模型名称 | 显示名」。已存在的会跳过。"
            : "填写服务接口使用的名称，例如 gpt-4o、deepseek-chat、qwen-plus。"
        }
      >
        {multiple ? (
          <textarea className="mono" rows={3} value={typed} onChange={(e) => emit(picked, e.target.value)} />
        ) : (
          <input className="mono" value={typed} onChange={(e) => emit([], e.target.value)} />
        )}
      </Field>
    </>
  );
}

/** Add the chosen models to the service (ones it has are skipped) and return them as configured. */
export async function addModels(provider: ModelProvider, choices: ModelChoice[]): Promise<ModelConfig[]> {
  const strip = ({ model, name, contextWindow, maxOutput }: ModelChoice) => ({
    model,
    ...(name ? { name } : {}),
    ...(contextWindow ? { context_window: contextWindow } : {}),
    ...(maxOutput ? { max_output_tokens: maxOutput } : {}),
  });
  const listed = choices.filter((c) => c.fromList).map(strip);
  const typed = choices.filter((c) => !c.fromList).map(strip);
  if (listed.length) await api.post(`/api/model-providers/${provider.id}/models`, { models: listed, source: "api" });
  if (typed.length) await api.post(`/api/model-providers/${provider.id}/models`, { models: typed });
  const wanted = new Set(choices.map((c) => c.model));
  return (await api.get<ModelConfig[]>("/api/models")).filter(
    (m) => m.provider?.id === provider.id && wanted.has(m.model),
  );
}

/** A model select grouped by service: chat models for roles, either kind for the dispatcher. */
export function ModelSelect({
  models,
  value,
  onChange,
  kind,
  none = "未配置",
  current,
  suffix,
}: {
  models: ModelConfig[];
  value: string;
  onChange: (id: string) => void;
  kind: "chat" | "decision" | "all";
  none?: string;
  /** The model in use when it is not in the list (removed, or not visible). */
  current?: { id: string; label: string } | null;
  /** Extra text after a model's name, e.g. its response time. */
  suffix?: (m: ModelConfig) => string;
}) {
  const groups = useMemo(() => {
    const out = new Map<string, ModelConfig[]>();
    for (const m of models) {
      if (kind !== "all" && (m.provider?.protocol === "systemone") !== (kind === "decision")) continue;
      const key = m.provider?.name ?? "";
      out.set(key, [...(out.get(key) ?? []), m]);
    }
    return [...out.entries()];
  }, [models, kind]);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      {groups.map(([provider, list]) => (
        <optgroup key={provider} label={provider || "其他"}>
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.name !== m.model ? `（${m.model}）` : ""}
              {suffix?.(m) ?? ""}
              {m.usable ? "" : " · 不可用"}
            </option>
          ))}
        </optgroup>
      ))}
      {current && !models.some((m) => m.id === current.id) ? <option value={current.id}>{current.label}</option> : null}
    </select>
  );
}

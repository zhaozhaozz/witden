import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import type { Instance, ModelConfig, ModelProtocol, ModelProvider, RemoteModel } from "../api/types";
import { instanceStatus } from "../lib/format";
import { useInterval } from "../lib/hooks";
import { useDirectory } from "../lib/session";
import { useTopics } from "../lib/topics";
import { Field, StatusChip } from "../ui/kit";

/**
 * First run (shown while the platform has no roles): connect a model service, pick a model, and witden creates
 * a desktop computer, a system administrator and an assistant on that computer (POST /api/setup/finish).
 */

interface Preset {
  key: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  hint?: string;
}

const PRESETS: Preset[] = [
  { key: "openai", label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1" },
  { key: "anthropic", label: "Anthropic（Claude）", protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  { key: "deepseek", label: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1" },
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
    key: "custom",
    label: "其他服务",
    protocol: "openai",
    baseUrl: "",
    hint: "OpenAI 兼容接口（如 vLLM、Ollama）填写含 /v1 的地址；Anthropic 接口不含 /v1。地址要能从 witden 服务器访问到。",
  },
];

interface Finished {
  computer: { id: string; name: string; status: string };
  admin_role_id: string;
  assistant_role_id: string;
  dm_id: string;
}

export default function SetupPage() {
  const nav = useNavigate();
  const dir = useDirectory();
  const topics = useTopics();
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [protocol, setProtocol] = useState<ModelProtocol>(PRESETS[0].protocol);
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<ModelProvider | null>(null);
  const [remote, setRemote] = useState<RemoteModel[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState("");
  const [model, setModel] = useState<ModelConfig | null>(null);
  const [done, setDone] = useState<Finished | null>(null);
  const [computer, setComputer] = useState<Instance | null>(null);
  const [stage, setStage] = useState<1 | 2>(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const step = done ? 3 : stage;
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (remote ?? []).filter((m) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q));
  }, [remote, filter]);

  const choose = (p: Preset) => {
    setPreset(p);
    setProtocol(p.protocol);
    setBaseUrl(p.baseUrl);
  };

  /** Save the service (create it, or update it when coming back) and ask it for its models. */
  const connect = async () => {
    setBusy("正在连接模型服务");
    setError(null);
    try {
      const body: Record<string, unknown> = { protocol, base_url: baseUrl.trim() };
      if (apiKey) body.api_key = apiKey;
      let saved: ModelProvider;
      if (provider) saved = await api.patch<ModelProvider>(`/api/model-providers/${provider.id}`, body);
      else {
        const taken = new Set((await api.get<ModelProvider[]>("/api/model-providers")).map((p) => p.name));
        let name = preset.key === "custom" ? "模型服务" : preset.label;
        for (let i = 2; taken.has(name); i++) name = `${preset.label} ${i}`;
        saved = await api.post<ModelProvider>("/api/model-providers", { ...body, name });
      }
      setProvider(saved);
      setApiKey("");
      setStage(2);
      try {
        setRemote((await api.get<{ models: RemoteModel[] }>(`/api/model-providers/${saved.id}/remote-models`)).models);
        setListError(null);
      } catch (err) {
        // Some services list no models: the name can still be typed in.
        setRemote([]);
        setListError(errorMessage(err));
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  /** Add the model, check what it can do, then create the computer and the roles. */
  const start = async () => {
    if (!provider || !picked.trim()) return;
    setError(null);
    try {
      setBusy("正在添加模型");
      await api.post(`/api/model-providers/${provider.id}/models`, {
        models: [{ model: picked.trim() }],
        source: remote?.some((m) => m.id === picked) ? "api" : "manual",
      });
      const found = (await api.get<ModelConfig[]>("/api/models")).find(
        (m) => m.provider?.id === provider.id && m.model === picked.trim(),
      );
      if (!found) throw new Error("模型没有添加成功");
      setBusy("正在检测模型能力（会调用几次模型，可能需要半分钟）");
      const checked = await api.post<ModelConfig>(`/api/models/${found.id}/check`);
      setModel(checked);
      if (checked.capabilities?.chat === false) {
        throw new Error(
          `这个模型无法对话：${checked.capabilities.errors?.chat ?? checked.capabilities.error ?? "检测失败"}。请检查 API Key，或换一个模型。`,
        );
      }
      setBusy("正在创建虚拟电脑和角色");
      const out = await api.post<Finished>("/api/setup/finish", { model_config_id: checked.id });
      setDone(out);
      await Promise.all([dir.reload(), topics.reload()]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // The computer starts in the background; follow it until it runs (or fails).
  const computerId = done?.computer.id;
  const poll = () => {
    if (!computerId) return;
    api
      .get<Instance>(`/api/instances/${computerId}`)
      .then(setComputer)
      .catch(() => {});
  };
  useEffect(() => {
    poll();
  }, [computerId]);
  useInterval(poll, 2000, !!computerId && computer?.status !== "running" && computer?.status !== "error");

  const skip = async () => {
    try {
      await api.post("/api/setup/skip");
    } finally {
      nav("/topics", { replace: true });
    }
  };

  const caps = model?.capabilities;
  return (
    <div className="login first-run">
      <div className="login-panel first-run-panel">
        <div className="login-brand">
          <img src="/favicon.svg" alt="" width={32} height={32} />
          <div>
            <h1>欢迎使用 witden</h1>
            <p>连接一个模型服务、选一个模型，其余的由 witden 准备好。</p>
          </div>
          {done ? null : (
            <button type="button" className="btn btn-sm first-run-skip" onClick={() => void skip()}>
              跳过，自己配置
            </button>
          )}
        </div>

        <ol className="setup-steps">
          <li className={`setup-step setup-${step === 1 ? "current" : "done"}`}>
            <button type="button" className="setup-head" disabled={step === 1 || !!done} onClick={() => setStage(1)}>
              <span className="setup-num" aria-hidden>
                {step === 1 ? 1 : "✓"}
              </span>
              <span className="setup-title">连接模型服务</span>
              {step > 1 ? <span className="setup-summary">{provider?.name}</span> : null}
            </button>
            {step === 1 ? (
              <div className="setup-body">
                <div className="pick first-run-presets" role="radiogroup" aria-label="模型服务">
                  {PRESETS.map((p) => (
                    <label key={p.key} className={`pick-item${p.key === preset.key ? " pick-on" : ""}`}>
                      <input type="radio" name="preset" checked={p.key === preset.key} onChange={() => choose(p)} />
                      <span className="pick-text">{p.label}</span>
                    </label>
                  ))}
                </div>
                <div className="form">
                  {preset.key === "custom" ? (
                    <Field label="接口协议">
                      <select value={protocol} onChange={(e) => setProtocol(e.target.value as ModelProtocol)}>
                        <option value="openai">OpenAI 兼容</option>
                        <option value="anthropic">Anthropic</option>
                      </select>
                    </Field>
                  ) : null}
                  <Field label="API 地址" hint={preset.hint}>
                    <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                  </Field>
                  <Field
                    label="API Key"
                    hint={`在模型服务的控制台中创建。witden 加密保存，之后在任何地方都不会显示出来${
                      preset.key === "custom" ? "；自部署的服务不需要时留空" : ""
                    }。`}
                  >
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="setup-next">
                  <button
                    type="button"
                    className="btn btn-primary"
                    // A saved service keeps its key when coming back to this step.
                    disabled={
                      !!busy || !baseUrl.trim() || (preset.key !== "custom" && !apiKey && !provider?.has_api_key)
                    }
                    onClick={() => void connect()}
                  >
                    {busy ?? "连接并获取模型"}
                  </button>
                </div>
              </div>
            ) : null}
          </li>

          <li className={`setup-step setup-${step === 2 ? "current" : step > 2 ? "done" : "todo"}`}>
            <div className="setup-head">
              <span className="setup-num" aria-hidden>
                {step > 2 ? "✓" : 2}
              </span>
              <span className="setup-title">选择模型</span>
              {step > 2 && model ? <span className="setup-summary">{model.name}</span> : null}
            </div>
            {step === 2 ? (
              <div className="setup-body">
                {listError ? (
                  <div className="callout callout-wait">
                    没能取到模型列表：{listError}。可以返回上一步检查地址和 API Key，或直接在下面填写模型名称。
                  </div>
                ) : null}
                {remote?.length ? (
                  <>
                    <input
                      type="search"
                      placeholder={`在 ${remote.length} 个模型中筛选`}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                    <div className="pick first-run-models" role="radiogroup" aria-label="模型">
                      {shown.slice(0, 300).map((m) => (
                        <label key={m.id} className={`pick-item${m.id === picked ? " pick-on" : ""}`}>
                          <input type="radio" name="model" checked={m.id === picked} onChange={() => setPicked(m.id)} />
                          <span className="pick-text">
                            <span className="mono">{m.id}</span>
                            {m.name && m.name !== m.id ? <span className="pick-hint">{m.name}</span> : null}
                          </span>
                        </label>
                      ))}
                    </div>
                  </>
                ) : null}
                <Field
                  label={remote?.length ? "或填写模型名称" : "模型名称"}
                  hint="填写服务的接口使用的名称，例如 gpt-4o、deepseek-chat、qwen-plus。助手要操作桌面，最好选支持工具调用和图像理解的模型。"
                >
                  <input className="mono" value={picked} onChange={(e) => setPicked(e.target.value)} />
                </Field>
                <div className="setup-next">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!!busy || !picked.trim()}
                    onClick={() => void start()}
                  >
                    {busy ?? "使用这个模型，开始体验"}
                  </button>
                  {busy ? null : (
                    <span className="small muted">
                      将创建一台桌面虚拟电脑和一个助手；内置的系统管理员还没有模型时也用这个模型。
                    </span>
                  )}
                </div>
              </div>
            ) : null}
          </li>

          <li className={`setup-step setup-${step === 3 ? "current" : "todo"}`}>
            <div className="setup-head">
              <span className="setup-num" aria-hidden>
                3
              </span>
              <span className="setup-title">开始使用</span>
            </div>
            {done ? (
              <div className="setup-body">
                <ul className="setup-list">
                  <li>
                    模型 <strong>{model?.name}</strong>：
                    {caps?.tools === false
                      ? "不能调用工具，角色只能对话，不能操作电脑。"
                      : caps?.vision === false
                        ? "可以调用工具，但看不懂图片，助手看不到桌面截图。"
                        : "可以对话、调用工具和理解图片。"}
                  </li>
                  <li>
                    桌面虚拟电脑 <strong>{done.computer.name}</strong>：
                    <StatusChip
                      meta={instanceStatus(computer?.status ?? done.computer.status)}
                      reason={computer?.status_reason}
                      compact
                    />
                    {computer?.status === "error" ? (
                      <span className="small">
                        {" "}
                        启动失败：{computer.status_reason}
                        。请确认服务器上已经准备好虚拟电脑镜像（见部署文档），然后在“虚拟电脑”页面重试。
                      </span>
                    ) : computer?.status !== "running" ? (
                      <span className="small muted">
                        {" "}
                        第一次启动需要一点时间，现在就可以开始对话，助手会在电脑准备好后开始工作。
                      </span>
                    ) : null}
                  </li>
                  <li>
                    <strong>{dir.roleLabel(done.assistant_role_id)}</strong>
                    ：通用助手，在这台桌面电脑上查资料、操作网页、整理文档。
                  </li>
                  <li>
                    <strong>{dir.roleLabel(done.admin_role_id)}</strong>
                    ：只在控制台中工作，可以按你的要求配置 witden（不包括账号和密钥）。
                  </li>
                </ul>
                <div className="setup-next">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => nav(`/topics/${done.dm_id}`, { replace: true })}
                  >
                    和助手开始对话
                  </button>
                  <button type="button" className="btn" onClick={() => void topics.openDm(done.admin_role_id)}>
                    让系统管理员帮我配置
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        </ol>
        {error ? (
          <div className="callout callout-bad" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

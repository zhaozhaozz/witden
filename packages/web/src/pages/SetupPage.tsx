import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import type { Instance, ModelConfig, ModelProvider } from "../api/types";
import { instanceStatus } from "../lib/format";
import { useInterval } from "../lib/hooks";
import { useDirectory } from "../lib/session";
import { useTopics } from "../lib/topics";
import { StatusChip } from "../ui/kit";
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

/**
 * First run (shown while the platform has no roles): connect a model service, pick a model, and witden creates
 * a desktop computer and an assistant on it, and the built-in system administrator gets the model if it has none
 * (POST /api/setup/finish). The service form and the model picker are the models page's own (modelParts.tsx).
 */

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
  const [service, setService] = useState<ServiceDraft>(() => serviceDraft());
  const [provider, setProvider] = useState<ModelProvider | null>(null);
  const [picked, setPicked] = useState<ModelChoice[]>([]);
  const [model, setModel] = useState<ModelConfig | null>(null);
  const [done, setDone] = useState<Finished | null>(null);
  const [computer, setComputer] = useState<Instance | null>(null);
  const [stage, setStage] = useState<1 | 2>(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const step = done ? 3 : stage;

  /** Save the service (create it, or update it when coming back); the picker then asks it for its models. */
  const connect = async () => {
    setBusy("正在连接模型服务");
    setError(null);
    try {
      const saved = await saveService(service, provider);
      setProvider(saved);
      setService({ ...serviceDraft(saved), preset: service.preset });
      setPicked([]);
      setStage(2);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  /** Add the model, check what it can do, then create the computer and the roles. */
  const start = async () => {
    if (!provider || !picked.length) return;
    setError(null);
    try {
      setBusy("正在添加模型");
      const [found] = await addModels(provider, picked);
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
                <div className="form">
                  <ServiceFields value={service} onChange={setService} existing={provider} showName={false} />
                </div>
                <div className="setup-next">
                  <button
                    type="button"
                    className="btn btn-primary"
                    // A saved service keeps its key when coming back to this step.
                    disabled={!!busy || !serviceReady(service, provider)}
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
                {provider ? <ModelPicker provider={provider} multiple={false} onChange={setPicked} /> : null}
                <p className="small muted">助手要操作桌面，最好选支持工具调用和图像理解的模型。</p>
                <div className="setup-next">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!!busy || !picked.length}
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

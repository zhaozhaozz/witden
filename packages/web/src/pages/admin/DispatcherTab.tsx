import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { ModelConfig } from "../../api/types";
import { useResource } from "../../lib/hooks";
import { useAction } from "../../ui/feedback";
import { Field, Loaded, Section, Tag } from "../../ui/kit";

interface DispatcherSetting {
  model_config_id: string | null;
  model: { id: string; label: string } | null;
  usable: boolean;
}

/** The model that decides who answers in "auto" topics with several roles (server: agent/router.ts). */
export function DispatcherTab() {
  const setting = useResource(() => api.get<DispatcherSetting>("/api/settings/dispatcher"), []);
  const models = useResource(() => api.get<ModelConfig[]>("/api/models"), []);
  const { run, busy } = useAction();
  const [picked, setPicked] = useState("");
  useEffect(() => {
    setPicked(setting.data?.model_config_id ?? "");
  }, [setting.data]);
  const groups = useMemo(() => {
    const out = new Map<string, ModelConfig[]>();
    for (const m of models.data ?? []) {
      const key = m.provider?.name ?? "";
      out.set(key, [...(out.get(key) ?? []), m]);
    }
    return [...out.entries()];
  }, [models.data]);

  return (
    <Section title="话题调度">
      <p className="small muted">
        话题设为「自动」且有多个角色时，没有 @
        任何角色的消息由这个模型决定交给哪几个角色，也可以一个都不交（比如闲聊、人和人之间的对话）。只有一个角色的话题不经过调度，由角色自己决定是否回复。
      </p>
      <p className="small muted">
        调度只读最近的一段对话，输出一小段 JSON，不需要工具调用：建议选响应快的小模型（System
        1，不做长推理）。用推理模型时，可以在
        <Link to="/models">模型</Link>页的参数里关闭思考。调度的 token 用量记在这个模型上。
      </p>
      <Loaded res={setting}>
        {(s) => (
          <form
            className="form form-narrow"
            onSubmit={async (e) => {
              e.preventDefault();
              const out = await run(
                () => api.put("/api/settings/dispatcher", { model_config_id: picked || null }),
                picked ? "调度模型已保存" : "已清除调度模型",
              );
              if (out) void setting.reload();
            }}
          >
            <Field
              label="调度模型"
              hint={
                s.model_config_id && !s.usable
                  ? "当前的调度模型已停用或服务商不可用，自动模式的多角色话题暂时不会把消息交给角色。"
                  : "按服务商分组；在「模型」页添加服务商和模型。"
              }
            >
              <select value={picked} onChange={(e) => setPicked(e.target.value)}>
                <option value="">未设置（多角色的自动话题不会自动交给角色）</option>
                {groups.map(([provider, list]) => (
                  <optgroup key={provider} label={provider || "其他"}>
                    {list.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.name !== m.model ? `（${m.model}）` : ""}
                        {m.usable ? "" : " · 不可用"}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>
            <div className="btn-row">
              {s.model ? (
                <Tag tone={s.usable ? "ok" : "bad"}>当前：{s.model.label}</Tag>
              ) : (
                <Tag tone="wait">当前未设置</Tag>
              )}
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={busy || picked === (s.model_config_id ?? "")}
              >
                保存
              </button>
            </div>
          </form>
        )}
      </Loaded>
    </Section>
  );
}

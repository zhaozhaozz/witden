import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { ModelConfig } from "../../api/types";
import { fmtLatency } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useAction } from "../../ui/feedback";
import { Empty, Field, Loaded, Section, Tag } from "../../ui/kit";

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
  // Only models marked as System 1 can route messages.
  const fast = useMemo(() => (models.data ?? []).filter((m) => m.system1), [models.data]);
  const groups = useMemo(() => {
    const out = new Map<string, ModelConfig[]>();
    for (const m of fast) {
      const key = m.provider?.name ?? "";
      out.set(key, [...(out.get(key) ?? []), m]);
    }
    return [...out.entries()];
  }, [fast]);

  return (
    <Section title="话题调度">
      <p className="small muted">
        话题设为「自动」且有多个角色时，没有 @
        任何角色的消息由这个模型决定交给哪几个角色，也可以一个都不交（比如闲聊、人和人之间的对话）。只有一个角色的话题不经过调度，由角色自己决定是否回复。
      </p>
      <p className="small muted">
        调度只需要阅读最近的一段对话并给出简短结果，因此只能选择标记为 System 1
        的模型，即响应快、不先进行长时间思考的模型。在
        <Link to="/models">模型</Link>
        页添加模型时勾选“标记为 System 1”，或编辑已有模型开启；会先思考的模型需要同时关闭思考。调度的 token
        用量计入所选模型。
      </p>
      <Loaded res={setting}>
        {(s) =>
          !fast.length && !s.model_config_id && models.data ? (
            <Empty
              title="还没有 System 1 模型"
              hint="在「模型」页添加模型时勾选“标记为 System 1”，或编辑已有模型开启，然后回到这里选择。"
            />
          ) : (
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
                    ? "当前的调度模型已停用、服务商不可用，或不再标记为 System 1；自动模式的多角色话题暂时不会把消息交给角色。"
                    : "只列出标记为 System 1 的模型，按服务商分组；括号中是最近一次检测的响应时间。"
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
                          {m.capabilities?.latency_ms !== undefined
                            ? ` · 响应 ${fmtLatency(m.capabilities.latency_ms)}`
                            : ""}
                          {m.capabilities?.thinks ? " · 会先思考" : ""}
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
          )
        }
      </Loaded>
    </Section>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { ModelConfig } from "../../api/types";
import { fmtLatency, SYSTEM_ONE_HINT } from "../../lib/format";
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
  // Only System One decision models (TypeSafe Jev, Laya) can route messages.
  const fast = useMemo(() => (models.data ?? []).filter((m) => m.provider?.protocol === "systemone"), [models.data]);
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
        调度模型必须是 System 1 模型。{SYSTEM_ONE_HINT}
        调度时它只看这条消息本身，从“各个角色”和“不需要角色”中选出最可能的一项；选中某个角色时，概率不低于 30%
        的其他角色也会一起接手。它不看之前的对话，所以回答某个角色的提问时，请 @ 这个角色。
      </p>
      <p className="small muted">
        添加方法：在<Link to="/models">模型</Link>页添加服务商，接口协议选“System One（TypeSafe
        Jev、Laya）”，再添加模型（Jev 一般为 jev-latest；自部署的 Laya 中文对话用
        multilingual），点击“检测能力”后回到这里选择。调度的 token 用量计入所选模型。
      </p>
      <Loaded res={setting}>
        {(s) =>
          !fast.length && !s.model_config_id && models.data ? (
            <Empty
              title="还没有 System 1 模型"
              hint="在「模型」页添加接口协议为“System One（TypeSafe Jev、Laya）”的服务商和模型，然后回到这里选择。"
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
                    ? "当前的调度模型已停用、服务商不可用，或不是 System 1 模型；自动模式的多角色话题暂时不会把消息交给角色。"
                    : "只列出 System 1 模型（System One 协议的服务商下的模型），按服务商分组，并附最近一次检测的响应时间。"
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

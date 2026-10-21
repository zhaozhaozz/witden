import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { ModelConfig } from "../../api/types";
import { useConfigChanged } from "../../lib/configEvents";
import { fmtLatency, SYSTEM_ONE_HINT } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useUnsavedChanges } from "../../lib/unsaved";
import { useAction } from "../../ui/feedback";
import { Empty, Field, Loaded, Section, Tag } from "../../ui/kit";
import { ModelSelect } from "../modelParts";

interface DispatcherSetting {
  model_config_id: string | null;
  model: { id: string; label: string } | null;
  kind: "decision" | "chat" | null;
  usable: boolean;
}

/** The model that decides who answers in "auto" topics with several roles (server: agent/router.ts). */
export function DispatcherTab() {
  const setting = useResource(() => api.get<DispatcherSetting>("/api/settings/dispatcher"), []);
  const models = useResource(() => api.get<ModelConfig[]>("/api/models"), []);
  useConfigChanged(["models"], models.reload);
  const { run, busy } = useAction();
  const [picked, setPicked] = useState("");
  useEffect(() => {
    setPicked(setting.data?.model_config_id ?? "");
  }, [setting.data]);
  const save = async (): Promise<boolean> => {
    const out = await run(
      () => api.put("/api/settings/dispatcher", { model_config_id: picked || null }),
      picked ? "调度模型已保存" : "已清除调度模型",
    );
    if (out) void setting.reload();
    return !!out;
  };
  useUnsavedChanges(!!setting.data && picked !== (setting.data.model_config_id ?? ""), save);

  return (
    <Section title="话题调度">
      <p className="small muted">
        话题设为「自动」且有多个角色时，没有 @
        任何角色的消息由这个模型决定交给哪几个角色，也可以一个都不交（比如闲聊、人和人之间的对话）。只有一个角色的话题不经过调度，由角色自己决定是否回复。
      </p>
      <p className="small muted">调度模型可以是以下两类之一，调度的 token 用量计入所选模型：</p>
      <ul className="small muted">
        <li>
          <strong>System 1 模型</strong>（推荐，快且便宜）：{SYSTEM_ONE_HINT}
          调度时它只看这条消息本身，从“各个角色”和“不需要角色”中选出最可能的一项；选中某个角色时，概率不低于 30%
          的其他角色也会一起接手。它不看之前的对话，所以回答某个角色的提问时，请 @ 这个角色。添加方法：在
          <Link to="/models">模型</Link>页添加服务商，选择“TypeSafe Jev”或“Laya”，再添加模型（Jev 一般为
          jev-latest；自部署的 Laya 中文对话用 multilingual）。
        </li>
        <li>
          <strong>普通对话模型</strong>
          （与角色使用的模型相同）：它会参考这条消息之前的几条消息，所以直接回答某个角色的提问时，通常不用 @
          也能交给这个角色；可以选零个、一个或几个角色。每条没有 @
          的消息都要调用一次，速度和费用取决于所选模型，建议选响应快的小模型。
        </li>
      </ul>
      <Loaded res={setting}>
        {(s) =>
          !models.data?.length && !s.model_config_id && models.data ? (
            <Empty title="还没有模型" hint="在「模型」页添加服务商和模型，然后回到这里选择。" />
          ) : (
            <form
              className="form form-narrow"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Field
                label="调度模型"
                hint={
                  s.model_config_id && !s.usable
                    ? "当前的调度模型已停用或服务商不可用；自动模式的多角色话题暂时不会把消息交给角色。"
                    : "按服务商分组；System 1 模型附最近一次检测的响应时间。"
                }
              >
                <ModelSelect
                  models={models.data ?? []}
                  value={picked}
                  onChange={setPicked}
                  kind="all"
                  none="未设置（多角色的自动话题不会自动交给角色）"
                  suffix={(m) =>
                    m.capabilities?.latency_ms !== undefined ? ` · 响应 ${fmtLatency(m.capabilities.latency_ms)}` : ""
                  }
                />
              </Field>
              <div className="btn-row">
                {s.model ? (
                  <Tag tone={s.usable ? "ok" : "bad"}>
                    当前：{s.model.label}
                    {s.kind === "decision" ? "（System 1）" : "（对话模型）"}
                  </Tag>
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

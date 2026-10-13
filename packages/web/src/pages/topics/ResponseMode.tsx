import { api } from "../../api/client";
import type { Topic } from "../../api/types";
import { RESPONSE_MODE } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useAction } from "../../ui/feedback";
import { Tag } from "../../ui/kit";

const MODES = ["mention", "auto"] as const;

/**
 * The topic's response mode as a two-way switch in its header: 主动 @ / 自动, each explained on hover.
 * Switched right here while the topic is active (the buttons stay hoverable for the explanation).
 */
export function ResponseModeSwitch({ topic, onChange }: { topic: Topic; onChange: (t: Topic) => void }) {
  const { run, busy } = useAction();
  if (topic.kind !== "group") return null;
  const editable = topic.status === "active";
  const pick = async (mode: (typeof MODES)[number]) => {
    if (!editable || busy || mode === topic.response_mode) return;
    const t = await run(
      () => api.patch<Topic>(`/api/topics/${topic.id}`, { response_mode: mode }),
      mode === "auto" ? "已切换为自动模式" : "已切换为主动 @ 模式",
    );
    if (t) onChange(t);
  };
  return (
    <span className="mode-switch">
      <span className="small muted">角色响应</span>
      <span className="segmented" role="radiogroup" aria-label="角色响应方式">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={topic.response_mode === m}
            aria-disabled={!editable}
            className={`seg${topic.response_mode === m ? " seg-on" : ""}${editable ? "" : " seg-readonly"}`}
            title={`${RESPONSE_MODE[m].hint}${editable ? "" : "\n\n话题已归档，不能切换。"}`}
            onClick={() => void pick(m)}
          >
            {RESPONSE_MODE[m].label}
          </button>
        ))}
      </span>
    </span>
  );
}

/** Auto mode with several roles needs the dispatcher model; say so when it is missing. */
export function DispatcherWarning({ topic }: { topic: Topic }) {
  const roles = (topic.participants ?? []).filter((p) => p.type === "role" && p.status !== "disabled").length;
  const needed = topic.kind === "group" && topic.response_mode === "auto" && roles > 1;
  const res = useResource(
    () => api.get<{ usable: boolean }>("/api/settings/dispatcher"),
    [topic.id, topic.response_mode, roles],
    needed,
  );
  if (!needed || !res.data || res.data.usable) return null;
  return (
    <span title="自动模式下话题里有多个角色时，由调度模型决定交给谁。请管理员在「系统管理 → 话题调度」中设置；在此之前，没有 @ 的消息不会交给任何角色。">
      <Tag tone="bad">未设置调度模型</Tag>
    </span>
  );
}

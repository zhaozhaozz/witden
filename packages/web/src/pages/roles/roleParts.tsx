import { Link } from "react-router-dom";
import type { RoleImpact } from "../../api/types";
import { instanceStatus } from "../../lib/format";
import { Guarded } from "../../ui/kit";
import { TaskStatusChip } from "../tasks/taskParts";

// Backend warnings are English sentences with a few fixed shapes; show them in Chinese when recognised.
const WARNING_PATTERNS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^no model configured/, () => "未配置模型：角色无法工作"],
  [/^the key of (.+) has been revoked: the role cannot work$/, (m) => `服务商 ${m[1]} 的密钥已撤销：角色无法工作`],
  [/^model (.+) is disabled: the role cannot work$/, (m) => `模型 ${m[1]} 已停用：角色无法工作`],
  [/^model (.+) has not been checked yet$/, (m) => `模型 ${m[1]} 还没有做能力检测`],
  [/^the model cannot call tools/, () => "模型不支持工具调用：角色只能对话"],
  [/^the model cannot understand images/, () => "模型不支持图像理解：桌面操作会被拒绝"],
  [/^no computer assigned/, () => "未分配虚拟电脑：任务无法执行"],
  [/^computer (.+) has no desktop$/, (m) => `虚拟电脑 ${m[1]} 没有桌面，桌面工具不可用`],
  [/^computer (.+) is (\w+)$/, (m) => `虚拟电脑 ${m[1]} 当前${instanceStatus(m[2]).label}`],
];

export function translateWarning(w: string): string {
  for (const [re, fn] of WARNING_PATTERNS) {
    const m = w.match(re);
    if (m) return fn(m);
  }
  return w;
}

const NOTE_ZH: Record<string, string> = {
  "Running and queued tasks keep the prompt, model and computer they started with.":
    "执行中和排队中的任务继续使用开始时的提示词、模型和虚拟电脑。",
  "Changing the computer does not move files, installed software or logins; tasks pinned to the old computer must be cancelled or re-run explicitly.":
    "更换虚拟电脑不会迁移文件、已安装的软件和登录状态；已固定在旧虚拟电脑上的任务需要明确取消或重新执行。",
  "Agent sessions and topic notes stay with their topics.": "角色会话和话题记忆留在各自话题中。",
};

const FIELD_ZH: Record<string, string> = {
  system_prompt: "提示词",
  model_config_id: "模型",
  model_params: "模型参数",
  instance_id: "虚拟电脑",
  allowed_tools: "工具",
};

/** Field names are snake_case (server `changes` and the editor); camelCase is accepted too. */
export function fieldLabel(f: string): string {
  const snake = f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return FIELD_ZH[snake] ?? snake;
}

/** What a configuration change touches: running work, topics, memories. */
export function ImpactView({ impact }: { impact: RoleImpact }) {
  return (
    <div className="impact">
      <div className="impact-stats">
        <div>
          <strong>{impact.active_tasks.length}</strong>
          <span>进行中的任务</span>
        </div>
        <div>
          <strong>{impact.topics}</strong>
          <span>参与的话题</span>
        </div>
        <div>
          <strong>{impact.memories}</strong>
          <span>角色记下的笔记</span>
        </div>
      </div>
      {impact.active_tasks.length ? (
        <ul className="plain-list">
          {impact.active_tasks.map((t) => (
            <li key={t.id}>
              <Link to={`/tasks/${t.id}`}>
                <Guarded text={t.title} label="受限任务" />
              </Link>{" "}
              <TaskStatusChip status={t.status} compact />
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="notes">
        {impact.notes.map((n) => (
          <li key={n}>{NOTE_ZH[n] ?? n}</li>
        ))}
      </ul>
    </div>
  );
}

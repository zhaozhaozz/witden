import { useState } from "react";
import { api } from "../../api/client";
import type { Task, TaskStatus } from "../../api/types";
import { isActiveTask, taskStatus } from "../../lib/format";
import { useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import { Field, FormModal, StatusChip } from "../../ui/kit";

export function TaskStatusChip({
  status,
  reason,
  compact,
}: {
  status: TaskStatus | string;
  reason?: string | null;
  compact?: boolean;
}) {
  return <StatusChip meta={taskStatus(status)} reason={reason} compact={compact} />;
}

interface ControlTarget {
  id: string;
  status: TaskStatus | string;
  owner_role_id: string;
  title?: string;
  /** A run of a role's conversation: it can be stopped, not handed to another role or retried. */
  kind?: "conversation" | "task";
}

/**
 * Pause / resume / cancel / add instructions / retry / reassign, offered according to the task state.
 * The backend re-checks permissions; buttons only reflect what makes sense for the state.
 */
export function TaskControls({
  task,
  onChanged,
  size = "sm",
}: {
  task: ControlTarget;
  onChanged: (t?: Task) => void;
  size?: "sm" | "xs";
}) {
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const dir = useDirectory();
  const [dialog, setDialog] = useState<null | "instruct" | "reassign">(null);
  const [note, setNote] = useState("");
  const [target, setTarget] = useState("");
  const active = isActiveTask(task.status);
  const conversation = task.kind === "conversation";
  const cls = `btn btn-${size}`;

  const control = async (action: string, text = "", success?: string) => {
    const out = await run(() => api.post<Task>(`/api/tasks/${task.id}/control`, { action, note: text }), success);
    if (out) onChanged(out);
    return out;
  };

  const candidates = dir.roles.filter((r) => r.status === "active" && r.id !== task.owner_role_id);

  return (
    <div className="btn-row">
      {active && task.status !== "paused" ? (
        <button type="button" className={cls} disabled={busy} onClick={() => control("pause", "", "任务已暂停")}>
          暂停
        </button>
      ) : null}
      {task.status === "paused" ? (
        <button type="button" className={cls} disabled={busy} onClick={() => control("resume", "", "任务已继续")}>
          继续
        </button>
      ) : null}
      {active ? (
        <button type="button" className={cls} disabled={busy} onClick={() => setDialog("instruct")}>
          补充要求
        </button>
      ) : null}
      {active && !conversation ? (
        <button type="button" className={cls} disabled={busy} onClick={() => setDialog("reassign")}>
          转交
        </button>
      ) : null}
      {!conversation && (task.status === "failed" || task.status === "cancelled") ? (
        <button type="button" className={cls} disabled={busy} onClick={() => control("retry", "", "已重新排队")}>
          重试
        </button>
      ) : null}
      {active ? (
        <button
          type="button"
          className={`${cls} btn-danger-ghost`}
          disabled={busy}
          onClick={async () => {
            const ok = await confirm(
              conversation
                ? {
                    title: "停止这一轮",
                    body: (
                      <p>
                        角色这一轮的工作会停止，还没读到的消息也不再处理；它拆出或委托出去的任务不受影响。之后有人再找它时，对话照常继续。
                      </p>
                    ),
                    confirmLabel: "停止",
                    cancelLabel: "返回",
                    danger: true,
                  }
                : {
                    title: "取消任务",
                    body: <p>取消后，该任务及其委托出去的子任务都会停止，已产生的结果保留。</p>,
                    confirmLabel: "取消任务",
                    cancelLabel: "返回",
                    danger: true,
                  },
            );
            if (ok) await control("cancel", "", conversation ? "已停止" : "任务已取消");
          }}
        >
          {conversation ? "停止" : "取消"}
        </button>
      ) : null}

      {dialog === "instruct" ? (
        <FormModal
          title="补充要求"
          submitLabel="发送给角色"
          busy={busy}
          disabled={!note.trim()}
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            const out = await control("instruct", note.trim(), "要求已送达，角色会在下一步读取");
            if (out) {
              setNote("");
              setDialog(null);
            }
          }}
        >
          <Field
            label="新的要求"
            hint={
              conversation
                ? "角色会在下一步读到它（不打断正在执行的操作），和话题里的新消息一样。"
                : "作为一条补充指令加入任务记录；如任务正在等待人工答复，会立即继续。"
            }
          >
            <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          </Field>
        </FormModal>
      ) : null}

      {dialog === "reassign" ? (
        <FormModal
          title="转交给其他角色"
          submitLabel="转交"
          busy={busy}
          disabled={!target}
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            const out = await run(
              () => api.post<Task>(`/api/tasks/${task.id}/reassign`, { role_id: target }),
              "任务已转交",
            );
            if (out) {
              setDialog(null);
              onChanged(out);
            }
          }}
        >
          <p className="muted">
            转交会创建一项由新角色负责的任务，并重新检查权限；新角色不会因此获得原角色更多的权限，任务会在新角色自己的虚拟电脑上执行。
          </p>
          <Field label="新负责人">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">选择角色</option>
              {candidates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} @{r.handle}
                  {r.instance ? ` · ${r.instance.name}` : " · 未分配虚拟电脑"}
                </option>
              ))}
            </select>
          </Field>
        </FormModal>
      ) : null}
    </div>
  );
}

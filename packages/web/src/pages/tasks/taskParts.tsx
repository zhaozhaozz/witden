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
  revision?: number;
  /** A task in a DM stays with the DM's one role: it is not handed over. */
  topic?: { kind: string } | null;
}

/** A task changes hands only while nothing runs it and nothing waits for the previous role (server: task-handoff.ts). */
const TRANSFERABLE = ["pending", "waiting_resource", "waiting_role", "completed", "failed"];

/**
 * Resume / cancel / add instructions / retry / reassign, offered according to the task state. Nothing is paused
 * by hand: an emergency stop or a takeover pauses work, and "继续" resumes it afterwards.
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
  const [dialog, setDialog] = useState<null | "instruct" | "continue" | "reassign">(null);
  const [note, setNote] = useState("");
  const [requestKey, setRequestKey] = useState("");
  const [target, setTarget] = useState("");
  const [handoffNote, setHandoffNote] = useState("");
  const active = isActiveTask(task.status);
  const conversation = task.kind === "conversation";
  const cls = `btn btn-${size}`;

  const control = async (action: string, text = "", success?: string) => {
    const out = await run(
      () =>
        api.post<Task>(`/api/tasks/${task.id}/control`, {
          action,
          note: text,
          ...(action === "continue" ? { expected_revision: task.revision ?? 1, idempotency_key: requestKey } : {}),
        }),
      success,
    );
    if (out) onChanged(out);
    return out;
  };

  const candidates = dir.roles.filter((r) => r.status === "active" && !r.system_admin && r.id !== task.owner_role_id);

  return (
    <div className="btn-row">
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
      {/* A finished task takes more requirements too: it starts working again and delivers once more. */}
      {!conversation && task.status === "completed" ? (
        <button
          type="button"
          className={cls}
          disabled={busy}
          onClick={() => {
            // One key per dialog: a double submit starts one new iteration, not two.
            setRequestKey(
              Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join(""),
            );
            setDialog("continue");
          }}
        >
          补充要求
        </button>
      ) : null}
      {!conversation && TRANSFERABLE.includes(task.status) ? (
        task.topic?.kind === "dm" ? (
          <button type="button" className={cls} disabled title="私信中只有一个角色，任务不能转交给其他角色">
            转交
          </button>
        ) : (
          <button type="button" className={cls} disabled={busy} onClick={() => setDialog("reassign")}>
            转交
          </button>
        )
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

      {dialog === "instruct" || dialog === "continue" ? (
        <FormModal
          title="补充要求"
          submitLabel="发送给角色"
          busy={busy}
          disabled={!note.trim()}
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            const out = await control(
              dialog === "continue" ? "continue" : "instruct",
              note.trim(),
              dialog === "continue" ? "已补充要求，任务重新开始工作" : "要求已送达，角色会在下一步读取",
            );
            if (out) {
              setNote("");
              setDialog(null);
            }
          }}
        >
          <Field
            label="新的要求"
            hint={
              dialog === "continue"
                ? "这项任务已经完成。补充要求后，它在原来的执行记录和虚拟电脑上接着做，完成后再交付一次结果；之前交付的结果都保留。"
                : conversation
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
              () => api.post<Task>(`/api/tasks/${task.id}/reassign`, { role_id: target, note: handoffNote }),
              "任务已转交",
            );
            if (out) {
              setDialog(null);
              setHandoffNote("");
              onChanged(out);
            }
          }}
        >
          <p className="muted">
            转交后仍是同一项任务，所属话题、执行记录和历次交付都保留。新角色按自己的权限配置，在自己的虚拟电脑上接着做；原虚拟电脑上的文件不会迁移，之前的执行过程也不会交给新角色。
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
          <Field
            label="交接说明"
            hint="选填。新角色从任务要求、已有的结果和这段说明开始工作，可以写明进展、相关的分支或文件位置和接下来要做的事。"
          >
            <textarea rows={4} maxLength={4000} value={handoffNote} onChange={(e) => setHandoffNote(e.target.value)} />
          </Field>
        </FormModal>
      ) : null}
    </div>
  );
}

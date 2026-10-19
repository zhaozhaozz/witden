import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AgentSession } from "../api/types";
import { fmtDateTime, fmtRelative, fmtTokens } from "../lib/format";
import { useDirectory } from "../lib/session";
import { useAction, useFeedback } from "../ui/feedback";
import { Empty, RoleBadge, Tag } from "../ui/kit";
import { TaskStatusChip } from "./tasks/taskParts";

/**
 * Agent sessions: a role's conversation in one topic, one per role × topic, so a role working in several
 * topics never mixes their contexts. `by` chooses what each row is labelled with (the topic on a role page,
 * the role on a topic page).
 */
export function AgentSessionList({
  sessions,
  by,
  onChanged,
}: {
  sessions: AgentSession[];
  by: "topic" | "role";
  onChanged?: () => void;
}) {
  if (!sessions.length)
    return (
      <Empty
        title="还没有对话"
        hint={
          by === "topic"
            ? "有人第一次找角色时，它在这个话题里的对话就开始了，之后一直延续。"
            : "有人在某个话题里第一次找角色时，它在那里的对话就开始了，之后一直延续。"
        }
      />
    );
  const sorted = [...sessions].sort((a, b) =>
    (b.last_run_at ?? b.created_at).localeCompare(a.last_run_at ?? a.created_at),
  );
  return (
    <ul className="memory-list">
      {sorted.map((s) => (
        <SessionItem key={s.id} session={s} by={by} onChanged={onChanged} />
      ))}
    </ul>
  );
}

function SessionItem({
  session: s,
  by,
  onChanged,
}: {
  session: AgentSession;
  by: "topic" | "role";
  onChanged?: () => void;
}) {
  const dir = useDirectory();
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const [open, setOpen] = useState(false);
  const notes = [...(s.notes ?? [])].reverse();
  const reset = async () => {
    const ok = await confirm({
      title: "清空上下文",
      body: (
        <p>
          角色会忘记在这里之前的对话内容；消息都还在，下次有人找它时，它会从最近的消息重新读起。正在进行的这一轮会停止。
        </p>
      ),
      confirmLabel: "清空上下文",
      cancelLabel: "返回",
      danger: true,
    });
    if (ok && (await run(() => api.post(`/api/sessions/${s.id}/reset`), "上下文已清空"))) onChanged?.();
  };
  return (
    <li>
      <div className="memory-text">
        {by === "topic" ? (
          s.topic ? (
            <Link to={`/topics/${s.topic.id}`}>{s.topic.kind === "dm" ? `私信：${s.topic.title}` : s.topic.title}</Link>
          ) : (
            <span className="muted">未知话题</span>
          )
        ) : s.role ? (
          <RoleBadge role={{ ...s.role, ...(dir.roleById.get(s.role.id) ?? {}) }} />
        ) : (
          <span className="muted">已删除的角色</span>
        )}{" "}
        {s.status !== "active" ? <Tag tone="off">{s.status}</Tag> : null}
        {s.restricted ? (
          <Tag
            tone="wait"
            title="这段对话读过不是话题里每个人都能看的资料，之后的回答要等资料主人批准才会发出；清空上下文后恢复。"
          >
            读过受限资料
          </Tag>
        ) : null}
        {s.open_run ? (
          <Link to={`/tasks/${s.open_run.id}`}>
            <TaskStatusChip status={s.open_run.status} compact />
          </Link>
        ) : null}
      </div>
      <div className="small muted">
        {s.runs} 轮 ·{" "}
        {s.last_run_at ? (
          <span title={fmtDateTime(s.last_run_at)}>最近 {fmtRelative(s.last_run_at)}</span>
        ) : (
          "尚未完成过一轮"
        )}
        {" · "}上下文 {fmtTokens(s.context_tokens)}
        {s.compact_at ? ` / ${fmtTokens(s.compact_at)} 时整理` : ""}
        {s.compactions ? ` · 已整理 ${s.compactions} 次` : ""}
        <button type="button" className="link-btn" disabled={busy} onClick={() => void reset()}>
          清空上下文
        </button>
        {notes.length ? (
          <button type="button" className="link-btn" onClick={() => setOpen(!open)}>
            {open ? "收起旧笔记" : `旧会话笔记 ${notes.length} 条`}
          </button>
        ) : null}
      </div>
      {open ? (
        <ul className="plain-list">
          {notes.map((n, i) => {
            const taskId = n.taskId ?? n.task_id;
            return (
              <li key={`${taskId ?? ""}-${i}`} className="small">
                <div>
                  <span className="muted">请求：</span>
                  {n.request || <span className="muted">（无）</span>}
                </div>
                <div>
                  <span className="muted">结果：</span>
                  {n.result}
                </div>
                <div className="muted">
                  {fmtRelative(n.at)}
                  {taskId ? (
                    <>
                      {" · "}
                      <Link to={`/tasks/${taskId}`}>查看任务</Link>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

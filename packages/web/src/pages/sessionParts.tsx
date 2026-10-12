import { useState } from "react";
import { Link } from "react-router-dom";
import type { AgentSession } from "../api/types";
import { fmtDateTime, fmtRelative } from "../lib/format";
import { useDirectory } from "../lib/session";
import { Empty, RoleBadge, Tag } from "../ui/kit";

/**
 * Agent sessions: one per role × topic, so a role working in several topics never mixes their contexts.
 * `by` chooses what each row is labelled with (the topic on a role page, the role on a topic page).
 */
export function AgentSessionList({ sessions, by }: { sessions: AgentSession[]; by: "topic" | "role" }) {
  if (!sessions.length)
    return (
      <Empty
        title="还没有会话"
        hint={
          by === "topic"
            ? "角色在这个话题里第一次接到任务时会建立会话。"
            : "角色在某个话题里第一次接到任务时会建立该话题的会话。"
        }
      />
    );
  const sorted = [...sessions].sort((a, b) =>
    (b.last_run_at ?? b.created_at).localeCompare(a.last_run_at ?? a.created_at),
  );
  return (
    <ul className="memory-list">
      {sorted.map((s) => (
        <SessionItem key={s.id} session={s} by={by} />
      ))}
    </ul>
  );
}

function SessionItem({ session: s, by }: { session: AgentSession; by: "topic" | "role" }) {
  const dir = useDirectory();
  const [open, setOpen] = useState(false);
  const notes = [...(s.notes ?? [])].reverse();
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
      </div>
      <div className="small muted">
        运行 {s.runs} 次 ·{" "}
        {s.last_run_at ? (
          <span title={fmtDateTime(s.last_run_at)}>最近 {fmtRelative(s.last_run_at)}</span>
        ) : (
          "尚未完成过任务"
        )}
        {notes.length ? (
          <button type="button" className="link-btn" onClick={() => setOpen(!open)}>
            {open ? "收起笔记" : `会话笔记 ${notes.length} 条`}
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

import type { Task } from "../../api/types";
import { fmtDateTime, fmtRelative } from "../../lib/format";
import { useDirectory } from "../../lib/session";
import { Empty, RoleBadge } from "../../ui/kit";
import { Markdown } from "../../ui/Markdown";

/**
 * The progress AI employees recorded on the task (post_progress), newest first: who recorded it, when, and what.
 * Tasks from before the history existed keep only one note, shown without author or time.
 */
export function TaskUpdates({ task }: { task: Task }) {
  const dir = useDirectory();
  const updates = [...(task.updates ?? [])].reverse();
  if (!updates.length)
    return (
      <>
        <Empty
          title="还没有进展记录"
          hint="AI 员工在任务中记录进展后会出现在这里；同一话题中的其他 AI 员工也可以为这项任务记录进展。"
        />
        {task.progress ? (
          <div className="task-update">
            <div className="task-update-head small muted">以前的进展说明（没有记录人和时间）</div>
            <Markdown content={task.progress} />
          </div>
        ) : null}
      </>
    );
  return (
    <div className="task-updates">
      {updates.map((u) => {
        const role = dir.roleById.get(u.author_id);
        return (
          <div key={u.id} className="task-update">
            <div className="task-update-head small">
              {role ? <RoleBadge role={role} compact /> : <span className="muted">已删除的 AI 员工</span>}
              <time dateTime={u.created_at}>{fmtDateTime(u.created_at)}</time>
              <span className="muted">{fmtRelative(u.created_at)}</span>
              {(task.revision ?? 1) > 1 ? <span className="muted">第 {u.revision} 次交付</span> : null}
            </div>
            <Markdown content={u.content} />
          </div>
        );
      })}
    </div>
  );
}

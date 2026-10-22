import type { Task } from "../../api/types";
import { fmtRelative, fmtTime } from "../../lib/format";
import { useDirectory } from "../../lib/session";
import { RoleBadge, Section } from "../../ui/kit";
import { Markdown } from "../../ui/Markdown";

/** The progress AI employees recorded on the task, newest first: what is done, what is next, what blocks it. */
export function TaskUpdates({ task }: { task: Task }) {
  const dir = useDirectory();
  const updates = [...(task.updates ?? [])].reverse();
  if (!updates.length) return null;
  return (
    <Section title={`进展记录（${updates.length} 条）`}>
      <div className="task-updates">
        {updates.map((u) => {
          const role = dir.roleById.get(u.author_id);
          return (
            <div key={u.id} className="task-update">
              <div className="task-update-head small muted">
                {role ? <RoleBadge role={role} compact /> : <span>已删除的 AI 员工</span>}
                <span title={fmtTime(u.created_at)}>{fmtRelative(u.created_at)}</span>
                {(task.revision ?? 1) > 1 ? <span>第 {u.revision} 次交付</span> : null}
              </div>
              <Markdown content={u.content} />
            </div>
          );
        })}
      </div>
    </Section>
  );
}

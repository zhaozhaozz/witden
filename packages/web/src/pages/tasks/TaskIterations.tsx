import type { Task } from "../../api/types";
import { fmtTime, taskStatus } from "../../lib/format";
import { Section } from "../../ui/kit";
import { Markdown } from "../../ui/Markdown";

/**
 * Every delivery of an independent task: a continued task delivers again, and earlier results are kept. A task
 * delivered once already shows its result above, so the list appears from its second iteration on.
 */
export function TaskIterations({ task }: { task: Task }) {
  const iterations = task.iterations ?? [];
  if ((task.revision ?? 1) < 2 || !iterations.length) return null;
  return (
    <Section title={`历次交付（当前是第 ${task.revision} 次）`}>
      {iterations.map((it) => (
        <details key={it.id} className="settings-block">
          <summary>
            第 {it.revision} 次交付 · {taskStatus(it.status).label}
            {it.finished_at ? ` · ${fmtTime(it.finished_at)}` : ""}
          </summary>
          <Markdown content={it.result ?? it.error ?? "没有结果文本"} />
        </details>
      ))}
    </Section>
  );
}

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useLiveEvents } from "../../api/events";
import type { Task } from "../../api/types";
import { ACTIVE_TASK_STATUSES, fmtRelative, fmtTime, isRestricted, taskStatus } from "../../lib/format";
import { useDebounced, useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { Empty, Guarded, Handle, Loaded, PageHeader } from "../../ui/kit";
import { TaskStatusChip } from "./taskParts";

const FILTERS: { key: string; label: string; statuses: string[] }[] = [
  { key: "active", label: "进行中", statuses: ACTIVE_TASK_STATUSES },
  { key: "waiting", label: "等待中", statuses: ["waiting_human", "waiting_approval", "waiting_children", "waiting_resource", "waiting_timer"] },
  { key: "running", label: "执行中", statuses: ["running"] },
  { key: "paused", label: "已暂停", statuses: ["paused"] },
  { key: "failed", label: "失败", statuses: ["failed"] },
  { key: "completed", label: "已完成", statuses: ["completed"] },
  { key: "cancelled", label: "已取消", statuses: ["cancelled"] },
  { key: "all", label: "全部", statuses: [] },
];

export default function TasksPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const dir = useDirectory();
  const [filter, setFilter] = useState("active");
  const [mine, setMine] = useState(false);
  const [roleId, setRoleId] = useState("");
  const statuses = FILTERS.find((f) => f.key === filter)?.statuses ?? [];
  const res = useResource(
    () =>
      api.get<Task[]>("/api/tasks", {
        status: statuses.length ? statuses.join(",") : undefined,
        mine: mine || undefined,
        role_id: roleId || undefined,
        limit: 300,
      }),
    [filter, mine, roleId],
  );
  const refresh = useDebounced(() => void res.reload(), 800);
  // Admin stream carries task events from every topic; only people with audit/instance rights may open it.
  const live = useLiveEvents(can("audit.view") || can("instance.manage") ? { admin: true } : null, (type) => {
    if (type.startsWith("task.")) refresh();
  });

  return (
    <div className="page">
      <PageHeader
        title="任务"
        sub="每项任务都有请求人、来源话题、负责角色和执行电脑。点开任务可以看到每一步执行记录和分配依据。"
        actions={
          <>
            {live ? <span className="live-dot live-on">实时</span> : null}
            <button className="btn btn-sm" onClick={() => void res.reload()}>
              刷新
            </button>
          </>
        }
      />
      <div className="toolbar">
        <div className="segmented">
          {FILTERS.map((f) => (
            <button key={f.key} className={f.key === filter ? "seg seg-on" : "seg"} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)} aria-label="按角色筛选">
          <option value="">全部角色</option>
          {dir.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} @{r.handle}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          我发起的
        </label>
      </div>
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>状态与原因</th>
                    <th>负责角色</th>
                    <th>电脑</th>
                    <th>话题</th>
                    <th>请求人</th>
                    <th>更新</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id} className="row-link" onClick={() => nav(`/tasks/${t.id}`)}>
                      <td>
                        <Link to={`/tasks/${t.id}`} onClick={(e) => e.stopPropagation()} className="strong">
                          <Guarded text={t.title} label="受限任务" />
                        </Link>
                        {t.parent_task_id ? <div className="small muted">委托的子任务 · 第 {t.depth} 层</div> : null}
                        {t.progress && !isRestricted(t.progress) ? <div className="small task-progress">{t.progress}</div> : null}
                      </td>
                      <td className="cell-status">
                        <TaskStatusChip status={t.status} compact />
                        {t.status_reason && !isRestricted(t.status_reason) ? (
                          <div className={`reason reason-${taskStatus(t.status).tone}`}>{t.status_reason}</div>
                        ) : null}
                      </td>
                      <td>{t.owner ? <Handle handle={t.owner.handle} /> : <span className="muted">—</span>}</td>
                      <td className="nowrap">{t.instance ? t.instance.name : <span className="muted">无</span>}</td>
                      <td>
                        {t.topic ? (
                          <Link to={`/topics/${t.topic.id}`} onClick={(e) => e.stopPropagation()}>
                            {t.topic.kind === "dm" ? "私信" : t.topic.title}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{t.requester?.name ?? (t.requester_role_id ? dir.roleLabel(t.requester_role_id) : "—")}</td>
                      <td title={fmtTime(t.updated_at)} className="nowrap">
                        {fmtRelative(t.updated_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="没有符合条件的任务" hint="在话题中 @ 角色即可创建任务。" />
          )
        }
      </Loaded>
    </div>
  );
}

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useLiveEvents } from "../../api/events";
import type { Task } from "../../api/types";
import { ACTIVE_TASK_STATUSES, fmtRelative, fmtTime, isRestricted, taskStatus } from "../../lib/format";
import { useDebounced, useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { ComputerBadge, Empty, Guarded, Loaded, PageHeader, RoleBadge, Tag } from "../../ui/kit";
import { TaskStatusChip } from "./taskParts";

const FILTERS: { key: string; label: string; statuses: string[] }[] = [
  { key: "active", label: "进行中", statuses: ACTIVE_TASK_STATUSES },
  {
    key: "waiting",
    label: "等待中",
    statuses: [
      "waiting_human",
      "waiting_approval",
      "waiting_children",
      "waiting_resource",
      "waiting_timer",
      "waiting_role",
    ],
  },
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
  // The roles' conversations are not tasks; their runs can be listed alongside when wanted.
  const [conversations, setConversations] = useState(false);
  const statuses = FILTERS.find((f) => f.key === filter)?.statuses ?? [];
  const res = useResource(
    () =>
      api.get<Task[]>("/api/tasks", {
        status: statuses.length ? statuses.join(",") : undefined,
        mine: mine || undefined,
        role_id: roleId || undefined,
        kind: conversations ? undefined : "task",
        limit: 300,
      }),
    [filter, mine, roleId, conversations],
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
        sub="任务是 AI 员工单独开展的工作：从对话中拆出的较大工作，或委托给其他 AI 员工的工作，各有自己的上下文。AI 员工在话题里的对话不算任务，勾选“包括对话”可一并查看它们的每一轮。点开可以看到每一步执行记录和分配依据。"
        actions={
          <>
            {live ? <span className="live-dot live-on">实时</span> : null}
            <button type="button" className="btn btn-sm" onClick={() => void res.reload()}>
              刷新
            </button>
          </>
        }
      />
      <div className="toolbar">
        <div className="segmented">
          {FILTERS.map((f) => (
            <button
              type="button"
              key={f.key}
              className={f.key === filter ? "seg seg-on" : "seg"}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)} aria-label="按 AI 员工筛选">
          <option value="">全部 AI 员工</option>
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
        <label className="check">
          <input type="checkbox" checked={conversations} onChange={(e) => setConversations(e.target.checked)} />
          包括对话
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
                    <th>负责的 AI 员工</th>
                    <th>虚拟电脑</th>
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
                        {t.kind === "conversation" ? (
                          <div className="small muted">
                            <Tag>对话</Tag> AI 员工在话题里的一轮工作
                          </div>
                        ) : t.parent_task_id ? (
                          <div className="small muted">委托的子任务 · 第 {t.depth} 层</div>
                        ) : t.report_session_id ? (
                          <div className="small muted">结果回到发起它的对话</div>
                        ) : null}
                        {t.progress && !isRestricted(t.progress) ? (
                          <div className="small task-progress">{t.progress}</div>
                        ) : null}
                      </td>
                      <td className="cell-status">
                        <TaskStatusChip status={t.status} compact />
                        {t.status_reason && !isRestricted(t.status_reason) ? (
                          <div className={`reason reason-${taskStatus(t.status).tone}`}>{t.status_reason}</div>
                        ) : null}
                      </td>
                      <td>{t.owner ? <RoleBadge role={t.owner} /> : <span className="muted">—</span>}</td>
                      <td className="nowrap">
                        {t.instance ? <ComputerBadge computer={t.instance} /> : <span className="muted">无</span>}
                      </td>
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
            <Empty
              title="没有符合条件的任务"
              hint="AI 员工在对话中把较大的工作拆出去、或委托给其他 AI 员工时，会出现在这里。"
            />
          )
        }
      </Loaded>
    </div>
  );
}

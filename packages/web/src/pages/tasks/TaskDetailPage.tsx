import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { useLiveEvents } from "../../api/events";
import type { AuditEntry, Dict, Task, TaskStep, TaskTrace, TraceStep } from "../../api/types";
import { auditLabel, CONVERSATION_KIND, fmtDateTime, fmtNumber, fmtTime, genericStatus, instanceStatus, isRestricted, TOOL_GROUP_LABEL } from "../../lib/format";
import { useDebounced, useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { COMPUTER_PERMS } from "../../lib/perms";
import { Empty, Guarded, Handle, IdText, KV, Loaded, PageHeader, Section, StatusChip, Tabs, Tag } from "../../ui/kit";
import { AssignmentTrace, TraceRail, type Stop } from "../../ui/trace";
import { TaskControls, TaskStatusChip } from "./taskParts";

export default function TaskDetailPage() {
  const { taskId = "" } = useParams();
  const nav = useNavigate();
  const [tab, setTab] = useState("log");
  const task = useResource(() => api.get<Task>(`/api/tasks/${taskId}`), [taskId]);
  const log = useResource(() => api.get<TaskStep[]>(`/api/tasks/${taskId}/log`), [taskId]);
  const trace = useResource(() => api.get<TaskTrace>(`/api/tasks/${taskId}/trace`), [taskId], tab === "trace");
  // Tasks that read material this viewer may not see: no log, no step stream (both are refused).
  const restricted = !!task.data?.content_restricted;
  const reloadTask = useDebounced(() => void task.reload(), 300);

  const live = useLiveEvents(task.data && !restricted ? { task_id: taskId } : null, (type, data) => {
    if (type === "task.step" && data.task_id === taskId) {
      const step = data as unknown as TaskStep & { task_id: string };
      log.setData((prev) => {
        if (!prev) return prev;
        if (prev.some((s) => s.seq === step.seq)) return prev;
        return [...prev, { seq: step.seq, kind: step.kind, payload: step.payload, created_at: new Date().toISOString() }];
      });
      reloadTask();
    } else if (type === "task.status" && data.id === taskId) {
      task.setData((prev) =>
        prev
          ? {
              ...prev,
              status: data.status as Task["status"],
              status_reason: (data.reason as string | null) ?? null,
              progress: (data.progress as string | null) ?? prev.progress,
            }
          : prev,
      );
      reloadTask();
    }
  });

  return (
    <div className="page">
      <Loaded res={task}>
        {(t) => (
          <>
            <PageHeader
              title={<Guarded text={t.title} label="受限任务" />}
              sub={
                <span className="head-meta">
                  <Link to="/tasks">任务</Link>
                  <span>/</span>
                  <IdText id={t.id} />
                  <span className={`live-dot${live ? " live-on" : ""}`}>{live ? "实时" : "离线"}</span>
                </span>
              }
              actions={
                <TaskControls
                  task={t}
                  onChanged={(n) => {
                    // Reassigning creates a new task owned by the other role: follow it.
                    if (n && n.id !== t.id) nav(`/tasks/${n.id}`);
                    else void task.reload();
                  }}
                />
              }
            />
            <TaskStatusBanner task={t} />
            {t.content_restricted ? (
              <div className="callout callout-wait">
                该任务读取了你无权查看的资料：标题、要求、进度和结果已隐藏，执行日志不可查看。任务的状态、负责角色和执行电脑仍然可见，你仍可以暂停或取消它。
              </div>
            ) : null}
            <TaskSummary task={t} />
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: "log", label: "执行记录", badge: restricted ? undefined : log.data?.length },
                { key: "trace", label: "链路追溯" },
              ]}
            />
            {tab === "log" && restricted ? (
              <Empty title="该任务读取了你无权查看的资料，执行日志已隐藏" hint="只有能查看任务全部资料来源的人可以看到执行记录。" />
            ) : tab === "log" ? (
              <Loaded res={log}>
                {(steps) => (steps.length ? <ExecutionLog steps={steps} /> : <Empty title="还没有执行记录" hint="角色开始工作后，每一步都会出现在这里。" />)}
              </Loaded>
            ) : (
              <Loaded res={trace}>{(tr) => <TraceView trace={tr} />}</Loaded>
            )}
          </>
        )}
      </Loaded>
    </div>
  );
}

function TaskStatusBanner({ task }: { task: Task }) {
  const wait = task.wait as Dict | null;
  return (
    <div className="status-banner">
      <TaskStatusChip status={task.status} compact />
      <div className="status-banner-text">
        {task.status_reason ? (
          <div>
            <Guarded text={task.status_reason} label="原因已隐藏（涉及受限资料）" />
          </div>
        ) : null}
        {task.progress && !isRestricted(task.progress) ? <div className="small">进度：{task.progress}</div> : null}
        {wait && Object.keys(wait).length ? <WaitInfo wait={wait} /> : null}
      </div>
    </div>
  );
}

function WaitInfo({ wait }: { wait: Dict }) {
  const dir = useDirectory();
  const type = wait.type as string | undefined;
  const parts: ReactNode[] = [];
  if (type === "instance") parts.push(`等待电脑可用${wait.since ? `（自 ${fmtTime(wait.since as string)}）` : ""}`);
  if (type === "timer") parts.push(wait.until ? `计划在 ${fmtDateTime(wait.until as string)} 跟进${wait.note ? `：${String(wait.note)}` : ""}` : "等待定时跟进");
  if (type === "approval") parts.push("等待审批");
  if (type === "children") parts.push("等待委托出去的子任务完成");
  if (Array.isArray(wait.user_ids) && wait.user_ids.length)
    parts.push(`等待 ${(wait.user_ids as string[]).map((id) => dir.userName(id)).join("、")} 回复`);
  if (wait.question) parts.push(`问题：${String(wait.question)}`);
  if (!parts.length) return null;
  return <div className="small muted">{parts.join("；")}</div>;
}

function TaskSummary({ task: t }: { task: Task }) {
  const dir = useDirectory();
  const { can } = useAuth();
  const usage = (t.usage ?? {}) as { steps?: number; tokens?: number };
  const budget = (t.budget ?? {}) as { max_steps?: number; max_tokens?: number };
  return (
    <div className="grid-2">
      <Section title="概要">
        <KV
          items={[
            ["负责角色", t.owner ? <span>{t.owner.name} <Handle handle={t.owner.handle} /></span> : "—"],
            [
              "请求人",
              t.requester ? t.requester.name : t.requester_role_id ? <span>角色 {dir.roleLabel(t.requester_role_id)}</span> : "—",
            ],
            [
              "来源话题",
              t.topic ? <Link to={`/topics/${t.topic.id}`}>{t.topic.kind === "dm" ? `私信：${t.topic.title}` : t.topic.title}</Link> : "—",
            ],
            [
              "执行电脑",
              t.instance ? (
                <span className="inline-list">
                  {COMPUTER_PERMS.some(can) ? <Link to={`/computers/${t.instance.id}`}>{t.instance.name}</Link> : t.instance.name}
                  <StatusChip meta={instanceStatus(t.instance.status)} compact />
                </span>
              ) : (
                <span className="muted">未分配（角色没有电脑时只能对话）</span>
              ),
            ],
            [
              "协作角色",
              t.collaborator_role_ids?.length ? t.collaborator_role_ids.map((id) => dir.roleLabel(id)).join("、") : null,
            ],
            ["上级任务", t.parent_task_id ? <Link to={`/tasks/${t.parent_task_id}`}>查看上级任务（第 {t.depth} 层委托）</Link> : null],
            ["时间", `创建 ${fmtDateTime(t.created_at)}${t.started_at ? `，开始 ${fmtTime(t.started_at)}` : ""}${t.finished_at ? `，结束 ${fmtTime(t.finished_at)}` : ""}`],
            [
              "用量",
              `${fmtNumber(usage.steps ?? 0)} 步${budget.max_steps ? ` / 上限 ${budget.max_steps}` : ""}，${fmtNumber(usage.tokens ?? 0)} tokens${
                budget.max_tokens ? ` / 上限 ${fmtNumber(budget.max_tokens)}` : ""
              }`,
            ],
          ]}
        />
      </Section>
      <Section title="内容">
        <div className="text-block-label">任务要求</div>
        <div className="text-block">{t.instruction ? <Guarded text={t.instruction} /> : <span className="muted">（无）</span>}</div>
        {t.result ? (
          <>
            <div className="text-block-label">交付结果</div>
            <div className="text-block text-block-ok">
              <Guarded text={t.result} />
            </div>
          </>
        ) : null}
        {t.error ? (
          <>
            <div className="text-block-label">错误</div>
            <div className="text-block text-block-bad">
              <Guarded text={t.error} />
            </div>
          </>
        ) : null}
        {t.children?.length ? (
          <>
            <div className="text-block-label">委托出去的子任务</div>
            <ul className="plain-list">
              {t.children.map((c) => (
                <li key={c.id}>
                  <Link to={`/tasks/${c.id}`}>
                    <Guarded text={c.title} label="受限子任务" />
                  </Link>{" "}
                  <TaskStatusChip status={c.status} compact />{" "}
                  <span className="small muted">{dir.roleLabel(c.owner_role_id)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {t.approvals?.length ? (
          <>
            <div className="text-block-label">审批</div>
            <ul className="plain-list">
              {t.approvals.map((a) => (
                <li key={a.id}>
                  <StatusChip meta={genericStatus(a.status)} compact /> {a.action === "disclose" ? "发送受限资料" : `工具 ${a.action}`}
                  <span className="small muted">
                    {" "}
                    {fmtTime(a.created_at)}
                    {a.decided_by ? ` · ${dir.userName(a.decided_by)} 处理` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Section>
    </div>
  );
}

// --- execution log -----------------------------------------------------------------------------------

function contentText(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (Array.isArray(content)) {
    const text = content
      .filter((p): p is { type: string; text?: string } => !!p && typeof p === "object")
      .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
      .join("\n");
    const images = content.filter((p) => p && typeof p === "object" && (p as { type?: string }).type !== "text").length;
    return { text, images };
  }
  if (content === undefined || content === null) return { text: "", images: 0 };
  return { text: JSON.stringify(content, null, 2), images: 0 };
}

function prettyArgs(raw: unknown): string {
  if (typeof raw === "string") {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return JSON.stringify(raw, null, 2);
}

function Collapsible({ text, limit = 900 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  if (text.length <= limit) return <pre className="mono-block">{text}</pre>;
  return (
    <div>
      <pre className="mono-block">{open ? text : `${text.slice(0, limit)}…`}</pre>
      <button className="link-btn small" onClick={() => setOpen(!open)}>
        {open ? "收起" : `展开全部（${text.length} 字符）`}
      </button>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  wait: "等待",
  instance_wait: "等待电脑",
  transcript_removed: "记录已删除",
};

function ExecutionLog({ steps }: { steps: TaskStep[] }) {
  return (
    <ol className="steps">
      {steps.map((s) => {
        const p = s.payload ?? {};
        let label = s.kind as string;
        let body: ReactNode = null;
        if (s.kind === "user" || s.kind === "system") {
          const c = contentText(p.content);
          label = s.kind === "system" ? "系统" : c.text.startsWith("Additional instruction") ? "补充要求" : "输入";
          body = (
            <>
              <Collapsible text={c.text} />
              {c.images ? <Tag>附带 {c.images} 张截图</Tag> : null}
            </>
          );
        } else if (s.kind === "assistant") {
          const c = contentText(p.content);
          const calls = (p.tool_calls ?? []) as { id: string; function?: { name?: string; arguments?: unknown } }[];
          label = calls.length ? "思考并调用工具" : "回复";
          body = (
            <>
              {c.text ? <div className="step-text">{c.text}</div> : null}
              {calls.map((call) => (
                <div key={call.id} className="tool-call">
                  <div className="tool-call-name">
                    <span className="tag tag-accent">调用</span> <code>{call.function?.name}</code>
                  </div>
                  <pre className="mono-block">{prettyArgs(call.function?.arguments)}</pre>
                </div>
              ))}
            </>
          );
        } else if (s.kind === "tool") {
          const c = contentText(p.content);
          label = `工具结果 ${String(p.name ?? "")}`;
          body = (
            <>
              <Collapsible text={c.text} />
              {c.images ? <Tag>含 {c.images} 张截图</Tag> : null}
            </>
          );
        } else if (s.kind === "event") {
          const type = String(p.type ?? "event");
          label = EVENT_LABEL[type] ?? type;
          const note = (p.note ?? p.reason ?? "") as string;
          body = (
            <div className="step-text">
              {p.tool ? <code>{String(p.tool)}</code> : null} {note}
              {p.args ? <pre className="mono-block">{prettyArgs(p.args)}</pre> : null}
            </div>
          );
        }
        return (
          <li key={s.seq} className={`step step-${s.kind}`}>
            <div className="step-head">
              <span className="step-seq">#{s.seq}</span>
              <span className="step-label">{label}</span>
              {s.created_at ? <time title={fmtDateTime(s.created_at)}>{fmtTime(s.created_at)}</time> : null}
            </div>
            <div className="step-body">{body}</div>
          </li>
        );
      })}
    </ol>
  );
}

// --- trace -------------------------------------------------------------------------------------------

function TraceView({ trace }: { trace: TaskTrace }) {
  const dir = useDirectory();
  const t = trace.task;
  const env = (trace.envelope ?? {}) as { tools?: string[]; contacts?: string[]; spaces?: string[]; approval_required?: string[]; inherited_from?: string };
  const assignment = (trace.assignment ?? {}) as { summary?: string; trace?: TraceStep[] };
  const source = trace.source ?? {};

  const actor = (a: AuditEntry) =>
    a.actor_type === "user" ? dir.userName(a.actor_id) : a.actor_type === "role" ? dir.roleLabel(a.actor_id) : a.actor_type === "system" ? "系统" : a.actor_id ?? a.actor_type;

  const auditStops: Stop[] = trace.audit.map((a) => ({
    key: a.id,
    title: auditLabel(a.action),
    tone: a.outcome === "denied" || a.outcome === "error" ? "bad" : a.action.includes("denied") || a.action.includes("blocked") ? "bad" : "info",
    meta: (
      <>
        {actor(a)} · <time title={fmtDateTime(a.created_at)}>{fmtTime(a.created_at)}</time>
      </>
    ),
    body:
      typeof a.detail === "string" ? (
        <span className="small muted">{isRestricted(a.detail) ? "详情已隐藏（涉及受限资料）" : a.detail}</span>
      ) : Object.keys(a.detail ?? {}).length ? (
        <code className="audit-detail">{JSON.stringify(a.detail)}</code>
      ) : undefined,
  }));

  return (
    <div className="trace-grid">
      <div>
        <Section title="请求来源">
          <KV
            items={[
              ["请求人", t.requester?.name ?? (t.requester_role_id ? `角色 ${dir.roleLabel(t.requester_role_id)}` : "—")],
              ["入口", CONVERSATION_KIND[(source.conversation_kind as string) ?? "internal"] ?? String(source.conversation_kind)],
              ["话题", t.topic ? <Link to={`/topics/${t.topic.id}`}>{t.topic.title}</Link> : "—"],
              ["通讯接入", source.connection_id ? <IdText id={source.connection_id as string} /> : null],
              ["外部会话", source.conversation_id ? <IdText id={source.conversation_id as string} /> : null],
              ["Thread", source.thread_key ? <code className="id">{String(source.thread_key)}</code> : null],
              ["执行电脑", t.instance?.name ?? "—"],
            ]}
          />
        </Section>
        <Section title="分配依据">
          {assignment.summary ? (
            <p className="small">
              结果：{t.instance ? assignment.summary.replace(t.instance.id, `电脑 ${t.instance.name}`) : assignment.summary}
            </p>
          ) : null}
          {assignment.trace?.length ? (
            <AssignmentTrace
              trace={assignment.trace}
              lookups={{
                instanceName: (id) => (t.instance && id === t.instance.id ? t.instance.name : undefined),
                topicTitle: (id) => (t.topic && id === t.topic.id ? t.topic.title : undefined),
              }}
            />
          ) : (
            <p className="muted small">
              {t.parent_task_id ? "这是由其他角色委托的子任务，权限继承自上级任务。" : "没有记录分配过程（例如由转交或系统创建的任务）。"}
            </p>
          )}
        </Section>
      </div>
      <div>
        <Section title="权限范围">
          <p className="small muted">任务实际可用的能力 = 角色能力 ∩ 委托方范围 ∩ 请求人权限。</p>
          <KV
            items={[
              [
                "工具",
                env.tools?.length ? (
                  <span className="inline-list">
                    {env.tools.map((g) => (
                      <Tag key={g}>{TOOL_GROUP_LABEL[g] ?? g}</Tag>
                    ))}
                  </span>
                ) : (
                  <span className="muted">仅对话</span>
                ),
              ],
              [
                "可联系角色",
                env.contacts?.length ? (env.contacts.includes("*") ? "任意角色" : env.contacts.map((id) => dir.roleLabel(id)).join("、")) : <span className="muted">无</span>,
              ],
              ["知识空间", env.spaces?.length ? env.spaces.map((s) => <IdText key={s} id={s} />) : <span className="muted">无</span>],
              ["需审批", env.approval_required?.length ? env.approval_required.join("、") : <span className="muted">无</span>],
              ["继承自", env.inherited_from ? <Link to={`/tasks/${env.inherited_from}`}>上级任务</Link> : null],
            ]}
          />
        </Section>
        <Section title="信息标签">
          <p className="small muted">任务读过的资料带有来源标签；结果只能发给有权查看这些来源的人，否则需要审批。</p>
          {trace.labels?.length ? (
            <div className="inline-list">
              {trace.labels.map((l) => (
                <code key={l} className="id">
                  {l}
                </code>
              ))}
            </div>
          ) : (
            <span className="muted small">无</span>
          )}
        </Section>
      </div>
      <Section title="审计链" className="trace-audit">
        {auditStops.length ? <TraceRail stops={auditStops} dense /> : <Empty title="没有审计记录" />}
      </Section>
    </div>
  );
}

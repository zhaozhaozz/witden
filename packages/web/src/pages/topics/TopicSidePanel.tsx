import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, downloadFile } from "../../api/client";
import type { AgentSession, Approval, Artifact, Task, Topic } from "../../api/types";
import {
  fmtBytes,
  fmtRelative,
  fmtTime,
  fmtTokens,
  isActiveTask,
  isRestricted,
  PLATFORM_LABEL,
} from "../../lib/format";
import { type Resource, useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { useTopics } from "../../lib/topics";
import { useLeaveGuard, useUnsavedChanges } from "../../lib/unsaved";
import { useAction, useFeedback } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import {
  Avatar,
  ComputerBadge,
  Empty,
  Field,
  Guarded,
  Handle,
  KV,
  Loaded,
  RoleBadge,
  Tabs,
  Tag,
  Toggle,
} from "../../ui/kit";
import { ApprovalCard } from "../approvalParts";
import { MemoryList } from "../memoryParts";
import { SessionRuns } from "../sessionParts";
import { SkillList } from "../skillParts";
import { TaskControls, TaskStatusChip } from "../tasks/taskParts";
import { TopicComputer, topicComputers } from "./TopicComputer";
import { TopicLinksTab } from "./TopicLinksTab";
import { TriggersTab } from "./TriggersTab";
import { InviteDialog } from "./topicDialogs";

export function TopicSidePanel({
  topic,
  onTopicChange,
  onCleared,
  version,
  approvals,
  onDecided,
  computerMax = false,
  onToggleComputerMax,
  onClose,
}: {
  topic: Topic;
  onTopicChange: (t: Topic) => void;
  onCleared: () => void;
  /** Bumped by live task events so the task / approval lists refresh. */
  version: number;
  approvals: Resource<Approval[]>;
  onDecided: (a: Approval) => void;
  /** The computer tab is laid over the whole topic (tabs hidden). */
  computerMax?: boolean;
  onToggleComputerMax?: () => void;
  onClose: () => void;
}) {
  // A DM is always you and one role: settings show the role instead of a participant list. A pair is two AI
  // employees talking directly: settings show the two of them, and nothing there can be changed.
  const dm = topic.kind === "dm";
  const pair = topic.kind === "pair";
  // A link may name the tab to open, e.g. ?panel=triggers when coming back from adding a webhook source.
  const [params] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const panel = params.get("panel") ?? "tasks";
    if (panel === "approvals") return "tasks";
    // Keep links to the former standalone tabs useful after consolidating them into settings.
    return ["people", "role", "links"].includes(panel) ? "settings" : panel;
  });
  const guard = useLeaveGuard();
  const hasComputers = topicComputers(topic).length > 0;
  // Maximised, the panel shows only the computer (the tab row is hidden).
  const shown = computerMax ? "computer" : tab;
  // The roles' conversations here, and the independent tasks (a conversation's runs are not listed as tasks).
  const sessions = useResource(() => api.get<AgentSession[]>(`/api/topics/${topic.id}/sessions`), [topic.id]);
  const tasks = useResource(() => api.get<Task[]>("/api/tasks", { topic_id: topic.id, kind: "task" }), [topic.id]);
  const pendingApprovals = approvals.data?.filter((a) => a.status === "pending");

  useEffect(() => {
    if (version > 0) {
      void sessions.reload();
      void tasks.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const activeCount =
    (tasks.data ?? []).filter((t) => isActiveTask(t.status)).length +
    (sessions.data ?? []).filter((s) => s.open_run).length;

  return (
    <aside className={`side-panel${computerMax ? " side-panel-max" : ""}`}>
      {!computerMax ? (
        <div className="side-panel-head">
          <span>工作区</span>
          <button type="button" className="btn btn-ghost btn-xs" aria-label="关闭工作区" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ) : null}
      <Tabs
        value={tab}
        onChange={(k) => guard(() => setTab(k))}
        tabs={[
          {
            key: "tasks",
            label: (
              <>
                工作
                {pendingApprovals?.length ? (
                  <span
                    className="work-approval-indicator"
                    role="img"
                    aria-label={`${pendingApprovals.length} 项待审批`}
                    title={`${pendingApprovals.length} 项待审批`}
                  />
                ) : null}
              </>
            ),
            badge: activeCount,
          },
          { key: "computer", label: "虚拟电脑", hidden: !hasComputers },
          { key: "files", label: "文件" },
          { key: "notes", label: "记忆" },
          { key: "triggers", label: "触发器", hidden: dm || pair },
          { key: "settings", label: "设置" },
        ]}
      />
      <div className="side-body">
        {shown === "tasks" ? (
          <>
            <Loaded res={{ ...approvals, data: pendingApprovals }}>
              {(rows) =>
                rows.length ? (
                  <section className="work-section work-approvals" aria-label="待审批">
                    <h4 className="work-section-title">待审批 · {rows.length}</h4>
                    <div className="approval-list">
                      {rows.map((a) => (
                        <ApprovalCard
                          key={a.id}
                          approval={a}
                          showContext={false}
                          onDecided={(next) => {
                            onDecided(next);
                            void sessions.reload();
                            void tasks.reload();
                          }}
                        />
                      ))}
                    </div>
                  </section>
                ) : null
              }
            </Loaded>
            <ConversationsBlock res={sessions} dm={dm} pair={pair} />
            <TasksTab res={tasks} place={dm ? "私信" : pair ? "对话" : "话题"} />
          </>
        ) : null}
        {shown === "computer" ? (
          <TopicComputer topic={topic} maximized={computerMax} onToggleMax={() => onToggleComputerMax?.()} />
        ) : null}
        {shown === "files" ? <FilesTab topic={topic} /> : null}
        {shown === "notes" ? <NotesTab key={topic.id} topic={topic} version={version} /> : null}
        {shown === "triggers" ? <TriggersTab key={topic.id} topic={topic} version={version} /> : null}
        {shown === "settings" ? (
          <div key={topic.id} className="sidebar-settings">
            <details className="sidebar-settings-section" open>
              <summary>{dm || pair ? "AI 员工" : "参与者"}</summary>
              <div className="sidebar-settings-body">
                {dm ? (
                  <DmRoleTab topic={topic} />
                ) : pair ? (
                  <PairRolesTab topic={topic} />
                ) : (
                  <PeopleTab topic={topic} onTopicChange={onTopicChange} />
                )}
              </div>
            </details>
            {pair ? null : (
              <details className="sidebar-settings-section" open>
                <summary>关联话题</summary>
                <div className="sidebar-settings-body">
                  <TopicLinksTab topic={topic} />
                </div>
              </details>
            )}
            <details className="sidebar-settings-section" open>
              <summary>{dm ? "私信设置" : pair ? "对话设置" : "话题设置"}</summary>
              <div className="sidebar-settings-body">
                {dm || pair ? (
                  <DmSettings topic={topic} onTopicChange={onTopicChange} onCleared={onCleared} />
                ) : (
                  <SettingsTab topic={topic} onTopicChange={onTopicChange} onCleared={onCleared} />
                )}
              </div>
            </details>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * Each role's conversation in this topic: one context it keeps from message to message. Shows whether it is
 * working on something now, how large its context is and when it gets compacted; stop the current round or
 * clear the context.
 */
function ConversationsBlock({ res, dm, pair }: { res: Resource<AgentSession[]>; dm: boolean; pair: boolean }) {
  const dir = useDirectory();
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  // Conversations opened to show their runs.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const reset = async (s: AgentSession) => {
    const name = s.role ? `@${s.role.handle}` : "AI 员工";
    const ok = await confirm({
      title: `清空 ${name} 的上下文`,
      body: (
        <p>
          {name}
          会忘记在{dm ? "这个私信" : pair ? "这段对话" : "这个话题"}
          里之前的对话内容；消息都还在，下次有人找它时，它会从最近的消息重新读起。正在进行的这一轮会停止。
        </p>
      ),
      confirmLabel: "清空上下文",
      cancelLabel: "返回",
      danger: true,
    });
    if (ok && (await run(() => api.post(`/api/sessions/${s.id}/reset`), "上下文已清空"))) void res.reload();
  };
  return (
    <section className="work-section">
      <h4 className="work-section-title">对话</h4>
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <ul className="task-cards">
              {rows.map((s) => {
                const role = s.role ? { ...s.role, ...(dir.roleById.get(s.role.id) ?? {}) } : null;
                const isOpen = open.has(s.id);
                return (
                  <li key={s.id} className="task-card">
                    {/* The whole head opens the conversation's runs, each linking to its execution record. */}
                    <button
                      type="button"
                      className="session-toggle"
                      aria-expanded={isOpen}
                      title={isOpen ? "收起执行记录" : "查看每一轮的执行记录"}
                      onClick={() => toggle(s.id)}
                    >
                      <span className="task-card-head">
                        <span className="session-who">
                          <svg className="session-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                            <path
                              d="M2 3.5 5 6.5 8 3.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                            />
                          </svg>
                          {role ? <RoleBadge role={role} compact /> : <span className="muted">已删除的 AI 员工</span>}
                          <span className="small muted">{s.runs} 轮</span>
                        </span>
                        {s.open_run ? (
                          <TaskStatusChip status={s.open_run.status} compact />
                        ) : (
                          <Tag tone="off">空闲</Tag>
                        )}
                      </span>
                      <span
                        className="small muted"
                        title="上下文：AI 员工在这里的对话目前占用的大小；达到整理点时，它会把前面的内容压缩成摘要。"
                      >
                        上下文 {fmtTokens(s.context_tokens)}
                        {s.compact_at ? ` / ${fmtTokens(s.compact_at)} 时整理` : ""}
                        {s.compactions ? ` · 已整理 ${s.compactions} 次` : ""}
                        {s.waiting ? ` · ${s.waiting} 条待读` : ""}
                        {s.next_follow_up_at ? ` · ${fmtRelative(s.next_follow_up_at)}跟进` : ""}
                      </span>
                    </button>
                    <div className="btn-row">
                      {s.open_run ? (
                        <Link to={`/tasks/${s.open_run.id}`} className="btn btn-xs">
                          查看过程
                        </Link>
                      ) : null}
                      <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void reset(s)}>
                        清空上下文
                      </button>
                    </div>
                    {s.open_run ? (
                      <TaskControls
                        size="xs"
                        task={{
                          id: s.open_run.id,
                          status: s.open_run.status,
                          owner_role_id: s.role_id,
                          kind: "conversation",
                        }}
                        onChanged={() => void res.reload()}
                      />
                    ) : null}
                    {isOpen ? <SessionRuns session={s} /> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty
              title="还没有对话"
              hint={
                pair
                  ? "一位 AI 员工给另一位发消息后，双方在这里的对话会一直延续。"
                  : dm
                    ? "给 AI 员工发消息后，它在这里的对话会一直延续，工作期间收到的新消息也会被它读到。"
                    : "在消息里 @ 一位 AI 员工，它在这个话题里的对话会一直延续，工作期间收到的新消息也会被它读到。"
              }
            />
          )
        }
      </Loaded>
    </section>
  );
}

/** Independent tasks: work a conversation split off (start_task) or delegated, each with its own context. */
function TasksTab({ res, place }: { res: Resource<Task[]>; place: string }) {
  const [onlyActive, setOnlyActive] = useState(false);
  return (
    <section className="work-section">
      <div className="side-toolbar">
        <h4 className="work-section-title">任务</h4>
        <Toggle checked={onlyActive} onChange={setOnlyActive} label="只看进行中" />
      </div>
      <Loaded res={res}>
        {(rows) => {
          const list = onlyActive ? rows.filter((t) => isActiveTask(t.status)) : rows;
          if (!list.length)
            return (
              <Empty
                title="还没有任务"
                hint={`AI 员工把一块较大的工作拆出去单独做、或交给其他 AI 员工时，会作为任务出现在这里，各自有独立的上下文，完成后结果回到${place}里的对话。`}
              />
            );
          return (
            <ul className="task-cards">
              {list.map((t) => (
                <li key={t.id} className="task-card">
                  <div className="task-card-head">
                    <Link to={`/tasks/${t.id}`} className="task-card-title">
                      <Guarded text={t.title} label="受限任务" />
                    </Link>
                    <TaskStatusChip status={t.status} compact />
                  </div>
                  {t.status_reason && !isRestricted(t.status_reason) ? (
                    <div className="reason">{t.status_reason}</div>
                  ) : null}
                  {t.progress && !isRestricted(t.progress) ? (
                    <div className="small task-progress">{t.progress}</div>
                  ) : null}
                  <div className="task-card-meta small muted">
                    {t.owner ? <RoleBadge role={t.owner} compact /> : null}
                    {t.instance ? <ComputerBadge computer={t.instance} /> : <span>无虚拟电脑</span>}
                    {t.requester ? <span>{t.requester.name} 发起</span> : null}
                    <span title={fmtTime(t.updated_at)}>{fmtRelative(t.updated_at)}</span>
                  </div>
                  <TaskControls size="xs" task={t} onChanged={() => void res.reload()} />
                </li>
              ))}
            </ul>
          );
        }}
      </Loaded>
    </section>
  );
}

function PeopleTab({ topic, onTopicChange }: { topic: Topic; onTopicChange: (t: Topic) => void }) {
  const { me } = useAuth();
  const { confirm } = useFeedback();
  const { run } = useAction();
  const [inviting, setInviting] = useState(false);
  const participants = topic.participants ?? [];
  // A Slack, Feishu or GitHub conversation: its people come with it, and its one role is chosen in its settings.
  const external = topic.channel ?? null;

  const remove = async (type: string, id: string, name: string) => {
    const self = type === "user" && id === me?.id;
    const ok = await confirm({
      title: self ? "离开话题" : `移除 ${name}`,
      body: (
        <p>
          {self
            ? "离开后你将无法再查看这个话题。"
            : type === "role"
              ? "移除后该 AI 员工不再接收这个话题的消息；它在这个话题中进行中的任务会被重新检查，不再被允许的会被取消。"
              : "移除后该成员将无法再访问这个话题；由他发起的进行中任务会被重新检查。"}
        </p>
      ),
      confirmLabel: self ? "离开" : "移除",
      danger: true,
    });
    if (!ok) return;
    const t = await run(
      () => api.del<Topic>(`/api/topics/${topic.id}/participants/${type}/${id}`),
      self ? "已离开话题" : "已移除",
    );
    if (t) onTopicChange(t);
  };

  return (
    <>
      <div className="side-toolbar">
        <span className="small muted">
          {participants.filter((p) => p.type === "user").length} 位成员 ·{" "}
          {participants.filter((p) => p.type === "role").length} 位 AI 员工
        </span>
        {topic.can_post && !external ? (
          <button type="button" className="btn btn-xs" onClick={() => setInviting(true)}>
            邀请
          </button>
        ) : null}
      </div>
      {external ? (
        <p className="small muted side-note">
          这是 {PLATFORM_LABEL[external.platform] ?? external.platform}{" "}
          中的会话：成员就是会话里的人，不能在这里邀请或移除。会话中只有一位 AI 员工工作，默认是接入「
          {external.connection_name}」的 AI 员工；要换一位，在下面「话题设置」的「处理的 AI 员工」中选择。
        </p>
      ) : null}
      <ul className="people">
        {participants.map((p) => (
          <li key={`${p.type}:${p.id}`} className="person">
            <Avatar id={p.id} name={p.name} kind={p.type} size={28} src={p.avatar_url} color={p.color} />
            <div className="person-main">
              <div className="person-name">
                <span>{p.name}</span>
                {p.type === "role" && p.handle ? <Handle handle={p.handle} /> : null}
                {p.type === "role" && p.instance ? <ComputerBadge computer={p.instance} /> : null}
                {p.type === "role" && p.status === "disabled" ? <Tag tone="off">已停用</Tag> : null}
              </div>
              <div className="small muted">{fmtRelative(p.joined_at)}加入</div>
            </div>
            {external ? null : (
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => void remove(p.type, p.id, p.name)}>
                {p.type === "user" && p.id === me?.id ? "离开" : "移除"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {inviting ? (
        <InviteDialog
          topic={topic}
          onClose={() => setInviting(false)}
          onDone={(t) => {
            setInviting(false);
            onTopicChange(t);
          }}
        />
      ) : null}
    </>
  );
}

/** The two AI employees of a direct conversation: who they are and where they work; nothing to change here. */
function PairRolesTab({ topic }: { topic: Topic }) {
  const dir = useDirectory();
  const { can } = useAuth();
  const roles = (topic.participants ?? []).filter((x) => x.type === "role");
  return (
    <div className="dm-role">
      {roles.map((p) => (
        <div key={p.id} className="person">
          <Avatar id={p.id} name={p.name} kind="role" size={32} src={p.avatar_url} color={p.color} />
          <div className="person-main">
            <div className="person-name">
              <strong>{p.name}</strong>
              {p.handle ? <Handle handle={p.handle} /> : null}
              {p.instance ? <ComputerBadge computer={p.instance} /> : null}
              {p.status === "disabled" ? <Tag tone="off">已停用</Tag> : null}
            </div>
            {dir.roleById.get(p.id)?.description ? (
              <div className="small">{dir.roleById.get(p.id)?.description}</div>
            ) : null}
          </div>
          {can("role.manage") ? (
            <Link to={`/roles/${p.id}`} className="btn btn-xs">
              编辑 AI 员工
            </Link>
          ) : null}
        </div>
      ))}
      <p className="small muted side-note">
        每位 AI 员工只能主动联系在它的设置「协作」中允许的 AI
        员工，对方的回复不需要设置。这段对话里没有成员，不能邀请其他成员或 AI 员工，也不能关联话题或添加触发器。
      </p>
    </div>
  );
}

/** The other side of a DM: the role, what it does and where it works. */
function DmRoleTab({ topic }: { topic: Topic }) {
  const dir = useDirectory();
  const { can } = useAuth();
  const { newTopic } = useTopics();
  const p = topic.participants?.find((x) => x.type === "role");
  if (!p) return <Empty title="这段私信没有 AI 员工" />;
  const role = dir.roleById.get(p.id);
  return (
    <div className="dm-role">
      <div className="person">
        <Avatar id={p.id} name={p.name} kind="role" size={40} src={p.avatar_url} color={p.color} />
        <div className="person-main">
          <div className="person-name">
            <strong>{p.name}</strong>
            {p.handle ? <Handle handle={p.handle} /> : null}
            {p.status === "disabled" ? <Tag tone="off">已停用</Tag> : null}
          </div>
          {role?.description ? <div className="small">{role.description}</div> : null}
        </div>
      </div>
      <KV
        items={[
          ["虚拟电脑", p.instance ? <ComputerBadge key="c" computer={p.instance} /> : "未分配"],
          ["模型", role?.model?.label ?? "—"],
        ]}
      />
      <p className="small muted side-note">
        私信只在你和 {p.name} 之间：消息不需要 @，都会交给它；不能邀请其他成员或 AI 员工。需要多人或多位 AI
        员工一起处理时，请新建话题。
      </p>
      <div className="btn-row">
        {can("topic.create") ? (
          <button type="button" className="btn btn-xs" onClick={newTopic}>
            新建话题
          </button>
        ) : null}
        {can("role.manage") ? (
          <Link to={`/roles/${p.id}`} className="btn btn-xs">
            编辑 AI 员工
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function FilesTab({ topic }: { topic: Topic }) {
  const dir = useDirectory();
  const { run } = useAction();
  const { confirm } = useFeedback();
  const res = useResource(() => api.get<Artifact[]>(`/api/topics/${topic.id}/files`), [topic.id]);
  return (
    <Loaded res={res}>
      {(rows) =>
        rows.length ? (
          <ul className="file-list">
            {rows.map((f) => (
              <li key={f.id}>
                <div className="file-main">
                  <button
                    type="button"
                    className="link-btn"
                    title="下载到你自己的电脑"
                    onClick={() => void run(() => downloadFile(f.id, f.name))}
                  >
                    {f.name}
                  </button>
                  <div className="small muted">
                    {fmtBytes(f.size)} ·{" "}
                    {f.kind === "upload" ? "成员上传" : f.kind === "generated" ? "AI 员工从虚拟电脑分享" : f.kind} ·{" "}
                    {f.created_by_type === "role" ? dir.roleLabel(f.created_by_id) : dir.userName(f.created_by_id)} ·{" "}
                    {fmtRelative(f.created_at)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "删除文件",
                        body: <p>删除「{f.name}」？文件内容会被永久清除。</p>,
                        danger: true,
                        confirmLabel: "删除",
                      })
                    ) {
                      const ok = await run(() => api.del(`/api/files/${f.id}`), "文件已删除");
                      if (ok) void res.reload();
                    }
                  }}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            title={
              topic.kind === "dm"
                ? "这段私信还没有文件"
                : topic.kind === "pair"
                  ? "这段对话还没有文件"
                  : "这个话题还没有文件"
            }
            hint={
              topic.kind === "pair"
                ? "两位 AI 员工从虚拟电脑分享的文件会出现在这里。下载会保存到你自己的电脑。"
                : "在输入框旁点击「附件」，从你自己的电脑上传；AI 员工从虚拟电脑分享的文件也会出现在这里。下载会保存到你自己的电脑。"
            }
          />
        )
      }
    </Loaded>
  );
}

function NotesTab({ topic, version }: { topic: Topic; version: number }) {
  const dm = topic.kind === "dm";
  const pair = topic.kind === "pair";
  const { can } = useAuth();
  const dir = useDirectory();
  const roles = (topic.participants ?? []).filter((p) => p.type === "role");
  // A system administrator has no skills.
  const skilled = roles.filter((r) => !dir.roleById.get(r.id)?.system_admin);
  return (
    <div className="memory-groups">
      <details className="memory-group" open>
        <summary>{dm ? "私信记忆" : pair ? "对话记忆" : "话题记忆"}</summary>
        <div className="memory-group-body">
          <p className="small muted side-note">
            {dm
              ? "这里的记忆只在这段私信中使用，不会带入其他话题和其他 AI 员工的私信。"
              : pair
                ? "这里的记忆只在这两位 AI 员工的这段对话中使用，不会带入它们参与的其他话题。"
                : "话题记忆只在这个话题内使用，不会带入 AI 员工参与的其他话题。"}
          </p>
          <MemoryList
            query={{ scope: "topic", topic_id: topic.id }}
            create={{ scope: "topic", topic_id: topic.id }}
            canAdd={!!topic.can_post}
            placeholder={dm ? "这段私信的要点或约定" : "这个话题的要点或约定"}
            emptyTitle={dm ? "暂无私信记忆" : pair ? "暂无对话记忆" : "暂无话题记忆"}
            itemName={dm ? "私信记忆" : pair ? "对话记忆" : "话题记忆"}
            compact
            version={version}
          />
        </div>
      </details>
      {can("role.manage") ? (
        <details className="memory-group" open>
          <summary>AI 员工记忆</summary>
          <div className="memory-group-body">
            <p className="small muted side-note">属于每位 AI 员工自己，在它参与的所有话题和私信中使用。</p>
            {roles.length ? (
              roles.map((role) => (
                <details key={role.id} className="memory-role" open>
                  <summary>
                    <RoleBadge role={role} />
                  </summary>
                  <MemoryList
                    query={{ scope: "role", role_id: role.id }}
                    create={{ scope: "role", role_id: role.id }}
                    placeholder="这位 AI 员工在各处都适用的工作规则或经验"
                    emptyTitle="暂无 AI 员工记忆"
                    itemName="AI 员工记忆"
                    maxChars={1000}
                    compact
                    version={version}
                  />
                </details>
              ))
            ) : (
              <Empty title="这个话题还没有 AI 员工参与" />
            )}
          </div>
        </details>
      ) : null}
      {can("role.manage") ? (
        <details className="memory-group" open>
          <summary>AI 员工技能</summary>
          <div className="memory-group-body">
            <p className="small muted side-note">
              每位 AI 员工做某类工作的方法，名称和说明随它的系统提示词给出，需要时读取全文。
            </p>
            {skilled.length ? (
              skilled.map((role) => (
                <details key={role.id} className="skill-role" open>
                  <summary>
                    <RoleBadge role={role} />
                  </summary>
                  <SkillList roleId={role.id} compact version={version} />
                </details>
              ))
            ) : (
              <Empty title={roles.length ? "系统管理员没有技能" : "这个话题还没有 AI 员工参与"} />
            )}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function SettingsTab({
  topic,
  onTopicChange,
  onCleared,
}: {
  topic: Topic;
  onTopicChange: (t: Topic) => void;
  onCleared: () => void;
}) {
  const { run, busy } = useAction();
  const [title, setTitle] = useState(topic.title);
  const [goal, setGoal] = useState(topic.goal);

  useEffect(() => {
    setTitle(topic.title);
    setGoal(topic.goal);
    // Participant updates in the same settings page must not reset the configuration draft.
  }, [topic.title, topic.goal]);

  const patch = async (body: Record<string, unknown>, success: string): Promise<boolean> => {
    const t = await run(() => api.patch<Topic>(`/api/topics/${topic.id}`, body), success);
    if (t) onTopicChange(t);
    return !!t;
  };
  const saveSettings = () =>
    title.trim() ? patch({ title: title.trim(), goal }, "设置已保存") : Promise.resolve(false);
  useUnsavedChanges(title !== topic.title || goal !== topic.goal, saveSettings);

  // A topic is configured with its name and goal; the response mode is switched in the topic header.
  return (
    <div className="settings">
      <HandlerRoleBlock topic={topic} onTopicChange={onTopicChange} />
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void saveSettings();
        }}
      >
        <Field label="标题">
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field
          label="目标"
          hint="这个话题是做什么的、工作有哪些要求（例如收到 webhook 或定时触发后怎么处理）。这里的每位 AI 员工都会读到，自动模式下调度模型也会参考；显示在标题下方。"
        >
          <textarea rows={6} maxLength={16000} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !title.trim()}>
          保存设置
        </button>
      </form>

      <div className="settings-block">
        <h4>归档</h4>
        <p className="small muted">
          {topic.status === "archived"
            ? "话题已归档，只能查看。恢复后参与者可以继续发言。"
            : "归档后话题只读，进行中的任务会被重新检查并停止。"}
        </p>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() =>
            void patch(
              { status: topic.status === "archived" ? "active" : "archived" },
              topic.status === "archived" ? "话题已恢复" : "话题已归档",
            )
          }
        >
          {topic.status === "archived" ? "恢复话题" : "归档话题"}
        </button>
      </div>

      <CleanupBlock topic={topic} onCleared={onCleared} />
    </div>
  );
}

/**
 * A DM has nothing to configure: it is always you and its role; nor has the direct conversation of two AI
 * employees. Only their history can be cleared, and a Slack or Feishu DM with the bot may choose its AI employee.
 */
function DmSettings({
  topic,
  onTopicChange,
  onCleared,
}: {
  topic: Topic;
  onTopicChange: (t: Topic) => void;
  onCleared: () => void;
}) {
  const roleNames = (topic.participants ?? []).filter((p) => p.type === "role").map((p) => p.name);
  return (
    <div className="settings">
      <HandlerRoleBlock topic={topic} onTopicChange={onTopicChange} />
      <p className="small muted side-note">
        {topic.kind === "pair"
          ? `这是 ${roleNames.join(" 与 ")} 之间一直保留的直接对话：没有标题、成员或响应方式可设置，也不需要归档。不想保留的内容可以在下面清空。`
          : `私信是你和 ${roleNames[0] ?? "AI 员工"} 之间一直保留的对话：没有标题、可见范围或响应方式可设置，也不需要归档。不想保留的内容可以在下面清空。`}
      </p>
      {topic.status === "active" ? <CleanupBlock topic={topic} onCleared={onCleared} /> : null}
    </div>
  );
}

/**
 * The AI employee working behind a Slack, Feishu or GitHub conversation: its connection's by default, or one
 * chosen for this conversation. Outwardly it always speaks as the app (bot). Changing it brings the new AI employee
 * in and the previous one out, whose work here stops.
 */
function HandlerRoleBlock({ topic, onTopicChange }: { topic: Topic; onTopicChange: (t: Topic) => void }) {
  const dir = useDirectory();
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const channel = topic.channel;
  if (!channel) return null;
  const fallback = channel.role_id ?? null;
  const chosen = topic.handler_role_id ?? null;
  const handle = (id: string | null) => (id ? `@${dir.roleById.get(id)?.handle ?? id}` : "未选择");
  // A system administrator works only in the console; a disabled AI employee only while it is still the choice.
  const choices = dir.roles.filter((r) => !r.system_admin && (r.status === "active" || r.id === chosen));
  const change = async (value: string) => {
    const next = value || null;
    if (next === chosen) return;
    const from = chosen ?? fallback;
    const to = next ?? fallback;
    if (from !== to) {
      const ok = await confirm({
        title: "更换处理的 AI 员工",
        body: (
          <p>
            「{topic.title}」改由 {to ? dir.roleLabel(to) : "接入默认的 AI 员工（尚未选择）"} 处理。
            {from ? `${dir.roleLabel(from)} 离开这个会话，它在这里进行中的工作会停止。` : ""}
            对外仍以应用（机器人）的身份发言。
          </p>
        ),
        confirmLabel: "更换",
      });
      if (!ok) return;
    }
    const t = await run(
      () => api.patch<Topic>(`/api/topics/${topic.id}`, { handler_role_id: next }),
      "处理的 AI 员工已更换",
    );
    if (t) onTopicChange(t);
  };
  return (
    <div className="settings-block">
      <Field
        label="处理的 AI 员工"
        hint="对外始终以应用（机器人）的身份发言，这里选择在背后处理这个会话的 AI 员工。更换后，这个会话的工作交给新的 AI 员工，原来的 AI 员工离开会话，它在这里进行中的工作会停止。"
      >
        <select value={chosen ?? ""} disabled={busy} onChange={(e) => void change(e.target.value)}>
          <option value="">跟随接入默认（{handle(fallback)}）</option>
          {choices.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} @{r.handle}
              {r.status === "active" ? "" : "（已停用）"}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** Permanently clear a topic's or DM's messages, memories and files. */
function CleanupBlock({ topic, onCleared }: { topic: Topic; onCleared: () => void }) {
  const { confirm, toast } = useFeedback();
  const { run, busy } = useAction();
  const [clean, setClean] = useState({ messages: true, memories: true, files: true, trigger_history: true });
  const dm = topic.kind === "dm";
  const name = dm
    ? `与 ${topic.participants?.find((p) => p.type === "role")?.name ?? "AI 员工"} 的私信`
    : `「${topic.title}」`;
  return (
    <div className="settings-block settings-danger">
      <h4>{dm ? "清空私信记录" : "清理数据"}</h4>
      <p className="small muted">
        永久清除所选内容。删除消息会一并删除由这些消息产生的记忆，任务执行记录也会被清空；审计只保留元数据。
      </p>
      <div className="check-col">
        <label className="check">
          <input
            type="checkbox"
            checked={clean.messages}
            onChange={(e) => setClean({ ...clean, messages: e.target.checked })}
          />
          消息与任务记录
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={clean.memories}
            onChange={(e) => setClean({ ...clean, memories: e.target.checked })}
          />
          {dm ? "私信记忆" : "话题记忆"}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={clean.files}
            onChange={(e) => setClean({ ...clean, files: e.target.checked })}
          />
          文件
        </label>
        {topic.kind === "group" ? (
          <label className="check">
            <input
              type="checkbox"
              checked={clean.trigger_history}
              onChange={(e) => setClean({ ...clean, trigger_history: e.target.checked })}
            />
            触发历史（含原始请求及未处理事件）
          </label>
        ) : null}
      </div>
      <button
        type="button"
        className="btn btn-sm btn-danger"
        disabled={busy || (!clean.messages && !clean.memories && !clean.files && !clean.trigger_history)}
        onClick={async () => {
          const ok = await confirm({
            title: dm ? "永久清空私信记录" : "永久清理话题数据",
            body: <p>此操作不可撤销。确定清除{name}中所选的内容？</p>,
            confirmLabel: dm ? "永久清空" : "永久清理",
            danger: true,
          });
          if (!ok) return;
          const out = await run(() =>
            api.post<{ messages: number; memories: number; files: number }>(`/api/topics/${topic.id}/cleanup`, {
              ...clean,
              confirm: true,
            }),
          );
          if (out) {
            toast(`已清理 ${out.messages} 条消息、${out.memories} 条记忆、${out.files} 个文件`, "ok");
            onCleared();
          }
        }}
      >
        {dm ? "清空所选内容" : "清理所选数据"}
      </button>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, downloadFile } from "../../api/client";
import type { Approval, Artifact, Memory, Task, Topic } from "../../api/types";
import { fmtBytes, fmtRelative, fmtTime, isActiveTask, isRestricted, RESPONSE_MODE } from "../../lib/format";
import { type Resource, useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { useTopics } from "../../lib/topics";
import { useLeaveGuard, useUnsavedChanges } from "../../lib/unsaved";
import { useAction, useFeedback } from "../../ui/feedback";
import {
  Avatar,
  ComputerBadge,
  Empty,
  Field,
  FieldGroup,
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
import { TaskControls, TaskStatusChip } from "../tasks/taskParts";
import { TopicComputer, topicComputers } from "./TopicComputer";
import { InviteDialog, PublishDialog } from "./topicDialogs";

export function TopicSidePanel({
  topic,
  onTopicChange,
  onCleared,
  version,
  computerMax = false,
  onToggleComputerMax,
}: {
  topic: Topic;
  onTopicChange: (t: Topic) => void;
  onCleared: () => void;
  /** Bumped by live task events so the task / approval lists refresh. */
  version: number;
  /** The computer tab is laid over the whole topic (tabs hidden). */
  computerMax?: boolean;
  onToggleComputerMax?: () => void;
}) {
  // A DM is always you and one role: its tab shows the role instead of a participant list.
  const dm = topic.kind === "dm";
  const [tab, setTab] = useState("tasks");
  const guard = useLeaveGuard();
  const hasComputers = topicComputers(topic).length > 0;
  // Maximised, the panel shows only the computer (the tab row is hidden).
  const shown = computerMax ? "computer" : tab;
  const tasks = useResource(() => api.get<Task[]>("/api/tasks", { topic_id: topic.id }), [topic.id]);
  const approvals = useResource(
    () =>
      api
        .get<Approval[]>("/api/approvals", { status: "pending" })
        .then((rows) => rows.filter((a) => a.topic_id === topic.id)),
    [topic.id],
  );

  useEffect(() => {
    if (version > 0) {
      void tasks.reload();
      void approvals.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const activeCount = (tasks.data ?? []).filter((t) => isActiveTask(t.status)).length;

  return (
    <aside className={`side-panel${computerMax ? " side-panel-max" : ""}`}>
      <Tabs
        value={tab}
        onChange={(k) => guard(() => setTab(k))}
        tabs={[
          { key: "tasks", label: "任务", badge: activeCount },
          { key: "approvals", label: "审批", badge: approvals.data?.length },
          { key: "computer", label: "虚拟电脑", hidden: !hasComputers },
          { key: "people", label: "参与者", hidden: dm },
          { key: "role", label: "角色", hidden: !dm },
          { key: "files", label: "文件" },
          { key: "notes", label: "记忆" },
          { key: "settings", label: "设置" },
        ]}
      />
      <div className="side-body">
        {shown === "tasks" ? <TasksTab res={tasks} dm={dm} /> : null}
        {shown === "approvals" ? (
          <Loaded res={approvals}>
            {(rows) =>
              rows.length ? (
                <div className="approval-list">
                  {rows.map((a) => (
                    <ApprovalCard
                      key={a.id}
                      approval={a}
                      showContext={false}
                      onDecided={() => {
                        void approvals.reload();
                        void tasks.reload();
                      }}
                    />
                  ))}
                </div>
              ) : (
                <Empty title="没有待处理的审批" hint="角色需要确认才能继续时，会在这里出现。" />
              )
            }
          </Loaded>
        ) : null}
        {shown === "computer" ? (
          <TopicComputer topic={topic} maximized={computerMax} onToggleMax={() => onToggleComputerMax?.()} />
        ) : null}
        {shown === "people" ? <PeopleTab topic={topic} onTopicChange={onTopicChange} /> : null}
        {shown === "role" ? <DmRoleTab topic={topic} /> : null}
        {shown === "files" ? <FilesTab topic={topic} /> : null}
        {shown === "notes" ? <NotesTab topic={topic} /> : null}
        {shown === "settings" ? (
          dm ? (
            <DmSettings topic={topic} onCleared={onCleared} />
          ) : (
            <SettingsTab topic={topic} onTopicChange={onTopicChange} onCleared={onCleared} />
          )
        ) : null}
      </div>
    </aside>
  );
}

function TasksTab({ res, dm }: { res: Resource<Task[]>; dm: boolean }) {
  const [onlyActive, setOnlyActive] = useState(false);
  return (
    <>
      <div className="side-toolbar">
        <Toggle checked={onlyActive} onChange={setOnlyActive} label="只看进行中" />
      </div>
      <Loaded res={res}>
        {(rows) => {
          const list = onlyActive ? rows.filter((t) => isActiveTask(t.status)) : rows;
          if (!list.length)
            return (
              <Empty
                title="还没有任务"
                hint={
                  dm
                    ? "给角色发消息后，它接下的工作会作为任务出现在这里。"
                    : "在消息里 @ 一个角色，它接下的工作会作为任务出现在这里。"
                }
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
    </>
  );
}

function PeopleTab({ topic, onTopicChange }: { topic: Topic; onTopicChange: (t: Topic) => void }) {
  const { me } = useAuth();
  const { confirm } = useFeedback();
  const { run } = useAction();
  const [inviting, setInviting] = useState(false);
  const participants = topic.participants ?? [];

  const remove = async (type: string, id: string, name: string) => {
    const self = type === "user" && id === me?.id;
    const ok = await confirm({
      title: self ? "离开话题" : `移除 ${name}`,
      body: (
        <p>
          {self
            ? "离开后你将无法再查看这个话题。"
            : type === "role"
              ? "移除后该角色不再接收这个话题的消息；它在这个话题中进行中的任务会被重新检查，不再被允许的会被取消。"
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
          {participants.filter((p) => p.type === "role").length} 个角色
        </span>
        {topic.can_post ? (
          <button type="button" className="btn btn-xs" onClick={() => setInviting(true)}>
            邀请
          </button>
        ) : null}
      </div>
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
            <button type="button" className="btn btn-xs btn-ghost" onClick={() => void remove(p.type, p.id, p.name)}>
              {p.type === "user" && p.id === me?.id ? "离开" : "移除"}
            </button>
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

/** The other side of a DM: the role, what it does and where it works. */
function DmRoleTab({ topic }: { topic: Topic }) {
  const dir = useDirectory();
  const { can } = useAuth();
  const { newTopic } = useTopics();
  const p = topic.participants?.find((x) => x.type === "role");
  if (!p) return <Empty title="这段私信没有角色" />;
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
        私信只在你和 {p.name} 之间：消息不需要
        @，都会交给它；不能邀请其他成员或角色。需要多人或多个角色一起处理时，请新建话题。
      </p>
      <div className="btn-row">
        {can("topic.create") ? (
          <button type="button" className="btn btn-xs" onClick={newTopic}>
            新建话题
          </button>
        ) : null}
        {can("role.manage") ? (
          <Link to={`/roles/${p.id}`} className="btn btn-xs">
            编辑角色
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
                    {f.kind === "upload" ? "成员上传" : f.kind === "generated" ? "角色从虚拟电脑分享" : f.kind} ·{" "}
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
            title={topic.kind === "dm" ? "这段私信还没有文件" : "这个话题还没有文件"}
            hint="在输入框旁点击「附件」，从你自己的电脑上传；角色从虚拟电脑分享的文件也会出现在这里。下载会保存到你自己的电脑。"
          />
        )
      }
    </Loaded>
  );
}

function NotesTab({ topic }: { topic: Topic }) {
  const { run, busy } = useAction();
  const [text, setText] = useState("");
  const res = useResource(() => api.get<Memory[]>("/api/memories", { scope: "topic", topic_id: topic.id }), [topic.id]);
  return (
    <>
      <p className="small muted side-note">
        {topic.kind === "dm"
          ? "这里的记忆只在这段私信中使用，不会带入其他话题；角色在私信里还会参考你的私密记忆（在个人页查看）。"
          : "话题记忆只在这个话题内使用，不会带入角色参与的其他话题。"}
      </p>
      {topic.can_post ? (
        <form
          className="note-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            const m = await run(() =>
              api.post<Memory>("/api/memories", { scope: "topic", topic_id: topic.id, content: text.trim() }),
            );
            if (m) {
              setText("");
              res.setData((prev) => [m, ...(prev ?? [])]);
            }
          }}
        >
          <textarea
            rows={2}
            value={text}
            placeholder={topic.kind === "dm" ? "记下这段私信的要点或约定" : "记下这个话题的要点或约定"}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn btn-xs btn-primary" disabled={busy || !text.trim()}>
            添加
          </button>
        </form>
      ) : null}
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <ul className="memory-list">
              {rows.map((m) => (
                <li key={m.id}>
                  <div className="memory-text">{m.content}</div>
                  <div className="small muted">
                    {m.created_by_type === "role" ? "角色记录" : "成员记录"} · {fmtRelative(m.created_at)}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={async () => {
                        const ok = await run(() => api.del(`/api/memories/${m.id}`));
                        if (ok) res.setData((prev) => prev?.filter((x) => x.id !== m.id));
                      }}
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title={topic.kind === "dm" ? "暂无私信记忆" : "暂无话题记忆"} />
          )
        }
      </Loaded>
    </>
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
  const [responseMode, setResponseMode] = useState(topic.response_mode);
  const [rounds, setRounds] = useState(topic.max_auto_rounds?.toString() ?? "");
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    setTitle(topic.title);
    setGoal(topic.goal);
    setResponseMode(topic.response_mode);
    setRounds(topic.max_auto_rounds?.toString() ?? "");
  }, [topic]);

  const patch = async (body: Record<string, unknown>, success: string): Promise<boolean> => {
    const t = await run(() => api.patch<Topic>(`/api/topics/${topic.id}`, body), success);
    if (t) onTopicChange(t);
    return !!t;
  };
  const saveSettings = () =>
    title.trim()
      ? patch(
          {
            title: title.trim(),
            goal,
            ...(topic.kind === "group" ? { response_mode: responseMode } : {}),
            max_auto_rounds: rounds ? Number(rounds) : null,
          },
          "设置已保存",
        )
      : Promise.resolve(false);
  useUnsavedChanges(
    title !== topic.title ||
      goal !== topic.goal ||
      responseMode !== topic.response_mode ||
      rounds !== (topic.max_auto_rounds?.toString() ?? ""),
    saveSettings,
  );

  return (
    <div className="settings">
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
        <Field label="目标" hint="这个话题要完成什么；显示在标题下方，角色接到任务时也会读到。">
          <textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>
        {topic.kind === "group" ? (
          <FieldGroup label="角色响应方式">
            <div className="mode-options">
              {(["mention", "auto"] as const).map((m) => (
                <label key={m} className="check mode-option" title={RESPONSE_MODE[m].hint}>
                  <input type="radio" checked={responseMode === m} onChange={() => setResponseMode(m)} />
                  <span>
                    <strong>{RESPONSE_MODE[m].label}</strong>
                    <span className="small muted">{RESPONSE_MODE[m].short}</span>
                  </span>
                </label>
              ))}
            </div>
          </FieldGroup>
        ) : null}
        <Field label="角色自动讨论轮次上限" hint="防止角色之间相互 @ 无限讨论；留空使用系统默认。">
          <input type="number" min={0} max={50} value={rounds} onChange={(e) => setRounds(e.target.value)} />
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

      {topic.kind === "group" ? (
        <div className="settings-block">
          <h4>发布到外部频道</h4>
          <p className="small muted">
            把话题发布到 Slack 或飞书的频道 / 群聊，并在对应 thread
            中继续交流。需要对该通讯接入拥有「发布话题到外部频道」权限。
            {topic.channel ? " 这个话题已经关联了一个外部会话。" : ""}
          </p>
          <button type="button" className="btn btn-sm" onClick={() => setPublishing(true)}>
            发布到频道
          </button>
          {publishing ? (
            <PublishDialog
              topic={topic}
              onClose={() => setPublishing(false)}
              onPublished={() => {
                // The topic now carries its external link (`external`).
                void api
                  .get<Topic>(`/api/topics/${topic.id}`)
                  .then(onTopicChange)
                  .catch(() => {});
              }}
            />
          ) : null}
        </div>
      ) : null}

      <CleanupBlock topic={topic} onCleared={onCleared} />
    </div>
  );
}

/** A DM has nothing to configure: it is always you and its role. Only its history can be cleared. */
function DmSettings({ topic, onCleared }: { topic: Topic; onCleared: () => void }) {
  const roleName = topic.participants?.find((p) => p.type === "role")?.name ?? "角色";
  return (
    <div className="settings">
      <p className="small muted side-note">
        私信是你和 {roleName}{" "}
        之间一直保留的对话：没有标题、可见范围或响应方式可设置，也不需要归档。不想保留的内容可以在下面清空。
      </p>
      {topic.status === "active" ? <CleanupBlock topic={topic} onCleared={onCleared} /> : null}
    </div>
  );
}

/** Permanently clear a topic's or DM's messages, memories and files. */
function CleanupBlock({ topic, onCleared }: { topic: Topic; onCleared: () => void }) {
  const { confirm, toast } = useFeedback();
  const { run, busy } = useAction();
  const [clean, setClean] = useState({ messages: true, memories: true, files: true });
  const dm = topic.kind === "dm";
  const name = dm
    ? `与 ${topic.participants?.find((p) => p.type === "role")?.name ?? "角色"} 的私信`
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
      </div>
      <button
        type="button"
        className="btn btn-sm btn-danger"
        disabled={busy || (!clean.messages && !clean.memories && !clean.files)}
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

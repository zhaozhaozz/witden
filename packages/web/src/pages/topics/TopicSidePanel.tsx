import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, downloadFile } from "../../api/client";
import type { AgentSession, Approval, Artifact, Memory, Task, Topic } from "../../api/types";
import { fmtBytes, fmtRelative, fmtTime, isActiveTask, isRestricted } from "../../lib/format";
import { type Resource, useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import { Avatar, Empty, Field, Guarded, Handle, Loaded, Tabs, Tag, Toggle } from "../../ui/kit";
import { ApprovalCard } from "../approvalParts";
import { AgentSessionList } from "../sessionParts";
import { TaskControls, TaskStatusChip } from "../tasks/taskParts";
import { InviteDialog, PublishDialog } from "./topicDialogs";

export function TopicSidePanel({
  topic,
  canAdmin,
  onTopicChange,
  onCleared,
  version,
}: {
  topic: Topic;
  /** Owner, or administrator of a group topic (may archive, remove and clean up, not edit). */
  canAdmin: boolean;
  onTopicChange: (t: Topic) => void;
  onCleared: () => void;
  /** Bumped by live task events so the task / approval lists refresh. */
  version: number;
}) {
  const manageOnly = topic.can_view === false;
  const [tab, setTab] = useState(manageOnly ? "people" : "tasks");
  const tasks = useResource(() => api.get<Task[]>("/api/tasks", { topic_id: topic.id }), [topic.id], !manageOnly);
  const approvals = useResource(
    () =>
      api
        .get<Approval[]>("/api/approvals", { status: "pending" })
        .then((rows) => rows.filter((a) => a.topic_id === topic.id)),
    [topic.id],
    !manageOnly,
  );

  useEffect(() => {
    if (version > 0 && !manageOnly) {
      void tasks.reload();
      void approvals.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const activeCount = (tasks.data ?? []).filter((t) => isActiveTask(t.status)).length;

  return (
    <aside className="side-panel">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "tasks", label: "任务", badge: activeCount, hidden: manageOnly },
          { key: "approvals", label: "审批", badge: approvals.data?.length, hidden: manageOnly },
          { key: "people", label: "参与者" },
          { key: "sessions", label: "会话", hidden: manageOnly },
          { key: "files", label: "文件", hidden: manageOnly },
          { key: "notes", label: "记忆", hidden: manageOnly },
          { key: "settings", label: "设置" },
        ]}
      />
      <div className="side-body">
        {tab === "tasks" ? <TasksTab res={tasks} /> : null}
        {tab === "approvals" ? (
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
        {tab === "people" ? <PeopleTab topic={topic} canAdmin={canAdmin} onTopicChange={onTopicChange} /> : null}
        {tab === "sessions" ? <SessionsTab topic={topic} /> : null}
        {tab === "files" ? <FilesTab topic={topic} canAdmin={canAdmin} /> : null}
        {tab === "notes" ? <NotesTab topic={topic} /> : null}
        {tab === "settings" ? (
          <SettingsTab topic={topic} canAdmin={canAdmin} onTopicChange={onTopicChange} onCleared={onCleared} />
        ) : null}
      </div>
    </aside>
  );
}

function TasksTab({ res }: { res: Resource<Task[]> }) {
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
            return <Empty title="还没有任务" hint="在消息里 @ 一个角色，它接下的工作会作为任务出现在这里。" />;
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
                    {t.owner ? <Handle handle={t.owner.handle} /> : null}
                    {t.instance ? <span>电脑 {t.instance.name}</span> : <span>无电脑</span>}
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

function PeopleTab({
  topic,
  canAdmin,
  onTopicChange,
}: {
  topic: Topic;
  canAdmin: boolean;
  onTopicChange: (t: Topic) => void;
}) {
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
            <Avatar id={p.id} name={p.name} kind={p.type} size={28} src={p.avatar_url} />
            <div className="person-main">
              <div className="person-name">
                <span>{p.name}</span>
                {p.type === "role" && p.handle ? <Handle handle={p.handle} /> : null}
                {p.is_owner ? <Tag tone="accent">负责人</Tag> : null}
                {p.type === "role" && p.status === "disabled" ? <Tag tone="off">已停用</Tag> : null}
              </div>
              <div className="small muted">
                {fmtRelative(p.joined_at)}加入
                {p.history_from ? ` · 可见 ${fmtTime(p.history_from)} 之后的消息` : " · 可见全部历史"}
              </div>
            </div>
            {(canAdmin && !(p.type === "user" && p.id === me?.id)) ||
            (p.type === "user" && p.id === me?.id && !p.is_owner) ? (
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => void remove(p.type, p.id, p.name)}>
                {p.type === "user" && p.id === me?.id ? "离开" : "移除"}
              </button>
            ) : null}
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

function SessionsTab({ topic }: { topic: Topic }) {
  const res = useResource(() => api.get<AgentSession[]>(`/api/topics/${topic.id}/sessions`), [topic.id]);
  return (
    <>
      <p className="small muted side-note">
        每个角色在这个话题里有自己的会话：它在这里接到的任务共享这份上下文，不会带到其他话题。会话笔记是此前交付结果的摘要，角色继续工作时会读到。
      </p>
      <Loaded res={res}>{(rows) => <AgentSessionList sessions={rows} by="role" />}</Loaded>
    </>
  );
}

function FilesTab({ topic, canAdmin }: { topic: Topic; canAdmin: boolean }) {
  const { me } = useAuth();
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
                  <button type="button" className="link-btn" onClick={() => void run(() => downloadFile(f.id, f.name))}>
                    {f.name}
                  </button>
                  <div className="small muted">
                    {fmtBytes(f.size)} · {f.kind === "upload" ? "上传" : f.kind === "generated" ? "角色生成" : f.kind} ·{" "}
                    {f.created_by_type === "role" ? dir.roleLabel(f.created_by_id) : dir.userName(f.created_by_id)} ·{" "}
                    {fmtRelative(f.created_at)}
                  </div>
                </div>
                {f.created_by_id === me?.id || canAdmin ? (
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
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="这个话题还没有文件" hint="在输入框旁点击「附件」上传；角色生成的文件也会出现在这里。" />
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
      <p className="small muted side-note">话题记忆只在这个话题内使用，不会带入角色参与的其他话题。</p>
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
            placeholder="记下这个话题的要点或约定"
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
                    {topic.is_owner ? (
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
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="暂无话题记忆" />
          )
        }
      </Loaded>
    </>
  );
}

function SettingsTab({
  topic,
  canAdmin,
  onTopicChange,
  onCleared,
}: {
  topic: Topic;
  canAdmin: boolean;
  onTopicChange: (t: Topic) => void;
  onCleared: () => void;
}) {
  const { confirm, toast } = useFeedback();
  const { run, busy } = useAction();
  const [title, setTitle] = useState(topic.title);
  const [goal, setGoal] = useState(topic.goal);
  const [visibility, setVisibility] = useState(topic.visibility);
  const [history, setHistory] = useState(topic.history_policy);
  const [rounds, setRounds] = useState(topic.max_auto_rounds?.toString() ?? "");
  const [publishing, setPublishing] = useState(false);
  const [clean, setClean] = useState({ messages: true, memories: true, files: true });

  useEffect(() => {
    setTitle(topic.title);
    setGoal(topic.goal);
    setVisibility(topic.visibility);
    setHistory(topic.history_policy);
    setRounds(topic.max_auto_rounds?.toString() ?? "");
  }, [topic]);

  const patch = async (body: Record<string, unknown>, success: string) => {
    const t = await run(() => api.patch<Topic>(`/api/topics/${topic.id}`, body), success);
    if (t) onTopicChange(t);
  };

  if (!canAdmin) {
    return (
      <div className="side-note">
        <p className="muted small">只有话题负责人可以修改设置、发布或清理话题。</p>
      </div>
    );
  }

  return (
    <div className="settings">
      {!topic.is_owner ? (
        <p className="small muted side-note">
          你以管理员身份管理这个话题：可以归档、移除参与者和清理数据；修改标题、可见范围或发布到外部频道需要话题负责人操作。
        </p>
      ) : null}
      {topic.is_owner ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void patch(
              {
                title: title.trim(),
                goal,
                ...(topic.kind === "group" ? { visibility } : {}),
                history_policy: history,
                max_auto_rounds: rounds ? Number(rounds) : null,
              },
              "设置已保存",
            );
          }}
        >
          <Field label="标题">
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="目标">
            <textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
          </Field>
          {topic.kind === "group" ? (
            <Field label="可见范围">
              <select value={visibility} onChange={(e) => setVisibility(e.target.value as Topic["visibility"])}>
                <option value="private">私密：仅参与者可见</option>
                <option value="internal">团队内公开：所有成员可阅读</option>
              </select>
            </Field>
          ) : null}
          <Field label="新成员可看的历史">
            <select value={history} onChange={(e) => setHistory(e.target.value as Topic["history_policy"])}>
              <option value="since_join">只看加入之后的消息</option>
              <option value="full">可看全部历史</option>
            </select>
          </Field>
          <Field label="角色自动讨论轮次上限" hint="防止角色之间相互 @ 无限讨论；留空使用系统默认。">
            <input type="number" min={0} max={50} value={rounds} onChange={(e) => setRounds(e.target.value)} />
          </Field>
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !title.trim()}>
            保存设置
          </button>
        </form>
      ) : null}

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

      {topic.kind === "group" && topic.is_owner ? (
        <div className="settings-block">
          <h4>发布到外部频道</h4>
          <p className="small muted">
            把话题发布到 Slack 或飞书的频道 / 群聊，并在对应 thread
            中继续交流。需要对该通讯接入拥有「发布话题到外部频道」权限。
            {topic.external?.conversation_kind ? " 这个话题已经关联了一个外部会话。" : ""}
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

      <div className="settings-block settings-danger">
        <h4>清理数据</h4>
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
            话题记忆
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
              title: "永久清理话题数据",
              body: <p>此操作不可撤销。确定清理「{topic.title}」中所选的数据？</p>,
              confirmLabel: "永久清理",
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
          清理所选数据
        </button>
      </div>
    </div>
  );
}

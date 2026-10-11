import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { useLiveEvents } from "../../api/events";
import type { Artifact, Message, PostMessageResult, Topic } from "../../api/types";
import { CONVERSATION_KIND, PLATFORM_LABEL, parseTime } from "../../lib/format";
import { useDebounced, useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import { Empty, ErrorNote, Loading, Tag } from "../../ui/kit";
import { Composer } from "./Composer";
import { MessageItem, type Author } from "./MessageItem";
import { TopicSidePanel } from "./TopicSidePanel";

const PAGE = 100;
const PANEL_KEY = "witden.topicPanel";

export function TopicView({ topicId, onTopicUpdated }: { topicId: string; onTopicUpdated: () => void }) {
  const { me } = useAuth();
  const dir = useDirectory();
  const { toast, confirm } = useFeedback();
  const { run } = useAction();
  const topicRes = useResource(() => api.get<Topic>(`/api/topics/${topicId}`), [topicId]);
  // Administrators may manage a private topic they are not in, without reading it (can_view=false).
  const viewable = topicRes.data ? topicRes.data.can_view !== false : null;
  const files = useResource(() => api.get<Artifact[]>(`/api/topics/${topicId}/files`), [topicId], viewable === true);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [msgError, setMsgError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [version, setVersion] = useState(0);
  const [panel, setPanel] = useState(() => localStorage.getItem(PANEL_KEY) !== "0");
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prependAnchor = useRef<number | null>(null);

  const loadMessages = useCallback(async () => {
    try {
      const rows = await api.get<Message[]>(`/api/topics/${topicId}/messages`, { limit: PAGE });
      setMessages(rows);
      setHasMore(rows.length >= PAGE);
      setMsgError(null);
      stickToBottom.current = true;
    } catch (err) {
      setMsgError((err as Error).message);
    }
  }, [topicId]);

  useEffect(() => {
    setMessages(null);
    if (viewable) void loadMessages();
  }, [loadMessages, viewable]);

  const loadEarlier = async () => {
    if (!messages?.length) return;
    setLoadingMore(true);
    try {
      const rows = await api.get<Message[]>(`/api/topics/${topicId}/messages`, { limit: PAGE, before: messages[0].created_at });
      prependAnchor.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
      stickToBottom.current = false;
      setMessages((prev) => [...rows, ...(prev ?? [])]);
      setHasMore(rows.length >= PAGE);
    } catch (err) {
      toast((err as Error).message, "bad");
    } finally {
      setLoadingMore(false);
    }
  };

  // Keep the view pinned to the newest message unless the reader scrolled up; keep position when prepending.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prependAnchor.current !== null) {
      el.scrollTop = el.scrollHeight - prependAnchor.current;
      prependAnchor.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const bumpTasks = useDebounced(() => setVersion((v) => v + 1), 400);
  const reloadTopic = useDebounced(() => void topicRes.reload(), 300);

  const appendMessage = useCallback(
    (m: Message) => {
      setMessages((prev) => {
        if (!prev) return prev;
        if (prev.some((x) => x.id === m.id)) return prev.map((x) => (x.id === m.id ? { ...x, ...m } : x));
        return [...prev, m];
      });
      const known = new Set((files.data ?? []).map((f) => f.id));
      if (m.attachments?.some((id) => !known.has(id))) void files.reload();
    },
    [files],
  );

  const live = useLiveEvents(viewable ? { topic_id: topicId } : null, (type, data) => {
    if (type === "message.created") {
      const m = data as unknown as Message;
      if (m.topic_id !== topicId) return;
      appendMessage(m);
      // Participant changes and archive notices arrive as system messages.
      if (m.author_type === "system") reloadTopic();
      if (m.task_id) bumpTasks();
    } else if (type.startsWith("task.")) {
      bumpTasks();
    }
  });

  const topic = topicRes.data;
  const participantMap = useMemo(() => {
    const map = new Map<string, NonNullable<Topic["participants"]>[number]>();
    for (const p of topic?.participants ?? []) map.set(`${p.type}:${p.id}`, p);
    return map;
  }, [topic]);
  const fileMap = useMemo(() => new Map((files.data ?? []).map((f) => [f.id, f])), [files.data]);

  const authorOf = (m: Message): Author => {
    const id = m.author_id ?? m.id;
    if (m.author_type === "role") {
      const p = participantMap.get(`role:${id}`);
      const r = dir.roleById.get(id);
      return { kind: "role", id, name: p?.name ?? r?.name ?? "已移除的角色", handle: p?.handle ?? r?.handle, avatarUrl: p?.avatar_url ?? r?.avatar_url };
    }
    if (m.author_type === "user") {
      const p = participantMap.get(`user:${id}`);
      return { kind: "user", id, name: p?.name ?? dir.userName(id), isMe: id === me?.id };
    }
    if (m.author_type === "external") {
      return { kind: "external", id, name: `外部成员（${PLATFORM_LABEL[m.source] ?? m.source}）` };
    }
    return { kind: "system", id, name: "系统" };
  };

  const onSent = (msg: PostMessageResult) => {
    stickToBottom.current = true;
    appendMessage(msg);
    if (msg.tasks?.length) {
      const names = msg.tasks.map((t) => {
        const r = dir.roleById.get(t.owner_role_id);
        return r ? `@${r.handle}` : "角色";
      });
      toast(`已交给 ${names.join("、")} 处理，任务已创建`, "ok");
      bumpTasks();
    }
    onTopicUpdated();
  };

  const togglePanel = () => {
    setPanel((v) => {
      localStorage.setItem(PANEL_KEY, v ? "0" : "1");
      return !v;
    });
  };

  if (!topic) {
    return (
      <div className="topic-view">
        {topicRes.error ? <ErrorNote error={topicRes.error} onRetry={topicRes.reload} /> : <Loading />}
      </div>
    );
  }

  const ext = topic.external;
  // Owners, plus administrators for removing / stopping things in group topics.
  const canAdmin = topic.is_owner || (!!me?.is_admin && topic.kind === "group");
  const manageOnly = topic.can_view === false;

  return (
    <div className={`topic-view${panel ? " with-panel" : ""}`}>
      <div className="conversation">
        <header className="topic-head">
          <div className="topic-head-main">
            <h2>{topic.title}</h2>
            <div className="topic-tags">
              <Tag>{topic.kind === "dm" ? "私信" : "群组话题"}</Tag>
              {topic.kind === "group" ? (
                <Tag tone={topic.visibility === "internal" ? "info" : undefined}>
                  {topic.visibility === "internal" ? "团队内公开" : "私密"}
                </Tag>
              ) : null}
              <Tag title="新加入者可阅读的历史范围">{topic.history_policy === "full" ? "新成员可看全部历史" : "新成员只看加入后消息"}</Tag>
              {topic.source !== "internal" ? <Tag tone="accent">来自 {PLATFORM_LABEL[topic.source] ?? topic.source}</Tag> : null}
              {ext?.conversation_kind ? (
                <Tag tone="accent" title={ext.thread_key ? `thread ${ext.thread_key}` : undefined}>
                  已关联外部{CONVERSATION_KIND[ext.conversation_kind] ?? ext.conversation_kind}
                </Tag>
              ) : null}
              {topic.status === "archived" ? <Tag tone="off">已归档</Tag> : null}
              {manageOnly ? <Tag tone="wait">仅可管理</Tag> : null}
              {manageOnly ? null : (
                <span className={`live-dot${live ? " live-on" : ""}`} title={live ? "实时更新已连接" : "实时更新未连接，正在重试"}>
                  {live ? "实时" : "离线"}
                </span>
              )}
            </div>
            {topic.goal ? <p className="topic-goal">{topic.goal}</p> : null}
          </div>
          <button className="btn btn-sm" onClick={togglePanel} aria-pressed={panel}>
            {panel ? "收起侧栏" : "任务与参与者"}
          </button>
        </header>

        {manageOnly ? (
          <div className="timeline">
            <Empty
              title="这是一个你没有参与的私密话题"
              hint="作为管理员，你可以归档话题、移除参与者或清理数据，但不能阅读其中的消息、文件和任务内容。"
            />
          </div>
        ) : (
        <div
          className="timeline"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {msgError ? <ErrorNote error={msgError} onRetry={loadMessages} /> : null}
          {messages === null ? (
            <Loading />
          ) : (
            <>
              {hasMore ? (
                <div className="timeline-more">
                  <button className="btn btn-xs" disabled={loadingMore} onClick={() => void loadEarlier()}>
                    {loadingMore ? "加载中…" : "加载更早的消息"}
                  </button>
                </div>
              ) : messages.length ? (
                <div className="timeline-start small muted">
                  {participantMap.get(`user:${me?.id}`)?.history_from ? "你加入之前的消息不可见（话题设置为只看加入后的消息）" : "话题开始"}
                </div>
              ) : null}
              {!messages.length ? (
                <Empty
                  title={topic.kind === "dm" ? "开始和角色私信" : "还没有消息"}
                  hint={topic.can_post ? "用 @ 提及角色把工作交给它；角色接下的工作会出现在右侧的任务列表。" : undefined}
                />
              ) : null}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const compact =
                  !!prev &&
                  prev.author_type === m.author_type &&
                  prev.author_id === m.author_id &&
                  m.author_type !== "system" &&
                  (parseTime(m.created_at)?.getTime() ?? 0) - (parseTime(prev.created_at)?.getTime() ?? 0) < 5 * 60_000;
                const author = authorOf(m);
                return (
                  <MessageItem
                    key={m.id}
                    msg={m}
                    author={author}
                    compact={compact}
                    files={fileMap}
                    canDelete={(m.author_type === "user" && m.author_id === me?.id) || canAdmin}
                    onEdit={async (content) => {
                      const out = await run(() => api.patch<Message>(`/api/messages/${m.id}`, { content }));
                      if (out) setMessages((prev) => prev?.map((x) => (x.id === out.id ? out : x)) ?? prev);
                      return !!out;
                    }}
                    onDelete={async () => {
                      const ok = await confirm({
                        title: "删除消息",
                        body: <p>消息内容会被清空，由这条消息产生的记忆也会一并删除。</p>,
                        confirmLabel: "删除",
                        danger: true,
                      });
                      if (!ok) return;
                      const out = await run(() => api.del<{ memories_deleted: number }>(`/api/messages/${m.id}`));
                      if (out) {
                        setMessages((prev) => prev?.filter((x) => x.id !== m.id) ?? prev);
                        toast(out.memories_deleted ? `消息已删除，同时删除了 ${out.memories_deleted} 条相关记忆` : "消息已删除", "ok");
                      }
                    }}
                  />
                );
              })}
            </>
          )}
        </div>
        )}

        {manageOnly ? null : topic.can_post ? (
          <Composer topicId={topic.id} participants={topic.participants ?? []} onSent={onSent} />
        ) : (
          <div className="readonly-note">
            {topic.status === "archived"
              ? "话题已归档，只能查看。负责人可以在设置中恢复。"
              : "你不是这个话题的参与者，可以阅读但不能发言。请话题负责人邀请你加入。"}
          </div>
        )}
      </div>
      {panel ? (
        <TopicSidePanel
          topic={topic}
          canAdmin={canAdmin}
          version={version}
          onTopicChange={(t) => {
            topicRes.setData(t);
            onTopicUpdated();
          }}
          onCleared={() => {
            void loadMessages();
            void files.reload();
            bumpTasks();
          }}
        />
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { type LiveHandler, useLiveEvents } from "../../api/events";
import type { Approval, Artifact, Message, PostMessageResult, Topic } from "../../api/types";
import { connectionLabel, conversationKind, placeLabel } from "../../lib/conversations";
import { PLATFORM_LABEL, parseTime } from "../../lib/format";
import { useDebounced, useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import { ResizeGrips, useDraggable, useFloatingWindow } from "../../ui/floating";
import { ComputerBadge, Empty, ErrorNote, Loading, RoleBadge, Tag } from "../../ui/kit";
import { ResizeHandle } from "../../ui/resize";
import { Composer } from "./Composer";
import { type Author, MessageItem } from "./MessageItem";
import { DispatcherWarning, ResponseModeSwitch } from "./ResponseMode";
import { RoleActivity } from "./RoleActivity";
import { TopicSidePanel } from "./TopicSidePanel";

const PAGE = 100;
const PANEL_KEY = "witden.topicPanel";

export function TopicView({ topicId, onTopicUpdated }: { topicId: string; onTopicUpdated: () => void }) {
  const { me } = useAuth();
  const dir = useDirectory();
  const { toast, confirm } = useFeedback();
  const { run } = useAction();
  const topicRes = useResource(() => api.get<Topic>(`/api/topics/${topicId}`), [topicId]);
  const files = useResource(() => api.get<Artifact[]>(`/api/topics/${topicId}/files`), [topicId]);
  // One source for inline cards and the side panel, including decisions kept in message history.
  const approvals = useResource(
    () => api.get<Approval[]>("/api/approvals", { topic_id: topicId, status: "all" }),
    [topicId],
  );
  const approvalMap = useMemo(() => new Map((approvals.data ?? []).map((a) => [a.id, a])), [approvals.data]);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [msgError, setMsgError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [version, setVersion] = useState(0);
  const [panel, setPanel] = useState(() => localStorage.getItem(PANEL_KEY) !== "0");
  // The side panel's virtual computer laid over the whole topic; the conversation then floats.
  const [computerMax, setComputerMax] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [unseen, setUnseen] = useState(0);
  // The button that brings the conversation back; draggable so it never hides what you are looking at.
  const fab = useDraggable("witden.chatButton", { w: 116, h: 52 }, () => ({
    x: window.innerWidth - 116 - 28,
    y: window.innerHeight - 52 - 28,
  }));
  const chat = useFloatingWindow("witden.chatWindow", () => {
    const h = Math.min(620, window.innerHeight - 140);
    return { w: 420, h, x: window.innerWidth - 444, y: window.innerHeight - h - 96 };
  });
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
    void loadMessages();
  }, [loadMessages]);

  const loadEarlier = async () => {
    if (!messages?.length) return;
    setLoadingMore(true);
    try {
      const rows = await api.get<Message[]>(`/api/topics/${topicId}/messages`, {
        limit: PAGE,
        before: messages[0].created_at,
      });
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
    // also when the floating conversation opens (it was hidden, so it had no scroll position)
  }, [messages, approvals.data, chatOpen, computerMax]);

  const bumpTasks = useDebounced(() => setVersion((v) => v + 1), 400);
  const reloadTopic = useDebounced(() => void topicRes.reload(), 300);
  const reloadApprovals = useDebounced(() => void approvals.reload(), 200);
  const onDecided = (next: Approval) => {
    approvals.setData((prev) => prev?.map((a) => (a.id === next.id ? next : a)));
    bumpTasks();
  };

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

  // Long messages arrive cut short (event size limit): fetch the latest ones in full.
  const refreshRecent = useDebounced(() => {
    void api
      .get<Message[]>(`/api/topics/${topicId}/messages`, { limit: 20 })
      .then((rows) => rows.forEach(appendMessage))
      .catch(() => {});
  }, 200);

  const activityFeed = useRef<LiveHandler | null>(null);
  const keepAtBottom = useCallback(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, []);

  const live = useLiveEvents({ topic_id: topicId }, (type, data) => {
    activityFeed.current?.(type, data);
    if (type === "task.live") return;
    if (type === "approval.changed") {
      reloadApprovals();
      bumpTasks();
    } else if (type === "message.created") {
      const m = data as unknown as Message;
      if (m.topic_id !== topicId) return;
      appendMessage(m);
      if (m.approval_id) reloadApprovals();
      if (computerMax && !chatOpen && m.author_id !== me?.id) setUnseen((n) => n + 1);
      if (data.truncated) refreshRecent();
      // Participant changes and archive notices arrive as system messages.
      if (m.author_type === "system") reloadTopic();
      if (m.task_id) bumpTasks();
    } else if (type.startsWith("task.") || type === "trigger.changed") {
      bumpTasks();
    }
  });

  // Fetch current decisions after a reconnect, including changes made in another console while offline.
  useEffect(() => {
    if (live) {
      void approvals.reload();
      refreshRecent();
      bumpTasks();
    }
  }, [live]);

  const topic = topicRes.data;
  const participantMap = useMemo(() => {
    const map = new Map<string, NonNullable<Topic["participants"]>[number]>();
    for (const p of topic?.participants ?? []) map.set(`${p.type}:${p.id}`, p);
    return map;
  }, [topic]);
  const fileMap = useMemo(() => new Map((files.data ?? []).map((f) => [f.id, f])), [files.data]);

  const roleAuthor = (id: string): Author => {
    const p = participantMap.get(`role:${id}`);
    const r = dir.roleById.get(id);
    return {
      kind: "role",
      id,
      name: p?.name ?? r?.name ?? "已移除的角色",
      handle: p?.handle ?? r?.handle,
      avatarUrl: p?.avatar_url ?? r?.avatar_url,
      color: p?.color ?? r?.color,
      computer: p?.instance ?? r?.instance ?? null,
    };
  };

  /** What this message really mentions, as the "@" tokens the composer inserts (handle / name without spaces). */
  const mentionTokens = (m: Message): string[] =>
    (m.mentions ?? []).flatMap((x) => {
      const p = participantMap.get(`${x.type}:${x.id}`);
      if (x.type === "role") return [p?.handle ?? dir.roleById.get(x.id)?.handle ?? ""].filter(Boolean);
      return [(p?.name ?? dir.userName(x.id)).replace(/\s+/g, "")];
    });

  const authorOf = (m: Message): Author => {
    const id = m.author_id ?? m.id;
    if (m.author_type === "role") return roleAuthor(id);
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
      const name = (t: { owner_role_id: string }) => {
        const r = dir.roleById.get(t.owner_role_id);
        return r ? `@${r.handle}` : "角色";
      };
      // A role already at work here reads the message at its next step instead of starting over.
      const joined = msg.tasks.filter((t) => t.joined).map(name);
      const started = msg.tasks.filter((t) => !t.joined).map(name);
      const parts = [
        started.length ? `已交给 ${started.join("、")}` : "",
        joined.length ? `${joined.join("、")} 正在工作，会在下一步读到这条消息` : "",
      ].filter(Boolean);
      toast(parts.join("；"), "ok");
      bumpTasks();
    }
    onTopicUpdated();
  };

  const toggleComputerMax = () => {
    setComputerMax((v) => !v);
    setChatOpen(false);
    setUnseen(0);
  };
  const openChat = () => {
    setChatOpen(true);
    setUnseen(0);
    stickToBottom.current = true;
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

  const ch = topic.channel ?? null;
  const dm = topic.kind === "dm";
  // A DM is named after its role (the stored title is "person · role").
  const dmRole = dm ? topic.participants?.find((p) => p.type === "role") : undefined;
  const heading = dm ? (dmRole?.name ?? topic.title) : topic.title;
  // A DM with a disabled role keeps its history, read-only (the server refuses new messages).
  const roleOff = dm && dmRole?.status === "disabled";

  return (
    <div className={`topic-view${panel || computerMax ? " with-panel" : ""}${computerMax ? " computer-max" : ""}`}>
      {panel && !computerMax ? <ResizeHandle name="topic-panel" side="end" min={260} max={720} /> : null}
      <div
        className={`conversation${computerMax ? (chatOpen ? " chat-float" : " chat-hidden") : ""}`}
        style={computerMax && chatOpen ? chat.style : undefined}
        {...(computerMax ? { role: "dialog", "aria-label": "对话" } : {})}
      >
        {computerMax ? (
          <div className="chat-float-bar" {...chat.handle("move")}>
            <span className="chat-float-title">{dm ? `与 ${heading} 的私信` : topic.title}</span>
            <button type="button" className="btn btn-xs btn-ghost" onClick={() => setChatOpen(false)}>
              收起
            </button>
            <button type="button" className="btn btn-xs btn-ghost" onClick={toggleComputerMax}>
              还原布局
            </button>
          </div>
        ) : null}
        {computerMax && chatOpen ? <ResizeGrips handle={chat.handle} /> : null}
        <header className="topic-head">
          <div className="topic-head-main">
            <h2>{heading}</h2>
            <div className="topic-tags">
              {dm && !ch ? (
                <Tag title={`你与 ${heading} 的私信；不能邀请其他成员或角色`}>私信</Tag>
              ) : (
                <Tag>{conversationKind(topic)}</Tag>
              )}
              {ch ? (
                <Tag tone="accent" title={`thread ${ch.thread_key}`}>
                  {topic.source === "internal" ? "已同步到 " : ""}
                  {connectionLabel(ch)}
                  {placeLabel(topic) ? ` · ${placeLabel(topic)}` : ""}
                </Tag>
              ) : null}
              {ch?.url ? (
                <a className="small" href={ch.url} target="_blank" rel="noreferrer">
                  在 {PLATFORM_LABEL[ch.platform] ?? ch.platform} 中打开 ↗
                </a>
              ) : null}
              <ResponseModeSwitch
                topic={topic}
                onChange={(t) => {
                  topicRes.setData(t);
                  onTopicUpdated();
                }}
              />
              <DispatcherWarning topic={topic} />
              {topic.status === "archived" ? <Tag tone="off">已归档</Tag> : null}
              {roleOff ? <Tag tone="off">角色已停用</Tag> : null}
              <span
                className={`live-dot${live ? " live-on" : ""}`}
                title={live ? "实时更新已连接" : "实时更新未连接，正在重试"}
              >
                {live ? "实时" : "离线"}
              </span>
            </div>
            {topic.goal ? <p className="topic-goal">{topic.goal}</p> : null}
            <TopicCast participants={topic.participants ?? []} showRoles={!dm} />
          </div>
          <button type="button" className="btn btn-sm" onClick={togglePanel} aria-pressed={panel}>
            {panel ? "收起侧栏" : dm ? "任务与详情" : "任务与参与者"}
          </button>
        </header>

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
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={loadingMore}
                    onClick={() => void loadEarlier()}
                  >
                    {loadingMore ? "加载中…" : "加载更早的消息"}
                  </button>
                </div>
              ) : messages.length ? (
                <div className="timeline-start small muted">{dm ? "私信开始" : "话题开始"}</div>
              ) : null}
              {!messages.length ? (
                <Empty
                  title={dm ? `开始和 ${heading} 私信` : "还没有消息"}
                  hint={
                    !topic.can_post
                      ? undefined
                      : dm
                        ? `直接发消息即可，不需要 @，${heading} 会回复；它接下的工作会出现在右侧的任务列表。`
                        : "用 @ 提及角色把工作交给它；角色接下的工作会出现在右侧的任务列表。"
                  }
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
                // a reply inside a Slack thread shows the thread's first message, as Slack does
                const root = m.reply_to_id ? messages.find((x) => x.id === m.reply_to_id) : undefined;
                return (
                  <MessageItem
                    key={m.id}
                    msg={m}
                    approval={m.approval_id ? approvalMap.get(m.approval_id) : undefined}
                    approvalError={approvals.error}
                    approvalLoading={approvals.loading}
                    onReloadApproval={approvals.reload}
                    onDecided={onDecided}
                    author={author}
                    replyTo={
                      m.reply_to_id
                        ? { author: root ? authorOf(root).name : null, excerpt: root?.content.slice(0, 80) ?? null }
                        : null
                    }
                    mentionTokens={mentionTokens(m)}
                    compact={compact}
                    files={fileMap}
                    canDelete
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
                        toast(
                          out.memories_deleted
                            ? `消息已删除，同时删除了 ${out.memories_deleted} 条相关记忆`
                            : "消息已删除",
                          "ok",
                        );
                      }
                    }}
                  />
                );
              })}
              <RoleActivity
                topicId={topic.id}
                connected={live}
                feed={activityFeed}
                authorOf={roleAuthor}
                onGrow={keepAtBottom}
              />
            </>
          )}
        </div>

        {topic.can_post ? (
          <Composer
            topicId={topic.id}
            participants={topic.participants ?? []}
            onSent={onSent}
            placeholder={
              dm
                ? `给 ${heading} 发消息（支持 Markdown、\`\`\`mermaid 流程图）；不需要 @。Enter 发送，Shift+Enter 换行`
                : undefined
            }
          />
        ) : (
          <div className="readonly-note">
            {roleOff
              ? `${heading} 已停用，这段私信只能查看。角色重新启用后可以继续私信。`
              : dm && topic.status === "archived"
                ? `这是之前与 ${heading} 的一段私信记录，只能查看；继续私信请从左侧角色列表打开。`
                : topic.status === "archived"
                  ? "话题已归档，只能查看。可以在右侧“设置”中恢复。"
                  : dm
                    ? `这是其他人与 ${heading} 的私信，只能查看。`
                    : "你不是这个话题的参与者，可以查看；在右侧“参与者”中把自己加入后即可发言。"}
          </div>
        )}
      </div>
      {computerMax && !chatOpen ? (
        <button
          type="button"
          className={`chat-fab${unseen ? " chat-fab-unread" : ""}${fab.dragging ? " chat-fab-dragging" : ""}`}
          style={fab.style}
          title="点击打开对话，拖动可移动位置"
          aria-label={unseen ? `打开对话（${unseen} 条新消息）` : "打开对话"}
          {...fab.bind(openChat)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
            <path
              d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5Z"
              fill="currentColor"
              fillOpacity="0.2"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinejoin="round"
            />
          </svg>
          <span>对话</span>
          {unseen ? <span className="chat-fab-badge">{unseen > 99 ? "99+" : unseen}</span> : null}
        </button>
      ) : null}
      {panel || computerMax ? (
        <TopicSidePanel
          topic={topic}
          version={version}
          approvals={approvals}
          onDecided={onDecided}
          computerMax={computerMax}
          onToggleComputerMax={toggleComputerMax}
          onTopicChange={(t) => {
            topicRes.setData(t);
            onTopicUpdated();
          }}
          onCleared={() => {
            void loadMessages();
            void files.reload();
            void approvals.reload();
            bumpTasks();
          }}
        />
      ) : null}
    </div>
  );
}

/** The roles taking part in a topic and the computers they work on, as badges. */
/** The roles in a topic and the computers they work in (a DM shows only the computer: the role is the title). */
function TopicCast({
  participants,
  showRoles = true,
}: {
  participants: NonNullable<Topic["participants"]>;
  showRoles?: boolean;
}) {
  const roles = participants.filter((p) => p.type === "role");
  if (!roles.length) return null;
  const computers = new Map<string, { id: string; name: string; color: string | null }>();
  for (const r of roles) if (r.instance) computers.set(r.instance.id, r.instance);
  return (
    <div className="topic-cast">
      {showRoles ? (
        <span className="badge-row">
          {roles.map((r) => (
            <span key={r.id} className={r.status === "disabled" ? "badge-off" : undefined}>
              <RoleBadge
                role={{ id: r.id, name: r.name, handle: r.handle, color: r.color, avatar_url: r.avatar_url }}
                title={r.status === "disabled" ? `${r.name} @${r.handle}（已停用）` : undefined}
              />
            </span>
          ))}
        </span>
      ) : null}
      {computers.size ? (
        <span className="badge-row" title={showRoles ? "这些角色在各自的虚拟电脑里工作" : "角色在这台虚拟电脑里工作"}>
          <span className="small muted">在</span>
          {[...computers.values()].map((c) => (
            <ComputerBadge key={c.id} computer={c} />
          ))}
        </span>
      ) : null}
    </div>
  );
}

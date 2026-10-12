import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api/client";
import type { Topic } from "../../api/types";
import { fmtRelative, PLATFORM_LABEL } from "../../lib/format";
import { useDebounced, useResource } from "../../lib/hooks";
import { useAuth } from "../../lib/session";
import { Empty, ErrorNote, Loading } from "../../ui/kit";
import { ResizeHandle } from "../../ui/resize";
import { TopicView } from "./TopicView";
import { NewTopicDialog, OpenDmDialog } from "./topicDialogs";

export default function TopicsPage() {
  const { topicId } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [dialog, setDialog] = useState<null | "new" | "dm">(null);
  const applyQuery = useDebounced(() => setQuery(q.trim()), 250);
  const list = useResource(
    () => api.get<Topic[]>("/api/topics", { q: query, include_archived: archived }),
    [query, archived],
  );

  useEffect(applyQuery, [q, applyQuery]);

  // A topic opened from elsewhere (new DM, link) may be missing from the list: refresh once.
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!topicId || !list.data || refreshedFor.current === topicId) return;
    if (!list.data.some((t) => t.id === topicId)) {
      refreshedFor.current = topicId;
      void list.reload();
    }
  }, [topicId, list]);

  const topics = list.data ?? [];
  const groups = topics.filter((t) => t.kind === "group");
  const dms = topics.filter((t) => t.kind === "dm");

  const item = (t: Topic) => (
    <li key={t.id}>
      <Link to={`/topics/${t.id}`} className={`topic-item${t.id === topicId ? " topic-on" : ""}`}>
        <span className="topic-item-title">
          {t.title}
          {t.status === "archived" ? <span className="small muted">（已归档）</span> : null}
        </span>
        <span className="topic-item-meta">
          {t.kind === "group" ? (t.visibility === "internal" ? "公开" : "私密") : "私信"}
          {t.source !== "internal" ? ` · ${PLATFORM_LABEL[t.source] ?? t.source}` : ""}
          {t.can_view === false ? " · 仅可管理" : !t.can_post && t.status === "active" ? " · 只读" : ""}
          <span className="topic-item-time">{t.last_message_at ? fmtRelative(t.last_message_at) : "无消息"}</span>
        </span>
      </Link>
    </li>
  );

  return (
    <div className="workspace">
      <ResizeHandle name="topic-list" side="start" min={180} max={480} />
      <aside className="topic-list">
        <div className="topic-list-head">
          <input
            type="search"
            placeholder="搜索标题或目标"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索话题"
          />
          <div className="btn-row">
            {can("topic.create") ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog("new")}>
                新建话题
              </button>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={() => setDialog("dm")}>
              私信角色
            </button>
          </div>
          <label className="check small">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            包含已归档
          </label>
        </div>
        <div className="topic-list-body">
          {list.error ? <ErrorNote error={list.error} onRetry={list.reload} /> : null}
          {list.data === undefined && !list.error ? <Loading /> : null}
          {list.data && !topics.length ? (
            <Empty
              title={query ? "没有匹配的话题" : "还没有话题"}
              hint={query ? undefined : "新建一个话题，邀请同事和角色一起推进一件事。"}
            />
          ) : null}
          {groups.length ? (
            <>
              <div className="list-label">话题</div>
              <ul>{groups.map(item)}</ul>
            </>
          ) : null}
          {dms.length ? (
            <>
              <div className="list-label">私信</div>
              <ul>{dms.map(item)}</ul>
            </>
          ) : null}
        </div>
      </aside>

      {topicId ? (
        <TopicView key={topicId} topicId={topicId} onTopicUpdated={() => void list.reload()} />
      ) : (
        <div className="topic-view topic-none">
          <Empty
            title="选择一个话题"
            hint="话题是围绕一件具体事情的协作空间：成员和 AI 角色在这里讨论、分派任务、交付结果。"
            action={
              can("topic.create") ? (
                <button type="button" className="btn btn-primary" onClick={() => setDialog("new")}>
                  新建话题
                </button>
              ) : undefined
            }
          />
        </div>
      )}

      {dialog === "new" ? (
        <NewTopicDialog
          onClose={() => setDialog(null)}
          onCreated={(t) => {
            setDialog(null);
            void list.reload();
            nav(`/topics/${t.id}`);
          }}
        />
      ) : null}
      {dialog === "dm" ? <OpenDmDialog onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

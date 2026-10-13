import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import type { Topic } from "../../api/types";
import { fmtRelative, PLATFORM_LABEL } from "../../lib/format";
import { useDebounced, useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { useTopics } from "../../lib/topics";
import { Empty, Loaded, PageHeader, RoleBadge, Tag } from "../../ui/kit";
import { TopicView } from "./TopicView";

/** One topic, full width (topics and roles are listed in the main sidebar), or the list of all topics. */
export default function TopicsPage() {
  const { topicId } = useParams();
  const topics = useTopics();
  const { setActive } = topics;
  useEffect(() => {
    setActive(topicId ?? null);
    return () => setActive(null);
  }, [topicId, setActive]);
  if (topicId) return <TopicView key={topicId} topicId={topicId} onTopicUpdated={() => void topics.reload()} />;
  return <AllTopics />;
}

/** Every topic you can see, with search and archived ones: what the sidebar shows, and more. */
function AllTopics() {
  const { can } = useAuth();
  const dir = useDirectory();
  const t = useTopics();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const applyQuery = useDebounced(() => setQuery(q.trim()), 250);
  useEffect(applyQuery, [q, applyQuery]);
  const res = useResource(
    () => api.get<Topic[]>("/api/topics", { q: query, include_archived: archived }),
    [query, archived],
  );

  return (
    <div className="page">
      <PageHeader
        title="话题"
        sub="话题是围绕一件具体事情的协作空间：多位成员和角色在这里讨论、分派任务、交付结果，事情结束后可以归档。私信是你和某个角色之间一直保留的一对一对话，在左侧角色列表中点击角色即可打开。"
        actions={
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={t.pickDm}>
              与角色私信
            </button>
            {can("topic.create") ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={t.newTopic}>
                新建话题
              </button>
            ) : null}
          </div>
        }
      />
      <div className="toolbar">
        <input
          type="search"
          placeholder="搜索标题或目标"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="搜索话题"
        />
        <label className="check small">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          包含已归档
        </label>
      </div>
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>最近消息</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x) => {
                    const dmRole = x.dm_role_id ? dir.roleById.get(x.dm_role_id) : undefined;
                    return (
                      <tr key={x.id}>
                        <td>
                          <Link to={`/topics/${x.id}`} className={t.unread(x) ? "strong" : undefined}>
                            {dmRole ? <RoleBadge role={dmRole} /> : x.title}
                          </Link>
                          {x.goal ? <div className="small muted clamp-1">{x.goal}</div> : null}
                        </td>
                        <td className="nowrap">
                          {x.kind === "dm" ? "私信" : x.visibility === "internal" ? "话题 · 团队内公开" : "话题 · 私密"}
                          {x.source !== "internal" ? (
                            <Tag tone="accent">{PLATFORM_LABEL[x.source] ?? x.source}</Tag>
                          ) : null}
                          {x.status === "archived" ? <Tag tone="off">已归档</Tag> : null}
                          {dmRole && dmRole.status !== "active" ? <Tag tone="off">角色已停用</Tag> : null}
                          {x.can_view === false ? <Tag tone="wait">仅可管理</Tag> : null}
                        </td>
                        <td className="nowrap muted">
                          {x.last_message_at ? fmtRelative(x.last_message_at) : "无消息"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title={query ? "没有匹配的话题" : "还没有话题"}
              hint={query ? undefined : "新建一个话题，邀请同事和角色一起推进一件事；或者直接在左侧选一个角色私信。"}
            />
          )
        }
      </Loaded>
    </div>
  );
}

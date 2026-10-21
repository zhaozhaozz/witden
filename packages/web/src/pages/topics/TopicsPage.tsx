import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import type { Topic } from "../../api/types";
import { connectionLabel, conversationKind, placeLabel, sourceOf } from "../../lib/conversations";
import { fmtRelative } from "../../lib/format";
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

/**
 * Every conversation of the roles, wherever it lives: console topics and DMs, Slack / Feishu threads and DMs,
 * GitHub issues and pull requests. Filter by source, search, include archived ones.
 */
function AllTopics() {
  const { can } = useAuth();
  const dir = useDirectory();
  const t = useTopics();
  const [params, setParams] = useSearchParams();
  const source = params.get("source") ?? "";
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const applyQuery = useDebounced(() => setQuery(q.trim()), 250);
  useEffect(applyQuery, [q, applyQuery]);
  const res = useResource(
    () => api.get<Topic[]>("/api/topics", { q: query, include_archived: archived }),
    [query, archived],
  );
  // The sources present: the console, then each connection with conversations.
  const sources = new Map<string, string>([["console", "控制台"]]);
  for (const x of res.data ?? [])
    if (x.channel && sourceOf(x) !== "console") sources.set(sourceOf(x), connectionLabel(x.channel));

  return (
    <div className="page">
      <PageHeader
        title="全部会话"
        sub="AI 员工参与的全部会话：控制台里的话题和私信，以及 Slack、飞书中的 thread 和私信、GitHub 上的 issue 和 pull request。"
        actions={
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={t.pickDm}>
              与 AI 员工私信
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
        <select
          value={source}
          onChange={(e) => setParams(e.target.value ? { source: e.target.value } : {}, { replace: true })}
          aria-label="来源"
        >
          <option value="">全部来源</option>
          {[...sources.entries()].map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="搜索标题或目标"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="搜索会话"
        />
        <label className="check small">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          包含已归档
        </label>
      </div>
      <Loaded res={res}>
        {(all) => {
          const rows = source ? all.filter((x) => sourceOf(x) === source) : all;
          return rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>来源</th>
                    <th>类型</th>
                    <th>最近消息</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x) => {
                    const dmRole =
                      x.kind === "dm" && !x.channel && x.dm_role_id ? dir.roleById.get(x.dm_role_id) : undefined;
                    return (
                      <tr key={x.id}>
                        <td>
                          <Link to={`/topics/${x.id}`} className={t.unread(x) ? "strong" : undefined}>
                            {dmRole ? <RoleBadge role={dmRole} /> : x.title}
                          </Link>
                          {x.goal ? <div className="small muted clamp-1">{x.goal}</div> : null}
                        </td>
                        <td className="nowrap">
                          {x.channel ? (
                            <>
                              {connectionLabel(x.channel)}
                              {placeLabel(x) ? <div className="small muted">{placeLabel(x)}</div> : null}
                            </>
                          ) : (
                            "控制台"
                          )}
                        </td>
                        <td className="nowrap">
                          {conversationKind(x)}
                          {x.status === "archived" ? <Tag tone="off">已归档</Tag> : null}
                          {dmRole && dmRole.status !== "active" ? <Tag tone="off">AI 员工已停用</Tag> : null}
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
              title={query || source ? "没有匹配的会话" : "还没有会话"}
              hint={
                query || source
                  ? undefined
                  : "新建一个话题，或在左侧选一位 AI 员工私信；接入 Slack、GitHub 后，那里的会话也会出现在这里。"
              }
            />
          );
        }}
      </Loaded>
    </div>
  );
}

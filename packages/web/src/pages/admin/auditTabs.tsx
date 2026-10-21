import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { AuditEntry, Instance, ModelConfig, UsageRow } from "../../api/types";
import { auditLabel, fmtDateTime, fmtNumber } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useDirectory } from "../../lib/session";
import { Empty, JsonBlock, Loaded, Tag } from "../../ui/kit";

export function AuditTab() {
  const dir = useDirectory();
  const [draft, setDraft] = useState({ action: "", task_id: "", topic_id: "", instance_id: "", role_id: "" });
  const [filters, setFilters] = useState(draft);
  const [open, setOpen] = useState<string | null>(null);
  const res = useResource(() => api.get<AuditEntry[]>("/api/audit", { ...filters, limit: 300 }), [filters]);
  const set = (k: keyof typeof draft) => (e: { target: { value: string } }) =>
    setDraft({ ...draft, [k]: e.target.value });

  const actor = (a: AuditEntry) =>
    a.actor_type === "user"
      ? dir.userName(a.actor_id)
      : a.actor_type === "role"
        ? dir.roleLabel(a.actor_id)
        : a.actor_type === "system"
          ? "系统"
          : `${a.actor_type} ${a.actor_id ?? ""}`;

  return (
    <>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters({ ...draft });
        }}
      >
        <input placeholder="操作前缀，如 task. 或 instance.exec" value={draft.action} onChange={set("action")} />
        <select value={draft.role_id} onChange={set("role_id")} aria-label="AI 员工">
          <option value="">全部 AI 员工</option>
          {dir.roles.map((r) => (
            <option key={r.id} value={r.id}>
              @{r.handle}
            </option>
          ))}
        </select>
        <input className="mono" placeholder="任务 ID" value={draft.task_id} onChange={set("task_id")} />
        <input className="mono" placeholder="话题 ID" value={draft.topic_id} onChange={set("topic_id")} />
        <input className="mono" placeholder="虚拟电脑 ID" value={draft.instance_id} onChange={set("instance_id")} />
        <button type="submit" className="btn btn-sm btn-primary">
          筛选
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            const empty = { action: "", task_id: "", topic_id: "", instance_id: "", role_id: "" };
            setDraft(empty);
            setFilters(empty);
          }}
        >
          清除
        </button>
      </form>
      <p className="small muted">审计只记录元数据，不保存消息正文、命令输出或密钥。最近 300 条。</p>
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>谁</th>
                    <th>做了什么</th>
                    <th>结果</th>
                    <th>关联</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <Fragment key={a.id}>
                      <tr>
                        <td className="nowrap">{fmtDateTime(a.created_at)}</td>
                        <td>{actor(a)}</td>
                        <td>
                          {auditLabel(a.action)}{" "}
                          {auditLabel(a.action) !== a.action ? <code className="id">{a.action}</code> : null}
                          {a.resource_type ? (
                            <div className="small muted">
                              {a.resource_type} {a.resource_id ?? ""}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          {a.outcome === "ok" ? (
                            <Tag tone="ok">成功</Tag>
                          ) : (
                            <Tag tone="bad">{a.outcome === "denied" ? "拒绝" : a.outcome}</Tag>
                          )}
                        </td>
                        <td className="small">
                          <span className="inline-list">
                            {a.task_id ? <Link to={`/tasks/${a.task_id}`}>任务</Link> : null}
                            {a.topic_id ? <Link to={`/topics/${a.topic_id}`}>话题</Link> : null}
                            {a.instance_id ? <Link to={`/computers/${a.instance_id}`}>虚拟电脑</Link> : null}
                            {a.role_id ? <span>{dir.roleLabel(a.role_id)}</span> : null}
                          </span>
                        </td>
                        <td>
                          {Object.keys(a.detail ?? {}).length ? (
                            <button
                              type="button"
                              className="link-btn small"
                              onClick={() => setOpen(open === a.id ? null : a.id)}
                            >
                              {open === a.id ? "收起" : "详情"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {open === a.id ? (
                        <tr className="row-detail">
                          <td colSpan={6}>
                            <JsonBlock value={a.detail} maxHeight={260} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="没有匹配的审计记录" />
          )
        }
      </Loaded>
    </>
  );
}

const GROUPS: [string, string][] = [
  ["role", "按 AI 员工"],
  ["model", "按模型"],
  ["instance", "按虚拟电脑"],
  ["task", "按任务"],
];

export function UsageTab() {
  const dir = useDirectory();
  const [days, setDays] = useState(7);
  const [groupBy, setGroupBy] = useState("role");
  const res = useResource(() => api.get<UsageRow[]>("/api/usage", { days, group_by: groupBy }), [days, groupBy]);
  const instances = useResource(() => api.get<Instance[]>("/api/instances").catch(() => [] as Instance[]), []);
  const models = useResource(() => api.get<ModelConfig[]>("/api/models").catch(() => [] as ModelConfig[]), []);

  const label = useMemo(
    () => (key: string | null) => {
      if (!key) return <span className="muted">（未关联）</span>;
      if (groupBy === "role") return dir.roleLabel(key);
      if (groupBy === "instance") return instances.data?.find((i) => i.id === key)?.name ?? key;
      if (groupBy === "model") return models.data?.find((m) => m.id === key)?.label ?? key;
      return <Link to={`/tasks/${key}`}>{key}</Link>;
    },
    [groupBy, dir, instances.data, models.data],
  );

  return (
    <>
      <div className="toolbar">
        <div className="segmented">
          {GROUPS.map(([k, v]) => (
            <button
              type="button"
              key={k}
              className={k === groupBy ? "seg seg-on" : "seg"}
              onClick={() => setGroupBy(k)}
            >
              {v}
            </button>
          ))}
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="时间范围">
          <option value={1}>最近 1 天</option>
          <option value={7}>最近 7 天</option>
          <option value={30}>最近 30 天</option>
          <option value={90}>最近 90 天</option>
        </select>
        <span className="small muted">模型调用的 token 用量。限额在 AI 员工和模型配置中设置。</span>
      </div>
      <Loaded res={res}>
        {(rows) => {
          if (!rows.length) return <Empty title="这段时间没有模型调用" />;
          const sorted = [...rows].sort(
            (a, b) => b.prompt_tokens + b.completion_tokens - (a.prompt_tokens + a.completion_tokens),
          );
          const total = sorted.reduce(
            (acc, r) => ({ p: acc.p + r.prompt_tokens, c: acc.c + r.completion_tokens, n: acc.n + r.calls }),
            { p: 0, c: 0, n: 0 },
          );
          return (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{GROUPS.find(([k]) => k === groupBy)?.[1].replace("按", "")}</th>
                    <th className="num">输入 tokens</th>
                    <th className="num">输出 tokens</th>
                    <th className="num">合计</th>
                    <th className="num">调用次数</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.key ?? "none"}>
                      <td>{label(r.key)}</td>
                      <td className="num">{fmtNumber(r.prompt_tokens)}</td>
                      <td className="num">{fmtNumber(r.completion_tokens)}</td>
                      <td className="num strong">{fmtNumber(r.prompt_tokens + r.completion_tokens)}</td>
                      <td className="num">{fmtNumber(r.calls)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>合计</th>
                    <td className="num">{fmtNumber(total.p)}</td>
                    <td className="num">{fmtNumber(total.c)}</td>
                    <td className="num strong">{fmtNumber(total.p + total.c)}</td>
                    <td className="num">{fmtNumber(total.n)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          );
        }}
      </Loaded>
    </>
  );
}

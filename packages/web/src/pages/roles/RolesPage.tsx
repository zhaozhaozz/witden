import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import type { Role } from "../../api/types";
import { fmtNumber, genericStatus, instanceStatus, RUNTIME_LABEL, TOOL_GROUP_LABEL } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { Avatar, Empty, Handle, Loaded, PageHeader, StatusChip, Tag } from "../../ui/kit";
import { translateWarning } from "./roleParts";

export default function RolesPage() {
  const nav = useNavigate();
  const res = useResource(() => api.get<Role[]>("/api/roles"), []);
  return (
    <div className="page">
      <PageHeader
        title="角色"
        sub="角色是团队里的 AI 员工：有独立的身份、职责、模型和所属电脑。同一个角色可以为多位获授权的成员工作。"
        actions={
          <Link to="/roles/new" className="btn btn-sm btn-primary">
            新建角色
          </Link>
        }
      />
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>角色</th>
                    <th>状态</th>
                    <th>电脑</th>
                    <th>模型 / 运行方式</th>
                    <th>参与方式</th>
                    <th>工具</th>
                    <th>今日用量</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="row-link" onClick={() => nav(`/roles/${r.id}`)}>
                      <td>
                        <div className="role-cell">
                          <Avatar id={r.id} name={r.name} kind="role" size={30} src={r.avatar_url} />
                          <div>
                            <div className="strong">
                              {r.name} <Handle handle={r.handle} />
                            </div>
                            {r.description ? <div className="small muted clamp-1">{r.description}</div> : null}
                          </div>
                        </div>
                        {r.warnings?.length ? (
                          <ul className="warn-list">
                            {r.warnings.map((w) => (
                              <li key={w}>{translateWarning(w)}</li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                      <td>
                        <StatusChip meta={genericStatus(r.status)} compact />
                      </td>
                      <td>
                        {r.instance ? (
                          <>
                            {r.instance.name}
                            <div>
                              <StatusChip meta={instanceStatus(r.instance.status)} compact />
                            </div>
                          </>
                        ) : (
                          <span className="text-bad">未分配</span>
                        )}
                      </td>
                      <td>
                        {r.runtime === "external" ? (
                          <Tag tone="accent" title="在电脑里运行的第三方智能体，自带模型">
                            {RUNTIME_LABEL.external}
                          </Tag>
                        ) : r.model ? (
                          <>
                            {r.model.label ?? r.model.name}
                            <div>
                              <StatusChip meta={genericStatus(r.model.status)} compact />
                            </div>
                          </>
                        ) : (
                          <span className="text-bad">未配置</span>
                        )}
                      </td>
                      <td>{r.response_mode === "active" ? "持续参与" : "被 @ 时响应"}</td>
                      <td>
                        <span className="inline-list">
                          {r.runtime === "external" ? (
                            <span className="muted small">由外部智能体自行决定</span>
                          ) : r.allowed_tools.length ? (
                            r.allowed_tools.map((g) => <Tag key={g}>{TOOL_GROUP_LABEL[g] ?? g}</Tag>)
                          ) : (
                            <span className="muted">仅对话</span>
                          )}
                        </span>
                      </td>
                      <td className="nowrap">
                        {fmtNumber(r.tokens_today ?? 0)}
                        {r.daily_token_limit ? (
                          <span className="muted"> / {fmtNumber(r.daily_token_limit)}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="还没有角色"
              hint="先准备好模型配置和电脑，再创建角色，例如开发、测试、分析。"
              action={
                <Link to="/roles/new" className="btn btn-primary">
                  新建角色
                </Link>
              }
            />
          )
        }
      </Loaded>
    </div>
  );
}

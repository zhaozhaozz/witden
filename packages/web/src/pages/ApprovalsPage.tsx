import { useEffect, useState } from "react";
import { api } from "../api/client";
import { APPROVALS_EVENT } from "../api/events";
import type { Approval } from "../api/types";
import { useDebounced, useResource } from "../lib/hooks";
import { Empty, Loaded, PageHeader, Tabs } from "../ui/kit";
import { ApprovalCard } from "./approvalParts";

export default function ApprovalsPage() {
  const [status, setStatus] = useState("pending");
  const [mineOnly, setMineOnly] = useState(true);
  const res = useResource(() => api.get<Approval[]>("/api/approvals", { status }), [status]);
  const refresh = useDebounced(() => void res.reload(), 200);
  useEffect(() => {
    window.addEventListener(APPROVALS_EVENT, refresh);
    return () => window.removeEventListener(APPROVALS_EVENT, refresh);
  }, [refresh]);

  return (
    <div className="page">
      <PageHeader
        title="审批"
        sub="AI 员工执行需要人工确认的操作时，会在这里等待决定。AI 员工不能批准自己的请求。"
        actions={
          <button type="button" className="btn btn-sm" onClick={() => void res.reload()}>
            刷新
          </button>
        }
      />
      <div className="toolbar">
        <Tabs
          value={status}
          onChange={setStatus}
          tabs={[
            { key: "pending", label: "待处理" },
            { key: "approved", label: "已批准" },
            { key: "rejected", label: "已拒绝" },
          ]}
        />
        {status === "pending" ? (
          <label className="check">
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            只看需要我处理的
          </label>
        ) : null}
      </div>
      <Loaded res={res}>
        {(rows) => {
          const list = status === "pending" && mineOnly ? rows.filter((a) => a.can_decide) : rows;
          if (!list.length)
            return (
              <Empty
                title={status === "pending" ? "没有等待处理的审批" : "暂无记录"}
                hint={
                  status === "pending" && mineOnly && rows.length
                    ? `另有 ${rows.length} 条审批由其他人处理，取消勾选即可查看。`
                    : undefined
                }
              />
            );
          return (
            <div className="approval-list">
              {list.map((a) => (
                <ApprovalCard
                  key={a.id}
                  approval={a}
                  onDecided={(next) =>
                    res.setData((prev) =>
                      status === "pending"
                        ? prev?.filter((x) => x.id !== next.id)
                        : prev?.map((x) => (x.id === next.id ? next : x)),
                    )
                  }
                />
              ))}
            </div>
          );
        }}
      </Loaded>
    </div>
  );
}

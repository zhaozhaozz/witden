import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Approval } from "../api/types";
import { APPROVALS_EVENT } from "../Layout";
import { fmtRelative, fmtTime, genericStatus, isRestricted } from "../lib/format";
import { useDirectory } from "../lib/session";
import { useAction } from "../ui/feedback";
import { JsonBlock, RoleBadge, StatusChip } from "../ui/kit";

function actionLabel(a: Approval): string {
  if (a.action === "disclose") return "发送含受限资料的消息";
  return `使用工具 ${a.action}`;
}

/** One approval request: what is held, why, who may decide, and the decision controls. */
export function ApprovalCard({
  approval,
  onDecided,
  showContext = true,
}: {
  approval: Approval;
  onDecided: (a: Approval) => void;
  showContext?: boolean;
}) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const [note, setNote] = useState("");
  const a = approval;
  const detail = a.detail ?? {};
  // Readable tool approvals carry {tool_call}; for viewers who may not see the material: {tool, arguments: "[restricted]"}.
  const toolCall =
    (detail.tool_call as { name?: string; arguments?: unknown } | undefined) ??
    (detail.tool ? { name: String(detail.tool), arguments: detail.arguments } : undefined);
  const argsHidden = isRestricted(toolCall?.arguments);
  // Deciders who cannot see the held material may reject but not approve.
  const rejectOnly = !!a.can_decide && a.can_approve === false;
  const sources = detail.sources as string | string[] | undefined;
  const content = detail.content as string | undefined;
  const labels = detail.labels as string[] | undefined;

  const decide = async (approve: boolean) => {
    const out = await run(
      () => api.post<Approval>(`/api/approvals/${a.id}/decide`, { approve, note }),
      approve ? "已批准" : "已拒绝",
    );
    if (out) {
      window.dispatchEvent(new Event(APPROVALS_EVENT));
      onDecided(out);
    }
  };

  return (
    <article className={`approval approval-${a.status}`}>
      <header className="approval-head">
        <div className="approval-title">
          {a.role ? (
            <RoleBadge role={{ ...a.role, name: a.role.name ?? a.role.handle }} />
          ) : (
            <span className="muted">未知角色</span>
          )}
          <strong>{actionLabel(a)}</strong>
        </div>
        <StatusChip meta={genericStatus(a.status)} compact />
      </header>

      {a.action === "disclose" ? (
        <div className="approval-body">
          <p className="small">
            角色想把一条消息发到这个话题，但消息用到了部分参与者无权查看的资料，需要资料所属方确认后才能发出。
          </p>
          {sources ? (
            <div className="approval-sources">
              <span className="muted small">资料来源</span>
              <span>{Array.isArray(sources) ? sources.join("，") : sources}</span>
            </div>
          ) : null}
          {content !== undefined ? (
            <div className="held">
              <div className="muted small">被暂扣的消息</div>
              <div className="held-text">{content}</div>
            </div>
          ) : (
            <p className="muted small">消息内容只对有权审批的人可见。</p>
          )}
          {labels?.length ? (
            <div className="inline-list">
              {labels.map((l) => (
                <code key={l} className="id">
                  {l}
                </code>
              ))}
            </div>
          ) : null}
        </div>
      ) : toolCall ? (
        <div className="approval-body">
          <p className="small">该角色的这类操作被设置为每次都需要人工批准。</p>
          <div className="muted small">调用 {toolCall.name}</div>
          {argsHidden ? (
            <p className="small muted">参数涉及你无权查看的资料，已隐藏。</p>
          ) : (
            <JsonBlock value={toolCall.arguments ?? {}} maxHeight={220} />
          )}
        </div>
      ) : Object.keys(detail).length ? (
        <div className="approval-body">
          <JsonBlock value={detail} maxHeight={220} />
        </div>
      ) : null}

      {rejectOnly ? (
        <p className="small text-wait">
          你可以拒绝这个请求，但批准需要能查看它涉及的全部资料，你没有这些资料的查看权限。
        </p>
      ) : null}
      <footer className="approval-foot">
        <div className="approval-meta small muted">
          <span title={fmtTime(a.created_at)}>{fmtRelative(a.created_at)}发起</span>
          {showContext ? (
            <>
              <Link to={`/tasks/${a.task_id}`}>查看任务</Link>
              <Link to={`/topics/${a.topic_id}`}>打开话题</Link>
            </>
          ) : (
            <Link to={`/tasks/${a.task_id}`}>查看任务</Link>
          )}
          {a.approver_user_ids?.length ? (
            <span>审批人：{a.approver_user_ids.map((id) => dir.userName(id)).join("、")}</span>
          ) : null}
          {a.decided_by ? (
            <span>
              {dir.userName(a.decided_by)} 于 {fmtTime(a.decided_at)} 处理
            </span>
          ) : null}
        </div>
        {a.status === "pending" && a.can_decide ? (
          <div className="approval-decide">
            <input placeholder="备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn btn-sm btn-danger-ghost" disabled={busy} onClick={() => decide(false)}>
              拒绝
            </button>
            {rejectOnly ? null : (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => decide(true)}>
                批准
              </button>
            )}
          </div>
        ) : a.status === "pending" ? (
          <span className="small muted">等待审批人处理</span>
        ) : null}
      </footer>
    </article>
  );
}

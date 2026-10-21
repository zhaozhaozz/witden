import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { APPROVALS_EVENT } from "../api/events";
import type { Approval } from "../api/types";
import { fmtRelative, fmtTime, genericStatus, isRestricted, TOOL_LABEL } from "../lib/format";
import { useDirectory } from "../lib/session";
import { useAction } from "../ui/feedback";
import { JsonBlock, RoleBadge, StatusChip } from "../ui/kit";

function actionLabel(a: Approval): string {
  if (a.action === "disclose") return "发送暂扣的消息";
  return `使用工具：${TOOL_LABEL[a.action] ?? a.action}`;
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
  // Tool approvals carry {tool_call}; for viewers who do not decide approvals: {tool, arguments: "[restricted]"}.
  const toolCall =
    (detail.tool_call as { name?: string; arguments?: unknown } | undefined) ??
    (detail.tool ? { name: String(detail.tool), arguments: detail.arguments } : undefined);
  const argsHidden = isRestricted(toolCall?.arguments);
  const content = detail.content as string | undefined;

  const decide = async (approve: boolean, scope: "once" | "task_run" = "once") => {
    const out = await run(
      () =>
        api.post<Approval>(`/api/approvals/${a.id}/decide`, {
          approve,
          note,
          ...(scope === "task_run" ? { scope } : {}),
        }),
      approve ? (scope === "task_run" ? "已允许本次运行使用此工具" : "已批准") : "已拒绝",
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
            <span className="muted">未知 AI 员工</span>
          )}
          <strong>{actionLabel(a)}</strong>
        </div>
        <StatusChip meta={genericStatus(a.status)} compact />
      </header>

      {a.action === "disclose" ? (
        <div className="approval-body">
          <p className="small">这条消息在升级前被暂扣，等待批准；批准后发到这个话题，拒绝则不发出。</p>
          {content !== undefined ? (
            <div className="held">
              <div className="muted small">被暂扣的消息</div>
              <div className="held-text">{content}</div>
            </div>
          ) : (
            <p className="muted small">消息内容只对有权审批的人可见。</p>
          )}
        </div>
      ) : toolCall ? (
        <div className="approval-body">
          <p className="small">该 AI 员工的这类操作被设置为需要人工批准。</p>
          <div className="muted small">调用 {toolCall.name}</div>
          {toolCall.name === "remember" && !argsHidden ? (
            <p className="small">{memoryScopeHint((toolCall.arguments as { scope?: string } | undefined)?.scope)}</p>
          ) : null}
          {argsHidden ? (
            <p className="small muted">参数只对有审批权限的人显示。</p>
          ) : (
            <ToolArguments value={toolCall.arguments ?? {}} />
          )}
        </div>
      ) : Object.keys(detail).length ? (
        <div className="approval-body">
          <JsonBlock value={detail} maxHeight={220} />
        </div>
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
          {a.decision_scope === "task_run" ? <span>授权范围：本次运行内同一工具</span> : null}
        </div>
        {a.status === "pending" && a.can_decide ? (
          <div
            className={`approval-decide${a.can_allow_for_task_run && a.action !== "disclose" ? " approval-decide-run" : ""}`}
          >
            <input
              aria-label="审批备注（可选）"
              placeholder="备注（可选）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button type="button" className="btn btn-sm btn-danger-ghost" disabled={busy} onClick={() => decide(false)}>
              拒绝
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => decide(true)}>
              批准
            </button>
            {a.can_allow_for_task_run && a.action !== "disclose" ? (
              <>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => decide(true, "task_run")}>
                  本次运行内允许
                </button>
                <p className="small muted approval-scope-hint">
                  本次运行内允许：后续调用同一工具（包括不同参数）不再询问，运行结束后失效。
                </p>
              </>
            ) : null}
          </div>
        ) : a.status === "pending" ? (
          <span className="small muted">等待审批人处理</span>
        ) : null}
      </footer>
    </article>
  );
}

/** Where a note the role asks to remember would be used (the scopes of the remember tool). */
function memoryScopeHint(scope: string | undefined): string {
  if (scope === "role")
    return "AI 员工记忆：它在所有话题、私信以及 Slack、飞书、GitHub 中都会看到，可能出现在与它对话的任何人面前。";
  return "话题记忆：只在这个话题（或这段私信）中使用。";
}

/** Keep multiline text readable (e.g. a memory's content), with a bounded area for long requests. */
function ToolArguments({ value }: { value: unknown }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return <JsonBlock value={value} maxHeight={260} />;
  return (
    <dl className="approval-arguments">
      {Object.entries(value).map(([name, argument]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>
            <JsonBlock value={argument} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

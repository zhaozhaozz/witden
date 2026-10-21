import type { ReactNode } from "react";
import type { RoleDecision, TraceStep } from "../api/types";
import { CONVERSATION_KIND, type Tone } from "../lib/format";
import { useDirectory } from "../lib/session";
import { IdText } from "./kit";

export interface Stop {
  key: string;
  title: ReactNode;
  tone?: Tone;
  meta?: ReactNode;
  body?: ReactNode;
}

/**
 * A route-map view of a decision or a chain of events: each stop is a node on one line, and the
 * line colour follows the outcome so the reader sees at a glance where a request was let through
 * or stopped.
 */
export function TraceRail({ stops, dense }: { stops: Stop[]; dense?: boolean }) {
  return (
    <ol className={`rail${dense ? " rail-dense" : ""}`}>
      {stops.map((s) => (
        <li key={s.key} className={`rail-stop rail-${s.tone ?? "info"}`}>
          <span className="rail-node" aria-hidden />
          <div className="rail-content">
            <div className="rail-title">
              <span>{s.title}</span>
              {s.meta ? <span className="rail-meta">{s.meta}</span> : null}
            </div>
            {s.body ? <div className="rail-body">{s.body}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

const KNOWN_TEXT: Record<string, string> = {
  allowed: "允许",
  "requester is not a recognised active member": "请求人不是已识别的在职成员",
  "no role was mentioned": "消息没有 @ AI 员工",
  "this connection's bot has no role yet: an administrator must choose the role it stands for":
    "这个接入的机器人还没有选择代表的 AI 员工，需要管理员在接入详情中选择",
  "the role the connection's bot stands for": "没有 @ AI 员工，交给机器人代表的 AI 员工",
};

/** Steps of the assignment rules, which were removed; older tasks still carry them. */
const LEGACY_STEPS = new Set(["matched_rules", "fallback", "restrictions"]);

export function zh(text: string): string {
  return KNOWN_TEXT[text] ?? text;
}

export interface NameLookups {
  instanceName?: (id: string) => string | undefined;
  topicTitle?: (id: string) => string | undefined;
  connectionName?: (id: string) => string | undefined;
}

/** Render a task's assignment trace (`assignment.trace`) as readable steps. */
export function AssignmentTrace({ trace, lookups = {} }: { trace: TraceStep[]; lookups?: NameLookups }) {
  const dir = useDirectory();
  const roleName = (id: string) => dir.roleLabel(id);
  const named = (id: string | null | undefined, fn?: (id: string) => string | undefined) =>
    id ? <span>{fn?.(id) ?? <IdText id={id} />}</span> : <span className="muted">—</span>;

  const stops: Stop[] = trace
    .filter((step) => !LEGACY_STEPS.has(step.step))
    .map((step, i) => {
      const key = `${i}-${step.step}`;
      const d = step.detail;
      switch (step.step) {
        case "request": {
          const r = (d ?? {}) as Record<string, string | null>;
          return {
            key,
            title: "收到请求",
            body: (
              <div className="rail-grid">
                <span>请求人</span>
                <span>{r.user_id ? dir.userName(r.user_id) : <span className="muted">未知</span>}</span>
                <span>来源</span>
                <span>{CONVERSATION_KIND[r.conversation_kind ?? "internal"] ?? r.conversation_kind}</span>
                {r.topic_id ? (
                  <>
                    <span>话题</span>
                    {named(r.topic_id, lookups.topicTitle)}
                  </>
                ) : null}
                {r.connection_id ? (
                  <>
                    <span>通讯接入</span>
                    {named(r.connection_id, lookups.connectionName)}
                  </>
                ) : null}
                {r.conversation_id ? (
                  <>
                    <span>外部会话</span>
                    <IdText id={r.conversation_id} full />
                  </>
                ) : null}
                {r.by_role_id ? (
                  <>
                    <span>由 AI 员工转交</span>
                    <span>{roleName(r.by_role_id)}</span>
                  </>
                ) : null}
              </div>
            ),
          };
        }
        case "candidates": {
          const text = String(d);
          // Server format: "asked for: role_a, role_b" (older tasks: "explicitly requested: …").
          const asked = text.match(/^(?:asked for|explicitly requested): (.*)$/);
          let body: ReactNode = zh(text);
          if (asked) {
            const ids = asked[1]
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            body = `请求的 AI 员工：${ids.map(roleName).join("、")}`;
          }
          return { key, title: "确定候选 AI 员工", body };
        }
        case "roles": {
          const decisions = (Array.isArray(d) ? d : []) as RoleDecision[];
          const anyOk = decisions.some((x) => x.allowed);
          return {
            key,
            title: "逐个检查 AI 员工的权限",
            tone: anyOk ? "ok" : "bad",
            body: (
              <ul className="rail-list">
                {decisions.map((x) => (
                  <li key={x.role_id} className="decision">
                    <span className={x.allowed ? "tag tag-ok" : "tag tag-bad"}>{x.allowed ? "可用" : "不可用"}</span>
                    <strong>{roleName(x.role_id)}</strong>
                    {x.instance_id ? (
                      <span className="muted small">
                        虚拟电脑 {lookups.instanceName?.(x.instance_id) ?? x.instance_id}
                      </span>
                    ) : null}
                    {x.reasons?.length ? (
                      <ul className="reasons">
                        {x.reasons.map((r, j) => (
                          <li key={j}>{zh(r)}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            ),
          };
        }
        case "result": {
          const ok = d === "allowed";
          return {
            key,
            title: ok ? "结论：允许" : "结论：拒绝",
            tone: ok ? "ok" : "bad",
            body: ok ? undefined : zh(String(d ?? "")),
          };
        }
        default:
          return {
            key,
            title: step.step,
            body: typeof d === "string" ? d : <pre className="mono-block">{JSON.stringify(d, null, 2)}</pre>,
          };
      }
    });

  return <TraceRail stops={stops} />;
}

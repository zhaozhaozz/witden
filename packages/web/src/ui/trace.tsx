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
  "internal topic without rules: topic participants decide": "内部话题没有匹配规则：由话题参与者决定可用角色",
  "requester is not a recognised active member": "请求人不是已识别的在职成员",
  "no assignment rule covers this conversation; an administrator must add one":
    "没有分配规则覆盖这个外部会话，需要管理员添加规则",
  "no role was mentioned and no rule defines a default role": "消息没有 @ 角色，也没有规则定义默认角色",
};

export function zh(text: string): string {
  return KNOWN_TEXT[text] ?? text;
}

export interface NameLookups {
  instanceName?: (id: string) => string | undefined;
  topicTitle?: (id: string) => string | undefined;
  connectionName?: (id: string) => string | undefined;
}

/** Render the assignment trace (from `/api/rules/explain` or a task's `assignment.trace`) as readable steps. */
export function AssignmentTrace({ trace, lookups = {} }: { trace: TraceStep[]; lookups?: NameLookups }) {
  const dir = useDirectory();
  const roleName = (id: string) => dir.roleLabel(id);
  const named = (id: string | null | undefined, fn?: (id: string) => string | undefined) =>
    id ? <span>{fn?.(id) ?? <IdText id={id} />}</span> : <span className="muted">—</span>;

  const stops: Stop[] = trace.map((step, i) => {
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
            </div>
          ),
        };
      }
      case "matched_rules": {
        const rules = (Array.isArray(d) ? d : []) as {
          id: string;
          name: string;
          effect: string;
          specificity: number;
        }[];
        return {
          key,
          title: "匹配分配规则",
          meta: rules.length ? `${rules.length} 条，按具体度排序` : "无",
          body: rules.length ? (
            <ul className="rail-list">
              {rules.map((r) => (
                <li key={r.id}>
                  <span className={r.effect === "deny" ? "tag tag-bad" : "tag tag-ok"}>
                    {r.effect === "deny" ? "拒绝" : "允许"}
                  </span>
                  <strong>{r.name}</strong>
                  <span className="muted small">具体度 {r.specificity}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted">没有规则匹配这个请求</span>
          ),
        };
      }
      case "fallback":
        return { key, title: "兜底规则", tone: "wait", body: zh(String(d)) };
      case "restrictions": {
        const r = (d ?? {}) as {
          allowed_roles?: string[] | string;
          denied_roles?: string[];
          allowed_instances?: string[] | string;
        };
        const list = (v: string[] | string | undefined, fn: (id: string) => ReactNode) =>
          v === "unrestricted" || v === undefined ? (
            <span className="muted">不限</span>
          ) : Array.isArray(v) && v.length === 0 ? (
            <span className="text-bad">无（全部排除）</span>
          ) : (
            <span className="inline-list">
              {(v as string[]).map((id) => (
                <span key={id} className="tag">
                  {fn(id)}
                </span>
              ))}
            </span>
          );
        return {
          key,
          title: "汇总限制（多条规则取交集）",
          body: (
            <div className="rail-grid">
              <span>允许的角色</span>
              {list(r.allowed_roles, roleName)}
              <span>排除的角色</span>
              {r.denied_roles?.length ? list(r.denied_roles, roleName) : <span className="muted">无</span>}
              <span>允许的电脑</span>
              {list(r.allowed_instances, (id) => lookups.instanceName?.(id) ?? id)}
            </div>
          ),
        };
      }
      case "candidates": {
        const text = String(d);
        // Server format: "explicitly requested: role_a, role_b" (role ids joined by ", ").
        const explicit = text.match(/^explicitly requested: (.*)$/);
        const byRule = text.match(/^default role from rule '(.*)'$/);
        let body: ReactNode = zh(text);
        if (explicit) {
          const ids = explicit[1]
            .split(",")
            .map((s) =>
              s
                .trim()
                .replace(/^\[|\]$/g, "")
                .replace(/^'|'$/g, ""),
            )
            .filter(Boolean);
          body = `消息中明确 @ 了：${ids.map(roleName).join("、")}`;
        } else if (byRule) {
          body = `没有 @ 角色，使用规则「${byRule[1]}」中的默认角色`;
        }
        return { key, title: "确定候选角色", body };
      }
      case "roles": {
        const decisions = (Array.isArray(d) ? d : []) as RoleDecision[];
        const anyOk = decisions.some((x) => x.allowed);
        return {
          key,
          title: "逐个检查角色权限",
          tone: anyOk ? "ok" : "bad",
          body: (
            <ul className="rail-list">
              {decisions.map((x) => (
                <li key={x.role_id} className="decision">
                  <span className={x.allowed ? "tag tag-ok" : "tag tag-bad"}>{x.allowed ? "可用" : "不可用"}</span>
                  <strong>{roleName(x.role_id)}</strong>
                  {x.instance_id ? (
                    <span className="muted small">电脑 {lookups.instanceName?.(x.instance_id) ?? x.instance_id}</span>
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

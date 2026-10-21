import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { TaskActivity, TaskStep } from "../../api/types";
import { fmtNumber, fmtTokens, TOOL_LABEL } from "../../lib/format";

interface RecordedCall {
  id: string;
  function?: { name?: string; arguments?: unknown };
}
function calls(step: TaskStep | undefined): RecordedCall[] {
  return Array.isArray(step?.payload.tool_calls) ? (step.payload.tool_calls as RecordedCall[]) : [];
}

interface Operation {
  key: string;
  label: string;
  preview: string;
  source?: TaskStep;
  result?: TaskStep;
  callId?: string;
  pending?: boolean;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p.type === "text" ? p.text : "[图片]")).join("\n");
  return "";
}
function args(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return value ? JSON.stringify(value, null, 2) : "";
}
function callPreview(value: unknown): string {
  try {
    const p = typeof value === "string" ? JSON.parse(value) : value;
    return String(p?.command ?? p?.path ?? p?.query ?? p?.text ?? args(value));
  } catch {
    return String(value ?? "");
  }
}

/** Join tool requests and results by ID: one operation stays one row even when its result arrives later. */
function operations(steps: TaskStep[]): Operation[] {
  const results = new Map(steps.filter((s) => s.kind === "tool").map((s) => [s.payload.tool_call_id, s]));
  const known = new Set(steps.flatMap((s) => calls(s).map((c) => c.id)));
  return steps.flatMap((s): Operation[] => {
    const p = s.payload;
    if (s.kind === "assistant")
      return [
        {
          key: `model-${s.seq}`,
          label: "思考",
          preview: text(p.reasoning_content) || text(p.content) || "模型未返回思考文本",
          source: s,
        },
        ...calls(s).map((c: { id: string; function?: { name?: string; arguments?: unknown } }) => ({
          key: `tool-${c.id}`,
          label: TOOL_LABEL[c.function?.name ?? ""] ?? c.function?.name ?? "使用工具",
          preview: callPreview(c.function?.arguments),
          source: s,
          result: results.get(c.id),
          callId: c.id,
          pending: !results.has(c.id),
        })),
      ];
    if (s.kind === "tool")
      return known.has(String(p.tool_call_id))
        ? []
        : [
            {
              key: `tool-${p.tool_call_id ?? s.seq}`,
              label: TOOL_LABEL[String(p.name)] ?? "工具结果",
              preview: s.request ? callPreview(s.request.function?.arguments) : text(p.content),
              source: s,
            },
          ];
    if (s.kind === "event") {
      const preview = p.type === "role_handoff" ? "任务转交给其他 AI 员工" : String(p.note ?? p.reason ?? p.type ?? "");
      return [{ key: `step-${s.seq}`, label: "状态", preview, source: s }];
    }
    return [
      {
        key: `step-${s.seq}`,
        label: p.summary ? "整理上下文" : s.kind === "system" ? "系统" : "输入",
        preview: text(p.content),
        source: s,
      },
    ];
  });
}
function mergeSteps(a: TaskStep[], b: TaskStep[]) {
  return [...new Map([...a, ...b].map((s) => [s.seq, s])).values()].sort((x, y) => x.seq - y.seq);
}
function elapsed(start: string | undefined, end: number) {
  if (!start) return "—";
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}时${Math.floor((seconds % 3600) / 60)}分`;
}

/** Keep the old text mounted while it fades out, then reveal the latest status. */
function ExecutionStatus({ status }: { status: string }) {
  const [label, setLabel] = useState(status);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (status === label || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setLabel(status);
      setFading(false);
      return;
    }
    setFading(true);
    const timer = window.setTimeout(() => {
      setLabel(status);
      setFading(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [status, label]);
  return (
    <span className={`execution-status${fading ? " is-fading" : ""}`} role="status" title={status}>
      {label}
    </span>
  );
}

export function ExecutionProgress({
  taskId,
  status,
  statusCode,
  onStatus,
  active,
  running,
  phase,
  liveText,
  version,
  connected,
  expanded,
  onToggle,
}: {
  taskId: string;
  status: string;
  statusCode: string;
  onStatus: (status: string) => void;
  active: boolean;
  running: boolean;
  phase: string;
  liveText: string;
  version: number;
  connected: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [snapshot, setSnapshot] = useState<TaskActivity>();
  const [steps, setSteps] = useState<TaskStep[]>([]);
  const stepsRef = useRef(steps);
  const [older, setOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const id = useId();
  const cache = useRef(new Map<number, Promise<TaskStep>>());
  const detail = (seq: number) => {
    let pending = cache.current.get(seq);
    if (!pending) {
      pending = api.get<TaskStep>(`/api/tasks/${taskId}/log/${seq}`).catch((err) => {
        cache.current.delete(seq);
        throw err;
      });
      cache.current.set(seq, pending);
    }
    return pending;
  };
  const merge = (incoming: TaskStep[]) => {
    stepsRef.current = mergeSteps(stepsRef.current, incoming);
    setSteps(stepsRef.current);
  };

  useEffect(() => {
    if (!active) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const fallback = window.setInterval(() => {
      if (!document.hidden) setRefresh((n) => n + 1);
    }, 5000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(fallback);
    };
  }, [active]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      let after = expanded ? stepsRef.current.at(-1)?.seq : undefined;
      try {
        do {
          const data = await api.get<TaskActivity>(`/api/tasks/${taskId}/activity`, {
            steps: expanded ? "true" : undefined,
            after,
          });
          if (cancelled) return;
          setSnapshot(data);
          if (data.status !== statusCode) onStatus(data.status);
          setError("");
          if (!expanded) return;
          merge(data.steps);
          if (after === undefined) {
            setOlder(data.has_more);
            return;
          }
          if (!data.has_more || !data.steps.length) return;
          after = data.steps.at(-1)!.seq;
        } while (!cancelled);
      } catch {
        if (!cancelled) setError("暂时无法更新执行过程");
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [taskId, version, phase, connected, expanded, refresh, statusCode]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prepend.current) {
      el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (following.current) el.scrollTop = el.scrollHeight;
  }, [steps, expanded]);

  const loadOlder = async () => {
    if (loadingOlder || !steps.length) return;
    setLoadingOlder(true);
    try {
      const data = await api.get<TaskActivity>(`/api/tasks/${taskId}/activity`, {
        steps: "true",
        before: steps[0].seq,
      });
      const el = scroller.current;
      if (el) prepend.current = { height: el.scrollHeight, top: el.scrollTop };
      merge(data.steps);
      setOlder(data.has_more);
      setError("");
    } catch {
      setError("暂时无法加载更早的过程");
    } finally {
      setLoadingOlder(false);
    }
  };
  const rows = operations(steps);
  if (running && ["thinking", "writing", "compacting"].includes(phase))
    rows.push({
      key: "current",
      label: phase === "compacting" ? "整理上下文" : "思考",
      preview: liveText || (phase === "writing" ? "正在生成回复…" : "等待模型返回…"),
      pending: true,
    });
  const end = snapshot?.finished_at ? Date.parse(snapshot.finished_at) : now;
  return (
    <section className={`execution-progress${running && connected ? " execution-running" : ""}`} aria-label="执行进度">
      <button type="button" className="execution-toggle" aria-expanded={expanded} aria-controls={id} onClick={onToggle}>
        <span className="execution-heading">
          <span className="live-indicator" aria-hidden />
          <ExecutionStatus status={status} />
          {!connected && active ? <span className="small muted">连接中</span> : null}
        </span>
        <span className="execution-stats">
          <span title="已完成的模型调用次数，包含上下文整理">
            <b>{snapshot ? fmtNumber(snapshot.rounds) : "—"}</b> 轮
          </span>
          <span title="从运行开始到现在的经过时间，包含等待">
            <b>{elapsed(snapshot?.started_at, end)}</b>
          </span>
          <span title="已向电脑发起的命令与终端启动次数，包含执行中及失败的调用；被拒绝的审批不计数">
            <b>{snapshot ? fmtNumber(snapshot.commands) : "—"}</b> 条命令
          </span>
          <span
            title={`模型已返回 ${fmtNumber(snapshot?.tokens)} token（输入与输出总量，包含缓存）；生成中的用量将在返回后更新`}
          >
            <b>{fmtTokens(snapshot?.tokens)}</b> token
          </span>
        </span>
        <span className="execution-chevron" aria-hidden>
          {expanded ? "⌃" : "⌄"}
        </span>
      </button>
      {error ? (
        <div className="execution-error" role="status">
          {error}{" "}
          <button type="button" className="link" onClick={() => setRefresh((n) => n + 1)}>
            重试
          </button>
        </div>
      ) : null}
      {expanded ? (
        <div
          id={id}
          className="execution-scroll"
          ref={scroller}
          role="region"
          aria-label="执行过程"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded log region must support keyboard scrolling.
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
          }}
        >
          {older ? (
            <button type="button" className="execution-earlier" disabled={loadingOlder} onClick={loadOlder}>
              {loadingOlder ? "加载中…" : "加载更早的过程"}
            </button>
          ) : null}
          {!steps.length && !snapshot ? <p className="muted small">正在读取执行过程…</p> : null}
          {rows.length ? (
            rows.map((row) => (
              <OperationRow
                key={row.key}
                operation={row}
                detail={detail}
                pendingLabel={
                  !active ? "未完成" : status === "等待审批" ? "待审批" : row.key === "current" ? "进行中" : "待结果"
                }
              />
            ))
          ) : (
            <p className="muted small">还没有执行记录。</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function OperationRow({
  operation: row,
  detail,
  pendingLabel,
}: {
  operation: Operation;
  detail: (seq: number) => Promise<TaskStep>;
  pendingLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<TaskStep[]>([]);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const id = useId();
  const sourceSeq = row.source?.seq;
  const resultSeq = row.result?.seq;
  useEffect(() => {
    if (!open || sourceSeq === undefined) return;
    let cancelled = false;
    setError(false);
    void Promise.all([detail(sourceSeq), ...(resultSeq === undefined ? [] : [detail(resultSeq)])])
      .then((data) => {
        if (!cancelled) setFull(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sourceSeq, resultSeq, retry]);
  const source = full.find((s) => s.seq === sourceSeq) ?? row.source;
  const result = full.find((s) => s.seq === resultSeq) ?? row.result;
  const p = source?.payload;
  const call = row.callId ? calls(source).find((c) => c.id === row.callId) : source?.request;
  const outcome = text(row.result?.payload.content ?? (row.source?.kind === "tool" ? row.source.payload.content : ""));
  const failure = /^(error:|\[exit code (?!0\])|\[timed out)/i.test(outcome);
  const uncertain = outcome.startsWith("uncertain:");
  return (
    <div className={`execution-operation${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="execution-row"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((x) => !x)}
      >
        <span className="execution-row-chevron" aria-hidden>
          {open ? "⌄" : "›"}
        </span>
        <span className="execution-label">{row.label}</span>
        <span className="execution-preview">{row.preview.replace(/\s+/g, " ").slice(0, 240) || "查看详情"}</span>
        {row.pending ? (
          <span className="execution-pending">{pendingLabel}</span>
        ) : failure || uncertain ? (
          <span className={failure ? "execution-failed" : "execution-pending"}>{failure ? "失败" : "结果不确定"}</span>
        ) : (
          <span className="execution-check" aria-hidden>
            ✓
          </span>
        )}
      </button>
      {open ? (
        <div id={id} className="execution-detail">
          {error ? (
            <p role="status">
              详细内容读取失败{" "}
              <button type="button" className="link" onClick={() => setRetry((x) => x + 1)}>
                重试
              </button>
            </p>
          ) : null}
          {call ? (
            <>
              <div className="small muted">参数 · {call.function?.name}</div>
              <pre>{args(call.function?.arguments)}</pre>
              <div className="small muted">结果</div>
              <pre>
                {result
                  ? text(result.payload.content)
                  : source?.kind === "tool"
                    ? text(source.payload.content)
                    : "尚未返回结果"}
              </pre>
            </>
          ) : p ? (
            source?.kind === "assistant" ? (
              <>
                <div className="small muted">思考</div>
                <pre>{text(p.reasoning_content) || "模型未返回思考文本。"}</pre>
                {text(p.content) ? (
                  <>
                    <div className="small muted">模型输出</div>
                    <pre>{text(p.content)}</pre>
                  </>
                ) : null}
              </>
            ) : (
              <pre>{text(p.content) || String(p.note ?? p.reason ?? p.type ?? "暂无详细内容")}</pre>
            )
          ) : (
            <pre>{row.preview}</pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

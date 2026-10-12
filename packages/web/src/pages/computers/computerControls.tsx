/** Controls shared by the virtual computer page and a topic's side panel: live screen, takeover, console. */
import { lazy, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../api/client";
import type { ExecResult, Instance } from "../../api/types";
import { fmtRelative } from "../../lib/format";
import { useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import { Section, Tag } from "../../ui/kit";

// noVNC is large; load it only when a desktop screen is actually opened.
export const LiveDesktop = lazy(() => import("./LiveDesktop").then((m) => ({ default: m.LiveDesktop })));

/**
 * Take over a virtual computer: AI work on it pauses until the person hands it back. No reason is asked;
 * only when AI work is running there does a confirmation say what will pause.
 */
export function useTakeover() {
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const takeOver = async (inst: Instance): Promise<Instance | undefined> => {
    const count = inst.active_tasks?.length ?? 0;
    if (count) {
      const ok = await confirm({
        title: `接管 ${inst.name}`,
        confirmLabel: "接管",
        body: (
          <p>
            这台虚拟电脑上有 {count} 项 AI
            工作，接管后会暂停，直到你交还控制。接管期间，你在浏览器里的鼠标和键盘操作会发送到这台虚拟电脑（不会影响你自己的电脑）。
          </p>
        ),
      });
      if (!ok) return undefined;
    }
    return run(
      () => api.post<Instance>(`/api/instances/${inst.id}/takeover`, {}),
      "你已接管这台虚拟电脑，AI 工作已暂停",
    );
  };
  return { takeOver, busy };
}

interface ConsoleEntry {
  id: number;
  command: string;
  result?: ExecResult;
  error?: string;
  at: Date;
}

/** Run shell commands in a virtual computer as its operator (audited; never on the platform host). */
export function OperatorConsole({ inst }: { inst: Instance }) {
  const [command, setCommand] = useState("");
  const [timeout, setTimeoutSec] = useState(60);
  const [history, setHistory] = useState<ConsoleEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const end = useRef<HTMLDivElement>(null);

  // Block body on purpose: newer browsers return a Promise from scrollIntoView, and anything an effect
  // returns is called as its cleanup when the tab unmounts (which crashed the page).
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [history]);

  const exec = async () => {
    const cmd = command.trim();
    if (!cmd || busy) return;
    setBusy(true);
    const id = nextId.current++;
    setHistory((h) => [...h, { id, command: cmd, at: new Date() }]);
    setCommand("");
    try {
      const result = await api.post<ExecResult>(`/api/instances/${inst.id}/exec`, { command: cmd, timeout });
      setHistory((h) => h.map((e) => (e.id === id ? { ...e, result } : e)));
    } catch (err) {
      setHistory((h) => h.map((e) => (e.id === id ? { ...e, error: errorMessage(err) } : e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="操作员控制台">
      <p className="small muted">
        命令经由 Runner 只在这台虚拟电脑（容器）内执行，以非特权用户 <code>{String(inst.spec?.user ?? "witden")}</code>{" "}
        的身份运行，每条命令都会记录审计。不会在平台宿主机上执行。
      </p>
      <div className="console">
        {history.length ? null : <div className="console-empty">还没有执行过命令</div>}
        {history.map((e) => (
          <div key={e.id} className="console-entry">
            <div className="console-cmd">
              <span className="console-prompt">$</span> {e.command}
            </div>
            {e.error ? <div className="console-err">{e.error}</div> : null}
            {e.result ? (
              <>
                <pre className="console-out">{e.result.output || "（无输出）"}</pre>
                <div className={`console-exit${e.result.exit_code === 0 ? "" : " console-exit-bad"}`}>
                  退出码 {e.result.exit_code}
                  {e.result.timed_out ? " · 已超时" : ""}
                  {e.result.truncated ? " · 输出已截断" : ""}
                </div>
              </>
            ) : !e.error ? (
              <div className="console-run">执行中…</div>
            ) : null}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="console-form"
        onSubmit={(e) => {
          e.preventDefault();
          void exec();
        }}
      >
        <input
          className="mono"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={inst.status === "running" ? "输入 shell 命令，例如 ls -la" : "虚拟电脑未运行"}
          disabled={inst.status !== "running"}
          aria-label="命令"
        />
        <label className="console-timeout small">
          超时
          <input
            type="number"
            min={1}
            max={600}
            value={timeout}
            onChange={(e) => setTimeoutSec(Number(e.target.value) || 60)}
          />
          秒
        </label>
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={busy || !command.trim() || inst.status !== "running"}
        >
          执行
        </button>
      </form>
    </Section>
  );
}

/** Who is operating a virtual computer right now: a person who took over, a role, or nobody. */
export function OperatorLabel({ inst }: { inst: Pick<Instance, "operator"> }) {
  const dir = useDirectory();
  const op = inst.operator;
  if (!op) return <span className="muted">空闲</span>;
  if (op.holder_type === "user")
    return (
      <span title={op.reason && op.reason !== "human takeover" ? op.reason : undefined}>
        <Tag tone="wait">人工接管</Tag> {dir.userName(op.holder_id)}
      </span>
    );
  return (
    <span title={`租约到期 ${fmtRelative(op.expires_at)}`}>
      <Tag tone="run">AI 操作中</Tag> {dir.roleLabel(op.holder_id)}
    </span>
  );
}

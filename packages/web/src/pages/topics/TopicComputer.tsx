import { Suspense, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { Instance, Topic } from "../../api/types";
import { instanceStatus } from "../../lib/format";
import { useInterval, useResource } from "../../lib/hooks";
import { useAuth } from "../../lib/session";
import { useAction } from "../../ui/feedback";
import { ComputerBadge, Empty, Loaded, Loading, StatusChip } from "../../ui/kit";
import {
  LiveDesktop,
  OperatorConsole,
  OperatorLabel,
  useTakeover,
  useTakeoverSession,
} from "../computers/computerControls";

type Computer = { id: string; name: string; color: string | null };

/** The virtual computers the topic's roles work on (one entry per computer). */
export function topicComputers(topic: Topic): Computer[] {
  const seen = new Map<string, Computer>();
  for (const p of topic.participants ?? []) if (p.type === "role" && p.instance) seen.set(p.instance.id, p.instance);
  return [...seen.values()];
}

/**
 * A topic's virtual computer in the side panel: the live desktop (or the operator console of a command-line
 * computer), with takeover and hand-back. ``maximized`` lays it over the whole topic; the conversation then
 * floats (see TopicView).
 */
export function TopicComputer({
  topic,
  maximized,
  onToggleMax,
}: {
  topic: Topic;
  maximized: boolean;
  onToggleMax: () => void;
}) {
  const computers = topicComputers(topic);
  const [picked, setPicked] = useState(computers[0]?.id ?? "");
  const current = computers.some((c) => c.id === picked) ? picked : (computers[0]?.id ?? "");
  const res = useResource(() => api.get<Instance>(`/api/instances/${current}`), [current], !!current);
  // Takeovers and status changes by others show up within a few seconds.
  useInterval(() => void res.reload(), 8000, !!current);

  if (!computers.length) {
    return <Empty title="没有虚拟电脑" hint="这个话题里的角色还没有分配虚拟电脑。" />;
  }
  return (
    <div className={`topic-computer${maximized ? " topic-computer-max" : ""}`}>
      <div className="tc-bar">
        {computers.length > 1 ? (
          <select value={current} onChange={(e) => setPicked(e.target.value)} aria-label="选择虚拟电脑">
            {computers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <ComputerBadge computer={computers[0]} />
        )}
        {res.data ? <StatusChip meta={instanceStatus(res.data.status)} compact /> : null}
        {res.data ? (
          <span className="small">
            <OperatorLabel inst={res.data} />
          </span>
        ) : null}
        <span className="tc-spacer" />
        <Link to={`/computers/${current}`} className="small">
          详情
        </Link>
        <button
          type="button"
          className="btn btn-xs"
          onClick={onToggleMax}
          title={maximized ? "还原布局" : "放大到整个话题区域"}
        >
          {maximized ? "还原" : "放大"}
        </button>
      </div>
      <Loaded res={res}>
        {(inst) => (
          <ComputerView inst={inst} maximized={maximized} onMaximize={onToggleMax} reload={() => void res.reload()} />
        )}
      </Loaded>
    </div>
  );
}

/**
 * Small, the screen is a read-only thumbnail (hover shows a zoom icon that maximises it). Taking over is
 * offered only maximised, in the screen's status bar; restoring the layout or leaving hands control back
 * (see useTakeoverSession).
 */
function ComputerView({
  inst,
  maximized,
  onMaximize,
  reload,
}: {
  inst: Instance;
  maximized: boolean;
  onMaximize: () => void;
  reload: () => void;
}) {
  const { can, me } = useAuth();
  const { run, busy } = useAction();
  const { takeOver, busy: taking } = useTakeover();
  const desktop = inst.spec?.kind === "desktop";
  const running = inst.status === "running";
  const canControl = can("instance.control");
  const heldByMe = inst.operator?.holder_type === "user" && inst.operator.holder_id === me?.id;
  const mode: "view" | "control" = heldByMe && canControl && maximized ? "control" : "view";
  useTakeoverSession(inst, maximized, reload);

  const control =
    maximized && desktop && canControl ? (
      heldByMe ? (
        <button
          type="button"
          className="btn btn-xs btn-primary"
          disabled={busy}
          onClick={async () => {
            if (await run(() => api.post(`/api/instances/${inst.id}/handback`), "已交还控制，AI 工作恢复")) reload();
          }}
        >
          交还控制
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-xs"
          disabled={taking || !running}
          onClick={async () => {
            if (await takeOver(inst)) reload();
          }}
        >
          接管并操作
        </button>
      )
    ) : null;

  if (!running) return <Empty title="虚拟电脑未运行" hint="启动后可以在这里看到它的画面。" />;
  if (!desktop) {
    return canControl ? (
      <OperatorConsole inst={inst} />
    ) : (
      <Empty
        title="命令行虚拟电脑没有桌面画面"
        hint="有「接管虚拟电脑」权限的人可以在这里直接执行命令；角色的操作记录见任务详情。"
      />
    );
  }
  return (
    <div className="tc-screen">
      <Suspense fallback={<Loading label="正在加载实时画面组件" />}>
        <LiveDesktop key={mode} instanceId={inst.id} mode={mode} actions={control} />
      </Suspense>
      {maximized ? null : (
        <button type="button" className="tc-zoom" onClick={onMaximize} title="放大查看" aria-label="放大查看">
          <span>
            <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden>
              <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
              <path
                d="M15.5 15.5 21 21M10.5 7.5v6M7.5 10.5h6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
        </button>
      )}
    </div>
  );
}

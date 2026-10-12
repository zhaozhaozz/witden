import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type { Instance, Resources, RunnerInfo } from "../../api/types";
import { fmtDateTime, fmtRelative, instanceStatus, RUNNER_VIA_LABEL } from "../../lib/format";
import { useAuth } from "../../lib/session";
import { Field, KV, StatusChip, Tag } from "../../ui/kit";

export function ComputersNav() {
  const { can } = useAuth();
  const showInstances = ["instance.manage", "instance.observe", "instance.control"].some(can);
  return (
    <div className="subnav">
      {showInstances ? (
        <NavLink end to="/computers" className={({ isActive }) => (isActive ? "subnav-item subnav-on" : "subnav-item")}>
          虚拟电脑实例
        </NavLink>
      ) : null}
      <NavLink
        to="/computers/templates"
        className={({ isActive }) => (isActive ? "subnav-item subnav-on" : "subnav-item")}
      >
        模板
      </NavLink>
    </div>
  );
}

export function InstanceStatusChip({
  inst,
  compact,
}: {
  inst: Pick<Instance, "status" | "status_reason">;
  compact?: boolean;
}) {
  return (
    <StatusChip
      meta={instanceStatus(inst.status)}
      reason={compact ? undefined : inst.status_reason}
      compact={compact}
    />
  );
}

/** Compact runner indicator for lists: only worth showing while the computer runs. */
export function RunnerBadge({ inst }: { inst: Pick<Instance, "status" | "runner"> }) {
  if (inst.runner?.connected) return <Tag tone="ok">Runner 在线</Tag>;
  if (inst.status !== "running") return null;
  return (
    <Tag tone="off" title="未连接的 Runner 会在需要时重新连接；命令行网络受限的虚拟电脑通过管理通道按需连接">
      Runner 未连接
    </Tag>
  );
}

function runnerFacts(info: RunnerInfo) {
  const d = info.desktop;
  return [
    [
      "运行用户",
      info.user ? (
        <span>
          <code className="id">{info.user}</code>
          {info.uid !== undefined ? <span className="muted small"> uid {info.uid}</span> : null}
          {info.uid === 0 ? <span className="text-bad small"> 以 root 运行</span> : null}
        </span>
      ) : null,
    ],
    ["主机名", info.hostname ? <code className="id">{info.hostname}</code> : null],
    ["工作目录", info.workdir ? <code className="id">{info.workdir}</code> : null],
    [
      "桌面",
      d ? (
        `显示器 ${d.display ?? "?"}${d.width && d.height ? ` · ${d.width}×${d.height}` : ""}`
      ) : (
        <span className="muted">无</span>
      ),
    ],
    ["浏览器", info.browser ? "可用" : <span className="muted">不可用</span>],
  ] as [string, ReactNode][];
}

/**
 * The runner is the agent inside the computer through which every AI action and every live view goes.
 * `runner` is the live connection; `runner_connected_at` / `runner_info` are what it reported last time.
 */
export function RunnerPanel({ inst }: { inst: Instance }) {
  const r = inst.runner ?? { connected: false };
  const network = inst.resources?.network ?? "bridge";
  const info = r.connected ? r.info : inst.runner_info;
  let hint: string | null = null;
  if (!r.connected) {
    if (inst.status !== "running") hint = "虚拟电脑未运行，Runner 不在线。";
    else if (network !== "bridge")
      hint =
        "这台虚拟电脑没有到平台的网络路由，Runner 在有操作需要时经 Docker 管理通道（stdio）按需连接，空闲时显示未连接是正常的。";
    else
      hint =
        "虚拟电脑运行后 Runner 会主动连入平台。长时间未连接时，请检查虚拟电脑内的 Runner 日志以及 Runner 连接地址的配置。";
  }
  return (
    <>
      <div className="operator">
        <div>
          {r.connected ? <Tag tone="ok">已连接</Tag> : <Tag tone="off">未连接</Tag>}{" "}
          {r.connected ? (
            <span className="small muted">
              {RUNNER_VIA_LABEL[r.via ?? ""] ?? r.via ?? ""}
              {r.since ? <span title={fmtDateTime(r.since)}> · {fmtRelative(r.since)}连接</span> : null}
            </span>
          ) : inst.runner_connected_at ? (
            <span className="small muted" title={fmtDateTime(inst.runner_connected_at)}>
              最近一次连接 {fmtRelative(inst.runner_connected_at)}
            </span>
          ) : (
            <span className="small muted">还没有连接过</span>
          )}
        </div>
        {hint ? <div className="small muted">{hint}</div> : null}
      </div>
      {info ? (
        <>
          {!r.connected ? <div className="small muted">以下是最近一次连接时 Runner 报告的环境：</div> : null}
          <KV items={runnerFacts(info)} />
        </>
      ) : null}
    </>
  );
}

export function resourceSummary(r: Resources | undefined): string {
  if (!r) return "—";
  const parts: string[] = [];
  if (r.cpus) parts.push(`${r.cpus} CPU`);
  if (r.memory_mb)
    parts.push(r.memory_mb >= 1024 ? `${+(r.memory_mb / 1024).toFixed(1)} GB 内存` : `${r.memory_mb} MB 内存`);
  if (r.disk_gb) parts.push(`${r.disk_gb} GB 磁盘`);
  if (r.pids_limit) parts.push(`${r.pids_limit} 进程`);
  if (r.network) parts.push(NETWORK_LABEL[r.network] ?? r.network);
  return parts.length ? parts.join(" · ") : "不限";
}

export const NETWORK_LABEL: Record<string, string> = {
  bridge: "可访问外网",
  internal: "仅内部网络",
  none: "无网络",
};

export interface ResourceDraft {
  cpus: string;
  memory_mb: string;
  disk_gb: string;
  pids_limit: string;
  network: string;
}

export function toDraft(r: Resources | undefined): ResourceDraft {
  return {
    cpus: r?.cpus?.toString() ?? "",
    memory_mb: r?.memory_mb?.toString() ?? "",
    disk_gb: r?.disk_gb?.toString() ?? "",
    pids_limit: r?.pids_limit?.toString() ?? "",
    network: r?.network ?? "bridge",
  };
}

export function fromDraft(d: ResourceDraft): Resources {
  const out: Resources = { network: d.network };
  if (d.cpus.trim()) out.cpus = Number(d.cpus);
  if (d.memory_mb.trim()) out.memory_mb = Number(d.memory_mb);
  if (d.disk_gb.trim()) out.disk_gb = Number(d.disk_gb);
  if (d.pids_limit.trim()) out.pids_limit = Number(d.pids_limit);
  return out;
}

/** Resource limit inputs; bounds mirror the backend's validation. */
export function ResourceFields({ value, onChange }: { value: ResourceDraft; onChange: (d: ResourceDraft) => void }) {
  const set = (k: keyof ResourceDraft) => (e: { target: { value: string } }) =>
    onChange({ ...value, [k]: e.target.value });
  return (
    <div className="form-grid">
      <Field label="CPU（核）" hint="0.1 – 64，留空不限">
        <input type="number" step="0.1" min={0.1} max={64} value={value.cpus} onChange={set("cpus")} />
      </Field>
      <Field label="内存（MB）" hint="128 – 262144">
        <input type="number" min={128} max={262144} value={value.memory_mb} onChange={set("memory_mb")} />
      </Field>
      <Field label="磁盘（GB）" hint="1 – 4096">
        <input type="number" min={1} max={4096} value={value.disk_gb} onChange={set("disk_gb")} />
      </Field>
      <Field label="进程数上限" hint="32 – 100000">
        <input type="number" min={32} max={100000} value={value.pids_limit} onChange={set("pids_limit")} />
      </Field>
      <Field label="网络">
        <select value={value.network} onChange={set("network")}>
          <option value="bridge">可访问外网（bridge）</option>
          <option value="internal">仅内部网络（internal）</option>
          <option value="none">无网络（none）</option>
        </select>
      </Field>
    </div>
  );
}

export function Meter({
  label,
  value,
  max,
  text,
}: {
  label: string;
  value: number;
  max?: number | null;
  text: string;
}) {
  const pct = max ? Math.min(100, Math.max(0, (value / max) * 100)) : null;
  const tone = pct === null ? "info" : pct > 90 ? "bad" : pct > 70 ? "wait" : "ok";
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-text">{text}</span>
      </div>
      {pct !== null ? (
        <div
          className="meter-track"
          role="meter"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        >
          <div className={`meter-fill meter-${tone}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

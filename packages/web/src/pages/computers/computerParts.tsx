import { NavLink } from "react-router-dom";
import type { Instance, Resources } from "../../api/types";
import { instanceStatus } from "../../lib/format";
import { useAuth } from "../../lib/session";
import { Field, StatusChip } from "../../ui/kit";

export function ComputersNav() {
  const { can } = useAuth();
  const showInstances = ["instance.manage", "instance.observe", "instance.control"].some(can);
  return (
    <div className="subnav">
      {showInstances ? (
        <NavLink end to="/computers" className={({ isActive }) => (isActive ? "subnav-item subnav-on" : "subnav-item")}>
          电脑实例
        </NavLink>
      ) : null}
      <NavLink to="/computers/templates" className={({ isActive }) => (isActive ? "subnav-item subnav-on" : "subnav-item")}>
        模板
      </NavLink>
    </div>
  );
}

export function InstanceStatusChip({ inst, compact }: { inst: Pick<Instance, "status" | "status_reason">; compact?: boolean }) {
  return <StatusChip meta={instanceStatus(inst.status)} reason={compact ? undefined : inst.status_reason} compact={compact} />;
}

export function resourceSummary(r: Resources | undefined): string {
  if (!r) return "—";
  const parts: string[] = [];
  if (r.cpus) parts.push(`${r.cpus} CPU`);
  if (r.memory_mb) parts.push(r.memory_mb >= 1024 ? `${+(r.memory_mb / 1024).toFixed(1)} GB 内存` : `${r.memory_mb} MB 内存`);
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
  const set = (k: keyof ResourceDraft) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
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

export function Meter({ label, value, max, text }: { label: string; value: number; max?: number | null; text: string }) {
  const pct = max ? Math.min(100, Math.max(0, (value / max) * 100)) : null;
  const tone = pct === null ? "info" : pct > 90 ? "bad" : pct > 70 ? "wait" : "ok";
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-text">{text}</span>
      </div>
      {pct !== null ? (
        <div className="meter-track" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <div className={`meter-fill meter-${tone}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

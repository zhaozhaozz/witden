import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Instance, SoftwareStatus } from "../../api/types";
import { fmtRelative } from "../../lib/format";
import { useAuth } from "../../lib/session";
import { useUnsavedChanges } from "../../lib/unsaved";
import { useAction } from "../../ui/feedback";
import { Field, Section, Tag } from "../../ui/kit";

const fromText = (text: string) =>
  text
    .split(/[\s,，]+/)
    .map((p) => p.trim())
    .filter(Boolean);

function StatusLine({ status }: { status: SoftwareStatus }) {
  if (status.state === "installing") return <Tag tone="run">正在安装</Tag>;
  if (status.state === "ok")
    return (
      <span className="inline-list">
        <Tag tone="ok">已安装</Tag>
        <span className="small muted">{fmtRelative(status.at)}</span>
      </span>
    );
  return (
    <div>
      <span className="inline-list">
        <Tag tone="bad">有软件包没有装上</Tag>
        <span className="small muted">{fmtRelative(status.at)}</span>
      </span>
      {status.missing?.length ? <p className="small">没有装上：{status.missing.join("、")}</p> : null}
      {status.error ? <pre className="console-out">{status.error}</pre> : null}
    </div>
  );
}

/**
 * The computer's software list: Debian packages the platform installs (when missing) whenever the computer
 * starts, so they come back after a reset. Its roles change the list too; what they install without listing
 * it is gone after a reset.
 */
export function SoftwareTab({ inst, onChanged }: { inst: Instance; onChanged: (i: Instance) => void }) {
  const { can } = useAuth();
  const manage = can("instance.manage");
  const { run, busy } = useAction();
  const saved = inst.software.join("\n");
  const [draft, setDraft] = useState(saved);
  // Follows changes made elsewhere (a role editing the list) without dropping an edit in progress here.
  useEffect(() => setDraft(saved), [saved]);
  const dirty = fromText(draft).join("\n") !== saved;

  const save = async (): Promise<boolean> => {
    const out = await run(
      () => api.patch<Instance>(`/api/instances/${inst.id}`, { software: fromText(draft) }),
      "软件清单已保存",
    );
    if (out) onChanged(out);
    return !!out;
  };
  useUnsavedChanges(manage && dirty, save);

  return (
    <Section
      title="软件清单"
      actions={
        manage ? (
          <div className="btn-row">
            <button type="button" className="btn btn-xs" disabled={busy || !dirty} onClick={() => void save()}>
              保存
            </button>
            <button
              type="button"
              className="btn btn-xs"
              disabled={busy || dirty || !inst.software.length || inst.status !== "running"}
              title={inst.status !== "running" ? "虚拟电脑运行时才能安装" : undefined}
              onClick={() =>
                void run(() => api.post(`/api/instances/${inst.id}/software/install`), "开始按软件清单安装")
              }
            >
              立即安装
            </button>
          </div>
        ) : null
      }
    >
      <p className="small muted">
        虚拟电脑里的人和 AI 员工都没有 root
        权限，系统软件由平台安装。清单里的软件包在这台虚拟电脑每次启动时自动安装缺少的部分，重置后也会装回。这台电脑上的
        AI 员工也可以修改清单；AI 员工临时安装、没有加入清单的软件，重置后会消失。镜像自带的软件不用填。
      </p>
      <Field label="Debian 软件包" hint="每行一个，与 apt-get install 使用的名称相同，例如 ffmpeg">
        {manage ? (
          <textarea className="mono" rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} />
        ) : inst.software.length ? (
          <span className="inline-list">
            {inst.software.map((p) => (
              <Tag key={p}>{p}</Tag>
            ))}
          </span>
        ) : (
          <span className="muted">（空）</span>
        )}
      </Field>
      <div className="field-label">最近一次自动安装</div>
      {inst.software_status ? (
        <StatusLine status={inst.software_status} />
      ) : (
        <p className="small muted">还没有安装过（清单为空，或虚拟电脑还没有启动）。</p>
      )}
    </Section>
  );
}

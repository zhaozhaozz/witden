import { useState } from "react";
import { api } from "../../api/client";
import type { Connection, Instance, KillSwitch, Topic } from "../../api/types";
import { KILL_SWITCH_EVENT } from "../../Layout";
import { fmtDateTime, fmtRelative } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import { Empty, Field, Loaded, Section, Tag } from "../../ui/kit";

const SCOPES: [KillSwitch["scope"], string][] = [
  ["role", "某位 AI 员工"],
  ["instance", "某台虚拟电脑"],
  ["connection", "某个通讯接入"],
  ["topic", "某个话题"],
  ["task", "某项任务"],
];

const SCOPE_LABEL: Record<string, string> = {
  global: "全部 AI 执行",
  role: "AI 员工",
  instance: "虚拟电脑",
  connection: "通讯接入",
  topic: "话题",
  task: "任务",
};

function tasksPaused(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.length;
  return null;
}

export function EmergencyTab() {
  const { can } = useAuth();
  const dir = useDirectory();
  const { confirm, toast } = useFeedback();
  const { run, busy } = useAction();
  const res = useResource(() => api.get<KillSwitch[]>("/api/kill-switches"), []);
  const instances = useResource(() => api.get<Instance[]>("/api/instances").catch(() => [] as Instance[]), []);
  const topics = useResource(() => api.get<Topic[]>("/api/topics").catch(() => [] as Topic[]), []);
  const connections = useResource(
    () => (can("connection.manage") ? api.get<Connection[]>("/api/connections") : Promise.resolve([] as Connection[])),
    [],
  );
  const [globalReason, setGlobalReason] = useState("");
  const [scope, setScope] = useState<KillSwitch["scope"]>("role");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");

  const targetName = (k: KillSwitch) => {
    if (!k.target_id) return "";
    switch (k.scope) {
      case "role":
        return dir.roleLabel(k.target_id);
      case "instance":
        return instances.data?.find((i) => i.id === k.target_id)?.name ?? k.target_id;
      case "topic":
        return topics.data?.find((t) => t.id === k.target_id)?.title ?? k.target_id;
      case "connection":
        return connections.data?.find((c) => c.id === k.target_id)?.name ?? k.target_id;
      default:
        return k.target_id;
    }
  };

  const engage = async (body: { scope: string; target_id?: string | null; reason: string }) => {
    const out = await run(() => api.post<KillSwitch>("/api/kill-switches", body));
    if (out) {
      const n = tasksPaused(out.tasks_paused);
      toast(`紧急停止已生效${n !== null ? `，暂停了 ${n} 项任务` : ""}`, "ok");
      window.dispatchEvent(new Event(KILL_SWITCH_EVENT));
      void res.reload();
    }
    return out;
  };

  const targetOptions: { value: string; label: string }[] =
    scope === "role"
      ? dir.roles.map((r) => ({ value: r.id, label: `${r.name} @${r.handle}` }))
      : scope === "instance"
        ? (instances.data ?? []).map((i) => ({ value: i.id, label: i.name }))
        : scope === "topic"
          ? (topics.data ?? []).map((t) => ({ value: t.id, label: t.title }))
          : scope === "connection"
            ? (connections.data ?? []).map((c) => ({ value: c.id, label: c.name }))
            : [];

  const active = (res.data ?? []).filter((k) => k.active);
  const globalActive = active.find((k) => k.scope === "global");

  return (
    <div className="emergency">
      <section className={`stop-all${globalActive ? " stop-all-on" : ""}`}>
        <div>
          <h2>{globalActive ? "全部 AI 执行已停止" : "停止全部 AI 执行"}</h2>
          <p>
            {globalActive
              ? `由 ${dir.userName(globalActive.created_by)} 于 ${fmtDateTime(globalActive.created_at)} 触发${globalActive.reason ? `：${globalActive.reason}` : ""}。解除前不会开始任何新的 AI 工作。`
              : "立即暂停所有 AI 员工正在进行的工作，并阻止新的工作开始。虚拟电脑本身不会被关闭，已暂停的任务可以在解除后继续。"}
          </p>
        </div>
        {globalActive ? (
          <button
            type="button"
            className="btn btn-lg"
            disabled={busy}
            onClick={async () => {
              const ok = await confirm({
                title: "解除全局紧急停止",
                body: <p>解除后新的 AI 工作可以开始；已暂停的任务需要逐个继续。</p>,
                confirmLabel: "解除",
              });
              if (!ok) return;
              const out = await run(() => api.post(`/api/kill-switches/${globalActive.id}/release`), "已解除");
              if (out) {
                window.dispatchEvent(new Event(KILL_SWITCH_EVENT));
                void res.reload();
              }
            }}
          >
            解除全局停止
          </button>
        ) : (
          <form
            className="stop-all-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await confirm({
                title: "停止全部 AI 执行",
                body: <p>所有 AI 员工会立即停下手头的工作。确定继续？</p>,
                confirmLabel: "立即停止",
                danger: true,
              });
              if (ok && (await engage({ scope: "global", reason: globalReason.trim() }))) setGlobalReason("");
            }}
          >
            <input
              placeholder="原因（会显示给所有管理员）"
              value={globalReason}
              onChange={(e) => setGlobalReason(e.target.value)}
            />
            <button type="submit" className="btn btn-lg btn-stop" disabled={busy}>
              停止全部 AI
            </button>
          </form>
        )}
      </section>

      <div className="grid-2">
        <Section title="停止部分工作">
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await engage({ scope, target_id: target.trim(), reason: reason.trim() })) {
                setTarget("");
                setReason("");
              }
            }}
          >
            <div className="form-row">
              <Field label="范围">
                <select
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value as KillSwitch["scope"]);
                    setTarget("");
                  }}
                >
                  {SCOPES.map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="对象">
                {scope === "task" || !targetOptions.length ? (
                  <input
                    className="mono"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder={scope === "task" ? "任务 ID" : "ID"}
                  />
                ) : (
                  <select value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">请选择</option>
                    {targetOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <Field label="原因">
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <button type="submit" className="btn btn-danger btn-sm" disabled={busy || !target.trim()}>
              停止
            </button>
          </form>
        </Section>
        <Section title="停止记录">
          <Loaded res={res}>
            {(rows) =>
              rows.length ? (
                <ul className="kill-list">
                  {rows.map((k) => (
                    <li key={k.id} className={k.active ? "kill-on" : undefined}>
                      <div>
                        <strong>{SCOPE_LABEL[k.scope] ?? k.scope}</strong> {targetName(k)}
                        {k.active ? <Tag tone="bad">生效中</Tag> : <Tag tone="off">已解除</Tag>}
                        <div className="small muted">
                          {dir.userName(k.created_by)} · {fmtRelative(k.created_at)}
                          {k.released_at ? ` · ${fmtRelative(k.released_at)}解除` : ""}
                          {k.reason ? ` · ${k.reason}` : ""}
                        </div>
                      </div>
                      {k.active && k.scope !== "global" ? (
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy}
                          onClick={async () => {
                            const out = await run(() => api.post(`/api/kill-switches/${k.id}/release`), "已解除");
                            if (out) {
                              window.dispatchEvent(new Event(KILL_SWITCH_EVENT));
                              void res.reload();
                            }
                          }}
                        >
                          解除
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title="没有触发过紧急停止" />
              )
            }
          </Loaded>
        </Section>
      </div>
    </div>
  );
}

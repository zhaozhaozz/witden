import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import { useLiveEvents } from "../../api/events";
import type {
  ActionPreview,
  Backup,
  ExecResult,
  ExecSession,
  Instance,
  InstanceStats,
  Task,
  Template,
} from "../../api/types";
import { EXEC_SESSION_KIND, fmtBytes, fmtDateTime, fmtRelative, fmtTime } from "../../lib/format";
import { useDebounced, useInterval, useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import {
  badgeColor,
  ColorPicker,
  ComputerBadge,
  Empty,
  Field,
  FormModal,
  Guarded,
  Handle,
  IdText,
  KV,
  Loaded,
  Loading,
  Modal,
  PageHeader,
  RoleBadge,
  Section,
  Tabs,
  Tag,
  Toggle,
} from "../../ui/kit";
import { TaskStatusChip } from "../tasks/taskParts";
import {
  fromDraft,
  InstanceStatusChip,
  Meter,
  ResourceFields,
  RunnerPanel,
  resourceSummary,
  toDraft,
} from "./computerParts";
import { OperatorLabel } from "./InstancesPage";
import { ModelAccessTab } from "./ModelAccessTab";

// noVNC is large; load it only when a desktop screen is actually opened.
const LiveDesktop = lazy(() => import("./LiveDesktop").then((m) => ({ default: m.LiveDesktop })));

type Lifecycle = "start" | "stop" | "restart" | "reset" | "delete";

const ACTION_LABEL: Record<Lifecycle, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
  reset: "重置",
  delete: "删除",
};

export default function InstanceDetailPage() {
  const { instanceId = "" } = useParams();
  const { can } = useAuth();
  const [tab, setTab] = useState("overview");
  const res = useResource(() => api.get<Instance>(`/api/instances/${instanceId}`), [instanceId]);
  const refresh = useDebounced(() => void res.reload(), 300);
  useLiveEvents(can("audit.view") || can("instance.manage") ? { admin: true } : null, (type, data) => {
    if (type.startsWith("instance.") && data.id === instanceId) refresh();
  });
  // Without the admin stream, poll while the computer is changing state.
  const transitional = res.data && ["creating", "deleting"].includes(res.data.status);
  useInterval(() => void res.reload(), 3000, !!transitional);

  return (
    <div className="page">
      <Loaded res={res}>
        {(inst) => {
          const desktop = inst.spec?.kind === "desktop";
          return (
            <>
              <PageHeader
                title={
                  <span className="title-with-avatar">
                    <span className="title-dot" style={{ background: badgeColor(inst.id, inst.color) }} aria-hidden />
                    {inst.name}
                  </span>
                }
                sub={
                  <span className="head-meta">
                    <Link to="/computers">虚拟电脑</Link>
                    <span>/</span>
                    <span>{desktop ? "桌面虚拟电脑" : "命令行虚拟电脑"}</span>
                    <IdText id={inst.id} />
                  </span>
                }
                actions={
                  can("instance.manage") ? (
                    <LifecycleButtons
                      inst={inst}
                      onChanged={(i) => (i ? res.setData((p) => (p ? { ...p, ...i } : p)) : void res.reload())}
                    />
                  ) : null
                }
              />
              <div className={`status-banner${inst.status === "error" ? " status-banner-bad" : ""}`}>
                <InstanceStatusChip inst={inst} compact />
                <div className="status-banner-text">
                  {inst.status_reason ? (
                    <div>{inst.status_reason}</div>
                  ) : (
                    <div className="muted">{statusHint(inst.status)}</div>
                  )}
                  {inst.paused_ai ? <div className="small">AI 工作已暂停：有人接管了这台虚拟电脑。</div> : null}
                </div>
              </div>
              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { key: "overview", label: "概览" },
                  { key: "screen", label: "屏幕", hidden: !desktop },
                  { key: "console", label: "控制台", hidden: !can("instance.control") },
                  { key: "sessions", label: "会话" },
                  { key: "models", label: "模型访问" },
                  { key: "backups", label: "备份与复制", hidden: !can("instance.manage") },
                  { key: "tasks", label: "任务", badge: inst.active_tasks?.length },
                ]}
              />
              {tab === "overview" ? (
                <Overview inst={inst} onChanged={(i) => res.setData(i)} reload={() => void res.reload()} />
              ) : null}
              {tab === "screen" && desktop ? <ScreenTab inst={inst} reload={() => void res.reload()} /> : null}
              {tab === "console" ? <ConsoleTab inst={inst} /> : null}
              {tab === "sessions" ? <SessionsTab inst={inst} /> : null}
              {tab === "models" ? <ModelAccessTab inst={inst} /> : null}
              {tab === "backups" ? <BackupsTab inst={inst} reload={() => void res.reload()} /> : null}
              {tab === "tasks" ? <TasksTab inst={inst} /> : null}
            </>
          );
        }}
      </Loaded>
    </div>
  );
}

// Preview lines come from a fixed set of backend sentences.
const PREVIEW_ZH: [RegExp, (m: RegExpMatchArray) => string][] = [
  [
    /^software installed or files changed outside persistent paths/,
    () => "持久化目录之外安装的软件和改动的文件（容器层）",
  ],
  [
    /^running processes, terminal and browser sessions, desktop state$/,
    () => "运行中的进程、终端和浏览器会话、桌面状态",
  ],
  [/^all data in persistent path (.+)$/, (m) => `持久化目录 ${m[1]} 中的全部数据`],
  [/^data in persistent path (.+)$/, (m) => `持久化目录 ${m[1]} 中的数据`],
  [/^instance name, resource limits and role assignments$/, () => "虚拟电脑名称、资源限制和角色分配"],
  [/^the container and everything in it$/, () => "容器及其中的全部内容"],
  [/^persistent path (.+)$/, (m) => `持久化目录 ${m[1]}`],
  [/^backups are kept until deleted separately$/, () => "已有备份会保留，需要单独删除"],
];

function previewText(s: string): string {
  for (const [re, fn] of PREVIEW_ZH) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  return s;
}

function statusHint(status: string): string {
  switch (status) {
    case "creating":
      return "正在创建容器和存储卷，完成后自动启动。";
    case "running":
      return "虚拟电脑正在运行，分配到这里的角色可以执行任务。";
    case "stopped":
      return "虚拟电脑已停止；分配到这里的任务会等待虚拟电脑启动，不会转到其他虚拟电脑执行。";
    case "deleting":
      return "正在删除。";
    default:
      return "";
  }
}

// --- lifecycle ---------------------------------------------------------------------------------------

function LifecycleButtons({ inst, onChanged }: { inst: Instance; onChanged: (i?: Instance) => void }) {
  const nav = useNavigate();
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const [destructive, setDestructive] = useState<null | "reset" | "delete">(null);

  const act = async (action: Lifecycle, extra: Record<string, unknown> = {}) => {
    const out = await run(
      () => api.post<Instance>(`/api/instances/${inst.id}/actions`, { action, ...extra }),
      `已提交：${ACTION_LABEL[action]}`,
    );
    if (out) {
      if (action === "delete") nav("/computers");
      else onChanged(out);
    }
    return out;
  };

  const running = inst.status === "running";
  const stopped = inst.status === "stopped" || inst.status === "error";
  const activeCount = inst.active_tasks?.length ?? 0;

  return (
    <div className="btn-row">
      {stopped ? (
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act("start")}>
          启动
        </button>
      ) : null}
      {running ? (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act("restart")}>
          重启
        </button>
      ) : null}
      {running ? (
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={async () => {
            const ok = await confirm({
              title: `停止 ${inst.name}`,
              body: (
                <p>
                  停止后，这台虚拟电脑上正在进行的 AI 工作会被中断{activeCount ? `（当前 ${activeCount} 项任务）` : ""}
                  ；持久化目录中的数据会保留。
                </p>
              ),
              confirmLabel: "停止",
              danger: true,
            });
            if (ok) await act("stop");
          }}
        >
          停止
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-sm btn-danger-ghost"
        disabled={busy || inst.status === "deleting"}
        onClick={() => setDestructive("reset")}
      >
        重置
      </button>
      <button
        type="button"
        className="btn btn-sm btn-danger-ghost"
        disabled={busy || inst.status === "deleting"}
        onClick={() => setDestructive("delete")}
      >
        删除
      </button>
      {destructive ? (
        <DestructiveDialog
          inst={inst}
          action={destructive}
          onClose={() => setDestructive(null)}
          onConfirm={async (keepVolumes) => {
            const out = await act(destructive, { confirm: true, keep_volumes: keepVolumes });
            if (out) setDestructive(null);
          }}
          busy={busy}
        />
      ) : null}
    </div>
  );
}

/** Reset / delete: load the server's preview of what will be cleared and kept, then confirm. */
function DestructiveDialog({
  inst,
  action,
  onClose,
  onConfirm,
  busy,
}: {
  inst: Instance;
  action: "reset" | "delete";
  onClose: () => void;
  onConfirm: (keepVolumes: boolean) => void;
  busy: boolean;
}) {
  const [keep, setKeep] = useState(true);
  const preview = useResource(
    () => api.get<ActionPreview>(`/api/instances/${inst.id}/preview/${action}`, { keep_volumes: keep }),
    [inst.id, action, keep],
  );
  const [typed, setTyped] = useState("");
  const needsName = action === "delete" || !keep;

  return (
    <Modal
      title={action === "reset" ? `重置 ${inst.name}` : `删除 ${inst.name}`}
      onClose={onClose}
      width={600}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || !preview.data || (needsName && typed !== inst.name)}
            onClick={() => onConfirm(keep)}
          >
            {busy ? "处理中…" : action === "reset" ? "确认重置" : "确认删除"}
          </button>
        </>
      }
    >
      {action === "reset" ? <Toggle checked={keep} onChange={setKeep} label="保留持久化目录中的数据" /> : null}
      <Loaded res={preview}>
        {(p) => (
          <div className="preview">
            <div className="preview-col preview-clear">
              <h4>会被清除</h4>
              <ul>
                {p.will_clear.map((x) => (
                  <li key={x}>{previewText(x)}</li>
                ))}
              </ul>
            </div>
            {p.will_keep?.length ? (
              <div className="preview-col preview-keep">
                <h4>会保留</h4>
                <ul>
                  {p.will_keep.map((x) => (
                    <li key={x}>{previewText(x)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {p.roles_detached?.length ? (
              <p className="small">
                以下角色将失去虚拟电脑，需要重新分配：
                {p.roles_detached.map((h) => (
                  <Handle key={h} handle={h} />
                ))}
              </p>
            ) : null}
            {p.active_tasks.length ? (
              <p className="small text-bad">有 {p.active_tasks.length} 项进行中的任务会被中断。</p>
            ) : null}
            {p.note ? <p className="small muted">{previewText(p.note)}</p> : null}
          </div>
        )}
      </Loaded>
      {needsName ? (
        <Field label={`输入虚拟电脑名称 ${inst.name} 以确认`}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      ) : null}
    </Modal>
  );
}

// --- overview ----------------------------------------------------------------------------------------

function Overview({
  inst,
  onChanged,
  reload,
}: {
  inst: Instance;
  onChanged: (i: Instance) => void;
  reload: () => void;
}) {
  const { can, me } = useAuth();
  const dir = useDirectory();
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(toDraft(inst.resources));
  const [taking, setTaking] = useState(false);
  const tpl = useResource(() => api.get<Template>(`/api/templates/${inst.template_id}`), [inst.template_id]);
  const stats = useResource(
    () => api.get<InstanceStats>(`/api/instances/${inst.id}/stats`, { volumes: true }),
    [inst.id, inst.status],
  );
  useInterval(() => void stats.reload(), 5000, inst.status === "running");

  const usage = stats.data?.usage;
  const limits = stats.data?.limits ?? inst.resources;
  const scope = inst.shared_scope;
  const op = inst.operator;
  const heldByMe = op?.holder_type === "user" && op.holder_id === me?.id;

  return (
    <div className="grid-2">
      <div>
        <Section title="配置">
          <KV
            items={[
              [
                "模板",
                tpl.data ? (
                  <span>
                    {tpl.data.name}{" "}
                    <span className="muted small">
                      创建时为 v{inst.template_version}，当前 v{tpl.data.version}
                    </span>
                  </span>
                ) : (
                  `v${inst.template_version}`
                ),
              ],
              ["颜色", <InstanceColor key="color" inst={inst} onChanged={(i) => onChanged(i)} />],
              ["镜像", <code className="id">{String(inst.spec?.image ?? "—")}</code>],
              ["工作目录", <code className="id">{String(inst.spec?.workdir ?? "—")}</code>],
              [
                "运行用户",
                <span>
                  <code className="id">{String(inst.spec?.user ?? "witden")}</code>{" "}
                  <span className="muted small">非特权用户，AI 的所有操作都以它的身份执行</span>
                </span>,
              ],
              ["容器", inst.container_id ? <IdText id={inst.container_id} /> : <span className="muted">尚未创建</span>],
              ["最近启动", inst.last_started_at ? fmtDateTime(inst.last_started_at) : null],
              [
                "创建",
                `${fmtDateTime(inst.created_at)}${inst.created_by ? ` · ${dir.userName(inst.created_by)}` : ""}`,
              ],
            ]}
          />
        </Section>

        <Section
          title="资源"
          actions={
            can("instance.manage") && !editing ? (
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => {
                  setDraft(toDraft(inst.resources));
                  setEditing(true);
                }}
              >
                修改限制
              </button>
            ) : null
          }
        >
          <p className="small muted">限制：{resourceSummary(limits)}</p>
          {inst.status === "running" ? (
            usage ? (
              <div className="meters">
                <Meter
                  label="CPU"
                  value={usage.cpu_percent ?? 0}
                  max={(limits.cpus ?? 1) * 100}
                  text={`${(usage.cpu_percent ?? 0).toFixed(1)}%${limits.cpus ? ` / ${limits.cpus} 核` : ""}`}
                />
                <Meter
                  label="内存"
                  value={usage.memory_bytes ?? 0}
                  max={usage.memory_limit_bytes ?? (limits.memory_mb ? limits.memory_mb * 1024 * 1024 : null)}
                  text={`${fmtBytes(usage.memory_bytes)}${
                    usage.memory_limit_bytes
                      ? ` / ${fmtBytes(usage.memory_limit_bytes)}`
                      : limits.memory_mb
                        ? ` / ${fmtBytes(limits.memory_mb * 1024 * 1024)}`
                        : ""
                  }`}
                />
                <Meter
                  label="进程"
                  value={usage.pids ?? 0}
                  max={limits.pids_limit}
                  text={`${usage.pids ?? "—"}${limits.pids_limit ? ` / ${limits.pids_limit}` : ""}`}
                />
                {usage.net_rx_bytes !== undefined ? (
                  <Meter
                    label="网络"
                    value={0}
                    text={`收 ${fmtBytes(usage.net_rx_bytes)} · 发 ${fmtBytes(usage.net_tx_bytes)}`}
                  />
                ) : null}
                {usage.block_read_bytes !== undefined ? (
                  <Meter
                    label="磁盘读写"
                    value={0}
                    text={`读 ${fmtBytes(usage.block_read_bytes)} · 写 ${fmtBytes(usage.block_write_bytes)}`}
                  />
                ) : null}
              </div>
            ) : stats.error ? (
              <p className="small text-bad">{stats.error}</p>
            ) : (
              <p className="small muted">正在读取实际占用…</p>
            )
          ) : (
            <p className="small muted">虚拟电脑未运行，没有实时占用数据。</p>
          )}
          {stats.data?.volumes && Object.keys(stats.data.volumes).length ? (
            <div className="volume-list">
              {Object.entries(inst.volumes).map(([path, vol]) => (
                <div key={path} className="small">
                  <code className="id">{path}</code> 占用 {fmtBytes(stats.data?.volumes?.[vol])}
                </div>
              ))}
            </div>
          ) : null}
          {editing ? (
            <FormModal
              title="修改资源限制"
              busy={busy}
              onClose={() => setEditing(false)}
              onSubmit={async () => {
                const out = await run(
                  () => api.patch<Instance>(`/api/instances/${inst.id}/resources`, { resources: fromDraft(draft) }),
                  "已保存。新的限制在下次重置虚拟电脑后生效",
                );
                if (out) {
                  setEditing(false);
                  reload();
                }
              }}
            >
              <ResourceFields value={draft} onChange={setDraft} />
              <p className="small muted">
                新限制在重置虚拟电脑（重新创建容器）后才会生效，保存不会中断正在进行的工作。
              </p>
            </FormModal>
          ) : null}
        </Section>
      </div>

      <div>
        <Section title="Runner">
          <p className="small muted">
            Runner 是虚拟电脑里的执行代理：AI 的每个操作、控制台命令和实时画面都经由它进入这台虚拟电脑。
          </p>
          <RunnerPanel inst={inst} />
        </Section>

        <Section title="当前操作者">
          <div className="operator">
            <OperatorLabel inst={inst} />
            {op ? (
              <div className="small muted">
                {op.reason ? `原因：${op.reason} · ` : ""}
                {op.task_id ? (
                  <>
                    <Link to={`/tasks/${op.task_id}`}>相关任务</Link> ·{" "}
                  </>
                ) : null}
                租约 {fmtRelative(op.expires_at)}到期
              </div>
            ) : (
              <div className="small muted">
                没有人占用鼠标和键盘。同一时间只有一个操作者，避免多个角色或人同时操作造成冲突。
              </div>
            )}
          </div>
          {can("instance.control") ? (
            <div className="btn-row">
              {heldByMe ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={async () => {
                    const out = await run(
                      () => api.post<Instance>(`/api/instances/${inst.id}/handback`),
                      "已交还控制，AI 工作恢复",
                    );
                    if (out) onChanged(out);
                  }}
                >
                  交还控制
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || inst.status !== "running"}
                  onClick={() => setTaking(true)}
                >
                  接管虚拟电脑
                </button>
              )}
              {!heldByMe && op?.holder_type === "user" && me?.is_admin ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger-ghost"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "强制结束接管",
                      body: (
                        <p>
                          {dir.userName(op.holder_id)} 正在操作这台虚拟电脑。结束接管后，AI
                          工作会恢复，对方将失去鼠标和键盘控制。
                        </p>
                      ),
                      confirmLabel: "结束接管",
                      danger: true,
                    });
                    if (!ok) return;
                    const out = await run(
                      () => api.post<Instance>(`/api/instances/${inst.id}/handback`),
                      "已结束接管，AI 工作恢复",
                    );
                    if (out) onChanged(out);
                  }}
                >
                  强制结束接管
                </button>
              ) : null}
            </div>
          ) : null}
          {taking ? (
            <TakeoverDialog
              inst={inst}
              onClose={() => setTaking(false)}
              onDone={(i) => (setTaking(false), onChanged(i))}
            />
          ) : null}
        </Section>

        <Section title="共享范围">
          <p className="small">
            这台虚拟电脑上的所有角色共享文件、已安装的软件和登录状态。需要互相保密的工作应放到不同的虚拟电脑上，而不是只靠不同的角色提示词区分。
          </p>
          <KV
            items={[
              [
                "使用它的角色",
                inst.roles.length ? (
                  <span className="inline-list">
                    {inst.roles.map((r) => (
                      <span key={r.id} className="badge-row">
                        <RoleBadge role={r} />
                        {r.status === "disabled" ? <Tag tone="off">已停用</Tag> : null}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="muted">没有角色</span>
                ),
              ],
              ["用户目录", scope?.home ? <code className="id">{scope.home}</code> : null],
              [
                "持久化目录",
                scope?.persistent_paths.length ? (
                  <span className="inline-list">
                    {scope.persistent_paths.map((p) => (
                      <code key={p} className="id">
                        {p}
                      </code>
                    ))}
                  </span>
                ) : (
                  <span className="muted">无（重启后容器内改动可能丢失）</span>
                ),
              ],
              [
                "凭据与登录状态",
                scope?.credential_paths.length ? (
                  <span className="inline-list">
                    {scope.credential_paths.map((p) => (
                      <code key={p} className="id">
                        {p}
                      </code>
                    ))}
                  </span>
                ) : null,
              ],
            ]}
          />
          <p className="small muted">凭据目录在复制虚拟电脑时默认不会带到新虚拟电脑。</p>
        </Section>
      </div>
    </div>
  );
}

function TakeoverDialog({
  inst,
  onClose,
  onDone,
}: {
  inst: Instance;
  onClose: () => void;
  onDone: (i: Instance) => void;
}) {
  const { run, busy } = useAction();
  const [reason, setReason] = useState("");
  const count = inst.active_tasks?.length ?? 0;
  return (
    <FormModal
      title={`接管 ${inst.name}`}
      submitLabel="接管"
      busy={busy}
      onClose={onClose}
      onSubmit={async () => {
        const out = await run(
          () => api.post<Instance>(`/api/instances/${inst.id}/takeover`, { reason: reason.trim() || null }),
          "你已接管这台虚拟电脑，AI 工作已暂停",
        );
        if (out) onDone(out);
      }}
    >
      <div className="callout callout-wait">
        接管后，这台虚拟电脑上所有角色的 AI 工作都会暂停{count ? `（当前 ${count} 项任务）` : ""}
        ，直到你交还控制。接管期间，你在浏览器里的鼠标和键盘操作会发送到这台虚拟电脑（不会影响你自己的电脑）。适合完成登录、验证码等需要人工的步骤。
      </div>
      <Field label="原因" hint="会显示给其他人，并记录在审计中。">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：登录企业邮箱" autoFocus />
      </Field>
    </FormModal>
  );
}

// --- screen ------------------------------------------------------------------------------------------

function ScreenTab({ inst, reload }: { inst: Instance; reload: () => void }) {
  const { can, me } = useAuth();
  const dir = useDirectory();
  const { run, busy } = useAction();
  const [taking, setTaking] = useState(false);
  const heldByMe = inst.operator?.holder_type === "user" && inst.operator.holder_id === me?.id;
  const mode: "view" | "control" = heldByMe && can("instance.control") ? "control" : "view";
  const running = inst.status === "running";

  return (
    <div className="screen-tab">
      <Section
        title="实时画面"
        actions={
          can("instance.control") ? (
            heldByMe ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={async () => {
                  const out = await run(
                    () => api.post(`/api/instances/${inst.id}/handback`),
                    "已交还控制，AI 工作恢复",
                  );
                  if (out) reload();
                }}
              >
                交还控制
              </button>
            ) : (
              <button type="button" className="btn btn-sm" disabled={busy || !running} onClick={() => setTaking(true)}>
                接管并操作
              </button>
            )
          ) : null
        }
      >
        <p className="small muted">
          {mode === "control"
            ? "你已接管这台虚拟电脑，画面可操作，AI 工作已暂停。完成后请交还控制。"
            : inst.operator?.holder_type === "user" && !heldByMe
              ? `只读画面：${dir.userName(inst.operator.holder_id)} 正在接管这台虚拟电脑，只有接管人可以操作。`
              : "只读画面：可以观察 AI 的操作。只有接管虚拟电脑的人才能使用鼠标和键盘，接管会暂停这台虚拟电脑上的 AI 工作。"}
        </p>
        {running ? (
          <Suspense fallback={<Loading label="正在加载实时画面组件" />}>
            <LiveDesktop key={mode} instanceId={inst.id} mode={mode} />
          </Suspense>
        ) : (
          <Empty title="虚拟电脑未运行" hint="启动虚拟电脑后可以查看实时画面。" />
        )}
        {taking ? (
          <TakeoverDialog inst={inst} onClose={() => setTaking(false)} onDone={() => (setTaking(false), reload())} />
        ) : null}
      </Section>
      <Screenshot inst={inst} />
    </div>
  );
}

function Screenshot({ inst }: { inst: Instance }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [at, setAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const current = useRef<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const blob = await api.blob(`/api/instances/${inst.id}/screenshot`);
      const next = URL.createObjectURL(blob);
      if (current.current) URL.revokeObjectURL(current.current);
      current.current = next;
      setUrl(next);
      setAt(new Date());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );
  useInterval(() => void load(), 5000, auto && inst.status === "running");

  return (
    <Section
      title="截图"
      actions={
        <div className="btn-row">
          <Toggle checked={auto} onChange={setAuto} label="每 5 秒刷新" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading || inst.status !== "running"}
            onClick={() => void load()}
          >
            {loading ? "截取中…" : "截取屏幕"}
          </button>
        </div>
      }
    >
      {error ? <p className="small text-bad">{error}</p> : null}
      {url ? (
        <figure className="shot">
          <img src={url} alt={`${inst.name} 的屏幕截图`} />
          <figcaption className="small muted">截取于 {at ? fmtTime(at.toISOString()) : ""}</figcaption>
        </figure>
      ) : (
        <p className="small muted">实时画面不可用时，可以用截图查看虚拟电脑屏幕。截图不会保存。</p>
      )}
    </Section>
  );
}

// --- console -----------------------------------------------------------------------------------------

interface ConsoleEntry {
  id: number;
  command: string;
  result?: ExecResult;
  error?: string;
  at: Date;
}

function ConsoleTab({ inst }: { inst: Instance }) {
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

// --- exec sessions -----------------------------------------------------------------------------------

function sessionKind(s: ExecSession): string {
  const kind = EXEC_SESSION_KIND[s.kind] ?? s.kind;
  if (s.kind !== "browser") return kind;
  return s.mode === "background" ? `${kind}（后台）` : `${kind}（桌面）`;
}

/** Terminals, browsers and external agents the AI opened in this computer (recorded by the execution gateway). */
function SessionsTab({ inst }: { inst: Instance }) {
  const dir = useDirectory();
  const [openOnly, setOpenOnly] = useState(true);
  const res = useResource(() => api.get<ExecSession[]>(`/api/instances/${inst.id}/sessions`), [inst.id]);
  return (
    <Section
      actions={
        <div className="btn-row">
          <Toggle checked={openOnly} onChange={setOpenOnly} label="只看打开的" />
          <button type="button" className="btn btn-sm" disabled={res.loading} onClick={() => void res.reload()}>
            刷新
          </button>
        </div>
      }
    >
      <p className="small muted">
        桌面浏览器开在这台虚拟电脑的桌面上，实时画面里能看到，接管后可以直接操作；后台浏览器是单独的会话，屏幕上看不到。终端在后台运行。
        虚拟电脑停止、重启、重置或恢复后，其中的会话都会标记为已关闭。
      </p>
      <Loaded res={res}>
        {(all) => {
          const rows = openOnly ? all.filter((s) => s.status === "open") : all;
          if (!rows.length)
            return (
              <Empty title={openOnly ? "没有打开的会话" : "还没有会话"} hint="角色打开终端或浏览器后会出现在这里。" />
            );
          return (
            <table className="table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>内容</th>
                  <th>角色与任务</th>
                  <th>状态</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className={s.status === "open" ? undefined : "row-muted"}>
                    <td className="nowrap">
                      {s.kind === "browser" ? (
                        <Tag tone={s.mode === "background" ? undefined : "accent"}>{sessionKind(s)}</Tag>
                      ) : (
                        sessionKind(s)
                      )}
                    </td>
                    <td>
                      <code className="id break">{s.title || "—"}</code>
                      <div className="small muted">
                        会话 <code className="id">{s.runner_session_id}</code>
                      </div>
                    </td>
                    <td>
                      {s.role_id ? dir.roleLabel(s.role_id) : <span className="muted">—</span>}
                      {s.task_id ? (
                        <div className="small">
                          <Link to={`/tasks/${s.task_id}`}>查看任务</Link>
                        </div>
                      ) : null}
                    </td>
                    <td>{s.status === "open" ? <Tag tone="ok">打开</Tag> : <Tag tone="off">已关闭</Tag>}</td>
                    <td
                      className="nowrap"
                      title={`打开于 ${fmtDateTime(s.created_at)}，更新于 ${fmtDateTime(s.updated_at)}`}
                    >
                      {fmtRelative(s.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }}
      </Loaded>
    </Section>
  );
}

// --- backups & clone ---------------------------------------------------------------------------------

function BackupsTab({ inst, reload }: { inst: Instance; reload: () => void }) {
  const { can } = useAuth();
  const dir = useDirectory();
  const nav = useNavigate();
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const backups = useResource(() => api.get<Backup[]>(`/api/instances/${inst.id}/backups`), [inst.id]);
  const [note, setNote] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneName, setCloneName] = useState(`${inst.name}-copy`);
  const [withCreds, setWithCreds] = useState(false);
  const inProgress = (b: Backup) => b.status === "running";
  useInterval(() => void backups.reload(), 5000, !!backups.data?.some(inProgress));

  return (
    <div className="grid-2">
      <Section title="备份">
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const out = await run(
              () => api.post<Backup>(`/api/instances/${inst.id}/backups`, { note: note.trim() || null }),
              "备份已开始",
            );
            if (out) {
              setNote("");
              void backups.reload();
            }
          }}
        >
          <input placeholder="备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !inst.container_id}>
            创建备份
          </button>
        </form>
        <p className="small muted">备份包含容器环境和持久化目录（含凭据），恢复会替换当前容器和数据。</p>
        <Loaded res={backups}>
          {(rows) =>
            rows.length ? (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>备注</th>
                    <th>大小</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.id}>
                      <td className="nowrap" title={fmtDateTime(b.created_at)}>
                        {fmtTime(b.created_at)}
                        <div className="small muted">{dir.userName(b.created_by)}</div>
                      </td>
                      <td>
                        {b.note ?? <span className="muted">—</span>}
                        {b.includes_credentials ? <div className="small muted">含凭据</div> : null}
                      </td>
                      <td className="nowrap">
                        {b.status === "complete" ? (
                          fmtBytes(b.size_bytes)
                        ) : inProgress(b) ? (
                          <span className="muted">进行中</span>
                        ) : (
                          <span className="text-bad">失败</span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-xs btn-danger-ghost"
                          disabled={busy || b.status !== "complete"}
                          title={b.status !== "complete" ? "只能从已完成的备份恢复" : undefined}
                          onClick={async () => {
                            const ok = await confirm({
                              title: "从备份恢复",
                              body: (
                                <>
                                  <p>
                                    恢复会用 {fmtDateTime(b.created_at)}{" "}
                                    的备份替换当前容器和持久化数据，之后的改动会丢失。
                                  </p>
                                  <p>这台虚拟电脑上进行中的 AI 工作会被中断。</p>
                                </>
                              ),
                              confirmLabel: "恢复",
                              danger: true,
                            });
                            if (!ok) return;
                            const out = await run(
                              () => api.post(`/api/instances/${inst.id}/restore`, { backup_id: b.id, confirm: true }),
                              "正在从备份恢复",
                            );
                            if (out) reload();
                          }}
                        >
                          恢复
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty title="还没有备份" />
            )
          }
        </Loaded>
      </Section>
      <Section title="复制为新虚拟电脑">
        <p className="small">
          复制当前环境（软件、文件）到一台新虚拟电脑。账号凭据、私密文件和浏览器登录状态默认不会被复制。
        </p>
        <button type="button" className="btn btn-sm" onClick={() => setCloning(true)}>
          复制虚拟电脑
        </button>
        {cloning ? (
          <FormModal
            title={`复制 ${inst.name}`}
            submitLabel="开始复制"
            busy={busy}
            disabled={!/^[a-z0-9][a-z0-9-]{1,62}$/.test(cloneName)}
            onClose={() => setCloning(false)}
            onSubmit={async () => {
              const out = await run(
                () =>
                  api.post<Instance>(`/api/instances/${inst.id}/clone`, {
                    name: cloneName,
                    include_credentials: withCreds,
                  }),
                "正在复制，新虚拟电脑会在完成后出现",
              );
              if (out) {
                setCloning(false);
                nav(`/computers/${out.id}`);
              }
            }}
          >
            <Field label="新虚拟电脑名称" hint="小写字母、数字和短横线">
              <input value={cloneName} onChange={(e) => setCloneName(e.target.value.toLowerCase())} />
            </Field>
            <Toggle
              checked={withCreds}
              onChange={setWithCreds}
              disabled={!can("secrets.manage")}
              label="同时复制凭据和登录状态（需要「管理模型与密钥」权限）"
            />
            {withCreds ? (
              <div className="callout callout-bad">
                新虚拟电脑上的所有角色都将能使用原虚拟电脑的账号和登录状态。只有确实需要时才勾选。
              </div>
            ) : null}
          </FormModal>
        ) : null}
      </Section>
    </div>
  );
}

// --- tasks -------------------------------------------------------------------------------------------

function TasksTab({ inst }: { inst: Instance }) {
  const dir = useDirectory();
  const res = useResource(
    () =>
      api.get<Pick<Task, "id" | "title" | "status" | "owner_role_id" | "topic_id" | "progress" | "updated_at">[]>(
        `/api/instances/${inst.id}/tasks`,
      ),
    [inst.id],
  );
  return (
    <Section>
      {inst.waiting_tasks?.length ? (
        <div className="callout callout-wait">
          {inst.waiting_tasks.length} 项任务正在等待这台虚拟电脑可用；它们不会转到其他虚拟电脑执行。
        </div>
      ) : null}
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th>角色</th>
                  <th>更新</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link to={`/tasks/${t.id}`}>
                        <Guarded text={t.title} label="受限任务" />
                      </Link>
                      {t.progress ? <div className="small task-progress">{t.progress}</div> : null}
                    </td>
                    <td>
                      <TaskStatusChip status={t.status} compact />
                    </td>
                    <td>{dir.roleLabel(t.owner_role_id)}</td>
                    <td className="nowrap">{fmtRelative(t.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="这台虚拟电脑还没有执行过任务" />
          )
        }
      </Loaded>
    </Section>
  );
}

/** The computer's badge colour; people who manage it change it in place. */
function InstanceColor({ inst, onChanged }: { inst: Instance; onChanged: (i: Instance) => void }) {
  const { can } = useAuth();
  const { run, busy } = useAction();
  if (!can("instance.manage")) return <ComputerBadge computer={inst} />;
  return (
    <span className="badge-row">
      <ComputerBadge computer={inst} />
      <ColorPicker
        value={inst.color}
        disabled={busy}
        onChange={async (color) => {
          const out = await run(() => api.patch<Instance>(`/api/instances/${inst.id}`, { color }), "已更新颜色");
          if (out) onChanged(out);
        }}
      />
    </span>
  );
}

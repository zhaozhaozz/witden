import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../../api/client";
import type {
  AgentSession,
  Instance,
  KnowledgeSpace,
  Memory,
  ModelConfig,
  Role,
  RoleImpact,
  Runtime,
  RuntimeConfig,
  ToolGroup,
} from "../../api/types";
import {
  fmtNumber,
  fmtRelative,
  genericStatus,
  instanceStatus,
  linesToList,
  RUNTIME_LABEL,
  TOOL_GROUP_LABEL,
} from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import {
  Avatar,
  Capability,
  Empty,
  ErrorNote,
  Field,
  FieldGroup,
  FormModal,
  Handle,
  Loaded,
  Loading,
  MultiPick,
  PageHeader,
  Section,
  StatusChip,
  Tag,
  Toggle,
} from "../../ui/kit";
import { ResizeHandle } from "../../ui/resize";
import { AgentSessionList } from "../sessionParts";
import { fieldLabel, ImpactView, translateWarning } from "./roleParts";

interface Draft {
  name: string;
  handle: string;
  avatar_url: string;
  description: string;
  system_prompt: string;
  model_config_id: string;
  model_params: string;
  instance_id: string;
  runtime: Runtime;
  // External runtime: runtime_config split into fields; keys the editor does not know are kept as-is.
  rt_command: string;
  rt_cwd: string;
  rt_env: string;
  rt_timeout: string;
  rt_extra: Record<string, unknown>;
  allowed_tools: string[];
  any_contact: boolean;
  allowed_contacts: string[];
  knowledge_space_ids: string[];
  approval_required: string[];
  response_mode: "mention" | "active";
  max_steps: string;
  max_tokens_per_task: string;
  daily_token_limit: string;
}

function toDraft(r: Role | null): Draft {
  const { command, cwd, env, timeout_minutes, ...extra } = r?.runtime_config ?? {};
  return {
    name: r?.name ?? "",
    handle: r?.handle ?? "",
    avatar_url: r?.avatar_url ?? "",
    description: r?.description ?? "",
    system_prompt: r?.system_prompt ?? "",
    model_config_id: r?.model_config_id ?? "",
    model_params: r?.model_params && Object.keys(r.model_params).length ? JSON.stringify(r.model_params, null, 2) : "",
    instance_id: r?.instance_id ?? "",
    runtime: r?.runtime === "external" ? "external" : "witden",
    rt_command: typeof command === "string" ? command : "",
    rt_cwd: typeof cwd === "string" ? cwd : "",
    rt_env: Object.entries(env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    rt_timeout: timeout_minutes != null ? String(timeout_minutes) : "",
    rt_extra: extra,
    allowed_tools: r?.allowed_tools ?? [],
    any_contact: (r?.allowed_contacts ?? []).includes("*"),
    allowed_contacts: (r?.allowed_contacts ?? []).filter((c) => c !== "*"),
    knowledge_space_ids: r?.knowledge_space_ids ?? [],
    approval_required: r?.approval_required ?? [],
    response_mode: r?.response_mode ?? "mention",
    max_steps: r?.max_steps?.toString() ?? "",
    max_tokens_per_task: r?.max_tokens_per_task?.toString() ?? "",
    daily_token_limit: r?.daily_token_limit?.toString() ?? "",
  };
}

const num = (s: string) => (s.trim() ? Number(s) : null);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function runtimeConfig(d: Draft): RuntimeConfig {
  const env: Record<string, string> = {};
  for (const line of linesToList(d.rt_env)) {
    const i = line.indexOf("=");
    const key = i > 0 ? line.slice(0, i).trim() : "";
    if (!ENV_KEY.test(key)) throw new Error(`环境变量格式应为 KEY=VALUE：${line}`);
    env[key] = line.slice(i + 1);
  }
  const out: RuntimeConfig = { ...d.rt_extra };
  if (d.rt_command.trim()) out.command = d.rt_command.trim();
  if (d.rt_cwd.trim()) out.cwd = d.rt_cwd.trim();
  if (Object.keys(env).length) out.env = env;
  if (d.rt_timeout.trim()) out.timeout_minutes = Number(d.rt_timeout);
  return out;
}

/** Throws an Error with a readable message when a free-form field does not parse. */
function toBody(d: Draft): Record<string, unknown> {
  let modelParams: unknown = {};
  if (d.model_params.trim()) {
    try {
      modelParams = JSON.parse(d.model_params);
    } catch {
      throw new Error("模型参数不是有效的 JSON");
    }
  }
  return {
    name: d.name.trim(),
    handle: d.handle.trim().toLowerCase(),
    avatar_url: d.avatar_url.trim() || null,
    description: d.description,
    system_prompt: d.system_prompt,
    model_config_id: d.model_config_id || null,
    model_params: modelParams,
    instance_id: d.instance_id || null,
    runtime: d.runtime,
    runtime_config: runtimeConfig(d),
    allowed_tools: d.allowed_tools,
    allowed_contacts: d.any_contact ? ["*"] : d.allowed_contacts,
    knowledge_space_ids: d.knowledge_space_ids,
    approval_required: d.approval_required,
    response_mode: d.response_mode,
    max_steps: num(d.max_steps),
    max_tokens_per_task: num(d.max_tokens_per_task),
    daily_token_limit: num(d.daily_token_limit),
  };
}

export default function RoleEditorPage() {
  const { roleId } = useParams();
  const isNew = !roleId;
  const role = useResource(() => api.get<Role>(`/api/roles/${roleId}`), [roleId], !isNew);
  if (!isNew && role.data === undefined) {
    return (
      <div className="page">{role.error ? <ErrorNote error={role.error} onRetry={role.reload} /> : <Loading />}</div>
    );
  }
  return (
    <RoleEditor
      key={roleId ?? "new"}
      role={isNew ? null : (role.data ?? null)}
      reload={() => void role.reload()}
      setRole={(r) => role.setData(r)}
    />
  );
}

function RoleEditor({ role, reload, setRole }: { role: Role | null; reload: () => void; setRole: (r: Role) => void }) {
  const nav = useNavigate();
  const dir = useDirectory();
  const { confirm, toast } = useFeedback();
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<Draft>(() => toDraft(role));
  const [dialog, setDialog] = useState<null | "copy" | "disable">(null);
  const toolGroups = useResource(() => api.get<ToolGroup[]>("/api/roles/tool-groups"), []);
  const models = useResource(() => api.get<ModelConfig[]>("/api/model-configs"), []);
  const instances = useResource(() => api.get<Instance[]>("/api/instances"), []);
  const spaces = useResource(() => api.get<KnowledgeSpace[]>("/api/knowledge-spaces"), []);

  useEffect(() => setDraft(toDraft(role)), [role]);

  const original = useMemo(() => {
    try {
      return role ? toBody(toDraft(role)) : null;
    } catch {
      return null;
    }
  }, [role]);
  let body: Record<string, unknown> | null = null;
  let formError: string | null = null;
  try {
    body = toBody(draft);
  } catch (err) {
    formError = (err as Error).message;
  }
  const changed =
    body && original ? Object.keys(body).filter((k) => JSON.stringify(body![k]) !== JSON.stringify(original[k])) : [];
  const dirty = !role || changed.length > 0;
  const selectedModel =
    models.data?.find((m) => m.id === draft.model_config_id) ??
    (role?.model && role.model.id === draft.model_config_id ? role.model : null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const external = draft.runtime === "external";

  const save = async () => {
    if (!body) return;
    if (!role) {
      const out = await run(() => api.post<Role>("/api/roles", body), "角色已创建");
      if (out) {
        void dir.reload();
        nav(`/roles/${out.id}`, { replace: true });
      }
      return;
    }
    const patch: Record<string, unknown> = Object.fromEntries(changed.map((k) => [k, body![k]]));
    // Behaviour changes on a role with active work need explicit confirmation; moving computers with
    // pinned tasks additionally needs those tasks cancelled. Each refusal carries the impact report.
    const attempt = async (extra: Record<string, unknown>): Promise<Role | undefined> => {
      try {
        return await api.patch<Role>(`/api/roles/${role.id}`, { ...patch, ...extra });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 400) throw err;
        const impact = err.detail.impact as RoleImpact | undefined;
        if (err.code === "confirmation_required") {
          const fields = ((err.detail.changes as string[]) ?? []).map(fieldLabel).join("、");
          const ok = await confirm({
            title: "这个角色有进行中的工作",
            confirmLabel: "确认修改",
            body: (
              <>
                <p>你修改了 {fields || "角色行为"}。进行中的任务会继续使用旧配置，新的工作使用新配置。</p>
                {impact ? <ImpactView impact={impact} /> : null}
              </>
            ),
          });
          return ok ? attempt({ ...extra, confirm: true }) : undefined;
        }
        if (err.code === "active_tasks_on_old_instance") {
          const ok = await confirm({
            title: "需要先处理旧电脑上的任务",
            danger: true,
            confirmLabel: "取消这些任务并更换电脑",
            body: (
              <>
                <p>这些任务已经固定在当前电脑上执行，不会自动转到新电脑。可以等它们完成后再更换，或者现在取消它们。</p>
                {impact ? <ImpactView impact={impact} /> : null}
              </>
            ),
          });
          return ok ? attempt({ ...extra, confirm: true, active_tasks: "cancel" }) : undefined;
        }
        throw err;
      }
    };
    const out = await run(() => attempt({}));
    if (out) {
      toast(`已保存 ${out.result?.changes?.length ?? changed.length} 项修改`, "ok");
      void dir.reload();
      reload();
    }
  };

  const groups = (toolGroups.data ?? []).filter((g) => g.group);
  const alwaysTools = (toolGroups.data ?? []).find((g) => !g.group)?.tools ?? [];
  const approvalOptions = [
    ...groups.map((g) => ({ value: g.group!, label: `整组：${TOOL_GROUP_LABEL[g.group!] ?? g.group}` })),
    ...groups.flatMap((g) =>
      g.tools.map((t) => ({ value: t, label: t, hint: TOOL_GROUP_LABEL[g.group!] ?? g.group! })),
    ),
  ];

  return (
    <div className="page">
      <PageHeader
        title={
          role ? (
            <span className="title-with-avatar">
              <Avatar id={role.id} name={role.name} kind="role" size={30} src={role.avatar_url} />
              {role.name} <Handle handle={role.handle} />
            </span>
          ) : (
            "新建角色"
          )
        }
        sub={
          <span className="head-meta">
            <Link to="/roles">角色</Link>
            {role ? (
              <>
                <span>/</span>
                <StatusChip meta={genericStatus(role.status)} compact />
                <Tag tone={role.runtime === "external" ? "accent" : undefined}>
                  {RUNTIME_LABEL[role.runtime] ?? role.runtime}
                </Tag>
                <span className="muted">配置版本 {role.config_version}</span>
                <span className="muted">今日 {fmtNumber(role.tokens_today ?? 0)} tokens</span>
              </>
            ) : null}
          </span>
        }
        actions={
          role ? (
            <>
              <button type="button" className="btn btn-sm" onClick={() => setDialog("copy")}>
                复制到其他电脑
              </button>
              {role.status === "active" ? (
                <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => setDialog("disable")}>
                  停用
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    const out = await run(() => api.post<Role>(`/api/roles/${role.id}/enable`), "角色已启用");
                    if (out) reload();
                  }}
                >
                  启用
                </button>
              )}
            </>
          ) : null
        }
      />

      {role?.warnings?.length ? (
        <div className="callout callout-bad">
          <strong>这个角色现在无法正常工作：</strong>
          <ul>
            {role.warnings.map((w) => (
              <li key={w}>{translateWarning(w)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="editor-layout">
        <ResizeHandle name="role-editor" side="end" min={260} max={640} />
        <form
          className="form editor-main"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Section title="身份">
            <div className="form-row">
              <Field label="名称">
                <input
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="例如：开发工程师"
                />
              </Field>
              <Field label="@ 名称" hint="小写字母、数字、_ . -，最多 32 个字符；在话题中用 @名称 呼叫">
                <input
                  className="mono"
                  value={draft.handle}
                  onChange={(e) => set("handle", e.target.value.toLowerCase())}
                  placeholder="dev"
                />
              </Field>
              <Field label="头像地址" hint="可选">
                <input value={draft.avatar_url} onChange={(e) => set("avatar_url", e.target.value)} />
              </Field>
            </div>
            <Field label="职责说明" hint="成员在邀请、私信时看到的介绍">
              <textarea rows={2} value={draft.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
          </Section>

          <Section title="工作方式">
            <Field label="提示词" hint="职责、工作规则、沟通方式与行为约束。权限限制由系统执行，不依赖提示词。">
              <textarea
                className="prompt"
                rows={10}
                value={draft.system_prompt}
                onChange={(e) => set("system_prompt", e.target.value)}
              />
            </Field>
            <FieldGroup label="在话题中的参与方式">
              <div className="radio-row">
                <label className="check">
                  <input
                    type="radio"
                    checked={draft.response_mode === "mention"}
                    onChange={() => set("response_mode", "mention")}
                  />
                  只在被 @ 时响应
                </label>
                <label className="check">
                  <input
                    type="radio"
                    checked={draft.response_mode === "active"}
                    onChange={() => set("response_mode", "active")}
                  />
                  在加入的话题中持续参与
                </label>
              </div>
            </FieldGroup>
          </Section>

          <Section title="运行方式">
            <div
              className="pick"
              role="radiogroup"
              aria-label="运行方式"
              style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", maxHeight: "none" }}
            >
              {(
                [
                  [
                    "witden",
                    "平台智能体",
                    "平台在电脑之外运行智能体循环：用下面选定的模型思考，再通过工具在所属电脑里执行命令、读写文件、操作桌面和浏览器。每一步都受工具范围和审批约束，并记录在任务日志里。",
                  ],
                  [
                    "external",
                    "外部智能体",
                    "在角色的电脑里启动一个第三方智能体命令行程序，由它自己完成任务。它使用自己的模型和凭据，平台负责启动、记录输出、超时和停止。",
                  ],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className={`pick-item${draft.runtime === value ? " pick-on" : ""}`}>
                  <input
                    type="radio"
                    name="runtime"
                    checked={draft.runtime === value}
                    onChange={() => set("runtime", value)}
                  />
                  <span className="pick-text">
                    <strong>{label}</strong>
                    <span className="pick-hint">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {external ? (
              <>
                <div className="callout callout-wait">
                  命令在所属电脑里以电脑的非特权用户身份通过 <code>/bin/sh -c</code>{" "}
                  执行。任务说明（角色提示词和这次的要求）写入它的标准输入；输出的结尾部分作为结果发回话题，退出码不为 0
                  时任务失败。下方的工具范围和逐项审批不约束外部程序在电脑内的操作，它能做的事以这台电脑本身的边界为准。
                </div>
                <Field label="启动命令" hint="必填。从标准输入读取任务说明，结果输出到标准输出。">
                  <textarea
                    className="mono"
                    rows={2}
                    value={draft.rt_command}
                    onChange={(e) => set("rt_command", e.target.value)}
                    placeholder="my-agent --non-interactive"
                  />
                </Field>
                <div className="form-row">
                  <Field label="工作目录" hint="可选；默认是电脑的工作目录，可用 ~/ 开头">
                    <input
                      className="mono"
                      value={draft.rt_cwd}
                      onChange={(e) => set("rt_cwd", e.target.value)}
                      placeholder="~/project"
                    />
                  </Field>
                  <Field label="超时（分钟）" hint="可选；默认 60 分钟，超时后停止并标记失败">
                    <input
                      type="number"
                      min={1}
                      value={draft.rt_timeout}
                      onChange={(e) => set("rt_timeout", e.target.value)}
                    />
                  </Field>
                </div>
                <Field
                  label="环境变量"
                  hint="可选；每行 KEY=VALUE。会以明文保存在角色配置中，密钥更适合放在电脑的凭据目录里。"
                >
                  <textarea
                    className="mono"
                    rows={3}
                    value={draft.rt_env}
                    onChange={(e) => set("rt_env", e.target.value)}
                  />
                </Field>
              </>
            ) : null}
          </Section>

          <Section title="模型与电脑">
            <div className="form-row">
              <Field
                label="模型配置"
                hint={external ? "外部智能体不使用这里的模型；切回平台智能体时才会用到。" : undefined}
              >
                <select value={draft.model_config_id} onChange={(e) => set("model_config_id", e.target.value)}>
                  <option value="">未配置</option>
                  {(models.data ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}（{m.model}）
                    </option>
                  ))}
                  {role?.model && !(models.data ?? []).some((m) => m.id === role.model!.id) ? (
                    <option value={role.model.id}>{role.model.name}</option>
                  ) : null}
                </select>
              </Field>
              <Field label="所属电脑" hint="角色执行任务时只能操作这台电脑">
                <select value={draft.instance_id} onChange={(e) => set("instance_id", e.target.value)}>
                  <option value="">未分配（只能对话）</option>
                  {(instances.data ?? []).map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}（{i.spec?.kind === "desktop" ? "桌面" : "命令行"} · {instanceStatus(i.status).label}）
                    </option>
                  ))}
                  {role?.instance && !(instances.data ?? []).some((i) => i.id === role.instance!.id) ? (
                    <option value={role.instance.id}>{role.instance.name}</option>
                  ) : null}
                </select>
              </Field>
            </div>
            {selectedModel && !external ? (
              <div className="caps">
                <Capability
                  label="对话"
                  value={selectedModel.capabilities?.chat}
                  error={selectedModel.capabilities?.errors?.chat}
                  falseLabel="不可用"
                />
                <Capability
                  label="工具调用"
                  value={selectedModel.capabilities?.tools}
                  error={selectedModel.capabilities?.errors?.tools}
                />
                <Capability
                  label="图像理解"
                  value={selectedModel.capabilities?.vision}
                  error={selectedModel.capabilities?.errors?.vision}
                />
              </div>
            ) : null}
            {role && draft.instance_id !== (role.instance_id ?? "") ? (
              <div className="callout callout-wait">
                更换电脑不会迁移文件、已安装的软件和登录状态。已固定在旧电脑上的任务需要等它们完成或取消。
              </div>
            ) : null}
            <Field label="模型参数（JSON，可选）" hint='例如 {"temperature": 0.2}'>
              <textarea
                className="mono"
                rows={3}
                value={draft.model_params}
                onChange={(e) => set("model_params", e.target.value)}
              />
            </Field>
          </Section>

          <Section title="能力范围">
            {external ? (
              <p className="small muted">
                以下设置作用于平台智能体；角色使用外部智能体时，它们不限制外部程序在电脑内的操作。
              </p>
            ) : null}
            <FieldGroup
              label="允许使用的工具"
              hint={alwaysTools.length ? `始终可用：${alwaysTools.join("、")}` : undefined}
            >
              <Loaded res={toolGroups}>
                {() => (
                  <MultiPick
                    columns={2}
                    options={groups.map((g) => ({
                      value: g.group!,
                      label: TOOL_GROUP_LABEL[g.group!] ?? g.group!,
                      hint: g.tools.join("、"),
                    }))}
                    value={draft.allowed_tools}
                    onChange={(v) => set("allowed_tools", v)}
                  />
                )}
              </Loaded>
            </FieldGroup>
            <FieldGroup label="每次使用都需要人工批准" hint="角色不能批准自己的请求；审批人由「审批」权限决定。">
              <MultiPick
                columns={3}
                options={approvalOptions}
                value={draft.approval_required}
                onChange={(v) => set("approval_required", v)}
              />
            </FieldGroup>
            <FieldGroup label="可以联系、委托的角色">
              <Toggle checked={draft.any_contact} onChange={(v) => set("any_contact", v)} label="任意角色" />
              {!draft.any_contact ? (
                <MultiPick
                  columns={3}
                  options={dir.roles
                    .filter((r) => r.id !== role?.id)
                    .map((r) => ({ value: r.id, label: `${r.name} @${r.handle}` }))}
                  value={draft.allowed_contacts}
                  onChange={(v) => set("allowed_contacts", v)}
                  empty="没有其他角色"
                />
              ) : null}
            </FieldGroup>
            <FieldGroup label="可读取的知识空间">
              <MultiPick
                columns={3}
                options={(spaces.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
                value={draft.knowledge_space_ids}
                onChange={(v) => set("knowledge_space_ids", v)}
                empty="还没有知识空间（在「管理 → 知识」中创建）"
              />
            </FieldGroup>
          </Section>

          <Section title="限额">
            <div className="form-row">
              <Field label="单个任务最多步数" hint="留空使用系统上限">
                <input
                  type="number"
                  min={1}
                  value={draft.max_steps}
                  onChange={(e) => set("max_steps", e.target.value)}
                />
              </Field>
              <Field label="单个任务 token 上限">
                <input
                  type="number"
                  min={1}
                  value={draft.max_tokens_per_task}
                  onChange={(e) => set("max_tokens_per_task", e.target.value)}
                />
              </Field>
              <Field label="每日 token 上限">
                <input
                  type="number"
                  min={1}
                  value={draft.daily_token_limit}
                  onChange={(e) => set("daily_token_limit", e.target.value)}
                />
              </Field>
            </div>
          </Section>

          <div className="sticky-actions">
            {formError ? <span className="small text-bad">{formError}</span> : null}
            {role && changed.length ? (
              <span className="small muted">已修改：{changed.map(fieldLabelAll).join("、")}</span>
            ) : null}
            <button type="button" className="btn" disabled={!dirty} onClick={() => setDraft(toDraft(role))}>
              还原
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !dirty || !!formError || !draft.name.trim() || !draft.handle.trim()}
            >
              {busy ? "保存中…" : role ? "保存修改" : "创建角色"}
            </button>
          </div>
        </form>

        {role ? (
          <aside className="editor-side">
            {role.impact ? (
              <Section title="修改的影响">
                <ImpactView impact={role.impact} />
              </Section>
            ) : null}
            <RoleSessions role={role} />
            <RoleMemories role={role} />
          </aside>
        ) : null}
      </div>

      {role && dialog === "copy" ? (
        <CopyRoleDialog
          role={role}
          instances={instances.data ?? []}
          onClose={() => setDialog(null)}
          onDone={(r) => {
            setDialog(null);
            void dir.reload();
            nav(`/roles/${r.id}`);
          }}
        />
      ) : null}
      {role && dialog === "disable" ? (
        <DisableRoleDialog
          role={role}
          onClose={() => setDialog(null)}
          onDone={(r) => {
            setDialog(null);
            setRole({ ...role, ...r });
            void dir.reload();
          }}
        />
      ) : null}
    </div>
  );
}

const ALL_FIELD_ZH: Record<string, string> = {
  name: "名称",
  handle: "@ 名称",
  avatar_url: "头像",
  description: "职责说明",
  response_mode: "参与方式",
  allowed_contacts: "可联系角色",
  knowledge_space_ids: "知识空间",
  approval_required: "审批要求",
  max_steps: "步数上限",
  max_tokens_per_task: "任务 token 上限",
  daily_token_limit: "每日 token 上限",
};

function fieldLabelAll(f: string): string {
  return ALL_FIELD_ZH[f] ?? fieldLabel(f);
}

function CopyRoleDialog({
  role,
  instances,
  onClose,
  onDone,
}: {
  role: Role;
  instances: Instance[];
  onClose: () => void;
  onDone: (r: Role) => void;
}) {
  const { run, busy } = useAction();
  const [handle, setHandle] = useState(`${role.handle}-2`);
  const [name, setName] = useState(role.name);
  const [instanceId, setInstanceId] = useState("");
  return (
    <FormModal
      title={`复制 ${role.name}`}
      submitLabel="复制角色"
      busy={busy}
      disabled={!handle.trim()}
      onClose={onClose}
      onSubmit={async () => {
        const out = await run(
          () =>
            api.post<Role>(`/api/roles/${role.id}/copy`, {
              handle: handle.trim(),
              name: name.trim() || null,
              instance_id: instanceId || null,
            }),
          "已复制角色",
        );
        if (out) onDone(out);
      }}
    >
      <p className="muted small">
        新角色拥有相同的岗位配置和岗位知识，但身份独立：话题记忆、私信和进行中的任务不会被复制。
      </p>
      <div className="form-row">
        <Field label="名称">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="@ 名称">
          <input className="mono" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} />
        </Field>
      </div>
      <Field label="所属电脑">
        <select value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
          <option value="">稍后分配</option>
          {instances.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </Field>
    </FormModal>
  );
}

function DisableRoleDialog({ role, onClose, onDone }: { role: Role; onClose: () => void; onDone: (r: Role) => void }) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const [onTasks, setOnTasks] = useState("pause");
  const [target, setTarget] = useState("");
  const active = role.impact?.active_tasks ?? [];
  return (
    <FormModal
      title={`停用 ${role.name}`}
      submitLabel="停用角色"
      danger
      busy={busy}
      disabled={onTasks === "reassign" && !target}
      onClose={onClose}
      onSubmit={async () => {
        const out = await run(
          () =>
            api.post<Role>(`/api/roles/${role.id}/disable`, {
              on_tasks: onTasks,
              reassign_to: onTasks === "reassign" ? target : null,
            }),
          "角色已停用",
        );
        if (out) onDone(out);
      }}
    >
      <p>停用后角色不再接受新的工作。它还有 {active.length} 项未完成的任务，需要决定如何处理：</p>
      <div className="check-col">
        <label className="check">
          <input type="radio" checked={onTasks === "pause"} onChange={() => setOnTasks("pause")} />
          暂停，之后可以继续或转交
        </label>
        <label className="check">
          <input type="radio" checked={onTasks === "cancel"} onChange={() => setOnTasks("cancel")} />
          取消
        </label>
        <label className="check">
          <input type="radio" checked={onTasks === "reassign"} onChange={() => setOnTasks("reassign")} />
          转交给其他角色
        </label>
      </div>
      {onTasks === "reassign" ? (
        <Field label="接手的角色" hint="转交会重新检查权限，接手角色在自己的电脑上执行。">
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">选择角色</option>
            {dir.roles
              .filter((r) => r.id !== role.id && r.status === "active")
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} @{r.handle}
                </option>
              ))}
          </select>
        </Field>
      ) : null}
    </FormModal>
  );
}

function RoleSessions({ role }: { role: Role }) {
  const res = useResource(() => api.get<AgentSession[]>(`/api/roles/${role.id}/sessions`), [role.id]);
  return (
    <Section title="会话">
      <p className="small muted">
        角色在每个话题里有一个独立的会话，不同话题的上下文互不共享；这里只列出你能查看的话题。会话笔记是此前交付到话题的结果摘要，角色在同一话题继续工作时会读到。
      </p>
      <Loaded res={res}>{(rows) => <AgentSessionList sessions={rows} by="topic" />}</Loaded>
    </Section>
  );
}

function RoleMemories({ role }: { role: Role }) {
  const { run, busy } = useAction();
  const { confirm } = useFeedback();
  const [text, setText] = useState("");
  const res = useResource(() => api.get<Memory[]>("/api/memories", { scope: "role", role_id: role.id }), [role.id]);
  return (
    <Section title="岗位知识">
      <p className="small muted">
        岗位知识跟随角色，在它参与的所有话题中都可使用；不要写入只属于某个人或某个话题的私密信息。
      </p>
      <form
        className="note-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const m = await run(
            () => api.post<Memory>("/api/memories", { scope: "role", role_id: role.id, content: text.trim() }),
            "已添加",
          );
          if (m) {
            setText("");
            res.setData((p) => [m, ...(p ?? [])]);
          }
        }}
      >
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="例如：发布前必须跑完 make check"
        />
        <button type="submit" className="btn btn-xs btn-primary" disabled={busy || !text.trim()}>
          添加
        </button>
      </form>
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <ul className="memory-list">
              {rows.map((m) => (
                <li key={m.id}>
                  <div className="memory-text">{m.content}</div>
                  <div className="small muted">
                    {m.created_by_type === "role" ? "角色自己记录" : "成员添加"} · {fmtRelative(m.created_at)}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={async () => {
                        if (!(await confirm({ title: "删除这条岗位知识", danger: true, confirmLabel: "删除" }))) return;
                        const ok = await run(() => api.del(`/api/memories/${m.id}`));
                        if (ok) res.setData((p) => p?.filter((x) => x.id !== m.id));
                      }}
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="还没有岗位知识" />
          )
        }
      </Loaded>
    </Section>
  );
}

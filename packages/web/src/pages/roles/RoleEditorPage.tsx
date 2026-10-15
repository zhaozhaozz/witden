import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../../api/client";
import type { AgentSession, Instance, KnowledgeSpace, ModelConfig, Role, RoleImpact, ToolGroup } from "../../api/types";
import { EFFORT_LABEL, effortChoices } from "../../lib/effort";
import { fmtNumber, genericStatus, instanceStatus } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import {
  Avatar,
  Capability,
  ColorPicker,
  ComputerBadge,
  ErrorNote,
  Field,
  FieldGroup,
  FormModal,
  Handle,
  Loaded,
  Loading,
  MultiPick,
  PageHeader,
  RoleBadge,
  Section,
  StatusChip,
  Toggle,
} from "../../ui/kit";
import { ResizeHandle } from "../../ui/resize";
import { AgentSessionList } from "../sessionParts";
import { defaultPermissions, PermissionList } from "./PermissionList";
import { fieldLabel, ImpactView, translateWarning } from "./roleParts";

interface Draft {
  name: string;
  handle: string;
  avatar_url: string;
  color: string | null;
  description: string;
  system_prompt: string;
  model_config_id: string;
  model_params: string;
  /** "" = the model's default. */
  reasoning_effort: string;
  instance_id: string;
  allowed_tools: string[];
  any_contact: boolean;
  allowed_contacts: string[];
  knowledge_space_ids: string[];
  approval_required: string[];
  max_steps: string;
  max_tokens_per_task: string;
  daily_token_limit: string;
}

function toDraft(r: Role | null): Draft {
  return {
    name: r?.name ?? "",
    handle: r?.handle ?? "",
    avatar_url: r?.avatar_url ?? "",
    color: r?.color ?? null,
    description: r?.description ?? "",
    system_prompt: r?.system_prompt ?? "",
    model_config_id: r?.model_config_id ?? "",
    model_params: r?.model_params && Object.keys(r.model_params).length ? JSON.stringify(r.model_params, null, 2) : "",
    reasoning_effort: r?.reasoning_effort ?? "",
    instance_id: r?.instance_id ?? "",
    allowed_tools: r?.allowed_tools ?? [],
    any_contact: (r?.allowed_contacts ?? []).includes("*"),
    allowed_contacts: (r?.allowed_contacts ?? []).filter((c) => c !== "*"),
    knowledge_space_ids: r?.knowledge_space_ids ?? [],
    approval_required: r?.approval_required ?? [],
    max_steps: r?.max_steps?.toString() ?? "",
    max_tokens_per_task: r?.max_tokens_per_task?.toString() ?? "",
    daily_token_limit: r?.daily_token_limit?.toString() ?? "",
  };
}

const num = (s: string) => (s.trim() ? Number(s) : null);
/** The built-in system administrator's defaults: the configuration tools, without asking. */
const ADMIN_DEFAULTS = { allowed: ["config"], approval: [] as string[] };
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
    color: d.color,
    description: d.description,
    system_prompt: d.system_prompt,
    model_config_id: d.model_config_id || null,
    model_params: modelParams,
    reasoning_effort: d.reasoning_effort || null,
    instance_id: d.instance_id || null,
    // Sorted (as the server stores them) so toggling back and forth does not count as a change.
    allowed_tools: [...d.allowed_tools].sort(),
    allowed_contacts: d.any_contact ? ["*"] : d.allowed_contacts,
    knowledge_space_ids: d.knowledge_space_ids,
    approval_required: [...d.approval_required].sort(),
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
  const models = useResource(() => api.get<ModelConfig[]>("/api/models"), []);
  // Models grouped under their providers for the picker; System 1 decision models cannot chat, so no role uses them.
  const modelGroups = useMemo(() => {
    const groups = new Map<string, ModelConfig[]>();
    for (const m of models.data ?? []) {
      if (m.provider?.protocol === "systemone") continue;
      const key = m.provider?.name ?? "";
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    return [...groups.entries()];
  }, [models.data]);
  const instances = useResource(() => api.get<Instance[]>("/api/instances"), []);
  const spaces = useResource(() => api.get<KnowledgeSpace[]>("/api/knowledge-spaces"), []);
  const defaults = useMemo(() => (toolGroups.data ? defaultPermissions(toolGroups.data) : null), [toolGroups.data]);
  // A new role starts from the platform's default permissions (see PermissionList).
  const fresh = (): Draft => {
    const d = toDraft(role);
    return !role && defaults ? { ...d, allowed_tools: defaults.allowed, approval_required: defaults.approval } : d;
  };

  useEffect(() => {
    setDraft(toDraft(role));
  }, [role]);
  const defaultsApplied = useRef(false);
  useEffect(() => {
    if (role || !defaults || defaultsApplied.current) return;
    defaultsApplied.current = true;
    setDraft((d) => ({ ...d, allowed_tools: defaults.allowed, approval_required: defaults.approval }));
  }, [role, defaults]);

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
  const effortFor = (modelId: string) => {
    const m = models.data?.find((x) => x.id === modelId);
    return effortChoices(
      m?.provider?.protocol,
      m?.capabilities ?? (role?.model?.id === modelId ? role.model.capabilities : undefined),
    );
  };
  const effort = effortFor(draft.model_config_id);
  // Another model may not take the chosen level: fall back to its default.
  const pickModel = (id: string) =>
    setDraft((d) => ({
      ...d,
      model_config_id: id,
      reasoning_effort: effortFor(id).levels.includes(d.reasoning_effort) ? d.reasoning_effort : "",
    }));

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
            title: "需要先处理旧虚拟电脑上的任务",
            danger: true,
            confirmLabel: "取消这些任务并更换虚拟电脑",
            body: (
              <>
                <p>
                  这些任务已经固定在当前虚拟电脑上执行，不会自动转到新虚拟电脑。可以等它们完成后再更换，或者现在取消它们。
                </p>
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

  // The built-in system administrator (services/system-admin.ts) alone has the configuration tools.
  const isAdmin = !!role?.system_admin;
  const groups = (toolGroups.data ?? []).filter((g) => g.group && (g.group !== "config" || isAdmin));
  const alwaysTools = (toolGroups.data ?? []).find((g) => !g.group)?.tools ?? [];
  const selectedInstance = (instances.data ?? []).find((i) => i.id === draft.instance_id) ?? null;

  return (
    <div className="page">
      <PageHeader
        title={
          role ? (
            <span className="title-with-avatar">
              <Avatar id={role.id} name={role.name} kind="role" size={30} src={role.avatar_url} color={role.color} />
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
                <span className="muted">配置版本 {role.config_version}</span>
                <span className="muted">今日 {fmtNumber(role.tokens_today ?? 0)} tokens</span>
              </>
            ) : null}
          </span>
        }
        actions={
          role && !isAdmin ? (
            <>
              <button type="button" className="btn btn-sm" onClick={() => setDialog("copy")}>
                复制到其他虚拟电脑
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
            </div>
            <div className="form-row">
              <FieldGroup label="头像" hint="从你自己的电脑选择 PNG、JPEG、GIF 或 WebP 图片（最大 1 MB）">
                <AvatarEditor
                  id={role?.id ?? (draft.handle || "new-role")}
                  name={draft.name || draft.handle || "?"}
                  color={draft.color}
                  value={draft.avatar_url}
                  onChange={(url) => set("avatar_url", url)}
                />
              </FieldGroup>
              <FieldGroup label="颜色" hint="话题、任务、审批等处的角色徽章使用这个颜色">
                <ColorPicker value={draft.color} onChange={(c) => set("color", c)} />
                <div className="badge-row">
                  <RoleBadge
                    role={{
                      id: role?.id ?? (draft.handle || "new-role"),
                      name: draft.name || "角色名称",
                      handle: draft.handle || "handle",
                      color: draft.color,
                      avatar_url: draft.avatar_url || null,
                    }}
                  />
                </div>
              </FieldGroup>
            </div>
            <Field label="职责说明" hint="成员在邀请、私信时看到的介绍">
              <textarea rows={2} value={draft.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
            {isAdmin ? (
              <div className="callout">
                这是 witden
                内置的系统管理员：始终存在，不能停用或复制，也不能另外添加。它只在控制台中工作，可以像管理员一样读取和修改
                witden
                的配置（角色、模型、虚拟电脑、通讯接入和知识；不包括账号），以提问人的身份操作并记入审计日志。它不处理
                Slack、飞书、GitHub
                的消息，其他角色也不能把工作交给它；任何密钥它都读不到也改不了。它不需要虚拟电脑，它的设置只能由人修改。
              </div>
            ) : null}
          </Section>

          <Section title="工作方式">
            <Field
              label="提示词"
              hint="职责、工作规则、沟通方式与行为约束；需要角色长期记住的岗位知识（例如“发布前必须跑完 make check”）也写在这里。权限限制由系统执行，不依赖提示词。"
            >
              <textarea
                className="prompt"
                rows={10}
                value={draft.system_prompt}
                onChange={(e) => set("system_prompt", e.target.value)}
              />
            </Field>
          </Section>

          <Section title="模型">
            <Field
              label="模型"
              hint={
                selectedModel && "usable" in selectedModel && !selectedModel.usable
                  ? "这个模型已停用或服务商密钥已撤销，角色暂时无法工作。"
                  : "按服务商分组；在「模型」页添加服务商和模型。"
              }
            >
              <select value={draft.model_config_id} onChange={(e) => pickModel(e.target.value)}>
                <option value="">未配置</option>
                {modelGroups.map(([provider, list]) => (
                  <optgroup key={provider} label={provider || "其他"}>
                    {list.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.name !== m.model ? `（${m.model}）` : ""}
                        {m.usable ? "" : " · 不可用"}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {role?.model && !(models.data ?? []).some((m) => m.id === role.model!.id) ? (
                  <option value={role.model.id}>{role.model.label ?? role.model.name}</option>
                ) : null}
              </select>
            </Field>
            {selectedModel ? (
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
            <Field
              label="思考程度（effort）"
              hint={
                !draft.model_config_id
                  ? "先选择模型。"
                  : effort.reported
                    ? effort.levels.length
                      ? "这些是模型服务报告的、这个模型支持的等级。等级越高，思考越充分，用时和 token 也越多。"
                      : "模型服务报告这个模型没有思考程度设置。"
                    : "模型服务没有报告这个模型支持哪些等级，下面是常见等级，模型不支持时请求会出错。在“模型”页对它点击“检测能力”可以获取支持的等级（Anthropic、OpenRouter 等服务会报告）。"
              }
            >
              <select
                value={draft.reasoning_effort}
                disabled={!draft.model_config_id || !effort.levels.length}
                onChange={(e) => set("reasoning_effort", e.target.value)}
              >
                <option value="">
                  默认（由模型决定{effort.default ? `，${EFFORT_LABEL[effort.default] ?? effort.default}` : ""}）
                </option>
                {effort.levels.map((l) => (
                  <option key={l} value={l}>
                    {EFFORT_LABEL[l] ?? l}
                  </option>
                ))}
                {draft.reasoning_effort && !effort.levels.includes(draft.reasoning_effort) ? (
                  <option value={draft.reasoning_effort}>
                    {EFFORT_LABEL[draft.reasoning_effort] ?? draft.reasoning_effort}（这个模型不支持）
                  </option>
                ) : null}
              </select>
            </Field>
            <Field label="模型参数（JSON，可选）" hint='例如 {"temperature": 0.2}'>
              <textarea
                className="mono"
                rows={3}
                value={draft.model_params}
                onChange={(e) => set("model_params", e.target.value)}
              />
            </Field>
          </Section>

          <Section title="虚拟电脑">
            <Field
              label="所属虚拟电脑"
              hint={
                isAdmin
                  ? "系统管理员不需要虚拟电脑；分配后，它也可以使用其中的工具。"
                  : "角色执行任务时只能操作这台虚拟电脑；没有虚拟电脑时只能对话。"
              }
            >
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
            {selectedInstance ? (
              <div className="computer-summary">
                <ComputerBadge computer={selectedInstance} />
                <span className="muted">
                  {selectedInstance.spec?.kind === "desktop" ? "桌面虚拟电脑" : "命令行虚拟电脑"}
                </span>
                <StatusChip meta={instanceStatus(selectedInstance.status)} compact />
                <span className={selectedInstance.runner?.connected ? "text-ok" : "muted"}>
                  {selectedInstance.runner?.connected ? "Runner 已连接" : "Runner 未连接"}
                </span>
                <Link to={`/computers/${selectedInstance.id}`}>打开虚拟电脑</Link>
              </div>
            ) : null}
            {role && draft.instance_id !== (role.instance_id ?? "") ? (
              <div className="callout callout-wait">
                更换虚拟电脑不会迁移文件、已安装的软件和登录状态。已固定在旧虚拟电脑上的任务需要等它们完成或取消。
              </div>
            ) : null}
          </Section>

          <Section title="权限">
            <FieldGroup
              label="工具"
              hint="新角色默认：虚拟电脑里的操作（包括把其中的文件分享到话题）始终允许，联系其他角色、平台记忆、其他话题和修改自己的职责说明需要询问。「询问」表示每次使用前要由有审批权限的人批准，角色不能批准自己的请求。点左侧箭头可以逐个工具设置。"
            >
              <Loaded res={toolGroups}>
                {() => (
                  <PermissionList
                    groups={groups}
                    alwaysTools={alwaysTools}
                    allowed={draft.allowed_tools}
                    approval={draft.approval_required}
                    defaults={isAdmin ? ADMIN_DEFAULTS : defaults}
                    onChange={(allowed, approval) =>
                      setDraft((d) => ({ ...d, allowed_tools: allowed, approval_required: approval }))
                    }
                  />
                )}
              </Loaded>
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
            <button type="button" className="btn" disabled={!dirty} onClick={() => setDraft(fresh())}>
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
  color: "颜色",
  description: "职责说明",
  allowed_contacts: "可联系角色",
  knowledge_space_ids: "知识空间",
  approval_required: "询问设置",
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
      <p className="muted small">新角色拥有相同的提示词和设置，但身份独立：话题记忆、私信和进行中的任务不会被复制。</p>
      <div className="form-row">
        <Field label="名称">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="@ 名称">
          <input className="mono" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} />
        </Field>
      </div>
      <Field label="所属虚拟电脑">
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
        <Field label="接手的角色" hint="转交会重新检查权限，接手角色在自己的虚拟电脑上执行。">
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

/** Upload an image from one's own computer (stored by the server, saved with the role). */
function AvatarEditor({
  id,
  name,
  color,
  value,
  onChange,
}: {
  id: string;
  name: string;
  color: string | null;
  value: string;
  onChange: (url: string) => void;
}) {
  const { run, busy } = useAction();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="avatar-edit">
      <Avatar id={id} name={name} kind="role" size={48} src={value || null} color={color} />
      <div className="avatar-edit-controls">
        <div className="btn-row">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "上传中…" : "上传图片"}
          </button>
          {value ? (
            <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => onChange("")}>
              移除
            </button>
          ) : null}
          <input
            ref={input}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const form = new FormData();
              form.append("file", file);
              const out = await run(() => api.upload<{ avatar_url: string }>("/api/avatars", form));
              if (out) onChange(out.avatar_url);
            }}
          />
        </div>
      </div>
    </div>
  );
}

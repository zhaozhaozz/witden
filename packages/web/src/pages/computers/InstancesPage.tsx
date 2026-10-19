import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useLiveEvents } from "../../api/events";
import type { Instance, Template } from "../../api/types";
import { useDebounced, useResource } from "../../lib/hooks";
import { useAuth } from "../../lib/session";
import { useAction } from "../../ui/feedback";
import {
  ColorPicker,
  ComputerBadge,
  Empty,
  Field,
  FieldGroup,
  FormModal,
  Loaded,
  PageHeader,
  RoleBadge,
} from "../../ui/kit";
import { OperatorLabel } from "./computerControls";
import {
  ComputersNav,
  fromDraft,
  InstanceStatusChip,
  type ResourceDraft,
  ResourceFields,
  RunnerBadge,
  resourceSummary,
  toDraft,
} from "./computerParts";

export default function InstancesPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const res = useResource(() => api.get<Instance[]>("/api/instances"), []);
  const templates = useResource(() => api.get<Template[]>("/api/templates"), []);
  const refresh = useDebounced(() => void res.reload(), 500);
  const live = useLiveEvents(can("audit.view") || can("instance.manage") ? { admin: true } : null, (type) => {
    if (type.startsWith("instance.")) refresh();
  });
  const tplName = (id: string) => templates.data?.find((t) => t.id === id)?.name ?? id;

  return (
    <div className="page">
      <PageHeader
        title="虚拟电脑"
        sub="每台虚拟电脑是一个独立的 Docker 容器，角色只能在分配给自己的虚拟电脑里执行命令和操作桌面。"
        actions={
          <>
            {live ? <span className="live-dot live-on">实时</span> : null}
            {can("instance.manage") ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
                新建虚拟电脑
              </button>
            ) : null}
          </>
        }
      />
      <ComputersNav />
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>虚拟电脑</th>
                    <th>状态</th>
                    <th>模板</th>
                    <th>资源限制</th>
                    <th>使用它的角色</th>
                    <th>当前操作者</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.id} className="row-link" onClick={() => nav(`/computers/${i.id}`)}>
                      <td>
                        <Link to={`/computers/${i.id}`} onClick={(e) => e.stopPropagation()}>
                          <ComputerBadge computer={i} />
                        </Link>
                        <div className="small muted">
                          {i.spec?.kind === "desktop" ? "桌面虚拟电脑" : "命令行虚拟电脑"}
                        </div>
                      </td>
                      <td className="cell-status">
                        <InstanceStatusChip inst={i} compact /> <RunnerBadge inst={i} />
                        {i.status_reason ? (
                          <div className={`reason reason-${i.status === "error" ? "bad" : "info"}`}>
                            {i.status_reason}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {tplName(i.template_id)} <span className="muted small">v{i.template_version}</span>
                      </td>
                      <td className="small">{resourceSummary(i.resources)}</td>
                      <td>
                        {i.roles.length ? (
                          <span className="badge-row">
                            {i.roles.map((r) => (
                              <RoleBadge key={r.id} role={r} compact />
                            ))}
                          </span>
                        ) : (
                          <span className="muted">无</span>
                        )}
                      </td>
                      <td>
                        <OperatorLabel inst={i} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="还没有虚拟电脑"
              hint={
                can("instance.manage")
                  ? "从模板创建一台虚拟电脑，再把角色分配到这台虚拟电脑上。"
                  : "你没有可以查看的虚拟电脑。"
              }
              action={
                can("instance.manage") ? (
                  <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                    新建虚拟电脑
                  </button>
                ) : undefined
              }
            />
          )
        }
      </Loaded>
      {creating ? (
        <CreateInstanceDialog
          templates={(templates.data ?? []).filter((t) => !t.archived)}
          onClose={() => setCreating(false)}
          onCreated={(i) => {
            setCreating(false);
            nav(`/computers/${i.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function CreateInstanceDialog({
  templates,
  onClose,
  onCreated,
}: {
  templates: Template[];
  onClose: () => void;
  onCreated: (i: Instance) => void;
}) {
  const { run, busy } = useAction();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [draft, setDraft] = useState<ResourceDraft>(toDraft(templates[0]?.default_resources));
  const tpl = templates.find((t) => t.id === templateId);

  useEffect(() => {
    setDraft(toDraft(tpl?.default_resources));
  }, [tpl]);

  const nameOk = /^[a-z0-9][a-z0-9-]{1,62}$/.test(name);

  return (
    <FormModal
      title="新建虚拟电脑"
      submitLabel="创建并启动"
      busy={busy}
      disabled={!templateId || !nameOk}
      width={640}
      onClose={onClose}
      onSubmit={async () => {
        const i = await run(
          () =>
            api.post<Instance>("/api/instances", { template_id: templateId, name, color, resources: fromDraft(draft) }),
          "虚拟电脑正在创建，完成后会自动启动",
        );
        if (i) onCreated(i);
      }}
    >
      <Field label="模板" hint="虚拟电脑按创建时的模板固定配置；之后修改模板不会静默改变已有的虚拟电脑">
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} v{t.version}（{t.kind === "desktop" ? "桌面" : "命令行"}）
            </option>
          ))}
        </select>
      </Field>
      {!templates.length ? (
        <p className="small text-bad">还没有可用的模板，请先在「模板」中创建或导入内置模板。</p>
      ) : null}
      {tpl?.description ? <p className="small muted">{tpl.description}</p> : null}
      {tpl ? (
        <p className="small muted">
          AI 的所有操作都以虚拟电脑内的非特权用户 <code>{tpl.user}</code> 身份执行。
        </p>
      ) : null}
      <Field label="名称" hint="2–63 个字符：小写字母、数字和短横线，例如 dev-01。创建后不能修改。">
        <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="dev-01" />
      </Field>
      <FieldGroup label="颜色" hint="话题、任务等处的虚拟电脑徽章使用这个颜色">
        <ColorPicker value={color} onChange={setColor} />
        <div className="badge-row">
          <ComputerBadge computer={{ id: name || "new-computer", name: name || "虚拟电脑名称", color }} />
        </div>
      </FieldGroup>
      <ResourceFields value={draft} onChange={setDraft} />
    </FormModal>
  );
}

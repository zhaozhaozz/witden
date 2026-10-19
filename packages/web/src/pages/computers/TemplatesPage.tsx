import { useState } from "react";
import { api } from "../../api/client";
import type { Template } from "../../api/types";
import { fmtRelative, linesToList, listToLines } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useAuth } from "../../lib/session";
import { useChanged, useUnsavedChanges } from "../../lib/unsaved";
import { useAction, useFeedback } from "../../ui/feedback";
import { Empty, Field, FormModal, Loaded, PageHeader, Tag } from "../../ui/kit";
import { ComputersNav, fromDraft, type ResourceDraft, ResourceFields, resourceSummary, toDraft } from "./computerParts";

const DEFAULT_DESKTOP =
  '{\n  "display": ":1",\n  "width": 1280,\n  "height": 800,\n  "vnc_port": 5900,\n  "vnc_view_port": 5901\n}';

// Mirrors the server: a user name or uid[:gid], never root / uid 0.
const USER_RE = /^(?:[a-z_][a-z0-9_-]{0,31}|\d{1,10})(?::(?:[a-z_][a-z0-9_-]{0,31}|\d{1,10}))?$/;

function userProblem(user: string): string | null {
  if (!USER_RE.test(user)) return "运行用户应为用户名或 uid[:gid]";
  if (user.split(":").some((p) => p === "root" || /^0+$/.test(p)))
    return "运行用户不能是 root：AI 的操作必须以非特权用户执行";
  return null;
}

export default function TemplatesPage() {
  const { can } = useAuth();
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const manage = can("template.manage");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [copying, setCopying] = useState<Template | null>(null);
  const [copyName, setCopyName] = useState("");
  const res = useResource(() => api.get<Template[]>("/api/templates"), []);

  return (
    <div className="page">
      <PageHeader
        title="虚拟电脑"
        sub="模板是创建虚拟电脑的预配置环境：镜像、预装软件、工作目录和需要持久保存的目录。每次修改模板都会增加版本号。"
        actions={
          manage ? (
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  void run(() => api.post("/api/templates/seed-builtin"), "内置模板已导入").then(() => res.reload())
                }
              >
                导入内置模板
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
                新建模板
              </button>
            </>
          ) : null
        }
      />
      <ComputersNav />
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          显示已归档
        </label>
      </div>
      <Loaded res={res}>
        {(rows) => {
          const list = rows.filter((t) => showArchived || !t.archived);
          if (!list.length)
            return (
              <Empty
                title="还没有模板"
                hint="可以先导入内置的开发环境和浏览器桌面环境模板，再按需复制修改。"
                action={
                  manage ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() =>
                        void run(() => api.post("/api/templates/seed-builtin"), "内置模板已导入").then(() =>
                          res.reload(),
                        )
                      }
                    >
                      导入内置模板
                    </button>
                  ) : undefined
                }
              />
            );
          return (
            <div className="card-grid">
              {list.map((t) => (
                <article key={t.id} className={`card${t.archived ? " card-muted" : ""}`}>
                  <header className="card-head">
                    <div>
                      <h3>{t.name}</h3>
                      <div className="inline-list small">
                        <Tag>v{t.version}</Tag>
                        <Tag tone={t.kind === "desktop" ? "accent" : undefined}>
                          {t.kind === "desktop" ? "桌面" : "命令行"}
                        </Tag>
                        {t.archived ? <Tag tone="off">已归档</Tag> : null}
                        <span className="muted">{t.instance_count} 台虚拟电脑在用</span>
                      </div>
                    </div>
                  </header>
                  {t.description ? <p className="card-desc">{t.description}</p> : null}
                  <dl className="kv kv-compact">
                    <div className="kv-row">
                      <dt>镜像</dt>
                      <dd>
                        <code className="id">{t.image}</code>
                      </dd>
                    </div>
                    <div className="kv-row">
                      <dt>工作目录</dt>
                      <dd>
                        <code className="id">{t.workdir}</code>
                        <span className="muted small"> · 以用户 {t.user} 运行</span>
                      </dd>
                    </div>
                    <div className="kv-row">
                      <dt>持久化</dt>
                      <dd>
                        {t.persistent_paths.length ? t.persistent_paths.join("，") : <span className="muted">无</span>}
                      </dd>
                    </div>
                    <div className="kv-row">
                      <dt>默认资源</dt>
                      <dd className="small">{resourceSummary(t.default_resources)}</dd>
                    </div>
                    {t.software.length ? (
                      <div className="kv-row">
                        <dt>软件</dt>
                        <dd className="inline-list">
                          {t.software.map((s) => (
                            <Tag key={s}>{s}</Tag>
                          ))}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  <footer className="card-foot">
                    <span className="small muted">更新于 {fmtRelative(t.updated_at)}</span>
                    {manage ? (
                      <div className="btn-row">
                        <button type="button" className="btn btn-xs" onClick={() => setEditing(t)}>
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={() => {
                            setCopyName(`${t.name}-copy`);
                            setCopying(t);
                          }}
                        >
                          复制
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy}
                          onClick={async () => {
                            const out = await run(
                              () => api.patch(`/api/templates/${t.id}`, { archived: !t.archived }),
                              t.archived ? "已恢复" : "已归档",
                            );
                            if (out) void res.reload();
                          }}
                        >
                          {t.archived ? "恢复" : "归档"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-danger-ghost"
                          disabled={busy || t.instance_count > 0}
                          title={t.instance_count > 0 ? "还有虚拟电脑在使用这个模板，可以先归档" : undefined}
                          onClick={async () => {
                            const ok = await confirm({
                              title: `删除模板 ${t.name}`,
                              body: <p>删除后无法恢复。已有虚拟电脑不受影响。</p>,
                              danger: true,
                              confirmLabel: "删除",
                            });
                            if (!ok) return;
                            const out = await run(() => api.del(`/api/templates/${t.id}`), "模板已删除");
                            if (out) void res.reload();
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ) : null}
                  </footer>
                </article>
              ))}
            </div>
          );
        }}
      </Loaded>

      {editing ? (
        <TemplateEditor
          template={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void res.reload();
          }}
        />
      ) : null}
      {copying ? (
        <FormModal
          title={`复制模板 ${copying.name}`}
          submitLabel="复制"
          busy={busy}
          disabled={!copyName.trim()}
          onClose={() => setCopying(null)}
          onSubmit={async () => {
            const out = await run(
              () => api.post(`/api/templates/${copying.id}/copy`, { name: copyName.trim() }),
              "模板已复制",
            );
            if (out) {
              setCopying(null);
              void res.reload();
            }
          }}
        >
          <Field label="新模板名称">
            <input value={copyName} onChange={(e) => setCopyName(e.target.value)} autoFocus />
          </Field>
        </FormModal>
      ) : null}
    </div>
  );
}

function TemplateEditor({
  template,
  onClose,
  onSaved,
}: {
  template: Template | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { run, busy } = useAction();
  const t = template;
  const [form, setForm] = useState({
    name: t?.name ?? "",
    description: t?.description ?? "",
    image: t?.image ?? "",
    kind: t?.kind ?? "shell",
    workdir: t?.workdir ?? "/home/witden",
    user: t?.user ?? "witden",
    command: listToLines(t?.command),
    env: Object.entries(t?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    persistent_paths: listToLines(t?.persistent_paths ?? ["/home/witden"]),
    credential_paths: listToLines(t?.credential_paths),
    software: listToLines(t?.software),
    cap_add: listToLines(t?.cap_add),
    runtime: t?.runtime ?? "",
    desktop: t?.desktop ? JSON.stringify(t.desktop, null, 2) : DEFAULT_DESKTOP,
  });
  const [resources, setResources] = useState<ResourceDraft>(toDraft(t?.default_resources));
  const [error, setError] = useState<string | null>(null);
  const [changed] = useChanged({ form, resources });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const userError = userProblem(form.user.trim() || "witden");

  const submit = async (): Promise<boolean> => {
    setError(null);
    if (userError) {
      setError(userError);
      return false;
    }
    let desktop: unknown = null;
    if (form.kind === "desktop") {
      try {
        desktop = JSON.parse(form.desktop);
      } catch {
        setError("桌面配置不是有效的 JSON");
        return false;
      }
    }
    const env: Record<string, string> = {};
    for (const line of linesToList(form.env)) {
      const i = line.indexOf("=");
      if (i <= 0) {
        setError(`环境变量格式应为 KEY=VALUE：${line}`);
        return false;
      }
      env[line.slice(0, i).trim()] = line.slice(i + 1);
    }
    const command = linesToList(form.command);
    const body = {
      name: form.name.trim(),
      description: form.description,
      image: form.image.trim(),
      kind: form.kind,
      workdir: form.workdir.trim() || "/home/witden",
      user: form.user.trim() || "witden",
      command: command.length ? command : null,
      env,
      persistent_paths: linesToList(form.persistent_paths),
      credential_paths: linesToList(form.credential_paths).length ? linesToList(form.credential_paths) : null,
      software: linesToList(form.software),
      default_resources: fromDraft(resources),
      cap_add: linesToList(form.cap_add),
      runtime: form.runtime.trim() || null,
      desktop,
    };
    const out = await run(
      () => (t ? api.patch(`/api/templates/${t.id}`, body) : api.post("/api/templates", body)),
      t ? "模板已保存，版本号已增加；已有虚拟电脑不受影响" : "模板已创建",
    );
    if (out) onSaved();
    return !!out;
  };
  useUnsavedChanges(changed, submit);

  return (
    <FormModal
      title={t ? `编辑模板 ${t.name}` : "新建模板"}
      busy={busy}
      width={760}
      disabled={!form.name.trim() || !form.image.trim()}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {error ? <div className="error-note">{error}</div> : null}
      <div className="form-row">
        <Field label="名称">
          <input value={form.name} onChange={set("name")} />
        </Field>
        <Field label="类型">
          <select value={form.kind} onChange={set("kind")}>
            <option value="shell">命令行</option>
            <option value="desktop">桌面（可截图、操作鼠标键盘）</option>
          </select>
        </Field>
      </div>
      <Field label="用途说明">
        <textarea rows={2} value={form.description} onChange={set("description")} />
      </Field>
      <div className="form-row">
        <Field label="镜像" hint="Docker 镜像，例如 witden/computer-shell:latest">
          <input className="mono" value={form.image} onChange={set("image")} />
        </Field>
        <Field label="工作目录">
          <input className="mono" value={form.workdir} onChange={set("workdir")} />
        </Field>
        <Field
          label="运行用户"
          hint={
            userError ??
            "Runner 和 AI 的所有操作都以这个非特权用户执行，不能是 root；必须是镜像中已有的用户，或数字 uid[:gid]"
          }
        >
          <input className="mono" value={form.user} onChange={set("user")} placeholder="witden" />
        </Field>
      </div>
      <div className="form-row">
        <Field label="持久化目录" hint="每行一个绝对路径；重启后保留">
          <textarea className="mono" rows={3} value={form.persistent_paths} onChange={set("persistent_paths")} />
        </Field>
        <Field label="凭据目录" hint="每行一个；复制虚拟电脑时默认排除。留空使用默认列表（~/.ssh 等）">
          <textarea className="mono" rows={3} value={form.credential_paths} onChange={set("credential_paths")} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="预装软件" hint="每行一个，用于说明">
          <textarea rows={3} value={form.software} onChange={set("software")} />
        </Field>
        <Field label="环境变量" hint="每行 KEY=VALUE">
          <textarea className="mono" rows={3} value={form.env} onChange={set("env")} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="启动命令" hint="每行一个参数；留空使用镜像默认">
          <textarea className="mono" rows={2} value={form.command} onChange={set("command")} />
        </Field>
        <Field label="附加能力（cap_add）" hint="每行一个，只允许安全的能力">
          <textarea className="mono" rows={2} value={form.cap_add} onChange={set("cap_add")} />
        </Field>
        <Field label="容器运行时" hint="如 runsc；留空默认">
          <input className="mono" value={form.runtime} onChange={set("runtime")} />
        </Field>
      </div>
      {form.kind === "desktop" ? (
        <Field label="桌面配置（JSON）" hint="显示编号与 VNC 端口；只读观察使用 vnc_view_port">
          <textarea className="mono" rows={5} value={form.desktop} onChange={set("desktop")} />
        </Field>
      ) : null}
      <div className="field-label">默认资源限制</div>
      <ResourceFields value={resources} onChange={setResources} />
    </FormModal>
  );
}

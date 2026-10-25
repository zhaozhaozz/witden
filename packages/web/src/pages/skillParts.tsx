/**
 * A role's skills (server: services/role-skills.ts): a name, when to use it, the instructions in Markdown, and the
 * files that come with it (scripts, templates, reference documents). Each is shown by name and description; opening
 * it shows the instructions, its files and who changed it last, with edit and delete. A skill downloads and imports
 * as a package (.tar.gz). The same list serves the role editor and the topic sidebar.
 */
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { ApiError, api, saveBlob } from "../api/client";
import type { RoleSkill, RoleSkillFile } from "../api/types";
import { fmtBytes, fmtDateTime, fmtRelative, fmtTime } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useDirectory } from "../lib/session";
import { useAction, useFeedback } from "../ui/feedback";
import { Empty, Loaded } from "../ui/kit";
import { Markdown } from "../ui/Markdown";

/** As the server checks them (services/role-skills.ts). */
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DESCRIPTION_MAX_CHARS = 500;
const CONTENT_MAX_CHARS = 64000;

interface Draft {
  name: string;
  description: string;
  content: string;
}

const BLANK: Draft = { name: "", description: "", content: "" };

/** Why the server would refuse a file's path in a skill (services/role-skills.ts: skillFilePath), or null. */
function badFilePath(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  if (p.startsWith("/")) return "路径相对于技能目录，例如 scripts/check.sh";
  if (p.split("/").some((part) => part === "" || part === "." || part === "..")) return "路径中不能有空的部分、. 或 ..";
  if (p === "SKILL.md") return "SKILL.md 是技能的内容，请直接编辑内容";
  return null;
}

/** A file's URL under its skill: each part of the path encoded on its own. */
const fileUrl = (base: string, path: string) => `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;

function SkillFileForm({
  base,
  busy,
  onDone,
  onCancel,
}: {
  base: string;
  busy: boolean;
  onDone: (file: RoleSkillFile) => void;
  onCancel: () => void;
}) {
  const { run } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState("");
  const [executable, setExecutable] = useState(false);
  const bad = path.trim() ? badFilePath(path.trim()) : null;
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!picked) return;
    setFile(picked);
    if (!path.trim() || path.trim() === file?.name) setPath(picked.name);
    // A script starts with "#!": it is to be run.
    setExecutable((await picked.slice(0, 2).text()) === "#!");
  };
  return (
    <form
      className="note-form skill-file-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        const form = new FormData();
        form.append("executable", String(executable));
        form.append("file", file);
        const out = await run(() => api.upload<RoleSkillFile>(fileUrl(base, path.trim()), form, "PUT"), "文件已上传");
        if (out) onDone(out);
      }}
    >
      <div className="skill-file-pick">
        <button type="button" className="btn btn-xs" onClick={() => input.current?.click()}>
          选择文件
        </button>
        <span className="small muted">{file ? `${file.name} · ${fmtBytes(file.size)}` : "未选择"}</span>
        <input ref={input} type="file" hidden onChange={pick} />
      </div>
      <input
        aria-label="文件路径"
        placeholder="技能中的路径，例如 scripts/check.sh"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      {bad ? <span className="small text-bad">{bad}</span> : null}
      <label className="check">
        <input type="checkbox" checked={executable} onChange={(e) => setExecutable(e.target.checked)} />
        可执行（脚本）
      </label>
      <span className="small muted">同一路径已有文件时会被替换。</span>
      <div className="btn-row">
        <button type="button" className="btn btn-xs" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn btn-xs btn-primary" disabled={busy || !file || !path.trim() || !!bad}>
          上传
        </button>
      </div>
    </form>
  );
}

/** The files of an opened skill: each viewed inline (text), downloaded or deleted; new ones uploaded. */
function SkillFiles({
  roleId,
  skill,
  onChange,
}: {
  roleId: string;
  skill: RoleSkill;
  onChange: (files: RoleSkillFile[]) => void;
}) {
  const { run, busy } = useAction();
  const { confirm } = useFeedback();
  const [adding, setAdding] = useState(false);
  // The opened file's text, or null for a binary file.
  const [viewing, setViewing] = useState<{ path: string; text: string | null } | null>(null);
  const base = `/api/roles/${roleId}/skills/${skill.id}/files`;
  const view = async (f: RoleSkillFile) => {
    if (viewing?.path === f.path) return setViewing(null);
    const blob = await run(() => api.blob(fileUrl(base, f.path)));
    if (!blob) return;
    let text: string | null;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer());
      if (text.includes("\0")) text = null;
    } catch {
      text = null;
    }
    setViewing({ path: f.path, text });
  };
  return (
    <div className="skill-files">
      <div className="skill-files-head">
        <span className="small">
          <strong>文件</strong> <span className="muted">{skill.files.length ? `${skill.files.length} 个` : "无"}</span>
        </span>
        {!adding ? (
          <button type="button" className="link-btn" onClick={() => setAdding(true)}>
            上传文件
          </button>
        ) : null}
      </div>
      {adding ? (
        <SkillFileForm
          base={base}
          busy={busy}
          onCancel={() => setAdding(false)}
          onDone={(file) => {
            onChange(
              [...skill.files.filter((f) => f.path !== file.path), file].sort((a, b) => a.path.localeCompare(b.path)),
            );
            if (viewing?.path === file.path) setViewing(null);
            setAdding(false);
          }}
        />
      ) : null}
      {skill.files.length ? (
        <ul className="skill-file-list">
          {skill.files.map((f) => (
            <li key={f.id}>
              <div className="skill-file-row">
                <code className="skill-file-path">{f.path}</code>
                <span className="small muted">{fmtBytes(f.size)}</span>
                {f.executable ? <span className="tag">可执行</span> : null}
                <span className="skill-file-actions small">
                  {/* Named with the path: the skill's own buttons (编辑, 删除) are next to these. */}
                  <button
                    type="button"
                    className="link-btn"
                    aria-label={`${viewing?.path === f.path ? "收起" : "查看"} ${f.path}`}
                    onClick={() => void view(f)}
                  >
                    {viewing?.path === f.path ? "收起" : "查看"}
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    aria-label={`下载 ${f.path}`}
                    onClick={() =>
                      void run(async () => saveBlob(await api.blob(fileUrl(base, f.path)), f.path.split("/").pop()!))
                    }
                  >
                    下载
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    aria-label={`删除 ${f.path}`}
                    onClick={async () => {
                      if (
                        !(await confirm({
                          title: `删除文件 ${f.path}`,
                          body: <p>删除后，AI 员工下次读取这个技能时，虚拟电脑中不再有这个文件。</p>,
                          danger: true,
                          confirmLabel: "删除",
                        }))
                      )
                        return;
                      const ok = await run(() => api.del(fileUrl(base, f.path)), "文件已删除");
                      if (ok) onChange(skill.files.filter((x) => x.id !== f.id));
                    }}
                  >
                    删除
                  </button>
                </span>
              </div>
              {viewing?.path === f.path ? (
                viewing.text === null ? (
                  <p className="small muted">二进制文件，请下载后查看。</p>
                ) : (
                  <pre className="skill-file-text">{viewing.text}</pre>
                )
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
const draftOf = (s: RoleSkill): Draft => ({ name: s.name, description: s.description, content: s.content });

function SkillForm({
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  busy: boolean;
  submitLabel: string;
  onSubmit: (d: Draft) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const set = (k: keyof Draft, v: string) => setD((p) => ({ ...p, [k]: v }));
  const name = d.name.trim().toLowerCase();
  const badName = !!name && !SKILL_NAME.test(name);
  return (
    <form
      className="note-form memory-form skill-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onSubmit(d)) setD(BLANK);
      }}
    >
      <input
        aria-label="名称"
        placeholder="名称，例如 release-check"
        maxLength={64}
        value={d.name}
        onChange={(e) => set("name", e.target.value)}
      />
      {badName ? <span className="small text-bad">名称只能用小写字母、数字和 . _ -，并以字母或数字开头</span> : null}
      <textarea
        aria-label="说明"
        rows={2}
        maxLength={DESCRIPTION_MAX_CHARS}
        placeholder="什么时候用它，一两句话（每次都随系统提示词给出）"
        value={d.description}
        onChange={(e) => set("description", e.target.value)}
      />
      <textarea
        aria-label="内容"
        rows={8}
        maxLength={CONTENT_MAX_CHARS}
        placeholder="具体做法，支持 Markdown：步骤、注意事项、常用命令"
        value={d.content}
        onChange={(e) => set("content", e.target.value)}
      />
      <div className="btn-row">
        <button type="button" className="btn btn-xs" onClick={onCancel}>
          取消
        </button>
        <button
          type="submit"
          className="btn btn-xs btn-primary"
          disabled={busy || !name || badName || !d.description.trim() || !d.content.trim()}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function SkillList({
  roleId,
  compact = false,
  version = 0,
}: {
  roleId: string;
  /** In a sidebar: who changed it and when are shown once it is opened. */
  compact?: boolean;
  /** Refresh after work events (the AI employee may change its skills) without closing open ones or drafts. */
  version?: number;
}) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const { confirm, toast } = useFeedback();
  const archiveInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const res = useResource(() => api.get<RoleSkill[]>(`/api/roles/${roleId}/skills`), [roleId]);
  const previousVersion = useRef(version);
  useEffect(() => {
    if (previousVersion.current !== version) {
      previousVersion.current = version;
      void res.reload();
    }
  }, [version, res.reload]);
  const fields = (d: Draft) => ({
    name: d.name.trim().toLowerCase(),
    description: d.description.trim(),
    content: d.content.trim(),
  });
  const sorted = (rows: RoleSkill[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name));
  /** A skill package (.tar.gz, as downloaded): a skill of the same name is replaced only after asking. */
  const importArchive = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const url = `/api/roles/${roleId}/skills/import`;
    const send = (replace?: boolean) => {
      const form = new FormData();
      form.append("file", file);
      return api.upload<RoleSkill>(url, form, "POST", replace ? { replace: true } : undefined);
    };
    const s = await run(async () => {
      try {
        return await send();
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409) throw err;
        const replace = await confirm({
          title: "替换同名技能",
          body: <p>这位 AI 员工已有同名的技能。替换后，它的说明、内容和文件都换成技能包中的内容。</p>,
          danger: true,
          confirmLabel: "替换",
        });
        return replace ? await send(true) : undefined;
      }
    });
    if (s) {
      res.setData((prev) => sorted([...(prev ?? []).filter((x) => x.id !== s.id), s]));
      toast("技能已导入", "ok");
    }
  };
  /** Who changed it last: a person, or the AI employee itself. */
  const changedBy = (s: RoleSkill) => {
    const created = s.updated_at === s.created_at;
    if (s.updated_by_type === "role") return created ? "AI 员工自己写下" : "AI 员工自己修改";
    return `${dir.userName(s.updated_by_id)} ${created ? "添加" : "修改"}`;
  };
  const meta = (s: RoleSkill) => (
    <span className="small muted">
      {changedBy(s)} ·{" "}
      <span title={fmtTime(s.updated_at)}>{compact ? fmtDateTime(s.updated_at) : fmtRelative(s.updated_at)}</span>
    </span>
  );
  return (
    <>
      {adding ? (
        <SkillForm
          initial={BLANK}
          busy={busy}
          submitLabel="添加"
          onCancel={() => setAdding(false)}
          onSubmit={async (d) => {
            const s = await run(() => api.post<RoleSkill>(`/api/roles/${roleId}/skills`, fields(d)), "技能已添加");
            if (s) {
              res.setData((prev) => sorted([...(prev ?? []), s]));
              setAdding(false);
            }
            return !!s;
          }}
        />
      ) : (
        <div className="skill-add">
          <button type="button" className="btn btn-xs btn-ghost memory-add" onClick={() => setAdding(true)}>
            添加技能
          </button>
          <button
            type="button"
            className="btn btn-xs btn-ghost memory-add"
            disabled={busy}
            title="导入 .tar.gz 技能包：SKILL.md 和它旁边的文件"
            onClick={() => archiveInput.current?.click()}
          >
            导入技能包
          </button>
          <input
            ref={archiveInput}
            type="file"
            hidden
            accept=".tar.gz,.tgz,.tar,application/gzip"
            aria-label="技能包"
            onChange={importArchive}
          />
        </div>
      )}
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <ul className="memory-list skill-list">
              {rows.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="memory-toggle"
                    aria-expanded={expanded.has(s.id)}
                    aria-controls={`skill-${s.id}`}
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(s.id)) next.add(s.id);
                        return next;
                      })
                    }
                  >
                    <span className="memory-chevron" aria-hidden>
                      ›
                    </span>
                    <span className="skill-head">
                      <strong className="skill-name">{s.name}</strong>
                      <span className="skill-description">{s.description}</span>
                    </span>
                  </button>
                  {!compact && editing !== s.id ? <div className="skill-meta">{meta(s)}</div> : null}
                  <div id={`skill-${s.id}`} hidden={!expanded.has(s.id)} className="memory-detail">
                    {editing === s.id ? (
                      <SkillForm
                        initial={draftOf(s)}
                        busy={busy}
                        submitLabel="保存"
                        onCancel={() => setEditing(null)}
                        onSubmit={async (d) => {
                          const out = await run(
                            () => api.patch<RoleSkill>(`/api/roles/${roleId}/skills/${s.id}`, fields(d)),
                            "已保存",
                          );
                          if (out) {
                            res.setData((prev) => sorted((prev ?? []).map((x) => (x.id === out.id ? out : x))));
                            setEditing(null);
                          }
                          return false;
                        }}
                      />
                    ) : (
                      <>
                        <div className="skill-content">
                          <Markdown content={s.content} />
                        </div>
                        <SkillFiles
                          roleId={roleId}
                          skill={s}
                          onChange={(files) =>
                            res.setData((prev) => (prev ?? []).map((x) => (x.id === s.id ? { ...x, files } : x)))
                          }
                        />
                        <div className="small muted">
                          {compact ? meta(s) : null}
                          <button type="button" className="link-btn" onClick={() => setEditing(s.id)}>
                            编辑
                          </button>
                          <button
                            type="button"
                            className="link-btn"
                            title="SKILL.md 和全部文件，.tar.gz 格式"
                            onClick={() =>
                              void run(async () =>
                                saveBlob(
                                  await api.blob(`/api/roles/${roleId}/skills/${s.id}/archive`),
                                  `${s.name}.tar.gz`,
                                ),
                              )
                            }
                          >
                            下载技能包
                          </button>
                          <button
                            type="button"
                            className="link-btn"
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: `删除技能 ${s.name}`,
                                  body: <p>删除后 AI 员工不再看到这个技能，也不能再读取它；技能的文件一并删除。</p>,
                                  danger: true,
                                  confirmLabel: "删除",
                                }))
                              )
                                return;
                              const ok = await run(() => api.del(`/api/roles/${roleId}/skills/${s.id}`), "技能已删除");
                              if (ok) res.setData((prev) => prev?.filter((x) => x.id !== s.id));
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="还没有技能" />
          )
        }
      </Loaded>
    </>
  );
}

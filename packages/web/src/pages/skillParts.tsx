/**
 * A role's skills (server: services/role-skills.ts): a name, when to use it, and the instructions in Markdown.
 * Each is shown by name and description; opening it shows the instructions and who changed it last, with edit and
 * delete. The same list serves the role editor and the topic sidebar.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { RoleSkill } from "../api/types";
import { fmtDateTime, fmtRelative, fmtTime } from "../lib/format";
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
  const { confirm } = useFeedback();
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
        <button type="button" className="btn btn-xs btn-ghost memory-add" onClick={() => setAdding(true)}>
          添加技能
        </button>
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
                        <div className="small muted">
                          {compact ? meta(s) : null}
                          <button type="button" className="link-btn" onClick={() => setEditing(s.id)}>
                            编辑
                          </button>
                          <button
                            type="button"
                            className="link-btn"
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: `删除技能 ${s.name}`,
                                  body: <p>删除后 AI 员工不再看到这个技能，也不能再读取它。</p>,
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

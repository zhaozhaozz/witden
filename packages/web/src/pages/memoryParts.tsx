/** Notes — a topic's, a role's own memory, a knowledge space's — as a title, keywords and content: add, edit, delete. */
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Memory } from "../api/types";
import { fmtDateTime, fmtRelative, fmtTime } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useDirectory } from "../lib/session";
import { useAction, useFeedback } from "../ui/feedback";
import { Empty, Loaded, Tag } from "../ui/kit";

interface Draft {
  title: string;
  /** As typed: separated by commas or 、 (the server splits them). */
  keywords: string;
  content: string;
}

const BLANK: Draft = { title: "", keywords: "", content: "" };
const draftOf = (m: Memory): Draft => ({ title: m.title, keywords: m.keywords.join("，"), content: m.content });

function MemoryForm({
  initial,
  placeholder,
  maxChars,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  placeholder: string;
  maxChars?: number;
  busy: boolean;
  submitLabel: string;
  onSubmit: (d: Draft) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [d, setD] = useState(initial);
  const set = (k: keyof Draft, v: string) => setD((p) => ({ ...p, [k]: v }));
  return (
    <form
      className="note-form memory-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onSubmit(d)) setD(BLANK);
      }}
    >
      <input
        aria-label="标题"
        placeholder="标题"
        maxLength={100}
        value={d.title}
        onChange={(e) => set("title", e.target.value)}
      />
      <input
        aria-label="关键词"
        placeholder="关键词，用逗号分隔（角色按它们检索）"
        value={d.keywords}
        onChange={(e) => set("keywords", e.target.value)}
      />
      <textarea
        aria-label="内容"
        rows={3}
        maxLength={maxChars}
        placeholder={placeholder}
        value={d.content}
        onChange={(e) => set("content", e.target.value)}
      />
      <div className="btn-row">
        {onCancel ? (
          <button type="button" className="btn btn-xs" onClick={onCancel}>
            取消
          </button>
        ) : null}
        <button
          type="submit"
          className="btn btn-xs btn-primary"
          disabled={busy || !d.title.trim() || !d.content.trim()}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function MemoryList({
  query,
  create,
  canAdd = true,
  placeholder,
  emptyTitle,
  itemName,
  maxChars,
  compact = false,
  version = 0,
}: {
  /** GET /api/memories parameters: the scope and its id. */
  query: Record<string, string>;
  /** POST /api/memories fields besides the note's: the scope and its id. */
  create: Record<string, string>;
  canAdd?: boolean;
  placeholder: string;
  emptyTitle: string;
  /** What one note is called here, e.g. 角色记忆 (for the delete confirmation). */
  itemName: string;
  maxChars?: number;
  /** In a sidebar, show titles first and open forms and details on demand. */
  compact?: boolean;
  /** Refresh after work events without resetting open notes or drafts. */
  version?: number;
}) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const { confirm } = useFeedback();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const key = JSON.stringify(query);
  const res = useResource(() => api.get<Memory[]>("/api/memories", query), [key]);
  const previousVersion = useRef(version);
  useEffect(() => {
    if (previousVersion.current !== version) {
      previousVersion.current = version;
      void res.reload();
    }
  }, [version, res.reload]);
  const fields = (d: Draft) => ({ title: d.title.trim(), keywords: d.keywords, content: d.content.trim() });
  return (
    <>
      {canAdd && compact && !adding ? (
        <button type="button" className="btn btn-xs btn-ghost memory-add" onClick={() => setAdding(true)}>
          添加{itemName}
        </button>
      ) : null}
      {canAdd && (!compact || adding) ? (
        <MemoryForm
          initial={BLANK}
          placeholder={placeholder}
          maxChars={maxChars}
          busy={busy}
          submitLabel="添加"
          onCancel={compact ? () => setAdding(false) : undefined}
          onSubmit={async (d) => {
            const m = await run(() => api.post<Memory>("/api/memories", { ...create, ...fields(d) }), "已添加");
            if (m) {
              res.setData((prev) => [m, ...(prev ?? [])]);
              setExpanded((prev) => new Set(prev).add(m.id));
              setAdding(false);
            }
            return !!m;
          }}
        />
      ) : null}
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <ul className="memory-list">
              {rows.map((m) => (
                <li key={m.id}>
                  {compact ? (
                    <button
                      type="button"
                      className="memory-toggle"
                      aria-expanded={expanded.has(m.id)}
                      aria-controls={`memory-${m.id}`}
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (!next.delete(m.id)) next.add(m.id);
                          return next;
                        })
                      }
                    >
                      <span className="memory-chevron" aria-hidden>
                        ›
                      </span>
                      <strong>{m.title || "（无标题）"}</strong>
                    </button>
                  ) : null}
                  <div
                    id={`memory-${m.id}`}
                    hidden={compact && !expanded.has(m.id)}
                    className={compact ? "memory-detail" : undefined}
                  >
                    {editing === m.id ? (
                      <MemoryForm
                        initial={draftOf(m)}
                        placeholder={placeholder}
                        maxChars={maxChars}
                        busy={busy}
                        submitLabel="保存"
                        onCancel={() => setEditing(null)}
                        onSubmit={async (d) => {
                          const out = await run(() => api.patch<Memory>(`/api/memories/${m.id}`, fields(d)), "已保存");
                          if (out) {
                            res.setData((prev) => prev?.map((x) => (x.id === out.id ? out : x)));
                            setEditing(null);
                          }
                          return false;
                        }}
                      />
                    ) : (
                      <>
                        <div className="memory-head">
                          {!compact ? <strong>{m.title || "（无标题）"}</strong> : null}
                          {compact && !m.keywords.length ? <span className="small muted">暂无关键词</span> : null}
                          {m.keywords.map((k) => (
                            <Tag key={k}>{k}</Tag>
                          ))}
                        </div>
                        <div className="memory-text">{m.content}</div>
                        <div className="small muted">
                          {m.created_by_type === "role"
                            ? `${dir.roleLabel(m.created_by_id)} 记下`
                            : `${dir.userName(m.created_by_id)} 添加`}{" "}
                          ·{" "}
                          <span title={fmtTime(m.created_at)}>
                            {compact ? fmtDateTime(m.created_at) : fmtRelative(m.created_at)}
                          </span>
                          {m.updated_at ? (
                            <span title={fmtTime(m.updated_at)}>
                              {" "}
                              · {compact ? fmtDateTime(m.updated_at) : fmtRelative(m.updated_at)}修改
                            </span>
                          ) : null}
                          <button type="button" className="link-btn" onClick={() => setEditing(m.id)}>
                            编辑
                          </button>
                          <button
                            type="button"
                            className="link-btn"
                            onClick={async () => {
                              if (
                                !(await confirm({ title: `删除这条${itemName}`, danger: true, confirmLabel: "删除" }))
                              )
                                return;
                              const ok = await run(() => api.del(`/api/memories/${m.id}`));
                              if (ok) res.setData((prev) => prev?.filter((x) => x.id !== m.id));
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
            <Empty title={emptyTitle} />
          )
        }
      </Loaded>
    </>
  );
}

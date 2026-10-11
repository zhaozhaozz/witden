import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { KnowledgeSpace, Memory } from "../../api/types";
import { fmtRelative } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import { Empty, Field, FormModal, Loaded, Section } from "../../ui/kit";

export function KnowledgeTab() {
  const { run, busy } = useAction();
  const spaces = useResource(() => api.get<KnowledgeSpace[]>("/api/knowledge-spaces"), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!selected && spaces.data?.length) setSelected(spaces.data[0].id);
  }, [spaces.data, selected]);

  const current = spaces.data?.find((s) => s.id === selected) ?? null;

  return (
    <>
      <div className="toolbar">
        <span className="small muted">
          知识空间存放团队共享资料。成员需要「读取知识空间」授权才能查看；角色需要在配置中选择空间才能读取。
        </span>
        <button className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
          新建知识空间
        </button>
      </div>
      <Loaded res={spaces}>
        {(rows) =>
          rows.length ? (
            <div className="split">
              <ul className="conn-list">
                {rows.map((s) => (
                  <li key={s.id}>
                    <button className={`conn-item${s.id === selected ? " conn-on" : ""}`} onClick={() => setSelected(s.id)}>
                      <span className="conn-name">{s.name}</span>
                      {s.description ? <span className="small muted">{s.description}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
              {current ? <SpaceMemories key={current.id} space={current} /> : null}
            </div>
          ) : (
            <Empty title="还没有知识空间" hint="例如：产品文档、运维手册、客户资料。" />
          )
        }
      </Loaded>
      {creating ? (
        <FormModal
          title="新建知识空间"
          busy={busy}
          disabled={!name.trim()}
          onClose={() => setCreating(false)}
          onSubmit={async () => {
            const out = await run(() => api.post<KnowledgeSpace>("/api/knowledge-spaces", { name: name.trim(), description }), "已创建");
            if (out) {
              setCreating(false);
              setName("");
              setDescription("");
              setSelected(out.id);
              void spaces.reload();
            }
          }}
        >
          <Field label="名称">
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="说明">
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </FormModal>
      ) : null}
    </>
  );
}

function SpaceMemories({ space }: { space: KnowledgeSpace }) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const { confirm } = useFeedback();
  const [text, setText] = useState("");
  const res = useResource(() => api.get<Memory[]>("/api/memories", { scope: "team", space_id: space.id }), [space.id]);
  return (
    <Section title={space.name}>
      {space.description ? <p className="small muted">{space.description}</p> : null}
      <form
        className="note-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const m = await run(() => api.post<Memory>("/api/memories", { scope: "team", space_id: space.id, content: text.trim() }), "已添加");
          if (m) {
            setText("");
            res.setData((p) => [m, ...(p ?? [])]);
          }
        }}
      >
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="添加一条共享资料（需要「编辑知识空间」授权）" />
        <button className="btn btn-xs btn-primary" disabled={busy || !text.trim()}>
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
                    {m.created_by_type === "role" ? dir.roleLabel(m.created_by_id) : dir.userName(m.created_by_id)} · {fmtRelative(m.created_at)}
                    <button
                      className="link-btn"
                      onClick={async () => {
                        if (!(await confirm({ title: "删除这条资料", danger: true, confirmLabel: "删除" }))) return;
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
            <Empty title="空间里还没有内容" />
          )
        }
      </Loaded>
    </Section>
  );
}

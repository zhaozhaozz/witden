import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { KnowledgeSpace } from "../../api/types";
import { useConfigChanged } from "../../lib/configEvents";
import { useResource } from "../../lib/hooks";
import { useAction } from "../../ui/feedback";
import { Empty, Field, FormModal, Loaded, Section } from "../../ui/kit";
import { ResizeHandle } from "../../ui/resize";
import { MemoryList } from "../memoryParts";

export function KnowledgeTab() {
  const { run, busy } = useAction();
  const spaces = useResource(() => api.get<KnowledgeSpace[]>("/api/knowledge-spaces"), []);
  useConfigChanged(["knowledge"], spaces.reload);
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
          知识空间存放团队共享资料。管理员都可以查看和编辑；AI 员工需要在配置中选择空间才能读取。
        </span>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
          新建知识空间
        </button>
      </div>
      <Loaded res={spaces}>
        {(rows) =>
          rows.length ? (
            <div className="split">
              <ResizeHandle name="knowledge" side="start" min={180} max={480} />
              <ul className="conn-list">
                {rows.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={`conn-item${s.id === selected ? " conn-on" : ""}`}
                      onClick={() => setSelected(s.id)}
                    >
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
            const out = await run(
              () => api.post<KnowledgeSpace>("/api/knowledge-spaces", { name: name.trim(), description }),
              "已创建",
            );
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
  return (
    <Section title={space.name}>
      {space.description ? <p className="small muted">{space.description}</p> : null}
      <MemoryList
        query={{ scope: "team", space_id: space.id }}
        create={{ scope: "team", space_id: space.id }}
        placeholder="一条共享资料"
        emptyTitle="空间里还没有内容"
        itemName="资料"
      />
    </Section>
  );
}

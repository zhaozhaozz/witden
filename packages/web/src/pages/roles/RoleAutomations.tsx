import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useResource } from "../../lib/hooks";
import { useAction } from "../../ui/feedback";
import { Empty, Loaded, Section, Tag } from "../../ui/kit";

interface Rule {
  id: string;
  topic_id: string;
  topic_title: string;
  name: string;
  kind: string;
  enabled: boolean;
}
export function RoleAutomations({ roleId }: { roleId: string }) {
  const res = useResource(() => api.get<Rule[]>("/api/automations", { role_id: roleId }), [roleId]);
  const { run, busy } = useAction();
  return (
    <Section title="负责的触发器">
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <ul className="task-cards">
              {rows.map((r) => (
                <li className="task-card" key={r.id}>
                  <strong>{r.name}</strong> <Tag tone={r.enabled ? "ok" : "off"}>{r.enabled ? "启用" : "停用"}</Tag>
                  <p className="small">
                    <Link to={`/topics/${r.topic_id}`}>{r.topic_title}</Link> ·{" "}
                    {r.kind === "schedule" ? "定时" : "Webhook"}
                  </p>
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await run(() =>
                          api.patch(`/api/topics/${r.topic_id}/triggers/${r.id}`, { enabled: !r.enabled }),
                        )
                      )
                        void res.reload();
                    }}
                  >
                    {r.enabled ? "停用" : "启用"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="没有负责的触发器" hint="在话题右侧栏的“触发器”中把这个角色设为处理角色。" />
          )
        }
      </Loaded>
    </Section>
  );
}

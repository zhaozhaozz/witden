import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Memory } from "../api/types";
import { fmtRelative } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useAuth } from "../lib/session";
import { useAction, useFeedback } from "../ui/feedback";
import { Avatar, Empty, KV, Loaded, PageHeader, Section, Tag } from "../ui/kit";

export default function MePage() {
  const { me } = useAuth();
  const { confirm, toast } = useFeedback();
  const { run, busy } = useAction();
  const [text, setText] = useState("");
  const notes = useResource(() => api.get<Memory[]>("/api/memories", { scope: "user" }), []);

  if (!me) return null;

  return (
    <div className="page">
      <PageHeader
        title={
          <span className="title-with-avatar">
            <Avatar id={me.id} name={me.name} kind="user" size={30} src={me.avatar_url} />
            {me.name}
          </span>
        }
        sub="你的账号、私密记忆，以及你目前拥有的权限。"
      />
      <div className="grid-2">
        <div>
          <Section title="账号">
            <KV
              items={[
                ["邮箱", me.email ?? "—"],
                [
                  "身份",
                  <Tag key="r" tone="accent">
                    管理员
                  </Tag>,
                ],
                ["我发起的任务", <Link to="/tasks">在任务页勾选「我发起的」查看</Link>],
              ]}
            />
          </Section>
          <Section title="我的权限">
            <p className="small">
              控制台账号都是管理员：可以配置角色、虚拟电脑和通讯接入，查看所有会话。外部成员（来自 Slack /
              飞书）不登录控制台。
            </p>
          </Section>
        </div>
        <div>
          <Section
            title="私密记忆"
            actions={
              <button
                type="button"
                className="btn btn-xs btn-danger-ghost"
                disabled={busy}
                onClick={async () => {
                  const ok = await confirm({
                    title: "让所有角色忘记我",
                    body: <p>删除所有角色为你保存的私密记忆。此操作不可撤销，不影响话题中的消息。</p>,
                    confirmLabel: "全部删除",
                    danger: true,
                  });
                  if (!ok) return;
                  const out = await run(() => api.post<{ deleted: number }>("/api/me/forget"));
                  if (out) {
                    toast(`已删除 ${out.deleted} 条私密记忆`, "ok");
                    notes.setData([]);
                  }
                }}
              >
                忘记我
              </button>
            }
          >
            <p className="small muted">
              只对你本人有效的偏好和资料，例如称呼、常用格式。只有你自己能看到，角色在为你工作时才会使用，不会带入其他人的请求或群组回答。
            </p>
            <form
              className="note-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const m = await run(
                  () => api.post<Memory>("/api/memories", { scope: "user", content: text.trim() }),
                  "已保存",
                );
                if (m) {
                  setText("");
                  notes.setData((p) => [m, ...(p ?? [])]);
                }
              }}
            >
              <textarea
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="例如：周报请用表格，结论放在最前面"
              />
              <button type="submit" className="btn btn-xs btn-primary" disabled={busy || !text.trim()}>
                添加
              </button>
            </form>
            <Loaded res={notes}>
              {(rows) =>
                rows.length ? (
                  <ul className="memory-list">
                    {rows.map((m) => (
                      <li key={m.id}>
                        <div className="memory-text">{m.content}</div>
                        <div className="small muted">
                          {m.created_by_type === "role" ? "角色为你记录" : "你自己添加"} · {fmtRelative(m.created_at)}
                          <button
                            type="button"
                            className="link-btn"
                            onClick={async () => {
                              const ok = await run(() => api.del(`/api/memories/${m.id}`));
                              if (ok) notes.setData((p) => p?.filter((x) => x.id !== m.id));
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty title="没有私密记忆" />
                )
              }
            </Loaded>
          </Section>
        </div>
      </div>
    </div>
  );
}

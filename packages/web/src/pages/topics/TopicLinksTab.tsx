import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useLiveEvents } from "../../api/events";
import type { Topic } from "../../api/types";
import { PLATFORM_LABEL } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useAction, useFeedback } from "../../ui/feedback";
import { Empty, Field, Loaded, Tag } from "../../ui/kit";

interface TopicLink {
  id: string;
  topic_id: string;
  title: string;
  goal: string;
  kind: string;
  status: string;
  external: boolean;
  source: string;
  roles: { id: string; handle: string; name: string }[];
}

export function TopicLinksTab({ topic }: { topic: Topic }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const links = useResource(() => api.get<TopicLink[]>(`/api/topics/${topic.id}/links`), [topic.id]);
  const choices = useResource(() => api.get<Topic[]>("/api/topics", { q: search }), [search]);
  useLiveEvents({ topic_id: topic.id }, (type) => {
    if (type === "topic.links_changed") void links.reload();
  });
  const { run, busy } = useAction();
  const { confirm } = useFeedback();
  const existing = new Set((links.data ?? []).map((l) => l.topic_id));
  // A link joins an external conversation (Slack, Feishu, GitHub) and an internal topic: only the other kind is
  // offered. A console DM is internal; a direct conversation between two AI employees is never linked.
  const external = !!topic.channel;
  const options = (choices.data ?? []).filter(
    (t) => t.id !== topic.id && !existing.has(t.id) && !!t.channel !== external && t.kind !== "pair",
  );
  const add = async () => {
    const target = options.find((t) => t.id === selected);
    if (!target) return;
    const privateLink = topic.kind === "dm" || target.kind === "dm";
    if (
      privateLink &&
      !(await confirm({
        title: "允许这个私信与所选话题通信？",
        body: (
          <p>AI 员工可以主动将必要消息发送到对方。这不会开放私信完整历史，但被发送的内容会对接收话题的成员可见。</p>
        ),
        confirmLabel: "确认关联",
        cancelLabel: "返回",
      }))
    )
      return;
    const result = await run(
      () =>
        api.post(`/api/topics/${topic.id}/links`, {
          topic_id: target.id,
          confirm_private: privateLink,
        }),
      "话题已关联",
    );
    if (result) {
      setSelected("");
      void links.reload();
    }
  };
  return (
    <div className="settings">
      <p className="small muted">
        关联只能建立在外部会话（Slack、飞书、GitHub）和内部话题之间：外部会话的机器人代表的 AI
        员工把需要处理的工作发给关联的内部话题，由那里的 AI 员工完成，再把进展和结果发回外部会话。AI
        员工根据工作需要主动发送，普通聊天不会自动转发，双方上下文不会合并。
      </p>
      <Loaded res={links}>
        {(rows) =>
          rows.length ? (
            <ul className="task-cards">
              {rows.map((link) => (
                <li key={link.id} className="task-card">
                  <div className="task-card-head">
                    <Link to={`/topics/${link.topic_id}`}>{link.title}</Link>
                    <Tag>{link.external ? "外部发布" : "内部协作"}</Tag>
                  </div>
                  {link.goal ? (
                    <p className="small clamp-1" title={link.goal}>
                      {link.goal}
                    </p>
                  ) : null}
                  <p className="small muted">
                    {link.external
                      ? "收到发送的消息后同步到外部平台，不再次运行机器人。"
                      : "收到发送的消息后交给话题中的 AI 员工处理。"}
                  </p>
                  <p className="small muted">
                    {link.roles.map((r) => `@${r.handle}`).join("、") || "暂无可用 AI 员工"}
                    {link.status !== "active" ? " · 已归档" : ""}
                  </p>
                  <button
                    type="button"
                    className="btn btn-xs btn-danger-ghost"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        !(await confirm({
                          title: `解除与「${link.title}」的关联？`,
                          body: (
                            <p>
                              之后双方不能再互相发送。历史消息保留；对方还没读到的关联消息作废，由关联请求开始的独立任务结束。
                            </p>
                          ),
                          confirmLabel: "解除",
                          cancelLabel: "返回",
                        }))
                      )
                        return;
                      if (await run(() => api.del(`/api/topics/${topic.id}/links/${link.id}`), "已解除关联"))
                        void links.reload();
                    }}
                  >
                    解除关联
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              title="尚未关联其他话题"
              hint={
                external
                  ? "选择一个内部话题或控制台私信，建立双向消息通道。"
                  : "选择一个 Slack、飞书或 GitHub 会话，建立双向消息通道。"
              }
            />
          )
        }
      </Loaded>
      <section className="settings-block">
        <h4>添加关联</h4>
        <Field label="搜索话题">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected("");
            }}
            placeholder="按话题名称搜索"
          />
        </Field>
        <Loaded res={choices}>
          {() => (
            <Field label="目标话题" hint={external ? "只列出内部话题" : "只列出外部会话"}>
              <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                <option value="">请选择</option>
                {options.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                    {t.kind === "dm" ? "（私信）" : ""}
                    {t.channel ? ` · ${PLATFORM_LABEL[t.channel.platform] ?? t.channel.platform}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </Loaded>
        <p className="small muted">
          关联后，外部会话中机器人代表的 AI
          员工可以把请求交给内部话题，并查看内部话题的工作状态（进行中的工作和结果摘录），外部会话中的人可能因此看到这些内容。
        </p>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || !selected || topic.status !== "active"}
          onClick={add}
        >
          关联话题
        </button>
      </section>
    </div>
  );
}

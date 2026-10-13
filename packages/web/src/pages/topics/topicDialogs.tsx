import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import type { ExternalConversation, PublishableConnection, PublishResult, Topic } from "../../api/types";
import { CONVERSATION_KIND, PLATFORM_LABEL } from "../../lib/format";
import { useAuth, useDirectory } from "../../lib/session";
import { useAction, useFeedback, withConfirmation } from "../../ui/feedback";
import { Field, FieldGroup, FormModal, MultiPick } from "../../ui/kit";

export function NewTopicDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: Topic) => void }) {
  const { me } = useAuth();
  const dir = useDirectory();
  const { run, busy } = useAction();
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [userIds, setUserIds] = useState<string[]>([]);
  const [roleIds, setRoleIds] = useState<string[]>([]);

  const submit = async () => {
    const t = await run(
      () =>
        api.post<Topic>("/api/topics", {
          title: title.trim(),
          goal,
          user_ids: userIds,
          role_ids: roleIds,
        }),
      "话题已创建",
    );
    if (t) onCreated(t);
  };

  return (
    <FormModal
      title="新建话题"
      submitLabel="创建话题"
      busy={busy}
      disabled={!title.trim()}
      onClose={onClose}
      onSubmit={submit}
      width={640}
    >
      <Field label="标题">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：十月版本发布准备"
          autoFocus
        />
      </Field>
      <Field label="目标" hint="写清楚要完成什么，角色会把它当作这个话题的工作背景。">
        <textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
      </Field>
      <FieldGroup label="邀请成员" hint="只有参与者能看到这个话题；参与者可以阅读全部历史，包括加入之前的消息。" wide>
        <MultiPick
          columns={3}
          options={dir.users.filter((u) => u.id !== me?.id && u.is_active).map((u) => ({ value: u.id, label: u.name }))}
          value={userIds}
          onChange={setUserIds}
          empty="团队里还没有其他成员"
        />
      </FieldGroup>
      <FieldGroup
        label="邀请角色"
        hint="角色默认只在被 @ 时回应；话题建好后可以在顶部或「设置」里切换成自动模式。"
        wide
      >
        <MultiPick
          columns={2}
          options={dir.roles
            .filter((r) => r.status === "active")
            .map((r) => ({
              value: r.id,
              label: `${r.name} @${r.handle}`,
              hint: r.instance ? `虚拟电脑 ${r.instance.name}` : "未分配虚拟电脑",
            }))}
          value={roleIds}
          onChange={setRoleIds}
          empty="你还没有可以使用的角色"
        />
      </FieldGroup>
    </FormModal>
  );
}

export function OpenDmDialog({ onClose }: { onClose: () => void }) {
  const dir = useDirectory();
  const nav = useNavigate();
  const { run, busy } = useAction();
  const [roleId, setRoleId] = useState("");
  const roles = dir.roles.filter((r) => r.status === "active");
  return (
    <FormModal
      title="与角色私信"
      submitLabel="打开私信"
      busy={busy}
      disabled={!roleId}
      onClose={onClose}
      onSubmit={async () => {
        const t = await run(() => api.post<Topic>("/api/dms", { role_id: roleId }));
        if (t) {
          onClose();
          nav(`/topics/${t.id}`);
        }
      }}
    >
      <p className="muted">私信只属于你和这个角色。即使同一个角色也在群组话题中工作，私信内容也不会自动带入群组。</p>
      <Field label="角色">
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)} autoFocus>
          <option value="">选择角色</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} @{r.handle}
            </option>
          ))}
        </select>
      </Field>
      {!roles.length ? <p className="small muted">没有可用的角色。需要管理员授予「使用角色」权限。</p> : null}
    </FormModal>
  );
}

export function InviteDialog({
  topic,
  onClose,
  onDone,
}: {
  topic: Topic;
  onClose: () => void;
  onDone: (t: Topic) => void;
}) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const [type, setType] = useState<"role" | "user">("role");
  const [id, setId] = useState("");
  const present = new Set((topic.participants ?? []).map((p) => `${p.type}:${p.id}`));
  const roles = dir.roles.filter((r) => r.status === "active" && !present.has(`role:${r.id}`));
  const users = dir.users.filter((u) => u.is_active && !present.has(`user:${u.id}`));
  const canAddUsers = topic.kind === "group";

  return (
    <FormModal
      title="邀请加入话题"
      submitLabel="邀请"
      busy={busy}
      disabled={!id}
      onClose={onClose}
      onSubmit={async () => {
        const t = await run(() => api.post<Topic>(`/api/topics/${topic.id}/participants`, { type, id }), "已邀请");
        if (t) onDone(t);
      }}
    >
      <div className="segmented">
        <button
          type="button"
          className={type === "role" ? "seg seg-on" : "seg"}
          onClick={() => (setType("role"), setId(""))}
        >
          角色
        </button>
        <button
          type="button"
          className={type === "user" ? "seg seg-on" : "seg"}
          disabled={!canAddUsers}
          title={canAddUsers ? undefined : "私信不能添加成员"}
          onClick={() => (setType("user"), setId(""))}
        >
          成员
        </button>
      </div>
      <Field label={type === "role" ? "角色" : "成员"}>
        <select value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">请选择</option>
          {type === "role"
            ? roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} @{r.handle}
                </option>
              ))
            : users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
        </select>
      </Field>
      <p className="small muted">
        新加入者可以阅读这个话题的全部历史，包括加入之前的消息；被移除后将无法再访问这个话题。
      </p>
    </FormModal>
  );
}

const CHANNEL_HINT: Record<string, string> = {
  slack: "Slack 频道 ID，例如 C0123456。",
  feishu: "飞书群聊 ID（chat_id，oc_ 开头）。",
};

/**
 * Publish an internal topic to a channel of a chat connection. The server refuses with
 * `audience_expansion` when the channel's audience is wider than the topic's readers; publishing then
 * needs explicit confirmation. Private channels additionally require the publisher to be a verified member.
 */
export function PublishDialog({
  topic,
  onClose,
  onPublished,
}: {
  topic: Topic;
  onClose: () => void;
  onPublished?: () => void;
}) {
  const { can } = useAuth();
  const { confirm, toast } = useFeedback();
  const { run, busy } = useAction();
  const [connections, setConnections] = useState<PublishableConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [conversations, setConversations] = useState<ExternalConversation[]>([]);
  const [channelId, setChannelId] = useState("");
  const platform = connections?.find((c) => c.id === connectionId)?.platform ?? "";

  useEffect(() => {
    // Only connections this user holds topic.publish on (no credentials or settings are returned).
    api
      .get<PublishableConnection[]>("/api/connections/publishable")
      .then((rows) => {
        setConnections(rows);
        if (rows.length === 1) setConnectionId(rows[0].id);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    setConversations([]);
    setChannelId("");
    // Listing known conversations needs connection.manage; everyone else types the channel id.
    if (!connectionId || !can("connection.manage")) return;
    api
      .get<ExternalConversation[]>(`/api/connections/${connectionId}/conversations`)
      .then((rows) => setConversations(rows.filter((c) => c.kind === "public" || c.kind === "private")))
      .catch(() => setConversations([]));
  }, [connectionId, can]);

  const submit = async () => {
    const out = await run(() =>
      withConfirmation(
        confirm,
        (confirmed) =>
          api.post<PublishResult>(`/api/topics/${topic.id}/publish`, {
            connection_id: connectionId,
            channel_id: channelId.trim(),
            confirm_expand_audience: confirmed,
          }),
        (err) => ({
          title: "发布会让更多人看到这个话题",
          danger: true,
          confirmLabel: "仍然发布",
          body: (
            <>
              <p>
                频道里的成员比当前能看到这个话题的人更多，原本只有少数人可见的内容会因此对他们可见。发布不会复制已有的历史消息，但之后的交流会同步到频道。
              </p>
              {err.detail.channel_kind ? (
                <p className="small">
                  频道类型：{CONVERSATION_KIND[String(err.detail.channel_kind)] ?? String(err.detail.channel_kind)}
                </p>
              ) : null}
              {err.detail.channel_audience ? (
                <p className="small">
                  频道可见范围：<code className="id">{String(err.detail.channel_audience)}</code>
                </p>
              ) : null}
            </>
          ),
        }),
        ["audience_expansion"],
      ),
    );
    if (out !== undefined) {
      toast(`已发布到${PLATFORM_LABEL[platform] ?? "外部"}频道，后续在对应 thread 中继续交流`, "ok");
      onPublished?.();
      onClose();
    }
  };

  return (
    <FormModal
      title="发布到外部频道"
      submitLabel="发布"
      busy={busy}
      disabled={!connectionId || !channelId.trim()}
      onClose={onClose}
      onSubmit={submit}
    >
      <p className="muted">
        发布后会在所选频道创建一条主消息，话题之后的交流同步到这个
        thread；已有的历史消息不会被复制。发布前会检查频道可见范围，不会自动公开原本仅少数人可见的内容；发布到私有频道需要你是该频道已验证的成员。
      </p>
      {loadError ? (
        <Field label="通讯接入 ID" hint="无法加载可用接入列表，可直接填写管理员授权给你的接入 ID（conn_…）。">
          <input className="mono" value={connectionId} onChange={(e) => setConnectionId(e.target.value.trim())} />
        </Field>
      ) : (
        <Field label="通讯接入">
          <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">选择接入</option>
            {(connections ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（{PLATFORM_LABEL[c.platform] ?? c.platform}）
              </option>
            ))}
          </select>
        </Field>
      )}
      {connections && !connections.length ? (
        <p className="small muted">
          没有你可以发布到的通讯接入（需要管理员授予该接入的「发布话题到外部频道」权限，且接入处于启用状态）。
        </p>
      ) : null}
      <Field
        label="频道"
        hint={`${CHANNEL_HINT[platform] ?? "频道或群聊 ID。"}${conversations.length ? "也可以从已同步的会话中选择。" : ""}`}
      >
        <input
          list="publish-channels"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          placeholder="频道 ID"
        />
        <datalist id="publish-channels">
          {conversations.map((c) => (
            <option key={c.id} value={c.external_id}>
              {c.name ?? c.external_id}（{CONVERSATION_KIND[c.kind] ?? c.kind}）
            </option>
          ))}
        </datalist>
      </Field>
    </FormModal>
  );
}

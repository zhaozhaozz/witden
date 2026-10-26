import { type ReactNode, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import type { Role, Topic } from "../../api/types";
import { useAuth, useDirectory } from "../../lib/session";
import { useAction } from "../../ui/feedback";
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
      <Field
        label="目标"
        hint="这个话题是做什么的、工作有哪些要求；这里的每位 AI 员工都会读到，自动模式下调度模型也会参考。"
      >
        <textarea rows={3} maxLength={16000} value={goal} onChange={(e) => setGoal(e.target.value)} />
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
      <FieldGroup label="邀请 AI 员工" hint="AI 员工默认只在被 @ 时回应；话题建好后可以在顶部切换成自动模式。" wide>
        <MultiPick
          columns={2}
          options={dir.roles
            .filter((r) => r.status === "active")
            .map((r) => ({
              value: r.id,
              label: `${r.name} @${r.handle}`,
              hint: roleHint(r),
            }))}
          value={roleIds}
          onChange={setRoleIds}
          empty="你还没有可以使用的 AI 员工"
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
      title="与 AI 员工私信"
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
      <p className="muted">
        私信只属于你和这位 AI 员工。即使同一位 AI 员工也在群组话题中工作，私信内容也不会自动带入群组。
      </p>
      <FieldGroup label="AI 员工">
        {roles.length ? (
          <RolePick roles={roles} value={roleId} onChange={setRoleId} />
        ) : (
          <span className="small muted">没有可用的 AI 员工。需要管理员授予「使用 AI 员工」权限。</span>
        )}
      </FieldGroup>
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
  // A Slack, Feishu or GitHub conversation has one role, the one handling it (its settings): only people are added.
  const external = !!topic.channel;
  const [type, setType] = useState<"role" | "user">(external ? "user" : "role");
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
          disabled={external}
          title={external ? "外部会话中只有处理它的 AI 员工工作，不能邀请其他 AI 员工" : undefined}
          onClick={() => (setType("role"), setId(""))}
        >
          AI 员工
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
      {type === "role" ? (
        <FieldGroup label="AI 员工">
          {roles.length ? (
            <RolePick roles={roles} value={id} onChange={setId} />
          ) : (
            <span className="small muted">没有可以邀请的 AI 员工</span>
          )}
        </FieldGroup>
      ) : (
        <Field label="成员">
          <select value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">请选择</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <p className="small muted">
        新加入者可以阅读这个话题的全部历史，包括加入之前的消息；被移除后将无法再访问这个话题。
      </p>
    </FormModal>
  );
}

/** Under an AI employee's name in a picker: its 职责说明 (two lines, all of it on hover) and its computer. */
function roleHint(r: Role): ReactNode {
  return (
    <>
      {r.description ? (
        <span className="clamp-2" title={r.description}>
          {r.description}
        </span>
      ) : null}
      <span>{r.instance ? `虚拟电脑 ${r.instance.name}` : "未分配虚拟电脑"}</span>
    </>
  );
}

/** Choose one AI employee by what it does: the same rows as the new topic dialog, as radio buttons. */
function RolePick({ roles, value, onChange }: { roles: Role[]; value: string; onChange: (id: string) => void }) {
  const name = useId();
  return (
    <div className="pick pick-roles" role="radiogroup" aria-label="AI 员工">
      {roles.map((r) => (
        <label key={r.id} className={`pick-item${value === r.id ? " pick-on" : ""}`}>
          <input type="radio" name={name} checked={value === r.id} onChange={() => onChange(r.id)} />
          <span className="pick-text">
            <span>
              {r.name} @{r.handle}
            </span>
            <span className="pick-hint">{roleHint(r)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

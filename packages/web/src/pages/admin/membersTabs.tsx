import { useState } from "react";
import { api } from "../../api/client";
import type { User } from "../../api/types";
import { fmtRelative } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import { Avatar, Field, FormModal, Loaded, Tag } from "../../ui/kit";

export function MembersTab() {
  const { me } = useAuth();
  const dir = useDirectory();
  const { confirm } = useFeedback();
  const { run } = useAction();
  const res = useResource(() => api.get<User[]>("/api/users"), []);
  const [editing, setEditing] = useState<User | "new" | null>(null);

  return (
    <>
      <div className="toolbar">
        <span className="small muted">
          能登录控制台的账号都是管理员，可以配置角色和虚拟电脑、查看所有会话。外部成员来自 Slack / 飞书，不登录控制台。
        </span>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
          添加管理员
        </button>
      </div>
      <Loaded res={res}>
        {(rows) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>邮箱</th>
                  <th>身份</th>
                  <th>状态</th>
                  <th>加入</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id} className={u.is_active ? undefined : "row-muted"}>
                    <td>
                      <span className="role-cell">
                        <Avatar id={u.id} name={u.name} kind="user" size={26} src={u.avatar_url} />
                        <span className="strong">{u.name}</span>
                        {u.id === me?.id ? <span className="muted small">（你）</span> : null}
                      </span>
                    </td>
                    <td>
                      {u.email ?? <span className="muted">{u.external_connection_id ? "—（不登录控制台）" : "—"}</span>}
                    </td>
                    <td>
                      {u.is_admin ? (
                        <Tag tone="accent">管理员</Tag>
                      ) : u.external_connection_id ? (
                        <Tag title="来自 Slack / 飞书 的外部成员：只能使用该接入允许的角色">外部成员</Tag>
                      ) : (
                        "成员"
                      )}
                    </td>
                    <td>{u.is_active ? <Tag tone="ok">在职</Tag> : <Tag tone="off">已停用</Tag>}</td>
                    <td className="nowrap">{u.created_at ? fmtRelative(u.created_at) : "—"}</td>
                    <td className="nowrap">
                      <div className="btn-row">
                        <button type="button" className="btn btn-xs" onClick={() => setEditing(u)}>
                          编辑
                        </button>
                        {u.id !== me?.id ? (
                          <button
                            type="button"
                            className={u.is_active ? "btn btn-xs btn-danger-ghost" : "btn btn-xs"}
                            onClick={async () => {
                              if (u.is_active) {
                                const ok = await confirm({
                                  title: `停用 ${u.name}`,
                                  body: (
                                    <p>停用后立即失去访问：登录令牌失效，由他发起的进行中工作会被重新检查并停止。</p>
                                  ),
                                  confirmLabel: "停用",
                                  danger: true,
                                });
                                if (!ok) return;
                              }
                              const out = await run(
                                () => api.patch<User>(`/api/users/${u.id}`, { is_active: !u.is_active }),
                                u.is_active ? "已停用" : "已恢复",
                              );
                              if (out) {
                                res.setData((p) => p?.map((x) => (x.id === out.id ? out : x)));
                                void dir.reload();
                              }
                            }}
                          >
                            {u.is_active ? "停用" : "恢复"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Loaded>
      {editing ? (
        <UserEditor
          user={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void res.reload();
            void dir.reload();
          }}
        />
      ) : null}
    </>
  );
}

function UserEditor({ user, onClose, onSaved }: { user: User | null; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  return (
    <FormModal
      title={user ? `编辑 ${user.name}` : "添加管理员"}
      busy={busy}
      disabled={!name.trim() || (!user && !email.trim())}
      onClose={onClose}
      onSubmit={async () => {
        const body: Record<string, unknown> = { name: name.trim() };
        if (password) body.password = password;
        if (!user) body.email = email.trim();
        const out = await run(
          () => (user ? api.patch(`/api/users/${user.id}`, body) : api.post("/api/users", body)),
          user ? "已保存" : "管理员已添加",
        );
        if (out) onSaved();
      }}
    >
      <Field label="姓名" hint="在话题中用 @姓名 提及（不含空格）">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {!user ? (
        <Field label="邮箱" hint="用于登录">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      ) : null}
      {user?.external_connection_id ? (
        <p className="small muted">
          外部成员来自 Slack / 飞书 接入，不登录控制台，只能使用该接入允许的角色（在“通讯接入”中设置）。
        </p>
      ) : (
        <Field label={user ? "重置密码" : "初始密码"} hint={user ? "留空保持不变" : undefined}>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      )}
    </FormModal>
  );
}

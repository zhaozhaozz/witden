import { useMemo, useState } from "react";
import { api } from "../../api/client";
import type {
  Connection,
  Grant,
  Instance,
  KnowledgeSpace,
  ModelConfig,
  PermissionInfo,
  Topic,
  User,
} from "../../api/types";
import { fmtDateTime, fmtRelative, permissionLabel } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useAuth, useDirectory } from "../../lib/session";
import { useAction, useFeedback } from "../../ui/feedback";
import { Avatar, Empty, Field, FormModal, Loaded, Tag, Toggle } from "../../ui/kit";

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
        <span className="small muted">新成员默认没有任何权限，需要在「授权」中逐项开放。</span>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
          添加成员
        </button>
      </div>
      <Loaded res={res}>
        {(rows) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>成员</th>
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
                    <td>{u.email ?? <span className="muted">—（外部账号自动创建）</span>}</td>
                    <td>{u.is_admin ? <Tag tone="accent">管理员</Tag> : "成员"}</td>
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
  const { me } = useAuth();
  const { run, busy } = useAction();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(!!user?.is_admin);
  return (
    <FormModal
      title={user ? `编辑 ${user.name}` : "添加成员"}
      busy={busy}
      disabled={!name.trim() || (!user && !email.trim())}
      onClose={onClose}
      onSubmit={async () => {
        const body: Record<string, unknown> = { name: name.trim() };
        if (password) body.password = password;
        if (me?.is_admin && isAdmin !== !!user?.is_admin) body.is_admin = isAdmin;
        if (!user) {
          body.email = email.trim();
          body.is_admin = isAdmin;
        }
        const out = await run(
          () => (user ? api.patch(`/api/users/${user.id}`, body) : api.post("/api/users", body)),
          user ? "已保存" : "成员已添加",
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
      <Field label={user ? "重置密码" : "初始密码"} hint={user ? "留空保持不变" : undefined}>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Toggle
        checked={isAdmin}
        onChange={setIsAdmin}
        disabled={!me?.is_admin}
        label="管理员（拥有全部管理权限，但仍看不到他人的私信）"
      />
    </FormModal>
  );
}

// --- grants ------------------------------------------------------------------------------------------

const RESOURCE_LABEL: Record<string, string> = {
  "*": "全局",
  role: "角色",
  instance: "虚拟电脑",
  topic: "话题",
  space: "知识空间",
  model: "模型配置",
  connection: "通讯接入",
};

function useResourceNames() {
  const dir = useDirectory();
  const { can } = useAuth();
  const connections = useResource(
    () =>
      can("connection.manage")
        ? api.get<Connection[]>("/api/connections").catch(() => [] as Connection[])
        : Promise.resolve([] as Connection[]),
    [],
  );
  const instances = useResource(() => api.get<Instance[]>("/api/instances").catch(() => [] as Instance[]), []);
  const topics = useResource(
    () => api.get<Topic[]>("/api/topics", { include_archived: true }).catch(() => [] as Topic[]),
    [],
  );
  const spaces = useResource(
    () => api.get<KnowledgeSpace[]>("/api/knowledge-spaces").catch(() => [] as KnowledgeSpace[]),
    [],
  );
  const models = useResource(() => api.get<ModelConfig[]>("/api/models").catch(() => [] as ModelConfig[]), []);
  return useMemo(() => {
    const options: Record<string, { value: string; label: string }[]> = {
      role: dir.roles.map((r) => ({ value: r.id, label: `${r.name} @${r.handle}` })),
      instance: (instances.data ?? []).map((i) => ({ value: i.id, label: i.name })),
      topic: (topics.data ?? []).filter((t) => t.kind === "group").map((t) => ({ value: t.id, label: t.title })),
      space: (spaces.data ?? []).map((s) => ({ value: s.id, label: s.name })),
      model: (models.data ?? []).map((m) => ({ value: m.id, label: m.label })),
      connection: (connections.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    };
    const name = (type: string, id: string) =>
      id === "*" ? "全部" : (options[type]?.find((o) => o.value === id)?.label ?? id);
    return { options, name };
  }, [dir.roles, instances.data, topics.data, spaces.data, models.data, connections.data]);
}

export function GrantsTab() {
  const dir = useDirectory();
  const { confirm } = useFeedback();
  const { run } = useAction();
  const res = useResource(() => api.get<Grant[]>("/api/grants"), []);
  const perms = useResource(() => api.get<PermissionInfo[]>("/api/permissions"), []);
  const names = useResourceNames();
  const [adding, setAdding] = useState(false);
  const [userFilter, setUserFilter] = useState("");

  return (
    <>
      <div className="toolbar">
        <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} aria-label="按成员筛选">
          <option value="">全部授权</option>
          <option value="*">授予全体成员的</option>
          {dir.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <span className="small muted">撤销授权立即生效，进行中的任务和待发送的结果会被重新检查。</span>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
          添加授权
        </button>
      </div>
      <Loaded res={res}>
        {(rows) => {
          const list = rows.filter(
            (g) => !userFilter || (userFilter === "*" ? g.subject_type === "all" : g.subject_id === userFilter),
          );
          if (!list.length) return <Empty title="没有授权" hint="除管理员外，没有授权的成员只能参与被邀请的话题。" />;
          return (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>权限</th>
                    <th>授予</th>
                    <th>范围</th>
                    <th>时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((g) => (
                    <tr key={g.id}>
                      <td>
                        <span className="strong">{permissionLabel(g.permission)}</span>{" "}
                        <code className="id">{g.permission}</code>
                      </td>
                      <td>{g.subject_type === "all" ? <Tag tone="wait">全体成员</Tag> : dir.userName(g.subject_id)}</td>
                      <td>
                        {RESOURCE_LABEL[g.resource_type] ?? g.resource_type}
                        {g.resource_type !== "*" ? `：${names.name(g.resource_type, g.resource_id)}` : ""}
                      </td>
                      <td className="nowrap" title={fmtDateTime(g.created_at)}>
                        {fmtRelative(g.created_at)}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-xs btn-danger-ghost"
                          onClick={async () => {
                            const ok = await confirm({
                              title: "撤销授权",
                              body: (
                                <p>撤销「{permissionLabel(g.permission)}」后立即生效，相关的进行中任务会被重新检查。</p>
                              ),
                              confirmLabel: "撤销",
                              danger: true,
                            });
                            if (!ok) return;
                            const out = await run(() => api.del(`/api/grants/${g.id}`), "授权已撤销");
                            if (out) res.setData((p) => p?.filter((x) => x.id !== g.id));
                          }}
                        >
                          撤销
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Loaded>
      {adding ? (
        <GrantEditor
          perms={perms.data ?? []}
          options={names.options}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void res.reload();
          }}
        />
      ) : null}
    </>
  );
}

function GrantEditor({
  perms,
  options,
  onClose,
  onSaved,
}: {
  perms: PermissionInfo[];
  options: Record<string, { value: string; label: string }[]>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const [permission, setPermission] = useState(perms[0]?.permission ?? "");
  const [subject, setSubject] = useState("");
  const [resourceId, setResourceId] = useState("*");
  const rtype = perms.find((p) => p.permission === permission)?.resource_type ?? "*";
  const resOptions = options[rtype] ?? [];

  return (
    <FormModal
      title="添加授权"
      busy={busy}
      disabled={!permission}
      onClose={onClose}
      onSubmit={async () => {
        const out = await run(
          () =>
            api.post("/api/grants", {
              permission,
              user_id: subject || null,
              resource_id: rtype === "*" ? "*" : resourceId || "*",
            }),
          "授权已添加",
        );
        if (out) onSaved();
      }}
    >
      <Field label="权限">
        <select
          value={permission}
          onChange={(e) => {
            setPermission(e.target.value);
            setResourceId("*");
          }}
        >
          {perms.map((p) => (
            <option key={p.permission} value={p.permission}>
              {permissionLabel(p.permission)}（{p.permission}）
            </option>
          ))}
        </select>
      </Field>
      <Field label="授予给">
        <select value={subject} onChange={(e) => setSubject(e.target.value)}>
          <option value="">全体成员</option>
          {dir.users
            .filter((u) => u.is_active)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
        </select>
      </Field>
      {!subject ? (
        <p className="small text-wait">授予全体成员的权限对之后加入的新成员也生效，请只开放确实需要的范围。</p>
      ) : null}
      {rtype !== "*" ? (
        <Field label={`适用的${RESOURCE_LABEL[rtype] ?? rtype}`}>
          <select value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
            <option value="*">全部{RESOURCE_LABEL[rtype] ?? ""}</option>
            {resOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <p className="small muted">这是全局权限，不区分具体对象。</p>
      )}
    </FormModal>
  );
}

import { type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { Link, Navigate, NavLink, Outlet } from "react-router-dom";
import { api } from "./api/client";
import type { Approval, KillSwitch } from "./api/types";
import { useInterval } from "./lib/hooks";
import { ADMIN_PERMS, COMPUTER_PERMS } from "./lib/perms";
import { useAuth, useDirectory } from "./lib/session";
import { useTopics } from "./lib/topics";
import { useAction } from "./ui/feedback";
import { Avatar, Loading } from "./ui/kit";
import { ResizeHandle } from "./ui/resize";

/** Fired by pages that change kill switches so the global banner refreshes immediately. */
export const KILL_SWITCH_EVENT = "witden:kill-switch-changed";
/** Fired after approvals are decided so the nav badge refreshes. */
export const APPROVALS_EVENT = "witden:approvals-changed";

interface NavItem {
  to: string;
  label: string;
  any?: string[];
  badge?: number;
}

export function RequirePerm({ any }: { any: string[] }) {
  const { can } = useAuth();
  if (!any.some(can)) return <Navigate to="/topics" replace />;
  return <Outlet />;
}

function useKillSwitches(enabled: boolean) {
  const [active, setActive] = useState<KillSwitch[]>([]);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const rows = await api.get<KillSwitch[]>("/api/kill-switches");
      setActive(rows.filter((k) => k.active));
    } catch {
      // banner is best effort
    }
  }, [enabled]);
  useEffect(() => {
    void load();
    window.addEventListener(KILL_SWITCH_EVENT, load);
    return () => window.removeEventListener(KILL_SWITCH_EVENT, load);
  }, [load]);
  useInterval(load, 30_000, enabled);
  return active;
}

function usePendingApprovals() {
  const [count, setCount] = useState(0);
  const load = useCallback(async () => {
    try {
      const rows = await api.get<Approval[]>("/api/approvals", { status: "pending" });
      setCount(rows.filter((a) => a.can_decide).length);
    } catch {
      // badge is best effort
    }
  }, []);
  useEffect(() => {
    void load();
    window.addEventListener(APPROVALS_EVENT, load);
    return () => window.removeEventListener(APPROVALS_EVENT, load);
  }, [load]);
  useInterval(load, 30_000);
  return count;
}

const SCOPE_LABEL: Record<string, string> = {
  global: "全部 AI 执行",
  connection: "通讯接入",
  role: "角色",
  instance: "虚拟电脑",
  topic: "话题",
  task: "任务",
};

export default function Layout() {
  const { me, can, logout } = useAuth();
  const dir = useDirectory();
  const kills = useKillSwitches(can("emergency.stop"));
  const approvals = usePendingApprovals();

  const settings: NavItem[] = [
    { to: "/computers", label: "虚拟电脑", any: COMPUTER_PERMS },
    { to: "/roles", label: "角色管理", any: ["role.manage"] },
    { to: "/models", label: "模型", any: ["secrets.manage"] },
    { to: "/rules", label: "分配规则", any: ["rules.manage"] },
    { to: "/connections", label: "通讯接入", any: ["connection.manage"] },
    { to: "/admin", label: "系统管理", any: ADMIN_PERMS },
  ].filter((i) => !i.any || i.any.some(can));

  const globalStop = kills.find((k) => k.scope === "global");

  return (
    <div className="app">
      <ResizeHandle name="nav" side="start" min={150} max={360} />
      <aside className="sidebar">
        <Link to="/topics" className="brand">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          <span>witden</span>
        </Link>
        <nav className="nav">
          <div className="nav-group">
            <NavLink to="/tasks" className={navClass}>
              <span>任务</span>
            </NavLink>
            <NavLink to="/approvals" className={navClass}>
              <span>审批</span>
              {approvals ? <span className="nav-badge">{approvals}</span> : null}
            </NavLink>
          </div>
          <TopicList />
          <RoleList />
          {settings.length ? (
            <SideSection id="settings" title="设置">
              {settings.map((i) => (
                <NavLink key={i.to} to={i.to} className={navClass}>
                  <span>{i.label}</span>
                </NavLink>
              ))}
            </SideSection>
          ) : null}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/me" className={({ isActive }) => (isActive ? "me-link nav-on" : "me-link")}>
            {me ? <Avatar id={me.id} name={me.name} kind="user" size={26} src={me.avatar_url} /> : null}
            <span className="me-name">
              <span>{me?.name}</span>
              <span className="muted small">{me?.is_admin ? "管理员" : "成员"}</span>
            </span>
          </NavLink>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              void logout();
            }}
          >
            退出
          </button>
        </div>
      </aside>
      <div className="main">
        {kills.length ? (
          <div className={`killbar${globalStop ? " killbar-global" : ""}`} role="alert">
            <strong>紧急停止生效中</strong>
            <span>
              {kills
                .map((k) => {
                  const scope = SCOPE_LABEL[k.scope] ?? k.scope;
                  const target = k.scope === "role" ? dir.roleLabel(k.target_id) : k.target_id ? k.target_id : "";
                  return `${scope}${target ? ` ${target}` : ""}${k.reason ? `（${k.reason}）` : ""}`;
                })
                .join("；")}
            </span>
            <Link to="/admin?tab=emergency" className="killbar-link">
              查看与解除
            </Link>
          </div>
        ) : null}
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? "nav-item nav-on" : "nav-item");

const COLLAPSED_KEY = "witden.sidebar.collapsed";

/** A collapsible sidebar section (remembered per section), with an optional action such as "new". */
function SideSection({
  id,
  title,
  to,
  action,
  children,
}: {
  id: string;
  title: string;
  /** The title also links to a page listing everything (e.g. all topics). */
  to?: string;
  action?: { label: string; title: string; onClick: () => void };
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return !!JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}")[id];
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed((c) => {
      try {
        const all = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify({ ...all, [id]: !c }));
      } catch {
        // not remembered
      }
      return !c;
    });
  };
  return (
    <div className={`side-section${collapsed ? " side-collapsed" : ""}`}>
      <div className="side-head">
        <button
          type="button"
          className="side-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
          title={collapsed ? "展开" : "收起"}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        {to ? (
          <Link to={to} className="side-title" title={`查看全部${title}`}>
            {title}
          </Link>
        ) : (
          <button type="button" className="side-title" onClick={toggle}>
            {title}
          </button>
        )}
        {action ? (
          <button
            type="button"
            className="side-action"
            title={action.title}
            aria-label={action.title}
            onClick={action.onClick}
          >
            +
          </button>
        ) : null}
      </div>
      {collapsed ? null : <div className="side-body">{children}</div>}
    </div>
  );
}

const MAX_TOPICS = 40;

/** Group topics, most recent activity first; unread ones in bold. */
function TopicList() {
  const { can } = useAuth();
  const t = useTopics();
  const topics = t.topics.filter((x) => x.kind === "group" && x.status === "active" && x.can_view !== false);
  return (
    <SideSection
      id="topics"
      title="话题"
      to="/topics"
      action={can("topic.create") ? { label: "+", title: "新建话题", onClick: t.newTopic } : undefined}
    >
      {topics.slice(0, MAX_TOPICS).map((x) => (
        <NavLink
          key={x.id}
          to={`/topics/${x.id}`}
          className={({ isActive }) =>
            `nav-item side-item${isActive ? " nav-on" : ""}${t.unread(x) ? " side-unread" : ""}`
          }
          title={x.title}
        >
          <span className="side-icon" aria-hidden>
            {x.visibility === "internal" ? "#" : <LockIcon />}
          </span>
          <span className="side-label">{x.title}</span>
          {t.unread(x) ? <span className="side-dot" role="img" aria-label="有新消息" /> : null}
        </NavLink>
      ))}
      {t.loaded && !topics.length ? <div className="side-empty">还没有话题</div> : null}
      {topics.length > MAX_TOPICS ? (
        <Link to="/topics" className="nav-item side-item side-more">
          查看全部 {topics.length} 个话题
        </Link>
      ) : null}
    </SideSection>
  );
}

/** The roles you can talk to: one click opens (or starts) your DM with the role. */
function RoleList() {
  const dir = useDirectory();
  const t = useTopics();
  const { can } = useAuth();
  const { run } = useAction();
  const canEdit = can("role.manage");
  const dmOf = new Map(t.topics.filter((x) => x.kind === "dm" && x.dm_role_id).map((x) => [x.dm_role_id as string, x]));
  const roles = dir.roles.filter((r) => r.status === "active").sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return (
    <SideSection id="roles" title="角色" action={{ label: "+", title: "与角色私信", onClick: t.pickDm }}>
      {roles.map((r) => {
        const dm = dmOf.get(r.id);
        const on = !!dm && dm.id === t.activeId;
        const unread = !!dm && t.unread(dm);
        const online = r.instance?.status === "running";
        // The edit shortcut sits next to the item (a link cannot live inside a button) and shows on hover.
        return (
          <div key={r.id} className={`side-row${canEdit ? " side-row-edit" : ""}`}>
            <button
              type="button"
              className={`nav-item side-item${on ? " nav-on" : ""}${unread ? " side-unread" : ""}`}
              title={`与 ${r.name} @${r.handle} 私信${r.instance ? `（虚拟电脑 ${r.instance.name}${online ? "" : "，未运行"}）` : ""}`}
              onClick={() => void run(() => t.openDm(r.id))}
            >
              <span className="side-avatar">
                <Avatar id={r.id} name={r.name} kind="role" size={20} src={r.avatar_url} color={r.color} />
                <span className={`side-presence${online ? " side-online" : ""}`} aria-hidden />
              </span>
              <span className="side-label">{r.name}</span>
              {unread ? <span className="side-dot" role="img" aria-label="有新消息" /> : null}
            </button>
            {canEdit ? (
              <Link
                to={`/roles/${r.id}`}
                className="side-quick"
                title={`编辑角色 ${r.name}`}
                aria-label={`编辑角色 ${r.name}`}
              >
                <PencilIcon />
              </Link>
            ) : null}
          </div>
        );
      })}
      {!roles.length ? <div className="side-empty">没有可用的角色</div> : null}
    </SideSection>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M11.2 2.3a1.5 1.5 0 0 1 2.1 0l.4.4a1.5 1.5 0 0 1 0 2.1L6 12.5l-3.2.9.9-3.2 7.5-7.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M9.8 3.8l2.4 2.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
      <rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="currentColor" />
      <path d="M3.8 5.5V4a2.2 2.2 0 0 1 4.4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

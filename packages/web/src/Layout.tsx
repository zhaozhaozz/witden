import { type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api/client";
import { APPROVALS_EVENT } from "./api/events";
import type { Approval, KillSwitch, Topic } from "./api/types";
import { connectionLabel, conversationIcon, conversationKind, sourceOf } from "./lib/conversations";
import { useInterval } from "./lib/hooks";
import { ADMIN_PERMS, COMPUTER_PERMS } from "./lib/perms";
import { useAuth, useDirectory } from "./lib/session";
import { isWebDm, useTopics } from "./lib/topics";
import { PageErrorBoundary } from "./ui/ErrorBoundary";
import { useAction } from "./ui/feedback";
import { Icon, type IconName } from "./ui/Icon";
import { Avatar, ComputerChip, Loading, RoleChip } from "./ui/kit";
import { ResizeHandle } from "./ui/resize";

/** Fired by pages that change kill switches so the global banner refreshes immediately. */
export const KILL_SWITCH_EVENT = "witden:kill-switch-changed";

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
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

/** A fresh platform (no roles yet, guide neither finished nor skipped) opens the first-run guide. */
function useFirstRun() {
  const nav = useNavigate();
  useEffect(() => {
    let live = true;
    api
      .get<{ needed: boolean }>("/api/setup")
      .then((s) => {
        if (live && s.needed) nav("/setup", { replace: true });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [nav]);
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
  const location = useLocation();
  const dir = useDirectory();
  const topics = useTopics();
  const [navOpen, setNavOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const navButton = useRef<HTMLButtonElement>(null);
  const kills = useKillSwitches(can("emergency.stop"));
  const approvals = usePendingApprovals();
  useFirstRun();
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const changed = () => {
      if (!media.matches) setNavOpen(false);
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!navOpen) return;
    sidebar.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNavOpen(false);
        navButton.current?.focus();
      } else if (e.key === "Tab") {
        const items = [...(sidebar.current?.querySelectorAll<HTMLElement>("a[href], button") ?? [])].filter(
          (el) => el.getClientRects().length && !el.matches(":disabled"),
        );
        const target = e.shiftKey ? items.at(-1) : items[0];
        if (document.activeElement === (e.shiftKey ? items[0] : items.at(-1))) {
          e.preventDefault();
          target?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const settings = (
    [
      { to: "/computers", label: "虚拟电脑", icon: "computer", any: COMPUTER_PERMS },
      { to: "/roles", label: "角色管理", icon: "roles", any: ["role.manage"] },
      { to: "/models", label: "模型", icon: "model", any: ["secrets.manage"] },
      { to: "/connections", label: "通讯接入", icon: "connection", any: ["connection.manage"] },
      { to: "/admin", label: "系统管理", icon: "settings", any: ADMIN_PERMS },
    ] satisfies NavItem[]
  ).filter((i) => i.any.some(can));

  const globalStop = kills.find((k) => k.scope === "global");

  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <div className="mobile-bar">
        <button
          type="button"
          className="btn btn-ghost"
          ref={navButton}
          aria-label="打开导航"
          aria-expanded={navOpen}
          aria-controls="workspace-navigation"
          onClick={() => setNavOpen(true)}
        >
          <Icon name="menu" />
        </button>
        <span>witden</span>
      </div>
      {navOpen ? (
        <button
          type="button"
          className="nav-backdrop"
          aria-label="关闭导航"
          tabIndex={-1}
          onClick={() => {
            setNavOpen(false);
            navButton.current?.focus();
          }}
        />
      ) : null}
      <ResizeHandle name="nav" side="start" min={150} max={360} />
      <aside
        className="sidebar"
        id="workspace-navigation"
        ref={sidebar}
        aria-label="工作区导航"
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest("a[href], .side-main, .side-action, .sidebar-create"))
            setNavOpen(false);
        }}
      >
        <div className="sidebar-brand">
          <Link to="/topics" className="brand">
            <img src="/favicon.svg" alt="" width={26} height={26} />
            <span>witden</span>
          </Link>
          <button
            type="button"
            className="btn btn-ghost sidebar-close"
            aria-label="收起导航"
            onClick={() => {
              setNavOpen(false);
              navButton.current?.focus();
            }}
          >
            <Icon name="close" />
          </button>
        </div>
        <nav className="nav" aria-label="主导航">
          {can("topic.create") ? (
            <button type="button" className="sidebar-create" onClick={topics.newTopic}>
              <Icon name="plus" />
              新建话题
            </button>
          ) : null}
          <div className="nav-group">
            <NavLink to="/topics" end className={navClass}>
              <Icon name="chat" />
              <span>全部会话</span>
            </NavLink>
            <NavLink to="/tasks" className={navClass}>
              <Icon name="tasks" />
              <span>任务</span>
            </NavLink>
            <NavLink to="/approvals" className={navClass}>
              <Icon name="approval" />
              <span>审批</span>
              {approvals ? <span className="nav-badge">{approvals}</span> : null}
            </NavLink>
          </div>
          <TopicList />
          <RoleList />
          <ConnectionLists />
          {settings.length ? (
            <SideSection id="settings" title="设置">
              {settings.map((i) => (
                <NavLink key={i.to} to={i.to} className={navClass}>
                  <Icon name={i.icon} />
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
              <span className="muted small">管理员</span>
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
      <div className="main" inert={navOpen}>
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
        <PageErrorBoundary key={location.pathname}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </PageErrorBoundary>
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
  extra,
  children,
}: {
  id: string;
  title: string;
  /** The title also links to a page listing everything (e.g. all topics). */
  to?: string;
  /** Shown after the title (e.g. the roles and computers a connection involves). */
  extra?: ReactNode;
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
        {extra}
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
      {collapsed ? null : <div className="side-list">{children}</div>}
    </div>
  );
}

const MAX_TOPICS = 40;

/** Console topics (group), most recent activity first; unread ones in bold. */
function TopicList() {
  const { can } = useAuth();
  const t = useTopics();
  const topics = t.topics.filter((x) => x.kind === "group" && x.status === "active" && sourceOf(x) === "console");
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
            #
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

const MAX_PER_CONNECTION = 20;

/**
 * The conversations the roles hold elsewhere, one section per connection (a Slack workspace, a GitHub
 * account ...): threads, DMs, issues and pull requests, most recent first.
 */
function ConnectionLists() {
  const t = useTopics();
  const dir = useDirectory();
  const groups = new Map<string, Topic[]>();
  for (const x of t.topics) {
    if (x.status !== "active" || sourceOf(x) === "console" || !x.channel) continue;
    groups.set(x.channel.connection_id, [...(groups.get(x.channel.connection_id) ?? []), x]);
  }
  const sections = [...groups.values()].sort((a, b) =>
    a[0].channel!.connection_name.localeCompare(b[0].channel!.connection_name, "zh"),
  );
  return (
    <>
      {sections.map((list) => {
        const c = list[0].channel!;
        return (
          <SideSection
            key={c.connection_id}
            id={`conn-${c.connection_id}`}
            title={connectionLabel(c)}
            to={`/topics?source=${c.connection_id}`}
            extra={
              <ConnectionCast
                bound={c.role_id ?? null}
                roleIds={list.flatMap((x) => x.role_ids ?? [])}
                roles={dir.roles}
              />
            }
          >
            {list.slice(0, MAX_PER_CONNECTION).map((x) => (
              <NavLink
                key={x.id}
                to={`/topics/${x.id}`}
                className={({ isActive }) =>
                  `nav-item side-item${isActive ? " nav-on" : ""}${t.unread(x) ? " side-unread" : ""}`
                }
                title={`${conversationKind(x)}：${x.title}`}
              >
                <span className="side-icon" aria-hidden>
                  {conversationIcon(x)}
                </span>
                {/* a channel's title already starts with "#", which the icon shows */}
                <span className="side-label">
                  {conversationIcon(x) === "#" ? x.title.replace(/^#\s*/, "") : x.title}
                </span>
                {t.unread(x) ? <span className="side-dot" role="img" aria-label="有新消息" /> : null}
              </NavLink>
            ))}
            {list.length > MAX_PER_CONNECTION ? (
              <Link to={`/topics?source=${c.connection_id}`} className="nav-item side-item side-more">
                查看全部 {list.length} 个会话
              </Link>
            ) : null}
          </SideSection>
        );
      })}
    </>
  );
}

type DirRole = ReturnType<typeof useDirectory>["roles"][number];

/**
 * Who works in a connection's conversations, at a glance: the role its bot stands for first, then other roles
 * brought in, and the virtual computers they work on (faded when not running).
 */
function ConnectionCast({ bound, roleIds, roles }: { bound: string | null; roleIds: string[]; roles: DirRole[] }) {
  const ids = [...new Set([...(bound ? [bound] : []), ...roleIds])];
  const cast = ids.map((id) => roles.find((r) => r.id === id)).filter((r): r is DirRole => !!r);
  if (!cast.length) return null;
  const computers = [...new Map(cast.filter((r) => r.instance).map((r) => [r.instance!.id, r.instance!])).values()];
  const title = [
    ...cast.map((r) => `${r.id === bound ? "机器人代表" : "参与"}的角色：${r.name} @${r.handle}`),
    ...computers.map((m) => `虚拟电脑：${m.name}${m.status === "running" ? "（运行中）" : "（未运行）"}`),
  ].join("\n");
  // Chips are wider than avatars were: two of each fit beside a section title.
  const MAX = 2;
  return (
    <span className="side-cast" title={title} role="img" aria-label={title}>
      {cast.slice(0, MAX).map((r) => (
        <RoleChip key={r.id} role={r} title={title} />
      ))}
      {cast.length > MAX ? <span className="side-cast-more">+{cast.length - MAX}</span> : null}
      {computers.slice(0, 2).map((m) => (
        <ComputerChip key={m.id} computer={m} running={m.status === "running"} title={title} />
      ))}
      {computers.length > 2 ? <span className="side-cast-more">+{computers.length - 2}</span> : null}
    </span>
  );
}

/** The roles you can talk to: one click opens (or starts) your DM with the role. */
function RoleList() {
  const dir = useDirectory();
  const t = useTopics();
  const { can } = useAuth();
  const { run } = useAction();
  const canEdit = can("role.manage");
  const dmOf = new Map(t.topics.filter((x) => isWebDm(x) && x.dm_role_id).map((x) => [x.dm_role_id as string, x]));
  const roles = dir.roles.filter((r) => r.status === "active").sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return (
    <SideSection id="roles" title="角色" action={{ label: "+", title: "与角色私信", onClick: t.pickDm }}>
      {roles.map((r) => {
        const dm = dmOf.get(r.id);
        const on = !!dm && dm.id === t.activeId;
        const unread = !!dm && t.unread(dm);
        const online = r.instance?.status === "running";
        // The button covers the whole row (a link cannot live inside a button); the edit shortcut sits before
        // the markers and only takes room while it shows, so the dot and the computer chip keep their place.
        return (
          <div
            key={r.id}
            className={`nav-item side-item side-row${on ? " nav-on" : ""}${unread ? " side-unread" : ""}`}
          >
            <button
              type="button"
              className="side-main"
              title={`与 ${r.name} @${r.handle} 私信${r.instance ? `（虚拟电脑 ${r.instance.name}${online ? "" : "，未运行"}）` : ""}`}
              onClick={() => void run(() => t.openDm(r.id))}
            >
              <span className="side-avatar">
                <Avatar id={r.id} name={r.name} kind="role" size={20} src={r.avatar_url} color={r.color} />
              </span>
              <span className="side-label">{r.name}</span>
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
            {unread ? <span className="side-dot" role="img" aria-label="有新消息" /> : null}
            {/* At the right edge: the computer it works on, faded when that computer is not running. */}
            {r.instance ? <ComputerChip computer={r.instance} running={online} /> : null}
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

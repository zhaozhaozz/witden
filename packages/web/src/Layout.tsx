import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, NavLink, Outlet } from "react-router-dom";
import { api } from "./api/client";
import type { Approval, KillSwitch } from "./api/types";
import { useInterval } from "./lib/hooks";
import { ADMIN_PERMS, COMPUTER_PERMS } from "./lib/perms";
import { useAuth, useDirectory } from "./lib/session";
import { Avatar } from "./ui/kit";
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
  instance: "电脑",
  topic: "话题",
  task: "任务",
};

export default function Layout() {
  const { me, can, logout } = useAuth();
  const dir = useDirectory();
  const kills = useKillSwitches(can("emergency.stop"));
  const approvals = usePendingApprovals();

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: "工作",
      items: [
        { to: "/topics", label: "话题" },
        { to: "/tasks", label: "任务" },
        { to: "/approvals", label: "审批", badge: approvals },
      ],
    },
    {
      title: "资源",
      items: [
        { to: "/computers", label: "电脑", any: COMPUTER_PERMS },
        { to: "/roles", label: "角色", any: ["role.manage"] },
        { to: "/models", label: "模型", any: ["secrets.manage"] },
      ],
    },
    {
      title: "治理",
      items: [
        { to: "/rules", label: "分配规则", any: ["rules.manage"] },
        { to: "/connections", label: "通讯接入", any: ["connection.manage"] },
        { to: "/admin", label: "管理", any: ADMIN_PERMS },
      ],
    },
  ];

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
          {groups.map((g) => {
            const items = g.items.filter((i) => !i.any || i.any.some(can));
            if (!items.length) return null;
            return (
              <div key={g.title} className="nav-group">
                <div className="nav-group-title">{g.title}</div>
                {items.map((i) => (
                  <NavLink
                    key={i.to}
                    to={i.to}
                    className={({ isActive }) => (isActive ? "nav-item nav-on" : "nav-item")}
                  >
                    <span>{i.label}</span>
                    {i.badge ? <span className="nav-badge">{i.badge}</span> : null}
                  </NavLink>
                ))}
              </div>
            );
          })}
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
        <Outlet />
      </div>
    </div>
  );
}

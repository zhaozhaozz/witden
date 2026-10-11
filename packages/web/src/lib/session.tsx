import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "../api/client";
import type { Me, Role, User } from "../api/types";

// --- auth ------------------------------------------------------------------------------------------

interface AuthState {
  me: Me | null;
  status: "loading" | "anon" | "ready";
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  can: (perm: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>(getToken() ? "loading" : "anon");

  const refreshMe = useCallback(async () => {
    const data = await api.get<Me>("/api/auth/me");
    setMe(data);
    setStatus("ready");
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setMe(null);
      setStatus("anon");
    });
    if (getToken()) {
      refreshMe().catch(() => {
        setToken(null);
        setStatus("anon");
      });
    }
    return () => setUnauthorizedHandler(null);
  }, [refreshMe]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.post<{ token: string }>("/api/auth/login", { email, password });
      setToken(res.token);
      await refreshMe();
    },
    [refreshMe],
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/api/auth/logout");
    } catch {
      // the session may already be gone
    }
    setToken(null);
    setMe(null);
    setStatus("anon");
  }, []);

  const can = useCallback((perm: string) => !!me && (!!me.is_admin || me.permissions.includes(perm)), [me]);

  const value = useMemo(() => ({ me, status, login, logout, refreshMe, can }), [me, status, login, logout, refreshMe, can]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

// --- directory: names of people and roles, used to label ids everywhere ------------------------------

interface DirectoryState {
  users: User[];
  roles: Role[];
  userById: Map<string, User>;
  roleById: Map<string, Role>;
  userName: (id: string | null | undefined) => string;
  roleLabel: (id: string | null | undefined) => string;
  reload: () => Promise<void>;
}

const DirectoryContext = createContext<DirectoryState | null>(null);

export function DirectoryProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);

  const reload = useCallback(async () => {
    const [u, r] = await Promise.allSettled([api.get<User[]>("/api/users"), api.get<Role[]>("/api/roles")]);
    if (u.status === "fulfilled") setUsers(u.value);
    if (r.status === "fulfilled") setRoles(r.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo(() => {
    const userById = new Map(users.map((u) => [u.id, u]));
    const roleById = new Map(roles.map((r) => [r.id, r]));
    return {
      users,
      roles,
      userById,
      roleById,
      userName: (id: string | null | undefined) => (id ? (userById.get(id)?.name ?? id) : "—"),
      roleLabel: (id: string | null | undefined) => {
        if (!id) return "—";
        const r = roleById.get(id);
        return r ? `${r.name} @${r.handle}` : id;
      },
      reload,
    };
  }, [users, roles, reload]);

  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>;
}

export function useDirectory(): DirectoryState {
  const ctx = useContext(DirectoryContext);
  if (!ctx) throw new Error("useDirectory outside DirectoryProvider");
  return ctx;
}

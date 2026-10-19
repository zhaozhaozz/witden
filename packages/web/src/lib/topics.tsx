import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { APPROVALS_EVENT, useLiveEvents } from "../api/events";
import type { Topic } from "../api/types";
import { NewTopicDialog, OpenDmDialog } from "../pages/topics/topicDialogs";
import { announceConfigChange } from "./configEvents";
import { useInterval } from "./hooks";

const SEEN_KEY = "witden.topics.seen";

/**
 * The person's topics for the sidebar (Slack-style lists of topics and role DMs), with unread markers. What
 * was last seen is remembered per topic in localStorage; the inbox stream announces new messages anywhere.
 */
interface TopicsState {
  topics: Topic[];
  loaded: boolean;
  reload: () => Promise<void>;
  /** The topic on screen right now (marked as read as messages arrive). */
  setActive: (topicId: string | null) => void;
  activeId: string | null;
  unread: (t: Topic) => boolean;
  /** Open (or create) the DM with a role. */
  openDm: (roleId: string) => Promise<void>;
  newTopic: () => void;
  pickDm: () => void;
}

const TopicsContext = createContext<TopicsState | null>(null);

function loadSeen(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export function TopicsProvider({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [seen, setSeen] = useState<Record<string, string>>(() => loadSeen() ?? {});
  const [dialog, setDialog] = useState<null | "new" | "dm">(null);
  const firstLoad = useRef(loadSeen() === null);
  const reloadTimer = useRef<number | undefined>(undefined);
  const topicsRef = useRef(topics);
  topicsRef.current = topics;

  const markSeen = useCallback((topicId: string, at: string | null | undefined) => {
    if (!at) return;
    setSeen((prev) => {
      if (prev[topicId] && prev[topicId] >= at) return prev;
      const next = { ...prev, [topicId]: at };
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable: unread markers reset on reload
      }
      return next;
    });
  }, []);

  const reload = useCallback(async () => {
    try {
      const rows = await api.get<Topic[]>("/api/topics");
      setTopics(rows);
      setLoaded(true);
      // First visit ever: everything so far counts as read, so the sidebar does not light up all at once.
      if (firstLoad.current) {
        firstLoad.current = false;
        for (const t of rows) markSeen(t.id, t.last_message_at ?? t.created_at);
      }
    } catch {
      // the sidebar keeps what it had
    }
  }, [markSeen]);

  useEffect(() => {
    void reload();
  }, [reload]);
  // Fallback for missed events (stream reconnects, topics shared with you by others).
  useInterval(() => void reload(), 60_000);

  // Reuse the inbox stream for approvals: per-view streams can exhaust the browser's HTTP connection limit.
  const live = useLiveEvents({ inbox: true }, (type, data) => {
    if (type === "approval.changed") {
      window.dispatchEvent(new Event(APPROVALS_EVENT));
      return;
    }
    // Roles, people, models ... changed elsewhere: whatever lists that area fetches it again.
    if (type === "config.changed") {
      announceConfigChange(String(data.area));
      return;
    }
    if (type !== "topic.activity") return;
    const topicId = String(data.topic_id);
    const at = String(data.at ?? new Date().toISOString());
    const known = topicsRef.current.some((t) => t.id === topicId);
    // Most recent activity first, as in the sidebar.
    setTopics((prev) => {
      const i = prev.findIndex((t) => t.id === topicId);
      if (i < 0) return prev;
      return [{ ...prev[i], last_message_at: at }, ...prev.slice(0, i), ...prev.slice(i + 1)];
    });
    if (topicId === activeId) markSeen(topicId, at);
    // A topic the list does not have yet (just created, or you were added): fetch the list again.
    if (!known) {
      window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(() => void reload(), 400);
    }
  });

  useEffect(() => {
    if (live) window.dispatchEvent(new Event(APPROVALS_EVENT));
  }, [live]);

  // The open topic is read up to its latest message.
  useEffect(() => {
    if (!activeId) return;
    const t = topics.find((x) => x.id === activeId);
    if (t) markSeen(t.id, t.last_message_at ?? t.created_at);
    else void reload();
  }, [activeId, topics, markSeen, reload]);

  const openDm = useCallback(
    async (roleId: string) => {
      const existing = topics.find((t) => isWebDm(t) && t.dm_role_id === roleId);
      if (existing) {
        nav(`/topics/${existing.id}`);
        return;
      }
      const t = await api.post<Topic>("/api/dms", { role_id: roleId });
      setTopics((prev) => (prev.some((x) => x.id === t.id) ? prev : [t, ...prev]));
      nav(`/topics/${t.id}`);
    },
    [topics, nav],
  );

  const value = useMemo<TopicsState>(
    () => ({
      topics,
      loaded,
      reload,
      activeId,
      setActive: setActiveId,
      unread: (t) => {
        if (t.id === activeId || !t.last_message_at) return false;
        const s = seen[t.id];
        return !s || s < t.last_message_at;
      },
      openDm,
      newTopic: () => setDialog("new"),
      pickDm: () => setDialog("dm"),
    }),
    [topics, loaded, reload, activeId, seen, openDm],
  );

  return (
    <TopicsContext.Provider value={value}>
      {children}
      {dialog === "new" ? (
        <NewTopicDialog
          onClose={() => setDialog(null)}
          onCreated={(t) => {
            setDialog(null);
            void reload();
            nav(`/topics/${t.id}`);
          }}
        />
      ) : null}
      {dialog === "dm" ? <OpenDmDialog onClose={() => setDialog(null)} /> : null}
    </TopicsContext.Provider>
  );
}

/** Your open DM in the console (a DM held over Slack or Feishu is a separate conversation). */
export const isWebDm = (t: Topic) => t.kind === "dm" && t.status === "active" && t.source === "internal";

export function useTopics(): TopicsState {
  const ctx = useContext(TopicsContext);
  if (!ctx) throw new Error("useTopics outside TopicsProvider");
  return ctx;
}

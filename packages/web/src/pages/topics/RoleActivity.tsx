import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import { api } from "../../api/client";
import type { LiveHandler } from "../../api/events";
import type { Task } from "../../api/types";
import { TOOL_LABEL } from "../../lib/format";
import { Avatar, ComputerBadge, RoleBadge } from "../../ui/kit";
import { type Author, MessageText } from "./MessageItem";

type Phase = "queued" | "thinking" | "writing" | "tool";

/** One role at work on one task. */
interface Activity {
  roleId: string;
  phase: Phase;
  tool?: string;
  /** The answer streamed so far in this model call. */
  text: string;
  /** Where the received text ends in the full answer (the server's ``offset``); a gap means we missed some. */
  end: number;
  /** Text from the previous model call (written before a tool call), kept faded while the role carries on. */
  note: string;
}

type Activities = Map<string, Activity>;

function toolLabel(tool = ""): string {
  return TOOL_LABEL[tool] ?? `使用工具 ${tool}`;
}

const ACTIVE = new Set(["pending", "running"]);

/** Apply one live event; returns the same map when nothing changed (so React skips the render). */
function apply(prev: Activities, type: string, data: Record<string, unknown>): Activities {
  const next = () => new Map(prev);
  if (type === "task.live") {
    const id = String(data.task_id);
    const cur = prev.get(id);
    const base: Activity = cur ?? { roleId: String(data.role_id), phase: "thinking", text: "", end: 0, note: "" };
    const m = next();
    if (data.phase === "writing") {
      const offset = Number(data.offset ?? 0);
      const delta = String(data.delta ?? "");
      let text = base.phase === "writing" ? base.text : "";
      let end = base.phase === "writing" ? base.end : 0;
      if (offset === 0 || offset > end) {
        // a new answer, or we joined late / missed a piece: show what we have, marking the gap
        text = offset === 0 ? delta : `${text}${text ? " " : ""}…${delta}`;
      } else {
        text += delta.slice(end - offset); // drop any overlap
      }
      end = offset + delta.length;
      m.set(id, { ...base, phase: "writing", text, end, note: "" });
    } else {
      // thinking or tool: the text written so far stays as a faded note
      const note = base.phase === "writing" ? base.text : base.note;
      m.set(id, {
        ...base,
        phase: data.phase === "tool" ? "tool" : "thinking",
        tool: data.tool as string,
        text: "",
        end: 0,
        note,
      });
    }
    return m;
  }
  if (type === "task.created" || type === "task.status") {
    const id = String(data.id);
    const status = String(data.status);
    if (!ACTIVE.has(status)) {
      if (!prev.has(id)) return prev;
      const m = next();
      m.delete(id);
      return m;
    }
    const cur = prev.get(id);
    if (cur && (status === "running") === (cur.phase !== "queued")) return prev;
    const m = next();
    m.set(id, {
      ...(cur ?? { text: "", end: 0, note: "" }),
      roleId: String(data.owner_role_id ?? cur?.roleId),
      phase: status === "running" ? "thinking" : "queued",
    });
    return m;
  }
  if (type === "message.created" && data.author_type === "role" && data.task_id && prev.has(String(data.task_id))) {
    // The role's message is in the timeline now; if the task carries on, its next event brings the bubble back.
    const m = next();
    m.delete(String(data.task_id));
    return m;
  }
  return prev;
}

/**
 * Roles working in this topic, shown at the end of the timeline: "thinking", the answer as it streams in
 * with a caret, or the tool being used. Fed by the topic's live events through ``feed``; resynchronised from
 * the task list whenever the stream (re)connects, so a missed "completed" never leaves a stale bubble.
 */
export function RoleActivity({
  topicId,
  connected,
  feed,
  authorOf,
  onGrow,
}: {
  topicId: string;
  connected: boolean;
  feed: RefObject<LiveHandler | null>;
  authorOf: (roleId: string) => Author;
  onGrow: () => void;
}) {
  const [items, setItems] = useState<Activities>(() => new Map());

  useEffect(() => {
    feed.current = (type, data) => setItems((prev) => apply(prev, type, data));
    return () => {
      feed.current = null;
    };
  }, [feed]);

  useEffect(() => {
    setItems(new Map());
  }, [topicId]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void api
      .get<Task[]>("/api/tasks", { topic_id: topicId, status: "pending,running", limit: 20 })
      .then((tasks) => {
        if (cancelled) return;
        setItems((prev) => {
          const m: Activities = new Map();
          for (const t of tasks) {
            m.set(
              t.id,
              prev.get(t.id) ?? {
                roleId: t.owner_role_id,
                phase: t.status === "running" ? "thinking" : "queued",
                text: "",
                end: 0,
                note: "",
              },
            );
          }
          return m;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [topicId, connected]);

  // Follow the bubbles as they grow (``items`` is the trigger, not an input).
  useLayoutEffect(() => {
    onGrow();
  }, [items, onGrow]);

  if (!items.size) return null;
  return (
    <>
      {[...items.entries()].map(([taskId, a]) => (
        <ActivityItem key={taskId} activity={a} author={authorOf(a.roleId)} />
      ))}
    </>
  );
}

function ActivityItem({ activity: a, author }: { activity: Activity; author: Author }) {
  const status = a.phase === "queued" ? "准备开始" : a.phase === "tool" ? `正在${toolLabel(a.tool)}` : "正在思考";
  return (
    <div className="msg msg-role msg-live" aria-live="polite" aria-busy="true">
      <div className="msg-gutter">
        <Avatar id={author.id} name={author.name} kind="role" size={32} src={author.avatarUrl} color={author.color} />
      </div>
      <div className="msg-main">
        <div className="msg-head">
          <RoleBadge
            role={{
              id: author.id,
              name: author.name,
              handle: author.handle,
              color: author.color,
              avatar_url: author.avatarUrl,
            }}
          />
          {author.computer ? <ComputerBadge computer={author.computer} /> : null}
          <span className="ai-mark">AI 员工</span>
        </div>
        {a.phase === "writing" ? (
          <MessageText content={a.text} streaming trailing={<span className="live-caret" aria-hidden />} />
        ) : (
          <>
            {a.note ? <div className="live-note">{a.note}</div> : null}
            <div className={`live-status live-${a.phase}`}>
              <span className="live-dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              {status}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

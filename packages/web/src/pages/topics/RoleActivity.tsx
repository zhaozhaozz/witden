import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { LiveHandler } from "../../api/events";
import type { Message, Task } from "../../api/types";
import { ACTIVE_TASK_STATUSES, isActiveTask, TOOL_LABEL, taskStatus } from "../../lib/format";
import { Avatar, ComputerBadge, RoleBadge } from "../../ui/kit";
import { ExecutionProgress } from "./ExecutionProgress";
import { type Author, MessageText } from "./MessageItem";

/** compacting: the role's conversation got long and it is summarising its earlier part. */
type Phase = "queued" | "thinking" | "writing" | "tool" | "compacting";

/** One role at work: a run of its conversation here, or one of its tasks. */
interface Activity {
  roleId: string;
  status: string;
  version: number;
  expanded?: boolean;
  /** Where a run without a posted answer ended in this view. */
  anchorId?: string;
  phase: Phase;
  tool?: string;
  /** The answer streamed so far in this model call. */
  text: string;
  /** Where the received text ends in the full answer (the server's ``offset``); a gap means we missed some. */
  end: number;
  /** Progress from earlier model calls, kept in place until a persisted message takes over. */
  note: string;
}

type Activities = Map<string, Activity>;

function toolLabel(tool = ""): string {
  return TOOL_LABEL[tool] ?? `使用工具 ${tool}`;
}

const ACTIVE = new Set(ACTIVE_TASK_STATUSES);

/** Apply one live event; returns the same map when nothing changed (so React skips the render). */
function apply(prev: Activities, type: string, data: Record<string, unknown>): Activities {
  const next = () => new Map(prev);
  if (type === "task.progress") {
    const id = String(data.task_id);
    const cur = prev.get(id);
    return cur ? new Map(prev).set(id, { ...cur, version: cur.version + 1 }) : prev;
  }
  if (type === "task.live") {
    const id = String(data.task_id);
    const cur = prev.get(id);
    const base: Activity = cur ?? {
      roleId: String(data.role_id),
      status: "running",
      version: 0,
      phase: "thinking",
      text: "",
      end: 0,
      note: "",
    };
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
      m.set(id, { ...base, phase: "writing", text, end });
    } else {
      // Keep the same Markdown body and height across tool/model transitions; collapsing it moves the reader.
      const note = base.phase === "writing" ? [base.note, base.text].filter(Boolean).join("\n\n") : base.note;
      m.set(id, {
        ...base,
        phase: data.phase === "tool" ? "tool" : data.phase === "compacting" ? "compacting" : "thinking",
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
      const cur = prev.get(id)!;
      if (cur.status === status) return prev;
      return next().set(id, { ...cur, status, version: cur.version + 1 });
    }
    const cur = prev.get(id);
    if (cur && status === cur.status) return prev;
    const m = next();
    m.set(id, {
      ...(cur ?? { text: "", end: 0, note: "" }),
      ...(cur && data.owner_role_id && cur.roleId !== data.owner_role_id ? { text: "", end: 0, note: "" } : {}),
      status,
      version: (cur?.version ?? 0) + 1,
      roleId: String(data.owner_role_id ?? cur?.roleId),
      phase: status === "running" ? "thinking" : "queued",
    });
    return m;
  }
  if (type === "message.created" && data.author_type === "role" && data.task_id && prev.has(String(data.task_id))) {
    // The persisted message replaces streamed text; its task ID anchors the execution record afterward.
    const m = next();
    const cur = prev.get(String(data.task_id))!;
    m.set(String(data.task_id), { ...cur, text: "", end: 0, note: "" });
    return m;
  }
  return prev;
}

/** Interleave persisted answers and their execution records, keeping each run's component mounted as it finishes. */
export function RoleActivity({
  topicId,
  messages,
  renderMessage,
  connected,
  feed,
  authorOf,
  onGrow,
}: {
  topicId: string;
  messages: Message[];
  renderMessage: (message: Message, index: number) => ReactNode;
  connected: boolean;
  feed: RefObject<LiveHandler | null>;
  authorOf: (roleId: string) => Author;
  onGrow: () => void;
}) {
  const [items, setItems] = useState<Activities>(() => new Map());
  const generation = useRef(0);
  const changes = useRef(new Map<string, number>());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const updateStatus = (prev: Activities, type: string, data: Record<string, unknown>) => {
    const next = apply(prev, type, data);
    const id = String(data.id);
    const item = next.get(id);
    if (item && !ACTIVE.has(item.status) && item.status !== "loading" && !item.anchorId) {
      return new Map(next).set(id, { ...item, anchorId: messagesRef.current.at(-1)?.id });
    }
    return next;
  };

  useEffect(() => {
    feed.current = (type, data) => {
      const id = data.task_id ?? (type.startsWith("task.") ? data.id : undefined);
      if (id) changes.current.set(String(id), ++generation.current);
      setItems((prev) => updateStatus(prev, type, data));
    };
    return () => {
      feed.current = null;
    };
  }, [feed]);

  useEffect(() => {
    setItems(new Map());
    changes.current.clear();
  }, [topicId]);

  // Message/task links survive refresh and pagination; load only the summary until a reader expands it.
  useEffect(() => {
    setItems((prev) => {
      const next = new Map(prev);
      for (const m of messages) {
        if (
          m.topic_id !== topicId ||
          m.author_type !== "role" ||
          m.deleted ||
          m.topic_delivery ||
          !m.task_id ||
          !m.author_id ||
          next.has(m.task_id)
        )
          continue;
        next.set(m.task_id, {
          roleId: m.author_id,
          status: "loading",
          version: 0,
          phase: "queued",
          text: "",
          end: 0,
          note: "",
        });
      }
      return next.size === prev.size ? prev : next;
    });
  }, [topicId, messages]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const start = generation.current;
    void api
      .get<Task[]>("/api/tasks", { topic_id: topicId, status: ACTIVE_TASK_STATUSES.join(","), limit: 20 })
      .then((tasks) => {
        if (cancelled) return;
        setItems((prev) => {
          const m: Activities = new Map(prev);
          const activeIds = new Set(tasks.filter((t) => ACTIVE.has(t.status)).map((t) => t.id));
          // A missing active run may have finished while disconnected. Resolve its final state, keeping the row.
          for (const [id, a] of prev) {
            if (ACTIVE.has(a.status) && !activeIds.has(id) && (changes.current.get(id) ?? 0) <= start) {
              m.set(id, { ...a, status: "loading", version: a.version + 1 });
            }
          }
          for (const t of tasks) {
            if (!ACTIVE.has(t.status) || (changes.current.get(t.id) ?? 0) > start) continue;
            m.set(
              t.id,
              prev.has(t.id)
                ? { ...prev.get(t.id)!, status: t.status, version: prev.get(t.id)!.version + 1 }
                : {
                    roleId: t.owner_role_id,
                    status: t.status,
                    version: 0,
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

  // One record per run, below its last posted reply. Later messages cannot move a finished record to the bottom.
  const anchors = new Map<string, string>();
  for (const m of messages) {
    if (m.author_type === "role" && !m.deleted && !m.topic_delivery && m.task_id) anchors.set(m.task_id, m.id);
  }
  const attached = new Map<string, [string, Activity][]>();
  const pending: [string, Activity][] = [];
  const messageIds = new Set(messages.map((m) => m.id));
  for (const [id, a] of items) {
    const anchor = !ACTIVE.has(a.status) ? (anchors.get(id) ?? a.anchorId) : undefined;
    if (anchor && messageIds.has(anchor)) attached.set(anchor, [...(attached.get(anchor) ?? []), [id, a]]);
    else pending.push([id, a]);
  }
  const activity = ([taskId, a]: [string, Activity], anchored: boolean) => (
    <ActivityItem
      key={`execution-${taskId}`}
      taskId={taskId}
      activity={a}
      anchored={anchored}
      author={authorOf(a.roleId)}
      connected={connected}
      onStatus={(status) => {
        changes.current.set(taskId, ++generation.current);
        setItems((prev) => updateStatus(prev, "task.status", { id: taskId, status, owner_role_id: a.roleId }));
      }}
      onToggle={() =>
        setItems((prev) => {
          const cur = prev.get(taskId);
          return cur ? new Map(prev).set(taskId, { ...cur, expanded: !cur.expanded }) : prev;
        })
      }
    />
  );
  // A flat keyed list lets React move the same execution node next to the final reply without losing open details.
  const timeline: ReactNode[] = [];
  messages.forEach((m, i) => {
    timeline.push(renderMessage(m, i));
    for (const entry of attached.get(m.id) ?? []) timeline.push(activity(entry, true));
  });
  for (const entry of pending) timeline.push(activity(entry, false));
  return <>{timeline}</>;
}

function ActivityItem({
  taskId,
  activity: a,
  anchored,
  author,
  connected,
  onToggle,
  onStatus,
}: {
  taskId: string;
  activity: Activity;
  anchored: boolean;
  author: Author;
  connected: boolean;
  onToggle: () => void;
  onStatus: (status: string) => void;
}) {
  const status =
    a.status === "loading"
      ? "执行记录"
      : a.status !== "running" && a.status !== "pending"
        ? taskStatus(a.status).label
        : a.phase === "queued"
          ? "准备开始"
          : a.phase === "tool"
            ? `正在${toolLabel(a.tool)}`
            : a.phase === "compacting"
              ? "对话较长，正在整理前面的内容"
              : a.phase === "writing"
                ? "正在生成回复"
                : "正在思考";
  const content = [a.note, a.text].filter(Boolean).join("\n\n");
  return (
    <div
      className={`msg msg-role${ACTIVE.has(a.status) ? " msg-live" : " msg-execution"}${anchored ? " msg-execution-attached" : ""}`}
      data-execution-task={taskId}
    >
      <div className="msg-gutter">
        {!anchored ? (
          <Avatar id={author.id} name={author.name} kind="role" size={32} src={author.avatarUrl} color={author.color} />
        ) : null}
      </div>
      <div className="msg-main">
        {!anchored ? (
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
        ) : null}
        {content ? <MessageText content={content} streaming mentions={[]} /> : null}
        <ExecutionProgress
          taskId={taskId}
          statusCode={a.status}
          onStatus={onStatus}
          status={status}
          running={a.status === "running"}
          active={isActiveTask(a.status)}
          phase={a.phase}
          liveText={a.text}
          version={a.version}
          connected={connected}
          expanded={!!a.expanded}
          onToggle={onToggle}
        />
      </div>
    </div>
  );
}

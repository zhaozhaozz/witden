import { useEffect, useRef, useState } from "react";
import { buildUrl, getToken } from "./client";

/** The shared inbox stream and local decisions invalidate approval views throughout this console. */
export const APPROVALS_EVENT = "witden:approvals-changed";

export type LiveEventType =
  | "message.created"
  /** A card changed (someone acted on it, or its role updated it): fetch the message again. */
  | "message.card"
  | "approval.changed"
  | "task.created"
  | "task.status"
  | "task.step"
  | "task.live"
  | "task.progress"
  /** A progress update recorded on a task (post_progress). */
  | "task.update"
  | "instance.status"
  | "instance.operator"
  | "instance.runner"
  | "instance.software"
  | "emergency.stop"
  | "topic.activity"
  | "trigger.changed"
  | "config.changed";

const EVENT_TYPES: LiveEventType[] = [
  "message.created",
  "message.card",
  "approval.changed",
  "task.created",
  "task.status",
  "task.step",
  "task.live",
  "task.progress",
  "task.update",
  "instance.status",
  "instance.operator",
  "instance.runner",
  "instance.software",
  "emergency.stop",
  "topic.activity",
  "trigger.changed",
  "config.changed",
];

export interface StreamScope {
  topic_id?: string;
  task_id?: string;
  admin?: boolean;
  /** New-message activity in every topic the user can view (no content): drives unread markers. */
  inbox?: boolean;
}

export type LiveHandler = (type: LiveEventType, data: Record<string, unknown>) => void;

/**
 * Subscribe to the server-sent event stream for a topic, a task or the admin channel.
 * EventSource cannot send headers, so the token travels as `access_token`.
 * The browser reconnects by itself after network drops, but gives up for good when the server
 * answers with an error status; in that case we reconnect with backoff.
 * Returns whether the stream is currently connected.
 */
export function useLiveEvents(scope: StreamScope | null, handler: LiveHandler): boolean {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const [connected, setConnected] = useState(false);
  const key = scope
    ? `${scope.topic_id ?? ""}|${scope.task_id ?? ""}|${scope.admin ? 1 : 0}|${scope.inbox ? 1 : 0}`
    : "";

  useEffect(() => {
    if (!scope) return;
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let delay = 2000;
    let disposed = false;

    const open = () => {
      const token = getToken();
      if (!token || disposed) return;
      const url = buildUrl("/api/events", {
        topic_id: scope.topic_id,
        task_id: scope.task_id,
        admin: scope.admin ? "true" : undefined,
        inbox: scope.inbox ? "true" : undefined,
        access_token: token,
      });
      const es = new EventSource(url);
      source = es;
      es.onopen = () => {
        delay = 2000;
        setConnected(true);
      };
      es.onerror = () => {
        setConnected(false);
        if (es.readyState === EventSource.CLOSED && !disposed) {
          es.close();
          retryTimer = window.setTimeout(open, delay);
          delay = Math.min(delay * 2, 60_000);
        }
      };
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (ev: MessageEvent) => {
          try {
            handlerRef.current(type, JSON.parse(ev.data) as Record<string, unknown>);
          } catch {
            // ignore malformed frames
          }
        });
      }
    };

    open();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      source?.close();
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return connected;
}

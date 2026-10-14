/**
 * The console as the roles' own messaging app: every conversation they are in, grouped by where it lives —
 * the console itself, or a connection (a Slack workspace, a Feishu tenant, a GitHub account).
 */
import type { Topic } from "../api/types";
import { PLATFORM_LABEL } from "./format";

/** "console", or the id of the connection the conversation came from. */
export const sourceOf = (t: Topic): string =>
  t.source !== "internal" && t.channel ? t.channel.connection_id : "console";

/** What kind of conversation it is, in words. */
export function conversationKind(t: Topic): string {
  const c = t.channel;
  if (t.source === "internal" || !c) return t.kind === "dm" ? "私信" : "话题";
  if (c.thread_kind === "pull_request") return "Pull request";
  if (c.thread_kind === "issue") return "Issue";
  if (c.conversation_kind === "im") return "私信";
  if (c.conversation_kind === "mpim") return "多人私信";
  if (c.thread_kind === "channel") return c.conversation_kind === "private" ? "私有频道" : "频道";
  return c.platform === "feishu" ? "群聊" : "频道 thread";
}

/** A one-character mark for lists. */
export function conversationIcon(t: Topic): string {
  const c = t.channel;
  if (t.source === "internal" || !c) return "#";
  if (c.thread_kind === "pull_request") return "⇄";
  if (c.thread_kind === "issue") return "◎";
  if (c.conversation_kind === "im" || c.conversation_kind === "mpim") return "@";
  return "#";
}

/** "Slack · 公司 Slack" — the connection a conversation came from. */
export const connectionLabel = (c: { platform: string; connection_name: string }) =>
  `${PLATFORM_LABEL[c.platform] ?? c.platform} · ${c.connection_name}`;

/** Where it is on that platform: "#general", "acme/api #12", a DM. */
export function placeLabel(t: Topic): string | null {
  const c = t.channel;
  if (!c) return null;
  if (c.platform === "github") return `${c.conversation_name ?? ""} #${c.thread_key}`;
  if (c.conversation_kind === "im") return "私信";
  return c.conversation_name ? `#${c.conversation_name}` : null;
}

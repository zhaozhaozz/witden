/** Pure invariants shared by linked messages, automation and task continuations. */
export interface MessageOrigin {
  topic_id: string;
  message_id: string | null;
  requester_user_id: string | null;
  outside: boolean;
  connection_id?: string | null;
  automated?: boolean;
}

export interface TopicDelivery {
  link_id: string;
  source_topic_id: string;
  source_message_id: string | null;
  sender_role_id: string;
  source_task_id: string;
  related_task_id?: string | null;
  origin: MessageOrigin;
  /** Forwarding never turns another bot's message into a new human round. */
  round: number;
}

export function orderedPair(a: string, b: string): [string, string] {
  if (!a || !b || a === b) throw new Error("choose two different topics");
  return a < b ? [a, b] : [b, a];
}

export function messageDisposition(external: boolean, receivedFromPlatform: boolean): "dispatch" | "publish" {
  return external && !receivedFromPlatform ? "publish" : "dispatch";
}

export function contactAllowed(contacts: string[], sender: string, recipient: string): boolean {
  return sender === recipient || contacts.includes("*") || contacts.includes(recipient);
}

export function assertNextRound(current: number, limit: number): number {
  if (!Number.isInteger(current) || current < 0 || !Number.isInteger(limit) || limit < 0 || current + 1 > limit)
    throw new Error("automatic collaboration round limit reached; ask a person before sending more work");
  return current + 1;
}

export function continuationAllowed(kind: string, status: string): boolean {
  return kind === "task" && status === "completed";
}

export function resultDeliveryKey(taskId: string, revision = 1): string {
  return `${taskId}:${revision}`;
}

/** A continuation is bounded both by its original grant and by what the role may do now. */
export function narrowEnvelope(original: Record<string, any>, current: Record<string, any>): Record<string, any> {
  const meet = (a: string[] = [], b: string[] = []) =>
    a.includes("*") ? [...b] : b.includes("*") ? [...a] : a.filter((x) => b.includes(x));
  return {
    ...original,
    tools: meet(original.tools, current.tools),
    contacts: meet(original.contacts, current.contacts),
    spaces: meet(original.spaces, current.spaces),
    approval_required: [...new Set([...(original.approval_required ?? []), ...(current.approval_required ?? [])])],
  };
}

export function relayFrom(ref: Record<string, any> | null | undefined): TopicDelivery | null {
  const r = ref?.topic_delivery;
  if (
    !r ||
    typeof r !== "object" ||
    typeof r.link_id !== "string" ||
    typeof r.source_topic_id !== "string" ||
    typeof r.source_task_id !== "string" ||
    typeof r.sender_role_id !== "string" ||
    !r.origin ||
    typeof r.origin.topic_id !== "string" ||
    typeof r.origin.outside !== "boolean"
  )
    return null;
  const nullableString = (value: unknown) => value === null || typeof value === "string";
  if (
    !nullableString(r.source_message_id) ||
    !nullableString(r.origin.message_id) ||
    !nullableString(r.origin.requester_user_id) ||
    !Number.isInteger(r.round) ||
    r.round < 0 ||
    (r.origin.connection_id !== undefined && !nullableString(r.origin.connection_id)) ||
    (r.origin.automated !== undefined && typeof r.origin.automated !== "boolean")
  )
    return null;
  return r as TopicDelivery;
}

/** Sensitive fields are removed before a receipt is persisted, not merely when displayed. */
export function redactWebhookHeaders(headers: Record<string, unknown>): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key.toLowerCase()] = /authorization|cookie|token|secret|api[-_]key|signature/i.test(key)
      ? "[REDACTED]"
      : Array.isArray(value)
        ? value.map(String)
        : String(value);
  }
  return result;
}

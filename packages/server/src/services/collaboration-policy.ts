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

/**
 * Where a role's message to another role came from (agent/contacts.ts), kept by the server with the receiver's
 * inbox item: the answer goes back there. The receiver is never shown it.
 */
export interface ContactRoute {
  /** The role that wrote and the message in their direct conversation. */
  from_role_id: string;
  message_id: string;
  /** The run or task that sent it, its topic, and its conversation (session) when it was one. */
  task_id: string;
  topic_id: string;
  session_id: string | null;
  /** The person the sender was working for. */
  user_id: string | null;
}

export function orderedPair(a: string, b: string): [string, string] {
  if (!a || !b || a === b) throw new Error("choose two different topics");
  return a < b ? [a, b] : [b, a];
}

export function messageDisposition(external: boolean, receivedFromPlatform: boolean): "dispatch" | "publish" {
  return external && !receivedFromPlatform ? "publish" : "dispatch";
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
    spaces: meet(original.spaces, current.spaces),
    approval_required: [...new Set([...(original.approval_required ?? []), ...(current.approval_required ?? [])])],
  };
}

/** One linked request, however many times it reaches a run. */
export const sameRoute = (a: TopicDelivery, b: TopicDelivery) =>
  a.link_id === b.link_id &&
  a.source_message_id === b.source_message_id &&
  a.origin.requester_user_id === b.origin.requester_user_id;

/**
 * What a run's input brings with it, whichever role works on it next: input from outside the console (`outside`,
 * `untrusted_input`), from an automation (`automation_event`) and the linked requests it answers (`topic_routes`).
 * An @-mention hands them to the colleague's run; a delegated task inherits them from its parent (buildEnvelope).
 */
export interface SourceLimits {
  outside?: true;
  untrusted_input?: true;
  automation_event?: true;
  topic_routes?: TopicDelivery[];
}

export function sourceLimits(envelope: Record<string, any> | null | undefined): SourceLimits | null {
  const limits: SourceLimits = {};
  if (envelope?.outside) limits.outside = true;
  if (envelope?.untrusted_input) limits.untrusted_input = true;
  if (envelope?.automation_event) limits.automation_event = true;
  if (envelope?.topic_routes?.length) limits.topic_routes = envelope.topic_routes;
  return Object.keys(limits).length ? limits : null;
}

/** The envelope with these limits added: such work never changes configuration (config, profile, automation). */
export function withSourceLimits(
  envelope: Record<string, any>,
  limits: SourceLimits | null | undefined,
): Record<string, any> {
  if (!limits) return envelope;
  const routes: TopicDelivery[] = [...(envelope.topic_routes ?? [])];
  for (const route of limits.topic_routes ?? []) if (!routes.some((r) => sameRoute(r, route))) routes.push(route);
  const out: Record<string, any> = {
    ...envelope,
    ...(limits.outside ? { outside: true } : {}),
    ...(limits.untrusted_input ? { untrusted_input: true } : {}),
    ...(limits.automation_event ? { automation_event: true } : {}),
    ...(routes.length ? { topic_routes: routes } : {}),
  };
  out.tools = (out.tools ?? []).filter((t: string) => !["config", "profile", "automation"].includes(t));
  return out;
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

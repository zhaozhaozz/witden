/**
 * How each connection's webhook calls went lately, kept in memory by the process serving the webhooks. It
 * lets the console tell "the platform reached witden but the signature did not match" (usually a wrong
 * secret) from "nothing arrived" (address or subscription), without writing to the database for every call
 * from the internet. Only calls that carry the platform's signature are counted as rejected, so scanners
 * without one leave no trace.
 */
export interface WebhookStatus {
  /** The platform verified the address (Slack and Feishu url_verification, GitHub ping). */
  verified_at?: string;
  /** An event was accepted. */
  received_at?: string;
  rejected_at?: string;
  rejected_reason?: string;
}

const statuses = new Map<string, WebhookStatus>();

export function noteWebhook(connectionId: string, outcome: "verified" | "received" | "rejected", reason?: string) {
  const s = statuses.get(connectionId) ?? {};
  const at = new Date().toISOString();
  if (outcome === "verified") s.verified_at = at;
  else if (outcome === "received") s.received_at = at;
  else {
    s.rejected_at = at;
    s.rejected_reason = reason;
  }
  statuses.set(connectionId, s);
}

export const webhookStatus = (connectionId: string): WebhookStatus | null => statuses.get(connectionId) ?? null;

/**
 * Platform end of a computer's model proxy. A program inside the computer calls the runner's local endpoint;
 * the runner relays the HTTP request over its authenticated connection (so the request is known to come from
 * that computer). Here the computer's key and model allow-list are checked, the request goes to the real
 * provider with the real key, and the answer streams back chunk by chunk. Token usage is recorded per computer.
 */
import type { ProxyCancelMessage, ProxyRequestMessage } from "@witden/shared";
import { eq } from "drizzle-orm";
import { fetchImpl } from "../agent/llm.js";
import { systemOneBase } from "../agent/systemone.js";
import { db as getDb } from "../db/client.js";
import { newId } from "../db/ids.js";
import { computerInstances, usageRecords } from "../db/schema.js";
import { safeEqual, secretBox } from "../security/crypto.js";
import { modelLabel, tokensToday, unusableReason } from "../services/model-configs.js";
import { proxyModels } from "../services/model-proxy.js";
import type { RunnerConnection } from "./hub.js";

const OPENAI_PATHS = new Set(["/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/responses"]);
const ANTHROPIC_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const SYSTEMONE_PATHS = new Set(["/v1/systemone", "/v1/systemone/batch"]);
/** Where each protocol's models are called, for error messages. */
const CALL_PATH: Record<string, string> = {
  openai: "/v1/chat/completions",
  anthropic: "/v1/messages",
  systemone: "/v1/systemone",
};
const RESPONSE_HEADERS = ["content-type", "cache-control", "x-request-id", "request-id"];
/** Enough to find token counts at both ends of a long stream. */
const USAGE_SCAN_BYTES = 8 * 1024 * 1024;

const inflight = new Map<string, AbortController>();

/** Entry point for proxy.request / proxy.cancel messages from a runner. */
export function handleProxyMessage(conn: RunnerConnection, msg: ProxyRequestMessage | ProxyCancelMessage): void {
  const key = `${conn.instanceId}:${msg.id}`;
  if (msg.type === "proxy.cancel") {
    inflight.get(key)?.abort();
    return;
  }
  const controller = new AbortController();
  inflight.set(key, controller);
  relay(conn, msg, controller.signal)
    .catch((err) => {
      console.error("[witden] model proxy request failed", err);
      conn.post({ type: "proxy.end", id: msg.id, error: (err as Error).message });
    })
    .finally(() => inflight.delete(key));
}

const b64 = (data: string | Uint8Array) => Buffer.from(data).toString("base64");

async function relay(conn: RunnerConnection, msg: ProxyRequestMessage, signal: AbortSignal): Promise<void> {
  const id = msg.id;
  const reply = (status: number, body: unknown) => {
    conn.post({ type: "proxy.response", id, status, headers: { "content-type": "application/json" } });
    conn.post({ type: "proxy.chunk", id, dataBase64: b64(JSON.stringify(body)) });
    conn.post({ type: "proxy.end", id });
  };
  // Error bodies that OpenAI- and Anthropic-style clients both report usefully.
  const error = (status: number, type: string, message: string) =>
    reply(status, { type: "error", error: { type, message } });

  const [inst] = await getDb()
    .select()
    .from(computerInstances)
    .where(eq(computerInstances.id, conn.instanceId))
    .limit(1);
  if (!inst?.modelProxyEnabled || !inst.modelProxyKeyEncrypted)
    return error(403, "permission_error", "model access is not enabled for this computer");
  const headers = lowerKeys(msg.headers);
  const presented = bearer(headers.authorization) ?? headers["x-api-key"] ?? "";
  if (!presented || !safeEqual(presented, secretBox().decrypt(inst.modelProxyKeyEncrypted)))
    return error(401, "authentication_error", "invalid API key for this computer's model access");

  const url = new URL(msg.path, "http://computer.local");
  const path = url.pathname.replace(/\/+$/, "");
  const models = await proxyModels(getDb(), inst.modelProxyModelIds);
  if (msg.method === "GET" && (path === "/v1/models" || path === "/models")) {
    return reply(200, {
      object: "list",
      data: models
        .filter((m) => !unusableReason(m.model, m.provider))
        .map((m) => ({
          id: m.alias,
          object: "model",
          type: "model",
          display_name: m.model.name,
          owned_by: m.provider.name,
          created: Math.floor(m.model.createdAt.getTime() / 1000),
        })),
      has_more: false,
    });
  }
  const protocol = OPENAI_PATHS.has(path)
    ? "openai"
    : ANTHROPIC_PATHS.has(path)
      ? "anthropic"
      : SYSTEMONE_PATHS.has(path)
        ? "systemone"
        : null;
  if (!protocol || msg.method !== "POST")
    return error(404, "not_found_error", `${msg.method} ${path} is not offered by this computer's model access`);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(msg.bodyBase64, "base64").toString("utf8"));
  } catch {
    return error(400, "invalid_request_error", "the request body is not JSON");
  }
  const wanted = String(body?.model ?? "");
  const target = models.find((m) => m.alias === wanted || `${m.provider.name}/${m.model.model}` === wanted);
  if (!target) {
    const allowed = models.map((m) => m.alias).join(", ") || "none";
    return error(404, "not_found_error", `model "${wanted}" is not available in this computer (allowed: ${allowed})`);
  }
  const unusable = unusableReason(target.model, target.provider);
  if (unusable) return error(403, "permission_error", unusable);
  if (target.provider.protocol !== protocol) {
    const use = CALL_PATH[target.provider.protocol] ?? "/v1/chat/completions";
    return error(
      400,
      "invalid_request_error",
      `model "${wanted}" uses the ${target.provider.protocol} protocol: call ${use}`,
    );
  }
  const limit = target.model.dailyTokenLimit;
  if (limit && (await tokensToday(getDb(), { modelConfigId: target.model.id })) >= limit)
    return error(
      429,
      "rate_limit_error",
      `model ${modelLabel(target.model, target.provider)} reached its daily token limit`,
    );

  const base = target.provider.baseUrl.replace(/\/+$/, "");
  // OpenAI-compatible base URLs already end in /v1; Anthropic's do not; System One ones may (agent/systemone.ts).
  const upstream =
    (protocol === "openai"
      ? base + path.replace(/^\/v1/, "")
      : protocol === "systemone"
        ? systemOneBase(base) + path
        : base + path) + url.search;
  const apiKey = target.provider.apiKeyEncrypted ? secretBox().decrypt(target.provider.apiKeyEncrypted) : null;
  const upstreamHeaders: Record<string, string> = { "content-type": "application/json" };
  if (protocol !== "anthropic") {
    if (apiKey) upstreamHeaders.authorization = `Bearer ${apiKey}`;
  } else {
    if (apiKey) upstreamHeaders["x-api-key"] = apiKey;
    upstreamHeaders["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
    if (headers["anthropic-beta"]) upstreamHeaders["anthropic-beta"] = headers["anthropic-beta"];
  }
  body.model = target.model.model;

  let res: Response;
  try {
    res = await fetchImpl(upstream, { method: "POST", headers: upstreamHeaders, body: JSON.stringify(body), signal });
  } catch (err) {
    if (signal.aborted) return;
    return error(502, "api_error", `the model service could not be reached: ${(err as Error).message}`);
  }
  const outHeaders: Record<string, string> = {};
  for (const h of RESPONSE_HEADERS) {
    const v = res.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  conn.post({ type: "proxy.response", id, status: res.status, headers: outHeaders });
  const usage = new UsageScanner();
  try {
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        usage.push(chunk);
        if (!conn.post({ type: "proxy.chunk", id, dataBase64: b64(chunk) })) throw new Error("runner connection lost");
      }
    }
    conn.post({ type: "proxy.end", id });
  } catch (err) {
    if (!signal.aborted) conn.post({ type: "proxy.end", id, error: (err as Error).message });
  }
  const { input, output } = usage.result();
  if (res.ok && (input || output)) {
    await getDb()
      .insert(usageRecords)
      .values({
        id: newId("use"),
        instanceId: inst.id,
        modelConfigId: target.model.id,
        promptTokens: input,
        completionTokens: output,
      });
  }
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m ? m[1].trim() : null;
}

/**
 * Token counts from a JSON answer or an SSE stream, in any dialect: OpenAI `usage.prompt_tokens /
 * completion_tokens` (Responses API: `input_tokens / output_tokens`, also under `response`), Anthropic
 * `message_start.message.usage.input_tokens` and `message_delta.usage.output_tokens`, System One
 * `usage.input_tokens / output_tokens` (batch: `total_usage`).
 */
export class UsageScanner {
  private parts: Buffer[] = [];
  private size = 0;

  push(chunk: Uint8Array): void {
    if (this.size >= USAGE_SCAN_BYTES) return;
    this.parts.push(Buffer.from(chunk));
    this.size += chunk.length;
  }

  result(): { input: number; output: number } {
    const text = Buffer.concat(this.parts).toString("utf8");
    let input = 0;
    let output = 0;
    const take = (o: any) => {
      for (const u of [o?.usage, o?.message?.usage, o?.response?.usage, o?.total_usage]) {
        if (!u || typeof u !== "object") continue;
        input = Math.max(input, Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0);
        output = Math.max(output, Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0);
      }
    };
    const docs = text.trimStart().startsWith("{")
      ? [text]
      : text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
    for (const doc of docs) {
      try {
        take(JSON.parse(doc));
      } catch {
        // not JSON ([DONE], keep-alives)
      }
    }
    return { input, output };
  }
}

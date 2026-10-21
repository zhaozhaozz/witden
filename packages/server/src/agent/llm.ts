/**
 * Model adapters. Internally messages use the OpenAI chat format; each provider adapter converts it.
 * Tool calls from any provider become provider-neutral ``ToolCall``s — the platform's own tools, not a
 * vendor's tool schema, define what can happen.
 */
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { ModelError } from "../errors.js";
import { anthropicEffort, type EffortInfo, listedEffort } from "../services/effort.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  rawArguments?: string;
}

export interface LLMResponse {
  content: string;
  /** The model's reasoning, when the service returns it and wants it back (DeepSeek's reasoning_content). */
  reasoning?: string;
  toolCalls: ToolCall[];
  /** All prompt tokens, including the part read from the service's prompt cache. */
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the prompt cache (0 when the service does not say). */
  cachedTokens?: number;
  finishReason?: string | null;
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** OpenAI-compatible services that return reasoning_content expect it back on the assistant turn. */
  reasoning_content?: string;
}
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

/** Receives the answer text as it is generated (streaming); tool-call arguments are not passed on. */
export type OnDelta = (text: string) => void;

export interface ChatModel {
  /** With ``onDelta`` the adapter streams the answer when the endpoint supports it; the result is the same. */
  complete(messages: ChatMessage[], tools?: ToolSchema[], onDelta?: OnDelta): Promise<LLMResponse>;
}

/** Tests replace this to intercept HTTP. */
export let fetchImpl: typeof fetch = (...args) => fetch(...args);
export function setFetch(fn: typeof fetch): void {
  fetchImpl = fn;
}

function parseArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object") return raw as Record<string, any>;
  if (!raw) return {};
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === "object" ? v : { value: v };
  } catch {
    return { __invalid_json__: raw };
  }
}

export async function request(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  return parseJson(await send(url, init, timeoutMs));
}

async function send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ModelError(`model endpoint unreachable: ${(err as Error).message}`);
  }
  if (res.status >= 400) {
    const text = await res.text().catch(() => "");
    throw new ModelError(`model returned HTTP ${res.status}: ${text.slice(0, 500)}`, {
      detail: { upstream_status: res.status },
    });
  }
  return res;
}

async function parseJson(res: Response): Promise<any> {
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new ModelError(`model endpoint unreachable: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelError("model returned invalid JSON");
  }
}

const isEventStream = (res: Response) => (res.headers.get("content-type") ?? "").includes("text/event-stream");

/** The JSON ``data:`` payloads of a server-sent event stream, as they arrive. */
async function* sseData(res: Response): AsyncGenerator<any> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let data: any;
        try {
          data = JSON.parse(payload);
        } catch {
          continue; // keep-alive comments and partial vendor extensions
        }
        if (data?.error)
          throw new ModelError(`model stream error: ${data.error.message ?? JSON.stringify(data.error)}`);
        yield data;
      }
    }
  } catch (err) {
    if (err instanceof ModelError) throw err;
    throw new ModelError(`model stream interrupted: ${(err as Error).message}`);
  }
}

/**
 * POST with streaming when someone listens for text. An endpoint that rejects streaming (some gateways
 * refuse ``stream_options``) is asked again without it, and the adapter stops trying for that model.
 */
async function postMaybeStreaming(
  model: { streaming: boolean },
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  streamFields: Record<string, any>,
  timeoutMs: number,
  onDelta: OnDelta | undefined,
): Promise<Response> {
  if (onDelta && model.streaming) {
    try {
      return await send(
        url,
        { method: "POST", headers, body: JSON.stringify({ ...body, ...streamFields }) },
        timeoutMs,
      );
    } catch (err) {
      if (!(err instanceof ModelError) || ![400, 422].includes(err.detail.upstream_status as number)) throw err;
      model.streaming = false;
    }
  }
  return send(url, { method: "POST", headers, body: JSON.stringify(body) }, timeoutMs);
}

/** Any endpoint speaking the OpenAI /chat/completions protocol (vLLM, Ollama, DeepSeek, ...). */
export class OpenAICompatibleModel implements ChatModel {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  streaming = true;

  constructor(
    baseUrl: string,
    private readonly model: string,
    apiKey: string | null,
    private readonly params: Record<string, any>,
    private readonly timeoutMs = 180_000,
  ) {
    this.url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  }

  async complete(messages: ChatMessage[], tools?: ToolSchema[], onDelta?: OnDelta): Promise<LLMResponse> {
    const body: Record<string, any> = { model: this.model, messages, ...this.params };
    if (tools?.length) body.tools = tools.map((t) => ({ type: "function", function: t }));
    const stream = { stream: true, stream_options: { include_usage: true } };
    const res = await postMaybeStreaming(this, this.url, this.headers, body, stream, this.timeoutMs, onDelta);
    if (!isEventStream(res)) return OpenAICompatibleModel.parse(await parseJson(res));
    // Streamed: text arrives in delta.content, reasoning in delta.reasoning_content; tool calls arrive in
    // pieces keyed by index.
    let content = "";
    let reasoning = "";
    const calls: { id?: string; name: string; args: string }[] = [];
    let usage: any = null;
    let finishReason: string | null = null;
    for await (const chunk of sseData(res)) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      for (const part of delta.tool_calls ?? []) {
        const at = typeof part.index === "number" ? part.index : calls.length;
        calls[at] ??= { name: "", args: "" };
        if (part.id) calls[at].id = part.id;
        if (part.function?.name) calls[at].name += part.function.name;
        if (part.function?.arguments) calls[at].args += part.function.arguments;
      }
    }
    return OpenAICompatibleModel.parse({
      choices: [
        {
          finish_reason: finishReason,
          message: {
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            tool_calls: calls.filter(Boolean).map((c) => ({ id: c.id, function: { name: c.name, arguments: c.args } })),
          },
        },
      ],
      usage,
    });
  }

  private static parse(data: any): LLMResponse {
    const choice = data.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => {
      const raw = c.function?.arguments;
      return {
        // Some servers (Ollama, older vLLM) omit ids; they must still be unique per transcript.
        id: c.id || `call_${randomBytes(6).toString("hex")}`,
        name: c.function?.name ?? "",
        arguments: parseArgs(raw),
        rawArguments: typeof raw === "string" ? raw : JSON.stringify(raw ?? {}),
      };
    });
    return {
      content: msg.content ?? "",
      ...(typeof msg.reasoning_content === "string" && msg.reasoning_content
        ? { reasoning: msg.reasoning_content }
        : {}),
      toolCalls,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      // OpenAI and most compatible services report prompt_tokens_details.cached_tokens; DeepSeek its own field.
      cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? data.usage?.prompt_cache_hit_tokens ?? 0,
      finishReason: choice.finish_reason,
    };
  }
}

/**
 * max_tokens when neither the model's parameters, its service nor the model catalog give one. The Anthropic API
 * requires the field and cuts the answer there, so it should not be what ends an answer: 32000 is the most every
 * Claude model still served accepts (Claude Opus 4 and 4.1 stop there; current models take 64000 or 128000). A
 * larger max_tokens costs nothing by itself: output rate limits count the tokens produced, not this value. A
 * compatible service that takes fewer says so, and the request is repeated with what it names (allowedMaxTokens).
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 32_000;

/**
 * The max_tokens a refusal names as the highest allowed ("max_tokens: 64001 > 64000, which is the maximum ...",
 * "the valid range of max_tokens is [1, 8192]"): the largest number below what was asked, else the 4096 every
 * Anthropic-compatible service has taken.
 */
export function allowedMaxTokens(message: string, asked: number): number {
  const below = (message.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 1024 && n < asked);
  return below.length ? Math.max(...below) : 4096;
}

/** Anthropic Messages API (also used by compatible gateways). */
export class AnthropicModel implements ChatModel {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private params: Record<string, any>;
  /** max_tokens was chosen here, not set in the model's parameters: lowered once if the service refuses it. */
  private chosenMaxTokens: boolean;
  streaming = true;

  /** ``maxOutput``: the model's largest answer in tokens, as its service or the model catalog reports it. */
  constructor(
    baseUrl: string,
    private readonly model: string,
    apiKey: string | null,
    params: Record<string, any>,
    maxOutput: number | null = null,
    private readonly timeoutMs = 180_000,
  ) {
    this.url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
    this.headers = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    };
    this.chosenMaxTokens = params.max_tokens === undefined;
    this.params = { max_tokens: maxOutput ?? ANTHROPIC_DEFAULT_MAX_TOKENS, ...params };
  }

  private static content(content: string | ContentPart[]): any {
    if (typeof content === "string") return content;
    return content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      const [meta, b64] = part.image_url.url.split(";base64,");
      return { type: "image", source: { type: "base64", media_type: meta.slice(5), data: b64 } };
    });
  }

  convert(messages: ChatMessage[]): { system: string; messages: any[] } {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content as string)
      .join("\n\n");
    const out: any[] = [];
    const asList = (c: any) => (Array.isArray(c) ? c : [{ type: "text", text: c }]);
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: AnthropicModel.content(m.content) };
        const last = out[out.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) last.content.push(block);
        else out.push({ role: "user", content: [block] });
        continue;
      }
      if (m.role === "assistant") {
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const c of m.tool_calls ?? []) {
          blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
        }
        out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
        continue;
      }
      const content = AnthropicModel.content(m.content);
      const last = out[out.length - 1];
      if (last?.role === "user") last.content = [...asList(last.content), ...asList(content)];
      else out.push({ role: "user", content });
    }
    return { system, messages: out };
  }

  /**
   * Prompt caching: one breakpoint after the system prompt (tools and system are the stable start of every
   * request) and one on the last block, so the next request of the same conversation reads everything before
   * it from the cache. Off for a gateway that rejects the field.
   */
  caching = true;

  private static withBreakpoints(system: string, messages: any[]): { system: any; messages: any[] } {
    const mark = { type: "ephemeral" };
    const out = messages.map((m) => ({ ...m }));
    const last = out[out.length - 1];
    if (last) {
      const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
      const tail = blocks[blocks.length - 1];
      // Empty text blocks cannot carry a breakpoint.
      if (tail && !(tail.type === "text" && !tail.text)) {
        blocks[blocks.length - 1] = { ...tail, cache_control: mark };
        last.content = blocks;
      }
    }
    return { system: system ? [{ type: "text", text: system, cache_control: mark }] : undefined, messages: out };
  }

  async complete(messages: ChatMessage[], tools?: ToolSchema[], onDelta?: OnDelta): Promise<LLMResponse> {
    const { system, messages: converted } = this.convert(messages);
    const build = () => {
      const cached = this.caching ? AnthropicModel.withBreakpoints(system, converted) : { system, messages: converted };
      const body: Record<string, any> = { model: this.model, messages: cached.messages, ...this.params };
      if (cached.system) body.system = cached.system;
      if (tools?.length)
        body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      return body;
    };
    let res: Response | undefined;
    // A gateway that rejects cache_control, or a service that takes fewer output tokens than chosen, is asked again
    // without them (and not offered them again by this model).
    for (let retries = 2; !res; retries--) {
      try {
        res = await postMaybeStreaming(
          this,
          this.url,
          this.headers,
          build(),
          { stream: true },
          this.timeoutMs,
          onDelta,
        );
      } catch (err) {
        const refused = retries > 0 && err instanceof ModelError && err.detail.upstream_status === 400;
        if (refused && this.caching && /cache_control/i.test(err.message)) this.caching = false;
        else if (refused && this.chosenMaxTokens && /max_tokens/i.test(err.message)) {
          this.params = { ...this.params, max_tokens: allowedMaxTokens(err.message, this.params.max_tokens) };
          this.chosenMaxTokens = false;
        } else throw err;
      }
    }
    if (!isEventStream(res)) return AnthropicModel.parse(await parseJson(res));
    // Streamed: content blocks open, grow by deltas (text or partial tool-input JSON), then close.
    const blocks: any[] = [];
    const usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason: string | null = null;
    for await (const ev of sseData(res)) {
      if (ev.type === "message_start") Object.assign(usage, ev.message?.usage ?? {});
      else if (ev.type === "content_block_start") blocks[ev.index] = { ...ev.content_block, json: "" };
      else if (ev.type === "content_block_delta") {
        const block = blocks[ev.index];
        if (!block) continue;
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          block.text = (block.text ?? "") + ev.delta.text;
          onDelta?.(ev.delta.text);
        } else if (ev.delta?.type === "input_json_delta") block.json += ev.delta.partial_json ?? "";
      } else if (ev.type === "message_delta") {
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens !== undefined) usage.output_tokens = ev.usage.output_tokens;
      }
    }
    for (const b of blocks) {
      if (b?.type === "tool_use" && b.json) b.input = parseArgs(b.json);
    }
    return AnthropicModel.parse({ content: blocks.filter(Boolean), usage, stop_reason: stopReason });
  }

  private static parse(data: any): LLMResponse {
    const blocks: any[] = data.content ?? [];
    const u = data.usage ?? {};
    // input_tokens counts only what was neither read from nor written to the cache.
    const read = u.cache_read_input_tokens ?? 0;
    return {
      content: blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
      toolCalls: blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, arguments: b.input ?? {} })),
      promptTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + read,
      completionTokens: u.output_tokens ?? 0,
      cachedTokens: read,
      finishReason: data.stop_reason,
    };
  }
}

/** ``maxOutput``: the model's largest answer in tokens when known (the Anthropic protocol must send one). */
export function buildModel(
  provider: string,
  baseUrl: string,
  model: string,
  apiKey: string | null,
  params: Record<string, any>,
  maxOutput: number | null = null,
): ChatModel {
  return provider === "anthropic"
    ? new AnthropicModel(baseUrl, model, apiKey, params, maxOutput)
    : new OpenAICompatibleModel(baseUrl, model, apiKey, params);
}

// --- model lists ------------------------------------------------------------------------------------------

export interface RemoteModel {
  id: string;
  /** Display name when the provider gives one. */
  name: string | null;
  /** Reasoning effort levels, when the provider reports them (services/effort.ts). */
  effort?: EffortInfo;
  /** Context window in tokens, when the provider reports it. */
  contextWindow?: number;
  /** Largest answer in tokens, when the provider reports it (Anthropic's max_tokens). */
  maxOutput?: number;
}

/** The context window a model list entry reports (Anthropic, OpenRouter, vLLM and others name it differently). */
export function listedContextWindow(item: Record<string, unknown>): number | undefined {
  for (const key of ["max_input_tokens", "context_length", "context_window", "max_model_len", "max_context_length"]) {
    const v = Number(item[key]);
    if (Number.isFinite(v) && v >= 1024) return Math.floor(v);
  }
  return undefined;
}

/**
 * The models a provider offers, from its own API: OpenAI-compatible `GET {base}/models` (OpenAI, vLLM,
 * Ollama, DeepSeek, ...), Anthropic `GET {base}/v1/models` (paged) or System One `GET {base}/v1/models` (Jev).
 */
export async function listModels(protocol: string, baseUrl: string, apiKey: string | null): Promise<RemoteModel[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const found = new Map<string, RemoteModel>();
  if (protocol === "systemone") {
    const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    let data: any;
    try {
      data = await request(`${base.replace(/\/v1$/, "")}/v1/models`, { headers }, 30_000);
    } catch (err) {
      // A self-hosted Laya server has no model list; its models are added by name.
      if (err instanceof ModelError && err.detail.upstream_status === 404)
        throw new ModelError(
          "this service does not list its models (a self-hosted Laya server does not): add them by name, e.g. multilingual",
          { detail: { upstream_status: 404 } },
        );
      throw err;
    }
    for (const m of data?.models ?? data?.data ?? []) {
      const id = String(m?.name ?? m?.id ?? "");
      if (id) found.set(id, { id, name: null });
    }
  } else if (protocol === "anthropic") {
    const headers = { "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) };
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ limit: "1000", ...(after ? { after_id: after } : {}) });
      const data = await request(`${base}/v1/models?${q}`, { headers }, 30_000);
      for (const m of data?.data ?? []) {
        if (m?.id)
          found.set(String(m.id), {
            id: String(m.id),
            name: m.display_name ? String(m.display_name) : null,
            effort: anthropicEffort(m),
            contextWindow: listedContextWindow(m),
            ...(Number.isInteger(m.max_tokens) && m.max_tokens > 0 ? { maxOutput: m.max_tokens } : {}),
          });
      }
      if (!data?.has_more || !data.last_id) break;
      after = String(data.last_id);
    }
  } else {
    const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const data = await request(`${base}/models`, { headers }, 30_000);
    // {data: [{id}]} is the norm; a bare array or {models: [...]} also occurs.
    const list: unknown[] = Array.isArray(data) ? data : (data?.data ?? data?.models ?? []);
    for (const m of list) {
      const item = m as Record<string, unknown> | string;
      const id = typeof item === "string" ? item : String(item?.id ?? item?.model ?? item?.name ?? "");
      if (id)
        found.set(id, {
          id,
          name: null,
          ...(typeof item === "string" ? {} : { effort: listedEffort(item), contextWindow: listedContextWindow(item) }),
        });
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// --- capability probe --------------------------------------------------------------------------------------

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function solidPng(r: number, g: number, b: number, size = 16): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (tag: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(tag), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const imagePart = (png: Buffer | string): ContentPart => ({
  type: "image_url",
  image_url: { url: `data:image/png;base64,${typeof png === "string" ? png : png.toString("base64")}` },
});

/** Verify connectivity, tool calling and image understanding with three tiny requests. */
export async function probeCapabilities(model: ChatModel): Promise<Record<string, any>> {
  const caps: Record<string, any> = { checked_at: new Date().toISOString(), errors: {} };
  try {
    const started = Date.now();
    await model.complete([{ role: "user", content: "Reply with the single word OK." }]);
    caps.latency_ms = Date.now() - started;
    caps.chat = true;
  } catch (err) {
    caps.chat = false;
    caps.errors.chat = (err as Error).message;
    caps.tools = caps.vision = null;
    return caps;
  }
  const tool = {
    name: "get_magic_number",
    description: "Returns the magic number.",
    parameters: { type: "object", properties: {}, required: [] },
  };
  try {
    const res = await model.complete(
      [{ role: "user", content: "Call the get_magic_number tool now. Do not answer in text." }],
      [tool],
    );
    caps.tools = res.toolCalls.some((c) => c.name === "get_magic_number");
    if (!caps.tools) caps.errors.tools = "model answered without calling the tool";
  } catch (err) {
    caps.tools = false;
    caps.errors.tools = (err as Error).message;
  }
  try {
    const res = await model.complete([
      {
        role: "user",
        content: [
          { type: "text", text: "What is the color of this image? Answer with one English word." },
          imagePart(solidPng(220, 20, 20)),
        ],
      },
    ]);
    caps.vision = res.content.toLowerCase().includes("red");
    if (!caps.vision)
      caps.errors.vision = `could not identify a red image (answered: ${JSON.stringify(res.content.slice(0, 60))})`;
  } catch (err) {
    caps.vision = false;
    caps.errors.vision = (err as Error).message;
  }
  return caps;
}

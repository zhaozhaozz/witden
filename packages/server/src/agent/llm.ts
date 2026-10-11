/**
 * Model adapters. Internally messages use the OpenAI chat format; each provider adapter converts it.
 * Tool calls from any provider become provider-neutral ``ToolCall``s — the platform's own tools, not a
 * vendor's tool schema, define what can happen.
 */
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { ModelError } from "../errors.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  rawArguments?: string;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  finishReason?: string | null;
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ChatModel {
  complete(messages: ChatMessage[], tools?: ToolSchema[]): Promise<LLMResponse>;
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

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ModelError(`model endpoint unreachable: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (res.status >= 400) throw new ModelError(`model returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelError("model returned invalid JSON");
  }
}

/** Any endpoint speaking the OpenAI /chat/completions protocol (vLLM, Ollama, DeepSeek, ...). */
export class OpenAICompatibleModel implements ChatModel {
  private readonly url: string;
  private readonly headers: Record<string, string>;

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

  async complete(messages: ChatMessage[], tools?: ToolSchema[]): Promise<LLMResponse> {
    const body: Record<string, any> = { model: this.model, messages, ...this.params };
    if (tools?.length) body.tools = tools.map((t) => ({ type: "function", function: t }));
    const data = await post(this.url, this.headers, body, this.timeoutMs);
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
      toolCalls,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      finishReason: choice.finish_reason,
    };
  }
}

/** Anthropic Messages API (also used by compatible gateways). */
export class AnthropicModel implements ChatModel {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly params: Record<string, any>;

  constructor(
    baseUrl: string,
    private readonly model: string,
    apiKey: string | null,
    params: Record<string, any>,
    private readonly timeoutMs = 180_000,
  ) {
    this.url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
    this.headers = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    };
    this.params = { max_tokens: 4096, ...params };
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

  async complete(messages: ChatMessage[], tools?: ToolSchema[]): Promise<LLMResponse> {
    const { system, messages: converted } = this.convert(messages);
    const body: Record<string, any> = { model: this.model, messages: converted, ...this.params };
    if (system) body.system = system;
    if (tools?.length)
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const data = await post(this.url, this.headers, body, this.timeoutMs);
    const blocks: any[] = data.content ?? [];
    return {
      content: blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
      toolCalls: blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, arguments: b.input ?? {} })),
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      finishReason: data.stop_reason,
    };
  }
}

export function buildModel(
  provider: string,
  baseUrl: string,
  model: string,
  apiKey: string | null,
  params: Record<string, any>,
): ChatModel {
  return provider === "anthropic"
    ? new AnthropicModel(baseUrl, model, apiKey, params)
    : new OpenAICompatibleModel(baseUrl, model, apiKey, params);
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
    await model.complete([{ role: "user", content: "Reply with the single word OK." }]);
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

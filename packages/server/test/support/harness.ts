/** Test harness: a full witden in one process on embedded PostgreSQL, with simulated computers. */

import type { ChatMessage, LLMResponse, OnDelta, ToolCall, ToolSchema } from "../../src/agent/llm.js";
import { setFetch } from "../../src/agent/llm.js";
import { DISPATCHER_PROMPT_START } from "../../src/agent/router.js";
import { Worker } from "../../src/agent/worker.js";
import { start, type Witden } from "../../src/app.js";
import { loadSettings, type Settings } from "../../src/config.js";
import { setModelFactory } from "../../src/services/model-configs.js";
import { FakeManager } from "./fake-computer.js";

export const ADMIN = { email: "admin@example.com", password: "admin-pass-123" };

export type Script = (messages: ChatMessage[], tools: ToolSchema[] | undefined) => LLMResponse;

export const reply = (content: string, toolCalls: ToolCall[] = []): LLMResponse => ({
  content,
  toolCalls,
  promptTokens: 10,
  completionTokens: 5,
});

let callSeq = 0;
export const call = (name: string, args: Record<string, any> = {}): ToolCall => ({
  id: `call_${name}_${++callSeq}`,
  name,
  arguments: args,
});

export interface Harness {
  witden: Witden;
  manager: FakeManager;
  worker: Worker;
  settings: Settings;
  api(
    method: string,
    url: string,
    opts?: { token?: string; json?: unknown; headers?: Record<string, string>; payload?: string | Buffer },
  ): Promise<{ status: number; body: any; raw: string }>;
  login(email: string, password: string): Promise<string>;
  adminToken: string;
  /** Run background operations and tasks until nothing is runnable. */
  drain(): Promise<void>;
  waitFor<T>(fn: () => Promise<T | undefined | false | null>, ms?: number): Promise<T>;
  close(): Promise<void>;
}

export async function startHarness(overrides: Partial<Settings> = {}): Promise<Harness> {
  const settings = loadSettings({
    dataDir: `.tmp/test-data/${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    databaseUrl: "pglite://memory",
    secretKey: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=",
    bootstrapAdminEmail: ADMIN.email,
    bootstrapAdminPassword: ADMIN.password,
    processRole: "all",
    instanceWaitSeconds: 300,
    ...overrides,
  });
  const manager = new FakeManager();
  const witden = await start({ settings, manager, startWorker: false, listenHub: false });
  manager.hub = witden.runtime.hub!;
  const worker = new Worker(witden.runtime.gateway!);
  witden.runtime.worker = worker;
  const app = witden.app!;
  const api: Harness["api"] = async (method, url, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await app.inject({
      method: method as any,
      url,
      headers,
      ...(opts.json !== undefined ? { payload: opts.json as any } : {}),
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    });
    let body: any = null;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res.body };
  };
  const login = async (email: string, password: string) => {
    const res = await api("POST", "/api/auth/login", { json: { email, password } });
    if (res.status !== 200) throw new Error(`login failed: ${res.raw}`);
    return res.body.token as string;
  };
  const waitFor: Harness["waitFor"] = async (fn, ms = 10_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v as any;
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const drain = async () => {
    await witden.runtime.drain();
    await worker.drain();
    await witden.runtime.drain();
  };
  return {
    witden,
    manager,
    worker,
    settings,
    api,
    login,
    adminToken: await login(ADMIN.email, ADMIN.password),
    drain,
    waitFor,
    async close() {
      setFetch((...args) => fetch(...args));
      await witden.close();
    },
  };
}

export function useScripts(scriptFor: (handle: string) => Script | undefined): void {
  setModelFactory(() => ({
    async complete(messages: ChatMessage[], tools?: ToolSchema[], onDelta?: OnDelta) {
      const system = String(messages[0]?.content ?? "");
      // The dispatcher of auto topics is scripted as "__dispatcher"; roles by the "(@handle)" in their prompt.
      const m = system.startsWith(DISPATCHER_PROMPT_START)
        ? [system, "__dispatcher"]
        : /\(@([a-z0-9_.-]+)\)/.exec(system);
      const script = m ? scriptFor(m[1]) : undefined;
      const out = script ? script(messages, tools) : reply(`${m?.[1] ?? "?"} has nothing to say`);
      // Stream the answer in a few pieces, like a real endpoint.
      if (onDelta) for (const piece of out.content.match(/[\s\S]{1,8}/g) ?? []) onDelta(piece);
      return out;
    },
  }));
}

/** How many model turns this task has had (assistant messages so far). */
export const turnOf = (messages: ChatMessage[]) => messages.filter((m) => m.role === "assistant").length;

export function lastToolResult(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  }
  return "";
}

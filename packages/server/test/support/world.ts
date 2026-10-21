/**
 * A small setup for end-to-end tests: two console accounts (alice, bob — administrators, like every console
 * account), three roles, one shared computer, and a topic with all of them. People outside the console are
 * Slack / Feishu members (see test/support/outside.ts).
 */
import type { ChatMessage, LLMResponse, ToolSchema } from "../../src/agent/llm.js";
import { type Harness, reply, type Script, startHarness, turnOf, useScripts } from "./harness.js";

export interface World extends Harness {
  alice: string;
  bob: string;
  ids: Record<string, string>;
  scripts: Record<string, (messages: ChatMessage[], turn: number, tools?: ToolSchema[]) => LLMResponse>;
  post(token: string, topicId: string, content: string): Promise<any>;
  messages(topicId: string, token?: string): Promise<any[]>;
  task(id: string, token?: string): Promise<any>;
}

export async function buildWorld(): Promise<World> {
  const h = await startHarness();
  const scripts: World["scripts"] = {};
  useScripts((handle): Script | undefined =>
    scripts[handle] ? (messages, tools) => scripts[handle](messages, turnOf(messages), tools) : undefined,
  );
  const admin = h.adminToken;
  const must = async (p: Promise<{ status: number; body: any; raw: string }>) => {
    const r = await p;
    if (r.status >= 300) throw new Error(`setup failed: ${r.status} ${r.raw}`);
    return r.body;
  };
  const alice = await must(
    h.api("POST", "/api/users", {
      token: admin,
      json: { name: "alice", email: "alice@example.com", password: "alice-pass-1" },
    }),
  );
  const bob = await must(
    h.api("POST", "/api/users", {
      token: admin,
      json: { name: "bob", email: "bob@example.com", password: "bob-pass-12" },
    }),
  );
  const ids: Record<string, string> = { alice: alice.id, bob: bob.id };
  const provider = await must(
    h.api("POST", "/api/model-providers", {
      token: admin,
      json: { name: "m", base_url: "http://llm/v1", models: ["x"] },
    }),
  );
  const cfg = provider.models[0];
  const tpl = await must(
    h.api("POST", "/api/templates", {
      token: admin,
      json: {
        name: "shell",
        image: "witden/computer-shell:latest",
        persistent_paths: ["/home/witden"],
        default_resources: { cpus: 1, memory_mb: 512 },
      },
    }),
  );
  const inst = await must(
    h.api("POST", "/api/instances", { token: admin, json: { template_id: tpl.id, name: "team-box" } }),
  );
  ids.model = cfg.id;
  ids.template = tpl.id;
  ids.instance = inst.id;
  await h.drain();
  await h.waitFor(
    async () => (await h.api("GET", `/api/instances/${inst.id}`, { token: admin })).body.runner?.connected,
  );
  const role = async (handle: string, tools: string[], extra: Record<string, unknown> = {}) =>
    (
      await must(
        h.api("POST", "/api/roles", {
          token: admin,
          json: {
            name: handle[0].toUpperCase() + handle.slice(1),
            handle,
            description: `${handle} role`,
            model_config_id: cfg.id,
            instance_id: inst.id,
            allowed_tools: tools,
            // Tests opt into approvals explicitly; new roles otherwise ask before reaching outside their computer.
            approval_required: [],
            ...extra,
          },
        }),
      )
    ).id as string;
  ids.dev = await role("dev", ["shell", "files", "memory", "terminal", "browser", "desktop"]);
  ids.test = await role("test", ["shell"]);
  ids.analyst = await role("analyst", ["memory"]);
  const aliceToken = await h.login("alice@example.com", "alice-pass-1");
  const bobToken = await h.login("bob@example.com", "bob-pass-12");
  const topic = await must(
    h.api("POST", "/api/topics", {
      token: aliceToken,
      json: { title: "Release 1.0", user_ids: [bob.id], role_ids: [ids.dev, ids.test, ids.analyst] },
    }),
  );
  ids.topic = topic.id;
  return {
    ...h,
    alice: aliceToken,
    bob: bobToken,
    ids,
    scripts,
    async post(token, topicId, content) {
      const r = await h.api("POST", `/api/topics/${topicId}/messages`, { token, json: { content } });
      if (r.status !== 200) throw new Error(`post failed: ${r.raw}`);
      return r.body;
    },
    async messages(topicId, token = aliceToken) {
      return (await h.api("GET", `/api/topics/${topicId}/messages`, { token })).body;
    },
    async task(id, token = aliceToken) {
      return (await h.api("GET", `/api/tasks/${id}`, { token })).body;
    },
  };
}

export { reply };

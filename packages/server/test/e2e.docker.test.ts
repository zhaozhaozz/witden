/**
 * End to end against real Docker: platform (API + worker + hub in one process), the in-process Docker
 * Manager, a real shell computer whose runner dials back over WebSocket, and a scripted OpenAI-compatible
 * model served locally. Run with WITDEN_DOCKER_TESTS=1 after building witden/computer-shell:latest.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start, type Witden } from "../src/app.js";
import { loadSettings } from "../src/config.js";
import { ADMIN } from "./support/harness.js";

const enabled = process.env.WITDEN_DOCKER_TESTS === "1";
const suffix = Math.random().toString(36).slice(2, 7);

/** OpenAI-style endpoint: the first turn of each task runs a command, the next one reports its output. */
function scriptedModel(): Promise<{ url: string; requests: any[]; close(): Promise<void> }> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const data = JSON.parse(body || "{}");
      requests.push(data);
      const messages: any[] = data.messages ?? [];
      const tool = [...messages].reverse().find((m) => m.role === "tool");
      const message = tool
        ? { role: "assistant", content: `done: ${String(tool.content).slice(0, 400)}` }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${requests.length}`,
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify({ command: "echo witden-e2e > hello.txt && cat hello.txt && whoami" }),
                },
              },
            ],
          };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 6 } }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "0.0.0.0", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe.skipIf(!enabled)("end to end with Docker", () => {
  let witden: Witden;
  let model: Awaited<ReturnType<typeof scriptedModel>>;
  let token = "";
  let instanceId = "";

  const api = async (method: string, url: string, json?: unknown) => {
    const res = await witden.app!.inject({
      method: method as any,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(json !== undefined ? { payload: json as any } : {}),
    });
    if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 90_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  beforeAll(async () => {
    model = await scriptedModel();
    const hubPort = await freePort();
    const settings = loadSettings({
      dataDir: `.tmp/e2e/${suffix}`,
      databaseUrl: "pglite://memory",
      secretKey: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=",
      bootstrapAdminEmail: ADMIN.email,
      bootstrapAdminPassword: ADMIN.password,
      processRole: "all",
      hubPort,
      hubHost: "0.0.0.0",
      hubUrlForComputers: `ws://witden-hub:${hubPort}/runner`,
    });
    witden = await start({ settings });
    token = (await api("POST", "/api/auth/login", { email: ADMIN.email, password: ADMIN.password })).token;
  }, 60_000);

  afterAll(async () => {
    if (instanceId) {
      await api("POST", `/api/instances/${instanceId}/actions`, { action: "delete", confirm: true }).catch(() => {});
      await waitFor(async () => (await api("GET", `/api/instances/${instanceId}`)).status === "deleted", 60_000).catch(
        () => {},
      );
    }
    await witden?.close();
    await model?.close();
  }, 90_000);

  it("creates a computer whose runner connects back through the hub", async () => {
    const tpl = await api("POST", "/api/templates", {
      name: `e2e-shell-${suffix}`,
      image: "witden/computer-shell:latest",
      persistent_paths: ["/home/witden"],
      default_resources: { memory_mb: 512, pids_limit: 256 },
    });
    const inst = await api("POST", "/api/instances", { template_id: tpl.id, name: `e2e-${suffix}` });
    instanceId = inst.id;
    const ready = await waitFor(async () => {
      const r = await api("GET", `/api/instances/${instanceId}`);
      if (r.status === "error") throw new Error(`instance failed: ${r.status_reason}`);
      return r.status === "running" && r.runner.connected && r;
    });
    expect(ready.runner.via).toBe("websocket");
    expect(ready.runner.info.user).toBe("witden");
  }, 120_000);

  it("a role runs a command on its computer and answers in the topic", async () => {
    const provider = await api("POST", "/api/model-providers", {
      name: `e2e-${suffix}`,
      base_url: model.url,
      models: ["scripted"],
    });
    const cfg = provider.models[0];
    const role = await api("POST", "/api/roles", {
      name: "Dev",
      handle: `dev${suffix}`,
      model_config_id: cfg.id,
      instance_id: instanceId,
      allowed_tools: ["shell", "files"],
    });
    const topic = await api("POST", "/api/topics", { title: "e2e", role_ids: [role.id] });
    const posted = await api("POST", `/api/topics/${topic.id}/messages`, { content: `@dev${suffix} write the file` });
    const taskId = posted.tasks[0].id;
    const task = await waitFor(async () => {
      const t = await api("GET", `/api/tasks/${taskId}`);
      return ["completed", "failed"].includes(t.status) && t;
    });
    expect(task.status, task.error ?? "").toBe("completed");
    const messages = await api("GET", `/api/topics/${topic.id}/messages`);
    const answer = messages.find((m: any) => m.author_type === "role");
    expect(answer.content).toContain("witden-e2e");
    // AI work runs as the unprivileged user, in the role's own computer
    expect(answer.content).toContain("witden");
    const trace = await api("GET", `/api/tasks/${taskId}/trace`);
    expect(JSON.stringify(trace)).toContain("hello.txt");
    // the platform reads the file back through the runner
    const read = await api("POST", `/api/instances/${instanceId}/exec`, { command: "cat ~/hello.txt" });
    expect(read.output).toContain("witden-e2e");
  }, 120_000);

  it("programs inside the computer reach allowed models through the local proxy only", async () => {
    const provider = await api("POST", "/api/model-providers", {
      name: `proxy-${suffix}`,
      base_url: model.url,
      api_key: "sk-host-only-secret-123456",
      models: ["scripted"],
    });
    await api("PUT", `/api/instances/${instanceId}/model-proxy`, { enabled: true, model_ids: [provider.models[0].id] });
    const run = async (command: string) =>
      (await api("POST", `/api/instances/${instanceId}/exec`, { command })).output as string;
    const env = await waitFor(async () => {
      const out = await run("cat ~/.config/witden/model-proxy.env 2>/dev/null");
      return out.includes("OPENAI_BASE_URL") && out;
    }, 30_000);
    expect(env).toContain("OPENAI_BASE_URL=http://127.0.0.1:8686/v1");
    expect(env).not.toContain("sk-host-only");
    expect(env).not.toContain(model.url);
    // a login shell picks the settings up, as an agent installed in the computer would
    const body = JSON.stringify({ model: "scripted", messages: [{ role: "user", content: "hi" }] });
    const answer = await run(
      `bash -lc 'curl -s "$OPENAI_BASE_URL/chat/completions" -H "Authorization: Bearer $OPENAI_API_KEY" -H "content-type: application/json" -d '"'"'${body}'"'"''`,
    );
    expect(answer).toContain("tool_calls");
    const listed = await run(`bash -lc 'curl -s "$OPENAI_BASE_URL/models" -H "Authorization: Bearer $OPENAI_API_KEY"'`);
    expect(JSON.parse(listed.slice(listed.indexOf("{"))).data.map((m: any) => m.id)).toEqual(["scripted"]);
    const refused = await run(
      `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8686/v1/models -H "Authorization: Bearer nope"`,
    );
    expect(refused).toContain("401");
    await api("PUT", `/api/instances/${instanceId}/model-proxy`, { enabled: false });
    await waitFor(async () => !(await run("ls ~/.config/witden/ 2>/dev/null")).includes("model-proxy.env"), 30_000);
  }, 120_000);
});

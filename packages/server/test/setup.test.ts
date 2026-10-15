/** The first-run guide: after a model is chosen, a desktop computer, a system administrator and an assistant. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, reply, startHarness, useScripts } from "./support/harness.js";

let h: Harness;
let modelId: string;

beforeEach(async () => {
  h = await startHarness();
  useScripts((handle) => (handle === "assistant" ? () => reply("你好，我是助手") : undefined));
  const provider = await h.api("POST", "/api/model-providers", {
    token: h.adminToken,
    json: { name: "m", base_url: "http://llm/v1", api_key: "sk-test-key-0123456789", models: ["x"] },
  });
  expect(provider.status, provider.raw).toBe(200);
  modelId = provider.body.models[0].id;
});
afterEach(async () => {
  await h.close();
});

const status = async () => (await h.api("GET", "/api/setup", { token: h.adminToken })).body;

describe("first-run setup", () => {
  it("is offered on a fresh platform and creates everything needed to start from one model", async () => {
    expect(await status()).toMatchObject({ needed: true, finished_at: null });
    const res = await h.api("POST", "/api/setup/finish", { token: h.adminToken, json: { model_config_id: modelId } });
    expect(res.status, res.raw).toBe(200);
    expect((await status()).needed).toBe(false);

    // a desktop computer from the built-in template, started in the background
    const computer = (await h.api("GET", `/api/instances/${res.body.computer.id}`, { token: h.adminToken })).body;
    expect(computer).toMatchObject({ name: "desktop", spec: { kind: "desktop", template_name: "desktop-browser" } });
    await h.drain();
    await h.waitFor(
      async () =>
        (await h.api("GET", `/api/instances/${computer.id}`, { token: h.adminToken })).body.status === "running",
    );

    // a system administrator (no computer) and an assistant on the desktop, both on the chosen model
    const roles = (await h.api("GET", "/api/roles", { token: h.adminToken })).body;
    const admin = roles.find((r: any) => r.id === res.body.admin_role_id);
    const assistant = roles.find((r: any) => r.id === res.body.assistant_role_id);
    expect(admin).toMatchObject({ handle: "admin", system_admin: true, model_config_id: modelId, instance_id: null });
    expect(assistant).toMatchObject({ handle: "assistant", system_admin: false, model_config_id: modelId });
    expect(assistant.instance_id).toBe(computer.id);
    expect(assistant.allowed_tools).toContain("desktop");

    // and a DM with the assistant that works right away
    const posted = await h.api("POST", `/api/topics/${res.body.dm_id}/messages`, {
      token: h.adminToken,
      json: { content: "你好" },
    });
    expect(posted.status, posted.raw).toBe(200);
    await h.drain();
    const messages = (await h.api("GET", `/api/topics/${res.body.dm_id}/messages`, { token: h.adminToken })).body;
    expect(messages.map((m: any) => m.content)).toContain("你好，我是助手");

    // finishing again creates nothing twice
    const again = await h.api("POST", "/api/setup/finish", { token: h.adminToken, json: { model_config_id: modelId } });
    expect(again.body).toMatchObject({
      computer: { id: computer.id },
      admin_role_id: admin.id,
      assistant_role_id: assistant.id,
      dm_id: res.body.dm_id,
    });
    expect((await h.api("GET", "/api/instances", { token: h.adminToken })).body).toHaveLength(1);
    expect((await h.api("GET", "/api/roles", { token: h.adminToken })).body).toHaveLength(2);
  });

  it("needs a chat model, and can be skipped", async () => {
    const decider = await h.api("POST", "/api/model-providers", {
      token: h.adminToken,
      json: { name: "laya", protocol: "systemone", base_url: "http://laya:8000", models: ["multilingual"] },
    });
    const refused = await h.api("POST", "/api/setup/finish", {
      token: h.adminToken,
      json: { model_config_id: decider.body.models[0].id },
    });
    expect(refused.status).toBe(400);
    expect(refused.raw).toContain("cannot chat");
    expect((await h.api("POST", "/api/setup/finish", { token: h.adminToken, json: {} })).status).toBe(404);

    expect((await h.api("POST", "/api/setup/skip", { token: h.adminToken })).status).toBe(200);
    expect(await status()).toMatchObject({ needed: false, finished_at: null });
    // only the built-in system administrator
    const roles = (await h.api("GET", "/api/roles", { token: h.adminToken })).body;
    expect(roles.map((r: any) => [r.handle, r.system_admin])).toEqual([["admin", true]]);
  });

  it("is not offered once roles exist", async () => {
    await h.api("POST", "/api/roles", { token: h.adminToken, json: { name: "Dev", handle: "dev" } });
    expect((await status()).needed).toBe(false);
  });
});

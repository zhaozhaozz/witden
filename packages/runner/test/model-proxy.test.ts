import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { ProxyRequestMessage } from "@witden/shared";
import { afterAll, describe, expect, it } from "vitest";
import { ENV_FILE } from "../src/model-proxy.js";
import { makeRunner } from "./helpers.js";

const { core, hub, home } = makeRunner("model-proxy");
afterAll(() => core.shutdown());

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

const nextRequest = (from: number) => hub.waitFor<ProxyRequestMessage>((m) => m.type === "proxy.request", 5000, from);

describe("model proxy", () => {
  it("serves a local endpoint, relays requests and streams the answer back", async () => {
    const port = await freePort();
    core.handleMessage({ type: "welcome", serverTime: "now", modelProxy: { port, key: "wdm_k1", models: ["m1"] } });
    await expect.poll(() => core.modelProxy.port).toBe(port);

    const envFile = path.join(home, ENV_FILE);
    const env = readFileSync(envFile, "utf8");
    expect(env).toContain(`OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`);
    expect(env).toContain("OPENAI_API_KEY=wdm_k1");
    expect(env).toContain("WITDEN_MODELS=m1");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);

    const from = hub.messages.length;
    const answer = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer wdm_k1", "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: true }),
    });
    const req = await nextRequest(from);
    expect(req).toMatchObject({ method: "POST", path: "/v1/chat/completions" });
    expect(req.headers.authorization).toBe("Bearer wdm_k1");
    expect(JSON.parse(Buffer.from(req.bodyBase64, "base64").toString())).toEqual({ model: "m1", stream: true });
    core.handleMessage({
      type: "proxy.response",
      id: req.id,
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    for (const part of ["data: one\n\n", "data: two\n\n"]) {
      core.handleMessage({ type: "proxy.chunk", id: req.id, dataBase64: Buffer.from(part).toString("base64") });
    }
    core.handleMessage({ type: "proxy.end", id: req.id });
    const res = await answer;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: one\n\ndata: two\n\n");
  });

  it("fails cleanly when the platform connection drops, and stops when turned off", async () => {
    const port = core.modelProxy.port!;
    const from = hub.messages.length;
    const pending = fetch(`http://127.0.0.1:${port}/v1/models`);
    await nextRequest(from);
    core.modelProxy.disconnected();
    const res = await pending;
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain("connection to the platform was lost");

    core.handleMessage({ type: "configure", modelProxy: null });
    await expect.poll(() => core.modelProxy.port).toBeNull();
    await expect(fetch(`http://127.0.0.1:${port}/v1/models`)).rejects.toThrow();
    expect(existsSync(path.join(home, ENV_FILE))).toBe(false);
  });

  it("tells the client when the computer is not connected", async () => {
    const port = await freePort();
    await core.modelProxy.configure({ port, key: "k", models: [] });
    core.detach(hub);
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(res.status).toBe(503);
    core.attach(hub);
    await core.modelProxy.configure(null);
  });
});

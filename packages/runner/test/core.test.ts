import { PassThrough } from "node:stream";
import { encodeStdioFrame, type HelloMessage, type ResponseMessage, StdioFrameDecoder } from "@witden/shared";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { serveStdio, WebSocketClient } from "../src/index.js";
import { errorCode, makeRunner, ok, waitUntil } from "./helpers.js";

const runner = makeRunner("core");
const { core, hub } = runner;

afterAll(async () => {
  await core.shutdown();
});

describe("core", () => {
  it("builds hello from the instance settings", async () => {
    const hello = await core.hello();
    expect(hello).toMatchObject({ type: "hello", protocol: 1, instanceId: "inst-test", token: "token-test" });
    expect(hello.info.uid).toBe(process.getuid?.());
    expect(hello.info.desktop).toBeNull();
    expect(hello.info.tools).toEqual(expect.arrayContaining(["exec", "file", "terminal"]));
  });

  it("answers unknown ops and malformed requests without crashing", async () => {
    expect(errorCode(await hub.request("nope.op"))).toBe("unsupported");
    core.handleText("not json");
    core.handleMessage(null);
    core.handleMessage({ type: "request", op: "exec.run" });
    core.handleMessage({ type: "mystery" });
    core.handleBinary(new Uint8Array([1]));
    const id = `bad-params-${Date.now()}`;
    core.handleMessage({ type: "request", id, op: "file.read", params: "x", timeoutMs: 1000 });
    const r = await hub.waitFor<ResponseMessage>((m) => m.type === "response" && m.id === id);
    expect(r.error?.code).toBe("invalid");
    expect(errorCode(await hub.request("journal.get", {}))).toBe("invalid");
    // Requests rejected before running must not stay registered as in flight.
    expect(core.inflightCount).toBe(0);
  });

  it("answers pings", async () => {
    core.handleMessage({ type: "ping", at: 42 });
    await hub.waitFor((m) => m.type === "pong" && m.at === 42);
  });

  it("lists processes and reports system info", async () => {
    const procs = ok(await hub.request("process.list")).processes as { pid: number; command: string }[];
    expect(procs.some((p) => p.pid === process.pid)).toBe(true);
    const info = ok(await hub.request("system.info"));
    expect(info).toMatchObject({ protocol: 1, pid: process.pid, workdir: runner.workdir });
  });

  it("reports desktop and browser ops as unsupported without them", async () => {
    expect(errorCode(await hub.request("screen.capture"))).toBe("unsupported");
    expect(errorCode(await hub.request("input.mouse", { action: "click", x: 1, y: 1 }))).toBe("unsupported");
    expect(errorCode(await hub.request("input.keyboard", { text: "x" }))).toBe("unsupported");
    expect(errorCode(await hub.request("browser.open", { url: "https://example.com", mode: "desktop" }))).toBe(
      "unsupported",
    );
    expect(errorCode(await hub.request("browser.open", { url: "https://example.com", mode: "background" }))).toBe(
      "unsupported",
    );
    expect(errorCode(await hub.request("browser.snapshot", { sessionId: "nope" }))).toBe("not_found");
    expect(ok(await hub.request("browser.list"))).toEqual({ sessions: [] });
  });

  it("times out handlers generically and refuses work beyond the concurrency limit", async () => {
    const limited = makeRunner("core-busy", { maxConcurrent: 1 });
    const slow = limited.hub.request("exec.run", { command: "sleep 1" });
    expect(errorCode(await limited.hub.request("process.list"))).toBe("busy");
    expect(ok(await slow).exitCode).toBe(0);
    await limited.core.shutdown();
  });
});

describe("transports", () => {
  it("speaks the protocol over stdio frames", async () => {
    const r = makeRunner("stdio");
    r.core.detach(r.hub);
    const input = new PassThrough();
    const output = new PassThrough();
    const frames = new StdioFrameDecoder();
    const messages: any[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const f of frames.push(chunk)) messages.push(JSON.parse(new TextDecoder().decode(f.payload)));
    });
    const done = serveStdio(r.core, input, output);
    await waitUntil(() => messages.some((m) => m.type === "hello"));
    const request = {
      type: "request",
      id: "s1",
      op: "exec.run",
      params: { command: "echo via-stdio" },
      timeoutMs: 5000,
    };
    input.write(encodeStdioFrame("text", new TextEncoder().encode(JSON.stringify(request))));
    const response = await waitUntil(() => messages.find((m) => m.type === "response" && m.id === "s1"));
    expect(response.result.output).toBe("via-stdio\n");
    input.end();
    await done;
    await r.core.shutdown();
  });

  it("dials the hub over WebSocket, authenticates and reconnects", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => wss.once("listening", resolve));
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/runner`;
    const hellos: HelloMessage[] = [];
    const responses: ResponseMessage[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "hello") {
          hellos.push(msg);
          ws.send(JSON.stringify({ type: "welcome", serverTime: new Date().toISOString() }));
          ws.send(
            JSON.stringify({
              type: "request",
              id: `w${hellos.length}`,
              op: "exec.run",
              params: { command: "echo ws" },
              timeoutMs: 5000,
            }),
          );
        } else if (msg.type === "response") {
          responses.push(msg);
          if (responses.length === 1) ws.terminate(); // force a reconnect
        }
      });
    });
    const r = makeRunner("ws");
    r.core.detach(r.hub);
    const client = new WebSocketClient(r.core, { url, minBackoffMs: 50, maxBackoffMs: 200 });
    client.start();
    await waitUntil(() => responses.length >= 2, 10_000);
    expect(hellos).toHaveLength(2);
    expect(hellos[0]).toMatchObject({ instanceId: "inst-test", token: "token-test", protocol: 1 });
    expect(responses.map((m) => (m.result as any).output)).toEqual(["ws\n", "ws\n"]);
    client.stop();
    await r.core.shutdown();
    await new Promise((resolve) => wss.close(resolve));
  });
});

import type { AddressInfo } from "node:net";
import type {
  BackupRequest,
  BackupResult,
  ComputerSpec,
  ContainerState,
  ContainerStats,
  CreateComputerResult,
  ManagerApi,
  RemoveComputerRequest,
  RestoreRequest,
  RunnerChannel,
  VolumeUsageRequest,
} from "@witden/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RelayChannel } from "../src/channel.js";
import { ManagerClient } from "../src/client.js";
import { ManagerError } from "../src/errors.js";
import { createManagerServer } from "../src/http-server.js";

const TOKEN = "test-token-0123456789abcdef";

/** Records calls; container ids pick the failure mode. */
class FakeManager implements ManagerApi {
  calls: [string, ...unknown[]][] = [];

  private check(id: string): void {
    if (id === "missing") throw new ManagerError("not_found", "computer missing not found");
    if (id === "foreign") throw new ManagerError("not_managed", "container foreign is not managed by witden");
    if (id === "broken") throw new ManagerError("docker_error", "daemon said no");
    if (id === "crash") throw new Error("unexpected secret detail");
  }

  async health() {
    return { ok: true, docker: "fake-1.0" };
  }
  async ensureImage(image: string) {
    this.calls.push(["ensureImage", image]);
  }
  async create(spec: ComputerSpec): Promise<CreateComputerResult> {
    this.calls.push(["create", spec]);
    if (spec.name === "Bad") throw new ManagerError("invalid", "computer name is not valid");
    return { containerId: `c-${spec.name}`, warnings: ["disk quota not enforced"] };
  }
  async start(id: string) {
    this.check(id);
    this.calls.push(["start", id]);
  }
  async stop(id: string, timeoutSec?: number) {
    this.check(id);
    this.calls.push(["stop", id, timeoutSec]);
  }
  async restart(id: string, timeoutSec?: number) {
    this.check(id);
    this.calls.push(["restart", id, timeoutSec]);
  }
  async remove(id: string | null, request: RemoveComputerRequest) {
    if (id) this.check(id);
    this.calls.push(["remove", id, request]);
  }
  async state(id: string | null): Promise<ContainerState> {
    if (id) this.check(id);
    return { exists: true, running: true, status: "running", exitCode: 0, oomKilled: false, startedAt: "now" };
  }
  async stats(id: string): Promise<ContainerStats> {
    this.check(id);
    return {
      cpuPercent: 1.5,
      memoryBytes: 10,
      memoryLimitBytes: null,
      netRxBytes: 1,
      netTxBytes: 2,
      blockReadBytes: 3,
      blockWriteBytes: 4,
      pids: 5,
    };
  }
  async volumeUsage(request: VolumeUsageRequest) {
    this.calls.push(["volumeUsage", request]);
    return Object.fromEntries(request.volumes.map((v) => [v, 42]));
  }
  async backup(id: string, request: BackupRequest): Promise<BackupResult> {
    this.check(id);
    this.calls.push(["backup", id, request]);
    return { imageRef: `witden-backup:${request.backupId}`, archives: { "/workspace": "0.tar" }, sizeBytes: 99 };
  }
  async restore(request: RestoreRequest): Promise<CreateComputerResult> {
    this.calls.push(["restore", request]);
    return { containerId: "restored", warnings: [] };
  }
  async deleteBackup(backupId: string) {
    this.calls.push(["deleteBackup", backupId]);
  }
  async openRunnerChannel(id: string): Promise<RunnerChannel> {
    this.check(id);
    // Echo runner: answers every chunk with "echo:" + chunk; "bye" makes it exit.
    const channel: RelayChannel = new RelayChannel({
      send: (data) => {
        if (Buffer.from(data).toString() === "bye") {
          setImmediate(() => channel.emitClose("runner exited with code 0"));
          return;
        }
        setImmediate(() => channel.emitData(new Uint8Array(Buffer.concat([Buffer.from("echo:"), data]))));
      },
      close: () => this.calls.push(["channelClosed", id]),
    });
    return channel;
  }
}

const spec = { name: "box", instanceId: "inst_1" } as ComputerSpec;

describe("manager HTTP server", () => {
  const fake = new FakeManager();
  let app: FastifyInstance;
  let baseUrl: string;
  let client: ManagerClient;

  beforeAll(async () => {
    app = createManagerServer(fake, { token: TOKEN });
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    client = new ManagerClient({ baseUrl, token: TOKEN });
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves an unauthenticated health check without details", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects requests without or with a wrong token", async () => {
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`, TOKEN, `bearer  ${TOKEN}`]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/computers/abc/start",
        headers: authorization ? { authorization } : {},
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: "unauthorized", message: "missing or invalid manager token" } });
    }
    // Unknown routes do not reveal anything before authentication either.
    expect((await app.inject({ method: "GET", url: "/v1/nope" })).statusCode).toBe(401);
    expect(fake.calls.filter((c) => c[0] === "start")).toEqual([]);

    const ok = await app.inject({ method: "GET", url: "/v1/health", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, docker: "fake-1.0" });
  });

  it("maps errors to status codes and ManagerErrorBody", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const cases: [string, number, string][] = [
      ["missing", 404, "not_found"],
      ["foreign", 403, "not_managed"],
      ["broken", 502, "docker_error"],
      ["crash", 500, "internal"],
    ];
    for (const [id, status, code] of cases) {
      const res = await app.inject({ method: "POST", url: `/v1/computers/${id}/start`, headers: auth });
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(code);
    }
    const crash = await app.inject({ method: "POST", url: "/v1/computers/crash/start", headers: auth });
    expect(crash.json().error.message).toBe("internal error");

    const bad = await app.inject({ method: "POST", url: "/v1/computers", headers: auth, payload: { name: "Bad" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: { code: "invalid", message: "computer name is not valid" } });

    const badJson = await app.inject({
      method: "POST",
      url: "/v1/computers",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().error.code).toBe("invalid");

    const notObject = await app.inject({ method: "POST", url: "/v1/computers", headers: auth, payload: [1, 2] });
    expect(notObject.statusCode).toBe(400);

    const unknown = await app.inject({ method: "GET", url: "/v1/nope", headers: auth });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");
  });

  it("round-trips every method through ManagerClient", async () => {
    fake.calls = [];
    expect(await client.health()).toEqual({ ok: true, docker: "fake-1.0" });
    await client.ensureImage("debian:bookworm-slim");
    expect(await client.create(spec)).toEqual({ containerId: "c-box", warnings: ["disk quota not enforced"] });
    await client.start("c-box");
    await client.stop("c-box", 3);
    await client.restart("c-box");
    await client.remove("c-box", { volumes: ["witden-box-ws"], removeVolumes: true });
    await client.remove(null, { volumes: ["witden-box-old"], removeVolumes: true });
    await client.remove(null, { volumes: ["witden-box-kept"], removeVolumes: false });
    expect((await client.state("c-box")).status).toBe("running");
    expect(await client.state(null)).toEqual({ exists: false, running: false, status: "missing" });
    expect((await client.stats("c-box")).pids).toBe(5);
    expect(await client.volumeUsage({ volumes: ["witden-box-ws"] })).toEqual({ "witden-box-ws": 42 });
    expect(await client.backup("c-box", { backupId: "bk1", mounts: ["/workspace"] })).toEqual({
      imageRef: "witden-backup:bk1",
      archives: { "/workspace": "0.tar" },
      sizeBytes: 99,
    });
    const restore: RestoreRequest = {
      spec,
      replaceContainerId: null,
      backupId: "bk1",
      imageRef: "witden-backup:bk1",
      archives: { "/workspace": "0.tar" },
      scrubPaths: ["/root/.ssh"],
    };
    expect(await client.restore(restore)).toEqual({ containerId: "restored", warnings: [] });
    await client.deleteBackup("bk1");

    expect(fake.calls).toEqual([
      ["ensureImage", "debian:bookworm-slim"],
      ["create", spec],
      ["start", "c-box"],
      ["stop", "c-box", 3],
      ["restart", "c-box", undefined],
      ["remove", "c-box", { volumes: ["witden-box-ws"], removeVolumes: true }],
      ["remove", null, { volumes: ["witden-box-old"], removeVolumes: true }],
      ["volumeUsage", { volumes: ["witden-box-ws"] }],
      ["backup", "c-box", { backupId: "bk1", mounts: ["/workspace"] }],
      ["restore", restore],
      ["deleteBackup", "bk1"],
    ]);
  });

  it("rebuilds ManagerError on the client side", async () => {
    await expect(client.start("foreign")).rejects.toMatchObject({ name: "ManagerError", code: "not_managed" });
    await expect(client.stats("missing")).rejects.toMatchObject({ code: "not_found", message: /missing/ });
    const wrong = new ManagerClient({ baseUrl, token: "nope" });
    await expect(wrong.health()).rejects.toMatchObject({ code: "unauthorized" });
    const down = new ManagerClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN });
    await expect(down.health()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("relays the runner channel over WebSocket", async () => {
    const channel = await client.openRunnerChannel("c-box");
    const received: string[] = [];
    const closed = new Promise<string>((resolve) => channel.onClose(resolve));
    const echoed = new Promise<void>((resolve) =>
      channel.onData((data) => {
        received.push(Buffer.from(data).toString());
        if (received.length === 2) resolve();
      }),
    );
    channel.send(new TextEncoder().encode("one"));
    channel.send(new Uint8Array([0, 255, 10]));
    await echoed;
    expect(received[0]).toBe("echo:one");
    expect([...Buffer.from(received[1], "latin1")].length).toBeGreaterThan(0);
    channel.send(new TextEncoder().encode("bye"));
    expect(await closed).toBe("runner exited with code 0");
  });

  it("closes the manager-side channel when the client disconnects", async () => {
    fake.calls = [];
    const channel = await client.openRunnerChannel("c-box");
    channel.close();
    await expect.poll(() => fake.calls).toContainEqual(["channelClosed", "c-box"]);
  });

  it("reports runner channel failures as HTTP errors", async () => {
    await expect(client.openRunnerChannel("foreign")).rejects.toMatchObject({ code: "not_managed" });
    await expect(client.openRunnerChannel("missing")).rejects.toMatchObject({ code: "not_found" });
    const wrong = new ManagerClient({ baseUrl, token: "nope" });
    await expect(wrong.openRunnerChannel("c-box")).rejects.toMatchObject({ code: "unauthorized" });
  });
});

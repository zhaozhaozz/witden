/** Templates, computer lifecycle, the execution boundary and desktop control. */

import { RUNNER_PROTOCOL_VERSION } from "@witden/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutionGateway } from "../src/compute/gateway.js";
import { memoryTransportPair, RunnerHub } from "../src/compute/hub.js";
import { db } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import { computerInstances, instanceLeases, roles, tasks, topics } from "../src/db/schema.js";
import { InstanceBusy, InstanceUnavailable } from "../src/errors.js";
import { FakeComputer } from "./support/fake-computer.js";
import { type Harness, startHarness } from "./support/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

async function template(overrides: Record<string, unknown> = {}) {
  const res = await h.api("POST", "/api/templates", {
    token: h.adminToken,
    json: { name: "shell", image: "witden/computer-shell:latest", persistent_paths: ["/home/witden"], ...overrides },
  });
  expect(res.status, res.raw).toBe(200);
  return res.body;
}

async function instance(templateId: string, name: string) {
  const res = await h.api("POST", "/api/instances", { token: h.adminToken, json: { template_id: templateId, name } });
  expect(res.status, res.raw).toBe(200);
  await h.drain();
  return h.waitFor(async () => {
    const r = (await h.api("GET", `/api/instances/${res.body.id}`, { token: h.adminToken })).body;
    return r.status === "running" && r.runner.connected && r;
  });
}

describe("templates", () => {
  it.each([
    [{ persistent_paths: ["/"] }, "not allowed"],
    [{ persistent_paths: ["/etc"] }, "not allowed"],
    [{ cap_add: ["SYS_ADMIN"] }, "capabilities not allowed"],
    [{ runtime: "evil" }, "runtime"],
    [{ default_resources: { network: "host" } }, "network"],
    [{ default_resources: { memory_mb: 1 } }, "memory_mb"],
    [{ user: "root" }, "unprivileged"],
    [{ env: { WITDEN_RUNNER_TOKEN: "x" } }, "reserved"],
    [{ software: ["-o", "APT::Update::Pre-Invoke::=sh"] }, "not Debian package names"],
  ])("rejects unsafe config %o", async (overrides, message) => {
    const res = await h.api("POST", "/api/templates", {
      token: h.adminToken,
      json: { name: "bad", image: "debian", ...overrides },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(message);
  });

  it("versions templates without moving existing computers; protects templates in use", async () => {
    const tpl = await template();
    const inst = await instance(tpl.id, "box-1");
    const updated = (
      await h.api("PATCH", `/api/templates/${tpl.id}`, { token: h.adminToken, json: { software: ["git"] } })
    ).body;
    expect(updated.version).toBe(2);
    expect((await h.api("GET", `/api/instances/${inst.id}`, { token: h.adminToken })).body.template_version).toBe(1);
    const copy = (
      await h.api("POST", `/api/templates/${tpl.id}/copy`, { token: h.adminToken, json: { name: "shell-2" } })
    ).body;
    expect(copy.image).toBe(tpl.image);
    expect((await h.api("DELETE", `/api/templates/${tpl.id}`, { token: h.adminToken })).status).toBe(409);
  });

  it("a computer's software list starts as its template's and is installed whenever the computer starts", async () => {
    const tpl = await template({ software: "ffmpeg, jq" });
    expect(tpl.software).toEqual(["ffmpeg", "jq"]);
    const inst = await instance(tpl.id, "box-1");
    expect(inst.software).toEqual(["ffmpeg", "jq"]);
    const get = async () => (await h.api("GET", `/api/instances/${inst.id}`, { token: h.adminToken })).body;
    await h.waitFor(async () => (await get()).software_status?.state === "ok");
    expect([...h.manager.computer(inst.id).packages].sort()).toEqual(["ffmpeg", "jq"]);

    // The computer's own list changes; the template's does not.
    const patched = await h.api("PATCH", `/api/instances/${inst.id}`, {
      token: h.adminToken,
      json: { software: ["ffmpeg", "no-such-tool"] },
    });
    expect(patched.body.software).toEqual(["ffmpeg", "no-such-tool"]);
    expect((await h.api("GET", `/api/templates/${tpl.id}`, { token: h.adminToken })).body.software).toEqual([
      "ffmpeg",
      "jq",
    ]);
    const bad = await h.api("PATCH", `/api/instances/${inst.id}`, { token: h.adminToken, json: { software: ["A B"] } });
    expect(bad.status).toBe(400);

    // A reset recreates the container without any of it: the list comes back, and what fails is reported.
    await h.api("POST", `/api/instances/${inst.id}/actions`, {
      token: h.adminToken,
      json: { action: "reset", confirm: true },
    });
    await h.drain();
    await h.waitFor(async () => (await get()).software_status?.state === "failed");
    expect((await get()).software_status).toMatchObject({ missing: ["no-such-tool"] });
    expect([...h.manager.computer(inst.id).packages]).toEqual(["ffmpeg"]);

    // Installing the list on request.
    await h.api("PATCH", `/api/instances/${inst.id}`, { token: h.adminToken, json: { software: ["ffmpeg", "jq"] } });
    const now = await h.api("POST", `/api/instances/${inst.id}/software/install`, { token: h.adminToken });
    expect(now.status, now.raw).toBe(200);
    await h.drain();
    await h.waitFor(async () => (await get()).software_status?.state === "ok");
    expect([...h.manager.computer(inst.id).packages].sort()).toEqual(["ffmpeg", "jq"]);
  });
});

describe("instances", () => {
  it("lifecycle, shared scope and previews", async () => {
    const tpl = await template();
    const inst = await instance(tpl.id, "box-1");
    expect(inst.shared_scope.credential_paths).toContain("/home/witden/.ssh");
    expect(inst.runner.connected).toBe(true);
    const reset = await h.api("POST", `/api/instances/${inst.id}/actions`, {
      token: h.adminToken,
      json: { action: "reset" },
    });
    expect(reset.body.error.code).toBe("confirmation_required");
    const preview = (
      await h.api("GET", `/api/instances/${inst.id}/preview/reset?keep_volumes=false`, { token: h.adminToken })
    ).body;
    expect(preview.will_clear.some((x: string) => x.includes("/home/witden"))).toBe(true);
    await h.api("POST", `/api/instances/${inst.id}/actions`, { token: h.adminToken, json: { action: "stop" } });
    await h.drain();
    const stopped = (await h.api("GET", `/api/instances/${inst.id}`, { token: h.adminToken })).body;
    expect(stopped.status).toBe("stopped");
    expect(stopped.runner.connected).toBe(false);
    await h.api("POST", `/api/instances/${inst.id}/actions`, { token: h.adminToken, json: { action: "start" } });
    await h.drain();
    await h.waitFor(
      async () => (await h.api("GET", `/api/instances/${inst.id}`, { token: h.adminToken })).body.runner.connected,
    );
  });

  it("a runner presenting a wrong secret is refused", async () => {
    const tpl = await template();
    const inst = await instance(tpl.id, "box-1");
    const pc = h.manager.computer(inst.id);
    pc.disconnect();
    (pc.spec.runner as any).token = "wdr_forged-token-value-1234567890";
    pc.connect(h.manager.hub!);
    await new Promise((r) => setTimeout(r, 200));
    expect((await h.api("GET", `/api/instances/${inst.id}`, { token: h.adminToken })).body.runner.connected).toBe(
      false,
    );
    const audit = (await h.api("GET", "/api/audit?action=runner.rejected", { token: h.adminToken })).body;
    expect(audit[0].instance_id).toBe(inst.id);
  });

  it("while a computer's runner answers, a second connection with its token is refused, not swapped in", async () => {
    const tpl = await template();
    const inst = await instance(tpl.id, "box-dup");
    const pc = h.manager.computer(inst.id);
    const hub = h.manager.hub!;
    hub.duplicateCheckMs = 300;
    const original = hub.connected(inst.id);
    // someone else holding the token
    const impostor = new FakeComputer(inst.id, pc.spec);
    impostor.connect(hub);
    await h.waitFor(async () => !impostor.connected);
    expect(hub.connected(inst.id)).toBe(original);
    expect(pc.connected).toBe(true);
    const refused = (await h.api("GET", "/api/audit?action=runner.duplicate", { token: h.adminToken })).body;
    expect(refused[0]).toMatchObject({ instance_id: inst.id, outcome: "denied" });

    // A runner that stopped answering (a connection left half-open) is replaced by its reconnect.
    pc.answersPings = false;
    const reconnect = new FakeComputer(inst.id, pc.spec);
    reconnect.connect(hub);
    await h.waitFor(async () => hub.connected(inst.id) !== original);
    expect(reconnect.connected).toBe(true);
    expect(pc.connected).toBe(false);
  });

  it("a stdio channel the Docker Manager opened is its own credential; elsewhere a runner needs the token", async () => {
    const tpl = await template();
    const inst = await instance(tpl.id, "box-stdio");
    const hello = (instanceId: string) =>
      JSON.stringify({
        type: "hello",
        protocol: RUNNER_PROTOCOL_VERSION,
        instanceId,
        token: "",
        runnerVersion: "test",
        info: {
          hostname: "box",
          user: "witden",
          uid: 1000,
          workdir: "/home/witden",
          desktop: null,
          browser: false,
          tools: [],
        },
      });
    // what the runner on the channel says it is
    let says = inst.id;
    const hub = new RunnerHub(async () => {
      const [hubSide, runnerSide] = memoryTransportPair();
      setTimeout(() => runnerSide.sendText(hello(says)), 20);
      return hubSide;
    });
    const conn = await hub.connection(inst.id, { containerId: "c-stdio", network: "none", waitMs: 2_000 });
    expect(conn).toMatchObject({ instanceId: inst.id, via: "stdio" });
    conn.shutdown("test");

    // the channel vouches only for the computer it was opened into
    const other = await instance(tpl.id, "box-other");
    says = other.id;
    await expect(hub.connection(inst.id, { containerId: "c-stdio", network: "none", waitMs: 500 })).rejects.toThrow();
    // and a runner dialling in still needs the token
    const [hubSide, runnerSide] = memoryTransportPair();
    let closed = "";
    runnerSide.onClose((reason) => {
      closed = reason;
    });
    hub.accept(hubSide, "websocket");
    setTimeout(() => runnerSide.sendText(hello(other.id)), 10);
    await h.waitFor(async () => closed !== "");
    expect(closed).toBe("authentication failed");
    await hub.close();
  });

  it("clones without credentials", async () => {
    const tpl = await template();
    const src = await instance(tpl.id, "src-box");
    const pc = h.manager.computer(src.id);
    pc.files.set("/home/witden/.ssh/id_ed25519", Buffer.from("PRIVATE"));
    pc.files.set("/home/witden/notes.txt", Buffer.from("hello"));
    const res = await h.api("POST", `/api/instances/${src.id}/clone`, {
      token: h.adminToken,
      json: { name: "copy-box" },
    });
    expect(res.status, res.raw).toBe(200);
    await h.drain();
    await h.waitFor(
      async () =>
        (await h.api("GET", `/api/instances/${res.body.id}`, { token: h.adminToken })).body.status === "running",
    );
    const files = h.manager.computer(res.body.id).files;
    expect(files.get("/home/witden/notes.txt")?.toString()).toBe("hello");
    expect(files.has("/home/witden/.ssh/id_ed25519")).toBe(false);
  });

  it("operator console and screenshot go through the runner, audited", async () => {
    const tpl = await template({ name: "desk", kind: "desktop" });
    const inst = await instance(tpl.id, "desk-1");
    const exec = (
      await h.api("POST", `/api/instances/${inst.id}/exec`, { token: h.adminToken, json: { command: "uname -a" } })
    ).body;
    expect(exec.output).toContain("ran: uname -a");
    const shot = await h.api("GET", `/api/instances/${inst.id}/screenshot`, { token: h.adminToken });
    expect(shot.status).toBe(200);
    expect((await h.api("GET", "/api/audit?action=instance.exec", { token: h.adminToken })).body.length).toBe(1);
  });
});

describe("execution gateway", () => {
  async function setup() {
    const tpl = await template({ name: "desk", kind: "desktop" });
    const a = await instance(tpl.id, "box-a");
    const b = await instance(tpl.id, "box-b");
    const mk = async (handle: string, inst: string) => {
      const [role] = await db()
        .insert(roles)
        .values({ id: newId("role"), name: handle, handle, instanceId: inst, allowedTools: ["shell", "desktop"] })
        .returning();
      return role;
    };
    const r1 = await mk("one", a.id);
    const r2 = await mk("two", a.id);
    const [topic] = await db()
      .insert(topics)
      .values({ id: newId("top"), title: "t" })
      .returning();
    const task = async (roleId: string) =>
      (
        await db()
          .insert(tasks)
          .values({
            id: newId("task"),
            topicId: topic.id,
            title: "t",
            ownerRoleId: roleId,
            instanceId: a.id,
            status: "running",
            envelope: { tools: ["shell", "desktop"] },
          })
          .returning()
      )[0];
    return { a, b, r1, r2, t1: await task(r1.id), t2: await task(r2.id) };
  }

  it("binds operations to the task's computer and never follows a moved role", async () => {
    const { a, b, r1, t1 } = await setup();
    const gw = new ExecutionGateway();
    await gw.execute({
      taskId: t1.id,
      toolCallId: "c1",
      op: "exec.run",
      params: { command: "echo hi" },
      timeoutMs: 5000,
    });
    expect(h.manager.computer(a.id).commands).toEqual(["echo hi"]);
    expect(h.manager.computer(b.id).commands).toEqual([]);
    const { eq } = await import("drizzle-orm");
    await db().update(roles).set({ instanceId: b.id }).where(eq(roles.id, r1.id));
    await expect(
      gw.execute({
        taskId: t1.id,
        toolCallId: "c2",
        op: "exec.run",
        params: { command: "echo again" },
        timeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(InstanceUnavailable);
    // operations outside the envelope are refused even if the worker asked
    await db().update(roles).set({ instanceId: a.id }).where(eq(roles.id, r1.id));
    await expect(
      gw.execute({ taskId: t1.id, toolCallId: "c3", op: "file.read", params: { path: "x" }, timeoutMs: 5000 }),
    ).rejects.toThrow("outside this task's permissions");
  });

  it("one task drives the desktop at a time; reading the screen needs no control", async () => {
    const { t1, t2 } = await setup();
    const gw = new ExecutionGateway();
    await gw.execute({
      taskId: t1.id,
      toolCallId: "m1",
      op: "input.mouse",
      params: { action: "click", x: 1, y: 2 },
      timeoutMs: 5000,
    });
    await gw.execute({ taskId: t2.id, toolCallId: "s1", op: "screen.capture", params: {}, timeoutMs: 5000 });
    await expect(
      gw.execute({ taskId: t2.id, toolCallId: "k1", op: "input.keyboard", params: { text: "hi" }, timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(InstanceBusy);
  });

  it("human takeover pauses AI on that computer", async () => {
    const { a, t1 } = await setup();
    await h.api("POST", `/api/instances/${a.id}/takeover`, { token: h.adminToken, json: { reason: "login" } });
    const { eq } = await import("drizzle-orm");
    const [paused] = await db().select().from(tasks).where(eq(tasks.id, t1.id));
    expect(paused.status).toBe("paused");
    // a worker that missed the pause is still refused at the gateway
    await expect(
      new ExecutionGateway().execute({
        taskId: t1.id,
        toolCallId: "x",
        op: "exec.run",
        params: { command: "ls" },
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("not running");
    expect(h.manager.computer(a.id).commands).toEqual([]);
  });

  it("a takeover the browser stops confirming lapses, and the paused work resumes", async () => {
    const { eq } = await import("drizzle-orm");
    const { expireTakeovers } = await import("../src/agent/control.js");
    const { a, t1 } = await setup();
    await h.api("POST", `/api/instances/${a.id}/takeover`, { token: h.adminToken, json: {} });
    const [lease] = await db().select().from(instanceLeases).where(eq(instanceLeases.instanceId, a.id));
    expect(lease.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(3 * 60_000 + 1000); // minutes, not a day
    // the console confirms while the person is there
    const kept = await h.api("POST", `/api/instances/${a.id}/takeover/keepalive`, { token: h.adminToken });
    expect(kept.status, kept.raw).toBe(200);
    expect(await expireTakeovers(db())).toBe(0);
    // ...and stops when the browser is gone
    await db()
      .update(instanceLeases)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(instanceLeases.id, lease.id));
    expect(await expireTakeovers(db())).toBe(1);
    const [inst] = await db().select().from(computerInstances).where(eq(computerInstances.id, a.id));
    expect(inst.pausedAi).toBe(false);
    const [resumed] = await db().select().from(tasks).where(eq(tasks.id, t1.id));
    expect(resumed.status).not.toBe("paused");
    expect((await h.api("POST", `/api/instances/${a.id}/takeover/keepalive`, { token: h.adminToken })).status).toBe(
      409,
    );
    const audit = (await h.api("GET", "/api/audit?action=instance.handback", { token: h.adminToken })).body;
    expect(audit[0].detail.automatic).toBeTruthy();
  });
});

describe("live view and permissions", () => {
  it("VNC: close codes reach the client; observers get the view-only tunnel", async () => {
    const tpl = await template({ name: "desk", kind: "desktop" });
    const inst = await instance(tpl.id, "desk-1");
    const app = h.witden.app!;
    const base = (await app.listen({ port: 0, host: "127.0.0.1" })).replace("http", "ws");
    const { default: WebSocket } = await import("ws");
    const open = (token: string) => {
      const ws = new WebSocket(`${base}/api/instances/${inst.id}/vnc?access_token=${token}`);
      const first = new Promise<{ code?: number; data?: string }>((resolve) => {
        ws.on("close", (code: number) => resolve({ code }));
        ws.on("message", (d: Buffer) => resolve({ data: d.toString() }));
      });
      return { ws, first };
    };
    expect((await open("bad").first).code).toBe(4401);
    const good = open(h.adminToken);
    expect((await good.first).data).toContain("RFB 003.");
    good.ws.terminate();
    const audit = (await h.api("GET", "/api/audit?action=instance.vnc", { token: h.adminToken })).body;
    expect(audit[0].detail.mode).toBe("view");
  });

  it("whoever may take over a computer may also watch it", async () => {
    const tpl = await template({ name: "desk", kind: "desktop" });
    const inst = await instance(tpl.id, "desk-1");
    await h.api("POST", "/api/users", {
      token: h.adminToken,
      json: { name: "ctl", email: "ctl@example.com", password: "ctl-pass-1234" },
    });
    const ctl = await h.login("ctl@example.com", "ctl-pass-1234");
    const me = (await h.api("GET", "/api/auth/me", { token: ctl })).body;
    await h.api("POST", "/api/grants", {
      token: h.adminToken,
      json: { permission: "instance.control", user_id: me.id, resource_id: inst.id },
    });
    expect((await h.api("POST", `/api/instances/${inst.id}/takeover`, { token: ctl, json: {} })).status).toBe(200);
    expect((await h.api("GET", `/api/instances/${inst.id}/screenshot`, { token: ctl })).status).toBe(200);
    const base = (await h.witden.app!.listen({ port: 0, host: "127.0.0.1" })).replace("http", "ws");
    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(`${base}/api/instances/${inst.id}/vnc?access_token=${ctl}&mode=control`);
    const first = await new Promise<{ code?: number; data?: string }>((resolve) => {
      ws.on("close", (code: number) => resolve({ code }));
      ws.on("message", (d: Buffer) => resolve({ data: d.toString() }));
    });
    ws.terminate();
    expect(first.data).toContain("RFB 003.");
    const audit = (await h.api("GET", "/api/audit?action=instance.vnc", { token: h.adminToken })).body;
    expect(audit[0].detail.mode).toBe("control");
  });

  it("/api/auth/me: every console account holds every permission", async () => {
    await h.api("POST", "/api/users", {
      token: h.adminToken,
      json: { name: "olga", email: "olga@example.com", password: "olga-pass-123" },
    });
    const olga = await h.login("olga@example.com", "olga-pass-123");
    const me = (await h.api("GET", "/api/auth/me", { token: olga })).body;
    expect(me.is_admin).toBe(true);
    expect(me.permissions).toEqual(expect.arrayContaining(["instance.observe", "secrets.manage", "user.manage"]));
  });
});

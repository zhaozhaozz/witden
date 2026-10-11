/**
 * Runs the real computer images with the runner inside, dialling a test hub on the host.
 * Opt-in: WITDEN_DOCKER_TESTS=1 (images must be built first, see images/).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import {
  decodeStreamFrame,
  type EventMessage,
  encodeStdioFrame,
  type HelloMessage,
  type ResponseMessage,
  type RunnerToHub,
  StdioFrameDecoder,
} from "@witden/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";

const enabled = process.env.WITDEN_DOCKER_TESTS === "1";
const SHELL_IMAGE = process.env.WITDEN_SHELL_IMAGE ?? "witden/computer-shell:latest";
const DESKTOP_IMAGE = process.env.WITDEN_DESKTOP_IMAGE ?? "witden/computer-desktop:latest";
const CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "NET_BIND_SERVICE"];

/** One runner connection as seen by the hub. */
class Connection {
  readonly messages: RunnerToHub[] = [];
  readonly binary: Uint8Array[] = [];
  private waiters: (() => void)[] = [];
  private nextId = 0;

  constructor(
    readonly ws: WebSocket,
    readonly hello: HelloMessage,
  ) {
    ws.on("message", (data, isBinary) => {
      const buf = Buffer.from(data as Buffer);
      if (isBinary) this.binary.push(new Uint8Array(buf));
      else this.messages.push(JSON.parse(buf.toString("utf8")));
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    });
  }

  async waitFor<T>(check: () => T | undefined, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = check();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error("timed out waiting for the runner");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 250);
      });
    }
  }

  async request(op: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<ResponseMessage> {
    const id = `e2e-${++this.nextId}-${randomBytes(3).toString("hex")}`;
    this.ws.send(JSON.stringify({ type: "request", id, op, params, timeoutMs }));
    return this.waitFor(
      () => this.messages.find((m): m is ResponseMessage => m.type === "response" && m.id === id),
      timeoutMs + 15_000,
    );
  }

  async ok(op: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, any>> {
    const res = await this.request(op, params, timeoutMs);
    if (!res.ok) throw new Error(`${op} failed: ${JSON.stringify(res.error)}`);
    return res.result as Record<string, any>;
  }
}

/** Minimal runner hub: accepts hellos and hands out connections per instance id. */
class TestHub {
  readonly wss = new WebSocketServer({ host: "0.0.0.0", port: 0, path: "/runner" });
  private readonly connections = new Map<string, Connection[]>();
  private waiters: (() => void)[] = [];

  constructor() {
    this.wss.on("connection", (ws) => {
      ws.once("message", (data) => {
        const hello = JSON.parse(data.toString()) as HelloMessage;
        if (hello.type !== "hello") {
          ws.close(4400, "expected hello");
          return;
        }
        ws.send(JSON.stringify({ type: "welcome", serverTime: new Date().toISOString() }));
        const list = this.connections.get(hello.instanceId) ?? [];
        list.push(new Connection(ws, hello));
        this.connections.set(hello.instanceId, list);
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters) w();
      });
    });
  }

  count(instanceId: string): number {
    return this.connections.get(instanceId)?.length ?? 0;
  }

  get port(): number {
    return (this.wss.address() as { port: number }).port;
  }

  /** Waits for connection number `index` (0-based) of an instance. */
  async connection(instanceId: string, index = 0, timeoutMs = 60_000): Promise<Connection> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const conn = this.connections.get(instanceId)?.[index];
      if (conn) return conn;
      if (Date.now() > deadline) throw new Error(`runner ${instanceId} did not connect`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 500);
      });
    }
  }

  close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

const containers: string[] = [];

function startComputer(image: string, hub: TestHub, instanceId: string, token: string): string {
  const name = `witden-e2e-${instanceId}`;
  execFileSync("docker", [
    "run",
    "-d",
    "--name",
    name,
    "--hostname",
    name,
    "--init",
    "--cap-drop",
    "ALL",
    ...CAPS.flatMap((cap) => ["--cap-add", cap]),
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "2g",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-e",
    `WITDEN_HUB_URL=ws://host.docker.internal:${hub.port}/runner`,
    "-e",
    `WITDEN_INSTANCE_ID=${instanceId}`,
    "-e",
    `WITDEN_RUNNER_TOKEN=${token}`,
    image,
  ]);
  containers.push(name);
  return name;
}

function imageExists(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const decode = (r: Record<string, any>) => Buffer.from(r.contentBase64, "base64").toString("utf8");

describe.skipIf(!enabled)("computer images (docker)", () => {
  let hub: TestHub;

  beforeAll(async () => {
    for (const image of [SHELL_IMAGE, DESKTOP_IMAGE]) {
      if (!imageExists(image)) throw new Error(`image ${image} is missing; build it first (see images/)`);
    }
    hub = new TestHub();
    await new Promise((resolve) => hub.wss.once("listening", resolve));
  });

  afterAll(async () => {
    for (const name of containers) {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
    await hub?.close();
  });

  describe("shell image", () => {
    const instanceId = `shell-${randomBytes(3).toString("hex")}`;
    const token = randomBytes(16).toString("hex");
    let name = "";
    let conn: Connection;

    beforeAll(async () => {
      name = startComputer(SHELL_IMAGE, hub, instanceId, token);
      conn = await hub.connection(instanceId);
    }, 90_000);

    it("authenticates with hello", () => {
      expect(conn.hello).toMatchObject({ type: "hello", protocol: 1, instanceId, token });
      expect(conn.hello.info).toMatchObject({ user: "witden", uid: 1000, hostname: name, desktop: null });
      expect(conn.hello.info.hostname).not.toBe(os.hostname());
      expect(conn.hello.info.tools).toContain("terminal");
    });

    it("runs commands as witden inside the container, without the runner token", async () => {
      const r = await conn.ok("exec.run", { command: 'id -un; id -u; hostname; echo "[$WITDEN_RUNNER_TOKEN]"' });
      expect(r.output.split("\n").slice(0, 4)).toEqual(["witden", "1000", name, "[]"]);
      const node = await conn.ok("exec.run", { command: "node --version && npm --version && python3 --version" });
      expect(node.output).toMatch(/^v22\./);
    });

    it("kills a timed-out command tree inside the container", async () => {
      const r = await conn.ok("exec.run", { command: "sleep 300 & (setsid sleep 301 &); sleep 302" }, 1500);
      expect(r).toMatchObject({ timedOut: true, killed: true });
      const ps = await conn.ok("process.list");
      expect(ps.processes.filter((p: any) => /^sleep 30[012]/.test(p.command))).toEqual([]);
    });

    it("keeps terminal sessions across inputs and hub reconnects", async () => {
      const { sessionId } = await conn.ok("terminal.create", {});
      await conn.ok("terminal.input", { sessionId, text: "cd /tmp && export X=42" });
      await conn.ok("terminal.input", { sessionId, text: 'echo "v=$X-$(pwd)"' });
      let output = "";
      for (let i = 0; i < 40 && !output.includes("v=42-/tmp"); i++) {
        output = (await conn.ok("terminal.read", { sessionId })).output;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(output).toContain("v=42-/tmp");

      // Drop the connection: the runner reconnects, the session is still there.
      conn.ws.terminate();
      const again = await hub.connection(instanceId, 1);
      const read = await again.ok("terminal.read", { sessionId });
      expect(read.output).toContain("v=42-/tmp");
      const list = await again.ok("terminal.list");
      expect(list.sessions.map((s: any) => s.sessionId)).toContain(sessionId);
      conn = again;
    }, 60_000);

    it("applies the computer's file permissions", async () => {
      const w = await conn.ok("file.write", { path: "notes/todo.txt", contentBase64: b64("buy milk") });
      expect(w.path).toBe("/home/witden/notes/todo.txt");
      expect(decode(await conn.ok("file.read", { path: "~/notes/todo.txt" }))).toBe("buy milk");
      expect((await conn.ok("file.stat", { path: "notes/todo.txt" })).uid).toBe(1000);
      const denied = await conn.request("file.write", { path: "/etc/passwd", contentBase64: b64("x") });
      expect(denied.ok).toBe(false);
      expect(denied.error?.code).toBe("failed");
      const shadow = await conn.request("file.read", { path: "/etc/shadow" });
      expect(shadow.ok).toBe(false);
      const passwd = decode(await conn.ok("file.read", { path: "/etc/passwd" }));
      expect(passwd.startsWith("root:x:0:0")).toBe(true);
    });

    it("keeps agents, terminals and the journal across a runner restart", async () => {
      const agent = await conn.ok("agent.start", { command: "sleep 3; echo agent-done; exit 5" });
      const { sessionId } = await conn.ok("terminal.create", { command: "export KEEP=yes" });
      const written = await conn.request("file.write", { path: "restart.txt", contentBase64: b64("1") });
      const index = hub.count(instanceId);
      execFileSync("docker", ["exec", name, "pkill", "-TERM", "-f", "witden-runner.mjs"]);
      const fresh = await hub.connection(instanceId, index);

      let read: Record<string, any> = {};
      for (let i = 0; i < 40; i++) {
        read = await fresh.ok("agent.read", { sessionId: agent.sessionId });
        if (!read.running) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(read).toMatchObject({ running: false, exitCode: 5 });
      expect(read.output).toContain("agent-done");

      await fresh.ok("terminal.input", { sessionId, text: 'echo "keep=$KEEP"' });
      let output = "";
      for (let i = 0; i < 40 && !output.includes("keep=yes"); i++) {
        output = (await fresh.ok("terminal.read", { sessionId })).output;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(output).toContain("keep=yes");

      expect(await fresh.ok("journal.get", { requestId: written.id })).toEqual({
        state: "completed",
        response: written,
      });
      conn = fresh;
    }, 60_000);

    it("serves the --stdio channel through docker exec", async () => {
      const child = spawn("docker", ["exec", "-i", name, "node", "/opt/witden/runner/witden-runner.mjs", "--stdio"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const frames = new StdioFrameDecoder();
      const messages: any[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        for (const f of frames.push(chunk))
          if (f.kind === "text") messages.push(JSON.parse(Buffer.from(f.payload).toString()));
      });
      const until = async <T>(fn: () => T | undefined) => {
        for (let i = 0; i < 100; i++) {
          const v = fn();
          if (v) return v;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("no answer on the stdio channel");
      };
      const hello = await until(() => messages.find((m) => m.type === "hello"));
      expect(hello).toMatchObject({ instanceId, token, info: { user: "witden", uid: 1000 } });
      const request = {
        type: "request",
        id: "stdio-1",
        op: "exec.run",
        params: { command: "id -un" },
        timeoutMs: 10_000,
      };
      child.stdin.write(encodeStdioFrame("text", Buffer.from(JSON.stringify(request))));
      const response = await until(() => messages.find((m) => m.type === "response" && m.id === "stdio-1"));
      expect(response.result.output).toBe("witden\n");
      child.stdin.end();
      const code = await new Promise((resolve) => child.on("exit", resolve));
      expect(code).toBe(0);
    }, 30_000);
  });

  describe("desktop image", () => {
    const instanceId = `desktop-${randomBytes(3).toString("hex")}`;
    const token = randomBytes(16).toString("hex");
    let name = "";
    let conn: Connection;

    beforeAll(async () => {
      name = startComputer(DESKTOP_IMAGE, hub, instanceId, token);
      conn = await hub.connection(instanceId);
      // The X server and the session start next to the runner: wait until the xterm has focus and its bash has
      // set the window title ("witden@host: ~").
      await conn.ok(
        "exec.run",
        {
          command:
            "for i in $(seq 120); do xdotool getwindowfocus getwindowname 2>/dev/null | grep -q @ && break; sleep 0.5; done",
        },
        70_000,
      );
    }, 120_000);

    it("describes its desktop in hello", () => {
      expect(conn.hello.info).toMatchObject({ user: "witden", uid: 1000, browser: true });
      expect(conn.hello.info.desktop).toEqual({
        display: ":1",
        width: 1280,
        height: 800,
        vncPort: 5900,
        vncViewPort: 5901,
      });
      expect(conn.hello.info.tools).toEqual(expect.arrayContaining(["screen", "input", "browser", "terminal"]));
    });

    it("captures the screen and drives mouse and keyboard", async () => {
      const shot = await conn.ok("screen.capture");
      expect(Buffer.from(shot.pngBase64, "base64").subarray(1, 4).toString()).toBe("PNG");
      expect([shot.width, shot.height]).toEqual([1280, 800]);
      expect(await conn.ok("screen.size")).toEqual({ width: 1280, height: 800 });

      // Click into the xterm the session starts and type a command.
      await conn.ok("input.mouse", { action: "click", x: 200, y: 200 });
      await conn.ok("input.keyboard", { text: "echo typed-by-runner > ~/typed.txt" });
      await conn.ok("input.keyboard", { keys: "Return" });
      let content = "";
      for (let i = 0; i < 40 && !content.includes("typed-by-runner"); i++) {
        const r = await conn.request("file.read", { path: "~/typed.txt" });
        if (r.ok) content = decode(r.result as Record<string, any>);
        else await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(content.trim()).toBe("typed-by-runner");
      const bad = await conn.request("input.keyboard", { keys: "ctrl+l; rm" });
      expect(bad.error?.code).toBe("invalid");
    }, 60_000);

    it("drives the desktop Chromium over CDP", async () => {
      const page =
        "data:text/html,<title>Witden test</title><h1>Hello Witden</h1>" +
        "<input id=q placeholder=Search><button onclick=\"document.querySelector('h1').textContent='clicked '+document.getElementById('q').value\">Press me</button>" +
        "<a download=report.txt href='data:text/plain,hello'>Get report</a>";
      const opened = await conn.ok("browser.open", { url: page, mode: "desktop" }, 90_000);
      expect(opened).toMatchObject({ mode: "desktop", title: "Witden test" });
      const snap = await conn.ok("browser.snapshot", { sessionId: opened.sessionId });
      expect(snap.text).toContain("Hello Witden");
      const button = snap.elements.find((e: any) => e.role === "button" && e.name === "Press me");
      const input = snap.elements.find((e: any) => e.role === "textbox" && e.name === "Search");
      expect(button && input).toBeTruthy();
      await conn.ok("browser.type", { sessionId: opened.sessionId, ref: input.ref, value: "abc" });
      await conn.ok("browser.click", { sessionId: opened.sessionId, ref: button.ref });
      const after = await conn.ok("browser.snapshot", { sessionId: opened.sessionId });
      expect(after.text).toContain("clicked abc");

      const download = await conn.ok("browser.download", { sessionId: opened.sessionId, text: "Get report" });
      expect(download).toEqual({ path: "/home/witden/Downloads/report.txt", size: 5, suggestedName: "report.txt" });
      const event = conn.messages.find(
        (m): m is EventMessage =>
          m.type === "event" && m.event === "browser.download" && m.sessionId === opened.sessionId,
      );
      expect(event?.data.path).toBe(download.path);

      // The tab is on the desktop people watch: a visible Chromium with remote debugging, run as witden.
      const ps = await conn.ok("process.list");
      expect(
        ps.processes.some(
          (p: any) => p.command.includes("--remote-debugging-port=9222") && !p.command.includes("--type="),
        ),
      ).toBe(true);
      const shot = await conn.ok("browser.screenshot", { sessionId: opened.sessionId });
      expect(shot.mode).toBe("desktop");
      expect((await conn.ok("browser.list")).sessions.map((s: any) => s.sessionId)).toContain(opened.sessionId);
    }, 120_000);

    it("runs background browser sessions separately", async () => {
      const opened = await conn.ok(
        "browser.open",
        { url: "data:text/html,<title>bg</title><p>background page</p>", mode: "background" },
        60_000,
      );
      expect(opened).toMatchObject({ mode: "background", title: "bg" });
      const snap = await conn.ok("browser.snapshot", { sessionId: opened.sessionId });
      expect(snap).toMatchObject({ mode: "background" });
      expect(snap.text).toContain("background page");
      await conn.ok("browser.close", { sessionId: opened.sessionId });
    }, 90_000);

    it("refuses to run the runner as root", () => {
      // The desktop container's default user is root (supervisord); the runner itself must not be.
      const asRoot = spawnSync("docker", ["exec", name, "node", "/opt/witden/runner/witden-runner.mjs", "--stdio"], {
        input: "",
      });
      expect(asRoot.status).toBe(78);
      const supervised = execFileSync("docker", ["exec", name, "ps", "-o", "user=", "-C", "node"]).toString().trim();
      expect(supervised.split(/\s+/)).toEqual(["witden"]);
    });

    it("tunnels the view-only VNC port", async () => {
      conn.ws.send(JSON.stringify({ type: "stream.open", streamId: 11, port: 5901 }));
      await conn.waitFor(() => conn.messages.find((m) => m.type === "stream.opened" && m.streamId === 11));
      const frame = await conn.waitFor(() => conn.binary.find((f) => decodeStreamFrame(f).streamId === 11));
      expect(Buffer.from(decodeStreamFrame(frame).payload).toString("latin1")).toMatch(/^RFB 003\./);
      conn.ws.send(JSON.stringify({ type: "stream.close", streamId: 11 }));

      conn.ws.send(JSON.stringify({ type: "stream.open", streamId: 12, port: 22 }));
      const refused = await conn.waitFor(() =>
        conn.messages.find((m) => m.type === "stream.close" && m.streamId === 12),
      );
      expect(refused).toMatchObject({ reason: expect.stringContaining("not allowed") });
    });
  });
});

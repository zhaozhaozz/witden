import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setPinnedFetch, setProbeFetch, setTunnelMetricsFetch } from "../src/services/public-url.js";
import { type Harness, startHarness } from "./support/harness.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A proxy in front of this deployment, forwarding the public address to one of its servers. */
const forwardTo =
  (server: Harness["api"]): typeof fetch =>
  async (input) => {
    const u = new URL(String(input));
    const res = await server("GET", u.pathname + u.search);
    return new Response(res.raw, { status: res.status, headers: { "content-type": "application/json" } });
  };

const failing =
  (code: string, message: string): typeof fetch =>
  async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code, message } });
  };

let h: Harness;
afterEach(async () => {
  setProbeFetch((...args) => fetch(...args));
  setPinnedFetch((url, address) => Promise.reject(new Error(`no network in tests (${url} at ${address})`)));
  setTunnelMetricsFetch((...args) => fetch(...args));
  await h.close();
});

describe("public address", () => {
  it("is saved only once it leads back to this deployment", async () => {
    h = await startHarness();
    const put = (url: string | null, extra: Record<string, unknown> = {}) =>
      h.api("PUT", "/api/settings/public-url", { token: h.adminToken, json: { url, ...extra } });

    // https on a public host, without a path
    expect((await put("http://witden.example.com")).body).toMatchObject({ saved: false, check: { problem: "https" } });
    expect((await put("https://192.168.1.5")).body.check.problem).toBe("private");
    expect((await put("https://witden.example.com/witden")).body.check.problem).toBe("format");
    // something else answers there
    setProbeFetch(async () => new Response("<html>nginx</html>", { status: 200 }));
    expect((await put("https://witden.example.com")).body.check.problem).toBe("not_witden");
    setProbeFetch(async () => json({ witden: true, proof: "0".repeat(64) }));
    expect((await put("https://witden.example.com")).body.check.problem).toBe("other_instance");
    setProbeFetch(
      async () => new Response(null, { status: 301, headers: { location: "https://elsewhere.example.com/" } }),
    );
    expect((await put("https://witden.example.com")).body.check.problem).toBe("redirect");
    // a certificate Slack would refuse cannot be overridden
    setProbeFetch(failing("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"));
    expect((await put("https://witden.example.com", { force: true })).body).toMatchObject({
      saved: false,
      check: { problem: "tls" },
    });
    // unreachable from this server (e.g. no hairpin NAT): saved only when asked to
    setProbeFetch(failing("ECONNREFUSED", "connect ECONNREFUSED"));
    expect((await put("https://witden.example.com")).body).toMatchObject({
      saved: false,
      check: { problem: "unreachable", overridable: true },
    });
    expect((await put("https://unchecked.example.com", { force: true })).body).toMatchObject({ saved: true });

    // through a proxy to this deployment's webhook listener (the probe needs no login)
    setProbeFetch(forwardTo(h.webhooks));
    expect((await put("https://witden.example.com/")).body).toMatchObject({
      saved: true,
      url: "https://witden.example.com",
      check: { ok: true },
    });
    // event addresses use it at once
    const conn = await h.api("POST", "/api/connections", {
      token: h.adminToken,
      json: { platform: "slack", name: "acme", credentials: { bot_token: "xoxb-1", signing_secret: "s" } },
    });
    expect(conn.body.events_url).toBe(`https://witden.example.com/api/integrations/slack/${conn.body.id}/events`);
    expect((await h.api("GET", "/api/settings/public-url", { token: h.adminToken })).body).toMatchObject({
      url: "https://witden.example.com",
      saved: "https://witden.example.com",
    });
    // clearing it falls back to WITDEN_PUBLIC_URL
    await put(null);
    expect((await h.api("GET", "/api/settings/public-url", { token: h.adminToken })).body.url).toBe(
      h.settings.publicUrl,
    );
  });
});

describe("public address when this server's DNS cannot resolve it", () => {
  it("is checked at the address public DNS gives, which is what the platforms use", async () => {
    h = await startHarness();
    let answer: { type: number; data: string }[] = [{ type: 1, data: "203.0.113.7" }];
    // This server's resolver knows nothing of the name; Cloudflare's DNS over HTTPS does.
    setProbeFetch(async (input) => {
      const u = new URL(String(input));
      if (u.hostname === "1.1.1.1" && u.searchParams.get("name") === "hooks.example.com")
        return json({ Status: 0, Answer: answer });
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND" },
      });
    });
    const connected: string[] = [];
    setPinnedFetch(async (url, address) => {
      connected.push(address);
      return forwardTo(h.webhooks)(url);
    });
    const check = async () =>
      (
        await h.api("POST", "/api/settings/public-url/check", {
          token: h.adminToken,
          json: { url: "https://hooks.example.com" },
        })
      ).body;
    expect(await check()).toMatchObject({ ok: true, url: "https://hooks.example.com", publicDns: "203.0.113.7" });
    // both the probe and the console check went to that address
    expect(connected).toEqual(["203.0.113.7", "203.0.113.7"]);
    // the console reached that way is refused just the same
    setPinnedFetch(async (url) => forwardTo(h.api)(url));
    expect(await check()).toMatchObject({ ok: false, problem: "console_exposed", publicDns: "203.0.113.7" });
    // not in public DNS either
    answer = [];
    expect(await check()).toMatchObject({ ok: false, problem: "dns", overridable: true });
  });
});

describe("webhook listener", () => {
  it("is the only server a public address may reach, and serves nothing but events", async () => {
    h = await startHarness();
    const put = (url: string) =>
      h.api("PUT", "/api/settings/public-url", { token: h.adminToken, json: { url, force: true } });
    // forwarded to the console's port: the whole console would be public, even when asked to save anyway
    setProbeFetch(forwardTo(h.api));
    expect((await put("https://witden.example.com")).body).toMatchObject({
      saved: false,
      check: { problem: "console_exposed" },
    });
    // events to the webhook listener, but other paths still to the console
    setProbeFetch(async (input, init) =>
      forwardTo(new URL(String(input)).pathname.startsWith("/api/integrations/") ? h.webhooks : h.api)(input, init),
    );
    expect((await put("https://witden.example.com")).body.check).toMatchObject({
      problem: "console_exposed",
      detail: "/api/health",
    });

    // the probe proves itself only on the webhook listener
    expect((await h.webhooks("GET", "/api/integrations/probe?nonce=abc")).body).toMatchObject({
      witden: true,
      listener: "webhooks",
      proof: expect.any(String),
    });
    expect((await h.api("GET", "/api/integrations/probe?nonce=abc")).body).toEqual({
      witden: true,
      listener: "console",
    });
    // nothing of the console there
    for (const [method, url] of [
      ["GET", "/"],
      ["GET", "/api/health"],
      ["POST", "/api/auth/login"],
      ["GET", "/api/connections"],
      ["GET", "/api/topics"],
      ["GET", "/api/settings/public-url"],
      ["POST", "/internal/gateway/exec"],
    ]) {
      expect((await h.webhooks(method, url, { token: h.adminToken })).status, `${method} ${url}`).toBe(404);
    }
    // a Slack event reaches its connection there
    const conn = await h.api("POST", "/api/connections", {
      token: h.adminToken,
      json: { platform: "slack", name: "acme", credentials: { bot_token: "xoxb-1", signing_secret: "s3cret" } },
    });
    const raw = JSON.stringify({ type: "url_verification", challenge: "c-123" });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", "s3cret").update(`v0:${ts}:${raw}`).digest("hex")}`;
    const verified = await h.webhooks("POST", `/api/integrations/slack/${conn.body.id}/events`, {
      payload: raw,
      headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    });
    expect(verified.body).toEqual({ challenge: "c-123" });
    const forged = await h.webhooks("POST", `/api/integrations/slack/${conn.body.id}/events`, {
      payload: raw,
      headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": "v0=00" },
    });
    expect(forged.status).toBe(401);
  });
});

describe("cloudflare tunnel", () => {
  const token = Buffer.from(JSON.stringify({ a: "acc123", t: "tun-456", s: "c2VjcmV0c2VjcmV0" })).toString("base64");

  it("takes the token in the console and reports the tunnel's state and routes", async () => {
    const dir = path.resolve(`.tmp/test-data/tunnel-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "token");
    h = await startHarness({
      tunnelTokenFile: file,
      tunnelMetricsUrl: "http://tunnel:2000",
      tunnelOrigin: "http://api:8320",
    });
    let metrics: "down" | "connecting" | "up" = "down";
    setTunnelMetricsFetch(async (input) => {
      if (metrics === "down") throw new TypeError("fetch failed");
      if (new URL(String(input)).pathname === "/ready")
        return json({ readyConnections: metrics === "up" ? 4 : 0 }, metrics === "up" ? 200 : 503);
      return json({
        version: 2,
        config: {
          ingress: [{ hostname: "witden.example.com", service: "http://api:8320" }, { service: "http_status:404" }],
        },
      });
    });
    const status = async () => (await h.api("GET", "/api/settings/tunnel", { token: h.adminToken })).body;
    expect(await status()).toMatchObject({
      available: true,
      token: null,
      state: "not_running",
      origin: "http://api:8320",
    });

    const put = (pasted: string) =>
      h.api("PUT", "/api/settings/tunnel", { token: h.adminToken, json: { token: pasted } });
    expect((await put("not a token")).status).toBe(400);
    // the dashboard's whole install command works too
    const saved = await put(`docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${token}`);
    expect(saved.status, saved.raw).toBe(200);
    expect(saved.body.token).toEqual({ account: "acc123", tunnel: "tun-456" });
    expect(saved.raw).not.toContain(token);
    expect(fs.readFileSync(file, "utf8")).toBe(token);
    // cloudflared runs as its own user and reads it from a shared volume
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);

    metrics = "connecting";
    expect((await status()).state).toBe("connecting");
    metrics = "up";
    expect(await status()).toMatchObject({
      state: "connected",
      routes: [{ hostname: "witden.example.com", service: "http://api:8320" }],
    });
    await h.api("DELETE", "/api/settings/tunnel", { token: h.adminToken });
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is unavailable without the tunnel service", async () => {
    h = await startHarness();
    expect((await h.api("GET", "/api/settings/tunnel", { token: h.adminToken })).body).toMatchObject({
      available: false,
      state: "not_running",
    });
    const res = await h.api("PUT", "/api/settings/tunnel", { token: h.adminToken, json: { token } });
    expect(res.status).toBe(400);
  });
});

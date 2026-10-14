import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setProbeFetch, setTunnelMetricsFetch } from "../src/services/public-url.js";
import { type Harness, startHarness } from "./support/harness.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A proxy in front of this deployment: requests to the public address are answered by the harness. */
const throughProxy =
  (h: Harness): typeof fetch =>
  async (input) => {
    const u = new URL(String(input));
    const res = await h.api("GET", u.pathname + u.search);
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

    // through a proxy to this deployment (the probe needs no login)
    setProbeFetch(throughProxy(h));
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

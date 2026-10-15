/** Badge colours for roles and computers, and role avatars. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { solidPng } from "../src/agent/llm.js";
import { absoluteAvatarUrl } from "../src/services/appearance.js";
import { reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

const admin = (method: string, url: string, json?: unknown) => w.api(method, url, { token: w.adminToken, json });

function multipart(name: string, content: Buffer, type: string) {
  const boundary = "----witdentest";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("appearance", () => {
  it("roles take a colour; avatars only as uploaded images; bad values are refused", async () => {
    const ok = await admin("PATCH", `/api/roles/${w.ids.dev}`, { color: "#FF8800" });
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.body.color).toBe("#ff8800");
    // an image address elsewhere is refused: avatars are uploaded
    const url = await admin("PATCH", `/api/roles/${w.ids.dev}`, { avatar_url: "https://img.example/a.png" });
    expect(url.status).toBe(400);
    expect(url.raw).toContain("upload the image");
    expect((await admin("PATCH", `/api/roles/${w.ids.dev}`, { color: "red" })).status).toBe(400);
    expect((await admin("PATCH", `/api/roles/${w.ids.dev}`, { avatar_url: "javascript:alert(1)" })).status).toBe(400);
    expect((await admin("PATCH", `/api/roles/${w.ids.dev}`, { color: null })).body.color).toBeNull();
  });

  it("uploaded avatars are stored by content and served without login", async () => {
    const png = solidPng(30, 120, 200);
    const up = await w.api("POST", `/api/roles/${w.ids.dev}/avatar`, {
      token: w.adminToken,
      ...multipart("me.png", png, "image/png"),
    });
    expect(up.status, up.raw).toBe(200);
    expect(up.body.avatar_url).toMatch(/^\/api\/avatars\/[a-f0-9]{64}\.png$/);
    const served = await w.witden.app!.inject({ method: "GET", url: up.body.avatar_url });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.rawPayload.equals(png)).toBe(true);
    expect((await w.witden.app!.inject({ method: "GET", url: "/api/avatars/..%2F..%2Fetc%2Fpasswd" })).statusCode).toBe(
      404,
    );

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const refused = await w.api("POST", `/api/roles/${w.ids.dev}/avatar`, {
      token: w.adminToken,
      ...multipart("x.svg", svg, "image/svg+xml"),
    });
    expect(refused.status).toBe(400);
    const big = Buffer.concat([png, Buffer.alloc(1024 * 1024)]);
    expect(
      (
        await w.api("POST", `/api/roles/${w.ids.dev}/avatar`, {
          token: w.adminToken,
          ...multipart("b.png", big, "image/png"),
        })
      ).status,
    ).toBe(413);
    expect((await admin("DELETE", `/api/roles/${w.ids.dev}/avatar`)).body.avatar_url).toBeNull();
    // editors upload first and save the URL with the rest of the form
    const stored = await w.api("POST", "/api/avatars", {
      token: w.adminToken,
      ...multipart("me.png", png, "image/png"),
    });
    expect(stored.body.avatar_url).toBe(up.body.avatar_url);
    expect(
      (await admin("PATCH", `/api/roles/${w.ids.dev}`, { avatar_url: stored.body.avatar_url })).body.avatar_url,
    ).toBe(up.body.avatar_url);
    // Slack fetches icons itself: uploaded avatars go out with the platform's address
    const base = "https://witden.example.com";
    expect(absoluteAvatarUrl(up.body.avatar_url, base)).toBe(`${base}${up.body.avatar_url}`);
    expect(absoluteAvatarUrl("https://img.example/a.png", base)).toBe("https://img.example/a.png");
  });

  it("computers take a colour; it shows wherever the computer is referenced", async () => {
    const patched = await admin("PATCH", `/api/instances/${w.ids.instance}`, { color: "#2E7D32" });
    expect(patched.status, patched.raw).toBe(200);
    expect(patched.body.color).toBe("#2e7d32");
    expect((await admin("PATCH", `/api/instances/${w.ids.instance}`, { color: "green" })).status).toBe(400);
    await admin("PATCH", `/api/roles/${w.ids.dev}`, { color: "#aa3366" });

    const role = (await admin("GET", `/api/roles/${w.ids.dev}`)).body;
    expect(role.instance).toMatchObject({ id: w.ids.instance, color: "#2e7d32" });
    const topic = (await w.api("GET", `/api/topics/${w.ids.topic}`, { token: w.alice })).body;
    const dev = topic.participants.find((p: any) => p.id === w.ids.dev);
    expect(dev).toMatchObject({ color: "#aa3366", instance: { id: w.ids.instance, color: "#2e7d32" } });

    w.scripts.dev = () => reply("done");
    const posted = await w.post(w.alice, w.ids.topic, "@dev hello");
    await w.drain();
    const task = await w.task(posted.tasks[0].id);
    expect(task.owner).toMatchObject({ handle: "dev", color: "#aa3366" });
    expect(task.instance).toMatchObject({ id: w.ids.instance, color: "#2e7d32" });

    const tpl = (await admin("GET", "/api/templates")).body[0];
    const created = await admin("POST", "/api/instances", { template_id: tpl.id, name: "blue-box", color: "#1565C0" });
    expect(created.body.color).toBe("#1565c0");
  });
});

/**
 * A DM is one person and one role, always open: no invites, no removal, no archive, no topic settings.
 * There is no visibility setting: the console (all administrators) sees every topic and DM.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

describe("DMs", () => {
  it("keep their person and role, cannot be archived or reconfigured, and reopen as the same conversation", async () => {
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    expect(dm).toMatchObject({ kind: "dm", title: expect.stringMatching(/ · /), dm_role_id: w.ids.dev });
    expect(dm.title.startsWith("DM ")).toBe(false);

    const refused = async (method: string, url: string, json?: unknown) => {
      const res = await w.api(method, url, { token: w.alice, json });
      expect([res.status, res.raw.includes("DM")]).toEqual([400, true]);
    };
    await refused("POST", `/api/topics/${dm.id}/participants`, { type: "role", id: w.ids.test });
    await refused("POST", `/api/topics/${dm.id}/participants`, { type: "user", id: w.ids.bob });
    await refused("DELETE", `/api/topics/${dm.id}/participants/role/${w.ids.dev}`);
    await refused("DELETE", `/api/topics/${dm.id}/participants/user/${w.ids.alice}`);
    for (const json of [{ status: "archived" }, { title: "x" }, { goal: "x" }, { max_auto_rounds: 2 }]) {
      await refused("PATCH", `/api/topics/${dm.id}`, json);
    }

    // opening it again is the same conversation
    const again = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    expect(again.id).toBe(dm.id);
    // clearing its history is still possible
    const cleared = await w.api("POST", `/api/topics/${dm.id}/cleanup`, {
      token: w.alice,
      json: { messages: true, memories: true, files: true, confirm: true },
    });
    expect(cleared.status).toBe(200);
  });

  it("with a disabled role become read-only, and open again when the role is enabled", async () => {
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    const say = () => w.api("POST", `/api/topics/${dm.id}/messages`, { token: w.alice, json: { content: "hi" } });
    await w.api("POST", `/api/roles/${w.ids.dev}/disable`, { token: w.adminToken, json: { on_tasks: "cancel" } });
    expect((await w.api("GET", `/api/topics/${dm.id}`, { token: w.alice })).body.can_post).toBe(false);
    expect((await say()).status).toBe(403);
    // the history stays readable
    expect((await w.api("GET", `/api/topics/${dm.id}/messages`, { token: w.alice })).status).toBe(200);

    await w.api("POST", `/api/roles/${w.ids.dev}/enable`, { token: w.adminToken });
    expect((await w.api("GET", `/api/topics/${dm.id}`, { token: w.alice })).body.can_post).toBe(true);
    expect((await say()).status).toBe(200);
  });

  it("console accounts see every topic and DM; there is no visibility setting", async () => {
    const t = (await w.api("POST", "/api/topics", { token: w.alice, json: { title: "plans", visibility: "internal" } }))
      .body;
    expect(t.visibility).toBeUndefined();
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    expect((await w.api("GET", `/api/topics/${t.id}`, { token: w.bob })).status).toBe(200);
    const listed = (await w.api("GET", "/api/topics", { token: w.bob })).body as any[];
    expect(listed.map((x) => x.id)).toEqual(expect.arrayContaining([t.id, dm.id]));
    // ...but only its own person writes in a DM
    expect((await w.api("GET", `/api/topics/${dm.id}`, { token: w.bob })).body.can_post).toBe(false);
  });
});

/** A DM is one person and one role, always open: no invites, no removal, no archive, no topic settings. */
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
});

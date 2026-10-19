/** System software: the platform installs packages for roles (no root in the computer); the software list. */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolSchema } from "../src/agent/llm.js";
import { db } from "../src/db/client.js";
import { auditLogs, computerInstances } from "../src/db/schema.js";
import { call, lastToolResult, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

const computer = async () =>
  (await db().select().from(computerInstances).where(eq(computerInstances.id, w.ids.instance)))[0];

describe("system software for roles", () => {
  it("installs and removes packages through the platform; the role decides what goes on the software list", async () => {
    await w.api("PATCH", `/api/roles/${w.ids.dev}`, {
      token: w.adminToken,
      json: { allowed_tools: ["shell", "system_software", "software_list"] },
    });
    const steps = [
      call("install_packages", { packages: ["ffmpeg"] }),
      call("edit_software_list", { add: ["ffmpeg", "jq"] }),
      call("install_packages", { packages: "ffmpeg jq" }),
      call("uninstall_packages", { packages: ["bash", "jq"] }),
      call("software_list"),
    ];
    const results: string[] = [];
    let system = "";
    w.scripts.dev = (m, turn) => {
      system = String(m[0].content);
      if (turn > 0) results.push(lastToolResult(m));
      return turn < steps.length ? reply("", [steps[turn]]) : reply("done");
    };
    await w.post(w.alice, w.ids.topic, "@dev set up ffmpeg");
    await w.drain();

    expect(system).toContain("install_packages");
    expect(system).toContain("edit_software_list");
    // Installed by the platform; not on the list yet, so the role is told it would not survive a reset.
    expect(results[0]).toContain("ffmpeg: installed");
    expect(results[0]).toMatch(/Not in this computer's software list: ffmpeg.*gone once the computer is reset/s);
    expect(results[1]).toContain("Software list of team-box: ffmpeg, jq");
    expect(results[1]).toMatch(/Nothing was installed or removed now/);
    expect(results[2]).not.toContain("Not in this computer's software list");
    // What came with the image stays; a listed package comes back at the next start.
    expect(results[3]).toContain("bash: not removed (part of the computer's image)");
    expect(results[3]).toMatch(/Still in this computer's software list: jq/);
    expect(results[4]).toContain("Software list of team-box (installed, when missing, whenever it starts): ffmpeg, jq");

    expect(w.manager.packageCalls.map((c) => c.request)).toEqual([
      { action: "install", packages: ["ffmpeg"] },
      { action: "install", packages: ["ffmpeg", "jq"] },
      { action: "remove", packages: ["bash", "jq"] },
    ]);
    expect((await computer()).software).toEqual(["ffmpeg", "jq"]);
    const audit = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "instance.software_list"), eq(auditLogs.instanceId, w.ids.instance)));
    expect(audit[0]).toMatchObject({ actorType: "role", actorId: w.ids.dev });

    // A restart keeps the container; the list is checked again and jq, removed meanwhile, comes back.
    await w.api("POST", `/api/instances/${w.ids.instance}/actions`, {
      token: w.adminToken,
      json: { action: "restart" },
    });
    await w.drain();
    await w.waitFor(async () => (await computer()).softwareStatus?.state === "ok");
    expect([...w.manager.computer(w.ids.instance).packages].sort()).toEqual(["ffmpeg", "jq"]);
  });

  it("offers the tools only with their permissions, and refuses names that are not package names", async () => {
    let tools: ToolSchema[] = [];
    const results: string[] = [];
    w.scripts.test = (m, turn, offered) => {
      tools = offered ?? [];
      if (turn > 0) results.push(lastToolResult(m));
      return turn === 0 ? reply("", [call("install_packages", { packages: ["ffmpeg"] })]) : reply("done");
    };
    await w.post(w.alice, w.ids.topic, "@test install ffmpeg");
    await w.drain();
    expect(tools.map((t) => t.name)).not.toContain("install_packages");
    expect(tools.map((t) => t.name)).not.toContain("edit_software_list");
    expect(w.manager.packageCalls).toEqual([]);

    await w.api("PATCH", `/api/roles/${w.ids.dev}`, {
      token: w.adminToken,
      json: { allowed_tools: ["shell", "software_list"] },
    });
    w.scripts.dev = (m, turn) => {
      if (turn > 0) results.push(lastToolResult(m));
      return turn === 0 ? reply("", [call("edit_software_list", { add: ["-o", "evil"] })]) : reply("done");
    };
    await w.post(w.alice, w.ids.topic, "@dev add packages");
    await w.drain();
    expect(results.at(-1)).toMatch(/not Debian package names: -o/);
    expect((await computer()).software).toEqual([]);
  });
});

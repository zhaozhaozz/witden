/** A role may rewrite its own description (职责说明) and nothing else: asking first, and only in the console. */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolsFor } from "../src/agent/tools.js";
import { db } from "../src/db/client.js";
import { tasks } from "../src/db/schema.js";
import { call, lastToolResult, reply } from "./support/harness.js";
import { linkChannel } from "./support/outside.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
let answers: string[];

beforeEach(async () => {
  w = await buildWorld();
  answers = [];
  w.scripts.dev = (m, turn) => {
    if (turn === 0) return reply("", [call("update_my_description", { description: "负责前端：页面、样式和交互" })]);
    answers.push(lastToolResult(m));
    return reply("ok");
  };
});
afterEach(async () => {
  await w.close();
});

const devRole = async () => (await w.api("GET", `/api/roles/${w.ids.dev}`, { token: w.adminToken })).body;
const setTools = (approval: string[]) =>
  w.api("PATCH", `/api/roles/${w.ids.dev}`, {
    token: w.adminToken,
    json: { allowed_tools: ["shell", "collaborate", "profile"], approval_required: approval },
  });

describe("update_my_description", () => {
  it("asks a person first by default, then changes only the role's own description", async () => {
    await setTools(["profile"]);
    const before = await devRole();
    const posted = await w.post(w.alice, w.ids.topic, "@dev 以后你负责前端，更新一下你的职责说明");
    await w.drain();
    const id = posted.tasks[0].id;
    expect((await w.task(id)).status).toBe("waiting_approval");
    expect((await devRole()).description).toBe(before.description);

    const approval = (await w.api("GET", "/api/approvals", { token: w.bob })).body.find((a: any) => a.task_id === id);
    await w.api("POST", `/api/approvals/${approval.id}/decide`, { token: w.bob, json: { approve: true } });
    await w.drain();
    expect((await w.task(id)).status).toBe("completed");
    expect(answers[0]).toContain("负责前端");
    const after = await devRole();
    expect(after.description).toBe("负责前端：页面、样式和交互");
    // nothing else moved: same prompt, same configuration version
    expect([after.system_prompt, after.config_version]).toEqual([before.system_prompt, before.config_version]);
    const [entry] = (await w.api("GET", "/api/audit?action=role.update", { token: w.adminToken })).body;
    expect(entry).toMatchObject({ actor_type: "role", actor_id: w.ids.dev, detail: { fields: ["description"] } });
  });

  it("is not offered in a conversation linked to Slack, Feishu or GitHub", async () => {
    await setTools([]);
    await linkChannel(w, w.ids.topic, ["UCAROL"]);
    const posted = await w.post(w.alice, w.ids.topic, "@dev 更新一下你的职责说明");
    await w.drain();
    const [task] = await db().select().from(tasks).where(eq(tasks.id, posted.tasks[0].id));
    expect(task.envelope.outside).toBe(true);
    expect(toolsFor(task.envelope).map((t) => t.name)).not.toContain("update_my_description");
    // calling it anyway is refused like any tool the role does not have
    expect(answers[0]).toContain("not available to you");
    expect((await devRole()).description).toBe("dev role");

    // the same role in a console DM may (asking is switched off here)
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    await w.post(w.alice, dm.id, "更新一下你的职责说明");
    await w.drain();
    expect((await devRole()).description).toBe("负责前端：页面、样式和交互");
  });
});

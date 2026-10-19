/** Inline approval cards use the same gated material and decisions as the approvals page. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtime } from "../src/runtime.js";
import type { BusEvent } from "../src/services/events.js";
import { call, reply } from "./support/harness.js";
import { linkChannel, restrictedNote } from "./support/outside.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
let events: BusEvent[];
let stop: () => void;
beforeEach(async () => {
  w = await buildWorld();
  events = [];
  stop = runtime().bus.subscribe((event) => events.push(event));
});
afterEach(async () => {
  stop();
  await w.close();
});

describe("conversation approvals", () => {
  it("links each request to its own card and retains approved and rejected decisions", async () => {
    const command = "printf '" + "long-line\n".repeat(100) + "'";
    await w.api("PATCH", `/api/roles/${w.ids.dev}`, {
      token: w.alice,
      json: { approval_required: ["shell"] },
    });
    w.scripts.dev = (_m, turn) =>
      turn < 2 ? reply("", [call("run_command", { command: turn === 0 ? command : "second-command" })]) : reply("done");
    const taskId = (await w.post(w.alice, w.ids.topic, "@dev run both")).tasks[0].id;
    await w.drain();
    const list = async () =>
      (await w.api("GET", `/api/approvals?topic_id=${w.ids.topic}&status=all`, { token: w.alice })).body;
    const [first] = await list();
    expect(first).toMatchObject({ task_id: taskId, status: "pending", can_decide: true, can_approve: true });
    expect(first.detail.tool_call.arguments.command).toBe(command);
    const notice = (await w.messages(w.ids.topic)).find((m) => m.approval_id === first.id);
    expect(notice).toMatchObject({ author_type: "system", task_id: taskId });
    expect(notice.content).not.toContain("long-line");
    expect(notice.content).toContain("控制台");
    await w.waitFor(() => events.find((e) => e.type === "approval.changed" && e.data.id === first.id));
    const created = events.find((e) => e.type === "message.created" && e.data.id === notice.id);
    expect(created?.data.approval_id).toBe(first.id);

    expect(
      (await w.api("POST", `/api/approvals/${first.id}/decide`, { token: w.bob, json: { approve: true } })).status,
    ).toBe(200);
    // A second console must not turn an already-approved request into a rejection or execute it twice.
    expect(
      (await w.api("POST", `/api/approvals/${first.id}/decide`, { token: w.alice, json: { approve: false } })).status,
    ).toBe(409);
    await w.drain();
    const rows = await list();
    const second = rows.find((a: any) => a.status === "pending");
    expect(rows.find((a: any) => a.id === first.id)).toMatchObject({ status: "approved", can_decide: false });
    expect(second.id).not.toBe(first.id);
    expect((await w.messages(w.ids.topic)).filter((m) => m.approval_id).map((m) => m.approval_id)).toEqual([
      first.id,
      second.id,
    ]);
    await w.api("POST", `/api/approvals/${second.id}/decide`, { token: w.alice, json: { approve: false } });
    await w.drain();
    expect(w.manager.computer(w.ids.instance).commands).toEqual([command]);
    expect((await list()).find((a: any) => a.id === second.id).status).toBe("rejected");
    await w.waitFor(() =>
      events.find((e) => e.type === "approval.changed" && e.data.id === second.id && e.data.status === "rejected"),
    );
    const changes = events.filter((e) => e.type === "approval.changed");
    expect(changes.map((e) => e.data.status)).toEqual(["pending", "approved", "pending", "rejected"]);
    expect(changes.every((e) => e.channels.includes(`topic:${w.ids.topic}`) && e.channels.includes("admin"))).toBe(
      true,
    );
    expect(JSON.stringify(changes)).not.toContain("long-line");
    expect((await w.api("GET", "/api/approvals?topic_id=missing&status=all", { token: w.alice })).body).toEqual([]);
    expect((await w.api("GET", "/api/approvals?status=all", { token: w.alice })).status).toBe(400);
  });

  it("links disclosure cards without putting held text in topic messages or events", async () => {
    const secret = "internal-salary-12345";
    await linkChannel(w, w.ids.topic, ["UCAROL"]);
    await restrictedNote(w, secret);
    w.scripts.dev = (_m, turn) => (turn === 0 ? reply("", [call("recall", { query: "salary" })]) : reply(secret));
    await w.post(w.alice, w.ids.topic, "@dev summarise salary");
    await w.drain();
    const [approval] = (await w.api("GET", `/api/approvals?topic_id=${w.ids.topic}&status=all`, { token: w.alice }))
      .body;
    expect(approval).toMatchObject({ action: "disclose", detail: { content: secret }, can_approve: true });
    const messages = await w.messages(w.ids.topic);
    expect(messages.find((m) => m.approval_id === approval.id)).toBeTruthy();
    expect(JSON.stringify(messages)).not.toContain(secret);
    await w.waitFor(() => events.find((e) => e.type === "approval.changed" && e.data.id === approval.id));
    expect(JSON.stringify(events.filter((e) => e.channels.includes(`topic:${w.ids.topic}`)))).not.toContain(secret);
  });
});

/**
 * Indirect leak paths and control-flow bypasses (from a security review of the first version).
 * Setup: the group topic is mirrored into a Slack channel with carol, an outside person; alice asks @dev there
 * and the task reads alice's DM, which holds SECRET. Nothing derived from it may reach the channel unless
 * alice approves. Console accounts (all administrators) may read everything.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, db as getDb } from "../src/db/client.js";
import { outboundMessages, tasks, users } from "../src/db/schema.js";
import { call, lastToolResult, lastUser, reply } from "./support/harness.js";
import { linkChannel } from "./support/outside.js";
import { buildWorld, type World } from "./support/world.js";

const SECRET = "salary-12345";
let w: World;
let dm: any;

beforeEach(async () => {
  w = await buildWorld();
  dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
  w.scripts.dev = () => reply("noted");
  await w.post(w.alice, dm.id, `my ${SECRET} is private`);
  await w.drain();
  await linkChannel(w, w.ids.topic, ["UCAROL"]);
});
afterEach(async () => {
  await w.close();
});

async function runDev(...steps: ReturnType<typeof call>[]) {
  w.scripts.dev = (_m, turn) => {
    const plan = [call("read_topic", { topic_id: dm.id }), ...steps];
    return turn < plan.length ? reply("", [plan[turn]]) : reply("ok");
  };
  const posted = await w.post(w.alice, w.ids.topic, "@dev go");
  await w.drain();
  return posted.tasks[0].id as string;
}

describe("indirect channels", () => {
  it("a held file is not shared with the channel, and is deleted on reject", async () => {
    w.manager.computer(w.ids.instance).files.set("/home/witden/leak.txt", Buffer.from(SECRET));
    const id = await runDev(call("share_file", { path: "leak.txt" }));
    expect((await w.task(id)).status).toBe("waiting_approval");
    expect((await w.api("GET", `/api/topics/${w.ids.topic}/files`, { token: w.alice })).body).toEqual([]);
    // nothing carrying the file went to the channel
    const mirrored = await getDb().select().from(outboundMessages);
    const topicMessages = await w.messages(w.ids.topic);
    for (const out of mirrored) {
      const m = topicMessages.find((x: any) => x.id === out.messageId);
      expect(JSON.stringify(m ?? {})).not.toContain(SECRET);
      expect(m?.attachments ?? []).toEqual([]);
    }
    const approval = (await w.api("GET", "/api/approvals", { token: w.alice })).body.find((a: any) => a.task_id === id);
    const fileId = approval.detail.attachments[0];
    expect((await w.api("GET", `/api/files/${fileId}`, { token: w.alice })).status).toBe(200);
    await w.api("POST", `/api/approvals/${approval.id}/decide`, { token: w.alice, json: { approve: false } });
    expect((await w.api("GET", `/api/files/${fileId}`, { token: w.alice })).status).toBe(404);
  });

  it("system interfaces and files holding credentials are never shared, wherever they are", async () => {
    const box = w.manager.computer(w.ids.instance);
    // what the runner's own /proc/self/environ holds, and the same copied or linked into the home directory
    const environ = Buffer.from("HOME=/home/witden\0WITDEN_RUNNER_TOKEN=wdr_abcdefghijklmnopqrstuvwxyz012345\0");
    box.files.set("/proc/self/environ", environ);
    box.files.set("/home/witden/env.txt", environ);
    box.files.set("/home/witden/.env", Buffer.from("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz\n"));
    const results: string[] = [];
    w.scripts.dev = (messages, turn) => {
      if (turn > 0) results.push(lastToolResult(messages));
      const plan = [
        call("share_file", { path: "/proc/self/environ" }),
        call("share_file", { path: "../../proc/self/environ" }),
        call("share_file", { path: "env.txt" }),
        call("share_file", { path: ".env" }),
      ];
      return turn < plan.length ? reply("", [plan[turn]]) : reply("ok");
    };
    await w.post(w.alice, w.ids.topic, "@dev share your environment");
    await w.drain();
    expect(results).toEqual([
      "error: /proc/self/environ is a system interface of the computer, not a file to share",
      "error: /proc/self/environ is a system interface of the computer, not a file to share",
      "error: /home/witden/env.txt contains a credential (wdr_…); files with credentials are never shared",
      "error: /home/witden/.env contains a credential (sk-…); files with credentials are never shared",
    ]);
    expect((await w.api("GET", `/api/topics/${w.ids.topic}/files`, { token: w.alice })).body).toEqual([]);
    const refused = (await w.api("GET", "/api/audit?action=file.share_refused", { token: w.adminToken })).body;
    expect(refused).toHaveLength(4);
    expect(JSON.stringify(refused)).not.toContain("abcdefghijklmnop");
  });

  it("topic notes cannot carry material the channel may not see", async () => {
    await runDev(call("remember", { content: `alice ${SECRET}`, scope: "topic" }));
    const mems = (await w.api("GET", `/api/memories?scope=topic&topic_id=${w.ids.topic}`, { token: w.alice })).body;
    expect(JSON.stringify(mems)).not.toContain(SECRET);
  });

  it("console accounts read every conversation, including another person's DM", async () => {
    const msgs = await w.messages(dm.id, w.bob);
    expect(JSON.stringify(msgs)).toContain(SECRET);
  });
});

describe("control flow", () => {
  it("approval during an emergency stop does not run the tool until resumed", async () => {
    await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.adminToken, json: { approval_required: ["shell"] } });
    w.scripts.dev = (_m, turn) =>
      turn === 0 ? reply("", [call("run_command", { command: "kubectl delete ns prod" })]) : reply("done");
    const id = (await w.post(w.alice, w.ids.topic, "@dev ship")).tasks[0].id;
    await w.drain();
    const ks = (
      await w.api("POST", "/api/kill-switches", { token: w.adminToken, json: { scope: "global", reason: "incident" } })
    ).body;
    const apr = (await w.api("GET", "/api/approvals", { token: w.bob })).body.find((a: any) => a.task_id === id);
    await w.api("POST", `/api/approvals/${apr.id}/decide`, { token: w.bob, json: { approve: true } });
    await w.drain();
    expect((await w.task(id)).status).toBe("paused");
    expect(w.manager.computer(w.ids.instance).commands).not.toContain("kubectl delete ns prod");
    await w.api("POST", `/api/kill-switches/${ks.id}/release`, { token: w.adminToken });
    await w.api("POST", `/api/tasks/${id}/control`, { token: w.alice, json: { action: "resume" } });
    await w.drain();
    expect((await w.task(id)).status).toBe("completed");
    expect(w.manager.computer(w.ids.instance).commands).toContain("kubectl delete ns prod");
  });

  it("a task-scoped stop covers the whole delegation tree", async () => {
    // dev's conversation hands work to test (it goes on); test's task waits for analyst's.
    w.scripts.dev = (m: any, turn: number) =>
      lastUser(m).includes("@test's task")
        ? reply("noted")
        : turn === 0
          ? reply("", [call("delegate_task", { role: "test", task: "t", expected_output: "x" })])
          : reply("ok");
    w.scripts.test = (_m: any, turn: number) =>
      turn === 0
        ? reply("", [call("delegate_task", { role: "analyst", task: "t", expected_output: "x" })])
        : reply("ok");
    w.scripts.analyst = () => reply("analyst ran");
    const root = (await w.post(w.alice, w.ids.topic, "@dev go")).tasks[0].id;
    // run step by step: root, then child, then stop before the grandchild runs
    await w.worker.tick();
    await w.waitFor(async () => (await db().select().from(tasks).where(eq(tasks.spawnedByTaskId, root)))[0]);
    const [child] = await db().select().from(tasks).where(eq(tasks.spawnedByTaskId, root));
    await w.waitFor(async () => (await w.task(root)).status === "completed");
    await w.worker.tick();
    await w.waitFor(async () => (await db().select().from(tasks).where(eq(tasks.parentTaskId, child.id)))[0]);
    await w.api("POST", "/api/kill-switches", { token: w.adminToken, json: { scope: "task", target_id: root } });
    await w.drain();
    const [grandchild] = await db().select().from(tasks).where(eq(tasks.parentTaskId, child.id));
    expect(grandchild.status).toBe("paused");
  });

  /** dev's conversation starts a task of its own; that task works like before: it waits for what it delegates or asks. */
  const ownTask = (inTask: (m: any, turn: number) => any) => (m: any, turn: number) => {
    const last = lastUser(m);
    if (last.includes("Started by your conversation")) return inTask(m, turn);
    if (last.includes("Your task")) return reply("reported");
    return turn === 0 ? reply("", [call("start_task", { task: "deploy carefully" })]) : reply("started");
  };
  const firstOwnTask = async (run: string) => {
    await w.waitFor(async () => (await db().select().from(tasks).where(eq(tasks.spawnedByTaskId, run)))[0]);
    return (await db().select().from(tasks).where(eq(tasks.spawnedByTaskId, run)))[0].id;
  };

  it("parents collect results after a pause", async () => {
    w.scripts.dev = ownTask((_m, turn) =>
      turn === 0
        ? reply("", [call("delegate_task", { role: "test", task: "t", expected_output: "x" })])
        : reply("parent finished"),
    );
    w.scripts.test = () => reply("child ok");
    const run = (await w.post(w.alice, w.ids.topic, "@dev go")).tasks[0].id;
    await w.worker.tick();
    const root = await firstOwnTask(run);
    await w.worker.tick();
    await w.waitFor(async () => (await w.task(root)).status === "waiting_children");
    const ks = (
      await w.api("POST", "/api/kill-switches", { token: w.adminToken, json: { scope: "role", target_id: w.ids.dev } })
    ).body;
    await w.drain(); // the child (role test) completes while the parent is paused
    await w.api("POST", `/api/kill-switches/${ks.id}/release`, { token: w.adminToken });
    await w.api("POST", `/api/tasks/${root}/control`, { token: w.alice, json: { action: "resume" } });
    await w.drain();
    expect((await w.task(root)).status).toBe("completed");
    // and its result went back to the conversation that started it
    expect((await w.messages(w.ids.topic)).at(-1).content).toBe("reported");
  });

  it("pausing twice keeps the waiting state", async () => {
    w.scripts.dev = ownTask((_m, turn) =>
      turn === 0 ? reply("", [call("ask_human", { question: "branch?" })]) : reply("went on"),
    );
    const run = (await w.post(w.alice, w.ids.topic, "@dev deploy")).tasks[0].id;
    await w.drain();
    const id = await firstOwnTask(run);
    expect((await w.task(id)).status).toBe("waiting_human");
    for (let i = 0; i < 2; i++)
      await w.api("POST", `/api/tasks/${id}/control`, { token: w.alice, json: { action: "pause" } });
    await w.api("POST", `/api/tasks/${id}/control`, { token: w.alice, json: { action: "resume" } });
    await w.drain();
    expect((await w.task(id)).status).toBe("waiting_human");
  });
});

describe("accounts and topics", () => {
  it("every console account is an administrator; external members never sign in", async () => {
    const made = await w.api("POST", "/api/users", {
      token: w.bob,
      json: { name: "erin", email: "erin@example.com", password: "erin-pass-12", is_admin: false },
    });
    expect(made.body.is_admin).toBe(true);
    const [ext] = await getDb()
      .insert(users)
      .values({ id: "usr_ext", name: "carol", externalConnectionId: "conn_x" })
      .returning();
    const pw = await w.api("PATCH", `/api/users/${ext.id}`, { token: w.alice, json: { password: "carol-pass-1" } });
    expect(pw.status).toBe(400);
  });

  it("a takeover is handed back by its holder, or by another console account (all are administrators)", async () => {
    const take = (token: string) => w.api("POST", `/api/instances/${w.ids.instance}/takeover`, { token, json: {} });
    expect((await take(w.alice)).status).toBe(200);
    expect((await w.api("POST", `/api/instances/${w.ids.instance}/handback`, { token: w.bob })).status).toBe(200);
    const inst = (await w.api("GET", `/api/instances/${w.ids.instance}`, { token: w.alice })).body;
    expect(inst.operator?.holder_type ?? null).not.toBe("user");
  });

  it("changing a provider's endpoint drops the stored key", async () => {
    const p = (
      await w.api("POST", "/api/model-providers", {
        token: w.adminToken,
        json: { name: "k", base_url: "http://a/v1", api_key: "sk-keep-me-secret-123456", models: ["m"] },
      })
    ).body;
    const rename = await w.api("PATCH", `/api/model-providers/${p.id}`, { token: w.adminToken, json: { name: "k2" } });
    expect(rename.body.has_api_key).toBe(true);
    const moved = await w.api("PATCH", `/api/model-providers/${p.id}`, {
      token: w.adminToken,
      json: { base_url: "http://evil/v1" },
    });
    expect(moved.body.has_api_key).toBe(false);
  });
});

export { lastToolResult };

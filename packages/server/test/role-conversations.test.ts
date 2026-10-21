import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, sessionFor } from "../src/agent/dispatch.js";
import { TOOLS } from "../src/agent/tools.js";
import { db, transaction } from "../src/db/client.js";
import { agentSessions, taskInputs, tasks, topicParticipants, topics } from "../src/db/schema.js";
import { ModelError } from "../src/errors.js";
import { roleMemoryRefusal } from "../src/services/role-memory.js";
import { getOrCreatePairTopic, getRole, getTopic } from "../src/services/topics.js";
import { call, lastToolResult, lastUser, reply } from "./support/harness.js";
import { linkChannel } from "./support/outside.js";
import { buildWorld, type World } from "./support/world.js";

// Two AI employees talking directly, outside any topic: only with a person's permission, one direction at a time.
describe("direct conversations between AI employees", () => {
  let w: World;
  let work: string;
  beforeEach(async () => {
    w = await buildWorld();
    // A topic only @dev works in: @analyst and @test are not part of it.
    const r = await w.api("POST", "/api/topics", { token: w.alice, json: { title: "Work", role_ids: [w.ids.dev] } });
    expect(r.status, r.raw).toBe(200);
    work = r.body.id;
  });
  afterEach(async () => {
    await w?.close();
  });

  const contacts = async (roleId: string, ids: string[]) => {
    const r = await w.api("PATCH", `/api/roles/${roleId}`, { token: w.alice, json: { allowed_contacts: ids } });
    expect(r.status, r.raw).toBe(200);
    return r.body;
  };
  const pairTopics = () => db().select().from(topics).where(eq(topics.kind, "pair"));
  const contents = async (topicId: string) => (await w.messages(topicId)).map((m: any) => m.content);
  /** A running piece of @dev's work in Work, as the worker would hold it. */
  const running = (kind: "conversation" | "task", limits: Record<string, true> | null = null) =>
    transaction(async (tx) => {
      const topic = await getTopic(tx, work);
      const role = (await getRole(tx, w.ids.dev))!;
      const task = await createTask(tx, {
        topic,
        role,
        kind,
        session: kind === "conversation" ? await sessionFor(tx, role.id, topic.id) : null,
        requesterUserId: w.ids.alice,
        instruction: "check the numbers",
        limits,
      });
      return (await tx.update(tasks).set({ status: "running" }).where(eq(tasks.id, task.id)).returning())[0];
    });
  const contact = (task: typeof tasks.$inferSelect, args: Record<string, unknown>, callId = "c-1") =>
    TOOLS.get("contact_role")!.handler(
      {
        taskId: task.id,
        topicId: task.topicId,
        roleId: task.ownerRoleId,
        toolCallId: callId,
        gateway: w.witden.runtime.gateway!,
        db,
        mode: task.kind === "conversation" ? "conversation" : "task",
      },
      args,
    );

  it("an allowed role writes to another; the answer comes back to its conversation and both stay in their pair", async () => {
    await contacts(w.ids.dev, [w.ids.analyst]);
    let devTools: string[] = [];
    let analystTools: string[] = [];
    let analystSaw = "";
    let analystPrompt = "";
    let devSaw = "";
    w.scripts.dev = (m, turn, tools) => {
      const u = lastUser(m);
      if (u.includes("Reply from @analyst")) {
        devSaw = u;
        return reply("@analyst confirms: 42");
      }
      devTools = (tools ?? []).map((t) => t.name);
      if (turn === 0) return reply("", [call("contact_role", { role: "@analyst", message: "Is the Q3 total 42?" })]);
      return reply("asked @analyst, waiting for its answer");
    };
    w.scripts.analyst = (m, _turn, tools) => {
      analystTools = (tools ?? []).map((t) => t.name);
      analystSaw = lastUser(m);
      analystPrompt = String(m[0].content);
      return reply("Yes, the Q3 total is 42.");
    };
    await w.post(w.alice, work, "@dev please check the Q3 numbers");
    await w.drain();

    // one conversation for the pair, with exactly the two roles and no people
    const [pair] = await pairTopics();
    expect(pair.title).toContain("@dev");
    expect(pair.title).toContain("@analyst");
    const members = await db().select().from(topicParticipants).where(eq(topicParticipants.topicId, pair.id));
    expect(members.map((p) => [p.participantType, p.participantId]).sort()).toEqual(
      [
        ["role", w.ids.analyst],
        ["role", w.ids.dev],
      ].sort(),
    );
    expect(await contents(pair.id)).toEqual(["Is the Q3 total 42?", "Yes, the Q3 total is 42."]);
    // the answer reached @dev's conversation in Work, marked as @analyst's reply in their direct conversation
    expect(devSaw).toContain("Reply from @analyst in your direct conversation with them");
    expect(devSaw).toContain("Yes, the Q3 total is 42.");
    expect(await contents(work)).toEqual([
      "@dev please check the Q3 numbers",
      "asked @analyst, waiting for its answer",
      "@analyst confirms: 42",
    ]);
    // the receiver never sees where the sender works; the sender sees only the answer
    expect(analystSaw).toContain("→ you: Is the Q3 total 42?");
    for (const text of [analystSaw, analystPrompt]) {
      expect(text).not.toContain("Q3 numbers");
      expect(text).not.toContain(work);
      expect(text).not.toContain("«Work»");
    }
    expect(analystPrompt).toContain("Your direct conversation with @dev");
    expect(devTools).toContain("contact_role");
    // nobody to ask, @ or hand work to in the pair; no contact list, no contact_role
    for (const tool of ["message_role", "delegate_task", "ask_human", "contact_role"])
      expect(analystTools).not.toContain(tool);
    // people read it in the console, with nobody to post as
    const view = await w.api("GET", `/api/topics/${pair.id}`, { token: w.bob });
    expect(view.body).toMatchObject({ kind: "pair", can_post: false });
    // a second message reuses the pair
    await w.post(w.alice, work, "@dev ask again");
    await w.drain();
    expect(await pairTopics()).toHaveLength(1);
  });

  it("writing first needs the writer's permission; answering does not", async () => {
    await contacts(w.ids.dev, [w.ids.analyst]);
    // @analyst may write to @test only: not to @dev, though it answers @dev
    await contacts(w.ids.analyst, [w.ids.test]);
    let refusedTest = "";
    let refusedDev = "";
    w.scripts.dev = (m, turn) => {
      if (lastUser(m).includes("Reply from @analyst")) return reply("done");
      if (turn === 0) return reply("", [call("contact_role", { role: "test", message: "run the tests" })]);
      if (turn === 1) {
        refusedTest = lastToolResult(m);
        return reply("", [call("contact_role", { role: "analyst", message: "what is the total?" })]);
      }
      return reply("waiting");
    };
    w.scripts.analyst = (m, turn) => {
      if (turn === 0) return reply("", [call("contact_role", { role: "dev", message: "a new question for you" })]);
      refusedDev = lastToolResult(m);
      return reply("the total is 42");
    };
    w.scripts.test = () => reply("should not be asked");
    await w.post(w.alice, work, "@dev get the total");
    await w.drain();
    expect(refusedTest).toMatch(/may not start a conversation with @test/);
    expect(refusedTest).toContain("@analyst");
    expect(refusedDev).toMatch(/may not start a conversation with @dev/);
    const [pair] = await pairTopics();
    expect(await contents(pair.id)).toEqual(["what is the total?", "the total is 42"]);
    expect(await contents(work)).toContain("done");
    expect(
      await db()
        .select()
        .from(tasks)
        .where(and(eq(tasks.ownerRoleId, w.ids.test))),
    ).toEqual([]);
  });

  it("is not offered in Slack, Feishu or GitHub conversations", async () => {
    await contacts(w.ids.dev, [w.ids.analyst]);
    const group = await w.api("POST", "/api/topics", {
      token: w.alice,
      json: { title: "Partners", role_ids: [w.ids.dev] },
    });
    await linkChannel(w, group.body.id, ["UCAROL"], "partners");
    let offered: string[] = [];
    let prompt = "";
    w.scripts.dev = (m, _turn, tools) => {
      offered = (tools ?? []).map((t) => t.name);
      prompt = String(m[0].content);
      return reply("on it");
    };
    await w.post(w.alice, group.body.id, "@dev hello");
    await w.drain();
    expect(offered).not.toContain("contact_role");
    expect(prompt).not.toContain("Other AI employees you may contact");
    // in the console the same role has it, with whom it may write to
    await w.post(w.alice, work, "@dev hello");
    await w.drain();
    expect(offered).toContain("contact_role");
    expect(prompt).toContain("Other AI employees you may contact");
    expect(prompt).toContain("@analyst (Analyst: analyst role)");
  });

  it("the writer's limits travel with its message", async () => {
    await contacts(w.ids.dev, [w.ids.analyst]);
    w.scripts.analyst = () => reply("noted");
    const sender = await running("conversation", { outside: true, untrusted_input: true });
    const out = await contact(sender, { role: "analyst", message: "a request relayed from outside" });
    expect(String(out.content)).toMatch(/^sent/);
    const [pair] = await pairTopics();
    const [run] = await db().select().from(tasks).where(eq(tasks.topicId, pair.id));
    expect(run.ownerRoleId).toBe(w.ids.analyst);
    expect(run.requesterRoleId).toBe(w.ids.dev);
    expect(run.envelope).toMatchObject({ outside: true, untrusted_input: true, pair_topic: true });
    expect(run.envelope.topic_routes).toBeUndefined();
    expect(await roleMemoryRefusal(db(), run)).toMatch(/role memory/);
    // a repeated call does not write twice
    expect(
      String((await contact(sender, { role: "analyst", message: "a request relayed from outside" })).content),
    ).toMatch(/already sent/);
    expect(await contents(pair.id)).toEqual(["a request relayed from outside"]);
  });

  it("the round limit ends a back-and-forth between two roles", async () => {
    w.settings.maxAutoRounds = 4;
    await contacts(w.ids.dev, [w.ids.analyst]);
    await contacts(w.ids.analyst, [w.ids.dev]);
    const refusals: string[] = [];
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("contact_role", { role: "analyst", message: "ping" })]);
      const result = lastToolResult(m);
      if (result.startsWith("error")) refusals.push(result);
      return reply("noted");
    };
    w.scripts.analyst = () => reply("pong");
    await w.post(w.alice, work, "@dev start");
    await w.drain();
    const [pair] = await pairTopics();
    expect(await contents(pair.id)).toEqual(["ping", "pong", "ping", "pong"]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/round limit/);
  });

  it("an answer reaches the independent task that wrote while it runs, or else the writer in the pair", async () => {
    await contacts(w.ids.dev, [w.ids.analyst]);
    w.scripts.analyst = () => reply("the answer is 42");
    let devInPair = "";
    w.scripts.dev = (m) => {
      devInPair = lastUser(m);
      return reply("");
    };
    // the task still works: a new input between its steps
    const task = await running("task");
    expect(String((await contact(task, { role: "analyst", message: "what is the answer?" })).content)).toContain(
      "new input",
    );
    await w.drain();
    const [input] = await db().select().from(taskInputs).where(eq(taskInputs.taskId, task.id));
    expect(input.content).toContain("Reply from @analyst in your direct conversation with them");
    expect(input.content).toContain("the answer is 42");
    // the task has ended: the writer's own conversation in the pair gets it
    const done = await running("task");
    await contact(done, { role: "analyst", message: "and the question?" });
    await db().update(tasks).set({ status: "completed" }).where(eq(tasks.id, done.id));
    await w.drain();
    const [pair] = await pairTopics();
    expect(devInPair).toMatch(/@analyst's reply msg_\w+ above answers your message/);
    const [session] = await db()
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.topicId, pair.id), eq(agentSessions.roleId, w.ids.dev)));
    expect(session.inbox.map((i) => i.kind)).toEqual(["reply"]);
    // it read the answer without saying anything more
    expect(await contents(pair.id)).toEqual([
      "what is the answer?",
      "the answer is 42",
      "and the question?",
      "the answer is 42",
    ]);
  });

  it("a writer hears when the other side ended without an answer", async () => {
    await contacts(w.ids.dev, [w.ids.analyst]);
    let devSaw = "";
    w.scripts.dev = (m, turn) => {
      const u = lastUser(m);
      if (u.includes("No reply")) {
        devSaw = u;
        return reply("@analyst could not answer");
      }
      if (turn === 0) return reply("", [call("contact_role", { role: "analyst", message: "status?" })]);
      return reply("asked");
    };
    w.scripts.analyst = () => {
      throw new ModelError("the model service is down");
    };
    await w.post(w.alice, work, "@dev ask for the status");
    await w.drain();
    expect(devSaw).toMatch(/No reply to your message msg_\w+ «status\?»: @analyst did not answer \(failed/);
    expect(await contents(work)).toContain("@analyst could not answer");
  });

  it("people read a pair but cannot post, invite, link, configure or add triggers", async () => {
    const pair = await transaction(async (tx) =>
      getOrCreatePairTopic(tx, (await getRole(tx, w.ids.dev))!, (await getRole(tx, w.ids.analyst))!),
    );
    const again = await transaction(async (tx) =>
      getOrCreatePairTopic(tx, (await getRole(tx, w.ids.analyst))!, (await getRole(tx, w.ids.dev))!),
    );
    expect(again.id).toBe(pair.id);
    const base = `/api/topics/${pair.id}`;
    expect((await w.api("POST", `${base}/messages`, { token: w.alice, json: { content: "hi" } })).status).toBe(403);
    expect(
      (await w.api("POST", `${base}/participants`, { token: w.alice, json: { type: "user", id: w.ids.alice } })).status,
    ).toBe(400);
    expect(
      (await w.api("POST", `${base}/participants`, { token: w.alice, json: { type: "role", id: w.ids.test } })).status,
    ).toBe(400);
    expect((await w.api("DELETE", `${base}/participants/role/${w.ids.dev}`, { token: w.alice })).status).toBe(400);
    for (const json of [{ title: "renamed" }, { response_mode: "auto" }, { status: "archived" }])
      expect((await w.api("PATCH", base, { token: w.alice, json })).status).toBe(400);
    const group = await w.api("POST", "/api/topics", { token: w.alice, json: { title: "Partners" } });
    await linkChannel(w, group.body.id, [], "partners");
    const link = await w.api("POST", `${base}/links`, { token: w.alice, json: { topic_id: group.body.id } });
    expect(link.status).toBe(400);
    expect(link.body.error.message).toMatch(/cannot be linked/);
    const trigger = await w.api("POST", `${base}/triggers`, {
      token: w.alice,
      json: { name: "nightly", kind: "schedule", role_id: w.ids.dev, cron: "0 3 * * *" },
    });
    expect(trigger.status).toBe(400);
    // topics are created as groups or DMs only
    expect((await w.api("POST", "/api/topics", { token: w.alice, json: { title: "x", kind: "pair" } })).status).toBe(
      400,
    );
    // the history is open to console accounts
    expect((await w.api("GET", `${base}/messages`, { token: w.bob })).status).toBe(200);
  });

  it("validates whom a role may write to", async () => {
    const roles = (await w.api("GET", "/api/roles", { token: w.adminToken })).body;
    const adminId = roles.find((r: any) => r.system_admin).id;
    const patch = (id: string, ids: unknown) =>
      w.api("PATCH", `/api/roles/${id}`, { token: w.alice, json: { allowed_contacts: ids } });
    expect((await patch(w.ids.dev, [w.ids.dev])).status).toBe(400);
    expect((await patch(w.ids.dev, [adminId])).status).toBe(400);
    expect((await patch(w.ids.dev, ["role_missing"])).status).toBe(404);
    expect((await patch(w.ids.dev, ["*"])).status).toBe(404);
    expect((await patch(w.ids.dev, "everyone")).status).toBe(400);
    expect((await patch(adminId, [w.ids.dev])).status).toBe(400);
    // a disabled role may be listed (it is written to once it is enabled again)
    await w.api("POST", `/api/roles/${w.ids.test}/disable`, { token: w.alice, json: { on_tasks: "keep" } });
    const ok = await patch(w.ids.dev, [w.ids.test, w.ids.analyst, w.ids.test]);
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.body.allowed_contacts).toEqual([w.ids.analyst, w.ids.test].sort());
    expect((await w.api("GET", `/api/roles/${w.ids.dev}`, { token: w.alice })).body.allowed_contacts).toEqual(
      [w.ids.analyst, w.ids.test].sort(),
    );
    const created = await w.api("POST", "/api/roles", {
      token: w.alice,
      json: { name: "Ops", handle: "ops", allowed_contacts: [w.ids.dev] },
    });
    expect(created.status, created.raw).toBe(200);
    expect(created.body.allowed_contacts).toEqual([w.ids.dev]);
    // the copy keeps the list
    const copy = await w.api("POST", `/api/roles/${created.body.id}/copy`, {
      token: w.alice,
      json: { handle: "ops2" },
    });
    expect(copy.body.allowed_contacts).toEqual([w.ids.dev]);
  });
});

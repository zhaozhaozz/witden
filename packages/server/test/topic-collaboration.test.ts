import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStatus } from "../src/agent/control.js";
import { inject } from "../src/agent/conversation.js";
import { createTask, saveMessage, sessionFor } from "../src/agent/dispatch.js";
import { stillAllowed } from "../src/agent/revocation.js";
import { TOOLS } from "../src/agent/tools.js";
import { appendStep, loadTranscript } from "../src/agent/transcript.js";
import { db, transaction } from "../src/db/client.js";
import {
  agentSessions,
  auditLogs,
  connections,
  externalThreadLinks,
  messages,
  outboundMessages,
  roles,
  taskInputs,
  tasks,
  topicLinks,
  topicParticipants,
  topics as topicsTable,
  topicTriggers,
  triggerEvents,
  webhookReceipts,
} from "../src/db/schema.js";
import { deliverOne } from "../src/integrations/delivery.js";
import { sentMessageRoot } from "../src/integrations/message-refs.js";
import { manageAutomation } from "../src/services/automation-rules.js";
import { roleMemoryRefusal } from "../src/services/role-memory.js";
import { getRole, getTopic } from "../src/services/topics.js";
import { processTriggerEvents } from "../src/services/triggers.js";
import { acceptSourceWebhook } from "../src/services/webhook-sources.js";
import { call, lastToolResult, lastUser, reply } from "./support/harness.js";
import { linkChannel } from "./support/outside.js";
import { buildWorld, type World } from "./support/world.js";

const SECRET = "shared-webhook-secret-long-enough-for-tests";
const rawRequest = {
  method: "POST",
  path: "/test",
  query: {},
  headers: { authorization: `Bearer ${SECRET}` },
  body_base64: Buffer.from('{"action":"opened"}').toString("base64"),
};

// Tests use the real API, database and task engine. External transport and model responses use the project's harness.
describe("linked topics, shared sources and task iterations", () => {
  let w: World;
  beforeEach(async () => {
    w = await buildWorld();
  });
  afterEach(async () => {
    await w?.close();
  });
  const newTopic = async (name = "Work", token?: string) => {
    const r = await w.api("POST", "/api/topics", {
      token: token ?? w.alice,
      json: { title: name, role_ids: [w.ids.dev] },
    });
    expect(r.status, r.raw).toBe(200);
    return r.body.id as string;
  };
  /** A topic linked to a Slack channel: only @dev, the role its bot stands for, works there. */
  const externalTopic = async (name = "Partners") => {
    const id = await newTopic(name);
    await linkChannel(w, id, ["UCAROL"], name.toLowerCase());
    return id;
  };
  const link = (a: string, b: string, confirmPrivate?: boolean) =>
    w.api("POST", `/api/topics/${a}/links`, {
      token: w.alice,
      json: { topic_id: b, ...(confirmPrivate ? { confirm_private: true } : {}) },
    });
  const connect = async (a: string, b: string) => {
    const r = await link(a, b);
    expect(r.status, r.raw).toBe(200);
    return r.body;
  };
  const sender = async (topicId = w.ids.topic) =>
    transaction(async (tx) => {
      const topic = await getTopic(tx, topicId);
      const role = (await getRole(tx, w.ids.dev))!;
      const message = await saveMessage(tx, topic, "user", w.ids.alice, "Please handle this work", { mentions: [] });
      const task = await createTask(tx, {
        topic,
        role,
        requesterUserId: w.ids.alice,
        instruction: "Work",
        sourceMessage: message,
      });
      return (await tx.update(tasks).set({ status: "running" }).where(eq(tasks.id, task.id)).returning())[0];
    });
  const send = (task: typeof tasks.$inferSelect, args: Record<string, unknown>, callId = "send-1") =>
    TOOLS.get("send_message")!.handler(
      {
        taskId: task.id,
        topicId: task.topicId,
        roleId: task.ownerRoleId,
        toolCallId: callId,
        gateway: w.witden.runtime.gateway!,
        db,
      },
      args,
    );

  it("requires direct links and treats the pair as bidirectional and unique", async () => {
    const a = w.ids.topic,
      b = await externalTopic(),
      c = await newTopic("Other");
    const task = await sender();
    await expect(send(task, { topic_id: b, text: "Work" })).rejects.toThrow(/linked/);
    await connect(a, b);
    await connect(b, a);
    await connect(b, c);
    expect(await db().select().from(topicLinks)).toHaveLength(2);
    await expect(send(task, { topic_id: c, text: "Work" })).rejects.toThrow(/linked/);
  });

  it("links an external conversation only with an internal topic; a console DM is internal", async () => {
    const work = await newTopic("Work");
    const group = await externalTopic("Group");
    const other = await externalTopic("Other group");
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body.id as string;
    const inside = await link(w.ids.topic, work);
    expect(inside.status).toBe(400);
    expect(inside.body.error.message).toMatch(/two internal topics cannot be linked/);
    const dmInside = await link(dm, work, true);
    expect(dmInside.status).toBe(400);
    expect(dmInside.body.error.message).toMatch(/two internal topics cannot be linked/);
    const outside = await link(group, other);
    expect(outside.status).toBe(400);
    expect(outside.body.error.message).toMatch(/two external conversations cannot be linked/);
    expect(await db().select().from(topicLinks)).toEqual([]);
    await connect(group, work);
    expect((await link(dm, other, true)).status).toBe(200);
    expect(await db().select().from(topicLinks)).toHaveLength(2);
  });

  it("an external conversation and its linked internal topic message each other without a permission or approval", async () => {
    const group = await externalTopic();
    await connect(group, w.ids.topic);
    w.scripts.dev = (_m, turn) =>
      turn === 0
        ? reply("", [call("send_message", { topic_id: w.ids.topic, role: "test", text: "please review the release" })])
        : reply("asked the team");
    w.scripts.test = (_m, turn) =>
      turn === 0
        ? reply("", [call("send_message", { topic_id: group, text: "review done: all good" })])
        : reply("reviewed");
    await w.post(w.alice, group, "@dev can the team review the release?");
    await w.drain();
    expect((await w.api("GET", "/api/approvals", { token: w.bob })).body).toEqual([]);
    const here = (await w.messages(w.ids.topic)).map((m: any) => m.content);
    expect(here).toEqual(expect.arrayContaining(["please review the release", "reviewed"]));
    // The answer is published in the external conversation; no role runs there for it.
    expect((await w.messages(group)).map((m: any) => m.content)).toContain("review done: all good");
    const runs = await db().select().from(tasks).where(eq(tasks.topicId, group));
    expect(runs.map((t) => t.ownerRoleId)).toEqual([w.ids.dev]);
  });

  it("delegates to roles of the topic without a permission; a role outside it is refused before any approval", async () => {
    const outsider = (
      await w.api("POST", "/api/roles", {
        token: w.adminToken,
        json: { name: "Outsider", handle: "outsider", model_config_id: w.ids.model, instance_id: w.ids.instance },
      })
    ).body.id as string;
    // alice has a DM with it: that is no place for work delegated from this topic either.
    await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: outsider } });
    // No permission at all, and an older setting still lists the tool as asking.
    const limited = await w.api("PATCH", `/api/roles/${w.ids.dev}`, {
      token: w.adminToken,
      json: { allowed_tools: ["shell"], approval_required: ["delegate_task"] },
    });
    expect(limited.status, limited.raw).toBe(200);
    let target = "test";
    // A result coming back is a new turn too: answer it instead of delegating again.
    w.scripts.dev = (m, turn) =>
      lastUser(m).includes(" ended")
        ? reply("thanks")
        : turn === 0
          ? reply("", [call("delegate_task", { role: target, task: "do a part", expected_output: "done" })])
          : reply(`result: ${lastToolResult(m)}`);
    w.scripts.test = () => reply("part done");
    w.scripts.outsider = () => reply("outside part done");
    const pending = async () => (await w.api("GET", "/api/approvals", { token: w.bob })).body;
    const ownerTasks = async (roleId: string) =>
      (await db().select().from(tasks).where(eq(tasks.ownerRoleId, roleId))).filter((t) => t.kind === "task");
    await w.post(w.alice, w.ids.topic, "@dev split it");
    await w.drain();
    expect(await pending()).toEqual([]);
    expect(await ownerTasks(w.ids.test)).toHaveLength(1);
    target = "outsider";
    await w.post(w.alice, w.ids.topic, "@dev split it again");
    await w.drain();
    const refused = (await w.messages(w.ids.topic)).at(-1).content;
    expect(refused).toContain("@outsider is not in this topic");
    expect(refused).toContain("hand work only to roles of this topic");
    expect(await pending()).toEqual([]);
    expect(await ownerTasks(outsider)).toHaveLength(0);
    const members = await db()
      .select()
      .from(topicParticipants)
      .where(and(eq(topicParticipants.topicId, w.ids.topic), eq(topicParticipants.participantId, outsider)));
    expect(members).toEqual([]);
  });

  it("from a DM, work goes to no other role, even one the person has a DM with", async () => {
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body.id as string;
    await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.test } });
    const dmCount = async () => (await db().select().from(topicsTable).where(eq(topicsTable.kind, "dm"))).length;
    const before = await dmCount();
    w.scripts.dev = (m, turn) =>
      turn === 0
        ? reply("", [call("delegate_task", { role: "test", task: "look at this", expected_output: "an opinion" })])
        : reply(`result: ${lastToolResult(m)}`);
    w.scripts.test = () => reply("fine by me");
    await w.post(w.alice, dm, "ask test what it thinks");
    await w.drain();
    expect((await w.messages(dm)).at(-1).content).toContain("@test is not in this topic");
    expect(await dmCount()).toBe(before);
    const work = (await db().select().from(tasks).where(eq(tasks.ownerRoleId, w.ids.test))).filter(
      (t) => t.kind === "task",
    );
    expect(work).toEqual([]);
  });

  it("a request relayed from an external conversation: the internal topic's roles @ and delegate to each other, keeping its limits", async () => {
    const group = await externalTopic();
    await connect(group, w.ids.topic);
    // Work from a conversation goes on while its connection is active (tests deliver nothing to Slack).
    await db().update(connections).set({ status: "active" });
    await w.api("POST", "/api/roles", {
      token: w.adminToken,
      json: { name: "Outsider", handle: "outsider", model_config_id: w.ids.model, instance_id: w.ids.instance },
    });
    let offered: string[] = [];
    let refused = "";
    w.scripts.dev = (m, turn) => {
      if (lastUser(m).includes("Delegated by @test")) return reply("build passed");
      return turn === 0
        ? reply("", [call("send_message", { topic_id: w.ids.topic, role: "test", text: "please build and review it" })])
        : reply("asked the team");
    };
    w.scripts.test = (m, turn, tools) => {
      if (lastUser(m).includes("@dev's task")) return reply("built; analyst reviews");
      if (turn === 0) {
        offered = (tools ?? []).map((t) => t.name);
        return reply("", [call("message_role", { role: "analyst", message: "please review" })]);
      }
      if (turn === 1)
        return reply("", [
          call("delegate_task", { role: "dev", task: "run the build", expected_output: "pass or fail" }),
        ]);
      if (turn === 2)
        return reply("", [call("delegate_task", { role: "outsider", task: "deploy it", expected_output: "done" })]);
      refused = lastToolResult(m);
      return reply("working on it");
    };
    w.scripts.analyst = () => reply("reviewed");
    await w.post(w.alice, group, "@dev please get the release built and reviewed");
    await w.drain();
    expect(offered).toEqual(expect.arrayContaining(["message_role", "delegate_task"]));
    const here = (await w.messages(w.ids.topic)).map((m: any) => m.content);
    expect(here).toEqual(expect.arrayContaining(["@analyst please review", "reviewed", "build passed"]));
    expect(refused).toContain("@outsider is not in this topic");
    expect((await w.api("GET", "/api/approvals", { token: w.bob })).body).toEqual([]);
    // The colleague's run and the delegated task keep the limits of the outside request.
    const inTopic = await db().select().from(tasks).where(eq(tasks.topicId, w.ids.topic));
    const analystRun = inTopic.find((t) => t.ownerRoleId === w.ids.analyst && t.kind === "conversation")!;
    const devTask = inTopic.find((t) => t.ownerRoleId === w.ids.dev && t.kind === "task")!;
    for (const work of [analystRun, devTask]) {
      expect(work.envelope).toMatchObject({ outside: true, untrusted_input: true });
      expect(work.envelope.external_topic).toBeUndefined();
      expect(work.envelope.topic_routes?.[0]?.source_topic_id).toBe(group);
      expect(await roleMemoryRefusal(db(), work)).toMatch(/role memory/);
    }
    // When the link row is gone (unlinked, or removed by a migration), work started from it ends.
    await db().delete(topicLinks);
    expect(await stillAllowed(db(), devTask)).toMatch(/link.*removed/);
  });

  // --- status of linked internal topics ----------------------------------------------------------------------

  const status = async (task: typeof tasks.$inferSelect, args: Record<string, unknown> = {}) =>
    (
      await TOOLS.get("linked_topic_status")!.handler(
        {
          taskId: task.id,
          topicId: task.topicId,
          roleId: task.ownerRoleId,
          toolCallId: "status-1",
          gateway: w.witden.runtime.gateway!,
          db,
        },
        args,
      )
    ).content as string;
  /** Work of ``roleId`` in ``topicId``, put straight into ``state`` (no model runs for it). */
  const work = (topicId: string, roleId: string, instruction: string, state: Partial<typeof tasks.$inferSelect>) =>
    transaction(async (tx) => {
      const task = await createTask(tx, {
        topic: await getTopic(tx, topicId),
        role: (await getRole(tx, roleId))!,
        requesterUserId: w.ids.alice,
        instruction,
      });
      return (await tx.update(tasks).set(state).where(eq(tasks.id, task.id)).returning())[0];
    });

  it("the external conversation's role checks a linked internal topic's work and its own requests, not its messages", async () => {
    const group = await externalTopic();
    await connect(group, w.ids.topic);
    await db().update(connections).set({ status: "active" });
    await work(w.ids.topic, w.ids.analyst, "Prepare the release notes\nwith every detail", {
      status: "running",
      progress: "drafting the changelog",
    });
    await work(w.ids.topic, w.ids.test, "Run the regression suite", {
      status: "completed",
      finishedAt: new Date(),
      result: `All 120 tests passed. ${"More detail. ".repeat(40)}TAIL-MARKER`,
    });
    // A person's request in the internal topic: the conversation run it starts (waiting for an approval) shows
    // its state only, never the person's text.
    await w.api("PATCH", `/api/roles/${w.ids.analyst}`, {
      token: w.adminToken,
      json: { approval_required: ["memory"] },
    });
    w.scripts.analyst = (_m, turn) =>
      turn === 0 ? reply("", [call("remember", { title: "a note", content: "a note" })]) : reply("noted");
    await w.post(w.bob, w.ids.topic, "@analyst between us: the codename is BLUEBIRD");
    await transaction(async (tx) =>
      saveMessage(tx, await getTopic(tx, w.ids.topic), "user", w.ids.bob, "and the launch is on Friday", {
        mentions: [],
      }),
    );
    let checked = "";
    let prompt = "";
    const offered: Record<string, string[]> = {};
    w.scripts.dev = (m, turn, tools) => {
      offered.dev = (tools ?? []).map((t) => t.name);
      if (lastUser(m).includes("how is it going")) {
        if (turn === 0) return reply("", [call("linked_topic_status", { topic_id: w.ids.topic })]);
        checked = lastToolResult(m);
        return reply("the team is on it");
      }
      prompt ||= lastUser(m);
      return turn === 0
        ? reply("", [call("send_message", { topic_id: w.ids.topic, role: "test", text: "please review the release" })])
        : reply("asked the team");
    };
    // The internal role splits the review off; the task then waits for a person's answer.
    w.scripts.test = (m, turn, tools) => {
      if (lastUser(m).includes("review the release in depth"))
        return turn === 0 ? reply("", [call("ask_human", { question: "Which build should I review?" })]) : reply("ok");
      offered.test = (tools ?? []).map((t) => t.name);
      if (turn === 0) return reply("", [call("start_task", { task: "review the release in depth" })]);
      if (turn === 1) return reply("", [call("send_message", { topic_id: group, text: "review started" })]);
      return reply("on it");
    };
    await w.post(w.alice, group, "@dev can the team review the release?");
    await w.drain();
    await w.post(w.alice, group, "@dev how is it going?");
    await w.drain();
    expect(prompt).toContain("linked_topic_status(topic_id)");
    expect(offered.dev).toContain("linked_topic_status");
    expect(offered.test).not.toContain("linked_topic_status");
    // Work in progress, with what it waits for.
    expect(checked).toContain("Prepare the release notes");
    expect(checked).toContain("progress: drafting the changelog");
    expect(checked).toMatch(/task of @test, waiting_human \(waits for a person's answer/);
    // A finished task's result, clipped.
    expect(checked).toContain("Run the regression suite");
    expect(checked).toContain("result: All 120 tests passed.");
    expect(checked).not.toContain("TAIL-MARKER");
    // The request this conversation relayed there: who took it up, and that an answer came back.
    expect(checked).toMatch(/«please review the release»: being handled by @test/);
    expect(checked).toContain("1 message(s) sent back here");
    // Status, not the topic's messages: a conversation started by a person there shows no text of theirs.
    expect(checked).toMatch(
      /对话（@analyst）, waiting_approval \(waits for an approval\), updated [\d-]+ [\d:]+ UTC\n/,
    );
    for (const text of ["BLUEBIRD", "between us", "launch is on Friday", "Which build should I review?"])
      expect(checked).not.toContain(text);
    const [run] = await db()
      .select()
      .from(tasks)
      .where(and(eq(tasks.topicId, group), eq(tasks.kind, "conversation")));
    const brief = await status(run);
    expect(brief).toContain(`${w.ids.topic} «Release 1.0»`);
    expect(brief).toMatch(/3 in progress \(2 waiting\)/);
    expect(brief).not.toContain("BLUEBIRD");
    expect(brief).toContain("your requests: 1 open of the latest 1");
    // Unlinked and unknown topics are refused alike; an internal topic does not report on its external one.
    const other = await newTopic("Other work");
    await expect(status(run, { topic_id: other })).rejects.toThrow(/not an internal topic directly linked/);
    await expect(status(run, { topic_id: "top_unknown" })).rejects.toThrow(/not an internal topic directly linked/);
    await expect(status(await sender(), { topic_id: group })).rejects.toThrow(/external conversation/);
  });

  it("linked status keeps a DM's own work and configuration work private, and masks credentials before clipping", async () => {
    const group = await externalTopic();
    await connect(group, w.ids.topic);
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.analyst } })).body
      .id as string;
    expect((await link(group, dm, true)).status).toBe(200);
    await work(dm, w.ids.analyst, "Review alice's salary", { status: "running" });
    const [admin] = await db().select().from(roles).where(eq(roles.systemAdmin, true));
    await work(w.ids.topic, admin.id, "Rotate the model provider key", { status: "running" });
    // A key the clip would cut so that it is no longer recognisable as one.
    const key = "sk-A1b2C3d4E5f6G7h8I9j0K1l2M3";
    await work(w.ids.topic, w.ids.test, "Deploy to staging", {
      status: "completed",
      finishedAt: new Date(),
      result: `${"x".repeat(388)} ${key} done`,
    });
    const rep = await sender(group);
    await send(rep, { topic_id: dm, text: "please summarise the meeting notes" });
    const inDm = await status(rep, { topic_id: dm });
    expect(inDm).toContain("private DM");
    expect(inDm).toMatch(/«please summarise the meeting notes»: (being handled|received)/);
    expect(inDm).not.toContain("salary");
    // A conversation run its own relayed request started may show that request.
    await send(rep, { topic_id: w.ids.topic, text: "please ship the hotfix" }, "send-2");
    const internal = await status(rep, { topic_id: w.ids.topic });
    expect(internal).toMatch(/对话（@dev）, pending .*: started by your request «please ship the hotfix»/);
    expect(internal).toContain("Deploy to staging");
    expect(internal).not.toContain("sk-A1b2");
    expect(internal).toContain("[REDAC");
    expect(internal).not.toContain("Rotate the model provider key");
    const brief = await status(rep);
    expect(brief).toContain("a private DM: only your requests are shown");
    expect(brief).not.toContain("salary");
  });

  it("dispatches the same role in another topic without creating a second source execution", async () => {
    const source = await externalTopic();
    const target = await newTopic();
    await connect(source, target);
    const task = await sender(source);
    const r = JSON.parse((await send(task, { topic_id: target, text: "Implement login" })).content as string);
    expect(r.status).toBe("queued_for_agent");
    const runs = await db().select().from(tasks).where(eq(tasks.topicId, target));
    expect(runs).toHaveLength(1);
    expect(runs[0].ownerRoleId).toBe(w.ids.dev);
    expect(runs[0].requesterRoleId).toBe(w.ids.dev);
    const [stored] = await db().select().from(messages).where(eq(messages.id, r.message_id));
    expect(stored.externalRef?.topic_delivery.source_topic_id).toBe(source);
    expect(stored.externalRef?.topic_delivery.origin.requester_user_id).toBe(w.ids.alice);
  });

  it("deduplicates retries of one cross-topic tool call", async () => {
    const source = await externalTopic();
    const target = await newTopic();
    await connect(source, target);
    const task = await sender(source);
    await send(task, { topic_id: target, text: "Implement login" });
    const retry = JSON.parse((await send(task, { topic_id: target, text: "Implement login" })).content as string);
    expect(retry.status).toBe("already_accepted");
    expect(await db().select().from(messages).where(eq(messages.topicId, target))).toHaveLength(1);
    expect(await db().select().from(tasks).where(eq(tasks.topicId, target))).toHaveLength(1);
  });

  it("publishes to an external destination without invoking any agent there", async () => {
    const target = await newTopic("Maintainer channel");
    const channel = await linkChannel(w, target, [], "maintainers");
    await connect(w.ids.topic, target);
    const task = await sender();
    await send(task, { topic_id: target, text: "Version one is ready" });
    expect(await db().select().from(tasks).where(eq(tasks.topicId, target))).toHaveLength(0);
    const outgoing = await db()
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.connectionId, channel.connectionId));
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].status).toBe("blocked"); // Test connection is deliberately paused; no real Slack request.
  });

  it("validates threads in the destination, not the source topic", async () => {
    const source = await externalTopic();
    const target = await newTopic();
    await connect(source, target);
    const task = await sender(source);
    await expect(send(task, { topic_id: target, text: "Update", thread: task.sourceMessageId })).rejects.toThrow(
      /selected topic/,
    );
    expect(await db().select().from(messages).where(eq(messages.topicId, target))).toHaveLength(0);
  });

  it("does not enroll the requester as a reader of an internal destination", async () => {
    const source = await externalTopic();
    const target = await newTopic("Bob's work", w.bob);
    await connect(source, target);
    const task = await sender(source);
    await send(task, { topic_id: target, text: "Implement login" });
    const [run] = await db().select().from(tasks).where(eq(tasks.topicId, target));
    expect(await stillAllowed(db(), run)).toBeNull();
    expect(
      await db()
        .select()
        .from(topicParticipants)
        .where(
          and(
            eq(topicParticipants.topicId, target),
            eq(topicParticipants.participantType, "user"),
            eq(topicParticipants.participantId, w.ids.alice),
          ),
        ),
    ).toHaveLength(0);
  });

  it("removing the link drops linked work not read yet, and ends tasks started from it", async () => {
    const source = await externalTopic();
    const target = await newTopic();
    const links = await connect(source, target);
    const task = await sender(source);
    await send(task, { topic_id: target, text: "Work" });
    const [run] = await db().select().from(tasks).where(eq(tasks.topicId, target));
    const [linkedTask] = await db()
      .update(tasks)
      .set({ kind: "task", sessionId: null })
      .where(eq(tasks.id, (await sender(target)).id))
      .returning();
    await db()
      .update(tasks)
      .set({ envelope: { ...linkedTask.envelope, topic_routes: run.envelope.topic_routes } })
      .where(eq(tasks.id, linkedTask.id));
    await w.api("DELETE", `/api/topics/${source}/links/${links[0].id}`, { token: w.alice });
    // the receiving conversation goes on with other work; the linked message it had not read is gone
    expect(await stillAllowed(db(), run)).toBeNull();
    const [session] = await db().select().from(agentSessions).where(eq(agentSessions.id, run.sessionId!));
    expect(session.inbox.filter((i) => !i.done)).toEqual([]);
    const [ended] = await db().select().from(tasks).where(eq(tasks.id, linkedTask.id));
    expect(await stillAllowed(db(), ended)).toMatch(/link.*removed/);
  });

  it("requires explicit consent before linking a DM and never auto-forwards its history", async () => {
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    const group = await externalTopic();
    const refused = await link(group, dm.id);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/confirm_private/);
    const accepted = await link(group, dm.id, true);
    expect(accepted.status).toBe(200);
    expect(await w.messages(dm.id)).toHaveLength(0);
  });

  it("receives one source receipt and independently filters two subscriptions", async () => {
    const other = await newTopic("Second work");
    const source = (
      await w.api("POST", "/api/webhook-sources", {
        token: w.alice,
        json: { name: "Bot platform", allowed_role_ids: [w.ids.dev] },
      })
    ).body;
    expect(source.token_hash).toBeUndefined();
    expect(source.secret).toMatch(/^whsec_/);
    for (const [topicId, filter] of [
      [w.ids.topic, 'return request.body.action === "opened";'],
      [other, "return false;"],
    ]) {
      const r = await w.api("POST", `/api/topics/${topicId}/triggers`, {
        token: w.alice,
        json: { name: "PR events", kind: "webhook", role_id: w.ids.dev, source_id: source.id, filter_code: filter },
      });
      expect(r.status, r.raw).toBe(200);
    }
    const a = await acceptSourceWebhook(source.id, { token: source.secret }, rawRequest, "event-1");
    const b = await acceptSourceWebhook(source.id, { token: source.secret }, rawRequest, "event-1");
    expect(b).toMatchObject({ id: a.id, duplicate: true });
    await processTriggerEvents();
    const receipts = await db().select().from(webhookReceipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].request.headers.authorization).toBe("[REDACTED]");
    const events = await db().select().from(triggerEvents).where(eq(triggerEvents.webhookReceiptId, a.id));
    expect(events.map((r) => r.status).sort()).toEqual(["dispatched", "filtered"]);
    expect(events.every((r) => r.request === null)).toBe(true);
  });

  it("stops queued shared-source deliveries after the source is disabled", async () => {
    const source = (await w.api("POST", "/api/webhook-sources", { token: w.alice, json: { name: "Source" } })).body;
    await w.api("POST", `/api/topics/${w.ids.topic}/triggers`, {
      token: w.alice,
      json: { name: "Rule", kind: "webhook", role_id: w.ids.dev, source_id: source.id },
    });
    await acceptSourceWebhook(source.id, { token: source.secret }, rawRequest, "disabled");
    await w.api("PATCH", `/api/webhook-sources/${source.id}`, { token: w.alice, json: { enabled: false } });
    await processTriggerEvents();
    const [event] = await db().select().from(triggerEvents);
    expect(event.status).toBe("skipped");
    expect(await db().select().from(tasks).where(eq(tasks.topicId, w.ids.topic))).toHaveLength(0);
  });

  it("keeps source-management APIs off the public webhook listener", async () => {
    expect((await w.webhooks("GET", "/api/webhook-sources", { token: w.alice })).status).toBe(404);
    expect((await w.api("GET", "/api/webhook-sources")).status).toBe(401);
  });

  it("receives a shared source over HTTP: secret first, the same key once, nothing about its triggers", async () => {
    const source = (
      await w.api("POST", "/api/webhook-sources", {
        token: w.alice,
        json: { name: "Bot platform", allowed_role_ids: [w.ids.dev] },
      })
    ).body;
    await w.api("POST", `/api/topics/${w.ids.topic}/triggers`, {
      token: w.alice,
      json: { name: "Events", kind: "webhook", role_id: w.ids.dev, source_id: source.id },
    });
    const post = (token: string, key = "evt-1") =>
      w.webhooks("POST", `/api/hook-sources/${source.id}`, {
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key },
        payload: '{"action":"opened"}',
      });
    expect((await post("wrong-secret-wrong-secret-wrong")).status).toBe(401);
    const first = await post(source.secret);
    expect(first.status, first.raw).toBe(202);
    expect(Object.keys(first.body).sort()).toEqual(["duplicate", "id"]);
    const again = await post(source.secret);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ id: first.body.id, duplicate: true });
    // clearing the topic's history erases the receipt too: the same key is taken again
    await w.witden.runtime.drain();
    const cleared = await w.api("DELETE", `/api/topics/${w.ids.topic}/trigger-events`, {
      token: w.alice,
      json: { confirm: true },
    });
    expect(cleared.status, cleared.raw).toBe(200);
    expect(await db().select().from(webhookReceipts)).toEqual([]);
    expect((await post(source.secret)).status).toBe(202);
  });

  it("continues a completed task in its original transcript and archives both results", async () => {
    const task = await sender();
    await transaction(async (tx) => {
      await appendStep(tx, task, "user", { content: "Original requirement: keep the API compatible" });
      await appendStep(tx, task, "assistant", { content: "Version one" });
      await setStatus(tx, task, "completed", null, { result: "Version one" });
    });
    w.scripts.dev = (history) => {
      const text = JSON.stringify(history);
      expect(text).toContain("keep the API compatible");
      expect(text).toContain("Add caching");
      return reply("Version two");
    };
    const response = await w.api("POST", `/api/tasks/${task.id}/control`, {
      token: w.alice,
      json: { action: "continue", note: "Add caching", expected_revision: 1, idempotency_key: "iteration-2" },
    });
    expect(response.status, response.raw).toBe(200);
    expect(response.body.revision).toBe(2);
    expect(response.body.instance_id).toBe(task.instanceId);
    expect(await db().select().from(taskInputs).where(eq(taskInputs.taskId, task.id))).toHaveLength(1);
    await w.drain();
    const done = await w.task(task.id);
    expect(done.status).toBe("completed");
    expect(done.iterations.map((r: any) => r.result)).toEqual(["Version one", "Version two"]);
  });

  it("deduplicates a repeated continuation request and rejects stale revision edits", async () => {
    const task = await sender();
    await transaction((tx) => setStatus(tx, task, "completed", null, { result: "v1" }));
    const payload = { action: "continue", note: "v2", expected_revision: 1, idempotency_key: "stable-retry-key" };
    const a = await w.api("POST", `/api/tasks/${task.id}/control`, { token: w.alice, json: payload });
    const b = await w.api("POST", `/api/tasks/${task.id}/control`, { token: w.alice, json: payload });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await db().select().from(taskInputs).where(eq(taskInputs.taskId, task.id))).toHaveLength(1);
    const stale = await w.api("POST", `/api/tasks/${task.id}/control`, {
      token: w.alice,
      json: { ...payload, idempotency_key: "different-key" },
    });
    expect(stale.status).toBe(400);
  });

  it("does not resume a manually paused task when requirements are added", async () => {
    const task = await sender();
    await transaction((tx) =>
      setStatus(tx, task, "paused", "human pause", { wait: { resume_to: "pending", paused_by: "user" } }),
    );
    const r = await w.api("POST", `/api/tasks/${task.id}/control`, {
      token: w.alice,
      json: { action: "instruct", note: "Remember this for later" },
    });
    expect(r.status).toBe(200);
    expect((await w.task(task.id)).status).toBe("paused");
    expect((await db().select().from(taskInputs).where(eq(taskInputs.taskId, task.id)))[0].consumedAt).toBeNull();
  });

  it("prevents continuation on a different computer", async () => {
    const task = await sender();
    await transaction((tx) => setStatus(tx, task, "completed", null, { result: "v1" }));
    await db().update(roles).set({ instanceId: null }).where(eq(roles.id, w.ids.dev));
    const r = await w.api("POST", `/api/tasks/${task.id}/control`, {
      token: w.alice,
      json: { action: "continue", note: "v2" },
    });
    expect(r.status).toBe(403);
  });

  it("delivers each iteration result to the same main session, even before it reads the first result", async () => {
    const task = await sender();
    const session = await transaction((tx) => sessionFor(tx, w.ids.dev, w.ids.topic));
    await db().update(tasks).set({ reportSessionId: session.id }).where(eq(tasks.id, task.id));
    const [withReport] = await db().select().from(tasks).where(eq(tasks.id, task.id));
    await transaction((tx) => setStatus(tx, withReport, "completed", null, { result: "first delivery" }));
    const continued = await w.api("POST", `/api/tasks/${task.id}/control`, {
      token: w.alice,
      json: { action: "continue", note: "second iteration", expected_revision: 1 },
    });
    expect(continued.status, continued.raw).toBe(200);
    const [second] = await db().select().from(tasks).where(eq(tasks.id, task.id));
    await transaction((tx) => setStatus(tx, second, "completed", null, { result: "second delivery" }));
    const [state] = await db().select().from(agentSessions).where(eq(agentSessions.id, session.id));
    expect(state.inbox.filter((i) => i.kind === "result").map((i) => i.revision)).toEqual([1, 2]);
    const [run] = await db().select().from(tasks).where(eq(tasks.sessionId, session.id));
    const topic = await getTopic(db(), w.ids.topic);
    const role = (await getRole(db(), w.ids.dev))!;
    await transaction((tx) => inject(tx, run, topic, role));
    const transcript = JSON.stringify(await loadTranscript(db(), run));
    expect(transcript).toContain("first delivery");
    expect(transcript).toContain("second delivery");
  });

  it("lets a granted role manage only its own rules across topics, without exposing secrets", async () => {
    const other = await newTopic("Another work topic");
    const [dev] = await db().select().from(roles).where(eq(roles.id, w.ids.dev));
    await db()
      .update(roles)
      .set({ allowedTools: [...dev.allowedTools, "automation"] })
      .where(eq(roles.id, dev.id));
    const task = await sender();
    const source = (
      await w.api("POST", "/api/webhook-sources", {
        token: w.alice,
        json: { name: "Granted source", allowed_role_ids: [w.ids.dev] },
      })
    ).body;
    const result: any = await transaction((tx) =>
      manageAutomation(tx, task, {
        action: "create",
        topic_id: other,
        kind: "webhook",
        config: { name: "Own rule", source_id: source.id, filter_code: "return true;" },
      }),
    );
    expect(result.topic_id).toBe(other);
    expect(JSON.stringify(result)).not.toContain(source.secret);
    const offered = await transaction((tx) => manageAutomation(tx, task, { action: "sources" }));
    expect(offered).toEqual([{ id: source.id, name: "Granted source", enabled: true }]);
    expect(result.token_hash).toBeUndefined();
    expect((await db().select().from(topicTriggers).where(eq(topicTriggers.id, result.id)))[0].roleId).toBe(w.ids.dev);
    const paused: any = await transaction((tx) =>
      manageAutomation(tx, task, { action: "update", id: result.id, config: { enabled: false } }),
    );
    expect(paused.enabled).toBe(false);
    await expect(
      transaction((tx) =>
        manageAutomation(tx, task, { action: "update", id: result.id, config: { secret: source.secret } }),
      ),
    ).rejects.toThrow(/configuration/);
    await expect(
      transaction((tx) =>
        manageAutomation(tx, { ...task, envelope: { ...task.envelope, outside: true } }, { action: "list" }),
      ),
    ).rejects.toThrow(/console conversation/);
    const foreign = (
      await w.api("POST", `/api/topics/${w.ids.topic}/triggers`, {
        token: w.alice,
        json: { name: "Another role", kind: "schedule", role_id: w.ids.test, cron: "0 9 * * *" },
      })
    ).body;
    await expect(transaction((tx) => manageAutomation(tx, task, { action: "get", id: foreign.id }))).rejects.toThrow(
      /no rule/,
    );
  });

  it("resolves a platform reply to a previously sent report and keeps subsequent sends in its thread", async () => {
    const target = await newTopic("External destination");
    const channel = await linkChannel(w, target, []);
    await db()
      .update(externalThreadLinks)
      .set({ threadKey: "__channel__" })
      .where(eq(externalThreadLinks.topicId, target));
    await connect(w.ids.topic, target);
    const task = await sender();
    const accepted = JSON.parse((await send(task, { topic_id: target, text: "Version one" })).content as string);
    const [out] = await db().select().from(outboundMessages).where(eq(outboundMessages.messageId, accepted.message_id));
    await db()
      .update(outboundMessages)
      .set({ status: "sent", externalTs: "170000.123" })
      .where(eq(outboundMessages.id, out.id));
    expect(await sentMessageRoot(db(), target, channel.connectionId, out.conversationExternalId, "170000.123")).toBe(
      accepted.message_id,
    );
    await send(task, { topic_id: target, text: "More detail", thread: accepted.message_id }, "send-2");
    const rows = await db()
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.connectionId, channel.connectionId));
    expect(rows.find((r) => r.id !== out.id)?.threadKey).toBe("170000.123");
  });

  it("blocks an already queued external publication after its topic link is removed", async () => {
    const target = await newTopic("External destination");
    const channel = await linkChannel(w, target, []);
    const links = await connect(w.ids.topic, target);
    const task = await sender();
    const accepted = JSON.parse((await send(task, { topic_id: target, text: "Queued result" })).content as string);
    const [out] = await db().select().from(outboundMessages).where(eq(outboundMessages.messageId, accepted.message_id));
    await w.api("DELETE", `/api/topics/${w.ids.topic}/links/${links[0].id}`, { token: w.alice });
    await db().update(connections).set({ status: "active" }).where(eq(connections.id, channel.connectionId));
    await db().update(outboundMessages).set({ status: "pending" }).where(eq(outboundMessages.id, out.id));
    expect(await deliverOne(out.id)).toBe(false);
    const [blocked] = await db().select().from(outboundMessages).where(eq(outboundMessages.id, out.id));
    expect(blocked.status).toBe("blocked");
    expect(blocked.lastError).toMatch(/topic link/);
  });

  // --- review fixes -----------------------------------------------------------------------------------------

  it("gives a person's reply to every task that may be waiting for it; the model judges whether it answers", async () => {
    const asking = async (question: string) => {
      const task = await sender();
      return transaction(async (tx) => {
        await appendStep(tx, task, "assistant", {
          content: question,
          tool_calls: [{ id: `ask-${task.id}`, name: "ask_human", arguments: {} }],
        });
        return setStatus(tx, task, "waiting_human", "waiting for alice", {
          wait: { type: "human", user_ids: [w.ids.alice], tool_call_id: `ask-${task.id}` },
        });
      });
    };
    const first = await asking("Which database?");
    const second = await asking("Which region?");
    // a top-level reply, not threaded under either question
    await w.post(w.alice, w.ids.topic, "@dev postgres");
    for (const task of [first, second]) {
      const [row] = await db().select().from(tasks).where(eq(tasks.id, task.id));
      expect(row.status).not.toBe("waiting_human");
      const answer = (await loadTranscript(db(), row)).find((m) => m.role === "tool");
      expect(answer?.content).toContain("alice replied: @dev postgres");
      expect(answer?.content).toContain("this reply may answer one of them");
    }
  });

  it("keeps the run's requester for a task it starts, whatever message the model points at", async () => {
    const bob = await w.post(w.bob, w.ids.topic, "a plain remark");
    let started = "";
    w.scripts.dev = (m, turn) => {
      if (lastToolResult(m).startsWith("started task")) started = lastToolResult(m);
      if (JSON.stringify(m).includes("Your task")) return reply("done");
      return turn === 0
        ? reply("", [call("start_task", { task: "side job", source_message_id: bob.id })])
        : reply("ok");
    };
    await w.post(w.alice, w.ids.topic, "@dev please split this off");
    await w.drain();
    expect(started).toContain("started task");
    const [child] = await db()
      .select()
      .from(tasks)
      .where(and(eq(tasks.topicId, w.ids.topic), eq(tasks.kind, "task")));
    expect(child.sourceMessageId).toBe(bob.id);
    expect(child.requesterUserId).toBe(w.ids.alice);
  });

  it("lets a conversation continue only the tasks it started", async () => {
    // a task the console started for dev, reporting to no conversation
    const other = await sender();
    await transaction((tx) => setStatus(tx, other, "completed", null, { result: "v1" }));
    let refused = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("continue_task", { task_id: other.id, instruction: "more" })]);
      refused = lastToolResult(m);
      return reply("ok");
    };
    await w.post(w.alice, w.ids.topic, "@dev continue that task");
    await w.drain();
    expect(refused).toContain("your conversation here started");
    expect((await w.task(other.id)).revision).toBe(1);
  });

  it("reports what this iteration said, not an earlier one", async () => {
    const task = await sender();
    const topic = await transaction((tx) => getTopic(tx, w.ids.topic));
    await transaction(async (tx) => {
      await saveMessage(tx, topic, "role", w.ids.dev, "Version one", { taskId: task.id, mentions: [] });
      await setStatus(tx, task, "completed", null, { result: "Version one" });
    });
    w.scripts.dev = () => reply("");
    const r = await w.api("POST", `/api/tasks/${task.id}/control`, {
      token: w.alice,
      json: { action: "continue", note: "Add caching", expected_revision: 1, idempotency_key: "iteration-2" },
    });
    expect(r.status, r.raw).toBe(200);
    await w.drain();
    const done = await w.task(task.id);
    expect(done.revision).toBe(2);
    expect(done.iterations.at(-1).result).not.toBe("Version one");
  });

  it("takes instructions for work under way as before: one audit entry, in an archived topic too", async () => {
    const task = await sender();
    await db().update(tasks).set({ status: "waiting_resource" }).where(eq(tasks.id, task.id));
    const r = await w.api("POST", `/api/tasks/${task.id}/control`, {
      token: w.alice,
      json: { action: "instruct", note: "use staging" },
    });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.revision).toBe(1);
    const inputs = await db().select().from(taskInputs).where(eq(taskInputs.taskId, task.id));
    expect(inputs.map((i) => i.content)).toEqual(["use staging"]);
    const logged = await db()
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.taskId, task.id), eq(auditLogs.action, "task.instruct")));
    expect(logged).toHaveLength(1);
    // the topic archived meanwhile: still accepted
    await db().update(topicsTable).set({ status: "archived" }).where(eq(topicsTable.id, w.ids.topic));
    const again = await w.api("POST", `/api/tasks/${task.id}/control`, {
      token: w.alice,
      json: { action: "instruct", note: "and use eu-west" },
    });
    expect(again.status, again.raw).toBe(200);
  });
});

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStatus } from "../src/agent/control.js";
import { inject } from "../src/agent/conversation.js";
import { createTask, saveMessage, sessionFor } from "../src/agent/dispatch.js";
import type { ChatMessage } from "../src/agent/llm.js";
import { stillAllowed } from "../src/agent/revocation.js";
import { TOOLS, toolsFor } from "../src/agent/tools.js";
import { appendStep, loadTranscript } from "../src/agent/transcript.js";
import { db, transaction } from "../src/db/client.js";
import {
  agentSessions,
  auditLogs,
  connections,
  externalThreadLinks,
  messageRoutes,
  messages,
  outboundMessages,
  roles,
  taskInputs,
  tasks,
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
import { getOrCreatePairTopic, getRole, getTopic } from "../src/services/topics.js";
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

/** Whether a role's model call is for its work in the topic titled ``title`` (the system prompt names it). */
const inTopic = (m: ChatMessage[], title: string) => String(m[0]?.content ?? "").includes(`Topic: «${title}»`);

// Tests use the real API, database and task engine. External transport and model responses use the project's harness.
describe("group topics an AI employee takes part in, shared sources and task iterations", () => {
  let w: World;
  beforeEach(async () => {
    w = await buildWorld();
  });
  afterEach(async () => {
    await w?.close();
  });
  const newTopic = async (name = "Work", token?: string, roleIds?: string[]) => {
    const r = await w.api("POST", "/api/topics", {
      token: token ?? w.alice,
      json: { title: name, role_ids: roleIds ?? [w.ids.dev] },
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
  const dmWith = async (roleId: string) =>
    (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: roleId } })).body.id as string;
  /** Running work of ``roleId`` (default @dev) in ``topicId``, asked by alice. */
  const sender = async (topicId = w.ids.topic, roleId = w.ids.dev) =>
    transaction(async (tx) => {
      const topic = await getTopic(tx, topicId);
      const role = (await getRole(tx, roleId))!;
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
  const tool = async (name: string, task: typeof tasks.$inferSelect, args: Record<string, unknown>, callId = "c-1") =>
    (
      await TOOLS.get(name)!.handler(
        {
          taskId: task.id,
          topicId: task.topicId,
          roleId: task.ownerRoleId,
          toolCallId: callId,
          gateway: w.witden.runtime.gateway!,
          db,
        },
        args,
      )
    ).content as string;
  const send = (task: typeof tasks.$inferSelect, args: Record<string, unknown>, callId = "send-1") =>
    tool("send_message", task, args, callId);
  const mention = (task: typeof tasks.$inferSelect, args: Record<string, unknown>, callId = "mention-1") =>
    tool("message_role", task, args, callId);
  const history = (task: typeof tasks.$inferSelect, args: Record<string, unknown>) => tool("topic_history", task, args);
  const status = (task: typeof tasks.$inferSelect, args: Record<string, unknown>) => tool("topic_status", task, args);
  const leave = (topicId: string, roleId: string) =>
    db()
      .update(topicParticipants)
      .set({ removedAt: new Date() })
      .where(and(eq(topicParticipants.topicId, topicId), eq(topicParticipants.participantId, roleId)));
  const contents = async (topicId: string) => (await w.messages(topicId)).map((m: any) => m.content);

  // --- the group topics an AI employee takes part in ---------------------------------------------------------

  it("lists the group topics an AI employee takes part in, with their people and AI employees, never private ones", async () => {
    const design = await newTopic("Design", w.alice, [w.ids.dev, w.ids.analyst]);
    const partners = await externalTopic("Partners");
    const dm = await dmWith(w.ids.dev);
    const pair = await transaction(async (tx) =>
      getOrCreatePairTopic(tx, (await getRole(tx, w.ids.dev))!, (await getRole(tx, w.ids.test))!),
    );
    const archived = await newTopic("Old project");
    await db().update(topicsTable).set({ status: "archived" }).where(eq(topicsTable.id, archived));
    const left = await newTopic("Left behind");
    await leave(left, w.ids.dev);
    const notIn = await newTopic("Ops", w.alice, [w.ids.test]);
    const here = await sender();
    const listed = await tool("my_topics", here, {});
    expect(listed).toContain("Group topics you take part in (3)");
    for (const id of [w.ids.topic, design, partners]) expect(listed).toContain(id);
    for (const id of [dm, pair.id, archived, left, notIn]) expect(listed).not.toContain(id);
    expect(listed).toContain(`${w.ids.topic} «Release 1.0» (this topic), in the witden console`);
    expect(listed).toContain("People: alice, bob. Other AI employees: @test (Test), @analyst (Analyst).");
    expect(listed).toContain(`${partners} «Partners», in Slack #partners`);
    expect(listed).toContain("DMs and direct conversations between AI employees are private");
    // from a DM it lists the same groups
    expect(await tool("my_topics", await sender(dm), {})).toContain("You are now in a private DM.");
    // a system administrator works only where it is
    const [admin] = await db().select().from(roles).where(eq(roles.systemAdmin, true));
    const offered = toolsFor({ tools: ["config"], system_admin: true }).map((t) => t.name);
    expect(offered).not.toContain("my_topics");
    expect(offered).not.toContain("topic_status");
    await expect(history(await sender(w.ids.topic, admin.id), { topic_id: design })).rejects.toThrow(
      /system administrator works only/,
    );
  });

  it("reads another group topic it takes part in; not one it is not in, a DM, a pair or an archived topic", async () => {
    const design = await newTopic("Design");
    await transaction(async (tx) => {
      const topic = await getTopic(tx, design);
      await saveMessage(tx, topic, "user", w.ids.alice, "the logo stays blue", { mentions: [] });
      await saveMessage(tx, topic, "user", w.ids.alice, "fonts are still open", { mentions: [] });
    });
    const here = await sender();
    const read = await history(here, { topic_id: design });
    expect(read).toContain(`2 matching message(s) in topic ${design} «Design»`);
    expect(read).toContain("alice: the logo stays blue");
    const found = await history(here, { topic_id: design, query: "fonts" });
    expect(found).toContain("1 matching message(s)");
    expect(found).not.toContain("logo");
    // without topic_id: this topic, as before
    expect(await history(here, {})).toContain("matching message(s) in this topic");
    const notIn = await newTopic("Ops", w.alice, [w.ids.test]);
    await expect(history(here, { topic_id: notIn })).rejects.toThrow(/do not take part in topic/);
    await expect(history(here, { topic_id: "top_unknown" })).rejects.toThrow(/do not take part in topic/);
    await expect(history(here, { topic_id: await dmWith(w.ids.dev) })).rejects.toThrow(/private DM/);
    const pair = await transaction(async (tx) =>
      getOrCreatePairTopic(tx, (await getRole(tx, w.ids.dev))!, (await getRole(tx, w.ids.test))!),
    );
    await expect(history(here, { topic_id: pair.id })).rejects.toThrow(/direct conversation between two AI/);
    await db().update(topicsTable).set({ status: "archived" }).where(eq(topicsTable.id, design));
    await expect(history(here, { topic_id: design })).rejects.toThrow(/archived/);
    // nor can it post to them
    await expect(send(here, { topic_id: pair.id, text: "hello" })).rejects.toThrow(/direct conversation/);
    await expect(send(here, { topic_id: notIn, text: "hello" })).rejects.toThrow(/do not take part/);
  });

  it("an external conversation's AI employee asks a colleague of an internal topic it is in; the answer comes to its conversation there", async () => {
    const group = await externalTopic("Partners");
    // Work from a conversation goes on while its connection is active (tests deliver nothing to Slack).
    await db().update(connections).set({ status: "active" });
    // Console-only tools are stripped from work that outside input started.
    await w.api("PATCH", `/api/roles/${w.ids.test}`, {
      token: w.adminToken,
      json: { allowed_tools: ["shell", "profile"] },
    });
    let prompt = "";
    let offered: string[] = [];
    let asked = "";
    let relayed = "";
    w.scripts.dev = (m, turn, tools) => {
      if (inTopic(m, "Partners")) {
        prompt ||= String(m[0].content);
        offered = (tools ?? []).map((t) => t.name);
        return turn === 0
          ? reply("", [
              call("message_role", { topic_id: w.ids.topic, role: "test", message: "please review the release" }),
            ])
          : reply("asked the team");
      }
      // Its conversation in the internal topic: the colleague's answer arrived there.
      relayed = lastUser(m);
      return turn === 0
        ? reply("", [call("send_message", { topic_id: group, text: "review done: all good" })])
        : reply("");
    };
    w.scripts.test = (m) => {
      asked = lastUser(m);
      return reply("reviewed: all good");
    };
    w.scripts.analyst = () => reply("not asked");
    await w.post(w.alice, group, "@dev can the team review the release?");
    await w.drain();
    expect(prompt).toContain("my_topics lists them");
    expect(offered).toEqual(expect.arrayContaining(["my_topics", "topic_status", "topic_history", "message_role"]));
    expect(offered).not.toContain("delegate_task");
    // posted in the internal topic as @dev, and answered there by @test only
    const inside = await w.messages(w.ids.topic);
    const request = inside.find((m: any) => m.content === "@test please review the release");
    expect(request).toMatchObject({ author_id: w.ids.dev, topic_delivery: { source_topic_id: group } });
    expect(inside.map((m: any) => m.content)).toContain("reviewed: all good");
    expect(asked).toContain("→ you: @test please review the release");
    expect(asked).toContain(`[Sent from topic ${group} «Partners»`);
    const ran = await db().select().from(tasks).where(eq(tasks.topicId, w.ids.topic));
    expect(ran.map((t) => t.ownerRoleId).sort()).toEqual([w.ids.dev, w.ids.test].sort());
    // the answer reached @dev's conversation in the internal topic, which brought it back to the conversation
    expect(relayed).toContain("→ you: reviewed: all good");
    expect(relayed).toContain(`You sent this from your conversation in topic ${group} «Partners»`);
    expect(await contents(group)).toEqual(
      expect.arrayContaining(["@dev can the team review the release?", "asked the team", "review done: all good"]),
    );
    expect(inside.filter((m: any) => m.author_id === w.ids.dev).map((m: any) => m.content)).toEqual([
      "@test please review the release",
    ]);
    expect((await w.api("GET", "/api/approvals", { token: w.bob })).body).toEqual([]);
    // Every hop counts as an automatic round, and the outside request's limits travel with it.
    const testRun = ran.find((t) => t.ownerRoleId === w.ids.test)!;
    const devRun = ran.find((t) => t.ownerRoleId === w.ids.dev)!;
    expect([request.round, testRun.round, devRun.round]).toEqual([1, 1, 2]);
    const [back] = await db().select().from(messages).where(eq(messages.content, "review done: all good"));
    expect(back.round).toBe(3);
    for (const work of [testRun, devRun]) {
      expect(work.envelope).toMatchObject({ outside: true, untrusted_input: true });
      expect(work.envelope.external_topic).toBeUndefined();
      expect(work.envelope.topic_routes?.[0]?.source_topic_id).toBe(group);
      expect(await roleMemoryRefusal(db(), work)).toMatch(/role memory/);
    }
    expect(testRun.envelope.tools).toEqual(["shell"]);
  });

  it("a plain message to another console topic is posted as the AI employee's own and starts no work there", async () => {
    await w.api("PATCH", `/api/topics/${w.ids.topic}`, { token: w.alice, json: { response_mode: "auto" } });
    const group = await externalTopic();
    const rep = await sender(group);
    const out = JSON.parse(await send(rep, { topic_id: w.ids.topic, text: "FYI: a customer reported a crash" }));
    expect(out).toMatchObject({ topic_id: w.ids.topic, status: "posted" });
    await w.drain();
    const [posted] = await db().select().from(messages).where(eq(messages.id, out.message_id));
    expect(posted).toMatchObject({ authorType: "role", authorId: w.ids.dev, source: "topic", round: 1 });
    expect(posted.externalRef?.topic_delivery).toMatchObject({ source_topic_id: group, sender_role_id: w.ids.dev });
    expect(await db().select().from(tasks).where(eq(tasks.topicId, w.ids.topic))).toEqual([]);
    expect(await db().select().from(messageRoutes)).toEqual([]);
    // the person it was sent for is not made a member there
    const alice = await db()
      .select()
      .from(topicParticipants)
      .where(and(eq(topicParticipants.topicId, w.ids.topic), eq(topicParticipants.participantId, w.ids.alice)));
    expect(alice).toHaveLength(1); // alice created the topic; nobody was added
    expect(await db().select().from(topicParticipants).where(eq(topicParticipants.topicId, w.ids.topic))).toHaveLength(
      5,
    );
  });

  it("publishes to an external conversation only as the AI employee working there; no agent runs there", async () => {
    const target = await externalTopic("Maintainers");
    const task = await sender();
    const out = JSON.parse(await send(task, { topic_id: target, text: "Version one is ready" }));
    expect(out.status).toBe("queued_for_external_delivery");
    expect(await db().select().from(tasks).where(eq(tasks.topicId, target))).toHaveLength(0);
    const outgoing = await db().select().from(outboundMessages).where(eq(outboundMessages.messageId, out.message_id));
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].status).toBe("blocked"); // Test connection is deliberately paused; no real Slack request.
    // @test is not the AI employee there; nobody but @dev can be @-mentioned there
    await expect(send(await sender(w.ids.topic, w.ids.test), { topic_id: target, text: "hi" })).rejects.toThrow(
      /do not take part/,
    );
    await expect(mention(task, { topic_id: target, role: "dev", message: "hi" })).rejects.toThrow(
      /only AI employee there/,
    );
    // in the conversation itself, @dev has nobody to @
    await expect(mention(await sender(target), { role: "test", message: "hi" })).rejects.toThrow(
      /only AI employee in this conversation/,
    );
  });

  it("in an external conversation the AI employee taking part is the one handling it, chosen or by default", async () => {
    const group = await externalTopic("Partners");
    const chosen = await w.api("PATCH", `/api/topics/${group}`, {
      token: w.alice,
      json: { handler_role_id: w.ids.test },
    });
    expect(chosen.status, chosen.raw).toBe(200);
    expect(await tool("my_topics", await sender(w.ids.topic, w.ids.test), {})).toContain(`${group} «Partners»`);
    expect(await tool("my_topics", await sender(), {})).not.toContain(group);
    await expect(history(await sender(), { topic_id: group })).rejects.toThrow(/do not take part in topic/);
    const out = JSON.parse(await send(await sender(w.ids.topic, w.ids.test), { topic_id: group, text: "noted" }));
    expect(out.status).toBe("queued_for_external_delivery");
  });

  it("@-mentions only an AI employee taking part in the other topic, and posts nothing otherwise", async () => {
    const design = await newTopic("Design");
    const task = await sender();
    await expect(mention(task, { topic_id: design, role: "test", message: "please look" })).rejects.toThrow(
      /@test is not in topic/,
    );
    await expect(mention(task, { topic_id: design, role: "dev", message: "please look" })).rejects.toThrow(
      /that is you/,
    );
    expect(await db().select().from(messages).where(eq(messages.topicId, design))).toEqual([]);
  });

  it("every message to another topic and every @ there counts as an automatic round", async () => {
    const design = await newTopic("Design", w.alice, [w.ids.dev, w.ids.test]);
    const task = await sender();
    await db().update(tasks).set({ round: w.settings.maxAutoRounds }).where(eq(tasks.id, task.id));
    const [late] = await db().select().from(tasks).where(eq(tasks.id, task.id));
    await expect(send(late, { topic_id: design, text: "more" })).rejects.toThrow(/round limit/);
    await expect(mention(late, { topic_id: design, role: "test", message: "more" })).rejects.toThrow(/round limit/);
    expect(await db().select().from(messages).where(eq(messages.topicId, design))).toEqual([]);
    await db().update(tasks).set({ round: 2 }).where(eq(tasks.id, task.id));
    const [early] = await db().select().from(tasks).where(eq(tasks.id, task.id));
    await mention(early, { topic_id: design, role: "test", message: "please look" }, "mention-2");
    const [posted] = await db().select().from(messages).where(eq(messages.topicId, design));
    expect(posted.round).toBe(3);
    const [run] = await db()
      .select()
      .from(tasks)
      .where(and(eq(tasks.topicId, design), eq(tasks.ownerRoleId, w.ids.test)));
    expect(run.round).toBe(3);
  });

  it("from a DM it may read and post to its group topics; a pair topic sends nothing elsewhere", async () => {
    const dm = await dmWith(w.ids.dev);
    const fromDm = await sender(dm);
    expect(JSON.parse(await send(fromDm, { topic_id: w.ids.topic, text: "alice is running late" })).status).toBe(
      "posted",
    );
    expect(await contents(w.ids.topic)).toContain("alice is running late");
    const pair = await transaction(async (tx) =>
      getOrCreatePairTopic(tx, (await getRole(tx, w.ids.dev))!, (await getRole(tx, w.ids.test))!),
    );
    await expect(send(await sender(pair.id), { topic_id: w.ids.topic, text: "hi" })).rejects.toThrow(
      /direct conversation between two AI employees sends nothing/,
    );
  });

  it("checks on a group topic it takes part in: work in progress, what it waits for and results, not configuration work", async () => {
    const group = await externalTopic();
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
    await work(w.ids.topic, w.ids.analyst, "Prepare the release notes\nwith every detail", {
      status: "running",
      progress: "drafting the changelog",
    });
    await work(w.ids.topic, w.ids.test, "Review the build", { status: "waiting_human", statusReason: "asked alice" });
    await work(w.ids.topic, w.ids.test, "Run the regression suite", {
      status: "completed",
      finishedAt: new Date(Date.now() - 60_000),
      result: `All 120 tests passed. ${"More detail. ".repeat(40)}TAIL-MARKER`,
    });
    // A key the clip would cut so that it is no longer recognisable as one.
    const key = "sk-A1b2C3d4E5f6G7h8I9j0K1l2M3";
    await work(w.ids.topic, w.ids.test, "Deploy to staging", {
      status: "completed",
      finishedAt: new Date(),
      result: `${"x".repeat(388)} ${key} done`,
    });
    const [admin] = await db().select().from(roles).where(eq(roles.systemAdmin, true));
    await work(w.ids.topic, admin.id, "Rotate the model provider key", { status: "running" });
    const rep = await sender(group);
    const checked = await status(rep, { topic_id: w.ids.topic });
    expect(checked).toContain(`Topic ${w.ids.topic} «Release 1.0»`);
    expect(checked).toContain("People: alice, bob. AI employees: @dev (Dev), @test (Test), @analyst (Analyst).");
    expect(checked).toContain("Work in progress: 2 (1 waiting)");
    expect(checked).toContain("Prepare the release notes");
    expect(checked).toContain("progress: drafting the changelog");
    expect(checked).toMatch(/task of @test, waiting_human \(waits for a person's answer: asked alice\)/);
    expect(checked).toContain("Run the regression suite");
    expect(checked).toContain("result: All 120 tests passed.");
    expect(checked).not.toContain("TAIL-MARKER");
    expect(checked).toContain("Deploy to staging");
    expect(checked).not.toContain("sk-A1b2");
    expect(checked).toContain("[REDAC");
    expect(checked).not.toContain("Rotate the model provider key");
    expect(await status(rep, { topic_id: group })).toContain("(this topic)");
    const other = await newTopic("Other work", w.alice, [w.ids.test]);
    await expect(status(rep, { topic_id: other })).rejects.toThrow(/do not take part in topic/);
    await expect(status(rep, { topic_id: await dmWith(w.ids.dev) })).rejects.toThrow(/private DM/);
  });

  it("in an internal topic reached from an external conversation, its AI employees @ and delegate to each other, keeping its limits", async () => {
    const group = await externalTopic();
    await db().update(connections).set({ status: "active" });
    await w.api("POST", "/api/roles", {
      token: w.adminToken,
      json: { name: "Outsider", handle: "outsider", model_config_id: w.ids.model, instance_id: w.ids.instance },
    });
    let offered: string[] = [];
    let refused = "";
    w.scripts.dev = (m, turn) => {
      if (lastUser(m).includes("Delegated by @test")) return reply("build passed");
      if (!inTopic(m, "Partners")) return reply("noted");
      return turn === 0
        ? reply("", [
            call("message_role", { topic_id: w.ids.topic, role: "test", message: "please build and review it" }),
          ])
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
    expect(await contents(w.ids.topic)).toEqual(
      expect.arrayContaining(["@analyst please review", "reviewed", "build passed"]),
    );
    expect(refused).toContain("@outsider is not in this topic");
    expect((await w.api("GET", "/api/approvals", { token: w.bob })).body).toEqual([]);
    // The colleague's run and the delegated task keep the limits of the outside request.
    const inTopicWork = await db().select().from(tasks).where(eq(tasks.topicId, w.ids.topic));
    const analystRun = inTopicWork.find((t) => t.ownerRoleId === w.ids.analyst && t.kind === "conversation")!;
    const devTask = inTopicWork.find((t) => t.ownerRoleId === w.ids.dev && t.kind === "task")!;
    for (const work of [analystRun, devTask]) {
      expect(work.envelope).toMatchObject({ outside: true, untrusted_input: true });
      expect(work.envelope.external_topic).toBeUndefined();
      expect(work.envelope.topic_routes?.[0]?.source_topic_id).toBe(group);
      expect(await roleMemoryRefusal(db(), work)).toMatch(/role memory/);
    }
  });

  it("work a message from another topic started ends when its sender leaves either topic; conversations go on", async () => {
    const group = await externalTopic();
    await db().update(connections).set({ status: "active" });
    const rep = await sender(group);
    await mention(rep, { topic_id: w.ids.topic, role: "test", message: "please build it" });
    const [testRun] = await db()
      .select()
      .from(tasks)
      .where(and(eq(tasks.topicId, w.ids.topic), eq(tasks.ownerRoleId, w.ids.test)));
    // A task it delegates inherits where the request came from (buildEnvelope).
    const child = await transaction(async (tx) =>
      createTask(tx, {
        topic: await getTopic(tx, w.ids.topic),
        role: (await getRole(tx, w.ids.analyst))!,
        requesterUserId: testRun.requesterUserId,
        requesterRoleId: w.ids.test,
        instruction: "build it",
        parent: testRun,
      }),
    );
    expect(child.envelope.topic_routes?.[0]?.source_topic_id).toBe(group);
    // the person it was sent for is not in this topic: that is no reason to stop
    expect(await stillAllowed(db(), child)).toBeNull();
    expect(await stillAllowed(db(), testRun)).toBeNull();
    await leave(w.ids.topic, w.ids.dev);
    expect(await stillAllowed(db(), child)).toMatch(/@dev, who sent it, no longer takes part in this topic/);
    expect(await stillAllowed(db(), testRun)).toBeNull();
    await db()
      .update(topicParticipants)
      .set({ removedAt: null })
      .where(and(eq(topicParticipants.topicId, w.ids.topic), eq(topicParticipants.participantId, w.ids.dev)));
    expect(await stillAllowed(db(), child)).toBeNull();
    await leave(group, w.ids.dev);
    expect(await stillAllowed(db(), child)).toMatch(/no longer takes part in the topic it came from/);
  });

  it("deduplicates retries of one cross-topic tool call", async () => {
    const design = await newTopic("Design", w.alice, [w.ids.dev, w.ids.test]);
    const task = await sender();
    await mention(task, { topic_id: design, role: "test", message: "Implement login" });
    const retry = await mention(task, { topic_id: design, role: "test", message: "Implement login" });
    expect(retry).toContain("already posted");
    expect(await db().select().from(messages).where(eq(messages.topicId, design))).toHaveLength(1);
    expect(await db().select().from(tasks).where(eq(tasks.topicId, design))).toHaveLength(1);
  });

  it("an @ from another topic its AI employee did not answer gets no later turn's words as an answer", async () => {
    const design = await newTopic("Design", w.alice, [w.ids.dev, w.ids.test]);
    await mention(await sender(), { topic_id: design, role: "test", message: "please look" });
    const [run] = await db()
      .select()
      .from(tasks)
      .where(and(eq(tasks.topicId, design), eq(tasks.ownerRoleId, w.ids.test)));
    await transaction((tx) => setStatus(tx, run, "cancelled", "stopped by a person"));
    w.scripts.test = () => reply("about something else");
    w.scripts.dev = () => reply("not asked");
    await w.post(w.alice, design, "@test something else");
    await w.drain();
    expect(await contents(design)).toContain("about something else");
    const devWork = await db()
      .select()
      .from(tasks)
      .where(and(eq(tasks.topicId, design), eq(tasks.ownerRoleId, w.ids.dev)));
    expect(devWork).toEqual([]);
  });

  it("validates threads in the destination, not the source topic", async () => {
    const design = await newTopic("Design");
    const task = await sender();
    await expect(send(task, { topic_id: design, text: "Update", thread: task.sourceMessageId })).rejects.toThrow(
      new RegExp(`no message ${task.sourceMessageId} in topic ${design}`),
    );
    expect(await db().select().from(messages).where(eq(messages.topicId, design))).toHaveLength(0);
  });

  it("does not enroll the requester as a member of the destination", async () => {
    const group = await externalTopic();
    const target = await newTopic("Bob's work", w.bob, [w.ids.dev, w.ids.test]);
    await mention(await sender(group), { topic_id: target, role: "test", message: "Implement login" });
    const [run] = await db().select().from(tasks).where(eq(tasks.topicId, target));
    expect(run).toMatchObject({ ownerRoleId: w.ids.test, requesterUserId: w.ids.alice, requesterRoleId: w.ids.dev });
    expect(await stillAllowed(db(), run)).toBeNull();
    expect(
      await db()
        .select()
        .from(topicParticipants)
        .where(and(eq(topicParticipants.topicId, target), eq(topicParticipants.participantId, w.ids.alice))),
    ).toHaveLength(0);
  });

  it("blocks a queued external publication once its AI employee no longer takes part in the conversation", async () => {
    const target = await newTopic("External destination");
    const channel = await linkChannel(w, target, []);
    const task = await sender();
    const accepted = JSON.parse(await send(task, { topic_id: target, text: "Queued result" }));
    const [out] = await db().select().from(outboundMessages).where(eq(outboundMessages.messageId, accepted.message_id));
    await leave(target, w.ids.dev);
    await db().update(connections).set({ status: "active" }).where(eq(connections.id, channel.connectionId));
    await db().update(outboundMessages).set({ status: "pending" }).where(eq(outboundMessages.id, out.id));
    expect(await deliverOne(out.id)).toBe(false);
    const [blocked] = await db().select().from(outboundMessages).where(eq(outboundMessages.id, out.id));
    expect(blocked.status).toBe("blocked");
    expect(blocked.lastError).toMatch(/no longer takes part/);
  });

  it("from a DM, work goes to no other role, even one the person has a DM with", async () => {
    const dm = await dmWith(w.ids.dev);
    await dmWith(w.ids.test);
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

  it("delegates to roles of the topic without a permission; a role outside it is refused before any approval", async () => {
    const outsider = (
      await w.api("POST", "/api/roles", {
        token: w.adminToken,
        json: { name: "Outsider", handle: "outsider", model_config_id: w.ids.model, instance_id: w.ids.instance },
      })
    ).body.id as string;
    // alice has a DM with it: that is no place for work delegated from this topic either.
    await dmWith(outsider);
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

  // --- shared sources and task iterations --------------------------------------------------------------------

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
    const task = await sender();
    const accepted = JSON.parse(await send(task, { topic_id: target, text: "Version one" }));
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

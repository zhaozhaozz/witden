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
import { getRole, getTopic } from "../src/services/topics.js";
import { processTriggerEvents } from "../src/services/triggers.js";
import { acceptSourceWebhook } from "../src/services/webhook-sources.js";
import { call, lastToolResult, reply } from "./support/harness.js";
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
  const connect = async (a: string, b: string) => {
    const r = await w.api("POST", `/api/topics/${a}/links`, { token: w.alice, json: { topic_id: b } });
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
      b = await newTopic(),
      c = await newTopic("Other");
    const task = await sender();
    await expect(send(task, { topic_id: b, text: "Work" })).rejects.toThrow(/linked/);
    await connect(a, b);
    await connect(b, a);
    await connect(b, c);
    expect(await db().select().from(topicLinks)).toHaveLength(2);
    await expect(send(task, { topic_id: c, text: "Work" })).rejects.toThrow(/linked/);
  });

  it("dispatches the same role in another topic without creating a second source execution", async () => {
    const target = await newTopic();
    await connect(w.ids.topic, target);
    const task = await sender();
    const r = JSON.parse((await send(task, { topic_id: target, text: "Implement login" })).content as string);
    expect(r.status).toBe("queued_for_agent");
    const runs = await db().select().from(tasks).where(eq(tasks.topicId, target));
    expect(runs).toHaveLength(1);
    expect(runs[0].ownerRoleId).toBe(w.ids.dev);
    expect(runs[0].requesterRoleId).toBe(w.ids.dev);
    const [stored] = await db().select().from(messages).where(eq(messages.id, r.message_id));
    expect(stored.externalRef?.topic_delivery.source_topic_id).toBe(w.ids.topic);
    expect(stored.externalRef?.topic_delivery.origin.requester_user_id).toBe(w.ids.alice);
  });

  it("deduplicates retries of one cross-topic tool call", async () => {
    const target = await newTopic();
    await connect(w.ids.topic, target);
    const task = await sender();
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
    const target = await newTopic();
    await connect(w.ids.topic, target);
    const task = await sender();
    await expect(send(task, { topic_id: target, text: "Update", thread: task.sourceMessageId })).rejects.toThrow(
      /selected topic/,
    );
    expect(await db().select().from(messages).where(eq(messages.topicId, target))).toHaveLength(0);
  });

  it("does not enroll the requester as a reader of an internal destination", async () => {
    const target = await newTopic("Bob's work", w.bob);
    await connect(w.ids.topic, target);
    const task = await sender();
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
    const target = await newTopic();
    const links = await connect(w.ids.topic, target);
    const task = await sender();
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
    await w.api("DELETE", `/api/topics/${w.ids.topic}/links/${links[0].id}`, { token: w.alice });
    // the receiving conversation goes on with other work; the linked message it had not read is gone
    expect(await stillAllowed(db(), run)).toBeNull();
    const [session] = await db().select().from(agentSessions).where(eq(agentSessions.id, run.sessionId!));
    expect(session.inbox.filter((i) => !i.done)).toEqual([]);
    const [ended] = await db().select().from(tasks).where(eq(tasks.id, linkedTask.id));
    expect(await stillAllowed(db(), ended)).toMatch(/link.*removed/);
  });

  it("requires explicit consent before linking a DM and never auto-forwards its history", async () => {
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    const refused = await w.api("POST", `/api/topics/${w.ids.topic}/links`, {
      token: w.alice,
      json: { topic_id: dm.id },
    });
    expect(refused.status).toBe(400);
    const accepted = await w.api("POST", `/api/topics/${w.ids.topic}/links`, {
      token: w.alice,
      json: { topic_id: dm.id, confirm_private: true },
    });
    expect(accepted.status).toBe(200);
    expect(await w.messages(dm.id)).toHaveLength(0);
  });

  it("receives one source receipt and independently filters two subscriptions", async () => {
    const other = await newTopic("Second work");
    const source = (
      await w.api("POST", "/api/webhook-sources", {
        token: w.alice,
        json: { name: "Bot platform", secret: SECRET, allowed_role_ids: [w.ids.dev] },
      })
    ).body;
    expect(source.token_hash).toBeUndefined();
    expect(JSON.stringify(source)).not.toContain(SECRET);
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
    const a = await acceptSourceWebhook(source.id, SECRET, rawRequest, "event-1");
    const b = await acceptSourceWebhook(source.id, SECRET, rawRequest, "event-1");
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
    const source = (
      await w.api("POST", "/api/webhook-sources", { token: w.alice, json: { name: "Source", secret: SECRET } })
    ).body;
    await w.api("POST", `/api/topics/${w.ids.topic}/triggers`, {
      token: w.alice,
      json: { name: "Rule", kind: "webhook", role_id: w.ids.dev, source_id: source.id },
    });
    await acceptSourceWebhook(source.id, SECRET, rawRequest, "disabled");
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
        json: { name: "Bot platform", secret: SECRET, allowed_role_ids: [w.ids.dev] },
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
    const first = await post(SECRET);
    expect(first.status, first.raw).toBe(202);
    expect(Object.keys(first.body).sort()).toEqual(["duplicate", "id"]);
    const again = await post(SECRET);
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
    expect((await post(SECRET)).status).toBe(202);
  });

  it("does not let a role replace a trigger's own secret with a shared source", async () => {
    const source = (
      await w.api("POST", "/api/webhook-sources", {
        token: w.alice,
        json: { name: "Bot platform", secret: SECRET, allowed_role_ids: [w.ids.dev] },
      })
    ).body;
    const own = (
      await w.api("POST", `/api/topics/${w.ids.topic}/triggers`, {
        token: w.alice,
        json: { name: "Own", kind: "webhook", role_id: w.ids.dev, secret: "an-own-secret-long-enough-for-this" },
      })
    ).body;
    const [dev] = await db().select().from(roles).where(eq(roles.id, w.ids.dev));
    await db()
      .update(roles)
      .set({ allowedTools: [...dev.allowedTools, "automation"] })
      .where(eq(roles.id, dev.id));
    const task = await sender();
    await expect(
      transaction((tx) =>
        manageAutomation(tx, task, { action: "update", id: own.id, config: { source_id: source.id } }),
      ),
    ).rejects.toThrow(/own secret/);
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
        json: { name: "Granted source", secret: SECRET, allowed_role_ids: [w.ids.dev] },
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
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.token_hash).toBeUndefined();
    expect((await db().select().from(topicTriggers).where(eq(topicTriggers.id, result.id)))[0].roleId).toBe(w.ids.dev);
    const paused: any = await transaction((tx) =>
      manageAutomation(tx, task, { action: "update", id: result.id, config: { enabled: false } }),
    );
    expect(paused.enabled).toBe(false);
    await expect(
      transaction((tx) => manageAutomation(tx, task, { action: "update", id: result.id, config: { secret: SECRET } })),
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

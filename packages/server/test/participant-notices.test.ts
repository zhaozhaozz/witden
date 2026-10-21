import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { messageOut, systemMessage } from "../src/agent/dispatch.js";
import { db, transaction } from "../src/db/client.js";
import { auditLogs, messages, roles, topics } from "../src/db/schema.js";
import { audit } from "../src/services/audit.js";
import { purgeMessage } from "../src/services/messages.js";
import { legacyParticipantChanges } from "../src/services/participant-notices.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

it("role joins and departures identify the role in live events and retain its snapshot after removal", async () => {
  const events: Record<string, any>[] = [];
  const unsubscribe = w.witden.runtime.bus.subscribe((e) => {
    if (e.type === "message.created") events.push(e.data);
  });
  try {
    const topic = (await w.api("POST", "/api/topics", { token: w.alice, json: { title: "Membership" } })).body;
    await db()
      .update(roles)
      .set({ color: "#567890", avatarUrl: "/api/avatars/test.png" })
      .where(eq(roles.id, w.ids.dev));
    const added = await w.api("POST", `/api/topics/${topic.id}/participants`, {
      token: w.alice,
      json: { type: "role", id: w.ids.dev },
    });
    expect(added.status).toBe(200);
    const [notice] = await w.messages(topic.id);
    expect(notice.participant_change).toMatchObject({
      action: "added",
      actor_name: "alice",
      role: { id: w.ids.dev, handle: "dev", color: "#567890", avatar_url: "/api/avatars/test.png" },
    });
    expect(notice.mentions).toEqual([]);
    expect(notice.content).toContain("@dev");
    await w.waitFor(() => Promise.resolve(events.find((e) => e.id === notice.id)));
    expect(events.find((e) => e.id === notice.id)?.participant_change).toEqual(notice.participant_change);
    const removed = await w.api("DELETE", `/api/topics/${topic.id}/participants/role/${w.ids.dev}`, { token: w.alice });
    expect(removed.status).toBe(200);
    expect(removed.body.participants.some((p: any) => p.id === w.ids.dev)).toBe(false);
    await db()
      .update(roles)
      .set({ name: "Renamed", handle: "renamed", color: "#111111" })
      .where(eq(roles.id, w.ids.dev));
    const notices = await w.messages(topic.id);
    expect(notices.map((m) => m.participant_change.action).sort()).toEqual(["added", "removed"]);
    expect(notices.every((m) => m.participant_change.role.handle === "dev")).toBe(true);
    expect(notices.every((m) => m.participant_change.role.color === "#567890")).toBe(true);
    const [row] = await db().select().from(messages).where(eq(messages.id, notice.id));
    await transaction((tx) => purgeMessage(tx, row));
    const [deleted] = await db().select().from(messages).where(eq(messages.id, notice.id));
    expect(messageOut(deleted).participant_change).toBeNull();
  } finally {
    unsubscribe();
  }
});

it("old role notices recover the matching audit identity without changing stored messages", async () => {
  const [topic] = await db().select().from(topics).where(eq(topics.id, w.ids.topic));
  const legacy = await transaction(async (tx) => {
    const added = await systemMessage(tx, topic, "alice added a role to the topic.");
    await audit(tx, "topic.participant_add", { topicId: topic.id, detail: { type: "role", id: w.ids.dev } });
    const removed = await systemMessage(tx, topic, "A role left the topic.");
    await audit(tx, "topic.participant_remove", { topicId: topic.id, detail: { type: "role", id: w.ids.test } });
    return [added, removed];
  });
  const response = await w.messages(topic.id);
  expect(response.find((m) => m.id === legacy[0].id)?.participant_change).toMatchObject({
    action: "added",
    actor_name: "alice",
    role: { id: w.ids.dev, handle: "dev" },
  });
  expect(response.find((m) => m.id === legacy[1].id)?.participant_change).toMatchObject({
    action: "removed",
    role: { id: w.ids.test, handle: "test" },
  });
  const [stored] = await db().select().from(messages).where(eq(messages.id, legacy[0].id));
  expect(stored.externalRef).toBeNull();
  expect(stored.content).toBe("alice added a role to the topic.");
});

it("legacy recovery leaves missing, ambiguous, deleted and human messages unlabelled, even across page boundaries", async () => {
  const [topic] = await db().select().from(topics).where(eq(topics.id, w.ids.topic));
  const duplicates = await transaction(async (tx) => {
    const first = await systemMessage(tx, topic, "A role left the topic.");
    const second = await systemMessage(tx, topic, "A role left the topic.");
    await audit(tx, "topic.participant_remove", { topicId: topic.id, detail: { type: "role", id: w.ids.dev } });
    return [first, second];
  });
  expect((await legacyParticipantChanges(db(), [duplicates[0]])).size).toBe(0);
  const ambiguous = await transaction(async (tx) => {
    const msg = await systemMessage(tx, topic, "alice added a role to the topic.");
    for (const id of [w.ids.dev, w.ids.test])
      await audit(tx, "topic.participant_add", { topicId: topic.id, detail: { type: "role", id } });
    return msg;
  });
  expect((await legacyParticipantChanges(db(), [ambiguous])).size).toBe(0);
  const missing = await transaction((tx) => systemMessage(tx, topic, "A role left the topic."));
  expect((await legacyParticipantChanges(db(), [missing])).size).toBe(0);
  await db()
    .insert(auditLogs)
    .values({
      id: "audit-other-topic",
      actorType: "user",
      action: "topic.participant_remove",
      topicId: "other-topic",
      createdAt: missing.createdAt,
      detail: { type: "role", id: w.ids.dev },
    });
  expect((await legacyParticipantChanges(db(), [missing])).size).toBe(0);
  expect(
    (
      await legacyParticipantChanges(db(), [
        { ...missing, deletedAt: new Date() },
        { ...missing, authorType: "user" },
      ])
    ).size,
  ).toBe(0);
});

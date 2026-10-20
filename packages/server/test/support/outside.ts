/**
 * People outside the console: a Slack workspace whose (private) channel mirrors a topic, and a knowledge space
 * a role may consult.
 */

import { and, eq, ne } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { newId } from "../../src/db/ids.js";
import { connections, externalConversations, externalThreadLinks, topicParticipants } from "../../src/db/schema.js";
import type { World } from "./world.js";

export interface Channel {
  connectionId: string;
  conversationId: string;
}

/**
 * Make ``topicId`` the topic of a private Slack channel whose members are ``members`` (Slack user ids). The
 * connection's bot stands for @dev, the only role working there: the topic's other roles leave it.
 */
export async function linkChannel(w: World, topicId: string, members: string[], name = "partners"): Promise<Channel> {
  const connectionId = newId("conn");
  await db()
    .insert(connections)
    .values({
      id: connectionId,
      platform: "slack",
      name: `slack-${connectionId}`,
      status: "paused",
      settings: { role_id: w.ids.dev },
    });
  const [conv] = await db()
    .insert(externalConversations)
    .values({
      id: newId("conv"),
      connectionId,
      externalId: `G${connectionId.slice(-6).toUpperCase()}`,
      kind: "private",
      name,
      memberIds: members,
      membersSyncedAt: new Date(),
    })
    .returning();
  await db()
    .insert(externalThreadLinks)
    .values({ id: newId("lnk"), connectionId, conversationId: conv.id, threadKey: "1.1", topicId });
  await db()
    .update(topicParticipants)
    .set({ removedAt: new Date() })
    .where(
      and(
        eq(topicParticipants.topicId, topicId),
        eq(topicParticipants.participantType, "role"),
        ne(topicParticipants.participantId, w.ids.dev),
      ),
    );
  return { connectionId, conversationId: conv.id };
}

/** A note in a knowledge space @dev may consult (recall): it may use it wherever it works. */
export async function teamNote(w: World, content: string): Promise<string> {
  const space = (await w.api("POST", "/api/knowledge-spaces", { token: w.adminToken, json: { name: "hr" } })).body;
  const note = await w.api("POST", "/api/memories", {
    token: w.adminToken,
    json: { scope: "team", space_id: space.id, title: content.slice(0, 40), content },
  });
  if (note.status >= 300) throw new Error(`note failed: ${note.raw}`);
  await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.adminToken, json: { knowledge_space_ids: [space.id] } });
  return space.id as string;
}

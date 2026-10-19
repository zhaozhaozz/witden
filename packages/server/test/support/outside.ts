/**
 * People outside the console: a Slack workspace whose (private) channel mirrors a topic, and a knowledge space
 * a role may consult.
 */
import { db } from "../../src/db/client.js";
import { newId } from "../../src/db/ids.js";
import { connections, externalConversations, externalThreadLinks } from "../../src/db/schema.js";
import type { World } from "./world.js";

export interface Channel {
  connectionId: string;
  conversationId: string;
}

/**
 * Mirror ``topicId`` into a private Slack channel whose members are ``members`` (Slack user ids). The
 * connection's bot stands for @dev (external conversations refuse work without a role); the console still
 * brings in any role.
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
  return { connectionId, conversationId: conv.id };
}

/** A note in a knowledge space @dev may consult (recall): it may use it wherever it works. */
export async function teamNote(w: World, content: string): Promise<string> {
  const space = (await w.api("POST", "/api/knowledge-spaces", { token: w.adminToken, json: { name: "hr" } })).body;
  const note = await w.api("POST", "/api/memories", {
    token: w.adminToken,
    json: { scope: "team", space_id: space.id, content },
  });
  if (note.status >= 300) throw new Error(`note failed: ${note.raw}`);
  await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.adminToken, json: { knowledge_space_ids: [space.id] } });
  return space.id as string;
}

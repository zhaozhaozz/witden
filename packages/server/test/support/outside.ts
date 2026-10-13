/**
 * People outside the console: a Slack workspace whose (private) channel mirrors a topic. Its members are the
 * audience the information-flow checks protect; console accounts read everything anyway.
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
 * Mirror ``topicId`` into a private Slack channel whose members are ``members`` (Slack user ids), with an
 * assignment rule letting the world's roles work there (external conversations refuse work without one).
 */
export async function linkChannel(w: World, topicId: string, members: string[], name = "partners"): Promise<Channel> {
  const connectionId = newId("conn");
  await db()
    .insert(connections)
    .values({ id: connectionId, platform: "slack", name: `slack-${connectionId}`, status: "paused" });
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
  const rule = await w.api("POST", "/api/rules", {
    token: w.adminToken,
    json: {
      name: `rule-${connectionId}`,
      match: { connection_id: connectionId },
      allow_role_ids: [w.ids.dev, w.ids.test, w.ids.analyst],
      default_role_id: w.ids.dev,
    },
  });
  if (rule.status !== 200) throw new Error(`rule: ${rule.raw}`);
  return { connectionId, conversationId: conv.id };
}

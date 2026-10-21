/**
 * The dispatcher on an ordinary chat model (agent/router.ts decides which kind is set). A chat model reads the
 * message with the topic goal and a few earlier messages, so a reply to a role's question can reach that role
 * without an @; it answers by calling ``choose_roles`` with none, one or several of the offered handles. Slower
 * and dearer per message than a System One decision model, and its choice comes without probabilities.
 */
import { and, desc, eq, isNull, lt, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type Message, messages, type Role, type Topic } from "../db/schema.js";
import { ModelError } from "../errors.js";
import type { ChatMessage, ChatModel, ToolSchema } from "./llm.js";
import { authorName } from "./tools.js";

/** Earlier messages given as context: enough for "yes, go ahead" to find its question, little enough to stay fast. */
const CONTEXT_MESSAGES = 6;
/** The start of the topic goal either kind of dispatcher reads: what the topic is for, not its whole brief. */
export const DISPATCH_GOAL_CHARS = 500;

export const DISPATCH_PROMPT = `You route messages in a team chat to the AI roles in it. Decide which roles should handle the latest message: none (small talk, greetings, thanks, or people talking to each other), usually one, or several when it needs different responsibilities. A message answering a role's question goes to that role. Earlier messages are context only; route just the latest one. Answer only by calling choose_roles.`;

const clip = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** The topic goal, the role list, earlier messages (oldest first) and the message to route, as one user turn. */
export async function chatDispatchRequest(
  db: Db,
  msg: Message,
  topic: Topic,
  candidates: Role[],
): Promise<ChatMessage[]> {
  const line = async (m: Message) => `${await authorName(db, m.authorType, m.authorId)}: ${clip(m.content, 300)}`;
  const earlier = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.topicId, msg.topicId),
        lt(messages.createdAt, msg.createdAt),
        ne(messages.authorType, "system"),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(CONTEXT_MESSAGES);
  const roles = candidates.map(
    (r) => `- @${r.handle}: ${r.name}${r.description ? ` — ${clip(r.description, 200)}` : ""}`,
  );
  const context = [];
  for (const m of earlier.reverse()) context.push(await line(m));
  const goal = clip(topic.goal, DISPATCH_GOAL_CHARS);
  const text = [
    goal ? `Topic goal: ${goal}` : "",
    `Roles:\n${roles.join("\n")}`,
    context.length ? `Earlier messages (oldest first):\n${context.join("\n")}` : "",
    `Latest message:\n${await line({ ...msg, content: clip(msg.content, 2000) })}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: DISPATCH_PROMPT },
    { role: "user", content: text },
  ];
}

const chooseRoles = (candidates: Role[]): ToolSchema => ({
  name: "choose_roles",
  description: "The roles that should handle the latest message; an empty list when none should.",
  parameters: {
    type: "object",
    properties: {
      roles: { type: "array", items: { type: "string", enum: candidates.map((r) => r.handle) } },
      reason: { type: "string", description: "One short sentence." },
    },
    required: ["roles"],
  },
});

/** Ask the chat model; the roles it chose (unknown handles dropped), its reason, and the tokens used. */
export async function chooseWithChat(model: ChatModel, request: ChatMessage[], candidates: Role[]) {
  const res = await model.complete(request, [chooseRoles(candidates)]);
  let args = res.toolCalls.find((c) => c.name === "choose_roles")?.arguments;
  // Some services answer in text despite the tool: accept the same object as JSON there.
  if (!args) {
    const json = /\{[\s\S]*\}/.exec(res.content)?.[0];
    try {
      args = json ? JSON.parse(json) : undefined;
    } catch {
      args = undefined;
    }
  }
  if (!args || !Array.isArray(args.roles)) throw new ModelError("the dispatcher model did not call choose_roles");
  // In the model's order: work from a linked topic goes to the first one only.
  const handles: string[] = [...new Set<string>(args.roles.map((h: unknown) => String(h).replace(/^@/, "")))];
  return {
    roles: handles.map((h) => candidates.find((r) => r.handle === h)).filter((r): r is Role => !!r),
    reason: typeof args.reason === "string" ? clip(args.reason, 300) : "",
    inputTokens: res.promptTokens,
    outputTokens: res.completionTokens,
  };
}

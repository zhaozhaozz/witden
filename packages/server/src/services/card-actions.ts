/**
 * What happens to a card after it is posted (services/cards.ts): people act on it, in the console or on its copy in
 * Feishu, and the role that posted it changes it. Each change is kept on the message (its card and its Markdown
 * text), shown live in the console (``message.card``) and pushed to the card's copies on platforms that show cards
 * (an adapter's ``updateCard``). An action also reaches the role as a message from the person, in the card's thread,
 * so the role answers it like anything else said to it; that message stays in the console.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { dispatchHumanMessage, saveMessage } from "../agent/dispatch.js";
import { type Db, db as getDb } from "../db/client.js";
import { connections, type Message, messages, outboundMessages, type Topic, type User } from "../db/schema.js";
import { BadRequest, NotFound } from "../errors.js";
import { getAdapter } from "../integrations/base.js";
import { audit } from "./audit.js";
import { actionText, type Card, type CardState, cardMarkdown, checkValues, type StoredCard } from "./cards.js";
import { publish } from "./events.js";
import { participant } from "./topics.js";

export const storedCard = (msg: Message): StoredCard | null => (msg.card ? (msg.card as StoredCard) : null);

/** A new card's stored form. */
export const newCard = (spec: Card): StoredCard => ({ spec, state: { actions: [], closed: false } });

async function save(db: Db, msg: Message, card: StoredCard): Promise<Message> {
  const [row] = await db
    .update(messages)
    .set({ card, content: cardMarkdown(card.spec, card.state) })
    .where(eq(messages.id, msg.id))
    .returning();
  // Small on purpose (events are size-limited): consoles fetch the message again.
  await publish(db, "message.card", { id: msg.id, topic_id: msg.topicId }, `topic:${msg.topicId}`);
  return row;
}

/**
 * A person's action on a card: checked against the card (its button, its inputs), recorded, and given to the role
 * that posted it. ``via`` is where it was done: "console", or the platform.
 */
export async function applyCardAction(
  db: Db,
  topic: Topic,
  msg: Message,
  user: User,
  actionId: string,
  rawValues: Record<string, unknown>,
  via: string,
  /** Data the card's app sent with the action (console only; the person confirmed it). */
  appData?: unknown,
): Promise<{ card: StoredCard; message: Message }> {
  const card = storedCard(msg);
  if (!card || msg.deletedAt) throw new NotFound("this message has no card");
  if (card.state.closed) throw new BadRequest("这张卡片已经关闭，不能再操作");
  const action = (card.spec.actions ?? []).find((a) => a.id === actionId);
  if (!action || action.url) throw new BadRequest("这张卡片没有这个按钮");
  let values: Record<string, unknown>;
  try {
    values = checkValues(card.spec, rawValues ?? {});
  } catch (err) {
    throw new BadRequest((err as Error).message);
  }
  if (appData !== undefined && Buffer.byteLength(JSON.stringify(appData) ?? "") > 4000)
    throw new BadRequest("小应用提交的数据太大（最多 4 KB）");
  const state: CardState = {
    actions: [
      ...card.state.actions,
      {
        action: action.id,
        label: action.label,
        values,
        user_id: user.id,
        user_name: user.name,
        at: new Date().toISOString(),
        via,
        ...(appData !== undefined ? { app_data: appData } : {}),
      },
    ],
    closed: !!card.spec.once,
  };
  const updated = { spec: card.spec, state };
  await save(db, msg, updated);
  await audit(db, "card.action", {
    actorType: "user",
    actorId: user.id,
    topicId: topic.id,
    detail: { message_id: msg.id, action: action.id, via },
  });
  // To the role that posted it, in the card's thread; the card itself shows the choice everywhere.
  const roleId = msg.authorType === "role" && msg.authorId ? msg.authorId : null;
  const present = roleId && (await participant(db, topic.id, "role", roleId));
  const said = await saveMessage(db, topic, "user", user.id, actionText(card.spec, action.label, values, appData), {
    mentions: present ? [{ type: "role", id: roleId }] : [],
    replyToId: msg.replyToId ?? msg.id,
    source: via === "console" ? "web" : via,
    // which card and button, for the role (agent/conversation.ts line)
    externalRef: { card_action: { card: msg.id, action: action.id } },
    mirror: false,
  });
  if (present) await dispatchHumanMessage(db, topic, said, user);
  return { card: updated, message: said };
}

/** The role that posted a card replaces it (spec), or closes it to further actions. */
export async function changeCard(db: Db, msg: Message, spec: Card | null, close: boolean): Promise<StoredCard> {
  const card = storedCard(msg);
  if (!card || msg.deletedAt) throw new NotFound("this message has no card");
  const updated: StoredCard = { spec: spec ?? card.spec, state: { ...card.state, closed: close || card.state.closed } };
  await save(db, msg, updated);
  return updated;
}

/**
 * Push a card's current form to its copies on platforms that show cards (after the change is committed: it calls
 * the platforms). ``except`` skips a copy already updated another way (Feishu takes the new card in its answer).
 */
export async function refreshCardCopies(messageId: string, except?: string): Promise<void> {
  const db = getDb();
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg?.card) return;
  const copies = await db
    .select()
    .from(outboundMessages)
    .where(and(eq(outboundMessages.messageId, messageId), isNotNull(outboundMessages.externalTs)));
  for (const out of copies) {
    if (!out.externalTs || out.externalTs === except) continue;
    const [conn] = await db.select().from(connections).where(eq(connections.id, out.connectionId)).limit(1);
    if (!conn) continue;
    const adapter = await getAdapter(conn);
    if (!adapter.updateCard) continue;
    try {
      await adapter.updateCard(db, conn, out.externalTs, msg);
    } catch (err) {
      console.warn("[witden] card copy not updated", out.externalTs, (err as Error).message);
    }
  }
}

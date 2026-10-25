/** Cards in the console (services/cards.ts): one message fetched again after it changed, and people's actions. */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { messageOut } from "../agent/dispatch.js";
import { messages } from "../db/schema.js";
import { Forbidden, NotFound } from "../errors.js";
import { applyCardAction, refreshCardCopies } from "../services/card-actions.js";
import * as svc from "../services/topics.js";
import { authed, body, params } from "./http.js";

export async function cardRoutes(app: FastifyInstance) {
  app.get(
    "/api/topics/:id/messages/:mid",
    authed(async ({ db, user, req }) => {
      const p = params(req);
      const topic = await svc.getTopic(db, p.id);
      await svc.requireView(db, user, topic);
      const [msg] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, p.mid), eq(messages.topicId, topic.id)))
        .limit(1);
      if (!msg) throw new NotFound("message not found");
      return messageOut(msg);
    }),
  );

  app.post(
    "/api/topics/:id/messages/:mid/card-actions",
    authed(async ({ db, user, req, after }) => {
      const p = params(req);
      const topic = await svc.getTopic(db, p.id);
      // Acting on a card is saying something in the topic.
      if (topic.kind === "pair" || !(await svc.canPost(db, user, topic)))
        throw new Forbidden("you are not a participant of this topic (or it is archived)");
      const [msg] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, p.mid), eq(messages.topicId, topic.id)))
        .limit(1);
      if (!msg) throw new NotFound("message not found");
      const b = body(req);
      const values = b.values && typeof b.values === "object" && !Array.isArray(b.values) ? b.values : {};
      const { message } = await applyCardAction(
        db,
        topic,
        msg,
        user,
        String(b.action ?? ""),
        values,
        "console",
        b.appData,
      );
      after(() => void refreshCardCopies(msg.id));
      const [updated] = await db.select().from(messages).where(eq(messages.id, msg.id)).limit(1);
      return { message: messageOut(updated), reply: messageOut(message) };
    }),
  );
}

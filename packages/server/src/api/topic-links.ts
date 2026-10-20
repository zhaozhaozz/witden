import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BadRequest, Forbidden } from "../errors.js";
import { isConsoleUser } from "../security/permissions.js";
import { addTopicLink, linkedTopics, removeTopicLink } from "../services/topic-links.js";
import { getTopic } from "../services/topics.js";
import { authed, body, params } from "./http.js";

export async function topicLinkRoutes(app: FastifyInstance) {
  app.get(
    "/api/topics/:id/links",
    authed(async ({ db, user, req }) => {
      if (!isConsoleUser(user)) throw new Forbidden("only console accounts can inspect topic link configuration");
      await getTopic(db, params(req).id);
      return linkedTopics(db, params(req).id);
    }),
  );
  app.post(
    "/api/topics/:id/links",
    authed(async ({ db, user, req }) => {
      const parsed = z
        .object({ topicId: z.string().min(1), confirmPrivate: z.boolean().optional() })
        .strict()
        .safeParse(body(req));
      if (!parsed.success) throw new BadRequest("provide topic_id and optional confirm_private");
      await addTopicLink(db, user, params(req).id, parsed.data.topicId, parsed.data.confirmPrivate);
      return linkedTopics(db, params(req).id);
    }),
  );
  app.delete(
    "/api/topics/:id/links/:linkId",
    authed(async ({ db, user, req }) => {
      await removeTopicLink(db, user, params(req).id, params(req).linkId);
      return { ok: true };
    }),
  );
}

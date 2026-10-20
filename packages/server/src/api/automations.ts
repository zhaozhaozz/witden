import type { FastifyInstance } from "fastify";
import { Forbidden } from "../errors.js";
import { isConsoleUser } from "../security/permissions.js";
import { automationList } from "../services/automation-rules.js";
import { authed, query } from "./http.js";

export async function automationRoutes(app: FastifyInstance) {
  app.get(
    "/api/automations",
    authed(async ({ db, user, req }) => {
      if (!isConsoleUser(user)) throw new Forbidden("only console accounts can list automation configuration");
      return automationList(db, query(req).role_id);
    }),
  );
}

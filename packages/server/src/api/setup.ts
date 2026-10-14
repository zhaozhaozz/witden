/** The first-run guide (services/setup.ts). */
import type { FastifyInstance } from "fastify";
import { runtime } from "../runtime.js";
import { Perm, requirePerm } from "../security/permissions.js";
import { opProvision } from "../services/instances.js";
import { finishSetup, setupStatus, skipSetup } from "../services/setup.js";
import { authed, body } from "./http.js";

export async function setupRoutes(app: FastifyInstance) {
  app.get(
    "/api/setup",
    authed(async ({ db }) => {
      const { needed, setting } = await setupStatus(db);
      return {
        needed,
        finished_at: setting?.finished_at ?? null,
        skipped_at: setting?.skipped_at ?? null,
      };
    }),
  );

  app.post(
    "/api/setup/skip",
    authed(async ({ db, user }) => {
      await requirePerm(db, user, Perm.ROLE_MANAGE);
      await skipSetup(db, user);
      return { ok: true };
    }),
  );

  app.post(
    "/api/setup/finish",
    authed(async ({ db, user, req, after }) => {
      await requirePerm(db, user, Perm.ROLE_MANAGE);
      await requirePerm(db, user, Perm.INSTANCE_MANAGE);
      const out = await finishSetup(db, user, String(body(req).modelConfigId ?? ""));
      // The computer starts once the rows above are committed.
      if (out.provision) after(() => runtime().background("provision", () => opProvision(out.computer.id)));
      return {
        computer: { id: out.computer.id, name: out.computer.name, status: out.computer.status },
        admin_role_id: out.admin.id,
        assistant_role_id: out.assistant.id,
        dm_id: out.dm.id,
      };
    }),
  );
}

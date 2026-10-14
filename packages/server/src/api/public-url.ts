/** The platform's public address and the optional Cloudflare Tunnel (services/public-url.ts). */
import type { FastifyInstance } from "fastify";
import { settings } from "../config.js";
import { BadRequest } from "../errors.js";
import { Perm, requirePerm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { getSetting } from "../services/platform-settings.js";
import {
  checkPublicUrl,
  PUBLIC_URL,
  parseTunnelToken,
  savePublicUrl,
  tunnelStatus,
  webhookBase,
  writeTunnelToken,
} from "../services/public-url.js";
import { authed, authedNoTx, body } from "./http.js";

export async function publicUrlRoutes(app: FastifyInstance) {
  app.get(
    "/api/settings/public-url",
    authed(async ({ db, user }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const saved = await getSetting<{ url?: string }>(db, PUBLIC_URL);
      return { url: await webhookBase(db), saved: saved?.url ?? null, default: settings().publicUrl };
    }),
  );

  // Checks call out over the network, so they run outside a request transaction.
  app.post(
    "/api/settings/public-url/check",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      return checkPublicUrl(String(body(req).url ?? (await webhookBase(db))));
    }),
  );

  app.put(
    "/api/settings/public-url",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      const b = body(req);
      if (!b.url) {
        await savePublicUrl(db, null, user.id);
        await audit(db, "settings.public_url", { actorType: "user", actorId: user.id, detail: { url: null } });
        return { saved: true, url: await webhookBase(db), check: null };
      }
      const check = await checkPublicUrl(String(b.url));
      // A failed check is saved only when asked to and when this server's own network may be the cause.
      const forced = !check.ok && !!b.force && !!check.overridable;
      if (!check.ok && !forced) return { saved: false, url: await webhookBase(db), check };
      await savePublicUrl(db, check.url, user.id);
      await audit(db, "settings.public_url", {
        actorType: "user",
        actorId: user.id,
        detail: { url: check.url, ...(forced ? { saved_despite: check.problem } : {}) },
      });
      return { saved: true, url: check.url, check };
    }),
  );

  app.get(
    "/api/settings/tunnel",
    authedNoTx(async ({ db, user }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      return tunnelStatus();
    }),
  );

  app.put(
    "/api/settings/tunnel",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      if (!settings().tunnelTokenFile)
        throw new BadRequest("this deployment has no tunnel service (see the tunnel profile in docker-compose.yml)");
      const parsed = parseTunnelToken(String(body(req).token ?? ""));
      if (!parsed) throw new BadRequest("not a Cloudflare Tunnel token");
      writeTunnelToken(parsed.token);
      await audit(db, "settings.tunnel", {
        actorType: "user",
        actorId: user.id,
        detail: { tunnel: parsed.info.tunnel },
      });
      return tunnelStatus();
    }),
  );

  app.delete(
    "/api/settings/tunnel",
    authedNoTx(async ({ db, user }) => {
      await requirePerm(db, user, Perm.CONNECTION_MANAGE);
      if (!settings().tunnelTokenFile) throw new BadRequest("this deployment has no tunnel service");
      writeTunnelToken(null);
      await audit(db, "settings.tunnel", { actorType: "user", actorId: user.id, detail: { tunnel: null } });
      return tunnelStatus();
    }),
  );
}

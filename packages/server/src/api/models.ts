import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { modelConfigs } from "../db/schema.js";
import { Conflict } from "../errors.js";
import { hasPermission, Perm, requirePerm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import * as svc from "../services/model-configs.js";
import { authed, authedNoTx, body, params, row } from "./http.js";

const out = (cfg: typeof modelConfigs.$inferSelect) => ({ ...row(cfg), has_api_key: !!cfg.apiKeyEncrypted });

export async function modelRoutes(app: FastifyInstance) {
  app.get(
    "/api/model-configs",
    authed(async ({ db, user }) => {
      const result = [];
      for (const c of await db.select().from(modelConfigs).orderBy(modelConfigs.name)) {
        if (
          !(await hasPermission(db, user, Perm.SECRETS_MANAGE)) &&
          !(await hasPermission(db, user, Perm.MODEL_USE, c.id))
        )
          continue;
        result.push({
          ...out(c),
          used_by_roles: await svc.rolesUsing(db, c),
          tokens_today: await svc.tokensToday(db, { modelConfigId: c.id }),
        });
      }
      return result;
    }),
  );

  app.post(
    "/api/model-configs",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const cfg = await svc.createConfig(db, body(req), user.id);
      await audit(db, "model_config.create", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model_config",
        resourceId: cfg.id,
        detail: { name: cfg.name, base_url: cfg.baseUrl, model: cfg.model },
      });
      return out(cfg);
    }),
  );

  app.patch(
    "/api/model-configs/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const data = body(req);
      const cfg = await svc.updateConfig(db, await svc.getConfig(db, params(req).id), data);
      await audit(db, "model_config.update", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model_config",
        resourceId: cfg.id,
        detail: { fields: Object.keys(data).sort(), key_changed: "apiKey" in data },
      });
      return out(cfg);
    }),
  );

  app.post(
    "/api/model-configs/:id/revoke-key",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const cfg = await svc.revokeKey(db, await svc.getConfig(db, params(req).id));
      await audit(db, "model_config.revoke_key", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model_config",
        resourceId: cfg.id,
      });
      return out(cfg);
    }),
  );

  // Calls the model three times: no transaction is held meanwhile.
  app.post(
    "/api/model-configs/:id/check",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const cfg = await svc.checkConfig(db, await svc.getConfig(db, params(req).id));
      await audit(db, "model_config.check", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model_config",
        resourceId: cfg.id,
        detail: { chat: cfg.capabilities.chat, tools: cfg.capabilities.tools, vision: cfg.capabilities.vision },
      });
      return out(cfg);
    }),
  );

  app.delete(
    "/api/model-configs/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const cfg = await svc.getConfig(db, params(req).id);
      const used = await svc.rolesUsing(db, cfg);
      if (used.length) throw new Conflict(`model config is used by roles: ${used.join(", ")}`);
      await db.delete(modelConfigs).where(eq(modelConfigs.id, cfg.id));
      await audit(db, "model_config.delete", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model_config",
        resourceId: cfg.id,
      });
      return { ok: true };
    }),
  );
}

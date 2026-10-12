/**
 * Model providers and their models. Managing them needs secrets.manage; everyone else sees only the models
 * they may use (model.use), grouped under their providers, and never anything about keys.
 */
import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { type ModelConfig, type ModelProvider, modelConfigs, modelProviders, type User } from "../db/schema.js";
import { BadRequest } from "../errors.js";
import { hasPermission, Perm, requirePerm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import * as svc from "../services/model-configs.js";
import { DISPATCHER, type DispatcherSetting, getSetting, putSetting } from "../services/platform-settings.js";
import { authed, authedNoTx, body, params, row } from "./http.js";

const providerOut = (p: ModelProvider, manage: boolean) =>
  manage
    ? { ...row(p), has_api_key: !!p.apiKeyEncrypted }
    : { id: p.id, name: p.name, protocol: p.protocol, status: p.status };

async function modelOut(db: Db, m: ModelConfig, p: ModelProvider) {
  return {
    ...row(m),
    label: svc.modelLabel(m, p),
    usable: !svc.unusableReason(m, p),
    used_by_roles: await svc.rolesUsing(db, m),
    tokens_today: await svc.tokensToday(db, { modelConfigId: m.id }),
  };
}

/** Providers with the models this person may see. */
async function visible(db: Db, user: User) {
  const manage = await hasPermission(db, user, Perm.SECRETS_MANAGE);
  const out = [];
  for (const p of await db.select().from(modelProviders).orderBy(sql`lower(${modelProviders.name})`)) {
    const models = [];
    for (const m of await db
      .select()
      .from(modelConfigs)
      .where(eq(modelConfigs.providerId, p.id))
      .orderBy(asc(modelConfigs.model))) {
      if (manage || (await hasPermission(db, user, Perm.MODEL_USE, m.id))) models.push(await modelOut(db, m, p));
    }
    if (manage || models.length) out.push({ ...providerOut(p, manage), models });
  }
  return out;
}

export async function modelRoutes(app: FastifyInstance) {
  // The dispatcher model of "auto" topics (agent/router.ts). Anyone signed in may see which one is set.
  app.get(
    "/api/settings/dispatcher",
    authed(async ({ db }) => {
      const setting = await getSetting<DispatcherSetting>(db, DISPATCHER);
      const found = setting?.model_config_id ? await svc.modelWithProvider(db, setting.model_config_id) : null;
      return {
        model_config_id: found ? found.model.id : null,
        model: found ? { id: found.model.id, label: svc.modelLabel(found.model, found.provider) } : null,
        usable: !!found && !svc.unusableReason(found.model, found.provider),
      };
    }),
  );
  app.put(
    "/api/settings/dispatcher",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const id = body(req).modelConfigId ?? null;
      if (id && !(await svc.modelWithProvider(db, String(id)))) throw new BadRequest("model not found");
      await putSetting(db, DISPATCHER, { model_config_id: id }, user.id);
      await audit(db, "settings.dispatcher", { actorType: "user", actorId: user.id, detail: { model_config_id: id } });
      return { model_config_id: id };
    }),
  );

  app.get(
    "/api/model-providers",
    authed(({ db, user }) => visible(db, user)),
  );

  /** Flat list for pickers (role editor, grants, usage). */
  app.get(
    "/api/models",
    authed(async ({ db, user }) =>
      (await visible(db, user)).flatMap((p) =>
        p.models.map((m) => ({ ...m, provider: { id: p.id, name: p.name, protocol: p.protocol, status: p.status } })),
      ),
    ),
  );

  app.post(
    "/api/model-providers",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const { provider, models } = await svc.createProvider(db, body(req), user.id);
      await audit(db, "model_provider.create", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model_provider",
        resourceId: provider.id,
        detail: { name: provider.name, protocol: provider.protocol, base_url: provider.baseUrl, models: models.length },
      });
      return {
        ...providerOut(provider, true),
        models: await Promise.all(models.map((m) => modelOut(db, m, provider))),
      };
    }),
  );

  app.patch(
    "/api/model-providers/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const data = body(req);
      const provider = await svc.updateProvider(db, await svc.getProvider(db, params(req).id), data);
      await audit(db, "model_provider.update", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model_provider",
        resourceId: provider.id,
        detail: { fields: Object.keys(data).sort(), key_changed: "apiKey" in data },
      });
      return providerOut(provider, true);
    }),
  );

  app.post(
    "/api/model-providers/:id/revoke-key",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const provider = await svc.revokeKey(db, await svc.getProvider(db, params(req).id));
      await audit(db, "model_provider.revoke_key", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model_provider",
        resourceId: provider.id,
      });
      return providerOut(provider, true);
    }),
  );

  app.delete(
    "/api/model-providers/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const provider = await svc.getProvider(db, params(req).id);
      await svc.deleteProvider(db, provider);
      await audit(db, "model_provider.delete", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model_provider",
        resourceId: provider.id,
        detail: { name: provider.name },
      });
      return { ok: true };
    }),
  );

  // Asks the provider's API: no transaction is held meanwhile.
  app.get(
    "/api/model-providers/:id/remote-models",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const provider = await svc.getProvider(db, params(req).id);
      const remote = await svc.fetchRemoteModels(db, provider);
      const have = new Set(
        (await db.select().from(modelConfigs).where(eq(modelConfigs.providerId, provider.id))).map((m) => m.model),
      );
      return {
        fetched_at: new Date().toISOString(),
        models: remote.map((m) => ({ id: m.id, name: m.name, added: have.has(m.id) })),
      };
    }),
  );

  app.post(
    "/api/model-providers/:id/models",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const provider = await svc.getProvider(db, params(req).id);
      const b = body(req);
      const source = b.source === "api" ? "api" : "manual";
      const added = await svc.addModels(db, provider, b.models, source, user.id);
      await audit(db, "model.add", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model_provider",
        resourceId: provider.id,
        detail: { source, models: added.map((m) => m.model) },
      });
      return {
        added: await Promise.all(added.map((m) => modelOut(db, m, provider))),
        skipped: (Array.isArray(b.models) ? b.models.length : 0) - added.length,
      };
    }),
  );

  app.patch(
    "/api/models/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const data = body(req);
      const model = await svc.updateModel(db, await svc.getModel(db, params(req).id), data);
      await audit(db, "model.update", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model",
        resourceId: model.id,
        detail: { fields: Object.keys(data).sort() },
      });
      return modelOut(db, model, await svc.getProvider(db, model.providerId));
    }),
  );

  app.delete(
    "/api/models/:id",
    authed(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const model = await svc.getModel(db, params(req).id);
      await svc.deleteModel(db, model);
      await audit(db, "model.delete", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model",
        resourceId: model.id,
        detail: { model: model.model },
      });
      return { ok: true };
    }),
  );

  // Calls the model three times: no transaction is held meanwhile.
  app.post(
    "/api/models/:id/check",
    authedNoTx(async ({ db, user, req }) => {
      await requirePerm(db, user, Perm.SECRETS_MANAGE);
      const model = await svc.checkModel(db, await svc.getModel(db, params(req).id));
      await audit(db, "model.check", {
        actorType: "user",
        actorId: user.id,
        resourceType: "model",
        resourceId: model.id,
        detail: { chat: model.capabilities.chat, tools: model.capabilities.tools, vision: model.capabilities.vision },
      });
      return modelOut(db, model, await svc.getProvider(db, model.providerId));
    }),
  );
}

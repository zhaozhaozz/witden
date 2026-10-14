/**
 * The only routes meant for the internet: the platforms' event webhooks, the public address check, and role
 * avatars (Slack downloads them itself to show a role's icon). None needs a login; each webhook verifies its
 * platform's signature or token.
 *
 * The webhook listener (WITDEN_WEBHOOK_PORT) serves these routes and nothing else, so a public address that
 * forwards to it cannot reach the console. The console's own server serves them too, for deployments where
 * platforms reach it directly, but answers the address check as "console" so such an address is refused.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { db as getDb } from "../db/client.js";
import { Forbidden, NotFound, WitdenError } from "../errors.js";
import { getAdapter, type InboundAction } from "../integrations/base.js";
import { enqueueInbound, processInbound } from "../integrations/inbound.js";
import { noteWebhook } from "../integrations/webhook-status.js";
import { runtime } from "../runtime.js";
import { probeAnswer } from "../services/public-url.js";
import { params, query, sendError } from "./http.js";
import { getConn } from "./integrations.js";
import { serveAvatar } from "./roles.js";

/**
 * Platforms retry slow webhooks, so events are stored durably first, then acknowledged, then processed from
 * the queue (a periodic sweep picks up anything a crash left behind).
 */
async function acceptEvents(connectionId: string, actions: InboundAction[]): Promise<void> {
  if (!actions.length) return;
  await enqueueInbound(getDb(), connectionId, actions);
  runtime().background("inbound", async () => {
    while (await processInbound()) {
      /* drain */
    }
  });
}

/** Run a platform's verification; a signed call that fails it is remembered for the console. */
function rejectedIf(connectionId: string, signed: boolean, verify: () => void): void {
  try {
    verify();
  } catch (err) {
    if (signed && err instanceof WitdenError) noteWebhook(connectionId, "rejected", err.message);
    throw err;
  }
}

export async function webhookRoutes(app: FastifyInstance, listener: "console" | "webhooks") {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req: FastifyRequest, raw: Buffer, done) => {
    // Keep the raw body for signature checks; parse JSON for everything else.
    (req as any).rawBody = raw;
    try {
      done(null, raw.length ? JSON.parse(raw.toString("utf8")) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // A deployment checking its public address calls this through it (services/public-url.ts): only the
  // webhook listener proves who it is; the console says it is the console.
  app.get("/api/integrations/probe", async (req) =>
    listener === "webhooks"
      ? { ...probeAnswer(String(query(req).nonce ?? "").slice(0, 64)), listener }
      : { witden: true, listener },
  );

  app.post("/api/integrations/slack/:id/events", async (req, reply) => {
    const { verifySignature, credentials } = await import("../integrations/slack.js");
    const raw: Buffer = (req as any).rawBody ?? Buffer.from("");
    const conn = await getConn(getDb(), params(req).id);
    if (conn.platform !== "slack") throw new NotFound("unknown connection");
    const signature = req.headers["x-slack-signature"];
    rejectedIf(conn.id, !!signature, () =>
      verifySignature(
        credentials(conn).signing_secret ?? "",
        String(req.headers["x-slack-request-timestamp"] ?? ""),
        raw,
        String(signature ?? ""),
      ),
    );
    const payload: any = req.body ?? {};
    if (payload.type === "url_verification") {
      noteWebhook(conn.id, "verified");
      return reply.send({ challenge: payload.challenge });
    }
    if (payload.type !== "event_callback" || conn.status !== "active") return { ok: true };
    if (payload.team_id && conn.externalWorkspaceId && payload.team_id !== conn.externalWorkspaceId)
      throw new Forbidden("event from another workspace");
    noteWebhook(conn.id, "received");
    await acceptEvents(conn.id, await (await getAdapter(conn)).parse(getDb(), conn, payload));
    return { ok: true };
  });

  app.post("/api/integrations/github/:id/events", async (req) => {
    const { verifySignature } = await import("../integrations/github.js");
    const { credentials } = await import("../integrations/slack.js");
    const raw: Buffer = (req as any).rawBody ?? Buffer.from("");
    const conn = await getConn(getDb(), params(req).id);
    if (conn.platform !== "github") throw new NotFound("unknown connection");
    const signature = req.headers["x-hub-signature-256"];
    rejectedIf(conn.id, !!signature, () =>
      verifySignature(credentials(conn).webhook_secret ?? "", raw, String(signature ?? "")),
    );
    const event = String(req.headers["x-github-event"] ?? "");
    noteWebhook(conn.id, event === "ping" ? "verified" : "received");
    if (event === "ping" || conn.status !== "active") return { ok: true };
    const input = { event, delivery: String(req.headers["x-github-delivery"] ?? ""), payload: req.body ?? {} };
    await acceptEvents(conn.id, await (await getAdapter(conn)).parse(getDb(), conn, input));
    return { ok: true };
  });

  app.post("/api/integrations/feishu/:id/events", async (req, reply) => {
    const conn = await getConn(getDb(), params(req).id);
    if (conn.platform !== "feishu") throw new NotFound("unknown connection");
    const adapter = (await getAdapter(conn)) as import("../integrations/feishu.js").FeishuAdapter;
    const payload: any = req.body ?? {};
    rejectedIf(conn.id, !!(payload?.header?.token ?? payload?.token), () => adapter.verify(conn, payload));
    if (payload.type === "url_verification") {
      noteWebhook(conn.id, "verified");
      return reply.send({ challenge: payload.challenge });
    }
    noteWebhook(conn.id, "received");
    if (conn.status !== "active") return { ok: true };
    await acceptEvents(conn.id, await adapter.parse(getDb(), conn, payload));
    return { ok: true };
  });
}

/** The webhook listener: the routes above plus avatars, and a 404 for everything else. */
export async function buildWebhookApp(): Promise<FastifyInstance> {
  // GitHub sends webhook payloads of up to 25 MB.
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });
  app.setErrorHandler(sendError);
  await webhookRoutes(app, "webhooks");
  app.get("/api/avatars/:file", serveAvatar);
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "not served on this port", detail: {} } }),
  );
  return app;
}

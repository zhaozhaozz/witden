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
import { db as getDb, transaction } from "../db/client.js";
import { Forbidden, NotFound, WitdenError } from "../errors.js";
import { getAdapter } from "../integrations/base.js";
import { acceptEvents } from "../integrations/inbound.js";
import { appCredentials, appForEvents, getApp, workspaceConnection } from "../integrations/slack-apps.js";
import {
  CALLBACK_PATH,
  exchangeCode,
  installProblem,
  installWorkspace,
  readState,
} from "../integrations/slack-install.js";
import { slackSockets } from "../integrations/slack-socket.js";
import { noteWebhook } from "../integrations/webhook-status.js";
import { audit } from "../services/audit.js";
import { probeAnswer } from "../services/public-url.js";
import { params, query, sendError } from "./http.js";
import { getConn } from "./integrations.js";
import { serveAvatar } from "./roles.js";
import { triggerWebhookRoutes } from "./triggers.js";

const escapeHtml = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** The page a person's browser shows after Slack's redirect: what became of the installation, nothing else. */
function installPage(title: string, text: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:36em;margin:4em auto;padding:0 1em;color:#1f2933}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`;
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
  await app.register(triggerWebhookRoutes);
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
    const { verifySignature, acceptSlackEvent } = await import("../integrations/slack.js");
    const raw: Buffer = (req as any).rawBody ?? Buffer.from("");
    // A Slack app's events URL (addresses made before apps name a workspace, which leads to its app).
    const slackApp = await appForEvents(getDb(), params(req).id);
    if (!slackApp) throw new NotFound("unknown Slack app");
    const signature = req.headers["x-slack-signature"];
    rejectedIf(slackApp.id, !!signature, () =>
      verifySignature(
        appCredentials(slackApp).signing_secret ?? "",
        String(req.headers["x-slack-request-timestamp"] ?? ""),
        raw,
        String(signature ?? ""),
      ),
    );
    const payload: any = req.body ?? {};
    if (payload.type === "url_verification") {
      noteWebhook(slackApp.id, "verified");
      return reply.send({ challenge: payload.challenge });
    }
    if (payload.type !== "event_callback") return { ok: true };
    // Every workspace the app is installed in sends here: the event goes to that workspace's connection.
    const conn = await workspaceConnection(getDb(), slackApp, payload.team_id);
    if (!conn) throw new Forbidden("event from a workspace this app is not connected to");
    await acceptSlackEvent(conn, payload);
    return { ok: true };
  });

  // Slack sends the browser of whoever installed the app here (integrations/slack-install.ts). It completes
  // only installations witden started (the signed state) and shows a plain page.
  app.get(CALLBACK_PATH, async (req, reply) => {
    const q = query(req);
    const page = (ok: boolean, text: string) =>
      reply
        .code(ok ? 200 : 400)
        .type("text/html; charset=utf-8")
        .send(installPage(ok ? "已安装到 Slack 工作区" : "没有完成安装", text));
    if (q.error) return page(false, q.error === "access_denied" ? "安装已取消。" : `Slack 返回：${q.error}`);
    try {
      const state = readState(String(q.state ?? ""));
      const app = await getApp(getDb(), state.app);
      const inst = await exchangeCode(app, String(q.code ?? ""), state.redirectUri);
      const conn = await transaction(async (db) => {
        const installed = await installWorkspace(db, app, inst, null);
        await audit(db, "connection.slack_install", {
          actorType: "system",
          connectionId: installed.id,
          detail: { slack_app: app.id, team: inst.teamId, via: "callback" },
        });
        return installed;
      });
      void slackSockets.sync();
      return page(
        true,
        `已把应用安装到工作区「${inst.teamName}」（witden 接入「${conn.name}」）。可以关闭这个页面，回到 witden 继续设置。`,
      );
    } catch (err) {
      return page(false, installProblem(err));
    }
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
    // A connection that only authenticates the GitHub tools takes no messages.
    if (event === "ping" || conn.status !== "active" || conn.settings.auth_only) return { ok: true };
    const input = { event, delivery: String(req.headers["x-github-delivery"] ?? ""), payload: req.body ?? {} };
    await acceptEvents(conn.id, await (await getAdapter(conn)).parse(getDb(), conn, input));
    return { ok: true };
  });

  app.post("/api/integrations/feishu/:id/events", async (req, reply) => {
    const conn = await getConn(getDb(), params(req).id);
    if (conn.platform !== "feishu") throw new NotFound("unknown connection");
    const { acceptFeishuEvent, FeishuAdapter } = await import("../integrations/feishu.js");
    const adapter = new FeishuAdapter();
    const payload: any = req.body ?? {};
    rejectedIf(conn.id, !!(payload?.header?.token ?? payload?.token), () => adapter.verify(conn, payload));
    if (payload.type === "url_verification") {
      noteWebhook(conn.id, "verified");
      return reply.send({ challenge: payload.challenge });
    }
    // a card click is answered with the toast and card Feishu shows
    return (await acceptFeishuEvent(conn, payload)) ?? { ok: true };
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

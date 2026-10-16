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
import { BadRequest, NotFound, WitdenError } from "../errors.js";
import { getAdapter } from "../integrations/base.js";
import { acceptEvents } from "../integrations/inbound.js";
import {
  CALLBACK_PATH,
  exchangeCode,
  installProblem,
  installWorkspace,
  readState,
  workspaceConnection,
} from "../integrations/slack-install.js";
import { slackSockets } from "../integrations/slack-socket.js";
import { noteWebhook } from "../integrations/webhook-status.js";
import { audit } from "../services/audit.js";
import { probeAnswer } from "../services/public-url.js";
import { params, query, sendError } from "./http.js";
import { getConn } from "./integrations.js";
import { serveAvatar } from "./roles.js";

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
    const { verifySignature, credentials, acceptSlackEvent } = await import("../integrations/slack.js");
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
    // One app, possibly installed in several workspaces: the event goes to the workspace's connection.
    await acceptSlackEvent(await workspaceConnection(getDb(), conn, payload.team_id), payload);
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
      const app = await getConn(getDb(), state.app);
      if (app.platform !== "slack" || app.installOf) throw new BadRequest("this is not a Slack app's connection");
      const inst = await exchangeCode(app, String(q.code ?? ""), state.redirectUri);
      const conn = await transaction(async (db) => {
        const installed = await installWorkspace(db, app, inst, null);
        await audit(db, "connection.slack_install", {
          actorType: "system",
          connectionId: installed.id,
          detail: { app: app.id, team: inst.teamId, via: "callback" },
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

/**
 * Process assembly. One codebase, three roles that can run together (single-host) or apart:
 *  - api:    REST API, web console, runner hub + execution gateway, chat webhooks, live events
 *  - worker: the agent loop (claims tasks from the PostgreSQL queue, calls the gateway over HTTP)
 *  - all:    both in one process (development, small teams)
 * The Docker Manager is used in-process or through its HTTP service (WITDEN_MANAGER_URL).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { ManagerApi } from "@witden/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { Worker } from "./agent/worker.js";
import { adminRoutes } from "./api/admin.js";
import { authRoutes } from "./api/auth.js";
import { computerRoutes } from "./api/computers.js";
import { eventRoutes } from "./api/events.js";
import { sendError } from "./api/http.js";
import { integrationRoutes } from "./api/integrations.js";
import { knowledgeRoutes } from "./api/knowledge.js";
import { liveRoutes } from "./api/live.js";
import { modelRoutes } from "./api/models.js";
import { publicUrlRoutes } from "./api/public-url.js";
import { roleRoutes } from "./api/roles.js";
import { taskRoutes } from "./api/tasks.js";
import { topicRoutes } from "./api/topics.js";
import { buildWebhookApp, webhookRoutes } from "./api/webhooks.js";
import { ExecutionGateway, type GatewayClient, HttpGatewayClient } from "./compute/gateway.js";
import { RunnerHub, stdioTransport } from "./compute/hub.js";
import { handleProxyMessage } from "./compute/model-proxy.js";
import { type Settings, setSettings } from "./config.js";
import { openDatabase, setDatabase, transaction } from "./db/client.js";
import { deliverPending } from "./integrations/delivery.js";
import { processInbound } from "./integrations/inbound.js";
import { slackSockets } from "./integrations/slack-socket.js";
import { Runtime, setRuntime } from "./runtime.js";
import { initSecretBox } from "./security/crypto.js";
import { EventBus } from "./services/events.js";
import { reconcile } from "./services/instances.js";
import { bootstrapLaya } from "./services/model-configs.js";
import { proxyConfigFor } from "./services/model-proxy.js";
import { bootstrap } from "./services/users.js";

export interface StartOptions {
  settings: Settings;
  /** Override the Docker Manager (tests use an in-memory fake). */
  manager?: ManagerApi;
  /** Do not start the agent worker loop even in "all" mode (tests drive it explicitly). */
  startWorker?: boolean;
  /** Listen for runners on settings.hubPort (tests attach runners in memory). */
  listenHub?: boolean;
}

export interface Witden {
  runtime: Runtime;
  app: FastifyInstance | null;
  /** The listener for event webhooks only (settings.webhookPort); the public address forwards here. */
  webhookApp: FastifyInstance | null;
  worker: Worker | null;
  close(): Promise<void>;
}

/** Worker processes never hold Docker access; computers are managed from the API process only. */
const NO_DOCKER_ACCESS = new Proxy({} as ManagerApi, {
  get: (_target, prop) =>
    prop === "then"
      ? undefined
      : () => Promise.reject(new Error(`this worker process has no Docker access (${String(prop)})`)),
});

async function makeManager(settings: Settings): Promise<ManagerApi> {
  if (settings.processRole === "worker") return NO_DOCKER_ACCESS;
  const mod: any = await import("@witden/manager");
  if (settings.managerUrl)
    return new mod.ManagerClient({ baseUrl: settings.managerUrl, token: settings.managerToken ?? "" });
  return new mod.DockerManager({
    dataDir: path.join(settings.dataDir, "manager"),
    allowedRuntimes: settings.allowedRuntimes,
  });
}

function webDist(settings: Settings): string | null {
  const candidates = [
    settings.webDist,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist"),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(path.join(p, "index.html"))) ?? null;
}

export async function buildApp(rt: Runtime): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 60 * 1024 * 1024 });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 60 * 1024 * 1024 } });
  app.setErrorHandler(sendError);
  app.get("/api/health", async () => ({ ok: true, version: "0.2.0" }));
  for (const routes of [
    authRoutes,
    adminRoutes,
    modelRoutes,
    computerRoutes,
    roleRoutes,
    topicRoutes,
    taskRoutes,
    knowledgeRoutes,
    eventRoutes,
    integrationRoutes,
    (a: FastifyInstance) => webhookRoutes(a, "console"),
    publicUrlRoutes,
    liveRoutes,
  ]) {
    await routes(app);
  }
  const dist = webDist(rt.settings);
  if (dist) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    // Single-page console: unknown non-API paths fall back to index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/internal/")) {
        return reply.code(404).send({ error: { code: "not_found", message: req.url, detail: {} } });
      }
      return reply.sendFile("index.html");
    });
  }
  return app;
}

export async function start(opts: StartOptions): Promise<Witden> {
  const settings = opts.settings;
  setSettings(settings);
  fs.mkdirSync(settings.dataDir, { recursive: true });
  const database = await openDatabase(settings.databaseUrl);
  setDatabase(database);
  initSecretBox(settings);
  await transaction((tx) => bootstrap(tx, settings));
  // Once, by the process that serves the API (api and worker start together).
  if (settings.layaUrl && settings.processRole !== "worker") {
    const { layaUrl, layaApiKey } = settings;
    await transaction((tx) => bootstrapLaya(tx, layaUrl, layaApiKey));
  }
  const bus = new EventBus();
  await bus.attach(database);
  const manager = opts.manager ?? (await makeManager(settings));
  const rt = new Runtime({ settings, database, bus, manager });
  setRuntime(rt);

  const hostsApi = settings.processRole !== "worker";
  let app: FastifyInstance | null = null;
  let webhookApp: FastifyInstance | null = null;
  const timers: NodeJS.Timeout[] = [];
  if (hostsApi) {
    rt.hub = new RunnerHub(async (containerId) => stdioTransport(await manager.openRunnerChannel(containerId)));
    rt.gateway = new ExecutionGateway();
    // Computers' model proxies are relayed here, next to the runner connections.
    rt.hub.proxyHandler = handleProxyMessage;
    rt.hub.welcomeExtras = async (instanceId) => ({ modelProxy: await proxyConfigFor(instanceId) });
    if (opts.listenHub !== false) await rt.hub.listen(settings.hubPort, settings.hubHost);
    app = await buildApp(rt);
    webhookApp = await buildWebhookApp();
    // Keep recorded computer status honest (crashes, OOM kills, manual docker changes).
    void reconcile().catch(() => {});
    timers.push(setInterval(() => void reconcile().catch(() => {}), 30_000));
    // Slack connections in Socket Mode receive their events over sockets this process keeps open.
    slackSockets.start();
    // Inbound chat events left queued or half-processed by a crash.
    const sweep = () => rt.background("inbound.sweep", async () => void (await processInbound()));
    sweep();
    timers.push(setInterval(sweep, 15_000));
  }
  let worker: Worker | null = null;
  if (settings.processRole !== "api" && opts.startWorker !== false) {
    let gateway: GatewayClient | undefined = rt.gateway;
    if (!gateway) {
      if (!settings.internalToken) throw new Error("WITDEN_INTERNAL_TOKEN is required for a separate worker process");
      gateway = new HttpGatewayClient(settings.apiUrlForWorker, settings.internalToken);
    }
    worker = new Worker(gateway, { deliverOutbound: deliverPending });
    rt.worker = worker;
    await worker.start(database, { recoverAll: settings.processRole === "all" });
  }
  return {
    runtime: rt,
    app,
    webhookApp,
    worker,
    async close() {
      for (const t of timers) clearInterval(t);
      await worker?.stop();
      await app?.close();
      await webhookApp?.close();
      slackSockets.stop();
      await rt.hub?.close();
      await rt.drain();
      await bus.close();
      await database.close();
    },
  };
}

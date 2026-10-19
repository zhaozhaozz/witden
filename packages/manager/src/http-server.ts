/**
 * HTTP API of the Docker Manager. Every route except `GET /health` needs `Authorization: Bearer <token>`.
 * Errors use `ManagerErrorBody` ({ error: { code, message } }) with the statuses in `ERROR_STATUS`.
 *
 *   GET    /health                             liveness only: { ok: true } (no auth, no details)
 *   GET    /v1/health                          health()                      -> { ok, docker }
 *   POST   /v1/images/ensure                   ensureImage({ image })        -> 204
 *   POST   /v1/computers                       create(ComputerSpec)          -> 201 CreateComputerResult
 *   POST   /v1/computers/:id/start             start()                       -> 204
 *   POST   /v1/computers/:id/stop              stop({ timeoutSec? })         -> 204
 *   POST   /v1/computers/:id/restart           restart({ timeoutSec? })      -> 204
 *   POST   /v1/computers/:id/remove            remove(id, RemoveComputerRequest)            -> 204
 *   POST   /v1/volumes/remove                  remove(null, { volumes, removeVolumes: true }) -> 204
 *   GET    /v1/computers/:id/state             state()                       -> ContainerState
 *   GET    /v1/computers/:id/stats             stats()                       -> ContainerStats
 *   POST   /v1/volumes/usage                   volumeUsage({ volumes })      -> { [volume]: bytes }
 *   POST   /v1/computers/:id/backups           backup(BackupRequest)         -> 201 BackupResult
 *   POST   /v1/backups/:backupId/restore       restore(RestoreRequest without backupId) -> 201 CreateComputerResult
 *   DELETE /v1/backups/:backupId               deleteBackup()                -> 204
 *   GET    /v1/computers/:id/runner-channel    WebSocket: binary messages carry raw runner stdio bytes both ways
 *
 * Inputs are only shape-checked here; the manager implementation does the full validation.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import type { ManagerApi, ManagerErrorBody, RestoreRequest, RunnerChannel } from "@witden/shared";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { toBytes } from "./channel.js";
import { ManagerError, type ManagerErrorCode } from "./errors.js";

export interface ManagerServerOptions {
  token: string;
  logger?: FastifyServerOptions["logger"];
  bodyLimit?: number;
}

function errorBody(code: ManagerErrorCode, message: string): ManagerErrorBody {
  return { error: { code, message } };
}

function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ManagerError("invalid", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function timeoutOf(body: unknown): number | undefined {
  const t = objectBody(body).timeoutSec;
  if (t === undefined || t === null) return undefined;
  if (typeof t !== "number") throw new ManagerError("invalid", "timeoutSec must be a number");
  return t;
}

function param(request: FastifyRequest, name: string): string {
  return (request.params as Record<string, string>)[name];
}

/** WebSocket close reasons are limited to 123 bytes. */
export function closeReason(reason: string): string {
  const buf = Buffer.from(reason, "utf8");
  return buf.length <= 123 ? reason : buf.subarray(0, 120).toString("utf8").replace(/�+$/, "");
}

export function createManagerServer(manager: ManagerApi, options: ManagerServerOptions): FastifyInstance {
  if (!options.token) throw new Error("a manager token is required");
  // Hash both sides so the comparison is constant-time regardless of the header length.
  const expected = createHash("sha256").update(`Bearer ${options.token}`).digest();
  const authorized = (header: string | undefined) =>
    typeof header === "string" && timingSafeEqual(createHash("sha256").update(header).digest(), expected);

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: options.bodyLimit ?? 1024 * 1024 });

  // Registered before the auth hook: its own onRequest hook must mark upgrade requests first, otherwise a
  // rejected upgrade's socket is never destroyed.
  app.register(websocket);

  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url === "/health") return;
    if (!authorized(request.headers.authorization)) {
      return reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send(errorBody("unauthorized", "missing or invalid manager token"));
    }
  });

  app.setErrorHandler((err: FastifyError | ManagerError, request, reply) => {
    if (err instanceof ManagerError) return reply.code(err.status).send(errorBody(err.code, err.message));
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send(errorBody("invalid", err.message));
    request.log.error(err);
    return reply.code(500).send(errorBody("internal", "internal error"));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorBody("not_found", `no route for ${request.method} ${request.url.split("?")[0]}`)),
  );

  app.get("/health", async () => ({ ok: true }));

  app.register(async (api) => {
    api.get("/v1/health", async () => manager.health());

    api.post("/v1/images/ensure", async (request, reply) => {
      const { image } = objectBody(request.body);
      if (typeof image !== "string") throw new ManagerError("invalid", "image must be a string");
      await manager.ensureImage(image);
      return reply.code(204).send();
    });

    api.post("/v1/computers", async (request, reply) => {
      const result = await manager.create(objectBody(request.body) as never);
      return reply.code(201).send(result);
    });

    api.post("/v1/computers/:id/start", async (request, reply) => {
      await manager.start(param(request, "id"));
      return reply.code(204).send();
    });

    api.post("/v1/computers/:id/stop", async (request, reply) => {
      await manager.stop(param(request, "id"), timeoutOf(request.body));
      return reply.code(204).send();
    });

    api.post("/v1/computers/:id/restart", async (request, reply) => {
      await manager.restart(param(request, "id"), timeoutOf(request.body));
      return reply.code(204).send();
    });

    api.post("/v1/computers/:id/remove", async (request, reply) => {
      const body = objectBody(request.body);
      await manager.remove(param(request, "id"), {
        volumes: (body.volumes ?? []) as string[],
        removeVolumes: body.removeVolumes === true,
      });
      return reply.code(204).send();
    });

    api.post("/v1/volumes/remove", async (request, reply) => {
      const { volumes } = objectBody(request.body);
      if (!Array.isArray(volumes)) throw new ManagerError("invalid", "volumes must be an array");
      await manager.remove(null, { volumes, removeVolumes: true });
      return reply.code(204).send();
    });

    api.get("/v1/computers/:id/state", async (request) => manager.state(param(request, "id")));

    api.get("/v1/computers/:id/stats", async (request) => manager.stats(param(request, "id")));

    api.post("/v1/volumes/usage", async (request) => {
      const { volumes } = objectBody(request.body);
      if (!Array.isArray(volumes)) throw new ManagerError("invalid", "volumes must be an array");
      return manager.volumeUsage({ volumes });
    });

    api.post("/v1/computers/:id/backups", async (request, reply) => {
      const result = await manager.backup(param(request, "id"), objectBody(request.body) as never);
      return reply.code(201).send(result);
    });

    api.post("/v1/backups/:backupId/restore", async (request, reply) => {
      const body = objectBody(request.body);
      const backupId = param(request, "backupId");
      if (body.backupId !== undefined && body.backupId !== backupId) {
        throw new ManagerError("invalid", "backupId in the body does not match the path");
      }
      const result = await manager.restore({ ...body, backupId } as RestoreRequest);
      return reply.code(201).send(result);
    });

    api.post("/v1/computers/:id/packages", async (request) =>
      manager.packages(param(request, "id"), objectBody(request.body) as never),
    );

    api.delete("/v1/backups/:backupId", async (request, reply) => {
      await manager.deleteBackup(param(request, "backupId"));
      return reply.code(204).send();
    });

    // The channel is opened before the upgrade so failures are reported as normal HTTP errors.
    const channels = new WeakMap<FastifyRequest, RunnerChannel>();
    api.get(
      "/v1/computers/:id/runner-channel",
      {
        websocket: true,
        preHandler: async (request) => {
          if (!request.ws) throw new ManagerError("invalid", "this route requires a WebSocket upgrade");
          channels.set(request, await manager.openRunnerChannel(param(request, "id")));
        },
      },
      (socket, request) => {
        const channel = channels.get(request)!;
        channels.delete(request);
        channel.onData((data) => {
          if (socket.readyState === socket.OPEN) socket.send(data, { binary: true });
        });
        channel.onClose((reason) => {
          if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
            socket.close(1000, closeReason(reason));
          }
        });
        socket.on("message", (data, isBinary) => {
          if (!isBinary) {
            socket.close(1003, "binary messages only");
            return;
          }
          channel.send(toBytes(data));
        });
        socket.on("close", () => channel.close());
        socket.on("error", () => channel.close());
      },
    );
  });

  return app;
}

#!/usr/bin/env node
/**
 * Runs the Docker Manager as its own service.
 *
 *   WITDEN_MANAGER_TOKEN              required; bearer token callers must present (>= 16 characters)
 *   WITDEN_MANAGER_HOST               listen address (default 127.0.0.1)
 *   WITDEN_MANAGER_PORT               listen port (default 8340)
 *   WITDEN_MANAGER_DATA_DIR           backups and scratch files (default ./data/manager)
 *   DOCKER_HOST                       Docker daemon (also DOCKER_TLS_VERIFY / DOCKER_CERT_PATH)
 *   WITDEN_MANAGER_NETWORK            network for `bridge` computers (default witden-computers)
 *   WITDEN_MANAGER_INTERNAL_NETWORK   network for `internal` computers (default witden-computers-internal)
 *   WITDEN_MANAGER_ALLOWED_RUNTIMES   comma-separated runtimes specs may request (default runc,runsc,sysbox-runc,kata-runtime)
 *   WITDEN_MANAGER_RUNNER_COMMAND     stdio runner command, JSON array or space-separated
 *   WITDEN_MANAGER_RUNNER_USER        user the stdio runner runs as (default witden)
 *   WITDEN_MANAGER_LOG_LEVEL          pino log level (default info)
 *
 * In a container with the runner volume mounted at /opt/witden/runner-live (docker-compose.yml), it installs
 * the image's runner bundle there and mounts the volume read-only into the computers (live-runner.ts).
 */
import path from "node:path";
import { DockerManager } from "./docker-manager.js";
import { createManagerServer } from "./http-server.js";

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function command(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  if (value.trim().startsWith("[")) {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === "string")) {
      throw new Error("WITDEN_MANAGER_RUNNER_COMMAND must be a JSON array of strings");
    }
    return parsed;
  }
  return value.trim().split(/\s+/);
}

async function main(): Promise<void> {
  const env = process.env;
  const token = env.WITDEN_MANAGER_TOKEN ?? "";
  if (token.length < 16) throw new Error("WITDEN_MANAGER_TOKEN must be set (at least 16 characters)");
  const port = Number(env.WITDEN_MANAGER_PORT || 8340);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WITDEN_MANAGER_PORT is not a valid port");

  const manager = new DockerManager({
    dataDir: path.resolve(env.WITDEN_MANAGER_DATA_DIR || "data/manager"),
    bridgeNetwork: env.WITDEN_MANAGER_NETWORK,
    internalNetwork: env.WITDEN_MANAGER_INTERNAL_NETWORK,
    allowedRuntimes: list(env.WITDEN_MANAGER_ALLOWED_RUNTIMES),
    runnerCommand: command(env.WITDEN_MANAGER_RUNNER_COMMAND),
    runnerUser: env.WITDEN_MANAGER_RUNNER_USER,
    liveRunner: {},
  });
  const app = createManagerServer(manager, { token, logger: { level: env.WITDEN_MANAGER_LOG_LEVEL || "info" } });
  await app.listen({ host: env.WITDEN_MANAGER_HOST || "127.0.0.1", port });

  const health = await manager.health();
  if (health.ok) app.log.info(`docker ${health.docker}`);
  else app.log.warn(`docker is not reachable yet: ${health.docker}`);
  manager.setUpLiveRunner().then((live) => {
    if (!live) return;
    if (live.retry) app.log.warn(live.problem);
    else if (!live.volume) app.log.info(`computers run their image's runner: ${live.problem}`);
    else if (live.problem) app.log.warn(`runner volume ${live.volume}: ${live.problem}`);
    else app.log.info({ install: live.install }, `computers run runner ${live.version} from volume ${live.volume}`);
  });

  const shutdown = () => {
    app.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

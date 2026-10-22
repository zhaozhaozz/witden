#!/usr/bin/env node
import { createRunnerCore } from "./core.js";
import { RESTART_NOW, UPDATE_SIGNAL } from "./live.js";
import { createStderrLogger, parseLogLevel } from "./log.js";
import { serveStdio } from "./transports/stdio.js";
import { WebSocketClient } from "./transports/websocket.js";
import { RUNNER_VERSION } from "./version.js";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(`${RUNNER_VERSION}\n`);
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write(
    "Usage: witden-runner [--stdio]\n\n" +
      "Connects to WITDEN_HUB_URL and executes operations inside this computer.\n" +
      "--stdio  speak the runner protocol over stdin/stdout instead (Docker Manager fallback channel).\n",
  );
  process.exit(0);
}

const logger = createStderrLogger(parseLogLevel(process.env.WITDEN_RUNNER_LOG_LEVEL));

// Everything the runner does is done with its own rights; running as root would hand those to every role.
if (process.getuid?.() === 0 && process.env.WITDEN_RUNNER_ALLOW_ROOT !== "1") {
  logger.error("refusing to run as root; start the runner as the computer's unprivileged user");
  process.exit(78);
}

process.on("uncaughtException", (err) => logger.error("uncaught exception", { error: err.stack ?? String(err) }));
process.on("unhandledRejection", (err) => logger.error("unhandled rejection", { error: String(err) }));

/** How long a runner asked to make way for another version waits for running operations (they are interrupted then). */
const UPDATE_WAIT_MS = 10 * 60_000;

const core = createRunnerCore({ logger });
let client: WebSocketClient | null = null;

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info("stopping", { signal });
  client?.stop();
  await core.shutdown();
  process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

// witden-init asks for this when the platform installed another runner version (live.ts): once nothing is running,
// the hub connection is closed first (anything still running at the cap is then "outcome uncertain" to the
// platform, which asks the next runner's journal), and witden-init starts the new version at once. Commands,
// terminals and the desktop browser run outside this process and are taken over by the next one.
let updating = false;
process.on(UPDATE_SIGNAL, async () => {
  if (updating || stopping) return;
  updating = true;
  logger.info("another runner version is ready; restarting once no operation is running");
  const idle = await core.idle(UPDATE_WAIT_MS);
  if (stopping) return;
  stopping = true;
  if (!idle) logger.warn("operations still running; interrupting them for the update", { running: core.inflightCount });
  client?.stop();
  core.detachCurrent();
  await core.shutdown("update");
  process.exit(RESTART_NOW);
});

if (args.includes("--stdio")) {
  await serveStdio(core);
  // The channel is gone; let running requests finish so their outcome lands in the journal.
  await core.drain();
  await core.shutdown();
  process.exit(0);
} else if (process.env.WITDEN_HUB_URL) {
  client = new WebSocketClient(core, { url: process.env.WITDEN_HUB_URL });
  client.start();
} else {
  logger.info("WITDEN_HUB_URL is not set; idling (the platform can use the --stdio channel)");
  setInterval(() => {}, 1 << 30);
}

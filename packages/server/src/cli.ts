#!/usr/bin/env node
/** witden command line: serve (api | worker | all), create-admin, gen-key, seed-templates. */
import { parseArgs } from "node:util";
import { loadSettings, setSettings } from "./config.js";
import { openDatabase, setDatabase, transaction } from "./db/client.js";
import { initSecretBox, SecretBox } from "./security/crypto.js";
import { seedBuiltinTemplates } from "./services/templates.js";
import { bootstrap, createUser } from "./services/users.js";

const USAGE = `usage: witden <command> [options]

commands:
  serve [--role all|api|worker] [--port N]   run the platform (default role: WITDEN_PROCESS_ROLE or all)
  create-admin --email E --password P [--name N]
  seed-templates                             create the built-in computer templates if missing
  gen-key                                    print a new master key for WITDEN_SECRET_KEY`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      role: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      name: { type: "string" },
    },
    allowPositionals: true,
  });
  if (command === "gen-key") {
    console.log(SecretBox.generateKey());
    return 0;
  }
  const settings = loadSettings({
    ...(values.role ? { processRole: values.role as "all" | "api" | "worker" } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.host ? { host: values.host } : {}),
  });
  if (command === "serve") {
    const { start } = await import("./app.js");
    const witden = await start({ settings });
    if (witden.app) {
      await witden.app.listen({ port: settings.port, host: settings.host });
      console.log(
        `[witden] ${settings.processRole} listening on ${settings.host}:${settings.port}, runner hub on :${settings.hubPort}`,
      );
    } else {
      console.log("[witden] worker started");
    }
    const stop = async () => {
      await witden.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return -1; // keep running
  }
  setSettings(settings);
  setDatabase(await openDatabase(settings.databaseUrl));
  initSecretBox(settings);
  if (command === "create-admin") {
    if (!values.email || !values.password) throw new Error("--email and --password are required");
    const user = await transaction(async (tx) => {
      await bootstrap(tx, settings);
      return createUser(tx, {
        name: values.name ?? "admin",
        email: values.email,
        password: values.password,
      });
    });
    console.log(`created admin ${user.email} (${user.id})`);
    return 0;
  }
  if (command === "seed-templates") {
    await transaction((tx) => seedBuiltinTemplates(tx, settings));
    console.log("built-in templates ready");
    return 0;
  }
  console.error(USAGE);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    console.error(`[witden] ${(err as Error).message}`);
    process.exit(1);
  },
);

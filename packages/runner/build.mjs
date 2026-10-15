// Bundles the runner and the images' init (witden-runner.mjs, witden-init.mjs) into one directory for the
// computer images (node build.mjs [--outdir dir]). `ws` and the shared protocol are inlined; playwright-core
// stays external (installed next to the bundles).
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const outIndex = process.argv.indexOf("--outdir");
const outdir = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : path.join(here, "dist");

await esbuild.build({
  entryPoints: { "witden-runner": path.join(here, "src", "main.ts"), "witden-init": path.join(here, "src", "init.ts") },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  alias: { "@witden/shared": path.join(here, "..", "shared", "src", "index.ts") },
  external: ["playwright-core", "bufferutil", "utf-8-validate"],
  // CommonJS dependencies (ws) call require() for Node built-ins.
  banner: { js: 'import { createRequire as __witdenCreateRequire } from "node:module";\nconst require = __witdenCreateRequire(import.meta.url);' },
  logLevel: "warning",
});
console.log(`bundled witden-runner.mjs and witden-init.mjs into ${path.relative(process.cwd(), outdir) || "."}`);

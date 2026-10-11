// Bundles the runner into one ESM file for the computer images (node build.mjs [--outfile path]).
// `ws` and the shared protocol are inlined; playwright-core stays external (installed next to the bundle).
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const outIndex = process.argv.indexOf("--outfile");
const outfile = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : path.join(here, "dist", "witden-runner.mjs");

await esbuild.build({
  entryPoints: [path.join(here, "src", "main.ts")],
  outfile,
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
console.log(`bundled ${path.relative(process.cwd(), outfile)}`);

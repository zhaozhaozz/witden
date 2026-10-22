// Bundles the runner and the images' init (witden-runner.mjs, witden-init.mjs) into one directory for the
// computer images and the platform image (node build.mjs [--outdir dir] [--with-playwright-core]). `ws` and the
// shared protocol are inlined; playwright-core stays external (copied next to the bundles with
// --with-playwright-core). manifest.json names the result: a hash of its files, the lowest Node.js major it runs
// on and the witden-init protocol it needs, which witden-init checks before it runs a bundle the platform
// installed (src/live.ts). The same sources and dependency versions give the same version.
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const NODE_MAJOR = 22;
const BUNDLE = ["witden-runner.mjs", "witden-init.mjs", "node_modules"];

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
  target: `node${NODE_MAJOR}`,
  sourcemap: false,
  legalComments: "none",
  alias: { "@witden/shared": path.join(here, "..", "shared", "src", "index.ts") },
  external: ["playwright-core", "bufferutil", "utf-8-validate"],
  // CommonJS dependencies (ws) call require() for Node built-ins.
  banner: { js: 'import { createRequire as __witdenCreateRequire } from "node:module";\nconst require = __witdenCreateRequire(import.meta.url);' },
  logLevel: "warning",
});

if (process.argv.includes("--with-playwright-core")) {
  const source = path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json"));
  const target = path.join(outdir, "node_modules", "playwright-core");
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

/** Files of the bundle (relative paths, sorted); a bundle holds no links or special files. */
function files(rel) {
  const abs = path.join(outdir, rel);
  const st = lstatSync(abs);
  if (st.isFile()) return [rel];
  if (!st.isDirectory()) throw new Error(`${abs}: not a file or directory`);
  return readdirSync(abs)
    .sort()
    .flatMap((name) => files(path.join(rel, name)));
}

// The init states its protocol itself; importing it runs nothing (it starts only as the entry point).
const { INIT_PROTOCOL } = await import(pathToFileURL(path.join(outdir, "witden-init.mjs")).href);
const hash = createHash("sha256").update(JSON.stringify({ node: NODE_MAJOR, init: INIT_PROTOCOL }));
for (const file of BUNDLE.filter((f) => existsSync(path.join(outdir, f))).flatMap(files)) {
  const data = readFileSync(path.join(outdir, file));
  hash.update(`${file}\0${data.length}\0`).update(data);
}
const manifest = { version: hash.digest("hex").slice(0, 12), node: NODE_MAJOR, init: INIT_PROTOCOL };
writeFileSync(path.join(outdir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
console.log(`bundled the runner ${manifest.version} into ${path.relative(process.cwd(), outdir) || "."}`);

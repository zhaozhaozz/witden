import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { abortError } from "../src/errors.js";
import { RunnerKeeper } from "../src/init.js";
import { INIT_PROTOCOL, type PickOptions, pickRunner, RESTART_NOW, runnerBuild, sameRunner } from "../src/live.js";
import { errorCode, makeRunner, ok, SCRATCH, waitUntil } from "./helpers.js";

const root = path.join(SCRATCH, `live-${process.pid}-${randomBytes(3).toString("hex")}`);
const uid = process.getuid?.() ?? 0;
const node = Number(process.versions.node.split(".")[0]);

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fake runner bundle: logs its start, exits RESTART_NOW when asked to restart (or `exit` right away). */
function bundle(dir: string, version: string, manifest: Record<string, unknown> = {}, exit?: number): void {
  mkdirSync(dir, { recursive: true });
  const log = path.join(root, "log");
  writeFileSync(
    path.join(dir, "witden-runner.mjs"),
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "${version} start\\n");
${exit === undefined ? "" : `process.exit(${exit});`}
process.on("SIGUSR2", () => { appendFileSync(${JSON.stringify(log)}, "${version} asked\\n"); process.exit(${RESTART_NOW}); });
setInterval(() => {}, 1000);
`,
  );
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ version, node: 22, init: INIT_PROTOCOL, ...manifest }),
  );
  chmodSync(dir, 0o755);
  for (const f of ["witden-runner.mjs", "manifest.json"]) chmodSync(path.join(dir, f), 0o644);
}

/** A runner volume as the manager leaves it, with `current` at `version`. */
function live(name: string, versions: Record<string, Record<string, unknown>>, current: string): string {
  const dir = path.join(root, name);
  for (const [v, m] of Object.entries(versions)) bundle(path.join(dir, "versions", v), v, m);
  chmodSync(dir, 0o755);
  chmodSync(path.join(dir, "versions"), 0o755);
  switchTo(dir, current);
  return dir;
}

function switchTo(dir: string, version: string): void {
  const tmp = path.join(dir, `.current-${randomBytes(3).toString("hex")}`);
  symlinkSync(path.join("versions", version), tmp);
  renameSync(tmp, path.join(dir, "current"));
}

const imageDir = path.join(root, "image");
bundle(imageDir, "aaaaaaaaaaaa");

describe("which runner witden-init starts", () => {
  const opts = (liveDir: string, more: PickOptions = {}): PickOptions => ({ liveDir, owner: uid, ...more });

  it("prefers the platform's copy when it runs here", () => {
    const dir = live("ok", { "111111111111": {} }, "111111111111");
    expect(pickRunner(imageDir, opts(dir))).toEqual({
      dir: path.join(dir, "versions", "111111111111"),
      source: "live",
      version: "111111111111",
    });
  });

  it("uses the image's copy without the volume, or when nothing is installed yet", () => {
    expect(pickRunner(imageDir, opts(path.join(root, "missing")))).toEqual({
      dir: imageDir,
      source: "image",
      version: "aaaaaaaaaaaa",
    });
    const empty = path.join(root, "empty");
    mkdirSync(empty, { mode: 0o755 });
    expect(pickRunner(imageDir, opts(empty)).source).toBe("image");
  });

  it("uses the image's copy when the platform's needs a newer node or init", () => {
    const newerNode = live("node", { "222222222222": { node: node + 1 } }, "222222222222");
    expect(pickRunner(imageDir, opts(newerNode)).source).toBe("image");
    const newerInit = live("init", { "333333333333": { init: INIT_PROTOCOL + 1 } }, "333333333333");
    expect(pickRunner(imageDir, opts(newerInit)).source).toBe("image");
    const broken = live("manifest", { "444444444444": { version: "555555555555" } }, "444444444444");
    expect(pickRunner(imageDir, opts(broken)).source).toBe("image");
  });

  it("uses the image's copy unless the platform's is sealed: one owner, nobody else may write", () => {
    const dir = live("sealed", { "666666666666": {} }, "666666666666");
    // Not root's (the computers' default owner)
    expect(pickRunner(imageDir, { liveDir: dir }).source).toBe("image");
    const file = path.join(dir, "versions", "666666666666", "witden-runner.mjs");
    chmodSync(file, 0o666);
    expect(pickRunner(imageDir, opts(dir)).source).toBe("image");
    chmodSync(file, 0o644);
    chmodSync(path.join(dir, "versions"), 0o777);
    expect(pickRunner(imageDir, opts(dir)).source).toBe("image");
    chmodSync(path.join(dir, "versions"), 0o755);
    // a link to code elsewhere
    symlinkSync(imageDir, path.join(dir, "versions", "666666666666", "lib"));
    expect(pickRunner(imageDir, opts(dir)).source).toBe("image");
    rmSync(path.join(dir, "versions", "666666666666", "lib"));
    expect(pickRunner(imageDir, opts(dir)).source).toBe("live");
    // `current` must point into versions/
    rmSync(path.join(dir, "current"));
    symlinkSync(imageDir, path.join(dir, "current"));
    expect(pickRunner(imageDir, opts(dir)).source).toBe("image");
  });

  it("skips a version it was told to avoid", () => {
    const dir = live("avoid", { "777777777777": {} }, "777777777777");
    expect(pickRunner(imageDir, opts(dir, { avoid: "777777777777" })).source).toBe("image");
  });

  it("tells runs of the same code apart from others", () => {
    const a = { dir: "/a", source: "image" as const, version: "111111111111" };
    expect(sameRunner(a, { dir: "/b", source: "live", version: "111111111111" })).toBe(true);
    expect(sameRunner(a, { ...a, version: "222222222222" })).toBe(false);
    expect(sameRunner({ ...a, version: null }, { ...a, version: null })).toBe(true);
    expect(sameRunner({ ...a, version: null }, { ...a, dir: "/b", version: null })).toBe(false);
  });

  it("reports the bundle a runner runs from", () => {
    const dir = live("build", { "888888888888": {} }, "888888888888");
    const file = path.join(dir, "versions", "888888888888", "witden-runner.mjs");
    expect(runnerBuild(file, dir)).toEqual({ version: "888888888888", source: "live" });
    expect(runnerBuild(path.join(imageDir, "witden-runner.mjs"), dir)).toEqual({
      version: "aaaaaaaaaaaa",
      source: "image",
    });
    // run from sources (tests, development)
    expect(runnerBuild()).toBeUndefined();
  });
});

describe("witden-init keeping the runner", () => {
  const log = () => {
    try {
      return readFileSync(path.join(root, "log"), "utf8").trim().split("\n");
    } catch {
      return []; // nothing started yet
    }
  };
  const children: ChildProcess[] = [];
  let stopping = false;
  afterAll(() => {
    stopping = true;
    for (const c of children) c.kill("SIGKILL");
  });
  const keeper = (liveDir: string, restartMs: number) =>
    new RunnerKeeper(
      (avoid) => pickRunner(imageDir, { liveDir, owner: uid, avoid }),
      (r) => {
        const child = spawn(process.execPath, [path.join(r.dir, "witden-runner.mjs")], { stdio: "ignore" });
        children.push(child);
        return child;
      },
      () => stopping,
      restartMs,
    );

  it("asks the runner to restart for another version, and starts that one at once", async () => {
    rmSync(path.join(root, "log"), { force: true });
    const dir = live("switch", { aaaaaaaaaa01: {} }, "aaaaaaaaaa01");
    const k = keeper(dir, 60_000);
    k.kept.run();
    await waitUntil(() => log().includes("aaaaaaaaaa01 start"));
    k.poll();
    expect(k.kept.child?.exitCode).toBeNull();

    bundle(path.join(dir, "versions", "aaaaaaaaaa02"), "aaaaaaaaaa02");
    switchTo(dir, "aaaaaaaaaa02");
    k.poll();
    // well before the 60 s an ordinary exit waits
    await waitUntil(() => log().includes("aaaaaaaaaa02 start"), 5_000);
    expect(log()).toEqual(["aaaaaaaaaa01 start", "aaaaaaaaaa01 asked", "aaaaaaaaaa02 start"]);
    expect(k.running).toMatchObject({ source: "live", version: "aaaaaaaaaa02" });
    k.kept.child?.kill("SIGKILL");
  });

  it("sets a platform version that keeps failing aside for the image's copy, until another arrives", async () => {
    rmSync(path.join(root, "log"), { force: true });
    const dir = path.join(root, "failing");
    mkdirSync(path.join(dir, "versions"), { recursive: true });
    bundle(path.join(dir, "versions", "bbbbbbbbbb01"), "bbbbbbbbbb01", {}, 1);
    chmodSync(dir, 0o755);
    chmodSync(path.join(dir, "versions"), 0o755);
    switchTo(dir, "bbbbbbbbbb01");
    const k = keeper(dir, 50);
    k.kept.run();
    await waitUntil(() => log().includes("aaaaaaaaaaaa start"));
    expect(log()).toEqual(["bbbbbbbbbb01 start", "bbbbbbbbbb01 start", "bbbbbbbbbb01 start", "aaaaaaaaaaaa start"]);
    expect(k.running?.source).toBe("image");
    k.poll(); // still the failing version: nothing to do
    expect(log()).not.toContain("aaaaaaaaaaaa asked");

    bundle(path.join(dir, "versions", "bbbbbbbbbb02"), "bbbbbbbbbb02");
    switchTo(dir, "bbbbbbbbbb02");
    k.poll();
    await waitUntil(() => log().includes("bbbbbbbbbb02 start"));
    expect(log().slice(-2)).toEqual(["aaaaaaaaaaaa asked", "bbbbbbbbbb02 start"]);
    k.kept.child?.kill("SIGKILL");
  });
});

describe("a runner making way for another version", () => {
  const { core, hub } = makeRunner("update");
  afterAll(() => core.shutdown());

  it("waits until nothing is running", async () => {
    expect(await core.idle(1000)).toBe(true);
    const running = hub.request("exec.run", { command: "sleep 1; echo done" });
    await waitUntil(() => core.inflightCount === 1);
    const started = Date.now();
    expect(await core.idle(10_000, 50)).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(500);
    expect(ok(await running).output).toContain("done");
  });

  it("gives up waiting after the cap", async () => {
    const running = hub.request("exec.run", { command: "sleep 30" });
    await waitUntil(() => core.inflightCount === 1);
    expect(await core.idle(300, 50)).toBe(false);
    await core.shutdown("update");
    // the command was stopped; the platform learns that from the journal
    expect(ok(await running).killed).toBe(true);
    expect(errorCode(await hub.request("file.stat", { path: "/" }))).toBe("failed");
  });

  it("tells the platform an interrupted operation's outcome is uncertain", () => {
    const err = abortError(AbortSignal.abort("update"));
    expect(err.code).toBe("failed");
    expect(err.message).toContain("outcome is uncertain");
  });
});

/** The runner volume: installing, switching and pruning versions, finding the volume, mounting it into computers. */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ComputerSpec, RUNNER_LIVE_DIR } from "@witden/shared";
import type Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { DockerManager } from "../src/docker-manager.js";
import { currentVersion, installRunner, LiveRunner, ownContainerId } from "../src/live-runner.js";

const root = path.join(
  fileURLToPath(new URL("../../../.tmp/manager", import.meta.url)),
  `live-${process.pid}-${randomBytes(3).toString("hex")}`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const HOUR = 3600_000;

/** A runner bundle as the platform image carries it. */
function bundle(version: string): string {
  const dir = path.join(root, "bundles", version);
  mkdirSync(path.join(dir, "node_modules", "playwright-core"), { recursive: true });
  writeFileSync(path.join(dir, "witden-runner.mjs"), `// runner ${version}\n`);
  writeFileSync(path.join(dir, "node_modules", "playwright-core", "index.js"), "module.exports = {};\n");
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version, node: 22, init: 1 }));
  chmodSync(path.join(dir, "witden-runner.mjs"), 0o664);
  return dir;
}

function volume(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const names = (dir: string) => readdirSync(dir).sort();
const versions = (live: string) => names(path.join(live, "versions"));

describe("installing the runner into its volume", () => {
  it("installs a bundle as a complete version and points current at it", () => {
    const live = volume("first");
    const r = installRunner(bundle("aaaaaaaaaa01"), live);
    expect(r).toEqual({ version: "aaaaaaaaaa01", copied: true, switched: true, removed: [] });
    expect(readlinkSync(path.join(live, "current"))).toBe("versions/aaaaaaaaaa01");
    expect(currentVersion(live)).toBe("aaaaaaaaaa01");
    const dir = path.join(live, "versions", "aaaaaaaaaa01");
    expect(readFileSync(path.join(dir, "node_modules", "playwright-core", "index.js"), "utf8")).toContain("exports");
    // nobody but the owner (root, in production) may write
    expect(lstatSync(dir).mode & 0o777).toBe(0o755);
    expect(lstatSync(path.join(dir, "witden-runner.mjs")).mode & 0o777).toBe(0o644);
    expect(lstatSync(live).mode & 0o777).toBe(0o755);
    // again: nothing to do
    expect(installRunner(bundle("aaaaaaaaaa01"), live)).toEqual({
      version: "aaaaaaaaaa01",
      copied: false,
      switched: false,
      removed: [],
    });
  });

  it("switches back to a version it still has without copying it", () => {
    const live = volume("rollback");
    installRunner(bundle("bbbbbbbbbb01"), live, { now: Date.now() - HOUR });
    installRunner(bundle("bbbbbbbbbb02"), live);
    expect(installRunner(bundle("bbbbbbbbbb01"), live)).toMatchObject({ copied: false, switched: true });
    expect(currentVersion(live)).toBe("bbbbbbbbbb01");
  });

  it("keeps the previous versions and recently replaced ones, removes the rest", () => {
    const live = volume("prune");
    const t0 = Date.now() - 10 * HOUR;
    for (let i = 1; i <= 5; i++) installRunner(bundle(`cccccccccc0${i}`), live, { now: t0 + i * HOUR });
    // current (05) and three before it; 01 was replaced (by 02) long ago
    expect(versions(live)).toEqual(["cccccccccc02", "cccccccccc03", "cccccccccc04", "cccccccccc05"]);
    // Updates minutes apart: a version replaced in the last hour stays beyond the three (runners may still use it).
    const t1 = t0 + 6 * HOUR;
    const removed = [6, 7, 8, 9].flatMap(
      (i, n) => installRunner(bundle(`cccccccccc0${i}`), live, { now: t1 + n * 60_000 }).removed,
    );
    expect(removed).toEqual(["cccccccccc02", "cccccccccc03", "cccccccccc04"]);
    expect(versions(live)).toEqual(["cccccccccc05", "cccccccccc06", "cccccccccc07", "cccccccccc08", "cccccccccc09"]);
    // later, the extra one goes too
    expect(installRunner(bundle("cccccccccc09"), live, { now: t1 + 2 * HOUR }).removed).toEqual(["cccccccccc05"]);
  });

  it("refuses a bundle without a manifest or with links, leaving the volume as it was", () => {
    const live = volume("refuse");
    installRunner(bundle("dddddddddd01"), live);
    const empty = path.join(root, "bundles", "empty");
    mkdirSync(empty, { recursive: true });
    expect(() => installRunner(empty, live)).toThrow(/no runner bundle/);
    const linked = bundle("dddddddddd02");
    symlinkSync("/etc/passwd", path.join(linked, "passwd"));
    expect(() => installRunner(linked, live)).toThrow(/only files and directories/);
    expect(versions(live)).toEqual(["dddddddddd01"]);
    expect(currentVersion(live)).toBe("dddddddddd01");
  });

  it("removes what an installer stopped halfway left behind", () => {
    const live = volume("leftovers");
    mkdirSync(path.join(live, "versions", ".eeeeeeeeee01-1234"), { recursive: true });
    symlinkSync("versions/nothing", path.join(live, ".current-1234"));
    installRunner(bundle("eeeeeeeeee02"), live);
    expect(versions(live)).toEqual(["eeeeeeeeee02"]);
    expect(names(live)).toEqual(["current", "versions"]);
  });
});

const ID = "f".repeat(64);
const MOUNTINFO = [
  "612 588 0:52 / / rw,relatime master:303 - overlay overlay rw,lowerdir=/x",
  `640 612 259:2 /var/lib/docker/containers/${ID}/hostname /etc/hostname rw,relatime - ext4 /dev/nvme0n1p2 rw`,
  "641 612 259:2 /var/lib/docker/volumes/witden_witden-runner/_data /opt/witden/runner-live rw - ext4 /dev/x rw",
].join("\n");

it("finds its own container id in /proc/self/mountinfo", () => {
  expect(ownContainerId(MOUNTINFO)).toBe(ID);
  expect(ownContainerId("612 588 0:52 / / rw - overlay overlay rw")).toBeNull();
});

/** Just enough of dockerode for creating computers and finding the manager's own container. */
function fakeDocker(self: { id: string; mounts: Record<string, unknown>[] } | "missing" | "down") {
  const created: Docker.ContainerCreateOptions[] = [];
  const notFound = () => Object.assign(new Error("no such object"), { statusCode: 404 });
  const docker = {
    created,
    getImage: () => ({ inspect: async () => ({ Config: { Labels: { "witden.init": "protected" } } }) }),
    getNetwork: () => ({
      inspect: async () => ({
        Labels: { "witden.managed": "true" },
        Internal: false,
        Options: { "com.docker.network.bridge.enable_icc": "false" },
      }),
    }),
    getVolume: () => ({
      inspect: async () => {
        throw notFound();
      },
    }),
    createVolume: async () => ({}),
    createContainer: async (options: Docker.ContainerCreateOptions) => {
      created.push(options);
      return { id: `c${created.length}` };
    },
    getContainer: (ref: string) => ({
      ref,
      inspect: async () => {
        if (self === "down") throw Object.assign(new Error("connect ENOENT /var/run/docker.sock"), { statusCode: 500 });
        if (self === "missing" || ref !== self.id) throw notFound();
        return { Id: self.id, Mounts: self.mounts };
      },
    }),
  };
  return docker as unknown as Docker & { created: Docker.ContainerCreateOptions[] };
}

function spec(name: string): ComputerSpec {
  return {
    instanceId: `inst_${name}`,
    name,
    image: "witden/computer-shell:latest",
    workdir: "/home/witden",
    command: null,
    env: {},
    volumes: { "/home/witden": `witden-${name}-home` },
    resources: {},
    network: "bridge",
    capAdd: [],
    runtime: null,
    runner: { token: "0123456789abcdef0123", hubUrl: "ws://witden-hub:8330/runner" },
  } as unknown as ComputerSpec;
}

describe("the runner volume of the computers", () => {
  const liveMount = { Type: "volume", Name: "witden_witden-runner", Destination: RUNNER_LIVE_DIR, RW: true };

  it("is found in the manager's own container and gets the platform image's bundle", async () => {
    const live = volume("setup");
    const docker = fakeDocker({ id: ID, mounts: [{ ...liveMount, Destination: live }] });
    const execs: { ref: string; cmd: string[] }[] = [];
    const runner = new LiveRunner(docker, {
      bundleDir: bundle("ffffffffff01"),
      liveDir: live,
      mountinfo: () => MOUNTINFO,
      // `docker exec` as root into the manager's container; here the installer runs in this process
      exec: async (container, cmd) => {
        execs.push({ ref: (container as any).ref, cmd });
        const [, , bundleDir, liveDir] = cmd;
        return { code: 0, output: `${JSON.stringify(installRunner(bundleDir, liveDir))}\n` };
      },
    });
    const status = await runner.setUp();
    expect(status).toMatchObject({ volume: "witden_witden-runner", version: "ffffffffff01" });
    expect(status.install).toMatchObject({ copied: true, switched: true });
    expect(execs).toHaveLength(1);
    expect(execs[0].ref).toBe(ID);
    expect(execs[0].cmd[1]).toMatch(/live-runner\.(ts|js)$/);
    // once per manager process
    expect(await runner.volume()).toBe("witden_witden-runner");
    expect(execs).toHaveLength(1);

    // A manager started from the same image again finds its version current: no install.
    const again = new LiveRunner(docker, {
      bundleDir: bundle("ffffffffff01"),
      liveDir: live,
      mountinfo: () => MOUNTINFO,
      exec: async () => {
        throw new Error("not expected");
      },
    });
    expect(await again.setUp()).toEqual({ volume: "witden_witden-runner", version: "ffffffffff01" });
  });

  it("is absent outside a container or without the mount, and looked for again after Docker failed", async () => {
    const exec = async () => ({ code: 1, output: "" });
    const outside = new LiveRunner(fakeDocker("missing"), { exec, mountinfo: () => "", hostname: () => "laptop" });
    expect(await outside.setUp()).toMatchObject({ volume: null });
    const unmounted = new LiveRunner(fakeDocker({ id: ID, mounts: [] }), { exec, mountinfo: () => MOUNTINFO });
    expect(await unmounted.setUp()).toMatchObject({
      volume: null,
      problem: expect.stringContaining("no runner volume"),
    });
    const down = new LiveRunner(fakeDocker("down"), { exec, mountinfo: () => MOUNTINFO });
    expect(await down.setUp()).toMatchObject({ volume: null, retry: true });
    expect((down as any).setup).toBeNull();
  });

  it("reports an install that failed, and still mounts what the volume has", async () => {
    const live = volume("failed");
    const docker = fakeDocker({ id: ID, mounts: [{ ...liveMount, Destination: live }] });
    const runner = new LiveRunner(docker, {
      bundleDir: bundle("ffffffffff02"),
      liveDir: live,
      mountinfo: () => MOUNTINFO,
      exec: async () => ({ code: 1, output: "the runner installer runs as root" }),
    });
    expect(await runner.setUp()).toMatchObject({
      volume: "witden_witden-runner",
      version: null,
      problem: expect.stringContaining("runs as root"),
    });
  });

  it("is mounted read-only into every computer, never copied into from an image", async () => {
    const docker = fakeDocker({ id: ID, mounts: [liveMount] });
    const manager = new DockerManager({
      docker,
      dataDir: path.join(root, "data"),
      liveRunner: { bundleDir: path.join(root, "no-bundle"), mountinfo: () => MOUNTINFO },
    });
    await manager.create(spec("box-live"));
    const mounts = docker.created[0].HostConfig?.Mounts ?? [];
    expect(mounts).toEqual([
      { Type: "volume", Source: "witden-box-live-home", Target: "/home/witden", ReadOnly: false },
      {
        Type: "volume",
        Source: "witden_witden-runner",
        Target: RUNNER_LIVE_DIR,
        ReadOnly: true,
        VolumeOptions: { NoCopy: true },
      },
    ]);
    expect(docker.created[0].HostConfig?.Binds).toBeUndefined();

    // without the runner volume, only the computer's own volumes
    const plain = fakeDocker({ id: ID, mounts: [liveMount] });
    await new DockerManager({ docker: plain, dataDir: path.join(root, "data") }).create(spec("box-plain"));
    expect((plain.created[0].HostConfig?.Mounts ?? []).map((m) => m.Target)).toEqual(["/home/witden"]);
  });
});

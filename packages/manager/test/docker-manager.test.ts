/**
 * Integration tests against a real Docker daemon. Run with WITDEN_DOCKER_TESTS=1 (needs debian:bookworm-slim).
 * Every object gets a per-run prefix and is removed in afterAll.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { type ComputerSpec, DEFAULT_CAPS, type RunnerChannel } from "@witden/shared";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { ManagerClient } from "../src/client.js";
import { DockerManager } from "../src/docker-manager.js";
import { createManagerServer } from "../src/http-server.js";

const enabled = process.env.WITDEN_DOCKER_TESTS === "1";
const IMAGE = "debian:bookworm-slim";
const SLOW = 180_000;

const docker = new Docker();
const run = randomBytes(3).toString("hex");
const prefix = `mgrtest-${run}`;
const dataDir = path.join(fileURLToPath(new URL("../../../.tmp/manager", import.meta.url)), `docker-${run}`);
const nets = { bridge: `witden-test-mgr-${run}`, internal: `witden-test-mgr-${run}-internal` };
const backupImages: string[] = [];

function makeSpec(suffix: string, overrides: Partial<ComputerSpec> = {}): ComputerSpec {
  const name = `${prefix}-${suffix}`;
  return {
    instanceId: `inst_${run}_${suffix}`,
    name,
    image: IMAGE,
    workdir: "/workspace",
    user: "1000:1000",
    command: ["sleep", "infinity"],
    env: { GREETING: "hello" },
    volumes: { "/home/witden": `witden-${name}-home`, "/workspace": `witden-${name}-ws` },
    resources: { cpus: 0.5, memoryMb: 256, pidsLimit: 128, diskGb: 2 },
    network: "bridge",
    capAdd: [],
    runtime: null,
    runner: { token: `token-${run}-${suffix}-0123456789`, hubUrl: "http://witden-hub:8320" },
    ...overrides,
  };
}

/** Test-side shell inside a container (the manager itself exposes no generic exec). */
async function sh(containerId: string, script: string): Promise<{ code: number; out: string }> {
  const exec = await docker
    .getContainer(containerId)
    .exec({ Cmd: ["sh", "-c", script], AttachStdout: true, AttachStderr: true, User: "0" });
  const stream = await exec.start({});
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (c: Buffer) => chunks.push(c));
  docker.modem.demuxStream(stream, sink, sink);
  await new Promise((resolve) => stream.on("end", resolve));
  const { ExitCode } = await exec.inspect();
  return { code: ExitCode ?? -1, out: Buffer.concat(chunks).toString() };
}

function collect(channel: RunnerChannel, until: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve) =>
    channel.onData((data) => {
      chunks.push(Buffer.from(data));
      const all = Buffer.concat(chunks);
      if (all.length >= until) resolve(all);
    }),
  );
}

const caps = (list: string[] | undefined) => (list ?? []).map((c) => c.replace(/^CAP_/, "")).sort();

describe.skipIf(!enabled)("DockerManager with a real Docker daemon", () => {
  const manager = new DockerManager({
    docker,
    dataDir,
    bridgeNetwork: nets.bridge,
    internalNetwork: nets.internal,
    allowedRuntimes: ["runc"],
    // debian has neither node nor a witden user: `cat` as root is an echo "runner" for the channel tests.
    runnerCommand: ["cat"],
    runnerUser: "root",
  });
  const specA = makeSpec("a");
  const specClone = makeSpec("clone");
  const ids: Record<string, string> = {};
  const backupId = `bk-${run}-1`;
  let backup: Awaited<ReturnType<DockerManager["backup"]>>;

  afterAll(async () => {
    const containers = await docker.listContainers({ all: true, filters: { name: [prefix] } });
    for (const c of containers)
      await docker
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => undefined);
    const { Volumes } = await docker.listVolumes({ filters: { name: [prefix] } });
    for (const v of Volumes ?? [])
      await docker
        .getVolume(v.Name)
        .remove()
        .catch(() => undefined);
    for (const ref of backupImages)
      await docker
        .getImage(ref)
        .remove({ force: true })
        .catch(() => undefined);
    for (const n of Object.values(nets))
      await docker
        .getNetwork(n)
        .remove()
        .catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }, 120_000);

  it(
    "creates hardened computers",
    async () => {
      const { containerId, warnings } = await manager.create(specA);
      ids.a = containerId;
      await manager.start(containerId);
      const info = await docker.getContainer(containerId).inspect();
      const host = info.HostConfig;
      expect(host.CapDrop).toEqual(["ALL"]);
      expect(caps(host.CapAdd)).toEqual([...DEFAULT_CAPS].sort());
      expect(host.SecurityOpt).toContain("no-new-privileges:true");
      expect(host.Privileged).toBe(false);
      expect(host.Init).toBe(true);
      expect(host.RestartPolicy?.Name).toBe("unless-stopped");
      expect(host.Binds ?? []).toEqual([]);
      expect(info.Mounts.every((m) => m.Type === "volume")).toBe(true);
      expect(info.Mounts.map((m) => m.Name).sort()).toEqual(Object.values(specA.volumes).sort());
      expect(host.Memory).toBe(256 * 1024 * 1024);
      expect(host.MemorySwap).toBe(256 * 1024 * 1024);
      expect(host.NanoCpus).toBe(500_000_000);
      expect(host.PidsLimit).toBe(128);
      expect(host.NetworkMode).toBe(nets.bridge);
      expect(host.ExtraHosts).toContain("witden-hub:host-gateway");
      // Either the quota is applied or the caller is told it is not enforced.
      if (!host.StorageOpt) expect(warnings.join(" ")).toMatch(/disk quota/);
      expect(info.Config.Labels).toMatchObject({ "witden.managed": "true", "witden.instance": specA.instanceId });
      expect(info.Config.Env).toEqual(
        expect.arrayContaining([
          "GREETING=hello",
          `WITDEN_INSTANCE_ID=${specA.instanceId}`,
          `WITDEN_RUNNER_TOKEN=${specA.runner.token}`,
          "WITDEN_HUB_URL=http://witden-hub:8320",
        ]),
      );
      const volume = await docker.getVolume(specA.volumes["/workspace"]).inspect();
      expect(volume.Labels).toMatchObject({ "witden.managed": "true", "witden.instance": specA.instanceId });
      const net = await docker.getNetwork(nets.bridge).inspect();
      expect(net.Internal).toBe(false);
      expect(net.Labels?.["witden.managed"]).toBe("true");
      expect(net.Options?.["com.docker.network.bridge.enable_icc"]).toBe("false");
      expect((await sh(containerId, "getent hosts witden-hub")).code).toBe(0);
    },
    SLOW,
  );

  it(
    "puts internal and offline computers on isolated networks",
    async () => {
      const offlineRunner = { token: `token-${run}-offline-0123456789`, hubUrl: null };
      const internal = makeSpec("internal", { network: "internal", volumes: {}, runner: offlineRunner });
      const none = makeSpec("none", { network: "none", volumes: {}, runner: offlineRunner });
      const i = await manager.create(internal);
      const n = await manager.create(none);
      const iInfo = await docker.getContainer(i.containerId).inspect();
      expect(iInfo.HostConfig.NetworkMode).toBe(nets.internal);
      expect(iInfo.HostConfig.ExtraHosts ?? []).toEqual([]);
      expect(iInfo.Config.Env).toContain("WITDEN_HUB_URL=");
      const net = await docker.getNetwork(nets.internal).inspect();
      expect(net.Internal).toBe(true);
      expect(net.Options?.["com.docker.network.bridge.enable_icc"]).toBe("false");
      expect((await docker.getContainer(n.containerId).inspect()).HostConfig.NetworkMode).toBe("none");
      for (const id of [i.containerId, n.containerId]) {
        await manager.remove(id, { volumes: [], removeVolumes: true });
        expect(await manager.state(id)).toEqual({ exists: false, running: false, status: "missing" });
      }
    },
    SLOW,
  );

  it(
    "refuses containers, volumes and images it did not create",
    async () => {
      const foreign = await docker.createContainer({
        Image: IMAGE,
        Cmd: ["sleep", "infinity"],
        name: `${prefix}-plain`,
      });
      await foreign.start();
      const ops: [string, () => Promise<unknown>][] = [
        ["start", () => manager.start(foreign.id)],
        ["stop", () => manager.stop(foreign.id, 0)],
        ["stop by name", () => manager.stop(`${prefix}-plain`, 0)],
        ["restart", () => manager.restart(foreign.id, 0)],
        ["state", () => manager.state(foreign.id)],
        ["stats", () => manager.stats(foreign.id)],
        ["remove", () => manager.remove(foreign.id, { volumes: [], removeVolumes: false })],
        ["backup", () => manager.backup(foreign.id, { backupId: `bk-${run}-x`, mounts: [] })],
        ["runner channel", () => manager.openRunnerChannel(foreign.id)],
      ];
      for (const [, op] of ops) await expect(op()).rejects.toMatchObject({ code: "not_managed" });
      expect((await foreign.inspect()).State.Running).toBe(true);

      const volume = `witden-${prefix}-plainvol`;
      await docker.createVolume({ Name: volume });
      await expect(manager.volumeUsage({ volumes: [volume] })).rejects.toMatchObject({ code: "not_managed" });
      await expect(manager.remove(null, { volumes: [volume], removeVolumes: true })).rejects.toMatchObject({
        code: "not_managed",
      });
      await expect(manager.create(makeSpec("d", { volumes: { "/data": volume } }))).rejects.toMatchObject({
        code: "not_managed",
      });
      expect((await docker.getVolume(volume).inspect()).Name).toBe(volume);

      // A volume of another computer cannot be mounted either.
      await expect(
        manager.create(makeSpec("e", { volumes: { "/data": specA.volumes["/workspace"] } })),
      ).rejects.toMatchObject({ code: "conflict" });

      const foreignTag = `foreign-${run}`;
      await docker.getImage(IMAGE).tag({ repo: "witden-backup", tag: foreignTag });
      backupImages.push(`witden-backup:${foreignTag}`);
      await expect(manager.deleteBackup(foreignTag)).rejects.toMatchObject({ code: "not_managed" });
      await expect(
        manager.restore({
          spec: makeSpec("f"),
          replaceContainerId: null,
          backupId: foreignTag,
          imageRef: `witden-backup:${foreignTag}`,
          archives: {},
          scrubPaths: [],
        }),
      ).rejects.toMatchObject({ code: "not_managed" });
      expect((await docker.getImage(`witden-backup:${foreignTag}`).inspect()).Id).toBeTruthy();
    },
    SLOW,
  );

  it(
    "stops, starts and reports state, stats and volume usage",
    async () => {
      const id = ids.a;
      expect(await manager.state(id)).toMatchObject({ exists: true, running: true, status: "running" });
      const stats = await manager.stats(id);
      expect(stats.memoryBytes).toBeGreaterThan(0);
      expect(stats.memoryLimitBytes).toBe(256 * 1024 * 1024);
      expect(stats.pids).toBeGreaterThanOrEqual(1);

      expect((await sh(id, "echo kept > /workspace/keep.txt && echo layer > /opt/layer.txt")).code).toBe(0);
      await manager.restart(id, 1);
      expect((await sh(id, "cat /workspace/keep.txt /opt/layer.txt")).out).toBe("kept\nlayer\n");

      await manager.stop(id, 1);
      await manager.stop(id, 1);
      const stopped = await manager.state(id);
      expect(stopped).toMatchObject({ exists: true, running: false, status: "exited" });
      await expect(manager.stats(id)).rejects.toMatchObject({ code: "not_running" });
      await expect(manager.openRunnerChannel(id)).rejects.toMatchObject({ code: "not_running" });

      await manager.start(id);
      await manager.start(id);
      expect((await manager.state(id)).running).toBe(true);
      expect((await sh(id, "cat /workspace/keep.txt")).out).toBe("kept\n");

      const usage = await manager.volumeUsage({ volumes: [...Object.values(specA.volumes), "witden-not-there"] });
      expect(Object.keys(usage).sort()).toEqual(Object.values(specA.volumes).sort());
      for (const size of Object.values(usage)) expect(typeof size).toBe("number");
    },
    SLOW,
  );

  it(
    "installs and removes packages as root with a clean environment, never touching the image's own",
    async () => {
      const { containerId } = await manager.create(
        makeSpec("pkg", { volumes: {}, env: { PATH: "/tmp/evil:/usr/sbin:/usr/bin:/sbin:/bin" } }),
      );
      await manager.start(containerId);
      // Programs the computer's user controls, named like the commands a root exec runs: never to be used.
      await sh(
        containerId,
        "mkdir -p /tmp/evil && for c in env apt-get dpkg-query timeout cat rm; do " +
          "printf '#!/bin/sh\\ntouch /tmp/evil/ran\\n' > /tmp/evil/$c; chmod +x /tmp/evil/$c; done",
      );

      const unlisted = await manager.packages(containerId, { action: "remove", packages: ["bash"] });
      expect(unlisted.refused.bash).toMatch(/does not list its own packages/);

      const hello = await manager.packages(containerId, { action: "install", packages: ["hello"] });
      expect(hello, hello.output).toMatchObject({ ok: true, installed: { hello: true }, refused: {} });
      expect((await sh(containerId, "/usr/bin/hello")).out).toContain("Hello, world!");
      const again = await manager.packages(containerId, { action: "install", packages: ["hello"] });
      expect(again.output).toMatch(/already installed/);
      const unknown = await manager.packages(containerId, { action: "install", packages: ["no-such-package-xyz"] });
      expect(unknown).toMatchObject({ ok: false, installed: { "no-such-package-xyz": false } });

      // The image lists its packages: those stay, what was installed later can go.
      await sh(
        containerId,
        "mkdir -p /opt/witden && /usr/bin/dpkg-query -W -f='${Package}\\n' | grep -vx hello > /opt/witden/image-packages",
      );
      const removed = await manager.packages(containerId, { action: "remove", packages: ["bash", "hello"] });
      expect(removed.refused).toEqual({ bash: "part of the computer's image" });
      expect(removed.installed).toEqual({ bash: true, hello: false });

      expect((await sh(containerId, "test -e /tmp/evil/ran && echo hijacked || echo clean")).out).toBe("clean\n");
      await expect(manager.packages(containerId, { action: "install", packages: ["-o"] })).rejects.toMatchObject({
        code: "invalid",
      });
      await manager.stop(containerId, 1);
      await expect(manager.packages(containerId, { action: "install", packages: ["hello"] })).rejects.toMatchObject({
        code: "not_running",
      });
    },
    SLOW,
  );

  it(
    "starts images with the protected init without Docker's init, and their stdio runner through it",
    async () => {
      const repo = `${prefix}-protected`;
      const base = await docker.createContainer({ Image: IMAGE, name: `${prefix}-protected-base` });
      await base.commit({ repo, tag: "latest", changes: ["LABEL witden.init=protected"] });
      backupImages.push(`${repo}:latest`);
      const own = new DockerManager({
        docker,
        dataDir,
        bridgeNetwork: nets.bridge,
        internalNetwork: nets.internal,
        allowedRuntimes: ["runc"],
        runnerCommand: ["cat"],
        protectedRunnerCommand: ["sh", "-c", 'echo "protected[$WITDEN_RUNNER_TOKEN]"; exec cat'],
      });
      const { containerId } = await own.create(makeSpec("protected", { image: `${repo}:latest` }));
      await own.start(containerId);
      expect((await docker.getContainer(containerId).inspect()).HostConfig.Init).toBe(false);
      const channel = await own.openRunnerChannel(containerId);
      // the channel is its own credential: nothing started through it holds the runner token
      expect((await collect(channel, 12)).toString()).toBe("protected[]\n");
      channel.close();
    },
    SLOW,
  );

  it(
    "relays the stdio runner channel, directly and over HTTP",
    async () => {
      const direct = await manager.openRunnerChannel(ids.a);
      const echoed = collect(direct, 5);
      direct.send(new TextEncoder().encode("ping\n"));
      expect((await echoed).toString()).toBe("ping\n");
      const closed = new Promise<string>((resolve) => direct.onClose(resolve));
      direct.close();
      expect(await closed).toBe("closed");

      const token = `mgr-${run}-0123456789abcdef`;
      const app = createManagerServer(manager, { token });
      await app.listen({ host: "127.0.0.1", port: 0 });
      try {
        const client = new ManagerClient({
          baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
          token,
        });
        const remote = await client.openRunnerChannel(ids.a);
        const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
        const back = collect(remote, bytes.length);
        remote.send(bytes);
        expect([...(await back)]).toEqual([...bytes]);
        const remoteClosed = new Promise<string>((resolve) => remote.onClose(resolve));
        remote.close();
        await remoteClosed;
        expect((await client.state(ids.a)).running).toBe(true);
      } finally {
        await app.close();
      }
    },
    SLOW,
  );

  it(
    "backs up a computer and restores a clone without the scrubbed credentials",
    async () => {
      const id = ids.a;
      const setup = await sh(
        id,
        [
          "mkdir -p /home/witden/.ssh /root/.aws /workspace/project",
          "echo SECRET > /home/witden/.ssh/id",
          "echo pub > /home/witden/.ssh/id.pub",
          "echo notes > /home/witden/notes.txt",
          "echo code > /workspace/project/a.txt",
          "echo awskey > /root/.aws/credentials",
          // Only removable by a root that keeps DAC_OVERRIDE (used for the failing-scrub case below).
          "mkdir -p /srv/locked && echo key > /srv/locked/key && chown -R 1000:1000 /srv/locked && chmod 700 /srv/locked",
        ].join(" && "),
      );
      expect(setup.code).toBe(0);

      backupImages.push(`witden-backup:${backupId}`);
      backup = await manager.backup(id, { backupId, mounts: ["/home/witden", "/workspace"] });
      expect(backup.imageRef).toBe(`witden-backup:${backupId}`);
      expect(backup.archives).toEqual({ "/home/witden": "0.tar", "/workspace": "1.tar" });
      expect(backup.sizeBytes).toBeGreaterThan(0);
      expect(existsSync(path.join(dataDir, "backups", backupId, "0.tar"))).toBe(true);
      const image = await docker.getImage(backup.imageRef).inspect();
      expect(image.Config.Labels).toMatchObject({ "witden.managed": "true", "witden.backup": backupId });
      expect(image.Config.Env).toContain("WITDEN_RUNNER_TOKEN=");
      expect(image.Config.Env.join("\n")).not.toContain(specA.runner.token);
      await expect(manager.backup(id, { backupId, mounts: [] })).rejects.toMatchObject({ code: "conflict" });
      await expect(manager.backup(id, { backupId: `bk-${run}-2`, mounts: ["/etc"] })).rejects.toMatchObject({
        code: "invalid",
      });

      const restored = await manager.restore({
        spec: specClone,
        replaceContainerId: null,
        backupId,
        imageRef: backup.imageRef,
        archives: backup.archives,
        scrubPaths: ["/home/witden/.ssh/id", "/root/.aws"],
      });
      ids.clone = restored.containerId;
      expect(ids.clone).not.toBe(id);
      expect((await manager.state(ids.clone)).running).toBe(true);
      const check = await sh(
        ids.clone,
        "cat /home/witden/notes.txt /workspace/project/a.txt /opt/layer.txt /home/witden/.ssh/id.pub; " +
          "test -e /home/witden/.ssh/id && echo HAS_ID; test -e /root/.aws && echo HAS_AWS; " +
          'echo "$WITDEN_INSTANCE_ID $WITDEN_RUNNER_TOKEN"',
      );
      expect(check.out).toBe(`notes\ncode\nlayer\npub\n${specClone.instanceId} ${specClone.runner.token}\n`);
      const cloneInfo = await docker.getContainer(ids.clone).inspect();
      expect(cloneInfo.HostConfig.CapDrop).toEqual(["ALL"]);
      expect(cloneInfo.Mounts.map((m) => m.Name).sort()).toEqual(Object.values(specClone.volumes).sort());
      // The source computer keeps its credentials.
      expect((await sh(id, "cat /home/witden/.ssh/id /root/.aws/credentials")).out).toBe("SECRET\nawskey\n");

      // A restore may not replace a computer of another instance.
      await expect(
        manager.restore({
          spec: makeSpec("intruder"),
          replaceContainerId: ids.clone,
          backupId,
          imageRef: backup.imageRef,
          archives: {},
          scrubPaths: [],
        }),
      ).rejects.toMatchObject({ code: "invalid" });
      expect((await manager.state(ids.clone)).running).toBe(true);

      // When the credential scrub fails, the half-restored clone is not left behind (fail closed).
      const strict = makeSpec("strict", { capAdd: ["NET_RAW"] });
      await expect(
        manager.restore({
          spec: strict,
          replaceContainerId: null,
          backupId,
          imageRef: backup.imageRef,
          archives: backup.archives,
          scrubPaths: ["/srv/locked/key"],
        }),
      ).rejects.toMatchObject({ code: "docker_error", message: /credential scrub failed/ });
      expect(await docker.listContainers({ all: true, filters: { name: [`witden-${strict.name}`] } })).toEqual([]);
      for (const v of Object.values(strict.volumes)) {
        await expect(docker.getVolume(v).inspect()).rejects.toMatchObject({ statusCode: 404 });
      }
    },
    SLOW,
  );

  it(
    "restores in place, replacing the container and its volumes",
    async () => {
      const old = ids.a;
      await sh(old, "echo changed > /workspace/project/a.txt && echo extra > /workspace/new.txt");
      const again = await manager.restore({
        spec: specA,
        replaceContainerId: old,
        backupId,
        imageRef: backup.imageRef,
        archives: backup.archives,
        scrubPaths: [],
      });
      ids.a = again.containerId;
      expect(await manager.state(old)).toMatchObject({ exists: false });
      const out = await sh(
        ids.a,
        "cat /workspace/project/a.txt /home/witden/.ssh/id; test -e /workspace/new.txt || echo NO_NEW",
      );
      expect(out.out).toBe("code\nSECRET\nNO_NEW\n");
    },
    SLOW,
  );

  it(
    "deletes backups and removes computers with their volumes",
    async () => {
      await manager.deleteBackup(backupId);
      await expect(docker.getImage(backup.imageRef).inspect()).rejects.toMatchObject({ statusCode: 404 });
      expect(existsSync(path.join(dataDir, "backups", backupId))).toBe(false);
      await manager.deleteBackup(backupId);

      for (const [id, spec] of [
        [ids.a, specA],
        [ids.clone, specClone],
      ] as const) {
        await manager.remove(id, { volumes: Object.values(spec.volumes), removeVolumes: true });
        expect(await manager.state(id)).toEqual({ exists: false, running: false, status: "missing" });
        for (const v of Object.values(spec.volumes)) {
          await expect(docker.getVolume(v).inspect()).rejects.toMatchObject({ statusCode: 404 });
        }
        await manager.remove(id, { volumes: Object.values(spec.volumes), removeVolumes: true });
      }
    },
    SLOW,
  );
});

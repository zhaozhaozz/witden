import type { ComputerSpec } from "@witden/shared";
import { describe, expect, it } from "vitest";
import { ManagerError } from "../src/errors.js";
import {
  validateBackupRequest,
  validateComputerSpec,
  validateImageRef,
  validateRestoreRequest,
  validateScrubPaths,
} from "../src/validate.js";

const options = { allowedRuntimes: ["runc", "runsc"] };

function spec(overrides: Record<string, unknown> = {}): ComputerSpec {
  return {
    instanceId: "inst_abc123",
    name: "dev-box",
    image: "witden/computer-shell:latest",
    workdir: "/workspace",
    command: ["sleep", "infinity"],
    env: { LANG: "C.UTF-8" },
    volumes: { "/workspace": "witden-dev-box-workspace", "/home/witden": "witden-dev-box-home" },
    resources: { cpus: 2, memoryMb: 4096, pidsLimit: 2048, diskGb: 20 },
    network: "bridge",
    capAdd: [],
    runtime: null,
    runner: { token: "0123456789abcdef0123", hubUrl: "ws://witden-hub:8320/runner" },
    ...overrides,
  } as ComputerSpec;
}

function rejects(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ManagerError);
    expect((err as ManagerError).code).toBe("invalid");
    expect((err as ManagerError).message).toMatch(pattern);
    return;
  }
  throw new Error("expected the value to be rejected");
}

describe("validateComputerSpec", () => {
  it("accepts a normal spec and normalizes it", () => {
    const clean = validateComputerSpec(
      spec({
        volumes: { "/workspace/": "witden-dev-box-workspace" },
        capAdd: ["NET_RAW", "NET_RAW"],
        runtime: "runsc",
      }),
      options,
    );
    expect(clean.volumes).toEqual({ "/workspace": "witden-dev-box-workspace" });
    expect(clean.capAdd).toEqual(["NET_RAW"]);
    expect(clean.runtime).toBe("runsc");
    expect(clean.runner.hubUrl).toBe("ws://witden-hub:8320/runner");
    expect(validateComputerSpec(spec({ runner: { token: "0123456789abcdef", hubUrl: null } }), options).runner).toEqual(
      { token: "0123456789abcdef", hubUrl: null },
    );
  });

  it.each([
    ["/", /not allowed/],
    ["/etc", /not allowed/],
    ["/etc/", /not allowed/],
    ["/proc/sys", /not allowed/],
    ["/opt", /not allowed/],
    ["/opt/witden/runner", /not allowed/],
    ["/home/../etc", /\.\./],
    ["/home//witden", /\/\//],
    ["relative/path", /absolute/],
  ])("rejects mount path %s", (path, pattern) => {
    rejects(() => validateComputerSpec(spec({ volumes: { [path]: "witden-dev-box-x" } }), options), pattern);
  });

  it.each(["/var/run/docker.sock", "data", "witden-", "witden-UPPER", "other-volume", "witden-a/../b"])(
    "rejects volume name %s",
    (name) => {
      rejects(() => validateComputerSpec(spec({ volumes: { "/data": name } }), options), /volume name/);
    },
  );

  it("rejects mounting one volume twice", () => {
    const volumes = { "/a": "witden-dev-box-a", "/b": "witden-dev-box-a" };
    rejects(() => validateComputerSpec(spec({ volumes }), options), /mounted twice/);
  });

  it.each([["SYS_ADMIN"], ["NET_ADMIN"], ["SYS_PTRACE"], ["ALL"], ["CAP_CHOWN"]])("rejects capability %s", (cap) => {
    rejects(() => validateComputerSpec(spec({ capAdd: [cap] }), options), /capabilities not allowed/);
  });

  it.each(["host", "container:abc", "witden-computers", ""])("rejects network %j", (network) => {
    rejects(() => validateComputerSpec(spec({ network }), options), /network must be one of/);
  });

  it.each([
    ["privileged", true],
    ["networkMode", "host"],
    ["binds", ["/:/host"]],
    ["pidMode", "host"],
  ])("rejects unknown field %s", (field, value) => {
    rejects(() => validateComputerSpec(spec({ [field]: value }), options), /unknown fields/);
  });

  it.each(["WITDEN_RUNNER_TOKEN", "WITDEN_INSTANCE_ID", "WITDEN_HUB_URL", "WITDEN_ANYTHING"])(
    "rejects reserved env key %s",
    (key) => {
      rejects(() => validateComputerSpec(spec({ env: { [key]: "x" } }), options), /reserved/);
    },
  );

  it.each(["1BAD", "BAD-KEY", "A B", ""])("rejects env key %j", (key) => {
    rejects(() => validateComputerSpec(spec({ env: { [key]: "x" } }), options), /environment variable name/);
  });

  it("rejects runtimes outside the allow-list", () => {
    rejects(() => validateComputerSpec(spec({ runtime: "kata-runtime" }), options), /runtime kata-runtime not allowed/);
    rejects(() => validateComputerSpec(spec({ runtime: "runc" }), { allowedRuntimes: [] }), /not allowed/);
  });

  it.each([
    [{ cpus: 0 }, /cpus/],
    [{ cpus: 65 }, /cpus/],
    [{ memoryMb: 64 }, /memoryMb/],
    [{ memoryMb: 512.5 }, /integer/],
    [{ pidsLimit: 10 }, /pidsLimit/],
    [{ diskGb: 5000 }, /diskGb/],
    [{ memoryMb: "4096" }, /number/],
    [{ swapMb: 1 }, /unknown fields/],
  ])("rejects resources %j", (resources, pattern) => {
    rejects(() => validateComputerSpec(spec({ resources }), options), pattern);
  });

  it("rejects bad names, images, workdirs and runner settings", () => {
    rejects(() => validateComputerSpec(spec({ name: "Dev_Box" }), options), /computer name/);
    rejects(() => validateComputerSpec(spec({ image: "debian bookworm" }), options), /image reference/);
    rejects(() => validateComputerSpec(spec({ workdir: "workspace" }), options), /absolute/);
    for (const user of ["root", "0", "1000:0", "witden:root", "00"]) {
      rejects(() => validateComputerSpec(spec({ user }), options), /never run as root/);
    }
    expect(validateComputerSpec(spec({ user: "1000:1000" }), options).user).toBe("1000:1000");
    expect(validateComputerSpec(spec(), options).user).toBe("witden");
    rejects(() => validateComputerSpec(spec({ command: ["sh", 1] }), options), /command/);
    rejects(() => validateComputerSpec(spec({ runner: { token: "short", hubUrl: null } }), options), /runner.token/);
    rejects(
      () =>
        validateComputerSpec(spec({ runner: { token: "0123456789abcdef", hubUrl: "file:///etc/passwd" } }), options),
      /hubUrl/,
    );
  });
});

describe("other validators", () => {
  it("accepts common image references", () => {
    for (const ref of [
      "debian:bookworm-slim",
      "witden/computer-shell:latest",
      "ghcr.io/org/image:1.2.3",
      "localhost:5000/team/img",
      `debian@sha256:${"a".repeat(64)}`,
      "witden-backup:bk_123",
    ]) {
      expect(validateImageRef(ref)).toBe(ref);
    }
    for (const ref of ["", "UPPER:latest", "a b", "img:tag:extra", "--privileged", "img;rm -rf /"]) {
      expect(() => validateImageRef(ref)).toThrow(ManagerError);
    }
  });

  it("validates scrub paths", () => {
    expect(validateScrubPaths(["/home/witden/.ssh", "/root/.aws/", "/home/witden/.ssh"])).toEqual([
      "/home/witden/.ssh",
      "/root/.aws",
    ]);
    rejects(() => validateScrubPaths(["/"]), /not allowed/);
    rejects(() => validateScrubPaths(["/etc"]), /not allowed/);
    rejects(() => validateScrubPaths(["/opt"]), /not allowed/);
    rejects(() => validateScrubPaths(["/home/witden/../../etc"]), /\.\./);
    rejects(() => validateScrubPaths(["~/.ssh"]), /absolute/);
  });

  it("validates backup and restore requests", () => {
    expect(validateBackupRequest({ backupId: "bk_1", mounts: ["/workspace/"] })).toEqual({
      backupId: "bk_1",
      mounts: ["/workspace"],
    });
    rejects(() => validateBackupRequest({ backupId: "../x", mounts: [] }), /backup id/);
    const restore = {
      spec: spec(),
      replaceContainerId: null,
      backupId: "bk_1",
      imageRef: "witden-backup:bk_1",
      archives: { "/workspace": "0.tar" },
      scrubPaths: ["/home/witden/.ssh"],
    };
    expect(validateRestoreRequest(restore, options).spec.image).toBe("witden-backup:bk_1");
    rejects(
      () => validateRestoreRequest({ ...restore, archives: { "/workspace": "../../etc/x" } }, options),
      /archive/,
    );
    rejects(() => validateRestoreRequest({ ...restore, archives: { "/srv": "0.tar" } }, options), /volume/);
    rejects(() => validateRestoreRequest({ ...restore, scrubPaths: ["/usr"] }, options), /not allowed/);
  });
});

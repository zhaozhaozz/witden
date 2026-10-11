import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { errorCode, makeRunner, ok } from "./helpers.js";

const { core, hub, workdir, home } = makeRunner("files");
const b64 = (s: string) => Buffer.from(s).toString("base64");
const text = (r: Record<string, any>) => Buffer.from(r.contentBase64, "base64").toString("utf8");

afterAll(async () => {
  chmodSync(path.join(workdir, "locked"), 0o700);
  await core.shutdown();
});

describe("files", () => {
  it("writes (creating parents), appends and reads relative to the workdir", async () => {
    const w = ok(await hub.request("file.write", { path: "notes/a/plan.txt", contentBase64: b64("step 1\n") }));
    expect(w).toEqual({ path: path.join(workdir, "notes/a/plan.txt"), size: 7 });
    ok(await hub.request("file.write", { path: "notes/a/plan.txt", contentBase64: b64("step 2\n"), append: true }));
    expect(readFileSync(path.join(workdir, "notes/a/plan.txt"), "utf8")).toBe("step 1\nstep 2\n");
    const r = ok(await hub.request("file.read", { path: path.join(workdir, "notes/a/plan.txt") }));
    expect(r.size).toBe(14);
    expect(text(r)).toBe("step 1\nstep 2\n");
  });

  it("expands ~ to the home directory", async () => {
    ok(await hub.request("file.write", { path: "~/hello.txt", contentBase64: b64("hi") }));
    expect(readFileSync(path.join(home, "hello.txt"), "utf8")).toBe("hi");
  });

  it("enforces maxBytes and reports missing files", async () => {
    writeFileSync(path.join(workdir, "big.bin"), Buffer.alloc(5000));
    expect(errorCode(await hub.request("file.read", { path: "big.bin", maxBytes: 100 }))).toBe("invalid");
    expect(ok(await hub.request("file.read", { path: "big.bin", maxBytes: 5000 })).size).toBe(5000);
    expect(errorCode(await hub.request("file.read", { path: "nope.txt" }))).toBe("not_found");
    expect(errorCode(await hub.request("file.read", { path: "notes" }))).toBe("invalid");
  });

  it("lists, stats and moves", async () => {
    ok(await hub.request("file.write", { path: "dir/x.txt", contentBase64: b64("x") }));
    mkdirSync(path.join(workdir, "dir/inner"), { recursive: true });
    const list = ok(await hub.request("file.list", { path: "dir" }));
    expect(list.entries.map((e: any) => [e.name, e.type])).toEqual([
      ["inner", "dir"],
      ["x.txt", "file"],
    ]);
    const st = ok(await hub.request("file.stat", { path: "dir/x.txt" }));
    expect(st).toMatchObject({ type: "file", size: 1, name: "x.txt" });
    ok(await hub.request("file.move", { from: "dir/x.txt", to: "moved/y.txt" }));
    expect(readFileSync(path.join(workdir, "moved/y.txt"), "utf8")).toBe("x");
    expect(errorCode(await hub.request("file.stat", { path: "dir/x.txt" }))).toBe("not_found");
    expect(errorCode(await hub.request("file.move", { from: "dir/none", to: "z" }))).toBe("not_found");
  });

  it.skipIf(process.getuid?.() === 0)("applies the runner user's permissions", async () => {
    const locked = path.join(workdir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    const r = await hub.request("file.write", { path: "locked/f.txt", contentBase64: b64("x") });
    expect(errorCode(r)).toBe("failed");
    expect(r.error?.message).toContain("permission denied");
  });

  it("rejects bad params", async () => {
    expect(errorCode(await hub.request("file.read", {}))).toBe("invalid");
    expect(errorCode(await hub.request("file.write", { path: "a" }))).toBe("invalid");
    expect(errorCode(await hub.request("file.read", { path: "a\0b" }))).toBe("invalid");
  });
});

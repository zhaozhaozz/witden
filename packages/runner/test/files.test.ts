import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("sets permission bits on write, lists a whole directory and removes it", async () => {
    ok(await hub.request("file.write", { path: "skill/run.sh", contentBase64: b64("echo hi"), mode: 0o755 }));
    ok(await hub.request("file.write", { path: "skill/docs/notes.md", contentBase64: b64("# notes") }));
    ok(await hub.request("file.write", { path: "skill/.git/HEAD", contentBase64: b64("ref") }));
    symlinkSync("/etc/passwd", path.join(workdir, "skill/docs/passwd"));
    expect(statSync(path.join(workdir, "skill/run.sh")).mode & 0o777).toBe(0o755);
    // an existing file gets the bits asked for, both ways
    ok(await hub.request("file.write", { path: "skill/run.sh", contentBase64: b64("echo hi"), mode: 0o644 }));
    expect(statSync(path.join(workdir, "skill/run.sh")).mode & 0o777).toBe(0o644);
    ok(await hub.request("file.write", { path: "skill/run.sh", contentBase64: b64("echo hi"), mode: 0o755 }));

    const tree = ok(await hub.request("file.tree", { path: "skill", exclude: [".git"] }));
    expect(tree.path).toBe(path.join(workdir, "skill"));
    expect(tree.files).toEqual([
      { path: "docs/notes.md", size: 7, mode: expect.stringMatching(/^06[0-4]{2}$/) },
      { path: "run.sh", size: 7, mode: "0755" },
    ]);
    expect(tree.skipped).toEqual([{ path: "docs/passwd", type: "link" }]);
    expect(errorCode(await hub.request("file.tree", { path: "skill/run.sh" }))).toBe("invalid");
    expect(errorCode(await hub.request("file.tree", { path: "nowhere" }))).toBe("not_found");
    expect(errorCode(await hub.request("file.tree", { path: "skill", exclude: [1] }))).toBe("invalid");
    expect(errorCode(await hub.request("file.write", { path: "x", contentBase64: "", mode: 0o1777 }))).toBe("invalid");

    expect(ok(await hub.request("file.remove", { path: "skill" }))).toEqual({
      path: path.join(workdir, "skill"),
      removed: true,
    });
    expect(existsSync(path.join(workdir, "skill"))).toBe(false);
    // the link went, not what it pointed to
    expect(existsSync("/etc/passwd")).toBe(true);
    expect(ok(await hub.request("file.remove", { path: "skill" })).removed).toBe(false);
    for (const p of ["~", ".", "/"]) expect(errorCode(await hub.request("file.remove", { path: p }))).toBe("invalid");
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

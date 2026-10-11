import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRunnerCore, MemoryTransport, silentLogger } from "../src/index.js";
import { makeRunner, ok, waitUntil } from "./helpers.js";

const first = makeRunner("journal");
const { hub, workdir, stateDir } = first;

afterAll(async () => {
  await first.core.shutdown();
});

const journalGet = async (h: MemoryTransport, requestId: string) => ok(await h.request("journal.get", { requestId }));

describe("journal", () => {
  it("never executes a request id twice and replays the stored response", async () => {
    const id = `dup-${Date.now()}`;
    const params = { command: "echo once >> counter.txt; wc -l < counter.txt" };
    const a = await hub.request("exec.run", params, { id });
    const b = await hub.request("exec.run", params, { id });
    expect(b).toEqual(a);
    expect(readFileSync(path.join(workdir, "counter.txt"), "utf8")).toBe("once\n");
    expect(await journalGet(hub, id)).toEqual({ state: "completed", response: a });
  });

  it("reports running requests and absorbs duplicates while they run", async () => {
    const id = `slow-${Date.now()}`;
    const pending = hub.request("exec.run", { command: "sleep 0.7; echo slow >> slow.txt" }, { id });
    expect(await journalGet(hub, id)).toEqual({ state: "running" });
    first.core.handleMessage({ type: "request", id, op: "exec.run", params: { command: "true" }, timeoutMs: 5000 });
    const response = await pending;
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.messages.filter((m) => m.type === "response" && m.id === id)).toHaveLength(1);
    expect(readFileSync(path.join(workdir, "slow.txt"), "utf8")).toBe("slow\n");
    expect(await journalGet(hub, id)).toEqual({ state: "completed", response });
  });

  it("answers unknown for ids it never saw", async () => {
    expect(await journalGet(hub, "never-seen")).toEqual({ state: "unknown" });
  });

  it("survives a runner restart; interrupted requests are uncertain", async () => {
    const id = `persist-${Date.now()}`;
    const response = await hub.request("file.write", { path: "p.txt", contentBase64: "eA==" }, { id });
    // A request that a dead runner process had started but never finished.
    const deadPid = spawnSync("true").pid!;
    appendFileSync(
      path.join(stateDir, "journal.jsonl"),
      `${JSON.stringify({ k: "start", id: "lost-1", op: "exec.run", at: Date.now(), boot: "old", pid: deadPid, pst: "1" })}\n`,
    );

    const restarted = createRunnerCore({ ...first.core.options, logger: silentLogger });
    const hub2 = new MemoryTransport(restarted);
    expect(await journalGet(hub2, id)).toEqual({ state: "completed", response });
    const lost = await journalGet(hub2, "lost-1");
    expect(lost.state).toBe("unknown");
    expect(lost.response.error.code).toBe("failed");
    // Duplicates of either are answered from the journal, not executed.
    expect(await hub2.request("file.write", { path: "p.txt", contentBase64: "eHg=" }, { id })).toEqual(response);
    expect(readFileSync(path.join(workdir, "p.txt"), "utf8")).toBe("x");
    expect((await hub2.request("exec.run", { command: "true" }, { id: "lost-1" })).ok).toBe(false);
    await restarted.shutdown();
  });

  it("re-runs read-only requests whose large result was compacted", async () => {
    const id = `big-${Date.now()}`;
    mkdirSync(path.join(workdir, "big"), { recursive: true });
    ok(
      await hub.request("file.write", {
        path: "big/data.bin",
        contentBase64: Buffer.alloc(300_000).toString("base64"),
      }),
    );
    const a = ok(await hub.request("file.read", { path: "big/data.bin" }, { id }));
    const stored = await journalGet(hub, id);
    expect(stored.response.result.journalCompacted).toBe(true);
    const b = ok(await hub.request("file.read", { path: "big/data.bin" }, { id }));
    expect(b.contentBase64).toBe(a.contentBase64);
  });

  it("rotates the journal file", async () => {
    const small = makeRunner("journal-rotate", { journalMaxFileBytes: 2000 });
    for (let i = 0; i < 20; i++) ok(await small.hub.request("system.info", {}, { id: `rot-${i}` }));
    await waitUntil(() => {
      try {
        readFileSync(path.join(small.stateDir, "journal.jsonl.1"));
        return true;
      } catch {
        return false;
      }
    }, 2000);
    const again = createRunnerCore({ ...small.core.options });
    expect((await journalGet(new MemoryTransport(again), "rot-19")).state).toBe("completed");
    await small.core.shutdown();
    await again.shutdown();
  });
});

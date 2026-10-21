/** Long tool results: the model reads the head and the tail, the whole output stays in the role's computer. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, lastToolResult, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

const numbered = (n: number, width = 30) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1} `.padEnd(width, "x")).join("\n");

/** What each turn of dev's run read: the latest tool result before that turn. */
function record(steps: ReturnType<typeof call>[], seen: string[]) {
  w.scripts.dev = (m, turn) => {
    if (turn > 0) seen.push(lastToolResult(m));
    return turn < steps.length ? reply("", [steps[turn]]) : reply("done");
  };
}

describe("long tool results", () => {
  it("keeps the whole output in a file and shows the head, the tail and where it is", async () => {
    const pc = w.manager.computer(w.ids.instance);
    const page = numbered(2000);
    pc.page = { text: page, elements: [{ ref: "e1", role: "link", name: "Next" }] };
    const seen: string[] = [];
    const snapshot = call("browser_snapshot", { session: "br-1" });
    record([snapshot], seen);
    await w.post(w.alice, w.ids.topic, "@dev read the page");
    await w.drain();
    const path = `/home/witden/.witden/tool-output/${snapshot.id}.txt`;
    const kept = pc.files.get(path)?.toString("utf8") ?? "";
    expect(kept).toContain(page);
    expect(kept).toContain("[e1] link: Next");
    const shown = seen[0];
    expect(shown.length).toBeLessThan(w.settings.toolOutputLimit + 400);
    expect(shown).toContain("line 1 ");
    expect(shown).toContain("line 2000 ");
    expect(shown).toContain("[e1] link: Next");
    expect(shown).not.toContain("line 1000 ");
    expect(shown).toContain(`browser_snapshot output: ${kept.length} characters`);
    expect(shown).toContain(`The whole output is in ${path}: read it with read_file (offset and limit, in lines)`);
  });

  it("read_file pages through a long file instead of keeping another copy", async () => {
    const pc = w.manager.computer(w.ids.instance);
    pc.files.set("/home/witden/big.log", Buffer.from(`${numbered(3000)}\n`));
    pc.files.set("/home/witden/small.txt", Buffer.from("short\nfile\n"));
    pc.files.set("/home/witden/wide.json", Buffer.from("y".repeat(20_000)));
    const seen: string[] = [];
    const perPage = Math.floor(w.settings.toolOutputLimit / 31);
    record(
      [
        call("read_file", { path: "big.log" }),
        call("read_file", { path: "big.log", offset: perPage + 1 }),
        call("read_file", { path: "big.log", offset: 2998, limit: 10 }),
        call("read_file", { path: "big.log", offset: 10, limit: 2 }),
        call("read_file", { path: "small.txt" }),
        call("read_file", { path: "wide.json" }),
        call("read_file", { path: "big.log", offset: 5000 }),
      ],
      seen,
    );
    await w.post(w.alice, w.ids.topic, "@dev read the log");
    await w.drain();
    expect(seen[0].split("\n")[0]).toBe(
      `[/home/witden/big.log: lines 1-${perPage} of 3000. To go on, call read_file with offset=${perPage + 1}.]`,
    );
    expect(seen[0]).toContain(`line ${perPage} `);
    expect(seen[0]).not.toContain(`line ${perPage + 1} `);
    expect(seen[0].length).toBeLessThanOrEqual(w.settings.toolOutputLimit + 200);
    expect(seen[1].split("\n")[1]).toMatch(new RegExp(`^line ${perPage + 1} x+$`));
    expect(seen[2]).toBe(
      `[/home/witden/big.log: lines 2998-3000 of 3000.]\n${numbered(3000).split("\n").slice(2997).join("\n")}`,
    );
    expect(seen[3].split("\n")).toHaveLength(3);
    expect(seen[3]).toContain("lines 10-11 of 3000. To go on, call read_file with offset=12.");
    expect(seen[4]).toBe("short\nfile\n");
    expect(seen[5]).toContain(`Line 1 has 20000 characters; only its first ${w.settings.toolOutputLimit} are shown`);
    expect(seen[6]).toBe("/home/witden/big.log has 3000 lines; there is nothing from line 5000 on.");
    // A file read is never kept again.
    expect([...pc.files.keys()].filter((k) => k.includes("tool-output"))).toEqual([]);
  });

  it("lists a directory as the runner returns it", async () => {
    w.manager.computer(w.ids.instance).files.set("/home/witden/notes/a.txt", Buffer.from("a"));
    const seen: string[] = [];
    record([call("list_directory", { path: "notes" })], seen);
    await w.post(w.alice, w.ids.topic, "@dev what is in notes?");
    await w.drain();
    expect(seen[0]).toContain("/home/witden/notes/a.txt");
  });

  it("without a computer or file permission, cuts the output and says why", async () => {
    // The system administrator works without a computer; one role's prompt makes the role list long.
    await w.api("PATCH", `/api/roles/${w.ids.analyst}`, {
      token: w.adminToken,
      json: { system_prompt: `Start. ${"p".repeat(20_000)} End.` },
    });
    const admin = (await w.api("GET", "/api/roles", { token: w.adminToken })).body.find((r: any) => r.system_admin);
    await w.api("PATCH", `/api/roles/${admin.id}`, { token: w.adminToken, json: { model_config_id: w.ids.model } });
    const setup = (
      await w.api("POST", "/api/topics", { token: w.alice, json: { title: "Setup", role_ids: [admin.id] } })
    ).body;
    const adminSaw: string[] = [];
    w.scripts.admin = (m, turn) => {
      if (turn === 0) return reply("", [call("read_config", { path: "/api/roles" })]);
      adminSaw.push(lastToolResult(m));
      return reply("read it");
    };
    // test has a computer but only the shell group.
    const testSaw: string[] = [];
    for (let i = 0; i < 4; i++) await w.post(w.alice, w.ids.topic, `note ${i}: ${"z".repeat(4000)}`);
    w.scripts.test = (m, turn) => {
      if (turn === 0) return reply("", [call("topic_history", { limit: 10 })]);
      testSaw.push(lastToolResult(m));
      return reply("read it");
    };
    await w.post(w.alice, setup.id, "@admin list the roles");
    await w.post(w.alice, w.ids.topic, "@test read the history");
    await w.drain();
    expect(adminSaw[0]).toMatch(/^HTTP 200\n/);
    expect(adminSaw[0]).toContain("witden API output:");
    expect(adminSaw[0]).toContain("You have no virtual computer here, so the whole output was not kept");
    expect(adminSaw[0].length).toBeLessThan(w.settings.toolOutputLimit + 400);
    expect(testSaw[0]).toContain("You may not use files here, so the whole output was not kept");
    expect(testSaw[0]).toContain("note 0:");
    expect(testSaw[0]).toContain("read the history");
    const pc = w.manager.computer(w.ids.instance);
    expect([...pc.files.keys()].filter((k) => k.includes("tool-output"))).toEqual([]);
  });
});

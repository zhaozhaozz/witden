/** What watchers of a topic see while a role works: thinking, the answer as it streams, the tool in use. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtime } from "../src/runtime.js";
import type { BusEvent } from "../src/services/events.js";
import { call, reply } from "./support/harness.js";
import { linkChannel, restrictedNote } from "./support/outside.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
let events: BusEvent[];
let stop: () => void;
beforeEach(async () => {
  w = await buildWorld();
  events = [];
  stop = runtime().bus.subscribe((e) => events.push(e));
});
afterEach(async () => {
  stop();
  await w.close();
});

const live = (taskId: string) => events.filter((e) => e.type === "task.live" && e.data.task_id === taskId);
const settle = () => new Promise((r) => setTimeout(r, 100));

describe("live activity", () => {
  it("thinking, then the tool in use, then the answer as it is written", async () => {
    const answer = "目录里有 README.md 和 src，看起来是一个 TypeScript 项目。";
    w.scripts.dev = (_m, turn) => (turn === 0 ? reply("", [call("run_command", { command: "ls" })]) : reply(answer));
    const id = (await w.post(w.alice, w.ids.topic, "@dev 看看目录")).tasks[0].id;
    await w.drain();
    await settle();
    const seen = live(id);
    expect(seen.every((e) => e.channels.join() === `topic:${w.ids.topic}`)).toBe(true);
    expect(seen[0].data).toMatchObject({ phase: "thinking", role_id: w.ids.dev, topic_id: w.ids.topic });
    const tool = seen.find((e) => e.data.phase === "tool")!;
    expect(tool.data.tool).toBe("run_command");
    expect(JSON.stringify(tool.data)).not.toContain("ls"); // the tool's name only, never its arguments
    const writing = seen.filter((e) => e.data.phase === "writing");
    expect(writing.map((e) => e.data.delta).join("")).toBe(answer);
    // offsets let a late joiner notice missing text
    expect(writing[0].data.offset).toBe(0);
    for (let i = 1; i < writing.length; i++)
      expect(writing[i].data.offset).toBe(writing[i - 1].data.offset + writing[i - 1].data.delta.length);
    const final = (await w.messages(w.ids.topic)).find((m: any) => m.task_id === id && m.author_type === "role");
    expect(final.content).toBe(answer);
  });

  it("no streamed text while the material may not reach the topic's Slack channel", async () => {
    const SECRET = "salary-12345";
    await linkChannel(w, w.ids.topic, ["UCAROL"]);
    await restrictedNote(w, `alice earns ${SECRET}`);
    w.scripts.dev = (_m, turn) =>
      turn === 0 ? reply("", [call("recall", { query: "alice" })]) : reply(`alice earns ${SECRET}`);
    const id = (await w.post(w.alice, w.ids.topic, "@dev summarise")).tasks[0].id;
    await w.drain();
    await settle();
    const seen = live(id);
    expect(seen.map((e) => e.data.phase)).toEqual(["thinking", "tool", "thinking"]);
    // nothing on the group topic's channel carries it (the DM's own events and task details are gated elsewhere)
    const group = events.filter((e) => e.channels.includes(`topic:${w.ids.topic}`));
    expect(JSON.stringify(group)).not.toContain(SECRET);
    expect((await w.task(id)).status).toBe("waiting_approval");
  });

  it("long messages in CJK still post and are announced", async () => {
    const long = "汉".repeat(3000); // 9000 bytes: over PostgreSQL's NOTIFY limit if sent whole
    const res = await w.api("POST", `/api/topics/${w.ids.topic}/messages`, { token: w.alice, json: { content: long } });
    expect(res.status, res.raw).toBeLessThan(300);
    await settle();
    const created = events.find((e) => e.type === "message.created" && e.data.id === res.body.id);
    expect(created?.data.truncated).toBe(true);
    expect((await w.messages(w.ids.topic)).at(-1).content).toBe(long);
  });
});

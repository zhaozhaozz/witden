/** The inbox stream behind the console's sidebar: activity in viewable topics only, never content. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
let base = "";
beforeEach(async () => {
  w = await buildWorld();
  base = await w.witden.app!.listen({ port: 0, host: "127.0.0.1" });
});
afterEach(async () => {
  await w.close();
});

/** Collect SSE events of one type from a stream until `stop()`. */
function listen(token: string) {
  const events: { type: string; data: any }[] = [];
  const controller = new AbortController();
  const ready = (async () => {
    const res = await fetch(`${base}/api/events?inbox=true&access_token=${token}`, { signal: controller.signal });
    const reader = res.body!.getReader();
    let buffer = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += new TextDecoder().decode(value);
          let i = buffer.indexOf("\n\n");
          while (i >= 0) {
            const chunk = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const type = /^event: (.+)$/m.exec(chunk)?.[1];
            const data = /^data: (.+)$/m.exec(chunk)?.[1];
            if (type && data) events.push({ type, data: JSON.parse(data) });
            i = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // aborted
      }
    })();
  })();
  return { events, ready, stop: () => controller.abort() };
}

describe("inbox stream", () => {
  it("announces new messages in topics the person can view, without their text", async () => {
    w.scripts.dev = () => reply("noted");
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    const bob = listen(w.bob);
    await bob.ready;
    await new Promise((r) => setTimeout(r, 100));
    await w.post(w.alice, w.ids.topic, "release notes are ready");
    await w.post(w.alice, dm.id, "my secret plan");
    await w.drain();
    await w.waitFor(async () => bob.events.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    bob.stop();
    expect(new Set(bob.events.map((e) => e.data.topic_id))).toEqual(new Set([w.ids.topic]));
    expect(bob.events.every((e) => e.type === "topic.activity")).toBe(true);
    expect(JSON.stringify(bob.events)).not.toContain("release notes");

    // DMs tell the sidebar which role they belong to
    const topics = (await w.api("GET", "/api/topics", { token: w.alice })).body;
    expect(topics.find((t: any) => t.id === dm.id).dm_role_id).toBe(w.ids.dev);
    expect(topics.find((t: any) => t.id === w.ids.topic).dm_role_id).toBeUndefined();
  });
});

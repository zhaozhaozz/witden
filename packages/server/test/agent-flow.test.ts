/** End-to-end behaviour of AI roles, mapped to the product's acceptance scenarios. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, lastToolResult, lastUser, reply } from "./support/harness.js";
import { linkChannel } from "./support/outside.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w.close();
});

describe("agent flow", () => {
  it("dev and test collaborate on one computer", async () => {
    w.scripts.dev = (messages, turn) => {
      // The delegate's result comes back to dev's conversation as something new.
      if (lastUser(messages).includes("@test's task")) return reply(`Built and tested: ${lastUser(messages)}`);
      if (turn === 0) return reply("", [call("run_command", { command: "make build" })]);
      if (turn === 1)
        return reply("", [
          call("delegate_task", { role: "test", task: "Run the test suite", expected_output: "pass or fail" }),
        ]);
      return reply("Built; @test is running the tests.");
    };
    w.scripts.test = (messages, turn) => {
      if (turn === 0) {
        expect(String(messages[1].content)).toContain("Delegated by @dev");
        return reply("", [call("run_command", { command: "make test" })]);
      }
      return reply("All 42 tests passed");
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev please build the release and get it tested");
    expect(posted.tasks.map((t: any) => [t.owner_role_id, t.kind])).toEqual([[w.ids.dev, "conversation"]]);
    await w.drain();
    // dev did not wait for the delegate: its turn ended, and the delegated task ran on its own
    const task = await w.task(posted.tasks[0].id);
    expect(task.status).toBe("completed");
    expect(task.result).toBe("Built; @test is running the tests.");
    expect(task.children.map((c: any) => c.status)).toEqual(["completed"]);
    const child = await w.task(task.children[0].id);
    expect([child.kind, child.parent_task_id, child.spawned_by_task_id]).toEqual(["task", null, task.id]);
    expect(w.manager.computer(w.ids.instance).commands).toEqual(["make build", "make test"]);
    const texts = (await w.messages(w.ids.topic)).map((m: any) => m.content);
    expect(texts).toContain("All 42 tests passed");
    // ... and the result reached dev's conversation, which reported it
    const report = texts.find((t: string) => t.startsWith("Built and tested"));
    expect(report).toContain("All 42 tests passed");
    const trace = (await w.api("GET", `/api/tasks/${task.id}/trace`, { token: w.adminToken })).body;
    const actions = trace.audit.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["task.create", "tool.run_command", "task.complete"]));
    // dev has its conversation in this topic; the delegated work was a task of its own
    const sessions = (await w.api("GET", `/api/topics/${w.ids.topic}/sessions`, { token: w.alice })).body;
    expect(sessions.map((s: any) => [s.role.handle, s.runs])).toEqual([["dev", 2]]);
  });
});

describe("permissions and isolation", () => {
  it("delegation cannot widen permissions", async () => {
    w.scripts.analyst = (m, turn) =>
      lastUser(m).includes("@dev's task")
        ? reply("dev could not do it")
        : turn === 0
          ? reply("", [
              call("delegate_task", { role: "dev", task: "Run rm -rf on the data directory", expected_output: "done" }),
            ])
          : reply(lastToolResult(m));
    w.scripts.dev = (m, turn) =>
      turn === 0
        ? reply("", [call("run_command", { command: "rm -rf /data" })])
        : reply(`could not: ${lastToolResult(m)}`);
    const posted = await w.post(w.alice, w.ids.topic, "@analyst clean up the data dir");
    await w.drain();
    const parent = await w.task(posted.tasks[0].id);
    const child = await w.task(parent.children[0].id);
    expect(child.envelope.tools).not.toContain("shell");
    expect(child.result).toContain("not available to you");
    expect(w.manager.computer(w.ids.instance).commands).not.toContain("rm -rf /data");
    const denied = (await w.api("GET", "/api/audit?action=tool.denied", { token: w.adminToken })).body;
    expect(denied[0].task_id).toBe(child.id);
  });

  it("DM material stays out of a Slack channel unless its owner approves", async () => {
    await linkChannel(w, w.ids.topic, ["UCAROL"]);
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: w.ids.dev } })).body;
    let refusedScope = "";
    w.scripts.dev = (m, turn) => {
      // There are no private notes any more: what is said in a DM is kept as a note of that DM.
      if (turn === 0) return reply("", [call("remember", { content: "alice salary is 12345", scope: "private" })]);
      if (turn === 1) {
        refusedScope = lastToolResult(m);
        return reply("", [call("remember", { content: "alice salary is 12345" })]);
      }
      return reply("Noted, kept in this DM.");
    };
    await w.post(w.alice, dm.id, "my salary is 12345, remember it");
    await w.drain();
    expect(refusedScope).toContain("scope must be topic or role");

    let found = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("recall", { query: "salary" })]);
      found = lastToolResult(m);
      return reply(`What I found: ${found}`);
    };
    await w.post(w.alice, w.ids.topic, "@dev what is alice's salary?");
    await w.drain();
    expect(found).toBe("nothing relevant remembered");
    expect(JSON.stringify(await w.messages(w.ids.topic))).not.toContain("12345");

    // A DM stays between its person and its role: no other topic can read it, permission or not.
    let refused = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("read_topic", { topic_id: dm.id })]);
      refused = lastToolResult(m);
      return reply("I cannot read that DM from here.");
    };
    await w.post(w.alice, w.ids.topic, "@dev check my DM with you and tell everyone");
    await w.drain();
    expect(refused).toContain("a DM is private between its person and its role");
    expect(JSON.stringify(await w.messages(w.ids.topic))).not.toContain("12345");
    expect((await w.api("GET", "/api/audit", { token: w.adminToken })).raw).not.toContain("salary is 12345");
  });

  it("reading other topics is a permission: with it, a role uses them wherever it works; new roles lack it", async () => {
    await linkChannel(w, w.ids.topic, ["UCAROL"]);
    const other = (
      await w.api("POST", "/api/topics", {
        token: w.alice,
        json: { title: "Release blockers", role_ids: [w.ids.test] },
      })
    ).body;
    await w.post(w.alice, other.id, "the release waits for issue 12");
    const results: string[] = [];
    w.scripts.dev = (m, turn) => {
      if (turn > 0) results.push(lastToolResult(m));
      if (turn === 0) return reply("", [call("read_topic", { query: "blockers" })]);
      if (turn === 1) return reply("", [call("read_topic", { topic_id: other.id })]);
      return reply("From «Release blockers»: the release waits for issue 12");
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev what blocks the release?");
    await w.drain();
    expect(results[0]).toContain(`${other.id} «Release blockers» in the witden console`);
    expect(results[1]).toContain("alice: the release waits for issue 12");
    // the role may read it, so it may use it: the answer goes to the Slack channel (carol is outside the console)
    expect((await w.task(posted.tasks[0].id)).status).toBe("completed");
    expect((await w.messages(w.ids.topic)).at(-1).content).toBe(
      "From «Release blockers»: the release waits for issue 12",
    );
    // a role without the permission is not offered the tool
    let offered: string[] = [];
    w.scripts.test = (_m, _turn, tools) => {
      offered = (tools ?? []).map((t) => t.name);
      return reply("ok");
    };
    await w.post(w.alice, w.ids.topic, "@test hi");
    await w.drain();
    expect(offered).toContain("send_message");
    expect(offered).not.toContain("read_topic");
  });

  it("asks the right person; their answer reaches the conversation without an @", async () => {
    let context = "";
    w.scripts.dev = (m, turn) => {
      context = lastUser(m);
      if (context.includes("main please")) return reply("Deploying main");
      return turn === 0 ? reply("", [call("ask_human", { question: "Which branch?", people: ["bob"] })]) : reply("");
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev deploy");
    await w.drain();
    // A question does not block the conversation: it is posted, and the turn ends.
    const id = posted.tasks[0].id;
    expect((await w.task(id)).status).toBe("completed");
    const asked = (await w.messages(w.ids.topic)).at(-1);
    expect([asked.content, asked.mentions]).toEqual(["@bob Which branch?", [{ type: "user", id: w.ids.bob }]]);
    // Someone else talking (no @) does not wake dev; bob's answer does.
    expect((await w.post(w.alice, w.ids.topic, "not me, bob decides")).tasks).toEqual([]);
    const answer = await w.post(w.bob, w.ids.topic, "main please");
    expect(answer.tasks.map((t: any) => t.owner_role_id)).toEqual([w.ids.dev]);
    await w.drain();
    expect((await w.messages(w.ids.topic)).at(-1).content).toBe("Deploying main");
    // Both messages are in its context; only bob's is marked as one for dev.
    expect(context).toContain("alice: not me, bob decides");
    expect(context).toContain("bob → you: main please");
    // Once answered, bob's next words are not taken as an answer again.
    expect((await w.post(w.bob, w.ids.topic, "thanks")).tasks).toEqual([]);
  });

  it("role ping-pong is bounded", async () => {
    w.settings.maxAutoRounds = 3;
    const chatty = (target: string) => (_m: any, turn: number) =>
      turn === 0 ? reply("", [call("message_role", { role: target, message: "your turn" })]) : reply("ok");
    w.scripts.dev = chatty("test");
    w.scripts.test = chatty("dev");
    await w.post(w.alice, w.ids.topic, "@dev talk to test");
    await w.drain();
    const texts = (await w.messages(w.ids.topic)).map((m: any) => m.content);
    expect(texts.some((t: string) => t.includes("Automatic discussion stopped"))).toBe(true);
    expect(texts.filter((t: string) => t.includes("your turn")).length).toBeLessThanOrEqual(4);
  });

  it("tools needing approval wait for a console account to approve", async () => {
    await w.api("PATCH", `/api/roles/${w.ids.dev}`, { token: w.adminToken, json: { approval_required: ["shell"] } });
    w.scripts.dev = (m, turn) =>
      turn === 0
        ? reply("", [call("run_command", { command: "kubectl apply -f prod.yaml" })])
        : reply(`applied: ${lastToolResult(m)}`);
    const posted = await w.post(w.alice, w.ids.topic, "@dev ship to prod");
    await w.drain();
    const id = posted.tasks[0].id;
    expect((await w.task(id)).status).toBe("waiting_approval");
    expect(w.manager.computer(w.ids.instance).commands).toEqual([]);
    const approval = (await w.api("GET", "/api/approvals", { token: w.bob })).body.find((a: any) => a.task_id === id);
    expect(
      (await w.api("POST", `/api/approvals/${approval.id}/decide`, { token: w.bob, json: { approve: true } })).status,
    ).toBe(200);
    await w.drain();
    expect((await w.task(id)).status).toBe("completed");
    expect(w.manager.computer(w.ids.instance).commands).toEqual(["kubectl apply -f prod.yaml"]);
  });

  it("new roles: work in their virtual computer (and sharing its files) runs, reaching outside asks first", async () => {
    const created = await w.api("POST", "/api/roles", {
      token: w.adminToken,
      json: { name: "Fresh", handle: "fresh", model_config_id: w.ids.model, instance_id: w.ids.instance },
    });
    expect(created.status, created.raw).toBe(200);
    // reading other topics is off until someone turns it on
    expect(created.body.allowed_tools).toEqual([
      "browser",
      "collaborate",
      "desktop",
      "files",
      "memory",
      "profile",
      "shell",
      "terminal",
    ]);
    expect(created.body.approval_required).toEqual(["collaborate", "memory", "profile"]);
    const groups = (await w.api("GET", "/api/roles/tool-groups", { token: w.adminToken })).body;
    const files = groups.find((g: any) => g.group === "files");
    expect([files.default_level, files.default_ask]).toEqual(["allow", []]);
    expect(groups.find((g: any) => g.group === "memory").default_level).toBe("ask");
    expect(groups.find((g: any) => g.group === "topics").default_level).toBe("off");

    await w.api("POST", "/api/grants", {
      token: w.adminToken,
      json: { permission: "role.use", user_id: w.ids.alice, resource_id: created.body.id },
    });
    const dm = (await w.api("POST", "/api/dms", { token: w.alice, json: { role_id: created.body.id } })).body;
    w.manager.computer(w.ids.instance).files.set("/home/witden/report.txt", Buffer.from("done"));
    w.scripts.fresh = (_m, turn) =>
      turn === 0
        ? reply("", [call("run_command", { command: "echo inside" })])
        : turn === 1
          ? reply("", [call("share_file", { path: "report.txt" })])
          : turn === 2
            ? reply("", [call("remember", { content: "alice wants weekly reports", scope: "topic" })])
            : reply("shared");
    await w.post(w.alice, dm.id, "make the report and send it to me");
    await w.drain();
    // inside the virtual computer, and sharing a file from it into the topic: no approval
    expect(w.manager.computer(w.ids.instance).commands).toEqual(["echo inside"]);
    const shared = (await w.api("GET", `/api/topics/${dm.id}/files`, { token: w.alice })).body;
    expect(shared.map((f: any) => f.name)).toEqual(["report.txt"]);
    // platform memory is outside it: asks first
    const approvals = (await w.api("GET", "/api/approvals", { token: w.adminToken })).body;
    expect(approvals.map((a: any) => a.action)).toEqual(["remember"]);
  });

  it("emergency stop pauses work until released and resumed", async () => {
    w.scripts.dev = () => reply("hello");
    const ks = (
      await w.api("POST", "/api/kill-switches", { token: w.adminToken, json: { scope: "global", reason: "incident" } })
    ).body;
    const posted = await w.post(w.alice, w.ids.topic, "@dev hello");
    await w.drain();
    const id = posted.tasks[0].id;
    const task = await w.task(id);
    expect(task.status).toBe("paused");
    expect(task.status_reason).toContain("emergency stop");
    expect(
      (await w.api("POST", `/api/tasks/${id}/control`, { token: w.alice, json: { action: "resume" } })).status,
    ).toBe(400);
    await w.api("POST", `/api/kill-switches/${ks.id}/release`, { token: w.adminToken });
    await w.api("POST", `/api/tasks/${id}/control`, { token: w.alice, json: { action: "resume" } });
    await w.drain();
    expect((await w.task(id)).status).toBe("completed");
  });
});

describe("computers", () => {
  it("a stopped computer means wait then fail, never another machine", async () => {
    w.settings.instanceWaitSeconds = 0;
    await w.api("POST", `/api/instances/${w.ids.instance}/actions`, { token: w.adminToken, json: { action: "stop" } });
    await w.drain();
    w.scripts.dev = () => reply("", [call("run_command", { command: "ls" })]);
    const posted = await w.post(w.alice, w.ids.topic, "@dev list files");
    expect(posted.tasks[0].status).toBe("waiting_resource");
    await w.drain();
    const task = await w.task(posted.tasks[0].id);
    expect(task.status).toBe("failed");
    expect(task.status_reason).toContain("unavailable");
    expect(w.manager.computer(w.ids.instance).commands).toEqual([]);
  });

  it("a computer that is gone before the call: wait, then run the same call once it is back", async () => {
    const pc = w.manager.computer(w.ids.instance);
    w.scripts.dev = (m, turn) => {
      if (turn === 0) {
        pc.disconnect(); // runner gone before the command is sent
        void w.api("POST", `/api/instances/${w.ids.instance}/actions`, {
          token: w.adminToken,
          json: { action: "stop" },
        });
        return reply("", [call("run_command", { command: "echo resumed" })]);
      }
      return reply(`done: ${lastToolResult(m)}`);
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev echo");
    await w.drain();
    const id = posted.tasks[0].id;
    expect((await w.task(id)).status).toBe("waiting_resource");
    await w.api("POST", `/api/instances/${w.ids.instance}/actions`, { token: w.adminToken, json: { action: "start" } });
    await w.drain();
    const task = await w.task(id);
    expect(task.status).toBe("completed");
    expect(task.usage.steps).toBe(2); // the model was not asked again for the interrupted call
    expect(w.manager.computer(w.ids.instance).commands).toEqual(["echo resumed"]);
  });

  it("an action whose outcome is unknown is never repeated blindly", async () => {
    const pc = w.manager.computer(w.ids.instance);
    pc.dropOn = "exec.run"; // the connection drops while the command may already be running
    let sawUncertain = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("run_command", { command: "git push" })]);
      sawUncertain = lastToolResult(m);
      return reply("checked the remote before doing anything else");
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev push");
    await w.drain();
    expect(sawUncertain).toContain("uncertain");
    expect((await w.task(posted.tasks[0].id)).status).toBe("completed");
    const trace = (await w.api("GET", `/api/tasks/${posted.tasks[0].id}/trace`, { token: w.alice })).body;
    expect(trace.tool_calls.map((c: any) => [c.op, c.state])).toEqual([["exec.run", "uncertain"]]);
  });

  it("after a brief disconnect the runner's journal answers instead of repeating the action", async () => {
    const pc = w.manager.computer(w.ids.instance);
    pc.dropAfter = "exec.run"; // the command ran, but the answer was lost with the connection
    let seen = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("run_command", { command: "git push" })]);
      seen = lastToolResult(m);
      return reply("pushed");
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev push");
    await w.drain();
    expect(seen).toContain("recovered result");
    expect(seen).toContain("ran: git push");
    expect(pc.commands.filter((c) => c === "git push")).toHaveLength(1);
    expect((await w.task(posted.tasks[0].id)).status).toBe("completed");
  });

  it("desktop and browser tools: one task drives the desktop at a time, background sessions are labelled", async () => {
    let browserText = "";
    w.scripts.dev = (m, turn) => {
      const steps = [
        call("browser_open", { url: "https://example.test/data" }),
        call("browser_snapshot", { session: "br-1" }),
        call("browser_download", { session: "br-1", ref: "e1" }),
        call("browser_open", { url: "https://example.test/report", mode: "background" }),
      ];
      if (turn === 2) browserText = lastToolResult(m);
      return turn < steps.length ? reply("", [steps[turn]]) : reply(`got: ${lastToolResult(m)}`);
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev download the data");
    await w.drain();
    const task = await w.task(posted.tasks[0].id);
    expect(task.status).toBe("completed");
    expect(browserText).toContain("Download CSV");
    expect(task.result).toContain("background browser");
    const sessions = (await w.api("GET", `/api/instances/${w.ids.instance}/sessions`, { token: w.adminToken })).body;
    expect(sessions.map((s: any) => s.mode).sort()).toEqual(["background", "desktop"]);
    // the lease ended with the task
    expect((await w.api("GET", `/api/instances/${w.ids.instance}`, { token: w.adminToken })).body.operator).toBeNull();
  });
});

describe("sessions and data lifecycle", () => {
  it("people and roles added later read the whole topic history", async () => {
    const topic = (await w.api("POST", "/api/topics", { token: w.alice, json: { title: "Later joiners" } })).body;
    await w.post(w.alice, topic.id, "the launch date is March 3");
    for (const p of [
      { type: "user", id: w.ids.bob },
      { type: "role", id: w.ids.dev },
    ]) {
      const added = await w.api("POST", `/api/topics/${topic.id}/participants`, { token: w.alice, json: p });
      expect(added.status, added.raw).toBeLessThan(300);
    }
    const seen = await w.messages(topic.id, w.bob);
    expect(seen.map((m: any) => m.content)).toContain("the launch date is March 3");
    const people = (await w.api("GET", `/api/topics/${topic.id}`, { token: w.bob })).body.participants;
    expect(people.every((p: any) => !("history_from" in p))).toBe(true);
    let brief = "";
    w.scripts.dev = (m) => {
      brief = String(m[1].content);
      return reply("March 3");
    };
    await w.post(w.bob, topic.id, "@dev when do we launch?");
    await w.drain();
    expect(brief).toContain("the launch date is March 3");
  });

  it("each topic has its own conversation for a role, continued from one message to the next", async () => {
    const other = (
      await w.api("POST", "/api/topics", { token: w.alice, json: { title: "Other project", role_ids: [w.ids.dev] } })
    ).body;
    w.scripts.dev = () => reply("the launch code is 4242");
    await w.post(w.alice, w.ids.topic, "@dev what is the launch code?");
    await w.drain();
    let seen: any[] = [];
    w.scripts.dev = (m) => {
      seen = m;
      return reply("ok");
    };
    await w.post(w.alice, other.id, "@dev anything to report?");
    await w.drain();
    expect(JSON.stringify(seen)).not.toContain("4242");
    await w.post(w.alice, w.ids.topic, "@dev and again?");
    await w.drain();
    // The same context: the earlier question and dev's own answer, then what is new.
    expect(seen.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(seen[2].content).toBe("the launch code is 4242");
    expect(seen[3].content).toContain("New in this topic since you last looked");
    expect(seen[3].content).toContain("alice → you: @dev and again?");
    // its own answer is in the context already, not repeated among the new messages
    expect(seen[3].content).not.toContain("4242");
    const sessions = (await w.api("GET", `/api/roles/${w.ids.dev}/sessions`, { token: w.alice })).body;
    expect(sessions.length).toBe(2);
    expect(sessions.find((s: any) => s.topic.id === w.ids.topic).runs).toBe(2);
  });

  it("deleting a message removes derived memory and the work it started", async () => {
    w.scripts.dev = (_m, turn) =>
      turn === 0
        ? reply("", [call("remember", { content: "the launch code is 4242", scope: "topic" })])
        : reply("noted");
    const posted = await w.post(w.alice, w.ids.topic, "@dev the launch code is 4242, remember it");
    await w.drain();
    const mems = (await w.api("GET", `/api/memories?scope=topic&topic_id=${w.ids.topic}`, { token: w.alice })).body;
    expect(mems.some((m: any) => m.content.includes("4242"))).toBe(true);
    const res = (await w.api("DELETE", `/api/messages/${posted.id}`, { token: w.alice })).body;
    expect(res.memories_deleted).toBe(1);
    expect(res.transcript_steps_removed).toBeGreaterThan(0);
    expect((await w.api("GET", `/api/memories?scope=topic&topic_id=${w.ids.topic}`, { token: w.alice })).body).toEqual(
      [],
    );
    expect(
      JSON.stringify((await w.api("GET", `/api/tasks/${posted.tasks[0].id}/log`, { token: w.alice })).body),
    ).not.toContain("4242");
    // nor does the role's session in this topic still carry it into its next run
    const sessions = await w.api("GET", `/api/topics/${w.ids.topic}/sessions`, { token: w.alice });
    expect(sessions.raw).not.toContain("4242");
    expect(
      JSON.stringify((await w.api("GET", `/api/tasks/${posted.tasks[0].id}`, { token: w.alice })).body),
    ).not.toContain("4242");
  });

  it("follow_up_later reminds the conversation on time; it is free meanwhile", async () => {
    w.scripts.dev = (m, turn) => {
      const last = lastUser(m);
      if (last.includes("Follow-up you scheduled"))
        return reply(`checked: ${last.split("\n\n").find((p) => p.startsWith("Follow-up"))}`);
      if (last.includes("how is it going")) return reply("waiting for the build");
      return turn === 0
        ? reply("", [call("follow_up_later", { minutes: 30, reason: "check the nightly build" })])
        : reply("I will check it tonight.");
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev check the build tonight");
    await w.drain();
    expect((await w.task(posted.tasks[0].id)).status).toBe("completed");
    // Not waiting on a timer: a message meanwhile gets an answer right away.
    await w.post(w.alice, w.ids.topic, "@dev how is it going?");
    await w.drain();
    expect((await w.messages(w.ids.topic)).at(-1).content).toBe("waiting for the build");
    const { db } = await import("../src/db/client.js");
    const { agentSessions } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const [s] = await db().select().from(agentSessions).where(eq(agentSessions.topicId, w.ids.topic));
    expect(s.wakeAt!.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    const past = new Date(Date.now() - 1000).toISOString();
    await db()
      .update(agentSessions)
      .set({ inbox: s.inbox.map((i) => (i.kind === "timer" ? { ...i, due: past } : i)), wakeAt: new Date(past) })
      .where(eq(agentSessions.id, s.id));
    await w.drain();
    expect((await w.messages(w.ids.topic)).at(-1).content).toBe(
      "checked: Follow-up you scheduled (" +
        s.inbox
          .find((i) => i.kind === "timer")!
          .at.slice(5, 16)
          .replace("T", " ") +
        "): check the nightly build",
    );
  });

  it("explains misconfiguration and unknown mentions", async () => {
    await w.api("PATCH", `/api/roles/${w.ids.test}`, {
      token: w.adminToken,
      json: { allowed_tools: ["shell", "desktop"] },
    });
    const role = (await w.api("GET", `/api/roles/${w.ids.test}`, { token: w.adminToken })).body;
    expect(role.warnings.some((x: string) => x.includes("has no desktop"))).toBe(true);
    await w.api("DELETE", `/api/topics/${w.ids.topic}/participants/role/${w.ids.test}`, { token: w.alice });
    const posted = await w.post(w.alice, w.ids.topic, "@test can you help?");
    expect(posted.tasks).toEqual([]);
    expect((await w.messages(w.ids.topic)).at(-1).content).toContain("@test is not in this topic");
  });
});

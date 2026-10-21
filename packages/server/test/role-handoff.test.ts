/**
 * A role hands a task over to a colleague of the topic (transfer_task): the task it executes, which changes
 * hands once its run is over, or a task its conversation started. The same task goes on with the colleague
 * from a handoff brief; its result travels where it went before.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, saveMessage, sessionFor } from "../src/agent/dispatch.js";
import { finishHandover } from "../src/agent/task-handoff.js";
import { TOOLS, toolsFor } from "../src/agent/tools.js";
import { appendStep, taskLog } from "../src/agent/transcript.js";
import { db, transaction } from "../src/db/client.js";
import { auditLogs, roles, type Task, taskInputs, tasks } from "../src/db/schema.js";
import { getRole, getTopic } from "../src/services/topics.js";
import { call, lastToolResult, lastUser, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

let w: World;
beforeEach(async () => {
  w = await buildWorld();
});
afterEach(async () => {
  await w?.close();
});

/** A task of ``owner`` that alice asked for in the topic, queued (or as ``fields`` say). */
async function queued(owner: string, instruction = "Build the login page", fields: Partial<Task> = {}) {
  return transaction(async (tx) => {
    const topic = await getTopic(tx, w.ids.topic);
    const role = (await getRole(tx, owner))!;
    const message = await saveMessage(tx, topic, "user", w.ids.alice, instruction, { mentions: [] });
    const task = await createTask(tx, {
      topic,
      role,
      requesterUserId: w.ids.alice,
      instruction,
      sourceMessage: message,
    });
    if (!Object.keys(fields).length) return task;
    const [t] = await tx.update(tasks).set(fields).where(eq(tasks.id, task.id)).returning();
    return t;
  });
}

const fresh = async (id: string) => (await db().select().from(tasks).where(eq(tasks.id, id)))[0];
const isTask = (m: { content: unknown }[]) => !String(m[0].content).includes("## Your conversation here");
const texts = async () => (await w.messages(w.ids.topic)).map((x: any) => x.content as string);

describe("a role hands the task it works on to a colleague", () => {
  it("the colleague finishes it from the brief, and the result reaches the conversation that started it", async () => {
    w.manager.computer(w.ids.instance).execHandler = async () => ({ exitCode: 0, output: "DEV PRIVATE OUTPUT" });
    let devTaskCalls = 0;
    let conversationSaw = "";
    w.scripts.dev = (m, turn) => {
      if (isTask(m)) {
        devTaskCalls++;
        return turn === 0
          ? reply("", [call("run_command", { command: "git switch -c login" })])
          : reply("", [
              call("transfer_task", { role: "@test", note: "Branch login has the form.\nWrite and run the tests." }),
            ]);
      }
      const last = lastUser(m);
      if (last.includes("ended:")) {
        conversationSaw = last;
        return reply(`Done: ${/ended:\n(.*)/.exec(last)?.[1]}`);
      }
      return turn === 0
        ? reply("", [call("start_task", { task: "Build the login page", expected_output: "a tested page" })])
        : reply("on it");
    };
    let brief = "";
    w.scripts.test = (m) => {
      brief = JSON.stringify(m);
      return reply("tests pass on branch login");
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev build the login page");
    await w.drain();

    const [own] = await db().select().from(tasks).where(eq(tasks.spawnedByTaskId, posted.tasks[0].id));
    const session = await transaction((tx) => sessionFor(tx, w.ids.dev, w.ids.topic));
    // The same task, now the colleague's; who asked it and where its result goes stay.
    expect(own).toMatchObject({
      kind: "task",
      ownerRoleId: w.ids.test,
      status: "completed",
      result: "tests pass on branch login",
      requesterUserId: w.ids.alice,
      reportSessionId: session.id,
      revision: 1,
    });
    expect(own.envelope.report_only).toBe(true);
    expect(own.assignment.handoffs).toMatchObject([
      { from_role_id: w.ids.dev, to_role_id: w.ids.test, by_role_id: w.ids.dev },
    ]);
    expect(own.assignment.handover_request).toBeUndefined();
    expect(JSON.stringify(own.assignment)).not.toContain("Branch login");
    // The run ended with the call; the colleague started from the brief, not from dev's steps.
    expect(devTaskCalls).toBe(2);
    expect(brief).toContain(`You are taking over task ${own.id}`);
    expect(brief).toContain("from @dev");
    expect(brief).toContain("Build the login page");
    expect(brief).toContain("Handoff note from @dev");
    expect(brief).toContain("Write and run the tests.");
    expect(brief).not.toContain("DEV PRIVATE OUTPUT");
    // Its result came back to the conversation that started it.
    expect(conversationSaw).toContain(`@test's task ${own.id}`);
    expect(conversationSaw).toContain("tests pass on branch login");
    const said = await texts();
    expect(said).toContain("@dev 把任务转交给 @test：Branch login has the form. Write and run the tests.");
    expect(said.at(-1)).toBe("Done: tests pass on branch login");
    // Executed by the role, recorded as such.
    const [moved] = await db().select().from(auditLogs).where(eq(auditLogs.action, "task.reassign"));
    expect(moved).toMatchObject({ actorType: "role", actorId: w.ids.dev, taskId: own.id, roleId: w.ids.test });
    const log = await taskLog(db(), own);
    expect(log.find((s) => s.payload.type === "role_handoff")?.payload).toMatchObject({
      from_role_id: w.ids.dev,
      to_role_id: w.ids.test,
      by_role_id: w.ids.dev,
    });
  });

  it("a follow-up sent while the task changes hands reaches the new role", async () => {
    const task = await queued(w.ids.dev);
    w.manager.computer(w.ids.instance).execHandler = async () => {
      // alice adds a requirement after dev's last look at the task, before the hand-over takes effect
      const r = await w.api("POST", `/api/tasks/${task.id}/control`, {
        token: w.alice,
        json: { action: "instruct", note: "Also cover the logout" },
      });
      if (r.status !== 200) throw new Error(r.raw);
      return { exitCode: 0, output: "ok" };
    };
    const devSaw: string[] = [];
    w.scripts.dev = (m) => {
      devSaw.push(JSON.stringify(m));
      return reply("", [
        call("run_command", { command: "make" }),
        call("transfer_task", { role: "test", note: "finish" }),
      ]);
    };
    let testSaw = "";
    w.scripts.test = (m) => {
      testSaw = JSON.stringify(m);
      return reply("done, logout too");
    };
    await w.drain();
    expect(devSaw).toHaveLength(1);
    expect(devSaw[0]).not.toContain("Also cover the logout");
    expect(testSaw).toContain("Also cover the logout");
    expect(await fresh(task.id)).toMatchObject({
      ownerRoleId: w.ids.test,
      status: "completed",
      result: "done, logout too",
    });
    const inputs = await db().select().from(taskInputs).where(eq(taskInputs.taskId, task.id));
    expect(inputs.map((i) => !!i.consumedAt)).toEqual([true]);
  });

  it("refuses roles outside the topic, itself, the system administrator and a task with delegated work under way", async () => {
    const ops = await w.api("POST", "/api/roles", {
      token: w.adminToken,
      json: {
        name: "Ops",
        handle: "ops",
        description: "ops role",
        model_config_id: w.ids.model,
        instance_id: w.ids.instance,
        allowed_tools: ["shell"],
        approval_required: [],
      },
    });
    expect(ops.status, ops.raw).toBe(200);
    const [admin] = await db().select().from(roles).where(eq(roles.systemAdmin, true));
    const task = await queued(w.ids.dev);
    const parent = await queued(w.ids.dev, "Ship the release");
    // work the second task delegated, still waiting for an answer
    await queued(w.ids.analyst, "Find the old release notes", { status: "waiting_human", parentTaskId: parent.id });
    const tries = ["ops", "dev", admin.handle];
    const results: string[] = [];
    let waited = "";
    let offered: string[] = [];
    w.scripts.dev = (m, turn, tools) => {
      if (String(m[1].content).includes("Ship the release")) {
        if (turn === 0) return reply("", [call("transfer_task", { role: "test", note: "yours" })]);
        waited = lastToolResult(m);
        return reply("shipped it myself");
      }
      if (turn === 0) offered = (tools ?? []).map((t) => t.name);
      else results.push(lastToolResult(m));
      return turn < tries.length
        ? reply("", [call("transfer_task", { role: tries[turn], note: "yours" })])
        : reply("did it myself");
    };
    await w.drain();
    expect(offered).toContain("transfer_task");
    expect(results).toHaveLength(3);
    expect(results[0]).toMatch(/^error: @ops is not in this topic/);
    expect(results[1]).toBe("error: you cannot hand a task over to yourself");
    expect(results[2]).toBe("error: the system administrator does not take over tasks");
    expect(waited).toMatch(/^error: work this task delegated is still under way/);
    for (const t of [task, parent]) {
      const after = await fresh(t.id);
      expect(after).toMatchObject({ ownerRoleId: w.ids.dev, status: "completed" });
      expect(after.assignment.handoffs).toBeUndefined();
      expect(after.assignment.handover_request).toBeUndefined();
    }
    expect((await texts()).filter((t) => t.includes("转交给"))).toEqual([]);
    // Nobody was brought into the topic.
    const people = (await w.api("GET", `/api/topics/${w.ids.topic}`, { token: w.alice })).body.participants;
    expect(people.map((p: any) => p.id)).not.toContain(ops.body.id);
  });

  it("is not offered in a Slack, Feishu or GitHub conversation, nor to the system administrator", async () => {
    expect(toolsFor({ tools: [] }).map((t) => t.name)).toContain("transfer_task");
    expect(toolsFor({ tools: [], external_topic: true }).map((t) => t.name)).not.toContain("transfer_task");
    expect(toolsFor({ tools: ["config"], system_admin: true }).map((t) => t.name)).not.toContain("transfer_task");
    // A call made anyway is refused by the runner.
    const task = await queued(w.ids.dev);
    await db()
      .update(tasks)
      .set({ envelope: { ...task.envelope, outside: true, external_topic: true } })
      .where(eq(tasks.id, task.id));
    let result = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("transfer_task", { role: "test", note: "yours" })]);
      result = lastToolResult(m);
      return reply("kept it");
    };
    await w.drain();
    expect(result).toBe("error: tool transfer_task is not available to you");
    expect(await fresh(task.id)).toMatchObject({ ownerRoleId: w.ids.dev, result: "kept it" });
  });

  it("roles cannot pass a task back and forth beyond the automatic round limit", async () => {
    w.settings.maxAutoRounds = 2;
    const task = await queued(w.ids.dev);
    let refused = "";
    w.scripts.dev = (m, turn) => {
      if (turn === 0) return reply("", [call("transfer_task", { role: "test", note: "your turn" })]);
      refused = lastToolResult(m);
      return reply("finished by dev");
    };
    w.scripts.test = () => reply("", [call("transfer_task", { role: "dev", note: "no, yours" })]);
    await w.drain();
    // dev -> test (round 1), test -> dev (round 2), the third is refused
    expect(refused).toMatch(/^error: this work already went 2 rounds between roles without a person/);
    expect(refused).toContain("ask a person");
    const after = await fresh(task.id);
    expect(after).toMatchObject({ ownerRoleId: w.ids.dev, status: "completed", result: "finished by dev", round: 2 });
    expect(after.assignment.handoffs.map((h: any) => h.to_role_id)).toEqual([w.ids.test, w.ids.dev]);
  });
});

describe("a conversation hands over a task it started", () => {
  it("to a colleague of the topic, which works on it while its result still comes back to the conversation", async () => {
    const other = await queued(w.ids.test, "Check the release notes", { status: "completed", result: "checked" });
    let started = "";
    let refused = "";
    w.scripts.dev = (m, turn) => {
      const last = lastUser(m);
      if (last.includes("ended:")) return reply(`Result: ${/ended:\n(.*)/.exec(last)?.[1]}`);
      if (turn === 0) return reply("", [call("start_task", { task: "Write the release notes" })]);
      if (turn === 1) {
        started = /started task (\S+) /.exec(lastToolResult(m))?.[1] ?? "";
        return reply("", [
          call("transfer_task", { task_id: started, role: "analyst", note: "You know the changelog" }),
        ]);
      }
      if (turn === 2) return reply("", [call("transfer_task", { task_id: other.id, role: "analyst", note: "too" })]);
      refused = lastToolResult(m);
      return reply("analyst writes them");
    };
    let brief = "";
    w.scripts.analyst = (m) => {
      brief = lastUser(m);
      return reply("notes written");
    };
    await w.post(w.alice, w.ids.topic, "@dev prepare the release notes");
    await w.drain();

    const task = await fresh(started);
    const session = await transaction((tx) => sessionFor(tx, w.ids.dev, w.ids.topic));
    expect(task).toMatchObject({
      ownerRoleId: w.ids.analyst,
      status: "completed",
      result: "notes written",
      reportSessionId: session.id,
    });
    expect(task.assignment.handoffs).toMatchObject([{ from_role_id: w.ids.dev, by_role_id: w.ids.dev }]);
    expect(brief).toContain("Write the release notes");
    expect(brief).toContain("Handoff note from @dev:\nYou know the changelog");
    // Only tasks it started: a task the conversation did not start stays where it is.
    expect(refused).toBe("error: you may only hand over independent tasks your conversation here started");
    expect((await fresh(other.id)).ownerRoleId).toBe(w.ids.test);
    const said = await texts();
    expect(said).toContain("@dev 把任务转交给 @analyst：You know the changelog");
    expect(said.at(-1)).toBe("Result: notes written");
  });
});

describe("what happens between the call and the hand-over", () => {
  /** dev's task, running under worker w1, whose model just called transfer_task (as the runner records it). */
  async function asked(note = "please take it") {
    const task = await queued(w.ids.dev, "Build the login page", {
      status: "running",
      claimedBy: "w1",
      leaseUntil: new Date(Date.now() + 60_000),
    });
    const args = { role: "test", note };
    await transaction(async (tx) => {
      await appendStep(tx, task, "user", { content: "Build the login page" });
      await appendStep(tx, task, "assistant", {
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "transfer_task", arguments: JSON.stringify(args) } },
        ],
      });
    });
    const out = await TOOLS.get("transfer_task")!.handler(
      {
        taskId: task.id,
        roleId: w.ids.dev,
        topicId: task.topicId,
        toolCallId: "c1",
        gateway: w.witden.runtime.gateway!,
        db,
        mode: "task",
      },
      args,
    );
    expect(out.control).toBe("handover");
    await transaction((tx) =>
      appendStep(tx, task, "tool", { tool_call_id: "c1", name: "transfer_task", content: out.content }),
    );
    expect((await fresh(task.id)).assignment.handover_request).toMatchObject({ to_role_id: w.ids.test });
    return task;
  }

  it("a cancellation first wins: the task stays cancelled and dev's", async () => {
    const task = await asked();
    const res = await w.api("POST", `/api/tasks/${task.id}/control`, { token: w.alice, json: { action: "cancel" } });
    expect(res.status, res.raw).toBe(200);
    await transaction((tx) => finishHandover(tx, task.id, "w1"));
    const after = await fresh(task.id);
    expect(after).toMatchObject({ status: "cancelled", ownerRoleId: w.ids.dev });
    expect(after.assignment.handover_request).toBeUndefined();
    expect(after.assignment.handoffs).toBeUndefined();
    const log = JSON.stringify(await taskLog(db(), after));
    expect(log).not.toContain("role_handoff");
    expect(log).toContain("did not happen");
    expect((await texts()).filter((t) => t.includes("转交给"))).toEqual([]);
  });

  it("an emergency stop first wins: dev keeps the task and is told when it goes on", async () => {
    const task = await asked();
    const ks = (
      await w.api("POST", "/api/kill-switches", {
        token: w.adminToken,
        json: { scope: "task", target_id: task.id, reason: "check" },
      })
    ).body;
    expect((await fresh(task.id)).status).toBe("paused");
    await transaction((tx) => finishHandover(tx, task.id, "w1"));
    expect(await fresh(task.id)).toMatchObject({ status: "paused", ownerRoleId: w.ids.dev });
    await w.api("POST", `/api/kill-switches/${ks.id}/release`, { token: w.adminToken });
    await w.api("POST", `/api/tasks/${task.id}/control`, { token: w.alice, json: { action: "resume" } });
    let told = "";
    w.scripts.dev = (m) => {
      told = lastUser(m);
      return reply("kept it");
    };
    await w.drain();
    expect(told).toContain("Your hand-over of this task to @test did not happen");
    expect(await fresh(task.id)).toMatchObject({ status: "completed", ownerRoleId: w.ids.dev, result: "kept it" });
  });

  it("a follow-up that arrives after the call is read by the new role", async () => {
    const task = await asked();
    const res = await w.api("POST", `/api/tasks/${task.id}/control`, {
      token: w.alice,
      json: { action: "instruct", note: "Use the new logo" },
    });
    expect(res.status, res.raw).toBe(200);
    await transaction((tx) => finishHandover(tx, task.id, "w1"));
    expect(await fresh(task.id)).toMatchObject({ status: "pending", ownerRoleId: w.ids.test, claimedBy: null });
    let testSaw = "";
    w.scripts.test = (m) => {
      testSaw = JSON.stringify(m);
      return reply("done with the new logo");
    };
    await w.drain();
    expect(testSaw).toContain("please take it");
    expect(testSaw).toContain("Use the new logo");
    expect(await fresh(task.id)).toMatchObject({ status: "completed", result: "done with the new logo" });
  });

  it("a hand-over recorded before its worker stopped is applied when the task is picked up again", async () => {
    const task = await asked("picked up after a restart");
    // The worker vanished: its lease ran out and the task was queued again.
    await db().update(tasks).set({ status: "pending", claimedBy: null, leaseUntil: null }).where(eq(tasks.id, task.id));
    let devCalls = 0;
    w.scripts.dev = () => {
      devCalls++;
      return reply("dev should not go on");
    };
    let testSaw = "";
    w.scripts.test = (m) => {
      testSaw = JSON.stringify(m);
      return reply("finished by test");
    };
    await w.drain();
    expect(devCalls).toBe(0);
    expect(testSaw).toContain("picked up after a restart");
    expect(await fresh(task.id)).toMatchObject({
      status: "completed",
      ownerRoleId: w.ids.test,
      result: "finished by test",
    });
  });
});

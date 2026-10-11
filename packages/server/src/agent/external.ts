/**
 * Third-party agents that bring their own local tools (for example a coding CLI) run *inside* the role's
 * computer, never in the platform: the worker asks the computer's runner to start the agent process with
 * the brief, follows its output, can stop it, and delivers its final output through the same flow check
 * as any other answer. The platform still owns identity, topic, permissions and task state.
 */
import { eq } from "drizzle-orm";
import type { GatewayClient } from "../compute/gateway.js";
import { db as getDb, transaction } from "../db/client.js";
import { roles, tasks, topics } from "../db/schema.js";
import { WitdenError } from "../errors.js";
import { redact } from "../security/crypto.js";
import { audit } from "../services/audit.js";
import { initialMessages, recordSessionNote } from "./context.js";
import { getTask, publishTaskStatus, setStatus, TERMINAL, textRestricted } from "./control.js";
import { deliver } from "./output.js";
import { activeKillSwitch } from "./revocation.js";
import { notifyParent } from "./runner.js";
import { appendStep } from "./transcript.js";

const POLL_MS = 3000;
const OUTPUT_TAIL = 8000;

export async function runExternal(gateway: GatewayClient, taskId: string): Promise<void> {
  const task = await getTask(getDb(), taskId);
  if (!task) return;
  const [role] = await getDb().select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
  const [topic] = await getDb().select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
  const config = task.roleSnapshot.runtime_config ?? role.runtimeConfig ?? {};
  const fail = (reason: string) =>
    transaction(async (tx) => {
      const t = await getTask(tx, taskId);
      if (t && !TERMINAL.has(t.status))
        await notifyParent(tx, await setStatus(tx, t, "failed", reason, { error: reason }));
    });
  if (!config.command) return fail("this role uses an external agent runtime but has no command configured");

  const call = (
    op: Parameters<GatewayClient["execute"]>[0]["op"],
    params: Record<string, unknown>,
    timeoutMs = 60_000,
  ) => gateway.execute({ taskId, toolCallId: `ext-${op}-${Date.now()}`, op, params, timeoutMs }) as Promise<any>;

  let sessionId: string | undefined = task.wait?.external_session;
  try {
    if (!sessionId) {
      const [system, user] = await initialMessages(getDb(), task, role, topic);
      const prompt = `${system.content}\n\n${user.content}`;
      const started = await call("agent.start", {
        command: String(config.command),
        prompt,
        cwd: config.cwd,
        env: config.env ?? {},
      });
      sessionId = started.sessionId as string;
      await transaction(async (tx) => {
        const t = (await getTask(tx, taskId))!;
        await tx
          .update(tasks)
          .set({ wait: { ...(t.wait ?? {}), external_session: sessionId } })
          .where(eq(tasks.id, taskId));
        await appendStep(tx, t, "event", {
          type: "external_agent_started",
          command: String(config.command),
          session: sessionId,
        });
      });
    }
    const deadline = Date.now() + Number(config.timeout_minutes ?? 60) * 60_000;
    for (;;) {
      const current = await getTask(getDb(), taskId);
      // Cancelled, paused or stopped by an emergency switch: the agent process inside the computer stops too.
      if (current?.status !== "running" || (await activeKillSwitch(getDb(), current))) {
        const stopped = await call("agent.stop", { sessionId }).then(
          () => true,
          (err) => (console.warn(`[witden] could not stop external agent ${sessionId}`, err.message), false),
        );
        await transaction(async (tx) => {
          const t = await getTask(tx, taskId);
          if (!t) return;
          await appendStep(tx, t, "event", {
            type: "external_agent_stopped",
            session: sessionId,
            stopped,
            status: t.status,
          });
          // A paused task starts a fresh agent run when resumed; the stopped one cannot continue.
          if (!TERMINAL.has(t.status) && t.wait?.external_session === sessionId) {
            const { external_session: _gone, ...wait } = t.wait as Record<string, any>;
            await tx.update(tasks).set({ wait }).where(eq(tasks.id, taskId));
          }
        });
        return;
      }
      const state = await call("agent.read", { sessionId });
      const tail = String(state.output ?? "").slice(-OUTPUT_TAIL);
      await transaction(async (tx) => {
        const t = (await getTask(tx, taskId))!;
        const restricted = await textRestricted(tx, t);
        const [row] = await tx
          .update(tasks)
          .set({ progress: restricted ? "(output withheld: restricted material)" : redact(tail.slice(-1500)) })
          .where(eq(tasks.id, taskId))
          .returning();
        await publishTaskStatus(tx, row);
      });
      if (!state.running) {
        await finish(taskId, tail, state.exitCode);
        return;
      }
      if (Date.now() > deadline) {
        await call("agent.stop", { sessionId }).catch(() => {});
        await fail(`external agent did not finish within ${config.timeout_minutes ?? 60} minutes`);
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } catch (err) {
    if (err instanceof WitdenError && err.code.startsWith("instance")) {
      await transaction(async (tx) => {
        const t = await getTask(tx, taskId);
        if (t && t.status === "running") {
          await setStatus(tx, t, "waiting_resource", err.message, {
            wait: { ...(t.wait ?? {}), type: "instance", instance_id: t.instanceId, since: new Date().toISOString() },
          });
        }
      });
      return;
    }
    await fail(`external agent error: ${(err as Error).message}`);
  }
}

async function finish(taskId: string, output: string, exitCode: number | null): Promise<void> {
  await transaction(async (tx) => {
    const task = await getTask(tx, taskId);
    if (task?.status !== "running") return;
    const [role] = await tx.select().from(roles).where(eq(roles.id, task.ownerRoleId)).limit(1);
    const [topic] = await tx.select().from(topics).where(eq(topics.id, task.topicId)).limit(1);
    const text = redact(output.trim()) || `(the agent exited with code ${exitCode} and no output)`;
    await appendStep(tx, task, "event", { type: "external_agent_exited", exit_code: exitCode });
    if (exitCode !== 0) {
      const reason = `external agent exited with code ${exitCode}`;
      await notifyParent(tx, await setStatus(tx, task, "failed", reason, { error: reason, result: text }));
      return;
    }
    const delivery = await deliver(tx, task, role, topic, text, { final: true });
    if (delivery.approval) {
      await setStatus(tx, task, "waiting_approval", "final answer waiting for disclosure approval", {
        wait: { type: "approval", approval_id: delivery.approval.id },
      });
      return;
    }
    const done = await setStatus(tx, task, "completed", null, { result: text });
    if (!(await textRestricted(tx, done))) await recordSessionNote(tx, done, text);
    await audit(tx, "task.complete", {
      actorType: "role",
      actorId: role.id,
      taskId,
      topicId: topic.id,
      roleId: role.id,
      instanceId: task.instanceId,
      detail: { runtime: "external" },
    });
    await notifyParent(tx, done);
  });
}

/**
 * Hand an independent task to another role without replacing it.
 *
 * A task belongs to its topic; ownerRoleId is the role executing it now, not its identity. Only work that
 * nothing executes and nothing waits on changes hands. The new role works with its own permissions on its own
 * computer. Earlier steps stay in the task's log but not in the new role's model context: that starts from a
 * handoff brief (transcript.ts reads from assignment.handoff_context_from_seq).
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { approvals, computerInstances, type Role, type Task, taskInputs, tasks, type User } from "../db/schema.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { audit } from "../services/audit.js";
import { wake } from "../services/events.js";
import * as topicSvc from "../services/topics.js";
import { ACTIVE, getTask, publishTaskStatus, TERMINAL } from "./control.js";
import { authorize, buildEnvelope, roleSnapshotFor, systemMessage, taskBudget } from "./dispatch.js";
import { activeKillSwitch, stillAllowed } from "./revocation.js";
import { lockTask } from "./task-continuation.js";
import { appendStep } from "./transcript.js";

/** Nothing executes these, and nothing is outstanding for the previous role. */
export const TRANSFERABLE = new Set(["pending", "waiting_resource", "waiting_role", "completed", "failed"]);

/** Where the work came from and how its answer travels stay with it; the permissions are the new role's. */
const CARRIED = ["report_only", "auto", "outside", "untrusted_input", "automation_event", "topic_routes"];

function envelopeFor(task: Task, target: Role, parent: Task | null): Record<string, any> {
  const env = buildEnvelope(target, parent);
  for (const key of CARRIED) if (task.envelope?.[key] !== undefined) env[key] = task.envelope[key];
  // As for continuations (task-continuation.ts): no configuration tools for work from outside or automation.
  if (env.outside || env.automation_event || env.untrusted_input)
    env.tools = env.tools.filter((t: string) => !["config", "profile", "automation"].includes(t));
  return env;
}

function refusal(status: string): string {
  if (status === "running") return "the task is running; hand it over after it stops, or cancel it";
  if (status === "paused") return "the task is paused by an emergency stop or a takeover; resume or cancel it first";
  if (status === "cancelled") return "retry the cancelled task before handing it over";
  return "resolve the pending approval, delegated work, question or timer before handing the task over";
}

export async function transferTask(db: Db, user: User, id: string, target: Role, note = ""): Promise<Task> {
  const task = await lockTask(db, id);
  if (!task) throw new NotFound("task not found");
  if (task.kind !== "task") throw new BadRequest("a role's conversation cannot be reassigned; only tasks can");
  if (!TRANSFERABLE.has(task.status)) throw new BadRequest(refusal(task.status));
  // A run that just stopped may still be finishing its last call; the worker releases the claim when it exits.
  if (task.claimedBy && task.leaseUntil && task.leaseUntil > new Date())
    throw new BadRequest("the previous run is still finishing; try again in a moment");
  if (task.ownerRoleId === target.id) throw new BadRequest("the task is already assigned to this role");
  if (target.systemAdmin) throw new Forbidden("the system administrator does not take over tasks");
  if (target.status !== "active") throw new Forbidden("target role is disabled");
  // An approval decided later would run the previous role's call as the new role.
  const [approval] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.taskId, task.id), eq(approvals.status, "pending")))
    .limit(1);
  if (approval) throw new BadRequest("decide the task's pending approval before handing it over");
  const [child] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, task.id), inArray(tasks.status, [...ACTIVE])))
    .limit(1);
  if (child) throw new BadRequest("work this task delegated is still under way; wait for it or cancel it");

  const topic = await topicSvc.getTopic(db, task.topicId);
  if (topic.status !== "active") throw new Forbidden("cannot reassign work in an archived topic");
  if (!(await topicSvc.participant(db, topic.id, "role", target.id)))
    await topicSvc.inviteRole(db, user, topic, target.id);
  // The same checks as new work for the target, as the original requester.
  const { allowed, refusals } = await authorize(db, topic, task.requesterUserId, [target.id]);
  if (!allowed.length) throw new Forbidden(`cannot reassign: ${refusals.join("; ")}`);
  const parent = task.parentTaskId ? ((await getTask(db, task.parentTaskId)) ?? null) : null;
  const next: Task = {
    ...task,
    ownerRoleId: target.id,
    instanceId: target.instanceId,
    envelope: envelopeFor(task, target, parent),
  };
  if (await activeKillSwitch(db, next)) throw new Forbidden("an emergency stop covers the new executor");
  const denied = await stillAllowed(db, next);
  if (denied) throw new Forbidden(denied);

  const previous = await topicSvc.getRole(db, task.ownerRoleId);
  await appendStep(db, task, "event", {
    type: "role_handoff",
    from_role_id: task.ownerRoleId,
    to_role_id: target.id,
    from_instance_id: task.instanceId,
    to_instance_id: target.instanceId,
    by: user.id,
    prior_status: task.status,
    revision: task.revision,
    previous_usage: task.usage,
  });
  // Only the requirements and outcomes cross over, never the previous role's tool output (it may hold material
  // only that role could read).
  const inputs = await db
    .select()
    .from(taskInputs)
    .where(and(eq(taskInputs.taskId, task.id), isNotNull(taskInputs.consumedAt)))
    .orderBy(desc(taskInputs.createdAt), desc(taskInputs.id))
    .limit(26);
  const followUps = inputs
    .slice(0, 25)
    .reverse()
    .map((input) => `[revision ${input.revision}] ${input.content.slice(0, 1200)}`)
    .join("\n");
  const brief = [
    `You are taking over task ${task.id} in topic "${topic.title}" from @${previous?.handle ?? "?"}; it is the same task, only its executor changed.`,
    `Task: ${task.title}\nOriginal instructions:\n${task.instruction}`,
    followUps
      ? `Follow-up requirements${inputs.length > 25 ? " (earlier ones omitted; see the task history)" : ""}:\n${followUps}`
      : "",
    task.result ? `Last delivered result:\n${task.result.slice(0, 3000)}` : "",
    task.error ? `It last failed with: ${task.error.slice(0, 1000)}` : "",
    task.progress ? `Last recorded progress:\n${task.progress.slice(0, 2000)}` : "",
    note.trim() ? `Handoff note from ${user.name}:\n${note.trim().slice(0, 4000)}` : "",
    "The previous executor's steps were not handed over. You work on your own computer: files, installed software " +
      "and credentials were not copied, so check what is there before changing anything.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const contextFrom = await appendStep(db, task, "user", { content: brief, type: "role_handoff_brief" });

  // Finished work stays finished until a person continues or retries it; anything else is queued for the new role.
  let status = task.status;
  let wait: Record<string, any> | null = null;
  if (!TERMINAL.has(status)) {
    const [inst] = target.instanceId
      ? await db.select().from(computerInstances).where(eq(computerInstances.id, target.instanceId)).limit(1)
      : [];
    status = inst && inst.status !== "running" ? "waiting_resource" : "pending";
    if (inst && status === "waiting_resource")
      wait = { type: "instance", instance_id: inst.id, since: new Date().toISOString() };
  }
  const handoffs = Array.isArray(task.assignment?.handoffs) ? task.assignment.handoffs : [];
  const [updated] = await db
    .update(tasks)
    .set({
      ownerRoleId: target.id,
      instanceId: target.instanceId,
      roleSnapshot: await roleSnapshotFor(db, target),
      envelope: next.envelope,
      budget: taskBudget(target, parent),
      // The new role has its own step budget; what the previous one used stays in the log and usage records.
      usage: { steps: 0, tokens: 0 },
      assignment: {
        ...task.assignment,
        ...allowed[0][1],
        handoff_context_from_seq: contextFrom,
        handoffs: [
          ...handoffs,
          {
            from_role_id: task.ownerRoleId,
            to_role_id: target.id,
            from_instance_id: task.instanceId,
            to_instance_id: target.instanceId,
            by: user.id,
            at: new Date().toISOString(),
          },
        ],
      },
      status,
      statusReason: `handed over to @${target.handle} by ${user.name}`,
      wait,
      claimedBy: null,
      leaseUntil: null,
    })
    .where(eq(tasks.id, task.id))
    .returning();
  await publishTaskStatus(db, updated);
  await audit(db, "task.reassign", {
    actorType: "user",
    actorId: user.id,
    taskId: task.id,
    topicId: task.topicId,
    roleId: target.id,
    instanceId: target.instanceId,
    detail: {
      from_role: task.ownerRoleId,
      to_role: target.id,
      old_instance: task.instanceId,
      new_instance: target.instanceId,
      prior_status: task.status,
    },
  });
  let message = `Task handed over from @${previous?.handle ?? "?"} to @${target.handle} by ${user.name}; it keeps its history.`;
  if (task.instanceId !== target.instanceId)
    message += " It now runs on a different computer; files from the previous computer were not moved.";
  await systemMessage(db, topic, message, { taskId: task.id });
  if (status === "pending") await wake(db, "tasks");
  return updated;
}

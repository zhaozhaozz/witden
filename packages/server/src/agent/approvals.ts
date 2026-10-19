/** Human decisions on held AI actions. Roles can never approve anything themselves. */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  type Approval,
  approvals,
  type Role,
  roles,
  type Task,
  type Topic,
  tasks,
  topics,
  type User,
} from "../db/schema.js";
import { Conflict, Forbidden } from "../errors.js";
import { hasPermission, Perm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { approvalChanged } from "../services/events.js";
import { recordSessionNote } from "./context.js";
import { deferWhilePaused, setStatus, TERMINAL } from "./control.js";
import { noteRunEnd, settle } from "./conversation.js";
import { systemMessage } from "./dispatch.js";
import { discardHeld, releaseApproved } from "./output.js";
import { notifyParent } from "./runner.js";
import { appendStep, isConversation } from "./transcript.js";

export async function canDecide(db: Db, user: User, approval: Approval): Promise<boolean> {
  if (!user.isActive) return false;
  return (
    approval.approverUserIds.includes(user.id) || (await hasPermission(db, user, Perm.APPROVAL_DECIDE, approval.roleId))
  );
}

/** Apply the decision, unless the task is paused (e.g. emergency stop): then it applies on resume. */
async function advance(db: Db, task: Task, status: string, reason: string, wait: Record<string, any> | null) {
  if (task.status === "paused") await deferWhilePaused(db, task, status, reason, wait);
  else await setStatus(db, task, status, reason, { wait });
}

/**
 * The final answer was released or withheld: the task ends. A conversation run that got something new while
 * it waited goes on with it instead.
 */
async function endWithAnswer(db: Db, task: Task, result: string, reason: string | null, verdict: string) {
  if (isConversation(task) && (await settle(db, task))) {
    await advance(db, task, "pending", `${verdict}; new messages arrived`, null);
    return;
  }
  const done = await setStatus(db, task, "completed", reason, { result });
  if (isConversation(done)) await noteRunEnd(db, done);
  else if (!reason) await recordSessionNote(db, done, result);
  await notifyParent(db, done);
}

export async function decide(db: Db, approval: Approval, user: User, approve: boolean, note = ""): Promise<Approval> {
  if (approval.status !== "pending") throw new Conflict(`approval already ${approval.status}`);
  if (!(await canDecide(db, user, approval))) throw new Forbidden("you are not an approver for this request");
  const [decided] = await db
    .update(approvals)
    .set({ status: approve ? "approved" : "rejected", decidedBy: user.id, decidedAt: new Date() })
    .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")))
    .returning();
  if (!decided) throw new Conflict("approval already decided; refresh to see the decision");
  await approvalChanged(db, decided);
  await audit(db, `approval.${decided.status}`, {
    actorType: "user",
    actorId: user.id,
    taskId: approval.taskId,
    topicId: approval.topicId,
    roleId: approval.roleId,
    detail: { action: approval.action, note },
  });
  const [task] = await db.select().from(tasks).where(eq(tasks.id, approval.taskId)).limit(1);
  const [role] = await db.select().from(roles).where(eq(roles.id, approval.roleId)).limit(1);
  const [topic] = await db.select().from(topics).where(eq(topics.id, approval.topicId)).limit(1);
  if (!task || !role || !topic || TERMINAL.has(task.status)) return decided;
  const verdict = `${approve ? "approved" : "rejected"} by ${user.name}${note ? `: ${note}` : ""}`;
  // Messages held for disclosure exist only from before migration 0032; deciding them still posts or drops them.
  if (approval.action === "disclose") {
    await decideDisclosure(db, decided, task, role, topic, approve, verdict);
  } else {
    const call = approval.detail.tool_call;
    if (approve) {
      const envelope = { ...task.envelope, approved_calls: [...(task.envelope.approved_calls ?? []), call.id] };
      const [updated] = await db.update(tasks).set({ envelope }).where(eq(tasks.id, task.id)).returning();
      await advance(db, updated, "pending", verdict, { retry_call: call });
    } else {
      await appendStep(db, task, "tool", {
        tool_call_id: call.id,
        name: call.name,
        content: `not executed: ${verdict}`,
      });
      await advance(db, task, "pending", verdict, null);
    }
  }
  return decided;
}

async function decideDisclosure(
  db: Db,
  approval: Approval,
  task: Task,
  role: Role,
  topic: Topic,
  approve: boolean,
  verdict: string,
) {
  const detail = approval.detail;
  if (approve) {
    await releaseApproved(db, approval, task, role, topic);
    if (detail.final) {
      await endWithAnswer(db, task, detail.content, null, verdict);
      return;
    }
    if (task.wait?.then) {
      // ask_human: now that the question is out, wait for the answer
      await advance(db, task, "waiting_human", "waiting for an answer", task.wait.then);
      return;
    }
    await appendStep(db, task, "tool", {
      tool_call_id: detail.tool_call_id,
      name: "post",
      content: `posted (${verdict})`,
    });
    await advance(db, task, "pending", verdict, null);
    return;
  }
  await discardHeld(db, approval);
  await systemMessage(db, topic, `Held message from @${role.handle} was not released (${verdict}).`, {
    taskId: task.id,
  });
  if (detail.final) {
    await endWithAnswer(db, task, "(answer withheld: disclosure rejected)", "answer withheld", verdict);
    return;
  }
  await appendStep(db, task, "tool", {
    tool_call_id: detail.tool_call_id,
    name: "post",
    content: `not posted: ${verdict}. Do not share that material here.`,
  });
  await advance(db, task, "pending", verdict, null);
}

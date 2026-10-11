/** Human decisions on held AI actions. Roles can never approve anything themselves. */
import { eq } from "drizzle-orm";
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
import { userCanRead } from "../security/labels.js";
import { hasPermission, Perm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { recordSessionNote } from "./context.js";
import { deferWhilePaused, setStatus, TERMINAL, textRestricted } from "./control.js";
import { systemMessage } from "./dispatch.js";
import { discardHeld, releaseApproved } from "./output.js";
import { notifyParent } from "./runner.js";
import { appendStep } from "./transcript.js";

export async function canDecide(db: Db, user: User, approval: Approval): Promise<boolean> {
  if (!user.isActive) return false;
  // Only the people whose material it is may release it to a wider audience.
  if (approval.action === "disclose") return approval.approverUserIds.includes(user.id);
  return (
    approval.approverUserIds.includes(user.id) || (await hasPermission(db, user, Perm.APPROVAL_DECIDE, approval.roleId))
  );
}

/** Approving needs seeing: the decider must be allowed to read everything the request draws on. */
export async function canSeeMaterial(db: Db, user: User, approval: Approval): Promise<boolean> {
  if (approval.action === "disclose") return userCanRead(db, user.id, approval.detail.labels ?? []);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, approval.taskId)).limit(1);
  return userCanRead(db, user.id, task?.labels ?? []);
}

/** Apply the decision, unless the task is paused (e.g. emergency stop): then it applies on resume. */
async function advance(db: Db, task: Task, status: string, reason: string, wait: Record<string, any> | null) {
  if (task.status === "paused") await deferWhilePaused(db, task, status, reason, wait);
  else await setStatus(db, task, status, reason, { wait });
}

export async function decide(db: Db, approval: Approval, user: User, approve: boolean, note = ""): Promise<Approval> {
  if (approval.status !== "pending") throw new Conflict(`approval already ${approval.status}`);
  if (!(await canDecide(db, user, approval))) throw new Forbidden("you are not an approver for this request");
  if (approve && !(await canSeeMaterial(db, user, approval))) {
    throw new Forbidden("you cannot approve this: it draws on material you are not allowed to see (you can reject it)");
  }
  const [decided] = await db
    .update(approvals)
    .set({ status: approve ? "approved" : "rejected", decidedBy: user.id, decidedAt: new Date() })
    .where(eq(approvals.id, approval.id))
    .returning();
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
      const done = await setStatus(db, task, "completed", null, { result: detail.content });
      if (!(await textRestricted(db, done))) await recordSessionNote(db, done, detail.content);
      await notifyParent(db, done);
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
    const done = await setStatus(db, task, "completed", "answer withheld", {
      result: "(answer withheld: disclosure rejected)",
    });
    await notifyParent(db, done);
    return;
  }
  await appendStep(db, task, "tool", {
    tool_call_id: detail.tool_call_id,
    name: "post",
    content: `not posted: ${verdict}. Do not share that material here.`,
  });
  await advance(db, task, "pending", verdict, null);
}

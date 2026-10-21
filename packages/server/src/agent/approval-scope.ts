import type { Approval, Task } from "../db/schema.js";

/** A grant belongs to this task's current iteration, never its children or the role's settings. */
export function hasRunToolApproval(task: Task, tool: string): boolean {
  const grant = task.envelope.approved_tools;
  return grant?.revision === task.revision && Array.isArray(grant.names) && grant.names.includes(tool);
}

export function grantRunToolApproval(task: Task, tool: string): Task["envelope"] {
  const current = task.envelope.approved_tools;
  const names = current?.revision === task.revision && Array.isArray(current.names) ? current.names : [];
  return { ...task.envelope, approved_tools: { revision: task.revision, names: [...new Set([...names, tool])] } };
}

/** Retries and completed-task continuations start a new approval boundary, even when the task ID stays. */
export function clearRunApprovals(envelope: Task["envelope"]): Task["envelope"] {
  const { approved_tools: _tools, approved_calls: _calls, ...rest } = envelope;
  return rest;
}

export function canAllowForTaskRun(approval: Approval, task: Task | undefined): boolean {
  const call = approval.detail.tool_call;
  return !!(
    approval.status === "pending" &&
    approval.action !== "disclose" &&
    typeof call?.id === "string" &&
    typeof call.name === "string" &&
    call.name === approval.action &&
    task?.ownerRoleId === approval.roleId &&
    task.topicId === approval.topicId &&
    (task.status === "waiting_approval" || (task.status === "paused" && task.wait?.resume_to === "waiting_approval")) &&
    task.wait?.approval_id === approval.id &&
    (approval.detail.task_revision === undefined || approval.detail.task_revision === task.revision)
  );
}

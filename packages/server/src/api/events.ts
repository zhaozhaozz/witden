/**
 * Server-sent events: live messages, task status and computer state.
 *
 * Access is re-checked for every event, not only when the stream opens: people may be removed from a topic or
 * deactivated while their browser is still connected.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db as getDb } from "../db/client.js";
import { tasks, topics, type User, users } from "../db/schema.js";
import { Forbidden, Unauthorized } from "../errors.js";
import { runtime } from "../runtime.js";
import { hasPermission, Perm } from "../security/permissions.js";
import { type BusEvent, CONFIG_CHANNEL } from "../services/events.js";
import { canView } from "../services/topics.js";
import { resolveToken } from "../services/users.js";
import { extractToken, query } from "./http.js";

async function topicOk(user: User, topicId: string | undefined): Promise<boolean> {
  const db = getDb();
  const [topic] = topicId ? await db.select().from(topics).where(eq(topics.id, topicId)).limit(1) : [];
  return !!topic && (await canView(db, user, topic));
}

async function taskOk(user: User, taskId: string | undefined): Promise<boolean> {
  const db = getDb();
  const [task] = taskId ? await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1) : [];
  return !!task && (await topicOk(user, task.topicId));
}

async function adminOk(user: User): Promise<boolean> {
  return (
    (await hasPermission(getDb(), user, Perm.AUDIT_VIEW)) || (await hasPermission(getDb(), user, Perm.INSTANCE_MANAGE))
  );
}

/** Is ``userId`` still allowed to receive ``event`` on the channels it matched? */
export async function allowed(userId: string, matched: string[], event: BusEvent): Promise<boolean> {
  const [user] = await getDb().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.isActive) return false;
  for (const channel of matched) {
    const [kind, ident] = [
      channel.slice(0, channel.indexOf(":") < 0 ? channel.length : channel.indexOf(":")),
      channel.slice(channel.indexOf(":") + 1),
    ];
    if (kind === "topic" && !(await topicOk(user, ident))) return false;
    if (kind === "task" && !(await taskOk(user, ident))) return false;
    if (kind === "admin" && !(await adminOk(user))) return false;
    // Which configuration area changed: for console accounts (external members never sign in).
    if (kind === CONFIG_CHANNEL && user.externalConnectionId) return false;
  }
  // Step previews can carry whatever the task has read.
  if (event.type === "task.step" && !(await taskOk(user, event.data.task_id))) return false;
  return true;
}

export async function eventRoutes(app: FastifyInstance) {
  app.get("/api/events", async (req, reply) => {
    const user = await resolveToken(getDb(), extractToken(req));
    if (!user) throw new Unauthorized("authentication required");
    const q = query(req);
    const channels = new Set<string>();
    if (q.topic_id) {
      if (!(await topicOk(user, q.topic_id))) throw new Forbidden("you cannot view this topic");
      channels.add(`topic:${q.topic_id}`);
    }
    if (q.task_id) {
      if (!(await taskOk(user, q.task_id))) throw new Forbidden("you cannot view this task's execution details");
      channels.add(`task:${q.task_id}`);
    }
    if (q.admin === "true") {
      if (!(await adminOk(user))) throw new Forbidden("admin stream requires audit.view or instance.manage");
      channels.add("admin");
    }
    // Inbox: which topics the person can view got new messages (for unread markers); never message content.
    // The same always-open stream tells the console which configuration area changed.
    const inbox = q.inbox === "true";
    if (inbox) channels.add(CONFIG_CHANNEL);
    const viewable = new Map<string, { ok: boolean; until: number }>();
    const canViewTopic = async (topicId: string) => {
      const hit = viewable.get(topicId);
      if (hit && hit.until > Date.now()) return hit.ok;
      const ok = await topicOk(user, topicId).catch(() => false);
      viewable.set(topicId, { ok, until: Date.now() + 30_000 });
      return ok;
    };
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    let queue = Promise.resolve();
    const unsubscribe = runtime().bus.subscribe((event) => {
      if (inbox && (event.type === "message.created" || event.type === "approval.changed")) {
        const topicId = event.channels.find((c) => c.startsWith("topic:"))?.slice("topic:".length);
        if (topicId) {
          queue = queue.then(async () => {
            if (res.writableEnded || !(await canViewTopic(topicId))) return;
            if (event.type === "approval.changed") {
              res.write(`event: approval.changed\ndata: ${JSON.stringify(event.data)}\n\n`);
            } else {
              const data = { topic_id: topicId, at: event.data.created_at, author_type: event.data.author_type };
              res.write(`event: topic.activity\ndata: ${JSON.stringify(data)}\n\n`);
            }
          });
        }
      }
      const matched = event.channels.filter((c) => channels.has(c));
      if (!matched.length) return;
      // Serialise per connection so events keep their order.
      queue = queue.then(async () => {
        if (res.writableEnded) return;
        if (await allowed(user.id, matched, event).catch(() => false)) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
      });
    });
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });
}

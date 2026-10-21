import { topicLinkRoutes } from "./topic-links.js";
import "@fastify/multipart";
import fs from "node:fs";
import { and, desc, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ACTIVE, cancelTree } from "../agent/control.js";
import { dispatchHumanMessage, messageOut, saveMessage, systemMessage } from "../agent/dispatch.js";
import { recheckActiveTasks } from "../agent/revocation.js";
import { type Db, db as getDb, transaction } from "../db/client.js";
import {
  agentSessions,
  artifacts,
  computerInstances,
  memories,
  messages,
  roles,
  type Topic,
  taskSteps,
  tasks,
  topicParticipants,
  topics,
  triggerEvents,
  type User,
  users,
} from "../db/schema.js";
import { BadRequest, Forbidden, NotFound, Unauthorized } from "../errors.js";
import { type ChannelInfo, channelsOf, externalRoleId } from "../integrations/links.js";
import { isConsoleUser } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import { artifactPath, deleteArtifactData, saveArtifact } from "../services/files.js";
import { erased } from "../services/memories.js";
import { purgeMessage } from "../services/messages.js";
import { legacyParticipantChanges, roleParticipantChange } from "../services/participant-notices.js";
import * as svc from "../services/topics.js";
import { resolveToken } from "../services/users.js";
import { pruneWebhookReceipts } from "../services/webhook-sources.js";
import { authed, body, extractToken, params, query, row } from "./http.js";
import { sessionOut } from "./sessions.js";

const MAX_UPLOAD = 50 * 1024 * 1024;

/**
 * A topic linked to a Slack, Feishu or GitHub conversation: its people are the conversation's, and its role is the
 * one the connection's bot stands for (changed on the connection, which replaces it in every linked topic).
 */
async function refuseExternalMembers(db: Db, topic: Topic): Promise<void> {
  if ((await externalRoleId(db, topic.id)) !== undefined)
    throw new BadRequest(
      "members of a Slack, Feishu or GitHub conversation follow the conversation; its role is the one the connection's bot stands for",
    );
}

async function participantsOut(db: Db, topic: Topic) {
  const out = [];
  for (const p of await svc.participants(db, topic.id)) {
    if (p.participantType === "user") {
      const [u] = await db.select().from(users).where(eq(users.id, p.participantId)).limit(1);
      out.push({
        type: "user",
        id: p.participantId,
        name: u?.name ?? "?",
        joined_at: p.joinedAt.toISOString(),
      });
    } else {
      const r = await svc.getRole(db, p.participantId);
      const [inst] = r?.instanceId
        ? await db.select().from(computerInstances).where(eq(computerInstances.id, r.instanceId)).limit(1)
        : [];
      out.push({
        type: "role",
        id: p.participantId,
        name: r?.name ?? "?",
        handle: r?.handle ?? null,
        avatar_url: r?.avatarUrl ?? null,
        color: r?.color ?? null,
        // the computer the role works on, shown as a badge next to it
        instance: inst ? { id: inst.id, name: inst.name, color: inst.color } : null,
        status: r?.status ?? null,
        joined_at: p.joinedAt.toISOString(),
      });
    }
  }
  return out;
}

/** What a list needs about each topic, looked up once for a batch of topics rather than topic by topic. */
interface ListFacts {
  channels: Map<string, ChannelInfo>;
  /** The roles taking part in each topic. */
  roleIds: Map<string, string[]>;
  /** Topics the person takes part in. */
  joined: Set<string>;
  /** Status of the roles of DMs. */
  roleStatus: Map<string, string>;
}

/** Topics per batch of list lookups: a query takes at most 65535 parameters. */
const LIST_BATCH = 1000;

/** Topics as lists show them (no participants), each batch's facts asked for in a few queries. */
async function listOut(db: Db, rows: Topic[], user: User) {
  const out = [];
  for (let i = 0; i < rows.length; i += LIST_BATCH) {
    const batch = rows.slice(i, i + LIST_BATCH);
    const ids = batch.map((t) => t.id);
    const facts: ListFacts = {
      channels: await channelsOf(db, ids),
      roleIds: new Map(),
      joined: new Set(),
      roleStatus: new Map(),
    };
    for (const p of await db
      .select({
        topicId: topicParticipants.topicId,
        type: topicParticipants.participantType,
        id: topicParticipants.participantId,
      })
      .from(topicParticipants)
      .where(
        and(
          inArray(topicParticipants.topicId, ids),
          isNull(topicParticipants.removedAt),
          or(
            eq(topicParticipants.participantType, "role"),
            and(eq(topicParticipants.participantType, "user"), eq(topicParticipants.participantId, user.id)),
          ),
        ),
      )) {
      if (p.type === "role") facts.roleIds.set(p.topicId, [...(facts.roleIds.get(p.topicId) ?? []), p.id]);
      else facts.joined.add(p.topicId);
    }
    const dmRoles = new Set(batch.flatMap((t) => (t.kind === "dm" ? (facts.roleIds.get(t.id) ?? []).slice(0, 1) : [])));
    if (dmRoles.size)
      for (const r of await db
        .select({ id: roles.id, status: roles.status })
        .from(roles)
        .where(inArray(roles.id, [...dmRoles])))
        facts.roleStatus.set(r.id, r.status);
    for (const t of batch) out.push(await topicOut(db, t, user, false, facts));
  }
  return out;
}

async function topicOut(db: Db, topic: Topic, user: User, detail = false, facts?: ListFacts) {
  const data: Record<string, any> = row(topic);
  // The roles taking part, for lists (e.g. which roles a connection's conversations involve).
  if (facts) data.role_ids = facts.roleIds.get(topic.id) ?? [];
  // Where it lives outside the console (Slack channel, GitHub issue ...), or null.
  data.channel = (facts?.channels ?? (await channelsOf(db, [topic.id]))).get(topic.id) ?? null;
  // A DM is "the conversation with this role" in sidebars.
  const dmRoleId =
    topic.kind !== "dm"
      ? undefined
      : facts
        ? facts.roleIds.get(topic.id)?.[0]
        : (await svc.participants(db, topic.id, "role"))[0]?.participantId;
  data.can_post = facts
    ? svc.postable(topic, facts.joined.has(topic.id), dmRoleId ? facts.roleStatus.get(dmRoleId) : undefined)
    : await svc.canPost(db, user, topic);
  if (topic.kind === "dm") data.dm_role_id = dmRoleId ?? null;
  if (detail) {
    data.participants = await participantsOut(db, topic);
  }
  return data;
}

export async function topicRoutes(app: FastifyInstance) {
  await topicLinkRoutes(app);
  app.get(
    "/api/topics",
    authed(async ({ db, user, req }) => {
      const q = query(req);
      const mine = db
        .select({ id: topicParticipants.topicId })
        .from(topicParticipants)
        .where(
          and(
            eq(topicParticipants.participantType, "user"),
            eq(topicParticipants.participantId, user.id),
            isNull(topicParticipants.removedAt),
          ),
        );
      // Console accounts see every conversation; anyone else only their own.
      const conds: (SQL | undefined)[] = isConsoleUser(user) ? [] : [inArray(topics.id, mine)];
      if (q.include_archived !== "true") conds.push(eq(topics.status, "active"));
      if (q.q) conds.push(or(ilike(topics.title, `%${q.q}%`), ilike(topics.goal, `%${q.q}%`)));
      // All of them, most recent activity first: the console's sidebar shows the latest of each kind and its
      // "all conversations" page the rest.
      const rows = await db
        .select()
        .from(topics)
        .where(and(...conds))
        .orderBy(desc(topics.lastMessageAt), desc(topics.createdAt));
      return listOut(db, rows, user);
    }),
  );

  app.post(
    "/api/topics",
    authed(async ({ db, user, req }) => {
      const b = body(req);
      const topic = await svc.createTopic(db, user, b as any);
      await audit(db, "topic.create", {
        actorType: "user",
        actorId: user.id,
        resourceType: "topic",
        resourceId: topic.id,
        topicId: topic.id,
        detail: { kind: topic.kind },
      });
      return topicOut(db, topic, user, true);
    }),
  );

  app.post(
    "/api/dms",
    authed(async ({ db, user, req }) => {
      const role = await svc.getRole(db, String(body(req).roleId ?? ""));
      if (!role) throw new NotFound("role not found");
      return topicOut(db, await svc.getOrCreateDm(db, user, role), user, true);
    }),
  );

  app.get(
    "/api/topics/:id",
    authed(async ({ db, user, req }) => {
      const topic = await svc.getTopic(db, params(req).id);
      await svc.requireView(db, user, topic);
      return topicOut(db, topic, user, true);
    }),
  );

  app.patch(
    "/api/topics/:id",
    authed(async ({ db, user, req }) => {
      const topic = await svc.getTopic(db, params(req).id);
      const b = body(req);
      const keys = Object.keys(b);
      // A DM is one person and one role, always open: nothing to rename, archive or reconfigure.
      if (topic.kind === "dm" && keys.length)
        throw new BadRequest("a DM has no title, archive or response settings: it is always one person and one role");
      // So is the direct conversation of two roles (agent/contacts.ts).
      if (topic.kind === "pair" && keys.length)
        throw new BadRequest(
          "a conversation between two AI employees has no title, archive or response settings: it is always the two of them",
        );
      if (!(await svc.canAdminister(db, user, topic))) throw new Forbidden("only console accounts can change a topic");
      if (b.status !== undefined && !["active", "archived"].includes(b.status))
        throw new BadRequest("status must be active or archived");
      if (b.responseMode !== undefined) svc.parseResponseMode(b.responseMode);
      // An unchanged goal passes: merged work instructions (migration 0043) may have made an old one longer.
      if (b.goal !== undefined && b.goal !== topic.goal) svc.parseGoal(b.goal);
      // A topic is configured with its name and goal; status and response mode are switched elsewhere.
      const allowed = ["title", "goal", "status", "responseMode"];
      const update = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
      const [updated] = await db.update(topics).set(update).where(eq(topics.id, topic.id)).returning();
      if (b.status === "archived") {
        const ids = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.topicId, topic.id))).map((t) => t.id);
        await recheckActiveTasks(db, "topic archived", ids);
      }
      await audit(db, "topic.update", {
        actorType: "user",
        actorId: user.id,
        topicId: topic.id,
        detail: { fields: Object.keys(update) },
      });
      return topicOut(db, updated, user, true);
    }),
  );

  app.post(
    "/api/topics/:id/participants",
    authed(async ({ db, user, req }) => {
      const topic = await svc.getTopic(db, params(req).id);
      const b = body(req);
      if (!(await svc.canAdminister(db, user, topic))) throw new Forbidden("only console accounts can invite");
      if (topic.kind === "dm")
        throw new BadRequest("a DM is between one person and one role; start a topic to work with more");
      if (topic.kind === "pair")
        throw new BadRequest("a conversation between two AI employees keeps its two roles and has no people");
      await refuseExternalMembers(db, topic);
      if (b.type === "role") await svc.inviteRole(db, user, topic, String(b.id));
      else if (b.type === "user") {
        const [added] = await db
          .select()
          .from(users)
          .where(eq(users.id, String(b.id)))
          .limit(1);
        if (!added) throw new NotFound("user not found");
        // People from a connected workspace take part through their own Slack / Feishu conversations.
        if (added.externalConnectionId) throw new BadRequest("external members cannot be added to console topics");
        await svc.addParticipant(db, topic, "user", String(b.id), { invitedBy: user.id });
      } else throw new BadRequest("type must be user or role");
      const change = b.type === "role" ? await roleParticipantChange(db, String(b.id), "added", user.name) : undefined;
      await systemMessage(
        db,
        topic,
        `${user.name} added ${change ? `@${change.role.handle}` : "a user"} to the topic.`,
        // Who is in a topic is the console's business, not the linked conversations'.
        { participantChange: change, mirror: false },
      );
      await audit(db, "topic.participant_add", { actorType: "user", actorId: user.id, topicId: topic.id, detail: b });
      return topicOut(db, topic, user, true);
    }),
  );

  app.delete(
    "/api/topics/:id/participants/:type/:pid",
    authed(async ({ db, user, req }) => {
      const p = params(req);
      const topic = await svc.getTopic(db, p.id);
      if (topic.kind === "dm") throw new BadRequest("a DM always keeps its person and its role");
      if (topic.kind === "pair") throw new BadRequest("a conversation between two AI employees keeps its two roles");
      await refuseExternalMembers(db, topic);
      if (!((await svc.canAdminister(db, user, topic)) || (p.type === "user" && p.pid === user.id)))
        throw new Forbidden("only topic owners can remove participants");
      if (!(await svc.removeParticipant(db, topic, p.type, p.pid))) throw new NotFound("not a participant");
      const ids = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.topicId, topic.id))).map((t) => t.id);
      const cancelled = await recheckActiveTasks(db, "participant removed", ids);
      const change = p.type === "role" ? await roleParticipantChange(db, p.pid, "removed", user.name) : undefined;
      await systemMessage(
        db,
        topic,
        `${change ? `@${change.role.handle ?? change.role.name}` : "A user"} left the topic.`,
        { participantChange: change, mirror: false },
      );
      await audit(db, "topic.participant_remove", {
        actorType: "user",
        actorId: user.id,
        topicId: topic.id,
        detail: { type: p.type, id: p.pid, tasks_cancelled: cancelled },
      });
      return topicOut(db, topic, user, true);
    }),
  );

  /** Agent sessions in this topic: one per role, each with its own context. */
  app.get(
    "/api/topics/:id/sessions",
    authed(async ({ db, user, req }) => {
      const topic = await svc.getTopic(db, params(req).id);
      await svc.requireView(db, user, topic);
      const out = [];
      for (const s of await db.select().from(agentSessions).where(eq(agentSessions.topicId, topic.id))) {
        const [role] = await db.select().from(roles).where(eq(roles.id, s.roleId)).limit(1);
        out.push({
          ...(await sessionOut(db, s)),
          role: role ? { id: role.id, handle: role.handle, name: role.name } : null,
        });
      }
      return out;
    }),
  );

  app.get(
    "/api/topics/:id/messages",
    authed(async ({ db, user, req }) => {
      const topic = await svc.getTopic(db, params(req).id);
      await svc.requireView(db, user, topic);
      const q = query(req);
      const msgs = await svc.visibleMessages(db, topic, {
        limit: Math.min(Number(q.limit ?? 100), 500),
        before: q.before ? new Date(q.before) : null,
      });
      const legacy = await legacyParticipantChanges(db, msgs);
      return msgs.map((msg) => ({
        ...messageOut(msg),
        ...(legacy.has(msg.id) ? { participant_change: legacy.get(msg.id) } : {}),
      }));
    }),
  );

  app.post(
    "/api/topics/:id/messages",
    authed(async ({ db, user, req }) => {
      const topic = await svc.getTopic(db, params(req).id);
      if (topic.kind === "pair")
        throw new Forbidden("only its two AI employees write in this conversation; people can read it");
      if (!(await svc.canPost(db, user, topic)))
        throw new Forbidden("you are not a participant of this topic (or it is archived)");
      const b = body(req);
      const content = String(b.content ?? "");
      const attachments: string[] = b.attachments ?? [];
      if (!content.trim() && !attachments.length) throw new BadRequest("message is empty");
      for (const id of attachments) {
        const [art] = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
        if (!art || art.topicId !== topic.id || art.createdById !== user.id)
          throw new BadRequest("attachments must be files you uploaded to this topic");
      }
      if (b.mentions) {
        // Structured mentions from the UI must point at participants of this topic.
        for (const m of b.mentions) {
          if (!(await svc.participant(db, topic.id, m.type, m.id)))
            throw new BadRequest(`mentioned ${m.type} is not in this topic`);
        }
      }
      const msg = await saveMessage(db, topic, "user", user.id, content, {
        mentions: b.mentions ?? null,
        replyToId: b.replyToId ?? null,
        attachments,
      });
      const created = await dispatchHumanMessage(db, topic, msg, user);
      return {
        ...messageOut(msg),
        // joined: the role was already working in this conversation and takes the message at its next step.
        tasks: created.map((t) => ({
          id: t.id,
          owner_role_id: t.ownerRoleId,
          status: t.status,
          kind: t.kind,
          joined: t.createdAt < msg.createdAt,
        })),
      };
    }),
  );

  // --- files ---
  app.post("/api/topics/:id/files", async (req) => {
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD + 1 } });
    if (!file) throw new BadRequest("file is required");
    const data = await file.toBuffer();
    if (data.length > MAX_UPLOAD) throw new BadRequest("file too large (50 MB max)");
    return transaction(async (db) => {
      const user = await resolveToken(db, extractToken(req));
      if (!user) throw new Unauthorized("authentication required");
      const topic = await svc.getTopic(db, params(req).id);
      if (!(await svc.canPost(db, user, topic))) throw new Forbidden("you are not a participant of this topic");
      const art = await saveArtifact(db, data, {
        name: file.filename || "upload",
        kind: "upload",
        topicId: topic.id,
        createdByType: "user",
        createdById: user.id,
        mime: file.mimetype,
      });
      await audit(db, "file.upload", {
        actorType: "user",
        actorId: user.id,
        topicId: topic.id,
        detail: { file: art.id, name: art.name, size: art.size },
      });
      return row(art);
    });
  });

  app.get(
    "/api/topics/:id/files",
    authed(async ({ db, user, req }) => {
      const topic = await svc.getTopic(db, params(req).id);
      await svc.requireView(db, user, topic);
      const rows = await db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.topicId, topic.id), isNull(artifacts.deletedAt)))
        .orderBy(desc(artifacts.createdAt));
      return rows.map((a) => row(a));
    }),
  );

  app.get(
    "/api/files/:id",
    authed(async ({ db, user, req, reply }) => {
      const [art] = await db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, params(req).id))
        .limit(1);
      if (!art || art.deletedAt) throw new NotFound("file not found");
      if (art.topicId) {
        const topic = await svc.getTopic(db, art.topicId);
        if (!(await svc.canDownload(db, user, topic))) throw new Forbidden("you cannot download files from this topic");
      } else {
        // A file held with a message for disclosure approval (before migration 0032): people who see its task.
        const [task] = art.taskId ? await db.select().from(tasks).where(eq(tasks.id, art.taskId)).limit(1) : [];
        const topic = task ? await svc.getTopic(db, task.topicId) : null;
        if (!topic || !(await svc.canView(db, user, topic))) throw new Forbidden("you cannot download this file");
      }
      await audit(db, "file.download", {
        actorType: "user",
        actorId: user.id,
        topicId: art.topicId,
        detail: { file: art.id },
      });
      reply
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(art.name)}`)
        .type(art.mime);
      return fs.createReadStream(artifactPath(art));
    }),
  );

  app.delete(
    "/api/files/:id",
    authed(async ({ db, user, req }) => {
      const [art] = await db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, params(req).id))
        .limit(1);
      if (!art || art.deletedAt) throw new NotFound("file not found");
      const topic = art.topicId ? await svc.getTopic(db, art.topicId) : null;
      if (!(art.createdById === user.id || (topic && (await svc.canAdminister(db, user, topic)))))
        throw new Forbidden("you cannot delete this file");
      await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, art.id));
      deleteArtifactData(art);
      await audit(db, "file.delete", {
        actorType: "user",
        actorId: user.id,
        topicId: art.topicId,
        detail: { file: art.id },
      });
      return { ok: true };
    }),
  );

  app.post(
    "/api/topics/:id/cleanup",
    authed(async ({ db, user, req }) => {
      // Clear a topic's conversation, derived memories and files. Audit records keep only metadata.
      const topic = await svc.getTopic(db, params(req).id);
      if (!(await svc.canAdminister(db, user, topic)))
        throw new Forbidden("only topic owners or administrators can clean up a topic");
      const b = body(req);
      if (!b.confirm)
        throw new BadRequest("this permanently clears data; repeat with confirm=true", {
          code: "confirmation_required",
        });
      const counts = { messages: 0, memories: 0, files: 0 };
      // Raw requests are another part of this topic's history, including receipts still in the queue.
      if (b.triggerHistory !== false) {
        await db.delete(triggerEvents).where(eq(triggerEvents.topicId, topic.id));
        await pruneWebhookReceipts(db);
      }
      if (b.messages !== false) {
        for (const m of await db
          .select()
          .from(messages)
          .where(and(eq(messages.topicId, topic.id), isNull(messages.deletedAt)))) {
          await purgeMessage(db, m);
          counts.messages++;
        }
      }
      if (b.memories !== false) {
        const rows = await db
          .update(memories)
          .set(erased())
          .where(and(eq(memories.topicId, topic.id), isNull(memories.deletedAt)))
          .returning();
        counts.memories = rows.length;
      }
      if (b.files !== false) {
        for (const a of await db
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.topicId, topic.id), isNull(artifacts.deletedAt)))) {
          await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, a.id));
          deleteArtifactData(a);
          counts.files++;
        }
      }
      // The roles' conversations here start over: open runs stop, their contexts and inboxes are emptied.
      for (const t of await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.topicId, topic.id), eq(tasks.kind, "conversation"), inArray(tasks.status, [...ACTIVE]))))
        await cancelTree(db, t, "the topic was cleared");
      // Task transcripts and the roles' session notes contain the same content.
      for (const t of await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.topicId, topic.id))) {
        await db.delete(taskSteps).where(eq(taskSteps.taskId, t.id));
        if (b.messages !== false) await db.update(tasks).set({ result: null }).where(eq(tasks.id, t.id));
      }
      await db
        .update(agentSessions)
        .set({
          notes: [],
          inbox: [],
          contextFrom: 0,
          contextTokens: 0,
          cursorAt: null,
          roster: null,
          awaiting: null,
          wakeAt: null,
        })
        .where(eq(agentSessions.topicId, topic.id));
      await audit(db, "topic.cleanup", { actorType: "user", actorId: user.id, topicId: topic.id, detail: counts });
      return counts;
    }),
  );
}

export { getDb };

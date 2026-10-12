import "@fastify/multipart";
import fs from "node:fs";
import { and, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
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
  type User,
  users,
} from "../db/schema.js";
import { BadRequest, Forbidden, NotFound, Unauthorized } from "../errors.js";
import { externalContext } from "../integrations/links.js";
import { topicLabel, userCanRead } from "../security/labels.js";
import { audit } from "../services/audit.js";
import { artifactPath, deleteArtifactData, saveArtifact } from "../services/files.js";
import { purgeMessage } from "../services/messages.js";
import * as svc from "../services/topics.js";
import { resolveToken } from "../services/users.js";
import { authed, body, extractToken, params, query, row } from "./http.js";

const MAX_UPLOAD = 50 * 1024 * 1024;

async function participantsOut(db: Db, topic: Topic) {
  const out = [];
  for (const p of await svc.participants(db, topic.id)) {
    if (p.participantType === "user") {
      const [u] = await db.select().from(users).where(eq(users.id, p.participantId)).limit(1);
      out.push({
        type: "user",
        id: p.participantId,
        name: u?.name ?? "?",
        is_owner: p.isOwner,
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
        is_owner: p.isOwner,
        joined_at: p.joinedAt.toISOString(),
      });
    }
  }
  return out;
}

async function topicOut(db: Db, topic: Topic, user: User, detail = false) {
  const data: Record<string, any> = row(topic);
  data.is_owner = await svc.isOwner(db, user, topic);
  data.can_post = await svc.canPost(db, user, topic);
  data.can_view = await svc.canView(db, user, topic);
  data.can_administer = await svc.canAdminister(db, user, topic);
  // A DM is "the conversation with this role" in sidebars.
  if (topic.kind === "dm") data.dm_role_id = (await svc.participants(db, topic.id, "role"))[0]?.participantId ?? null;
  if (detail) {
    data.participants = await participantsOut(db, topic);
    const ext = await externalContext(db, topic.id);
    data.external = Object.keys(ext).length
      ? {
          connection_id: ext.connectionId,
          conversation_id: ext.conversationId,
          conversation_kind: ext.conversationKind,
          thread_key: ext.threadKey,
        }
      : null;
  }
  return data;
}

export async function topicRoutes(app: FastifyInstance) {
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
      const conds = [
        user.isAdmin
          ? or(inArray(topics.id, mine), eq(topics.kind, "group"))
          : or(inArray(topics.id, mine), and(eq(topics.visibility, "internal"), eq(topics.kind, "group"))),
      ];
      if (q.include_archived !== "true") conds.push(eq(topics.status, "active"));
      if (q.q) conds.push(or(ilike(topics.title, `%${q.q}%`), ilike(topics.goal, `%${q.q}%`)));
      const rows = await db
        .select()
        .from(topics)
        .where(and(...conds))
        .orderBy(desc(topics.lastMessageAt), desc(topics.createdAt))
        .limit(300);
      const out = [];
      for (const t of rows) {
        if (await svc.canView(db, user, t)) out.push(await topicOut(db, t, user));
        else if (user.isAdmin && t.kind === "group") out.push(await topicOut(db, t, user)); // metadata only, for management
      }
      return out;
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
        detail: { visibility: topic.visibility },
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
      if ((await svc.canView(db, user, topic)) || (user.isAdmin && topic.kind === "group"))
        return topicOut(db, topic, user, true);
      throw new Forbidden("you cannot view this topic");
    }),
  );

  app.patch(
    "/api/topics/:id",
    authed(async ({ db, user, req }) => {
      const topic = await svc.getTopic(db, params(req).id);
      const b = body(req);
      const keys = Object.keys(b);
      // A DM is one person and one role, always open: nothing to rename, archive or reconfigure.
      if (topic.kind === "dm" && keys.some((k) => k !== "allowedModelConfigIds"))
        throw new BadRequest("a DM has no title, archive or response settings: it is always one person and one role");
      if (!(await svc.isOwner(db, user, topic))) {
        // Administrators may archive / reactivate a topic they are not in, but not change who can read it.
        if (!((await svc.canAdminister(db, user, topic)) && keys.every((k) => k === "status")))
          throw new Forbidden("only topic owners can change the topic");
      }
      if (b.status !== undefined && !["active", "archived"].includes(b.status))
        throw new BadRequest("status must be active or archived");
      if (b.visibility !== undefined && (!["private", "internal"].includes(b.visibility) || topic.kind === "dm"))
        throw new BadRequest("invalid visibility");
      if (b.responseMode !== undefined) svc.parseResponseMode(b.responseMode);
      const allowed = [
        "title",
        "goal",
        "status",
        "visibility",
        "responseMode",
        "maxAutoRounds",
        "allowedModelConfigIds",
      ];
      const update = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
      const [updated] = await db.update(topics).set(update).where(eq(topics.id, topic.id)).returning();
      if (b.status === "archived") {
        const ids = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.topicId, topic.id))).map((t) => t.id);
        await recheckActiveTasks(db, "topic archived", ids);
      }
      await audit(db, "topic.update", { actorType: "user", actorId: user.id, topicId: topic.id, detail: b });
      return topicOut(db, updated, user, true);
    }),
  );

  app.post(
    "/api/topics/:id/participants",
    authed(async ({ db, user, req }) => {
      const topic = await svc.getTopic(db, params(req).id);
      const b = body(req);
      if (!(await svc.canPost(db, user, topic))) throw new Forbidden("only participants can invite");
      if (topic.kind === "dm")
        throw new BadRequest("a DM is between one person and one role; start a topic to work with more");
      if (b.type === "role") await svc.inviteRole(db, user, topic, String(b.id));
      else if (b.type === "user") {
        if (!(await svc.isOwner(db, user, topic))) throw new Forbidden("only topic owners can add people");
        if (
          !(
            await db
              .select()
              .from(users)
              .where(eq(users.id, String(b.id)))
              .limit(1)
          ).length
        )
          throw new NotFound("user not found");
        await svc.addParticipant(db, topic, "user", String(b.id), { invitedBy: user.id });
      } else throw new BadRequest("type must be user or role");
      await systemMessage(db, topic, `${user.name} added a ${b.type} to the topic.`);
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
      if (!((await svc.canAdminister(db, user, topic)) || (p.type === "user" && p.pid === user.id)))
        throw new Forbidden("only topic owners can remove participants");
      if (!(await svc.removeParticipant(db, topic, p.type, p.pid))) throw new NotFound("not a participant");
      const ids = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.topicId, topic.id))).map((t) => t.id);
      const cancelled = await recheckActiveTasks(db, "participant removed", ids);
      await systemMessage(db, topic, `A ${p.type} left the topic.`);
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
        out.push({ ...row(s), role: role ? { id: role.id, handle: role.handle, name: role.name } : null });
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
      return msgs.map(messageOut);
    }),
  );

  app.post(
    "/api/topics/:id/messages",
    authed(async ({ db, user, req }) => {
      const topic = await svc.getTopic(db, params(req).id);
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
        tasks: created.map((t) => ({ id: t.id, owner_role_id: t.ownerRoleId, status: t.status })),
      };
    }),
  );

  app.patch(
    "/api/messages/:id",
    authed(async ({ db, user, req }) => {
      const [msg] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, params(req).id))
        .limit(1);
      if (!msg || msg.deletedAt) throw new NotFound("message not found");
      if (msg.authorType !== "user" || msg.authorId !== user.id)
        throw new Forbidden("you can only edit your own messages");
      const [updated] = await db
        .update(messages)
        .set({ content: String(body(req).content ?? ""), editedAt: new Date() })
        .where(eq(messages.id, msg.id))
        .returning();
      await audit(db, "message.edit", {
        actorType: "user",
        actorId: user.id,
        topicId: msg.topicId,
        detail: { message_id: msg.id },
      });
      return messageOut(updated);
    }),
  );

  app.delete(
    "/api/messages/:id",
    authed(async ({ db, user, req }) => {
      const [msg] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, params(req).id))
        .limit(1);
      if (!msg || msg.deletedAt) throw new NotFound("message not found");
      const topic = await svc.getTopic(db, msg.topicId);
      if (!((msg.authorType === "user" && msg.authorId === user.id) || (await svc.canAdminister(db, user, topic))))
        throw new Forbidden("you cannot delete this message");
      const purged = await purgeMessage(db, msg);
      await audit(db, "message.delete", {
        actorType: "user",
        actorId: user.id,
        topicId: msg.topicId,
        detail: { message_id: msg.id, ...purged },
      });
      return { ok: true, ...purged };
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
        labels: [topicLabel(topic.id)],
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
      const out = [];
      for (const a of rows) if (await userCanRead(db, user.id, a.labels)) out.push(row(a));
      return out;
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
        // A file held for disclosure approval: only people who may read all of its sources.
        const [task] = art.taskId ? await db.select().from(tasks).where(eq(tasks.id, art.taskId)).limit(1) : [];
        const topic = task ? await svc.getTopic(db, task.topicId) : null;
        if (!topic || !(await svc.canView(db, user, topic))) throw new Forbidden("you cannot download this file");
      }
      if (!(await userCanRead(db, user.id, art.labels)))
        throw new Forbidden("this file draws on material you are not allowed to see");
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
          .set({ deletedAt: new Date(), content: "" })
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
      // Task transcripts and the roles' session notes contain the same content.
      for (const t of await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.topicId, topic.id))) {
        await db.delete(taskSteps).where(eq(taskSteps.taskId, t.id));
        if (b.messages !== false) await db.update(tasks).set({ result: null }).where(eq(tasks.id, t.id));
      }
      await db.update(agentSessions).set({ notes: [] }).where(eq(agentSessions.topicId, topic.id));
      await audit(db, "topic.cleanup", { actorType: "user", actorId: user.id, topicId: topic.id, detail: counts });
      return counts;
    }),
  );
}

export { getDb };

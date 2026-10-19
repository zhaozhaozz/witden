/**
 * The Feishu tools roles call (permissions and calls: integrations/feishu-tools.ts). Each tool belongs to
 * a product and a mode, its group being ``feishu:<product>:<mode>``; ``toolsFor`` offers it when the task holds that
 * product and mode for at least one app, and ``app`` picks which when there are several.
 */
import { and, eq } from "drizzle-orm";
import { settings } from "../config.js";
import type { Db } from "../db/client.js";
import { connections, externalIdentities, tasks } from "../db/schema.js";
import { BadRequest } from "../errors.js";
import { explainFeishuError, FEISHU_PRODUCTS, type FeishuMode, feishuApi } from "../integrations/feishu-tools.js";
import { connectionFor, grantedApps, parseGrant } from "../integrations/platform-tools.js";
import type { ToolContext, ToolResult, ToolSpec } from "./tools.js";

const str = { type: "string" };
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: "object", properties, required });
const appArg = {
  type: "string",
  description: "Feishu app (connection id) to use; needed only when several are open to you (see feishu_apps)",
};
const timeArg = (what: string) => ({
  type: "string",
  description: `${what}, ISO 8601 with offset, e.g. 2026-10-20T10:00:00+08:00`,
});

function clip(text: string): string {
  const limit = settings().toolOutputLimit;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

async function envelopeTools(db: Db, taskId: string): Promise<string[]> {
  const [task] = await db.select({ envelope: tasks.envelope }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return (task?.envelope as { tools?: string[] } | undefined)?.tools ?? [];
}

/** Seconds since the epoch, as Feishu wants them, from an ISO time. */
function unix(value: unknown, what: string): string {
  const t = Date.parse(String(value ?? ""));
  if (Number.isNaN(t)) throw new BadRequest(`${what} must be an ISO 8601 time, e.g. 2026-10-20T10:00:00+08:00`);
  return String(Math.floor(t / 1000));
}

/** The token in a Feishu link (…/docx/<token>, …/wiki/<token>, …/base/<token>, …/sheets/<token>) or the token itself. */
function tokenOf(value: unknown, what: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new BadRequest(`${what} is required`);
  const m = /\/(?:docx|docs|wiki|base|sheets|drive\/folder|file)\/([A-Za-z0-9]+)/.exec(s);
  return m ? m[1] : s;
}

/**
 * Run a Feishu call for a product and mode: the app is checked against the task's grants, Feishu's refusals are
 * explained.
 */
function feishuTool(
  name: string,
  product: string,
  mode: FeishuMode,
  description: string,
  properties: Record<string, any>,
  required: string[],
  run: (conn: any, args: Record<string, any>, call: { db: Db; taskId: string }) => Promise<unknown>,
): ToolSpec {
  return {
    name,
    group: `feishu:${product}:${mode}`,
    description,
    parameters: obj({ ...properties, app: appArg }, required),
    handler: async (ctx: ToolContext, args: Record<string, any>): Promise<ToolResult> => {
      const db = ctx.db();
      const conn = await connectionFor(db, await envelopeTools(db, ctx.taskId), "feishu", product, mode, args.app);
      try {
        const out = await run(conn, args, { db, taskId: ctx.taskId });
        return { content: clip(typeof out === "string" ? out : JSON.stringify(out, null, 1)) };
      } catch (err) {
        if (err instanceof BadRequest) throw err;
        return { content: `error: ${explainFeishuError(err as Error)}` };
      }
    },
  };
}

/** A docx document id from a document or wiki link (a wiki node is looked up to the document under it). */
async function documentId(conn: any, value: unknown): Promise<string> {
  const s = String(value ?? "");
  const token = tokenOf(s, "document");
  if (!/\/wiki\//.test(s)) return token;
  const { node } = await feishuApi(conn, "GET", "wiki/v2/spaces/get_node", { params: { token } });
  if (node?.obj_type !== "docx") throw new BadRequest(`this wiki page is a ${node?.obj_type ?? "?"}, not a document`);
  return node.obj_token;
}

const paragraphs = (text: string) =>
  String(text)
    .split("\n")
    .map((line) => ({ block_type: 2, text: { elements: [{ text_run: { content: line } }] } }));

/** Append paragraphs at the end of a document; Feishu takes at most 50 blocks a call. */
async function appendText(conn: any, doc: string, text: string) {
  const all = paragraphs(text);
  for (let i = 0; i < all.length; i += 50)
    await feishuApi(conn, "POST", `docx/v1/documents/${doc}/blocks/${doc}/children`, {
      params: { document_revision_id: "-1" },
      body: { children: all.slice(i, i + 50), index: -1 },
    });
}

/** Who the requester is in this company's Feishu, when known: meetings and tasks need an owner there. */
async function requesterOpenId(db: Db, taskId: string, conn: any): Promise<string | null> {
  const [task] = await db.select({ user: tasks.requesterUserId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task?.user) return null;
  const [ident] = await db
    .select({ id: externalIdentities.externalUserId })
    .from(externalIdentities)
    .where(and(eq(externalIdentities.connectionId, conn.id), eq(externalIdentities.userId, task.user)))
    .limit(1);
  return ident?.id ?? null;
}

/** A calendar as tools show it. */
const calendarOut = (c: any) => ({
  calendar_id: c?.calendar_id,
  summary: c?.summary,
  description: c?.description || undefined,
  type: c?.type,
  permissions: c?.permissions,
  role: c?.role,
});

const PERMISSIONS = ["public", "show_only_free_busy", "private"];
const ACL_ROLES = ["owner", "writer", "reader", "free_busy_reader"];

function oneOf(value: unknown, allowed: string[], what: string): string {
  const s = String(value ?? "");
  if (!allowed.includes(s)) throw new BadRequest(`${what} must be one of ${allowed.join(", ")}`);
  return s;
}

const openIds = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

/** A calendar's members (its access list); only its owner may see them. */
async function calendarMembers(conn: any, calendarId: string) {
  const out: { acl_id: string; role: string; user: string }[] = [];
  let page: string | undefined;
  do {
    const data = await feishuApi(conn, "GET", `calendar/v4/calendars/${calendarId}/acls`, {
      params: { user_id_type: "open_id", page_size: "50", ...(page ? { page_token: page } : {}) },
    });
    for (const a of data.acls ?? []) out.push({ acl_id: a.acl_id, role: a.role, user: a.scope?.user_id });
    page = data.has_more ? data.page_token : undefined;
  } while (page);
  return out;
}

const appsTool: ToolSpec = {
  name: "feishu_apps",
  group: "feishu:apps",
  description:
    "List the Feishu apps (companies) whose tools you may use, what you may do with each, and the people witden knows there (with their open_id, for attendees and assignees).",
  parameters: obj({}),
  handler: async (ctx) => {
    const db = ctx.db();
    const tools = await envelopeTools(db, ctx.taskId);
    const ids = [
      ...new Set(
        tools
          .map(parseGrant)
          .filter((g) => g?.platform === "feishu")
          .map((g) => g!.connectionId),
      ),
    ];
    const lines: string[] = [];
    for (const id of ids) {
      const [conn] = await db.select().from(connections).where(eq(connections.id, id)).limit(1);
      if (conn?.platform !== "feishu") continue;
      const can = FEISHU_PRODUCTS.flatMap((p) =>
        (["read", "write"] as FeishuMode[])
          .filter((m) => grantedApps(tools, "feishu", p.key, m).includes(id))
          .map((m) => `${p.key} ${m}`),
      );
      const people = await db
        .select({ id: externalIdentities.externalUserId, name: externalIdentities.displayName })
        .from(externalIdentities)
        .where(eq(externalIdentities.connectionId, id))
        .limit(100);
      lines.push(
        `- ${conn.name} (app: ${id}${conn.status === "paused" ? ", paused" : ""}): ${can.join(", ")}`,
        `  people: ${people.map((p) => `${p.name ?? "?"} ${p.id}`).join("; ") || "(none known yet)"}`,
      );
    }
    return { content: lines.join("\n") || "no Feishu app is open to you" };
  },
};

export const FEISHU_TOOLS: ToolSpec[] = [
  appsTool,
  // --- calendar
  feishuTool(
    "feishu_calendar_list",
    "calendar",
    "read",
    "List the Feishu calendars the app has: its own, the shared calendars it created or subscribed to, and those it was made a member of; with your role in each (owner, writer, reader, free_busy_reader).",
    {},
    [],
    async (conn) => {
      const data = await feishuApi(conn, "GET", "calendar/v4/calendars", { params: { page_size: "50" } });
      return (data.calendar_list ?? []).map(calendarOut);
    },
  ),
  feishuTool(
    "feishu_calendar_search",
    "calendar",
    "read",
    "Find the company's public (shared) calendars whose title or description contains a keyword; people's own calendars are not found. Subscribe to one (feishu_calendar_subscribe) to read its events.",
    { query: str },
    ["query"],
    async (conn, a) => {
      const data = await feishuApi(conn, "POST", "calendar/v4/calendars/search", {
        params: { page_size: "50" },
        body: { query: String(a.query ?? "").slice(0, 200) },
      });
      return (data.items ?? []).map(calendarOut);
    },
  ),
  feishuTool(
    "feishu_calendar_members",
    "calendar",
    "read",
    "Who may use a calendar the app owns, and how: owner (manages it and its members), writer (creates and changes events), reader (sees events), free_busy_reader (sees only busy times).",
    { calendar_id: str },
    ["calendar_id"],
    async (conn, a) => calendarMembers(conn, String(a.calendar_id)),
  ),
  feishuTool(
    "feishu_calendar_events",
    "calendar",
    "read",
    "List the events of a Feishu calendar between two times.",
    { calendar_id: str, start: timeArg("from"), end: timeArg("until") },
    ["calendar_id", "start", "end"],
    async (conn, a) => {
      const data = await feishuApi(conn, "GET", `calendar/v4/calendars/${a.calendar_id}/events`, {
        params: { start_time: unix(a.start, "start"), end_time: unix(a.end, "end"), page_size: "500" },
      });
      return (data.items ?? []).map((e: any) => ({
        event_id: e.event_id,
        summary: e.summary,
        start: e.start_time,
        end: e.end_time,
        location: e.location?.name,
        status: e.status,
      }));
    },
  ),
  feishuTool(
    "feishu_calendar_event",
    "calendar",
    "read",
    "One event of a Feishu calendar: its details and who is invited (with their replies).",
    { calendar_id: str, event_id: str },
    ["calendar_id", "event_id"],
    async (conn, a) => {
      const path = `calendar/v4/calendars/${a.calendar_id}/events/${a.event_id}`;
      const { event: e } = await feishuApi(conn, "GET", path);
      const people = await feishuApi(conn, "GET", `${path}/attendees`, {
        params: { user_id_type: "open_id", page_size: "100" },
      });
      return {
        event_id: e?.event_id,
        summary: e?.summary,
        description: e?.description,
        start: e?.start_time,
        end: e?.end_time,
        location: e?.location?.name,
        status: e?.status,
        organizer: e?.event_organizer?.display_name,
        link: e?.app_link,
        attendees: (people.items ?? []).map((p: any) => ({
          name: p.display_name,
          user: p.user_id,
          type: p.type,
          reply: p.rsvp_status,
          organizer: p.is_organizer || undefined,
        })),
      };
    },
  ),
  feishuTool(
    "feishu_calendar_freebusy",
    "calendar",
    "read",
    "When a person (their open_id, see feishu_apps) is busy between two times (at most 90 days apart).",
    { user: str, start: timeArg("from"), end: timeArg("until") },
    ["user", "start", "end"],
    async (conn, a) => {
      const rfc = (v: unknown, what: string) => new Date(Number(unix(v, what)) * 1000).toISOString();
      const data = await feishuApi(conn, "POST", "calendar/v4/freebusy/list", {
        params: { user_id_type: "open_id" },
        body: { time_min: rfc(a.start, "start"), time_max: rfc(a.end, "end"), user_id: String(a.user) },
      });
      return (data.freebusy_list ?? []).map((b: any) => ({ busy_from: b.start_time, busy_until: b.end_time }));
    },
  ),
  feishuTool(
    "feishu_calendar_create",
    "calendar",
    "write",
    "Create a shared Feishu calendar owned by the app, e.g. the organization's public calendar; add its members with feishu_calendar_share (an administrator as owner too, so people can manage it in Feishu).",
    {
      summary: str,
      description: str,
      permissions: {
        type: "string",
        enum: PERMISSIONS,
        description:
          "public: anyone in the company may subscribe and see the events; show_only_free_busy (default): only busy times; private: members only",
      },
    },
    ["summary"],
    async (conn, a) => {
      const { calendar } = await feishuApi(conn, "POST", "calendar/v4/calendars", {
        body: {
          summary: String(a.summary),
          description: a.description ? String(a.description) : undefined,
          permissions: a.permissions ? oneOf(a.permissions, PERMISSIONS, "permissions") : undefined,
        },
      });
      return calendarOut(calendar);
    },
  ),
  feishuTool(
    "feishu_calendar_update",
    "calendar",
    "write",
    "Change the title, description or visibility (public, show_only_free_busy, private) of a calendar the app owns.",
    { calendar_id: str, summary: str, description: str, permissions: { type: "string", enum: PERMISSIONS } },
    ["calendar_id"],
    async (conn, a) => {
      const change: Record<string, string> = {};
      if (a.summary !== undefined) change.summary = String(a.summary);
      if (a.description !== undefined) change.description = String(a.description);
      if (a.permissions !== undefined) change.permissions = oneOf(a.permissions, PERMISSIONS, "permissions");
      if (!Object.keys(change).length)
        throw new BadRequest("nothing to change: give summary, description or permissions");
      const { calendar } = await feishuApi(conn, "PATCH", `calendar/v4/calendars/${a.calendar_id}`, { body: change });
      return calendarOut(calendar);
    },
  ),
  feishuTool(
    "feishu_calendar_share",
    "calendar",
    "write",
    "Make a person (open_id, see feishu_apps) a member of a calendar the app owns, or change their role: owner, writer, reader or free_busy_reader.",
    { calendar_id: str, user: str, role: { type: "string", enum: ACL_ROLES } },
    ["calendar_id", "user", "role"],
    async (conn, a) => {
      const calendarId = String(a.calendar_id);
      const role = oneOf(a.role, ACL_ROLES, "role");
      const acl = await feishuApi(conn, "POST", `calendar/v4/calendars/${calendarId}/acls`, {
        params: { user_id_type: "open_id" },
        body: { role, scope: { type: "user", user_id: String(a.user) } },
      });
      return { acl_id: acl.acl_id, user: acl.scope?.user_id ?? String(a.user), role: acl.role ?? role };
    },
  ),
  feishuTool(
    "feishu_calendar_unshare",
    "calendar",
    "write",
    "Remove a person (open_id) from the members of a calendar the app owns.",
    { calendar_id: str, user: str },
    ["calendar_id", "user"],
    async (conn, a) => {
      const calendarId = String(a.calendar_id);
      const mine = (await calendarMembers(conn, calendarId)).filter((m) => m.user === String(a.user));
      if (!mine.length) return `${a.user} is not a member of this calendar`;
      for (const m of mine) await feishuApi(conn, "DELETE", `calendar/v4/calendars/${calendarId}/acls/${m.acl_id}`);
      return { removed: String(a.user) };
    },
  ),
  feishuTool(
    "feishu_calendar_subscribe",
    "calendar",
    "write",
    "Subscribe the app to a shared calendar that is public or shows busy times (see feishu_calendar_search), so its events can be read; or stop (unsubscribe: true).",
    { calendar_id: str, unsubscribe: { type: "boolean" } },
    ["calendar_id"],
    async (conn, a) => {
      if (a.unsubscribe === true) {
        await feishuApi(conn, "POST", `calendar/v4/calendars/${a.calendar_id}/unsubscribe`, { body: {} });
        return { unsubscribed: String(a.calendar_id) };
      }
      const { calendar } = await feishuApi(conn, "POST", `calendar/v4/calendars/${a.calendar_id}/subscribe`, {
        body: {},
      });
      return calendarOut(calendar);
    },
  ),
  feishuTool(
    "feishu_calendar_create_event",
    "calendar",
    "write",
    "Create an event in a Feishu calendar the app may write to (its own, or one where it is owner or writer), optionally inviting people (their open_id, see feishu_apps); the event then shows in their calendars.",
    {
      calendar_id: str,
      summary: str,
      start: timeArg("start"),
      end: timeArg("end"),
      description: str,
      location: str,
      attendees: { type: "array", items: str, description: "open_ids of the people to invite" },
    },
    ["calendar_id", "summary", "start", "end"],
    async (conn, a) => {
      const { event } = await feishuApi(conn, "POST", `calendar/v4/calendars/${a.calendar_id}/events`, {
        body: {
          summary: String(a.summary),
          description: a.description ? String(a.description) : undefined,
          start_time: { timestamp: unix(a.start, "start") },
          end_time: { timestamp: unix(a.end, "end") },
          location: a.location ? { name: String(a.location) } : undefined,
        },
      });
      const invited = openIds(a.attendees);
      if (invited.length)
        await feishuApi(conn, "POST", `calendar/v4/calendars/${a.calendar_id}/events/${event.event_id}/attendees`, {
          params: { user_id_type: "open_id" },
          body: { attendees: invited.map((id) => ({ type: "user", user_id: id })), need_notification: true },
        });
      return { event_id: event?.event_id, summary: event?.summary, invited: invited.length, link: event?.app_link };
    },
  ),
  feishuTool(
    "feishu_calendar_update_event",
    "calendar",
    "write",
    "Change an event the app organized (created): title, description, time (start and end together), place, and who is invited. Feishu lets only the organizer change an event.",
    {
      calendar_id: str,
      event_id: str,
      summary: str,
      description: str,
      start: timeArg("new start"),
      end: timeArg("new end"),
      location: str,
      invite: { type: "array", items: str, description: "open_ids of people to add" },
      uninvite: { type: "array", items: str, description: "open_ids of people to remove" },
    },
    ["calendar_id", "event_id"],
    async (conn, a) => {
      const path = `calendar/v4/calendars/${a.calendar_id}/events/${a.event_id}`;
      if ((a.start === undefined) !== (a.end === undefined)) throw new BadRequest("give start and end together");
      const change: Record<string, unknown> = {};
      if (a.summary !== undefined) change.summary = String(a.summary);
      if (a.description !== undefined) change.description = String(a.description);
      if (a.start !== undefined) {
        change.start_time = { timestamp: unix(a.start, "start") };
        change.end_time = { timestamp: unix(a.end, "end") };
      }
      if (a.location !== undefined) change.location = { name: String(a.location) };
      const invite = openIds(a.invite);
      const uninvite = openIds(a.uninvite);
      if (!Object.keys(change).length && !invite.length && !uninvite.length) throw new BadRequest("nothing to change");
      let event: any = null;
      if (Object.keys(change).length)
        ({ event } = await feishuApi(conn, "PATCH", path, { body: { ...change, need_notification: true } }));
      if (invite.length)
        await feishuApi(conn, "POST", `${path}/attendees`, {
          params: { user_id_type: "open_id" },
          body: { attendees: invite.map((id) => ({ type: "user", user_id: id })), need_notification: true },
        });
      let removed = 0;
      if (uninvite.length) {
        // attendees are removed by their attendee id, found from their open_id
        const people = await feishuApi(conn, "GET", `${path}/attendees`, {
          params: { user_id_type: "open_id", page_size: "100" },
        });
        const ids = (people.items ?? [])
          .filter((p: any) => uninvite.includes(p.user_id))
          .map((p: any) => p.attendee_id);
        if (ids.length)
          await feishuApi(conn, "POST", `${path}/attendees/batch_delete`, {
            body: { attendee_ids: ids, need_notification: true },
          });
        removed = ids.length;
      }
      return { event_id: String(a.event_id), summary: event?.summary, invited: invite.length, removed };
    },
  ),
  feishuTool(
    "feishu_calendar_delete_event",
    "calendar",
    "write",
    "Cancel (delete) an event the app organized (created); invited people are told.",
    { calendar_id: str, event_id: str },
    ["calendar_id", "event_id"],
    async (conn, a) => {
      await feishuApi(conn, "DELETE", `calendar/v4/calendars/${a.calendar_id}/events/${a.event_id}`, {
        params: { need_notification: "true" },
      });
      return { deleted: String(a.event_id) };
    },
  ),
  // --- documents, drive and wiki
  feishuTool(
    "feishu_doc_read",
    "docs",
    "read",
    "Read the text of a Feishu document (docx), given its link (a wiki link to a document works too) or id.",
    { document: str },
    ["document"],
    async (conn, a) => {
      const id = await documentId(conn, a.document);
      return (await feishuApi(conn, "GET", `docx/v1/documents/${id}/raw_content`)).content ?? "";
    },
  ),
  feishuTool(
    "feishu_drive_list",
    "docs",
    "read",
    "List the files in a Feishu Drive folder (its link or token).",
    { folder: str },
    ["folder"],
    async (conn, a) => {
      const data = await feishuApi(conn, "GET", "drive/v1/files", {
        params: { folder_token: tokenOf(a.folder, "folder"), page_size: "100" },
      });
      return (data.files ?? []).map((f: any) => ({ name: f.name, type: f.type, token: f.token, url: f.url }));
    },
  ),
  feishuTool(
    "feishu_wiki_list",
    "docs",
    "read",
    "List Feishu wiki spaces, or the pages of a space (under a page when parent is given).",
    { space_id: str, parent: { type: "string", description: "node token of the parent page" } },
    [],
    async (conn, a) => {
      if (!a.space_id) {
        const data = await feishuApi(conn, "GET", "wiki/v2/spaces", { params: { page_size: "50" } });
        return (data.items ?? []).map((s: any) => ({ space_id: s.space_id, name: s.name }));
      }
      const data = await feishuApi(conn, "GET", `wiki/v2/spaces/${a.space_id}/nodes`, {
        params: { page_size: "50", ...(a.parent ? { parent_node_token: String(a.parent) } : {}) },
      });
      return (data.items ?? []).map((n: any) => ({
        node_token: n.node_token,
        title: n.title,
        type: n.obj_type,
        token: n.obj_token,
        has_child: n.has_child,
      }));
    },
  ),
  feishuTool(
    "feishu_doc_create",
    "docs",
    "write",
    "Create a Feishu document with some text (one paragraph per line). It is kept in the app's own space and shared (can edit) with the person who asked and anyone in share_with.",
    {
      title: str,
      text: str,
      share_with: { type: "array", items: str, description: "open_ids of more people to share it with" },
    },
    ["title"],
    async (conn, a, call) => {
      const { document } = await feishuApi(conn, "POST", "docx/v1/documents", { body: { title: String(a.title) } });
      const id = document.document_id;
      if (a.text) await appendText(conn, id, String(a.text));
      const requester = await requesterOpenId(call.db, call.taskId, conn);
      const people = [
        ...new Set([
          ...(requester ? [requester] : []),
          ...(Array.isArray(a.share_with) ? a.share_with.map(String) : []),
        ]),
      ];
      const shared: string[] = [];
      for (const person of people) {
        await feishuApi(conn, "POST", `drive/v1/permissions/${id}/members`, {
          params: { type: "docx", need_notification: "true" },
          body: { member_type: "openid", member_id: person, perm: "edit" },
        });
        shared.push(person);
      }
      return {
        document_id: id,
        title: document.title,
        shared_with: shared,
        ...(shared.length
          ? {}
          : { note: "nobody could be given access: the asker has no linked account in this Feishu" }),
      };
    },
  ),
  feishuTool(
    "feishu_doc_append",
    "docs",
    "write",
    "Append text to the end of a Feishu document (one paragraph per line).",
    { document: str, text: str },
    ["document", "text"],
    async (conn, a) => {
      const id = await documentId(conn, a.document);
      await appendText(conn, id, String(a.text));
      return { document_id: id, appended_paragraphs: String(a.text).split("\n").length };
    },
  ),
  // --- bases
  feishuTool(
    "feishu_bitable_schema",
    "bitable",
    "read",
    "List the tables of a Feishu base (its link or app token), or the fields of one table.",
    { base: str, table_id: str },
    ["base"],
    async (conn, a) => {
      const base = tokenOf(a.base, "base");
      if (!a.table_id) {
        const data = await feishuApi(conn, "GET", `bitable/v1/apps/${base}/tables`, { params: { page_size: "100" } });
        return (data.items ?? []).map((t: any) => ({ table_id: t.table_id, name: t.name }));
      }
      const data = await feishuApi(conn, "GET", `bitable/v1/apps/${base}/tables/${a.table_id}/fields`, {
        params: { page_size: "100" },
      });
      return (data.items ?? []).map((f: any) => ({ field_name: f.field_name, type: f.type, ui_type: f.ui_type }));
    },
  ),
  feishuTool(
    "feishu_bitable_records",
    "bitable",
    "read",
    'Search records of a table in a Feishu base. filter is Feishu\'s condition object, e.g. {"conjunction":"and","conditions":[{"field_name":"状态","operator":"is","value":["进行中"]}]}.',
    { base: str, table_id: str, filter: { type: "object" }, page_size: { type: "integer" } },
    ["base", "table_id"],
    async (conn, a) => {
      const data = await feishuApi(
        conn,
        "POST",
        `bitable/v1/apps/${tokenOf(a.base, "base")}/tables/${a.table_id}/records/search`,
        {
          params: { page_size: String(Math.min(Math.max(Number(a.page_size ?? 50), 1), 500)) },
          body: a.filter ? { filter: a.filter } : {},
        },
      );
      return {
        total: data.total,
        records: (data.items ?? []).map((r: any) => ({ record_id: r.record_id, fields: r.fields })),
      };
    },
  ),
  feishuTool(
    "feishu_bitable_add_record",
    "bitable",
    "write",
    "Add a record to a table in a Feishu base; fields maps field names to values.",
    { base: str, table_id: str, fields: { type: "object" } },
    ["base", "table_id", "fields"],
    async (conn, a) => {
      const { record } = await feishuApi(
        conn,
        "POST",
        `bitable/v1/apps/${tokenOf(a.base, "base")}/tables/${a.table_id}/records`,
        {
          body: { fields: a.fields ?? {} },
        },
      );
      return { record_id: record?.record_id };
    },
  ),
  feishuTool(
    "feishu_bitable_update_record",
    "bitable",
    "write",
    "Change fields of a record in a table of a Feishu base.",
    { base: str, table_id: str, record_id: str, fields: { type: "object" } },
    ["base", "table_id", "record_id", "fields"],
    async (conn, a) => {
      const { record } = await feishuApi(
        conn,
        "PUT",
        `bitable/v1/apps/${tokenOf(a.base, "base")}/tables/${a.table_id}/records/${a.record_id}`,
        { body: { fields: a.fields ?? {} } },
      );
      return { record_id: record?.record_id };
    },
  ),
  // --- sheets
  feishuTool(
    "feishu_sheet_read",
    "sheets",
    "read",
    "Read a range of a Feishu spreadsheet (its link or token), e.g. range 0b8e2a!A1:D20 with the sheet id; without a range, list its sheets.",
    { spreadsheet: str, range: str },
    ["spreadsheet"],
    async (conn, a) => {
      const token = tokenOf(a.spreadsheet, "spreadsheet");
      if (!a.range) {
        const data = await feishuApi(conn, "GET", `sheets/v3/spreadsheets/${token}/sheets/query`);
        return (data.sheets ?? []).map((s: any) => ({ sheet_id: s.sheet_id, title: s.title }));
      }
      const data = await feishuApi(conn, "GET", `sheets/v2/spreadsheets/${token}/values/${encodeURI(String(a.range))}`);
      return data.valueRange?.values ?? [];
    },
  ),
  feishuTool(
    "feishu_sheet_write",
    "sheets",
    "write",
    "Write values (rows of cells) into a range of a Feishu spreadsheet, e.g. 0b8e2a!A1:C2.",
    { spreadsheet: str, range: str, values: { type: "array", items: { type: "array" } } },
    ["spreadsheet", "range", "values"],
    async (conn, a) => {
      const data = await feishuApi(
        conn,
        "PUT",
        `sheets/v2/spreadsheets/${tokenOf(a.spreadsheet, "spreadsheet")}/values`,
        {
          body: { valueRange: { range: String(a.range), values: a.values } },
        },
      );
      return { updated_range: data.updatedRange, updated_cells: data.updatedCells };
    },
  ),
  // --- meetings and tasks
  feishuTool(
    "feishu_meeting_reserve",
    "meeting",
    "write",
    "Book a Feishu video meeting hosted by the person who asked you, and get its join link (bookable until end, at most 30 days ahead).",
    { topic: str, end: timeArg("the booking stays valid until") },
    ["topic", "end"],
    async (conn, a, call) => {
      const owner = await requesterOpenId(call.db, call.taskId, conn);
      if (!owner)
        throw new BadRequest("the person who asked has no linked account in this company's Feishu to host the meeting");
      const { reserve } = await feishuApi(conn, "POST", "vc/v1/reserves/apply", {
        params: { user_id_type: "open_id" },
        body: { end_time: unix(a.end, "end"), owner_id: owner, meeting_settings: { topic: String(a.topic) } },
      });
      return { meeting_no: reserve?.meeting_no, url: reserve?.url, end_time: reserve?.end_time };
    },
  ),
  feishuTool(
    "feishu_task_create",
    "task",
    "write",
    "Create a Feishu task, optionally with a due time and assignees (their open_id, see feishu_apps).",
    {
      summary: str,
      description: str,
      due: timeArg("due"),
      assignees: { type: "array", items: str, description: "open_ids of the assignees" },
    },
    ["summary"],
    async (conn, a) => {
      const members = (Array.isArray(a.assignees) ? a.assignees : []).map((id: unknown) => ({
        id: String(id),
        type: "user",
        role: "assignee",
      }));
      const { task } = await feishuApi(conn, "POST", "task/v2/tasks", {
        params: { user_id_type: "open_id" },
        body: {
          summary: String(a.summary),
          ...(a.description ? { description: String(a.description) } : {}),
          ...(a.due ? { due: { timestamp: String(Number(unix(a.due, "due")) * 1000), is_all_day: false } } : {}),
          ...(members.length ? { members } : {}),
        },
      });
      return { guid: task?.guid, summary: task?.summary, url: task?.url };
    },
  ),
];

export const ALL_FEISHU_TOOLS = FEISHU_TOOLS;

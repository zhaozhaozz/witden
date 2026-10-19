/**
 * Feishu tools: roles use a company's calendar, documents, bases, sheets, meetings and tasks through the platform,
 * per app and product, with the app's credentials never leaving the server (Feishu's Open API is a stand-in).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { newId } from "../src/db/ids.js";
import {
  connections,
  externalConversations,
  externalIdentities,
  externalThreadLinks,
  feishuCalendarShares,
  messages,
  outboundMessages,
  roles,
} from "../src/db/schema.js";
import { CHANNEL } from "../src/integrations/base.js";
import { FeishuAdapter, setFeishuFetch } from "../src/integrations/feishu.js";
import { call, reply } from "./support/harness.js";
import { buildWorld, type World } from "./support/world.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Feishu's Open API: records every call; the scopes it reports granted can be set. */
class FakeFeishu {
  calls: { method: string; path: string; query: Record<string, string>; body: any }[] = [];
  granted = new Set(["im:message.p2p_msg:readonly", "calendar:calendar", "docx:document:readonly"]);
  /** The members of the group oc_team. */
  team = ["ou_alice_a", "ou_bob_a", "ou_carol_a", "ou_guest"];
  /** Paths answered as if the app lacked the scope. */
  missingScope = new Set<string>();

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/open-apis/", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "auth/v3/tenant_access_token/internal")
      return json({ code: 0, tenant_access_token: `t-${body.app_id}`, expire: 7200 });
    const method = init?.method ?? "GET";
    this.calls.push({ method, path, query: Object.fromEntries(url.searchParams), body });
    if (this.missingScope.has(path))
      return json({ code: 99991672, msg: "Access denied. One of the following scopes is required: [bitable:app]" });
    if (path === "application/v6/scopes")
      return json({
        code: 0,
        data: {
          scopes: [...this.granted, "drive:drive"].map((s) => ({
            scope_name: s,
            grant_status: this.granted.has(s) ? 1 : 2,
          })),
        },
      });
    if (path === "calendar/v4/calendars" && method === "POST")
      return json({ code: 0, data: { calendar: { calendar_id: "cal_org", type: "shared", role: "owner", ...body } } });
    if (path === "calendar/v4/calendars")
      return json({
        code: 0,
        data: { calendar_list: [{ calendar_id: "cal_team", summary: "团队日历", type: "shared" }] },
      });
    // the organization's calendar the app made, a public one it finds, and an event it organized
    if (path === "calendar/v4/calendars/cal_org" && method === "GET")
      return json({ code: 0, data: { calendar_id: "cal_org", summary: "公司日历", permissions: "public" } });
    if (path === "calendar/v4/calendars/cal_org/events" && method === "GET")
      return json({
        code: 0,
        data: {
          items: [
            {
              event_id: "ev_launch",
              summary: "发布会",
              app_link:
                "https://applink.feishu.cn/client/calendar/event/detail?calendarId=7698317119771184158&key=k1&originalTime=0&startTime=1792400000",
            },
          ],
        },
      });
    if (path === "calendar/v4/calendars/cal_team" && method === "GET")
      return json({ code: 0, data: { calendar_id: "cal_team", summary: "团队日历", permissions: "private" } });
    if (path === "calendar/v4/calendars/cal_org" && method === "PATCH")
      return json({ code: 0, data: { calendar: { calendar_id: "cal_org", summary: "公司日历", ...body } } });
    if (path === "calendar/v4/calendars/cal_org/acls" && method === "POST" && body.scope.user_id === "ou_guest")
      return json({ code: 190003, msg: "user is not in the tenant" });
    if (path === "calendar/v4/calendars/cal_org/acls" && method === "POST")
      return json({ code: 0, data: { acl_id: "acl_new", role: body.role, scope: body.scope } });
    if (path === "calendar/v4/calendars/cal_org/acls")
      return json({
        code: 0,
        data: {
          acls: [
            { acl_id: "acl_1", role: "writer", scope: { type: "user", user_id: "ou_alice_a" } },
            { acl_id: "acl_2", role: "owner", scope: { type: "user", user_id: "ou_admin_a" } },
            { acl_id: "acl_b", role: "reader", scope: { type: "user", user_id: "ou_bob_a" } },
          ],
          has_more: false,
        },
      });
    if (path === "calendar/v4/calendars/cal_org/acls/acl_1" || path === "calendar/v4/calendars/cal_org/acls/acl_b")
      return json({ code: 0, data: {} });
    if (path === "calendar/v4/calendars/search")
      return json({
        code: 0,
        data: { items: [{ calendar_id: "cal_hol", summary: "公司假期", permissions: "public", type: "shared" }] },
      });
    if (path === "calendar/v4/calendars/cal_hol/subscribe")
      return json({ code: 0, data: { calendar: { calendar_id: "cal_hol", summary: "公司假期", role: "reader" } } });
    if (path === "calendar/v4/calendars/cal_team/events/ev1" && method === "GET")
      return json({
        code: 0,
        data: { event: { event_id: "ev1", summary: "周会", event_organizer: { display_name: "witden" } } },
      });
    if (path === "calendar/v4/calendars/cal_team/events/ev1" && method === "PATCH")
      return json({ code: 0, data: { event: { event_id: "ev1", summary: body.summary } } });
    if (path === "calendar/v4/calendars/cal_team/events/ev1/attendees" && method === "GET")
      return json({
        code: 0,
        data: {
          items: [
            {
              attendee_id: "user_1",
              type: "user",
              user_id: "ou_alice_a",
              display_name: "alice",
              rsvp_status: "accept",
            },
            { attendee_id: "user_2", type: "user", user_id: "ou_bob_a", display_name: "bob", rsvp_status: "tentative" },
            { attendee_id: "chat_1", type: "chat", chat_id: "oc_team", display_name: "团队群" },
          ],
        },
      });
    if (path.startsWith("calendar/v4/calendars/cal_team/events/ev1")) return json({ code: 0, data: {} });
    if (path === "calendar/v4/calendars/cal_team/events" && method === "GET")
      return json({
        code: 0,
        data: { items: [{ event_id: "ev1", summary: "周会", start_time: { timestamp: "1792400000" } }] },
      });
    if (path === "calendar/v4/calendars/cal_team/events" && method === "POST")
      return json({ code: 0, data: { event: { event_id: "ev_new", summary: body.summary } } });
    if (path === "calendar/v4/calendars/cal_team/events/ev_new/attendees") return json({ code: 0, data: {} });
    if (path === "wiki/v2/spaces/get_node")
      return json({ code: 0, data: { node: { obj_type: "docx", obj_token: "doxWiki1" } } });
    if (path === "docx/v1/documents/doxWiki1/raw_content")
      return json({ code: 0, data: { content: "季度计划：上线 2.0" } });
    if (path === "docx/v1/documents" && method === "POST")
      return json({ code: 0, data: { document: { document_id: "doxNew", title: body.title } } });
    if (path === "docx/v1/documents/doxNew/blocks/doxNew/children") return json({ code: 0, data: {} });
    if (path === "drive/v1/permissions/doxNew/members") return json({ code: 0, data: {} });
    if (path === "bitable/v1/apps/bascBase1/tables/tbl1/records/search")
      return json({ code: 0, data: { total: 1, items: [{ record_id: "rec1", fields: { 状态: "进行中" } }] } });
    if (path === "bitable/v1/apps/bascBase1/tables/tbl1/records")
      return json({ code: 0, data: { record: { record_id: "rec_new" } } });
    if (path === "sheets/v2/spreadsheets/shtSheet1/values/s1!A1:B2")
      return json({ code: 0, data: { valueRange: { values: [["a", "b"]] } } });
    if (path === "vc/v1/reserves/apply")
      return json({ code: 0, data: { reserve: { meeting_no: "123456789", url: "https://vc.feishu.cn/j/123456789" } } });
    if (path === "task/v2/tasks") return json({ code: 0, data: { task: { guid: "task1", summary: body.summary } } });
    // the team group (alice, bob and someone from another company), its calendar and an event for it
    if (path === "im/v1/chats/oc_team/members")
      return json({
        code: 0,
        data: { items: this.team.map((id) => ({ member_id: id, name: id })), has_more: false },
      });
    if (path === "im/v1/messages" && method === "POST")
      return json({ code: 0, data: { message_id: `om_${body.msg_type}_${this.calls.length}` } });
    return json({ code: 404, msg: `unknown ${method} ${path}` });
  };

  last = (path: string) => [...this.calls].reverse().find((c) => c.path === path);
}

let w: World;
let feishu: FakeFeishu;
let appA: string;
let appB: string;

const connect = async (name: string, appId: string) => {
  const res = await w.api("POST", "/api/connections", {
    token: w.adminToken,
    json: { platform: "feishu", name, credentials: { app_id: appId, app_secret: "s", verification_token: "vt" } },
  });
  expect(res.status, res.raw).toBe(200);
  return res.body.id as string;
};
const grant = async (allowed: string[], approval: string[] = []) => {
  const [role] = await db().select().from(roles).where(eq(roles.id, w.ids.dev));
  return w.api("PATCH", `/api/roles/${w.ids.dev}`, {
    token: w.adminToken,
    json: {
      allowed_tools: [...role.allowedTools, ...allowed],
      approval_required: [...role.approvalRequired, ...approval],
    },
  });
};
/** What each tool call of the role's first turn returned, by tool name. */
const resultsOf = (messages: any[]) =>
  Object.fromEntries(
    messages.filter((m) => m.role === "tool").map((m) => [m.name ?? m.tool_call_id, String(m.content)]),
  );

beforeEach(async () => {
  w = await buildWorld();
  feishu = new FakeFeishu();
  setFeishuFetch(feishu.fetch);
  appA = await connect("甲公司", "cli_a");
  appB = await connect("乙公司", "cli_b");
  // alice has an account in 甲公司's Feishu: meetings and shared documents can name her there
  await db()
    .insert(externalIdentities)
    .values({ id: newId("ext"), connectionId: appA, externalUserId: "ou_alice_a", userId: w.ids.alice });
});

afterEach(async () => {
  setFeishuFetch((...args) => fetch(...args));
  await w.close();
});

describe("feishu tools", () => {
  it("are given per app and product, each call with its own company's token", async () => {
    expect((await grant([`feishu:${appA}:calendar:read`, `feishu:${appB}:docs:read`])).status).toBe(200);
    let results: Record<string, string> = {};
    let offered: string[] = [];
    w.scripts.dev = (m, turn) => {
      if (turn === 0)
        return reply("", [
          call("feishu_apps", {}),
          call("feishu_calendar_events", {
            start: "2026-10-20T00:00:00+08:00",
            end: "2026-10-21T00:00:00+08:00",
            calendar_id: "cal_team",
          }),
          call("feishu_doc_read", { document: "https://x.feishu.cn/wiki/wikNode1" }),
          call("feishu_doc_read", { document: "doxWiki1", app: appA }),
        ]);
      results = resultsOf(m);
      return reply("done");
    };
    const posted = await w.post(w.alice, w.ids.topic, "@dev 看看日程和计划");
    await w.drain();
    // only the products given are offered; the app is the only one open for each
    const steps = JSON.stringify((await w.task(posted.tasks[0].id)).steps ?? []);
    offered = ["feishu_calendar_create_event", "feishu_doc_create"].filter((t) => steps.includes(`"${t}"`));
    expect(offered).toEqual([]);
    const all = Object.values(results).join("\n");
    expect(all).toContain(`甲公司 (app: ${appA}): calendar read`);
    expect(all).toContain(`乙公司 (app: ${appB}): docs read`);
    expect(all).toContain("周会");
    expect(all).toContain("季度计划：上线 2.0");
    expect(all).toContain(`you may not use docs (read) of the Feishu connection ${appA}`);
    // each call went with its own company's token
    expect(feishu.last("calendar/v4/calendars/cal_team/events")?.query.start_time).toBe("1792425600");
  });

  it("a write that asks waits for approval; then it runs with the attendees invited", async () => {
    await grant([`feishu:${appA}:calendar:read`, `feishu:${appA}:calendar:write`], [`feishu:${appA}:calendar:write`]);
    w.scripts.dev = (_m, turn) =>
      turn === 0
        ? reply("", [
            call("feishu_calendar_create_event", {
              calendar_id: "cal_team",
              summary: "评审会",
              start: "2026-10-20T10:00:00+08:00",
              end: "2026-10-20T11:00:00+08:00",
              attendees: ["ou_alice_a"],
            }),
          ])
        : reply("已创建");
    const posted = await w.post(w.alice, w.ids.topic, "@dev 约个评审会");
    await w.drain();
    const id = posted.tasks[0].id;
    expect((await w.task(id)).status).toBe("waiting_approval");
    expect(feishu.last("calendar/v4/calendars/cal_team/events")).toBeUndefined();
    const approval = (await w.api("GET", "/api/approvals", { token: w.bob })).body.find((a: any) => a.task_id === id);
    await w.api("POST", `/api/approvals/${approval.id}/decide`, { token: w.bob, json: { approve: true } });
    await w.drain();
    expect((await w.task(id)).status).toBe("completed");
    expect(feishu.last("calendar/v4/calendars/cal_team/events")?.body).toMatchObject({
      summary: "评审会",
      start_time: { timestamp: "1792461600" },
    });
    expect(feishu.last("calendar/v4/calendars/cal_team/events/ev_new/attendees")?.body.attendees).toEqual([
      { type: "user", user_id: "ou_alice_a" },
    ]);
  });

  it("an organization calendar: the app creates and shares it, finds and subscribes to others, changes its events", async () => {
    await grant([`feishu:${appA}:calendar:read`, `feishu:${appA}:calendar:write`]);
    let results: Record<string, string> = {};
    w.scripts.dev = (m, turn) => {
      if (turn === 0)
        return reply("", [
          call("feishu_calendar_create", { summary: "公司日历", permissions: "public" }),
          call("feishu_calendar_share", { calendar_id: "cal_org", user: "ou_admin_a", role: "owner" }),
          call("feishu_calendar_share", { calendar_id: "cal_org", user: "ou_x", role: "boss" }),
          call("feishu_calendar_update", { calendar_id: "cal_org", description: "全员可订阅" }),
          call("feishu_calendar_members", { calendar_id: "cal_org" }),
          call("feishu_calendar_unshare", { calendar_id: "cal_org", user: "ou_alice_a" }),
          call("feishu_calendar_search", { query: "假期" }),
          call("feishu_calendar_subscribe", { calendar_id: "cal_hol" }),
        ]);
      if (turn === 1) {
        results = resultsOf(m);
        return reply("", [
          call("feishu_calendar_event", { calendar_id: "cal_team", event_id: "ev1" }),
          call("feishu_calendar_share_link", { calendar_id: "cal_org" }),
          call("feishu_calendar_share_link", { calendar_id: "cal_team" }),
          call("feishu_calendar_update_event", {
            calendar_id: "cal_team",
            event_id: "ev1",
            start: "2026-10-20T10:00:00+08:00",
          }),
          call("feishu_calendar_update_event", {
            calendar_id: "cal_team",
            event_id: "ev1",
            summary: "周会（改到周三）",
            start: "2026-10-21T10:00:00+08:00",
            end: "2026-10-21T11:00:00+08:00",
            invite: ["ou_carol_a"],
            uninvite: ["ou_bob_a"],
          }),
          call("feishu_calendar_delete_event", { calendar_id: "cal_team", event_id: "ev1" }),
        ]);
      }
      results = { ...results, ...resultsOf(m) };
      return reply("done");
    };
    await w.post(w.alice, w.ids.topic, "@dev 建一个公司公共日历");
    await w.drain();
    const all = Object.values(results).join("\n");
    // the new calendar is the app's, public; an administrator becomes its owner too
    expect(feishu.last("calendar/v4/calendars")?.body).toEqual({ summary: "公司日历", permissions: "public" });
    expect(feishu.last("calendar/v4/calendars/cal_org/acls")?.query.user_id_type).toBe("open_id");
    expect(
      feishu.calls.find((c) => c.method === "POST" && c.path === "calendar/v4/calendars/cal_org/acls")?.body,
    ).toEqual({
      role: "owner",
      scope: { type: "user", user_id: "ou_admin_a" },
    });
    expect(all).toContain("role must be one of owner, writer, reader, free_busy_reader");
    expect(feishu.calls.find((c) => c.method === "PATCH" && c.path === "calendar/v4/calendars/cal_org")?.body).toEqual({
      description: "全员可订阅",
    });
    expect(all).toContain('"acl_id": "acl_2"');
    // removing a member deletes their entry only
    expect(feishu.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toContain(
      "calendar/v4/calendars/cal_org/acls/acl_1",
    );
    expect(feishu.last("calendar/v4/calendars/search")?.body).toEqual({ query: "假期" });
    expect(all).toContain('"role": "reader"');
    // sharing a calendar: the link Feishu's own share card opens, its number taken from an event's link
    expect(all).toContain(
      '"link": "https://applink.feishu.cn/client/calendar/detail?calendarId=7698317119771184158&source=calendar_share_by_owner"',
    );
    expect(all).toContain('"who_can_open": "anyone in the company (they can subscribe)"');
    expect(all).toContain("no link yet: Feishu gives a calendar's link only through its events, and 团队日历 has none");
    // the event: its attendees read; a time needs start and end; changes, invites and removals; then cancelled
    expect(all).toContain('"reply": "tentative"');
    expect(all).toContain("give start and end together");
    expect(feishu.last("calendar/v4/calendars/cal_team/events/ev1")).toMatchObject({
      method: "DELETE",
      query: { need_notification: "true" },
    });
    const patch = feishu.calls.find(
      (c) => c.method === "PATCH" && c.path === "calendar/v4/calendars/cal_team/events/ev1",
    );
    expect(patch?.body).toEqual({
      summary: "周会（改到周三）",
      start_time: { timestamp: "1792548000" },
      end_time: { timestamp: "1792551600" },
      need_notification: true,
    });
    expect(feishu.last("calendar/v4/calendars/cal_team/events/ev1/attendees/batch_delete")?.body).toEqual({
      attendee_ids: ["user_2"],
      need_notification: true,
    });
    expect(
      feishu.calls.find((c) => c.method === "POST" && c.path === "calendar/v4/calendars/cal_team/events/ev1/attendees")
        ?.body.attendees,
    ).toEqual([{ type: "user", user_id: "ou_carol_a" }]);
  });

  it("a calendar for a whole group: its members now and later, the group invited to events, the share card posted", async () => {
    await grant([`feishu:${appA}:calendar:read`, `feishu:${appA}:calendar:write`]);
    // the topic is the team group's conversation in 甲公司's Feishu, whose bot stands for @dev
    await w.api("PATCH", `/api/connections/${appA}`, {
      token: w.adminToken,
      json: { settings: { role_id: w.ids.dev } },
    });
    const [conv] = await db()
      .insert(externalConversations)
      .values({
        id: newId("ecv"),
        connectionId: appA,
        externalId: "oc_team",
        kind: "private",
        name: "团队群",
        memberIds: ["ou_alice_a", "ou_bob_a", "ou_guest"],
        membersSyncedAt: new Date(Date.now() - 3600_000),
      })
      .returning();
    await db()
      .insert(externalThreadLinks)
      .values({
        id: newId("lnk"),
        connectionId: appA,
        conversationId: conv.id,
        threadKey: CHANNEL,
        topicId: w.ids.topic,
      });
    let results: Record<string, string> = {};
    w.scripts.dev = (m, turn) => {
      if (turn === 0)
        return reply("", [
          call("feishu_apps", {}),
          call("feishu_calendar_share", { calendar_id: "cal_org", chat: "this", role: "reader" }),
          call("feishu_calendar_create_event", {
            calendar_id: "cal_team",
            summary: "全员会",
            start: "2026-10-22T10:00:00+08:00",
            end: "2026-10-22T11:00:00+08:00",
            attendees: ["ou_carol_a"],
            groups: ["this"],
          }),
          call("feishu_calendar_update_event", {
            calendar_id: "cal_team",
            event_id: "ev1",
            uninvite_groups: ["oc_team"],
          }),
          call("feishu_calendar_share_card", { calendar_id: "cal_org" }),
        ]);
      if (turn === 1) {
        results = resultsOf(m);
        return reply("", [
          call("feishu_calendar_members", { calendar_id: "cal_org" }),
          call("feishu_calendar_unshare", { calendar_id: "cal_org", chat: "oc_team" }),
        ]);
      }
      results = { ...results, ...resultsOf(m) };
      return reply("done");
    };
    await w.post(w.alice, w.ids.topic, "@dev 把公司日历分享给这个群");
    await w.drain();
    const all = Object.values(results).join("\n");
    expect(all).toContain("团队群 oc_team (this conversation)");
    // members are added, except those who already have the role or more (alice writes, bob reads); the one
    // from another company could not be, and says why
    const added = feishu.calls.filter((c) => c.method === "POST" && c.path === "calendar/v4/calendars/cal_org/acls");
    expect(added.map((c) => [c.body.scope.user_id, c.body.role])).toEqual([
      ["ou_carol_a", "reader"],
      ["ou_guest", "reader"],
    ]);
    expect(all).toContain('"added": 1');
    expect(all).toContain('"already_had_it_or_more": 2');
    expect(all).toContain("user is not in the tenant");
    // the group is invited to the event as a group; removing it from another finds its attendee entry
    expect(feishu.last("calendar/v4/calendars/cal_team/events/ev_new/attendees")?.body.attendees).toEqual([
      { type: "user", user_id: "ou_carol_a" },
      { type: "chat", chat_id: "oc_team" },
    ]);
    expect(feishu.last("calendar/v4/calendars/cal_team/events/ev1/attendees/batch_delete")?.body.attendee_ids).toEqual([
      "chat_1",
    ]);
    // the share card goes into the group, as the client's does; the topic records it as already there
    const card = feishu.calls.find((c) => c.path === "im/v1/messages" && c.body.msg_type === "interactive");
    expect(card?.body.receive_id).toBe("oc_team");
    const content = JSON.parse(card?.body.content);
    expect(content.header.title.content).toBe("日历分享");
    expect(JSON.stringify(content.elements)).toContain("可查看所有日程详情");
    expect(content.elements[2].actions[0]).toMatchObject({
      text: { content: "在日历中查看" },
      url: "https://applink.feishu.cn/client/calendar/detail?calendarId=7698317119771184158&source=calendar_share_by_owner",
    });
    const [shared] = await db().select().from(messages).where(eq(messages.source, "feishu"));
    expect(shared.content).toContain("**日历分享**");
    expect(shared.externalRef).toMatchObject({ conversation: "oc_team" });
    expect(await db().select().from(outboundMessages).where(eq(outboundMessages.messageId, shared.id))).toEqual([]);
    // the calendar lists the group; stopping takes the group's role from its members, not other roles
    expect(all).toContain('"chat": "oc_team"');
    expect(feishu.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      "calendar/v4/calendars/cal_org/acls/acl_b",
    ]);
    expect(await db().select().from(feishuCalendarShares)).toEqual([]);
  });

  it("people who join a group a calendar is shared with get it too", async () => {
    await db()
      .insert(feishuCalendarShares)
      .values({ id: newId("fcs"), connectionId: appA, calendarId: "cal_org", chatId: "oc_team", role: "reader" });
    const [conv] = await db()
      .insert(externalConversations)
      .values({
        id: newId("ecv"),
        connectionId: appA,
        externalId: "oc_team",
        kind: "private",
        memberIds: ["ou_alice_a", "ou_bob_a"],
        membersSyncedAt: new Date(Date.now() - 3600_000),
      })
      .returning();
    feishu.team = ["ou_alice_a", "ou_bob_a", "ou_dave_a"];
    const [conn] = await db().select().from(connections).where(eq(connections.id, appA));
    await new FeishuAdapter().syncMembers(db(), conn, conv);
    await w.waitFor(async () => feishu.calls.some((c) => c.method === "POST" && c.path.endsWith("/acls")));
    expect(
      feishu.calls.filter((c) => c.method === "POST" && c.path.endsWith("/acls")).map((c) => [c.path, c.body]),
    ).toEqual([
      ["calendar/v4/calendars/cal_org/acls", { role: "reader", scope: { type: "user", user_id: "ou_dave_a" } }],
    ]);
  });

  it("documents, bases, sheets, meetings and tasks; refusals are explained", async () => {
    await grant(
      ["docs", "bitable", "sheets"]
        .flatMap((p) => [`feishu:${appA}:${p}:read`, `feishu:${appA}:${p}:write`])
        .concat([`feishu:${appA}:meeting:write`, `feishu:${appA}:task:write`]),
    );
    feishu.missingScope.add("bitable/v1/apps/bascBase1/tables/tbl1/records");
    let results: Record<string, string> = {};
    w.scripts.dev = (m, turn) => {
      if (turn === 0)
        return reply("", [
          call("feishu_doc_create", { title: "周报", text: "第一行\n第二行" }),
          call("feishu_bitable_records", { base: "https://x.feishu.cn/base/bascBase1", table_id: "tbl1" }),
          call("feishu_bitable_add_record", { base: "bascBase1", table_id: "tbl1", fields: { 名称: "新任务" } }),
          call("feishu_sheet_read", { spreadsheet: "shtSheet1", range: "s1!A1:B2" }),
          call("feishu_meeting_reserve", { topic: "站会", end: "2026-10-21T10:00:00+08:00" }),
          call("feishu_task_create", {
            summary: "整理周报",
            assignees: ["ou_alice_a"],
            due: "2026-10-22T18:00:00+08:00",
          }),
        ]);
      results = resultsOf(m);
      return reply("done");
    };
    await w.post(w.alice, w.ids.topic, "@dev 帮我处理这些");
    await w.drain();
    const all = Object.values(results).join("\n");
    // a new document is shared with the person who asked (it lives in the app's own space)
    expect(feishu.last("docx/v1/documents/doxNew/blocks/doxNew/children")?.body.children).toHaveLength(2);
    expect(feishu.last("drive/v1/permissions/doxNew/members")?.body).toEqual({
      member_type: "openid",
      member_id: "ou_alice_a",
      perm: "edit",
    });
    expect(all).toContain("进行中");
    expect(all).toContain("这个飞书应用没有开通所需的权限");
    expect(all).toContain('"a"');
    // the meeting is hosted by the asker's account in this company
    expect(feishu.last("vc/v1/reserves/apply")?.body.owner_id).toBe("ou_alice_a");
    expect(all).toContain("https://vc.feishu.cn/j/123456789");
    expect(feishu.last("task/v2/tasks")?.body).toMatchObject({
      summary: "整理周报",
      members: [{ id: "ou_alice_a", type: "user", role: "assignee" }],
      due: { timestamp: "1792663200000" },
    });
  });

  it("checks the grants a role is given; a removed app's grants go with it", async () => {
    expect((await grant([`feishu:${appA}:meeting:read`])).raw).toMatch(/no read tools/);
    expect((await grant([`feishu:${appA}:mail:read`])).status).toBe(400);
    expect((await grant([`feishu:${w.ids.topic}:calendar:read`])).raw).toMatch(/not a Feishu connection/);
    expect((await grant([`feishu:${appB}:calendar:read`], [`feishu:${appB}:calendar:write`])).status).toBe(200);
    await w.api("DELETE", `/api/connections/${appB}`, { token: w.adminToken });
    const [role] = await db().select().from(roles).where(eq(roles.id, w.ids.dev));
    expect([...role.allowedTools, ...role.approvalRequired].filter((g) => g.startsWith("feishu:"))).toEqual([]);
  });

  it("lists what Feishu has granted the app, per product", async () => {
    const res = (await w.api("GET", `/api/connections/${appA}/feishu-scopes`, { token: w.adminToken })).body;
    expect(res.ok).toBe(true);
    expect(res.base.find((s: any) => s.scope === "im:message.p2p_msg:readonly").granted).toBe(true);
    expect(res.base.find((s: any) => s.scope === "im:message:send_as_bot").granted).toBe(false);
    const product = (key: string) => res.products.find((p: any) => p.key === key);
    expect(product("calendar")).toMatchObject({ read: true, write: true });
    expect(product("docs")).toMatchObject({ read: false, write: false });
    expect(product("bitable")).toMatchObject({ read: false, write: false, missing: ["bitable:app"] });
    const tools = (await w.api("GET", "/api/roles/feishu-tools", { token: w.adminToken })).body;
    expect(tools.apps.map((a: any) => a.name)).toEqual(["乙公司", "甲公司"]);
    expect(tools.products.find((p: any) => p.key === "meeting")).toMatchObject({
      read: [],
      write: ["feishu_meeting_reserve"],
    });
  });
});

/**
 * Feishu calendars shared beyond the app (the tools: agent/tools-feishu.ts):
 * - the link Feishu's own calendar share card opens: Feishu names a calendar there by an internal number the API
 *   gives only inside its events' links;
 * - a calendar given to a group chat: Feishu's access list names users only, so the group's members are added
 *   one by one, and the share is kept (``feishu_calendar_shares``) so people who join later are added when witden
 *   next syncs the group's members (``followJoiners``, from the adapter's member sync);
 * - the share card itself, posted as a message card, with a Markdown version for witden and other platforms.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { type Connection, feishuCalendarShares } from "../db/schema.js";
import { feishuApi } from "./feishu-tools.js";

export const CALENDAR_ROLES = ["owner", "writer", "reader", "free_busy_reader"];

/** What people may see, as the share card says it: by the calendar's visibility, or by the role a group got. */
export const CALENDAR_ACCESS: Record<string, string> = {
  public: "可查看所有日程详情",
  show_only_free_busy: "仅可查看忙闲",
  private: "仅日历成员可查看",
  owner: "可管理日历及共享设置",
  writer: "可创建和修改日程",
  reader: "可查看所有日程详情",
  free_busy_reader: "仅可查看忙闲",
};

/** A calendar's name, visibility and share link (null while it has no event to take the number from). */
export async function calendarLink(conn: Connection, calendarId: string) {
  const cal = await feishuApi(conn, "GET", `calendar/v4/calendars/${calendarId}`);
  const events = await feishuApi(conn, "GET", `calendar/v4/calendars/${calendarId}/events`, {
    params: { page_size: "50" },
  });
  const number = (events.items ?? [])
    .map((e: any) => /[?&]calendarId=(\d+)/.exec(String(e.app_link ?? ""))?.[1])
    .find(Boolean);
  return {
    summary: String(cal.summary ?? calendarId),
    permissions: String(cal.permissions ?? ""),
    link: number
      ? `https://applink.feishu.cn/client/calendar/detail?calendarId=${number}&source=calendar_share_by_owner`
      : null,
  };
}

/** A calendar's members (its access list); only its owner may see them. */
export async function calendarMembers(conn: Connection, calendarId: string) {
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

/** The open_ids of a group chat's members (the bot is not among them). */
export async function chatMembers(conn: Connection, chatId: string): Promise<string[]> {
  const ids: string[] = [];
  let page: string | undefined;
  do {
    const data = await feishuApi(conn, "GET", `im/v1/chats/${chatId}/members`, {
      params: { member_id_type: "open_id", page_size: "100", ...(page ? { page_token: page } : {}) },
    });
    for (const m of data.items ?? []) if (m.member_id) ids.push(m.member_id);
    page = data.has_more ? data.page_token : undefined;
  } while (page);
  return ids;
}

/** Make people members of a calendar with a role; who could not be added, and why (e.g. outside the company). */
export async function addMembers(conn: Connection, calendarId: string, users: string[], role: string) {
  const failed: { user: string; error: string }[] = [];
  for (const user of users) {
    try {
      await feishuApi(conn, "POST", `calendar/v4/calendars/${calendarId}/acls`, {
        params: { user_id_type: "open_id" },
        body: { role, scope: { type: "user", user_id: user } },
      });
    } catch (err) {
      failed.push({ user, error: (err as Error).message });
    }
  }
  return { added: users.length - failed.length, failed };
}

const RANK: Record<string, number> = { free_busy_reader: 1, reader: 2, writer: 3, owner: 4 };

/**
 * Give people a role in a calendar, leaving alone those who already have it or more: a group shared to read
 * must not make its owner, who may be in the group, a reader.
 */
export async function grantMembers(conn: Connection, calendarId: string, users: string[], role: string) {
  const current = new Map((await calendarMembers(conn, calendarId)).map((m) => [m.user, m.role]));
  const due = users.filter((u) => (RANK[current.get(u) ?? ""] ?? 0) < (RANK[role] ?? 0));
  return { kept: users.length - due.length, ...(await addMembers(conn, calendarId, due, role)) };
}

/** Share a calendar with a group: its members now, and (kept) those who join later. */
export async function shareWithChat(db: Db, conn: Connection, calendarId: string, chatId: string, role: string) {
  const members = await chatMembers(conn, chatId);
  const result = await grantMembers(conn, calendarId, members, role);
  await db
    .insert(feishuCalendarShares)
    .values({ id: newId("fcs"), connectionId: conn.id, calendarId, chatId, role })
    .onConflictDoUpdate({
      target: [feishuCalendarShares.connectionId, feishuCalendarShares.calendarId, feishuCalendarShares.chatId],
      set: { role },
    });
  return { members: members.length, ...result };
}

/**
 * Stop sharing a calendar with a group: no more joiners are added, and the group's current members lose the
 * role the group gave them (members with another role, e.g. made owner on their own, keep it).
 */
export async function unshareChat(db: Db, conn: Connection, calendarId: string, chatId: string) {
  const where = and(
    eq(feishuCalendarShares.connectionId, conn.id),
    eq(feishuCalendarShares.calendarId, calendarId),
    eq(feishuCalendarShares.chatId, chatId),
  );
  const [share] = await db.select().from(feishuCalendarShares).where(where).limit(1);
  if (!share) return null;
  const members = new Set(await chatMembers(conn, chatId));
  let removed = 0;
  for (const m of await calendarMembers(conn, calendarId))
    if (members.has(m.user) && m.role === share.role) {
      await feishuApi(conn, "DELETE", `calendar/v4/calendars/${calendarId}/acls/${m.acl_id}`);
      removed++;
    }
  await db.delete(feishuCalendarShares).where(where);
  return { removed };
}

/** The groups a calendar is shared with. */
export const chatShares = (db: Db, connectionId: string, calendarId: string) =>
  db
    .select({ chat: feishuCalendarShares.chatId, role: feishuCalendarShares.role })
    .from(feishuCalendarShares)
    .where(and(eq(feishuCalendarShares.connectionId, connectionId), eq(feishuCalendarShares.calendarId, calendarId)));

/** People who joined a group get the calendars shared with it (after a member sync noticed them). */
export async function followJoiners(db: Db, conn: Connection, chatId: string, joined: string[]): Promise<void> {
  const shares = await db
    .select()
    .from(feishuCalendarShares)
    .where(and(eq(feishuCalendarShares.connectionId, conn.id), eq(feishuCalendarShares.chatId, chatId)));
  for (const share of shares) {
    const { failed } = await grantMembers(conn, share.calendarId, joined, share.role);
    for (const f of failed) console.warn(`[witden] calendar ${share.calendarId}: could not add ${f.user}: ${f.error}`);
  }
}

/** Feishu's calendar share card (as the client sends it), and the same in Markdown. */
export function shareCard(name: string, link: string, access: string, from: string | null) {
  const label = name.replace(/[[\]]/g, "");
  const card = {
    config: { wide_screen_mode: true },
    header: { template: "orange", title: { tag: "plain_text", content: "日历分享" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**日历名称**\n[${label}](${link})` } },
      { tag: "div", text: { tag: "lark_md", content: `**权限详情**\n${access}` } },
      {
        tag: "action",
        actions: [{ tag: "button", text: { tag: "plain_text", content: "在日历中查看" }, type: "default", url: link }],
      },
      ...(from ? [{ tag: "note", elements: [{ tag: "plain_text", content: `由 ${from} 分享` }] }] : []),
    ],
  };
  const markdown = [
    "**日历分享**",
    `日历名称：[${label}](${link})`,
    `权限详情：${access}`,
    `[在日历中查看](${link})`,
    ...(from ? [`由 ${from} 分享`] : []),
  ].join("\n\n");
  return { card, markdown };
}

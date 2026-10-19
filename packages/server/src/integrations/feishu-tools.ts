/**
 * Feishu tools: a company's Feishu calendar, documents, bases, sheets, meetings and tasks, used by roles through
 * the platform. The role never holds the app's credentials: each call is made here with the connection's tenant
 * token, after the server checked that the role may use that product of that app — and a person approved the call
 * where the role's settings ask for it (runner.ts). What comes back is labelled as visible inside that company's
 * Feishu (labels.ts ``feishu:<connection>``), so it reaches other companies, Slack or GitHub only once released.
 *
 * A role's permission is per app (connection) and product, kept in its tool lists as
 * ``feishu:<connection>:<product>:read`` / ``…:write``; a write group in ``approval_required`` asks first. Feishu
 * itself only lets the app reach what it was granted: the scopes it applied for, and the documents, bases and
 * calendars shared with it.
 */
import type { Connection } from "../db/schema.js";
import { feishuLabel } from "../security/labels.js";
import { FeishuAdapter } from "./feishu.js";

export type FeishuMode = "read" | "write";

export interface FeishuScope {
  scope: string;
  /** As the Feishu console names it. */
  name: string;
}

/** What every Feishu connection applies for: receiving and sending messages, names (the setup guide). */
export const FEISHU_BASE_SCOPES: (FeishuScope & { purpose: string })[] = [
  { scope: "im:message.group_at_msg:readonly", name: "接收群聊中@机器人消息事件", purpose: "收到群里 @ 机器人的消息" },
  { scope: "im:message.p2p_msg:readonly", name: "读取用户发给机器人的单聊消息", purpose: "收到发给机器人的私聊消息" },
  { scope: "im:message:send_as_bot", name: "以应用的身份发消息", purpose: "发送角色的回复" },
  {
    scope: "im:chat:readonly",
    name: "获取群组信息",
    purpose: "读取群名和群成员（包括名字），判断回复会被谁看到",
  },
  {
    scope: "contact:contact.base:readonly",
    name: "获取通讯录基本信息",
    purpose: "私聊中显示对方的名字（与下一项一起）",
  },
  { scope: "contact:user.base:readonly", name: "获取用户基本信息", purpose: "私聊中显示对方的名字（与上一项一起）" },
  {
    scope: "im:message.group_msg.include_bot:read",
    name: "获取群组中用户和机器人发送的消息",
    purpose: "群里没有 @ 机器人的消息，包括其他机器人发的，也记入话题，作为角色的上下文",
  },
];

export interface FeishuProduct {
  key: string;
  label: string;
  /** What a role can do with it, for the role editor and the setup guide. */
  description: string;
  /** Scopes that let the app read it, and read and change it (any one is enough; the guide applies for ``write``). */
  read: FeishuScope[];
  write: FeishuScope[];
}

/** The products roles can be given (the Feishu tools), in the order the console shows them. */
export const FEISHU_PRODUCTS: FeishuProduct[] = [
  {
    key: "calendar",
    label: "日历",
    description: "查看日历、日程和忙闲；创建日程并邀请参与人",
    read: [{ scope: "calendar:calendar:readonly", name: "获取日历、日程及忙闲信息" }],
    write: [{ scope: "calendar:calendar", name: "更新日历及日程信息" }],
  },
  {
    key: "docs",
    label: "文档与知识库",
    description: "读取文档、云空间文件夹和知识库；新建文档（分享给提问的人）、追加内容",
    read: [
      { scope: "docx:document:readonly", name: "查看新版文档" },
      { scope: "drive:drive:readonly", name: "查看、评论和下载云空间中所有文件" },
      { scope: "wiki:wiki:readonly", name: "查看知识库" },
    ],
    write: [
      { scope: "docx:document", name: "创建及编辑新版文档" },
      { scope: "drive:drive", name: "查看、评论、编辑和管理云空间中所有文件" },
      { scope: "wiki:wiki", name: "查看、编辑和管理知识库" },
    ],
  },
  {
    key: "bitable",
    label: "多维表格",
    description: "查看数据表、字段和记录；新增、修改记录",
    read: [{ scope: "bitable:app:readonly", name: "查看、评论和导出多维表格" }],
    write: [{ scope: "bitable:app", name: "查看、评论、编辑和管理多维表格" }],
  },
  {
    key: "sheets",
    label: "电子表格",
    description: "读取、写入单元格区域",
    read: [{ scope: "sheets:spreadsheet:readonly", name: "查看、评论和导出电子表格" }],
    write: [{ scope: "sheets:spreadsheet", name: "查看、评论、编辑和管理电子表格" }],
  },
  {
    key: "meeting",
    label: "视频会议",
    description: "以提问的人为主持人预约会议，得到入会链接",
    read: [],
    write: [{ scope: "vc:reserve", name: "更新会议预约信息" }],
  },
  {
    key: "task",
    label: "任务",
    description: "创建任务，设置截止时间和负责人",
    read: [],
    write: [{ scope: "task:task:write", name: "查看、创建、更新、删除任务" }],
  },
];

/**
 * The scopes Feishu has granted the app, asked of Feishu itself (``application/v6/scopes``: no permission needed;
 * a scope is either granted or not, review pending counts as not).
 */
export async function grantedScopes(conn: Connection): Promise<Set<string>> {
  const data = await new FeishuAdapter().call(conn, "GET", "application/v6/scopes", { timeoutMs: 15_000 });
  return new Set((data.scopes ?? []).filter((s: any) => s.grant_status === 1).map((s: any) => s.scope_name));
}

/** What an app can offer of each product, from its granted scopes; a write scope also reads. */
export function productStatus(granted: Set<string>) {
  return FEISHU_PRODUCTS.map((p) => {
    const write = p.write.length > 0 && p.write.every((s) => granted.has(s.scope));
    const read =
      write || (p.read.length > 0 && p.read.every((s) => granted.has(s.scope) || granted.has(writeOf(p, s))));
    return {
      key: p.key,
      label: p.label,
      read,
      write,
      missing: p.write.filter((s) => !granted.has(s.scope)).map((s) => s.scope),
    };
  });
}

/** The write scope standing beside a read one (docx:document for docx:document:readonly…). */
function writeOf(p: FeishuProduct, read: FeishuScope): string {
  const i = p.read.indexOf(read);
  return p.write[i]?.scope ?? "";
}

// --- calls -----------------------------------------------------------------------------------------------------

/** Feishu's answers to a call that went wrong, said so a role can tell the person what to do. */
export function explainFeishuError(err: Error): string {
  const m = err.message;
  const code = /\((\d+)\)/.exec(m)?.[1] ?? "";
  if (code === "99991672")
    return `${m}\n(这个飞书应用没有开通所需的权限：请在飞书开发者后台申请上面列出的权限并发布新版本。)`;
  if (["91403", "1770032", "1254302", "1254304", "1061004", "131006"].includes(code))
    return `${m}\n(应用对这个文档、表格或知识库没有权限：请在其中通过“…→ 更多 → 添加文档应用”把这个应用加进来，写入需要编辑权限；知识库要把应用加为成员。)`;
  if (code === "1254301") return `${m}\n(这个多维表格开启了高级权限：需要给应用“可管理”权限。)`;
  if (["191002", "191004"].includes(code))
    return `${m}\n(应用不能访问这个日历：请把日历共享给应用，创建日程需要可编辑权限。)`;
  if (code === "190007") return `${m}\n(飞书应用没有开启机器人能力。)`;
  if (code === "1470403") return `${m}\n(应用不能访问这个任务。)`;
  return m;
}

export async function feishuApi(
  conn: Connection,
  method: string,
  path: string,
  opts: { params?: Record<string, string>; body?: unknown } = {},
): Promise<any> {
  return new FeishuAdapter().call(conn, method, path, { ...opts, timeoutMs: 20_000 });
}

export const labelsFor = (conn: Connection) => [feishuLabel(conn.id)];

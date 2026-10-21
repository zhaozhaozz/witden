// Display helpers: Chinese labels for states, times and sizes.

export type Tone = "ok" | "run" | "wait" | "bad" | "off" | "info";

export interface StatusMeta {
  label: string;
  tone: Tone;
}

const TASK_STATUS: Record<string, StatusMeta> = {
  pending: { label: "待处理", tone: "info" },
  running: { label: "执行中", tone: "run" },
  waiting_human: { label: "等待人工", tone: "wait" },
  waiting_approval: { label: "等待审批", tone: "wait" },
  waiting_children: { label: "等待子任务", tone: "wait" },
  waiting_resource: { label: "等待虚拟电脑", tone: "wait" },
  waiting_timer: { label: "等待定时跟进", tone: "wait" },
  waiting_role: { label: "待认领", tone: "wait" },
  paused: { label: "已暂停", tone: "off" },
  completed: { label: "已完成", tone: "ok" },
  failed: { label: "失败", tone: "bad" },
  cancelled: { label: "已取消", tone: "off" },
};

const INSTANCE_STATUS: Record<string, StatusMeta> = {
  creating: { label: "创建中", tone: "wait" },
  running: { label: "运行中", tone: "run" },
  stopped: { label: "已停止", tone: "off" },
  error: { label: "故障", tone: "bad" },
  deleting: { label: "删除中", tone: "wait" },
  deleted: { label: "已删除", tone: "off" },
};

const GENERIC_STATUS: Record<string, StatusMeta> = {
  active: { label: "启用", tone: "ok" },
  disabled: { label: "已停用", tone: "off" },
  archived: { label: "已归档", tone: "off" },
  paused: { label: "已暂停", tone: "off" },
  error: { label: "故障", tone: "bad" },
  ok: { label: "正常", tone: "ok" },
  unchecked: { label: "未检测", tone: "info" },
  revoked: { label: "密钥已撤销", tone: "bad" },
  pending: { label: "待审批", tone: "wait" },
  approved: { label: "已批准", tone: "ok" },
  rejected: { label: "已拒绝", tone: "bad" },
  sent: { label: "已送达", tone: "ok" },
  sending: { label: "发送中", tone: "run" },
  failed: { label: "失败", tone: "bad" },
  blocked: { label: "已拦截", tone: "bad" },
  denied: { label: "拒绝", tone: "bad" },
};

export const ACTIVE_TASK_STATUSES = [
  "pending",
  "running",
  "waiting_human",
  "waiting_approval",
  "waiting_children",
  "waiting_resource",
  "waiting_timer",
  "waiting_role",
  "paused",
];

export const TASK_STATUS_ORDER = [...ACTIVE_TASK_STATUSES, "completed", "failed", "cancelled"];

export function taskStatus(s: string): StatusMeta {
  return TASK_STATUS[s] ?? { label: s, tone: "info" };
}

export function instanceStatus(s: string): StatusMeta {
  return INSTANCE_STATUS[s] ?? { label: s, tone: "info" };
}

export function genericStatus(s: string): StatusMeta {
  return GENERIC_STATUS[s] ?? { label: s, tone: "info" };
}

export function isActiveTask(status: string): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function parseTime(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  // Backend timestamps are UTC; naive ones (no offset) must not be read as local time.
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(iso);
  const d = new Date(hasZone ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtTime(iso: string | null | undefined): string {
  const d = parseTime(iso);
  if (!d) return "—";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  const d = parseTime(iso);
  if (!d) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

export function fmtRelative(iso: string | null | undefined): string {
  const d = parseTime(iso);
  if (!d) return "—";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 0) {
    const ahead = -sec;
    if (ahead < 60) return `${ahead} 秒后`;
    if (ahead < 3600) return `${Math.round(ahead / 60)} 分钟后`;
    return `${Math.round(ahead / 3600)} 小时后`;
  }
  if (sec < 45) return "刚刚";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} 分钟前`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 小时前`;
  if (sec < 86400 * 7) return `${Math.round(sec / 86400)} 天前`;
  return fmtTime(iso);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("zh-CN");
}

/** Token counts as people read them: 850, 12.3K, 1.2M. */
export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  const i = id.indexOf("_");
  const tail = i >= 0 ? id.slice(i + 1) : id;
  return (i >= 0 ? id.slice(0, i + 1) : "") + tail.slice(0, 8);
}

export function initials(name: string | null | undefined): string {
  const s = (name ?? "").trim();
  if (!s) return "?";
  // CJK names: last character reads naturally; latin: first letter(s).
  if (/[一-鿿]/.test(s[0])) return s.slice(-1);
  const parts = s.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

/** Stable hue per id, so a role keeps the same avatar color everywhere. */
export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function listToLines(list: string[] | null | undefined): string {
  return (list ?? []).join("\n");
}

export const CONVERSATION_KIND: Record<string, string> = {
  public: "公开频道",
  private: "私有频道",
  im: "单人私信",
  mpim: "多人私信",
  internal: "内部话题",
};

export const PLATFORM_LABEL: Record<string, string> = {
  slack: "Slack",
  feishu: "飞书",
  github: "GitHub",
  wecom: "企业微信",
  web: "网页",
  internal: "内部",
};

export const TOOL_GROUP_LABEL: Record<string, string> = {
  shell: "命令行",
  terminal: "终端会话",
  files: "文件",
  desktop: "桌面操作",
  browser: "浏览器",
  system_software: "系统软件",
  software_list: "软件清单",
  automation: "自动化管理",
  memory: "记忆",
  topics: "读取其他话题",
  config: "witden 配置",
  profile: "职责说明",
};

/**
 * How permissions are ordered and grouped wherever a role's are shown: where the role works, what it automates,
 * what it reads, and the role itself. Working with the roles of a topic needs no permission. Groups not listed
 * (none yet) go last.
 */
export const PERMISSION_SECTIONS: { key: string; label: string; hint: string; groups: string[] }[] = [
  {
    key: "computer",
    label: "虚拟电脑",
    hint: "在角色自己的虚拟电脑里工作",
    groups: ["shell", "terminal", "files", "browser", "desktop", "system_software", "software_list"],
  },
  { key: "automation", label: "自动化", hint: "在参与的话题里管理自己负责的触发器", groups: ["automation"] },
  { key: "knowledge", label: "资料", hint: "平台上的记忆和知识空间，以及其他话题", groups: ["memory", "topics"] },
  { key: "self", label: "角色与平台", hint: "角色自己的介绍，以及 witden 本身的配置", groups: ["profile", "config"] },
];

const GROUP_ORDER = PERMISSION_SECTIONS.flatMap((s) => s.groups);
const groupRank = (g: string) => {
  const i = GROUP_ORDER.indexOf(g);
  return i < 0 ? GROUP_ORDER.length : i;
};

/**
 * A role's tool groups as labels, in the editor's order; Feishu and GitHub grants (one per connection and product)
 * as one entry each.
 */
export function permissionLabels(groups: string[]): string[] {
  const labels = groups
    .filter((g) => !/^(feishu|github):/.test(g))
    .sort((a, b) => groupRank(a) - groupRank(b))
    .map((g) => TOOL_GROUP_LABEL[g] ?? g);
  if (groups.some((g) => g.startsWith("feishu:"))) labels.push("飞书工具");
  if (groups.some((g) => g.startsWith("github:"))) labels.push("GitHub 工具");
  return labels;
}

/** What each tool group covers, in people's words. */
export const TOOL_GROUP_HINT: Record<string, string> = {
  shell: "在角色的虚拟电脑里执行命令",
  terminal: "在虚拟电脑里开交互式或长时间运行的终端会话",
  files: "读写和整理虚拟电脑里的文件；也可以把虚拟电脑里的文件分享到话题",
  desktop: "查看虚拟电脑的屏幕，操作它的鼠标和键盘",
  browser: "操作虚拟电脑里的浏览器（桌面上可见的或后台的），下载的文件保存在虚拟电脑里",
  system_software:
    "请平台在虚拟电脑里安装或卸载系统软件包（apt）。角色自己没有 root 权限，由平台以 root 执行固定的安装命令；镜像自带的软件不能卸载。不在软件清单里的软件，重置虚拟电脑后会消失",
  software_list: "修改虚拟电脑的软件清单：清单里的软件包在虚拟电脑每次启动时自动安装，重置后也会装回",
  automation:
    "在它参与的话题里新建和修改自己负责的触发器；不能读取密钥，也不能扩大 Webhook 来源的授权。只在控制台账号请求的工作中可用",
  memory: "在平台上记住和检索笔记与知识，不在虚拟电脑里",
  topics:
    "查找并读取其他话题（不含私信），包括 Slack、飞书、GitHub 中的会话；读到的内容可以在角色工作的任何地方使用。新角色默认禁用",
  profile:
    "修改自己的职责说明（别人邀请、私信时看到的介绍），不能改其他设置；只在控制台的对话中可用，Slack、飞书、GitHub 的会话中没有",
  config:
    "像管理员一样读取和修改 witden 的配置（角色、模型、虚拟电脑、通讯接入、知识；不含账号），读不到也改不了任何密钥",
};

/** Tool names as actions ("正在" + label reads naturally too). */
export const TOOL_LABEL: Record<string, string> = {
  feishu_apps: "查看可用的飞书应用",
  feishu_calendar_list: "查看飞书日历",
  feishu_calendar_search: "搜索飞书公共日历",
  feishu_calendar_members: "查看飞书日历的成员",
  feishu_calendar_share_link: "获取飞书日历的分享链接",
  feishu_calendar_share_card: "发送飞书日历分享卡片",
  feishu_calendar_events: "查看飞书日程",
  feishu_calendar_event: "查看飞书日程详情",
  feishu_calendar_freebusy: "查看飞书忙闲",
  feishu_calendar_create: "新建飞书共享日历",
  feishu_calendar_update: "修改飞书日历",
  feishu_calendar_share: "设置飞书日历的成员",
  feishu_calendar_unshare: "移除飞书日历的成员",
  feishu_calendar_subscribe: "订阅飞书日历",
  feishu_calendar_create_event: "创建飞书日程",
  feishu_calendar_update_event: "修改飞书日程",
  feishu_calendar_delete_event: "取消飞书日程",
  feishu_doc_read: "读取飞书文档",
  feishu_drive_list: "查看飞书云空间文件夹",
  feishu_wiki_list: "查看飞书知识库",
  feishu_doc_create: "新建飞书文档",
  feishu_doc_append: "向飞书文档追加内容",
  feishu_bitable_schema: "查看多维表格结构",
  feishu_bitable_records: "查询多维表格记录",
  feishu_bitable_add_record: "新增多维表格记录",
  feishu_bitable_update_record: "修改多维表格记录",
  feishu_sheet_read: "读取飞书电子表格",
  feishu_sheet_write: "写入飞书电子表格",
  feishu_meeting_reserve: "预约飞书视频会议",
  feishu_task_create: "创建飞书任务",
  github_apps: "查看可用的 GitHub 接入",
  github_repos: "查看能访问的 GitHub 仓库",
  github_read_path: "读取 GitHub 仓库中的文件",
  github_write_file: "向 GitHub 仓库提交文件",
  github_create_branch: "新建 GitHub 分支",
  github_issue_list: "查看 GitHub issue 列表",
  github_issue_get: "查看 GitHub issue",
  github_issue_create: "新建 GitHub issue",
  github_issue_comment: "评论 GitHub issue",
  github_issue_update: "修改 GitHub issue",
  github_pr_list: "查看 pull request 列表",
  github_pr_get: "查看 pull request",
  github_pr_create: "新建 pull request",
  github_pr_comment: "评论 pull request",
  github_pr_merge: "合并 pull request",
  github_actions_runs: "查看 GitHub Actions 运行",
  github_actions_rerun: "重新运行 GitHub Actions",
  github_workflow_dispatch: "手动触发 GitHub 工作流",
  run_command: "执行命令",
  terminal_start: "启动终端",
  terminal_read: "读取终端输出",
  terminal_input: "向终端输入",
  terminal_control: "中断或结束终端",
  read_file: "读取虚拟电脑里的文件",
  write_file: "写入虚拟电脑里的文件",
  list_directory: "查看虚拟电脑里的目录",
  move_file: "移动或重命名虚拟电脑里的文件",
  share_file: "把虚拟电脑里的文件分享到话题",
  screenshot: "截取虚拟电脑屏幕",
  mouse: "操作鼠标",
  keyboard: "操作键盘",
  release_desktop: "交还桌面",
  browser_open: "打开网页",
  browser_snapshot: "读取网页内容",
  browser_click: "点击网页元素",
  browser_type: "在网页中输入",
  browser_download: "下载文件到虚拟电脑",
  browser_screenshot: "网页截图",
  browser_close: "关闭浏览器",
  install_packages: "安装系统软件",
  uninstall_packages: "卸载系统软件",
  software_list: "查看软件清单",
  edit_software_list: "修改软件清单",
  message_role: "在话题内 @ 其他角色",
  delegate_task: "委派任务",
  start_task: "拆出独立任务",
  continue_task: "给自己拆出的任务补充要求",
  transfer_task: "把任务转交给其他角色",
  manage_automation: "管理负责的自动化",
  send_message: "向话题发送消息",
  linked_topic_status: "查看关联话题的工作状态",
  remember: "记录记忆",
  recall: "检索记忆",
  update_memory: "修改记忆",
  forget: "删除记忆",
  read_topic: "查阅其他话题",
  read_webhook_history: "查阅本话题的 webhook 历史",
  ask_human: "向人提问",
  post_progress: "汇报进度",
  follow_up_later: "稍后跟进",
  stay_silent: "决定不回复",
  update_my_description: "修改自己的职责说明",
  read_config: "读取 witden 配置",
  change_config: "修改 witden 配置",
};

/** A topic's response modes: the label in the header switch, the full explanation on hover. */
export const RESPONSE_MODE: Record<"mention" | "auto", { label: string; hint: string }> = {
  mention: {
    label: "主动 @",
    hint: "主动 @ 模式：角色只在被 @ 时回应。在输入框输入 @ 后，从弹出的列表里点选角色才算 @；粘贴或手打的“@名称”只是文字，不会让角色开始工作。角色之间也只能用专门的工具 @ 对方，回答里提到某个角色不会触发它。",
  },
  auto: {
    label: "自动",
    hint: "自动模式：没有 @ 任何角色的消息也可能交给角色。话题里只有一个角色时，它会看每条消息并自己决定是否回复（闲聊等可以不回）；有多个角色时，由「系统管理 → 话题调度」里设置的调度模型决定交给哪几个角色，也可以一个都不交。被 @ 的角色总会回应。",
  },
};

/** System One decision models (provider protocol "systemone"): a fast kind of topic dispatcher. */
export const SYSTEM_ONE_HINT =
  "System 1 模型（如 TypeSafe Jev、开源的 Laya）不生成文字，而是针对给定内容回答选择、是否、打分等问题并给出概率，一次判断通常只需几十到几百毫秒。witden 可以用它做话题调度；它不能对话、不能调用工具，因此不能用作角色的模型。";

export function fmtLatency(ms: number | undefined): string | null {
  if (ms === undefined || ms === null) return null;
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

export const RUNNER_VIA_LABEL: Record<string, string> = {
  websocket: "主动连入（WebSocket）",
  stdio: "管理通道（stdio）",
  memory: "进程内（测试）",
};

export const EXEC_SESSION_KIND: Record<string, string> = {
  terminal: "终端",
  browser: "浏览器",
};

const AUDIT_LABEL: Record<string, string> = {
  "task.create": "创建任务",
  "task.created": "创建任务",
  "task.denied": "拒绝分配",
  "task.complete": "完成任务",
  "task.failed": "任务失败",
  "routing.failed": "话题自动调度失败",
  "integration.error": "通讯接入诊断",
  "task.reassign": "转交任务",
  "task.pause": "暂停",
  "task.resume": "继续",
  "task.cancel": "取消",
  "task.instruct": "补充要求",
  "task.retry": "重试",
  "task.continue": "补充要求（任务重新开始）",
  "topic.link": "关联话题",
  "topic.unlink": "解除话题关联",
  "message.topic_send": "跨话题发送",
  "message.post": "发送消息",
  "tool.denied": "工具被拒绝",
  "approval.request": "申请审批",
  "approval.decide": "审批决定",
  "approval.approved": "审批通过",
  "approval.rejected": "审批拒绝",
  "output.blocked": "输出被拦截",
  "file.upload": "从自己的电脑上传文件",
  "file.download": "下载文件到自己的电脑",
  "memory.create": "写入记忆",
  "memory.update": "修改记忆",
  "memory.delete": "删除记忆",
  "emergency.stop": "紧急停止",
  "emergency.release": "解除紧急停止",
  "topic.publish": "发布到外部频道",
  "instance.takeover": "接管虚拟电脑",
  "instance.handback": "交还虚拟电脑",
  "instance.vnc": "打开实时画面",
  "instance.software_list": "修改软件清单",
  "instance.software_install": "按软件清单安装",
  "runner.rejected": "拒绝 Runner 连接",
};

export function auditLabel(action: string): string {
  // Every tool call is audited as tool.<name>.
  if (!AUDIT_LABEL[action] && action.startsWith("tool.")) return `工具 ${action.slice(5)}`;
  return AUDIT_LABEL[action] ?? action;
}

export const RESTRICTED = "[restricted]";

/** Text fields of tasks in topics the viewer may not see come back as "[restricted]". */
export function isRestricted(v: unknown): boolean {
  return v === RESTRICTED;
}

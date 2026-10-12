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
  waiting_resource: { label: "等待电脑", tone: "wait" },
  waiting_timer: { label: "等待定时跟进", tone: "wait" },
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
  wecom: "企业微信",
  web: "网页",
  internal: "内部",
};

export const SYNC_MODE: Record<string, string> = {
  mentions: "仅 @ 机器人的 thread",
  all: "全部 thread",
  off: "不同步",
};

export const TOOL_GROUP_LABEL: Record<string, string> = {
  shell: "命令行",
  terminal: "终端会话",
  files: "文件",
  desktop: "桌面操作",
  browser: "浏览器",
  collaborate: "协作委托",
  memory: "记忆",
  topics: "跨话题引用",
};

/** What each tool group covers, in people's words. */
export const TOOL_GROUP_HINT: Record<string, string> = {
  shell: "在角色的电脑里执行命令",
  terminal: "交互式或长时间运行的终端会话",
  files: "读写和整理电脑里的文件，并分享到话题",
  desktop: "查看屏幕，使用鼠标和键盘",
  browser: "操作电脑里的浏览器（桌面上可见的或后台的）",
  collaborate: "给其他角色发消息、委派任务（受「可以联系的角色」限制）",
  memory: "记住和检索笔记与知识",
  topics: "引用请求者能阅读的其他话题",
};

/** Tool names as actions ("正在" + label reads naturally too). */
export const TOOL_LABEL: Record<string, string> = {
  run_command: "执行命令",
  terminal_start: "启动终端",
  terminal_read: "读取终端输出",
  terminal_input: "向终端输入",
  terminal_control: "中断或结束终端",
  read_file: "读取文件",
  write_file: "写入文件",
  list_directory: "查看目录",
  move_file: "移动或重命名文件",
  share_file: "分享文件到话题",
  screenshot: "截取屏幕",
  mouse: "操作鼠标",
  keyboard: "操作键盘",
  release_desktop: "交还桌面",
  browser_open: "打开网页",
  browser_snapshot: "读取网页内容",
  browser_click: "点击网页元素",
  browser_type: "在网页中输入",
  browser_download: "下载文件",
  browser_screenshot: "网页截图",
  browser_close: "关闭浏览器",
  message_role: "联系其他角色",
  delegate_task: "委派任务",
  remember: "记录记忆",
  recall: "检索记忆",
  read_topic: "查阅其他话题",
  ask_human: "向人提问",
  post_progress: "汇报进度",
  follow_up_later: "稍后跟进",
};

export const RUNNER_VIA_LABEL: Record<string, string> = {
  websocket: "主动连入（WebSocket）",
  stdio: "管理通道（stdio）",
  memory: "进程内（测试）",
};

export const EXEC_SESSION_KIND: Record<string, string> = {
  terminal: "终端",
  browser: "浏览器",
};

export const PERMISSION_LABEL: Record<string, string> = {
  "topic.create": "创建话题",
  "role.use": "使用角色",
  "role.invite": "邀请角色进话题",
  "role.manage": "管理角色",
  "instance.observe": "观察电脑",
  "instance.control": "接管电脑",
  "instance.manage": "管理电脑",
  "template.manage": "管理模板",
  "file.download": "下载文件",
  "rules.manage": "管理分配规则",
  "secrets.manage": "管理模型与密钥",
  "model.use": "使用模型配置",
  "connection.manage": "管理通讯接入",
  "topic.publish": "发布话题到外部频道",
  "audit.view": "查看审计与用量",
  "user.manage": "管理成员与授权",
  "approval.decide": "审批",
  "knowledge.read": "读取知识空间",
  "knowledge.write": "编辑知识空间",
  "emergency.stop": "紧急停止",
};

export function permissionLabel(p: string): string {
  return PERMISSION_LABEL[p] ?? p;
}

const AUDIT_LABEL: Record<string, string> = {
  "task.create": "创建任务",
  "task.created": "创建任务",
  "task.denied": "拒绝分配",
  "task.complete": "完成任务",
  "task.failed": "任务失败",
  "task.reassign": "转交任务",
  "task.pause": "暂停",
  "task.resume": "继续",
  "task.cancel": "取消",
  "task.instruct": "补充要求",
  "task.retry": "重试",
  "message.post": "发送消息",
  "tool.denied": "工具被拒绝",
  "approval.request": "申请审批",
  "approval.decide": "审批决定",
  "approval.approved": "审批通过",
  "approval.rejected": "审批拒绝",
  "output.blocked": "输出被拦截",
  "file.upload": "上传文件",
  "file.download": "下载文件",
  "memory.create": "写入记忆",
  "emergency.stop": "紧急停止",
  "emergency.release": "解除紧急停止",
  "topic.publish": "发布到外部频道",
  "instance.takeover": "接管电脑",
  "instance.handback": "交还电脑",
  "instance.vnc": "打开实时画面",
  "runner.rejected": "拒绝 Runner 连接",
};

export function auditLabel(action: string): string {
  // Every tool call is audited as tool.<name>.
  if (!AUDIT_LABEL[action] && action.startsWith("tool.")) return `工具 ${action.slice(5)}`;
  return AUDIT_LABEL[action] ?? action;
}

export const RESTRICTED = "[restricted]";

/** Text fields of tasks that read material the viewer may not see come back as "[restricted]". */
export function isRestricted(v: unknown): boolean {
  return v === RESTRICTED;
}

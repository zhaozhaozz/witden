import type { ReactNode } from "react";
import { api } from "../api/client";
import type { Connection, ExternalIdentity } from "../api/types";
import { useResource } from "../lib/hooks";
import { useDirectory } from "../lib/session";
import { useAction } from "../ui/feedback";
import { Empty, Field, Loaded, Tag, Toggle } from "../ui/kit";

// Outcomes recorded by the server's inbound handler (integrations/inbound.ts).
export const INBOUND_STATUS: Record<string, [string, "ok" | "wait" | "off" | "bad"]> = {
  queued: ["等待处理", "wait"],
  processing: ["处理中", "wait"],
  dispatched: ["已交给角色", "ok"],
  not_assigned: ["没有交给角色", "bad"],
  stored: ["已记录（未 @ 机器人）", "ok"],
  ignored: ["已忽略", "off"],
  // recorded before every thread was synced (migration 0016)
  sync_off: ["会话不同步", "off"],
  connection_paused: ["接入已暂停", "off"],
  bot_limit: ["机器人连续请求已达上限，只记录", "wait"],
  unknown_connection: ["接入不存在", "bad"],
  unlinked_user: ["账号未关联成员", "bad"],
  failed: ["处理失败", "bad"],
};

/** Why Slack refused a Socket Mode connection. */
function slackWhy(e: string): string {
  if (/link_disabled/.test(e)) return "应用没有打开 Socket Mode：在应用的 Socket Mode 页面打开 Enable Socket Mode";
  if (/missing_scope/.test(e))
    return "App-Level Token 缺少 connections:write 权限：在 App-Level Tokens 中重新生成并添加这个权限";
  if (/invalid_auth|not_authed|token_revoked|not_allowed_token_type/.test(e)) return "App-Level Token 不正确或已撤销";
  return e;
}

/** Why Feishu's long connection is down, by the error codes Feishu's SDK knows. */
function feishuWhy(e: string): string {
  if (/code[=:] ?514\b|auth_failed/.test(e)) return "App ID 或 App Secret 不正确";
  if (/1000040350|exceed_conn_limit/.test(e))
    return "这个应用的长连接数已达上限（每个应用最多 50 个）：检查是否还有其他程序用这个应用连接飞书";
  if (/code[=:] ?403\b|forbidden/.test(e)) return "飞书不允许这个应用使用长连接：长连接只支持企业自建应用";
  if (/1000040343/.test(e)) return "飞书返回内部错误。App ID 不存在时也是这个错误，请核对 App ID";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|connect failed|socket hang up/i.test(e))
    return `连不上飞书，请检查服务器的网络或代理（${e}）`;
  return e;
}

/** The state of a connection witden keeps open (Slack Socket Mode, the Feishu long connection), in words. */
export function socketText(
  socket: Connection["socket"],
  platform: string,
): { text: string; tone: "ok" | "wait" | "bad" } {
  if (!socket)
    return {
      text: platform === "feishu" ? "未连接（接入已暂停）" : "未连接（接入已暂停，或还没有保存 App-Level Token）",
      tone: "wait",
    };
  if (socket.state === "connected") return { text: "已连接", tone: "ok" };
  const e = socket.error ?? "";
  const why = platform === "feishu" ? feishuWhy(e) : slackWhy(e);
  if (socket.state === "connecting") return { text: why ? `正在连接：${why}` : "正在连接", tone: "wait" };
  return { text: `连接失败，正在重试：${why}`, tone: "bad" };
}

/** What a Slack bot cannot do without a scope the connection test checks (server: integrations/slack.ts). */
const SCOPE_EFFECTS: Record<string, string> = {
  "chat:write": "角色不能在 Slack 中回复",
  "files:write": "角色分享的文件和截图不能发到 Slack，只能附上控制台链接",
};

/** A warning for scopes the Slack app was installed without, or null when nothing is missing. */
export function missingScopes(scopes: string[] | undefined): string | null {
  if (!scopes?.length) return null;
  const effects = scopes.map((x) => SCOPE_EFFECTS[x] ?? x).join("；");
  return `Slack 应用缺少 ${scopes.join("、")} 权限（${effects}）。在应用的 OAuth & Permissions 页面添加后，点击 Reinstall to Workspace 重新安装。`;
}

/** Why the server refused a signed call to the events URL. */
export const REJECTED: Record<string, string> = {
  "bad Slack signature": "签名不对",
  "stale Slack request": "请求时间与服务器时间相差超过 5 分钟",
  "connection has no signing secret": "还没有保存 Signing Secret",
  "bad GitHub signature": "签名不对",
  "connection has no webhook secret": "还没有保存 Webhook Secret",
  "bad Feishu verification token": "Verification Token 不对",
  "this connection receives events over the long connection":
    "这个接入使用长连接，飞书却仍在把事件推送到事件地址：在飞书开发者后台把订阅方式改为“使用长连接接收事件”",
};

/** The platform's latest call to the events URL was refused (after any accepted one). */
export function lastRejected(conn: { webhook?: Connection["webhook"] }): { at: string; reason: string } | null {
  const w = conn.webhook;
  if (!w?.rejected_at) return null;
  const accepted = [w.verified_at, w.received_at].filter(Boolean).sort().at(-1);
  if (accepted && accepted > w.rejected_at) return null;
  return { at: w.rejected_at, reason: REJECTED[w.rejected_reason ?? ""] ?? w.rejected_reason ?? "" };
}

export interface InboundEvent {
  id: string;
  event_key: string;
  status: string;
  detail: string | null;
  received_at: string;
}

/** Credential fields per platform, as [key, label]; shared by the connection form and the Slack guide. */
export const CREDENTIAL_FIELDS: Record<string, [string, string][]> = {
  // Slack: see SLACK_FIELDS (Socket Mode, or the events URL)
  slack: [],
  // Feishu: see FEISHU_FIELDS (the long connection, or the events URL)
  feishu: [],
  // GitHub: see GITHUB_FIELDS (a GitHub App, or a bot account's token)
  github: [],
};

/** Socket Mode (recommended: no public address) or the events URL; the bot token is the same for both. */
export const SLACK_FIELDS: Record<"socket" | "http", [string, string][]> = {
  socket: [
    ["bot_token", "Bot User OAuth Token"],
    ["app_token", "App-Level Token"],
  ],
  http: [
    ["bot_token", "Bot User OAuth Token"],
    ["signing_secret", "Signing Secret"],
  ],
};

/** The long connection (recommended: no public address) or the events URL, which also checks a token. */
export const FEISHU_FIELDS: Record<"socket" | "http", [string, string][]> = {
  socket: [
    ["app_id", "App ID"],
    ["app_secret", "App Secret"],
  ],
  http: [
    ["app_id", "App ID"],
    ["app_secret", "App Secret"],
    ["verification_token", "Verification Token"],
  ],
};

/** A GitHub App (recommended) or a bot account; the private key is a multi-line PEM. */
export const GITHUB_FIELDS: Record<"app" | "token", [string, string][]> = {
  app: [
    ["app_id", "App ID"],
    ["private_key", "Private key（.pem 文件的全部内容）"],
    ["webhook_secret", "Webhook Secret"],
  ],
  token: [
    ["token", "机器人账号的 Token（ghp_… 或 github_pat_…）"],
    ["webhook_secret", "Webhook Secret"],
  ],
};

/** An account that only authenticates the GitHub tools takes no events, so it has no webhook secret. */
export const GITHUB_AUTH_ONLY_FIELDS: [string, string][] = [["token", "账号的 Token（ghp_… 或 github_pat_…）"]];

/**
 * What goes into each Slack credential and where it is, shown right above the inputs. After an app is created
 * Slack shows a couple of tokens, and the app-level one (xapp-) is easily taken for the signing secret.
 */
export const SLACK_FIELD_HELP: Record<string, ReactNode> = {
  bot_token: (
    <>
      在应用的 <b>OAuth &amp; Permissions</b> 页面（安装应用后才有），以 <code>xoxb-</code> 开头。创建应用后 Slack
      列出的令牌中，只有 <code>xoxb-</code> 开头的这一个填在这里。witden 用它读取消息、发送回复。
    </>
  ),
  app_token: (
    <>
      <code>xapp-</code> 开头。在应用的 <b>Basic Information</b> 页面 → <b>App-Level Tokens</b> 中生成，必须带{" "}
      <code>connections:write</code> 权限。witden 用它主动连到 Slack 接收消息，所以不需要公网地址。
    </>
  ),
  signing_secret: (
    <>
      <b>不在 Slack 弹出的令牌里。</b>到应用的 <b>Basic Information</b> 页面 → <b>App Credentials</b>，点击 Signing
      Secret 旁的 Show 后复制，是 32 位十六进制字符。不要填 <code>xapp-</code> 开头的 App-Level Token，也不要填 Client
      Secret 或 Verification Token。witden 用它确认事件确实来自 Slack。
    </>
  ),
};

/** A connection's settings as edited in the console. */
export interface ConnSettings {
  /** The role the connection's bot stands for (null: not chosen yet; the bot takes no requests). */
  role_id: string | null;
  auto_provision_users: boolean;
  /** Feishu only: other bots @-mentioning the bot go to its role (otherwise their messages are context only). */
  bot_requests?: boolean;
  /** GitHub only: not a bot; the account only authenticates the GitHub tools roles are given. */
  auth_only?: boolean;
}

export const settingsOf = (conn: Connection | null): ConnSettings => ({
  role_id: typeof conn?.settings?.role_id === "string" && conn.settings.role_id ? conn.settings.role_id : null,
  auto_provision_users: !!conn?.settings?.auto_provision_users,
  ...(conn?.platform === "feishu" ? { bot_requests: !!conn.settings?.bot_requests } : {}),
  ...(conn?.platform === "github" ? { auth_only: !!conn.settings?.auth_only } : {}),
});

/** Who may use the bot; shared by the connection form and setup guides. */
export function ConnectionSettingsFields({
  platform,
  value,
  onChange,
  chooseRole = true,
  botLimit = 8,
}: {
  platform: string;
  value: ConnSettings;
  onChange: (next: ConnSettings) => void;
  /** Feishu: requests from other bots in a row before waiting for a person (the server's MAX_AUTO_ROUNDS). */
  botLimit?: number;
  /** Show the role choice (the setup guide asks for it on its own). */
  chooseRole?: boolean;
}) {
  const dir = useDirectory();
  const set = (patch: Partial<ConnSettings>) => onChange({ ...value, ...patch });
  return (
    <>
      {chooseRole ? (
        <Field
          label="机器人代表的角色"
          hint="发给这个机器人的消息都交给这个角色，回复以机器人的名字和头像发出。需要多个角色时，为每个角色各建一个应用。"
        >
          <select required value={value.role_id ?? ""} onChange={(e) => set({ role_id: e.target.value || null })}>
            {value.role_id ? null : (
              <option value="" disabled>
                选择一个角色（未选择时机器人不接收请求）
              </option>
            )}
            {dir.roles
              // A system administrator works only in the console, never as a bot.
              .filter((r) => !r.system_admin && (r.status === "active" || r.id === value.role_id))
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} @{r.handle}
                </option>
              ))}
          </select>
        </Field>
      ) : null}
      <Toggle
        checked={value.auto_provision_users}
        onChange={(v) => set({ auto_provision_users: v })}
        label="允许未关联的人使用：自动建为外部成员（不登录控制台，私信彼此隔离）"
        hint={
          value.auto_provision_users
            ? `外部成员可以使用这个机器人代表的角色${value.role_id ? ` ${dir.roleLabel(value.role_id)}` : ""}。`
            : undefined
        }
      />
      {platform === "feishu" ? (
        <Toggle
          checked={!!value.bot_requests}
          onChange={(v) => set({ bot_requests: v })}
          label="其他机器人 @ 这个机器人时，也交给角色处理"
          hint={`关闭时（默认），群里其他机器人发的消息只记入话题、作为角色的上下文。开启后，其他机器人 @ 这个机器人的消息也交给角色；为防止机器人之间来回触发，连续 ${botLimit} 次都是机器人的请求、中间没有人发言时，之后的只记录，等有人发言再继续。`}
        />
      ) : null}
    </>
  );
}

export function Identities({ conn }: { conn: Connection }) {
  const dir = useDirectory();
  const { run } = useAction();
  const res = useResource(() => api.get<ExternalIdentity[]>("/api/identities", { connection_id: conn.id }), [conn.id]);
  return (
    <>
      <p className="small muted side-note">
        外部账号按平台用户 ID
        关联到内部成员，不按显示名称判断身份。未关联的人在连接开启“允许未关联的人使用”时成为外部成员，否则不能使用角色。
      </p>
      <Loaded res={res}>
        {(rows) =>
          rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>外部账号</th>
                    <th>平台用户 ID</th>
                    <th>关联成员</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.id}>
                      <td>
                        {i.display_name ?? <span className="muted">（无显示名）</span>}
                        {i.is_bot ? <Tag tone="off">机器人</Tag> : null}
                      </td>
                      <td>
                        <code className="id">{i.external_user_id}</code>
                      </td>
                      <td>
                        <select
                          value={i.user_id ?? ""}
                          aria-label="关联成员"
                          onChange={async (e) => {
                            const out = await run(
                              () =>
                                api.patch<ExternalIdentity>(`/api/identities/${i.id}`, {
                                  user_id: e.target.value || null,
                                }),
                              e.target.value ? "已关联" : "已解除关联",
                            );
                            if (out) res.setData((prev) => prev?.map((x) => (x.id === i.id ? out : x)));
                          }}
                        >
                          <option value="">未关联</option>
                          {dir.users.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                              {u.email ? `（${u.email}）` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="还没有外部账号" hint="有人在平台上与机器人互动后，账号会出现在这里等待关联。" />
          )
        }
      </Loaded>
    </>
  );
}

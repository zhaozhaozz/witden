import { api } from "../api/client";
import type { Connection, ExternalIdentity } from "../api/types";
import { SYNC_MODE } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useDirectory } from "../lib/session";
import { useAction } from "../ui/feedback";
import { Empty, Field, FieldGroup, Loaded, MultiPick, Tag, Toggle } from "../ui/kit";

// Outcomes recorded by the server's inbound handler (integrations/inbound.ts).
export const INBOUND_STATUS: Record<string, [string, "ok" | "wait" | "off" | "bad"]> = {
  queued: ["等待处理", "wait"],
  processing: ["处理中", "wait"],
  dispatched: ["已交给角色", "ok"],
  not_assigned: ["没有交给角色", "bad"],
  stored: ["已同步（未 @ 机器人）", "ok"],
  ignored: ["已忽略（不在同步范围）", "off"],
  sync_off: ["会话不同步", "off"],
  connection_paused: ["接入已暂停", "off"],
  unknown_connection: ["接入不存在", "bad"],
  unlinked_user: ["账号未关联成员", "bad"],
  failed: ["处理失败", "bad"],
};

export interface InboundEvent {
  id: string;
  event_key: string;
  status: string;
  detail: string | null;
  received_at: string;
}

/** A connection's settings as edited in the console. */
export interface ConnSettings {
  auto_provision_users: boolean;
  external_role_ids: string[];
  custom_identity: boolean;
  default_sync_mode: "mentions" | "all" | "off";
}

export const settingsOf = (conn: Connection | null): ConnSettings => ({
  auto_provision_users: !!conn?.settings?.auto_provision_users,
  external_role_ids: conn?.settings?.external_role_ids ?? [],
  custom_identity: !!conn?.settings?.custom_identity,
  default_sync_mode: conn?.settings?.default_sync_mode ?? "mentions",
});

/** Who may use the bot, what gets synced and how roles appear; shared by the connection form and setup guides. */
export function ConnectionSettingsFields({
  platform,
  value,
  onChange,
}: {
  platform: string;
  value: ConnSettings;
  onChange: (next: ConnSettings) => void;
}) {
  const dir = useDirectory();
  const set = (patch: Partial<ConnSettings>) => onChange({ ...value, ...patch });
  return (
    <>
      <Field label="新会话默认同步范围" hint="接入平台不等于导入全部消息；每个会话之后还可以单独调整。">
        <select
          value={value.default_sync_mode}
          onChange={(e) => set({ default_sync_mode: e.target.value as ConnSettings["default_sync_mode"] })}
        >
          {Object.entries(SYNC_MODE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Toggle
        checked={value.auto_provision_users}
        onChange={(v) => set({ auto_provision_users: v })}
        label="允许未关联的人使用：自动建为外部成员（不登录控制台，私信彼此隔离）"
      />
      {value.auto_provision_users ? (
        <FieldGroup label="外部成员可以使用的角色" hint="外部成员只能使用这里选中的角色。">
          <MultiPick
            columns={3}
            options={dir.roles
              .filter((r) => r.status === "active")
              .map((r) => ({ value: r.id, label: `${r.name} @${r.handle}` }))}
            value={value.external_role_ids}
            onChange={(ids) => set({ external_role_ids: ids })}
            empty="还没有可用的角色"
          />
        </FieldGroup>
      ) : null}
      {platform !== "github" ? (
        <Toggle
          checked={value.custom_identity}
          onChange={(v) => set({ custom_identity: v })}
          label="以角色自己的名称和头像发送消息（Slack 需要 chat:write.customize）"
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

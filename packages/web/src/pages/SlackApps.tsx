import { useState } from "react";
import { api } from "../api/client";
import type { SlackApp } from "../api/types";
import { fmtRelative } from "../lib/format";
import { useChanged, useUnsavedChanges } from "../lib/unsaved";
import { useAction, useFeedback } from "../ui/feedback";
import { CopyText, Field, KV, Section, Tag } from "../ui/kit";
import { lastRejected, SLACK_FIELD_HELP, socketText } from "./connectionParts";

const modeText = (a: SlackApp) => (a.slack_mode === "socket" ? "Socket Mode（不需要公网地址）" : "事件地址（HTTP）");

/**
 * A Slack app, above the workspaces it is installed in: how it connects to Slack (shared by all of them), where
 * it is installed, its keys. Deleting a workspace leaves the app; the app can be deleted once it has none.
 */
export function SlackAppDetail({
  app,
  onChanged,
  onDeleted,
  onInstall,
  onOpenWorkspace,
}: {
  app: SlackApp;
  onChanged: (a: SlackApp) => void;
  onDeleted: () => void;
  onInstall: () => void;
  onOpenWorkspace: (connectionId: string) => void;
}) {
  const { confirm } = useFeedback();
  const { run, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const rejected = lastRejected(app);
  const inUse = app.workspaces.length > 0;

  if (editing)
    return (
      <div className="conn-detail">
        <Section title={`编辑 Slack 应用 ${app.name}`}>
          <SlackAppForm
            app={app}
            onCancel={() => setEditing(false)}
            onSaved={(a) => {
              setEditing(false);
              onChanged(a);
            }}
          />
        </Section>
      </div>
    );

  return (
    <div className="conn-detail">
      <Section
        title={
          <span>
            {app.name} <Tag>Slack 应用</Tag>
          </span>
        }
        actions={
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={onInstall}>
              安装到其他工作区
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
              编辑
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger-ghost"
              disabled={busy || inUse}
              title={inUse ? "先删除这个应用的所有工作区接入" : undefined}
              onClick={async () => {
                const ok = await confirm({
                  title: `删除 Slack 应用 ${app.name}`,
                  body: (
                    <p>删除后 witden 不再使用这个应用的令牌。Slack 中的应用本身不受影响，需要时在 Slack 中删除。</p>
                  ),
                  confirmLabel: "删除",
                  danger: true,
                });
                if (!ok) return;
                const out = await run(() => api.del(`/api/slack-apps/${app.id}`), "应用已删除");
                if (out) onDeleted();
              }}
            >
              删除应用
            </button>
          </div>
        }
      >
        <p className="small muted">
          一个 Slack 应用可以安装到多个工作区，每个工作区是它下面的一个接入，有自己的频道、私信、关联的账号和默认处理的
          AI 员工。应用的令牌和与 Slack
          的连接由所有工作区共用；删除某个工作区的接入，不影响应用和它的其他工作区。应用在没有工作区之后才能删除。
        </p>
        {rejected ? (
          <div className="callout callout-bad" role="alert">
            {fmtRelative(rejected.at)}，witden 收到了 Slack 发来的请求，但校验没有通过：{rejected.reason}。请检查应用的
            Signing Secret 是否与 Slack 中的一致，可以点击“编辑”重新填写。
          </div>
        ) : null}
        <KV
          items={[
            [
              "Slack 应用 ID",
              app.app_id ? <code className="id">{app.app_id}</code> : <span className="muted">安装到工作区后获取</span>,
            ],
            ["接入方式", modeText(app)],
            app.slack_mode === "socket"
              ? [
                  "与 Slack 的连接",
                  <Tag key="socket" tone={inUse ? socketText(app.socket, "slack").tone : "off"}>
                    {inUse ? socketText(app.socket, "slack").text : "未连接：还没有安装到工作区"}
                  </Tag>,
                ]
              : ["事件地址", <CopyText key="url" text={app.events_url} />],
            [
              "安装到其他工作区",
              app.slack_oauth ? (
                "已保存 Client ID 和 Client Secret"
              ) : (
                <span className="muted">还没有保存 Client ID 和 Client Secret（在安装引导中填写）</span>
              ),
            ],
            [
              "工作区",
              inUse ? (
                <ul className="plain-list">
                  {app.workspaces.map((w) => (
                    <li key={w.id}>
                      <button type="button" className="btn btn-xs" onClick={() => onOpenWorkspace(w.id)}>
                        {w.name}
                      </button>{" "}
                      <span className="muted small">
                        {w.team_id ?? "还没有测试"}
                        {w.status === "paused" ? "，已暂停" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted">没有。点击“安装到其他工作区”安装，或删除这个应用。</span>
              ),
            ],
          ]}
        />
      </Section>
    </div>
  );
}

/** Rename an app or change its keys; what is left empty stays. */
function SlackAppForm({
  app,
  onCancel,
  onSaved,
}: {
  app: SlackApp;
  onCancel: () => void;
  onSaved: (a: SlackApp) => void;
}) {
  const { run, busy } = useAction();
  const [name, setName] = useState(app.name);
  const [mode, setMode] = useState(app.slack_mode);
  const [secret, setSecret] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const switching = mode !== app.slack_mode;
  const key = mode === "socket" ? "app_token" : "signing_secret";
  const ready = !!name.trim() && (!switching || !!secret.trim());
  const [changed] = useChanged({ name, mode, secret, clientId, clientSecret });

  const save = async (): Promise<boolean> => {
    if (!ready) return false;
    const credentials = Object.fromEntries(
      Object.entries({ [key]: secret.trim(), client_id: clientId.trim(), client_secret: clientSecret.trim() }).filter(
        ([, v]) => v,
      ),
    );
    const out = await run(
      () =>
        api.patch<SlackApp>(`/api/slack-apps/${app.id}`, {
          name: name.trim(),
          ...(Object.keys(credentials).length ? { credentials } : {}),
        }),
      "已保存",
    );
    if (out) onSaved(out);
    return !!out;
  };
  useUnsavedChanges(changed, save);

  return (
    <form
      className="form form-narrow"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void save();
      }}
    >
      <Field label="名称" hint="在 witden 中区分不同的 Slack 应用。">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        label="接入方式"
        hint={
          switching
            ? `改用${mode === "socket" ? " Socket Mode" : "事件地址"}后，所有工作区都按新的方式接收消息；原来的${mode === "socket" ? " Signing Secret" : " App-Level Token"} 会被删除。也要在 Slack 应用中做相应的修改（设置引导中有说明）。`
            : "所有工作区共用。"
        }
      >
        <select value={mode} onChange={(e) => setMode(e.target.value as SlackApp["slack_mode"])}>
          <option value="socket">Socket Mode（不需要公网地址）</option>
          <option value="http">事件地址（HTTP）</option>
        </select>
      </Field>
      <Field
        label={mode === "socket" ? "App-Level Token" : "Signing Secret"}
        description={SLACK_FIELD_HELP[key]}
        hint={switching ? undefined : "留空保持不变"}
      >
        <input
          type="password"
          className="mono"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </Field>
      <Field
        label="Client ID"
        hint={
          app.slack_oauth ? "已保存，留空保持不变" : "安装到其他工作区时需要，在 Basic Information → App Credentials 中"
        }
      >
        <input className="mono" autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </Field>
      <Field label="Client Secret" hint={app.slack_oauth ? "已保存（不可查看），留空保持不变" : undefined}>
        <input
          type="password"
          className="mono"
          autoComplete="off"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </Field>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
          保存
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

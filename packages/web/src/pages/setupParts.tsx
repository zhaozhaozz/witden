/**
 * Building blocks of the in-page setup guides (Slack, GitHub, Feishu): the numbered steps, live checks of what
 * the platform sent to witden, choosing the role the bot stands for, and trying the bot out.
 */
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Connection, Role } from "../api/types";
import { fmtRelative } from "../lib/format";
import { useDirectory } from "../lib/session";
import { useUnsavedChanges } from "../lib/unsaved";
import { useAction } from "../ui/feedback";
import { Tag } from "../ui/kit";
import {
  ConnectionSettingsFields,
  Identities,
  INBOUND_STATUS,
  type InboundEvent,
  lastRejected,
  settingsOf,
} from "./connectionParts";

/** Which step of a guide is open and how far the person has got. */
export function useSteps<K extends string>(flow: K[], start: K) {
  const [step, setStep] = useState<K>(start);
  const [reached, setReached] = useState(Math.max(0, flow.indexOf(start)));
  return {
    step,
    setStep,
    reached,
    setReached,
    go: (k: K) => {
      setStep(k);
      setReached((r) => Math.max(r, flow.indexOf(k)));
    },
    /** A step's number, for texts that point at another step. */
    num: (k: K) => flow.indexOf(k) + 1,
  };
}

/**
 * The numbered steps: done ones show their summary and can be reopened; only the open one shows its body.
 * ``unlocked``: steps beyond the furthest reached that may be opened anyway (once the credentials work).
 */
export function SetupSteps<K extends string>({
  flow,
  step,
  reached,
  title,
  summary,
  body,
  unlocked,
  onOpen,
}: {
  flow: K[];
  step: K;
  reached: number;
  title: (k: K) => string;
  summary: Partial<Record<K, string>>;
  body: Partial<Record<K, ReactNode>>;
  unlocked?: (k: K, index: number) => boolean;
  onOpen: (k: K) => void;
}) {
  const at = flow.indexOf(step);
  return (
    <ol className="setup-steps">
      {flow.map((key, i) => {
        const state = key === step ? "current" : i < reached ? "done" : "todo";
        const open = i !== at && (i <= reached || unlocked?.(key, i)) ? () => onOpen(key) : undefined;
        return (
          <li key={key} className={`setup-step setup-${state}`}>
            <button type="button" className="setup-head" disabled={!open} onClick={open}>
              <span className="setup-num" aria-hidden>
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className="setup-title">{title(key)}</span>
              {state === "done" && summary[key] ? <span className="setup-summary">{summary[key]}</span> : null}
            </button>
            {state === "current" ? <div className="setup-body">{body[key]}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The connection as the server has it now, refreshed every few seconds while the step showing it is open. */
export function useLiveConnection(initial: Connection, ms = 3000): Connection {
  const [conn, setConn] = useState(initial);
  useEffect(() => {
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const fresh = (await api.get<Connection[]>("/api/connections")).find((c) => c.id === initial.id);
        if (fresh && !stopped) setConn(fresh);
      } catch {
        // the next poll retries
      }
    }, ms);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [initial.id, ms]);
  return conn;
}

/**
 * What the platform's latest calls to the events URL came to: refused (and why), accepted, or nothing yet.
 * ``since``: ignore what happened before (a call made before witden held the secret it is signed with).
 */
export function WebhookStatus({
  conn,
  platform,
  since,
  idle,
  accepted,
  fix,
}: {
  conn: Connection;
  platform: string;
  since?: string | null;
  idle: ReactNode;
  accepted: (at: string) => ReactNode;
  /** What to check when a call was refused (and a way to correct the secret). */
  fix?: ReactNode;
}) {
  const after = (at: string | null | undefined) => !!at && (!since || at > since);
  const rejected = lastRejected(conn);
  const ok = [conn.webhook?.verified_at, conn.webhook?.received_at].filter(after).sort().at(-1);
  if (rejected && after(rejected.at))
    return (
      <div className="callout callout-bad" role="alert">
        {fmtRelative(rejected.at)}，witden 收到了{spaced(platform)}的请求，但校验没有通过：{rejected.reason}。{fix}
      </div>
    );
  if (ok) return <div className="callout">{accepted(ok)}</div>;
  return <div className="small muted setup-events">{idle}</div>;
}

/** Chinese text puts a space around Latin words: pads ``t`` on the sides where it is Latin ("Slack", not "飞书"). */
export const spaced = (t: string) => `${/^[A-Za-z0-9]/.test(t) ? " " : ""}${t}${/[A-Za-z0-9]$/.test(t) ? " " : ""}`;

/** A random secret for the platform and witden to share (webhook secrets). */
export function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Why a role cannot take work yet (the dispatcher refuses roles without a computer or a model). */
function missingSetup(r: Role): string | undefined {
  const missing = [r.instance_id ? null : "分配电脑", r.model_config_id ? null : "配置模型"].filter(Boolean);
  return missing.length ? `还没有${missing.join("和")}，暂时不能工作` : undefined;
}

/** Choose the role the bot stands for (the default of its conversations), and who may use it. */
export function AccessStep({
  conn,
  intro,
  account,
  onSaved,
}: {
  conn: Connection;
  /** What one bot is on this platform (one Slack app, one GitHub App …). */
  intro: ReactNode;
  /** The platform's accounts, e.g. "Slack 账号". */
  account: string;
  onSaved: (c: Connection) => void;
}) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const [settings, setSettings] = useState(settingsOf(conn));
  // A system administrator works only in the console, never as a bot.
  const roles = dir.roles.filter((r) => !r.system_admin && (r.status === "active" || r.id === settings.role_id));

  const save = async (): Promise<boolean> => {
    if (!settings.role_id) return false;
    const out = await run(() => api.patch<Connection>(`/api/connections/${conn.id}`, { settings }), "已保存");
    if (out) onSaved(out);
    return !!out;
  };
  useUnsavedChanges(JSON.stringify(settings) !== JSON.stringify(settingsOf(conn)), save);

  return (
    <>
      <p>{intro}</p>
      <div className="pick setup-roles" role="radiogroup" aria-label="机器人代表的 AI 员工">
        {roles.length ? (
          roles.map((r) => (
            <label key={r.id} className={`pick-item${settings.role_id === r.id ? " pick-on" : ""}`}>
              <input
                type="radio"
                name="bot-role"
                checked={settings.role_id === r.id}
                onChange={() => setSettings({ ...settings, role_id: r.id })}
              />
              <span className="pick-text">
                <span>
                  {r.name} @{r.handle}
                </span>
                {missingSetup(r) ? <span className="pick-hint">{missingSetup(r)}</span> : null}
              </span>
            </label>
          ))
        ) : (
          <span className="muted small">
            还没有可用的 AI 员工，请先在<Link to="/roles">AI 员工管理</Link>中创建。
          </span>
        )}
      </div>
      <p className="small muted">
        机器人所在会话默认由这位 AI 员工处理，对外以机器人的身份发言；之后单个会话可以在话题设置中改由其他 AI 员工处理。
      </p>
      <h3 className="setup-sub">谁可以使用</h3>
      <p className="small muted">
        默认只有把{spaced(account)}关联到 witden
        管理员账号的人可以使用（最后一步可以直接关联你自己的账号）。要让其他人也能使用，开启“允许未关联的人使用”。
      </p>
      <div className="form form-narrow">
        <ConnectionSettingsFields
          platform={conn.platform}
          value={settings}
          onChange={setSettings}
          chooseRole={false}
          botLimit={conn.bot_request_limit}
        />
      </div>
      <div className="setup-next">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !settings.role_id}
          onClick={() => void save()}
        >
          保存，下一步
        </button>
        {settings.role_id ? null : <span className="small muted">选择一位 AI 员工后继续。</span>}
      </div>
    </>
  );
}

/**
 * Send the bot a message on the platform and watch what witden made of it (every 3 seconds), with what to do
 * when it was not handed to the role.
 */
export function TryStep({
  conn: initial,
  platform,
  steps,
  where,
  idle,
  accessStep,
  header,
  footer,
  onDone,
}: {
  conn: Connection;
  /** The platform's name in texts ("Slack"). */
  platform: string;
  /** What to do on the platform, as list items. */
  steps: ReactNode;
  /** Where the role answers ("提问的地方（频道里或 thread 里）"). */
  where: string;
  /** What to check while nothing arrives. */
  idle: string;
  /** The number of the step choosing the role and who may use the bot. */
  accessStep: number;
  header?: (conn: Connection) => ReactNode;
  footer?: (events: InboundEvent[] | null) => ReactNode;
  onDone: () => void;
}) {
  const [events, setEvents] = useState<InboundEvent[] | null>(null);
  const [conn, setConn] = useState(initial);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const [rows, all] = await Promise.all([
          api.get<InboundEvent[]>(`/api/connections/${initial.id}/inbound`),
          api.get<Connection[]>("/api/connections"),
        ]);
        if (stopped) return;
        setEvents(rows);
        const fresh = all.find((c) => c.id === initial.id);
        if (fresh) setConn(fresh);
      } catch {
        // keep the last list; the next poll retries
      }
    };
    void load();
    const timer = window.setInterval(load, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [initial.id]);
  const recent = (events ?? []).slice(0, 5);
  // What to do next depends on how the latest message was handled.
  const latest = recent[0];
  const on = spaced(platform);

  return (
    <>
      {header?.(conn)}
      <ol className="setup-list">
        {steps}
        <li>回到这里查看 witden 收到的消息和处理结果（每 3 秒刷新）。</li>
      </ol>
      <div className="setup-events">
        {events === null ? (
          <span className="muted small">正在读取…</span>
        ) : recent.length ? (
          <ul className="plain-list">
            {recent.map((e) => (
              <li key={e.id}>
                <span className="muted small">{fmtRelative(e.received_at)}</span>{" "}
                <Tag tone={INBOUND_STATUS[e.status]?.[1] ?? "info"}>{INBOUND_STATUS[e.status]?.[0] ?? e.status}</Tag>
                {e.detail ? <span className="small muted"> {e.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted small">还没有收到消息。发了消息后这里一直没有变化时，{idle}</span>
        )}
      </div>
      {latest?.status === "dispatched" ? (
        <div className="callout">已交给 AI 员工处理。AI 员工会在{where}回复，也可以在 witden 的会话列表中查看。</div>
      ) : null}
      {latest?.status === "not_assigned" ? (
        <div className="callout callout-wait">
          witden 收到了请求，但没有交给 AI 员工：{latest.detail}。常见原因是处理会话的 AI 员工还没有分配电脑或模型（在
          <Link to="/roles">AI 员工管理</Link>中设置），或者这个接入还没有选择 AI 员工（第 {accessStep} 步）。
          {`处理后在${on}中再发一次；${on}中提问的地方也会收到这条说明。`}
        </div>
      ) : null}
      {latest?.status === "stored" ? (
        <div className="callout">这条消息没有 @ 机器人：witden 记录了它，但只有 @ 机器人的消息才交给 AI 员工。</div>
      ) : null}
      {latest?.status === "unlinked_user" ? (
        <>
          <div className="callout callout-wait">
            {`发消息的${on}账号还没有关联 witden 账号，所以没有交给 AI 员工。在下面把你自己的${on}账号关联到你的 witden 账号，然后在${on}中再发一次；其他人可以在第 ${accessStep} 步开启“允许未关联的人使用”。`}
          </div>
          <Identities key={events?.length} conn={conn} />
        </>
      ) : null}
      {footer?.(events)}
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          完成
        </button>
      </div>
    </>
  );
}

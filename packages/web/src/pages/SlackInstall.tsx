import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api/client";
import type { Connection, SlackApp } from "../api/types";
import { useAction } from "../ui/feedback";
import { CopyText, Field, Section } from "../ui/kit";
import { PublicAddressStep } from "./PublicAddress";
import { BOT_SCOPES, SlackTryStep } from "./SlackSetup";
import { AccessStep, SetupSteps, useSteps } from "./setupParts";

type Method = "public" | "manual";
type StepKey = "app" | "client" | "callback" | "distribute" | "install" | "access" | "try";

const STEP_TITLES: Record<StepKey, string> = {
  app: "选择要安装的应用",
  client: "填写应用的 Client ID 和 Client Secret",
  callback: "选择完成安装的方式",
  distribute: "在 Slack 中添加回调地址并开放安装",
  install: "安装到工作区",
  access: "选择机器人代表的 AI 员工",
  try: "在 Slack 中试一试",
};

const FLOW: StepKey[] = ["app", "client", "callback", "distribute", "install", "access", "try"];

/** Where the browser goes when there is no public address: any HTTPS address will do; it need not open. */
export const MANUAL_REDIRECT = "https://localhost/witden/slack-install";

interface Started {
  client_id: string;
  redirect_uri: string;
  state: string;
}

/** Slack's authorize page for this app, asking for the scopes its manifest has. */
function authorizeUrl(s: Started): string {
  const q = new URLSearchParams({
    client_id: s.client_id,
    scope: BOT_SCOPES.map(([scope]) => scope).join(","),
    redirect_uri: s.redirect_uri,
    state: s.state,
  });
  return `https://slack.com/oauth/v2/authorize?${q.toString()}`;
}

const modeText = (a: SlackApp) => (a.slack_mode === "socket" ? "Socket Mode" : "事件地址");

/**
 * Install a Slack app witden already has (a connection holding it) in another workspace, via Slack's OAuth:
 * its client id and secret, a redirect address (the public address, which completes the installation by
 * itself, or any HTTPS address whose final URL is pasted back), Slack's distribution settings, the install
 * link, then the new workspace's role and a try. ``installed`` resumes a workspace installed this way.
 */
export function SlackInstall({
  apps,
  app: initialApp,
  installed,
  header,
  onInstalled,
  onClose,
}: {
  /** Slack connections holding an app. */
  apps: SlackApp[];
  app?: SlackApp | null;
  /** A workspace installed this way, to continue with. */
  installed?: Connection | null;
  header?: ReactNode;
  onInstalled: (c: Connection) => void;
  onClose: (c: Connection | null) => void;
}) {
  const [app, setApp] = useState<SlackApp | null>(
    initialApp ?? apps.find((a) => a.id === installed?.slack_app?.id) ?? (apps.length === 1 ? apps[0] : null),
  );
  const [conn, setConn] = useState<Connection | null>(installed ?? null);
  const [method, setMethod] = useState<Method>("public");
  const [redirect, setRedirect] = useState<string | null>(null);
  const start: StepKey = installed ? "access" : app ? (app.slack_oauth ? "callback" : "client") : "app";
  const { step, setStep, reached, go, num } = useSteps(FLOW, start);

  const refreshApp = async (id: string) => {
    const fresh = (await api.get<SlackApp[]>("/api/slack-apps")).find((a) => a.id === id);
    if (fresh) setApp(fresh);
    return fresh ?? null;
  };

  const body: Partial<Record<StepKey, ReactNode>> = {
    app: (
      <PickApp
        apps={apps}
        value={app}
        onPick={(a) => {
          setApp(a);
          go(a.slack_oauth ? "callback" : "client");
        }}
      />
    ),
    client: app ? (
      <ClientStep
        app={app}
        onSaved={async () => {
          await refreshApp(app.id);
          go("callback");
        }}
      />
    ) : null,
    callback: app ? (
      <CallbackStep
        app={app}
        method={method}
        onMethod={setMethod}
        onReady={(uri) => {
          setRedirect(uri);
          go("distribute");
        }}
      />
    ) : null,
    distribute: redirect ? <DistributeStep redirect={redirect} onNext={() => go("install")} /> : null,
    install:
      app && redirect ? (
        <InstallStep
          app={app}
          method={method}
          redirect={redirect}
          num={num}
          onInstalled={(c) => {
            setConn(c);
            onInstalled(c);
            go("access");
          }}
        />
      ) : null,
    access: conn ? (
      <AccessStep
        conn={conn}
        intro={`这是应用在工作区「${conn.name}」中的机器人，默认代表与应用的第一个工作区相同的 AI 员工。选择它在这个工作区代表 witden 中的哪位 AI 员工：这里发给机器人的消息都交给这位 AI 员工处理。`}
        account="Slack 账号"
        onSaved={(c) => {
          setConn(c);
          go("try");
        }}
      />
    ) : null,
    try: conn ? (
      <SlackTryStep
        conn={conn}
        bot={null}
        accessStep={num("access")}
        idle={`检查应用「${app?.name ?? ""}」的事件地址是否仍然有效：这个工作区的事件也发到那里。`}
        onDone={() => onClose(conn)}
      />
    ) : null,
  };
  const summary: Partial<Record<StepKey, string>> = {
    app: app ? `应用：${app.name}（${modeText(app)}）` : undefined,
    client: app?.slack_oauth ? "已保存（不可查看）" : undefined,
    callback: redirect ? (method === "public" ? "公网地址自动完成" : "手动粘贴安装结果") : undefined,
    distribute: redirect ? `回调地址：${redirect}` : undefined,
    install: conn ? `已安装到工作区「${conn.name}」` : undefined,
  };

  return (
    <Section
      title="把 Slack 应用安装到另一个工作区"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => onClose(conn)}>
          {conn ? "稍后继续" : "取消"}
        </button>
      }
    >
      {header}
      <p className="setup-intro">
        一个 Slack
        应用可以安装到多个工作区（例如不同的组织），不需要为每个工作区各建一个应用。每个工作区是应用下的一个接入，有自己的频道、私信、关联的账号和机器人代表的
        AI 员工；应用的令牌和与 Slack 的连接由它的所有工作区共用，删除任何一个工作区都不影响应用和其他工作区。安装用的是
        Slack 的 OAuth：安装的人在 Slack 中确认后，witden 换取这个工作区的机器人令牌。
      </p>
      <SetupSteps
        flow={FLOW}
        step={step}
        reached={reached}
        title={(k) => STEP_TITLES[k]}
        summary={summary}
        body={body}
        // Once installed, its own steps can be opened again.
        unlocked={(k) => !!conn && (k === "access" || k === "try")}
        onOpen={setStep}
      />
    </Section>
  );
}

function PickApp({ apps, value, onPick }: { apps: SlackApp[]; value: SlackApp | null; onPick: (a: SlackApp) => void }) {
  const [picked, setPicked] = useState<SlackApp | null>(value);
  if (!apps.length) return <p className="muted">还没有 Slack 应用：先用“新建一个 Slack 应用”接入一个工作区。</p>;
  return (
    <>
      <p>选择要安装到另一个工作区的 Slack 应用。</p>
      <div className="pick setup-roles" role="radiogroup" aria-label="Slack 应用">
        {apps.map((a) => (
          <label key={a.id} className={`pick-item${picked?.id === a.id ? " pick-on" : ""}`}>
            <input type="radio" name="slack-app" checked={picked?.id === a.id} onChange={() => setPicked(a)} />
            <span className="pick-text">
              <span>{a.name}</span>
              <span className="pick-hint">
                {modeText(a)}
                {a.workspaces.length
                  ? `，已安装到 ${a.workspaces.map((x) => x.name).join("、")}`
                  : "，还没有安装到工作区"}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="setup-next">
        <button type="button" className="btn btn-primary" disabled={!picked} onClick={() => picked && onPick(picked)}>
          下一步
        </button>
      </div>
    </>
  );
}

function ClientStep({ app, onSaved }: { app: SlackApp; onSaved: () => Promise<void> }) {
  const { run, busy } = useAction();
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const oddId = !!id.trim() && !/^\d+\.\d+$/.test(id.trim());
  const ready = app.slack_oauth ? !oddId : !!id.trim() && !!secret.trim() && !oddId;

  const save = async () => {
    const credentials = Object.fromEntries(
      Object.entries({ client_id: id.trim(), client_secret: secret.trim() }).filter(([, v]) => v),
    );
    if (Object.keys(credentials).length) {
      const out = await run(() => api.patch<SlackApp>(`/api/slack-apps/${app.id}`, { credentials }), "已保存");
      if (!out) return;
    }
    await onSaved();
  };

  return (
    <>
      <p>
        安装到其他工作区要用应用的 OAuth 凭据。在应用的设置页面（api.slack.com/apps → 选择应用「{app.name}」）的{" "}
        <b>Basic Information → App Credentials</b> 中复制 <b>Client ID</b> 和 <b>Client Secret</b>（点击 Show
        后复制）。witden 加密保存它们，保存后不能再查看。
      </p>
      <div className="form form-narrow">
        <Field
          label="Client ID"
          hint={
            oddId ? (
              <span className="text-wait">Client ID 是用点隔开的两串数字，例如 1234567890.1234567890。</span>
            ) : app.slack_oauth ? (
              "已保存，留空保持不变"
            ) : undefined
          }
        >
          <input className="mono" autoComplete="off" value={id} onChange={(e) => setId(e.target.value)} />
        </Field>
        <Field label="Client Secret" hint={app.slack_oauth ? "已保存（不可查看），留空保持不变" : undefined}>
          <input
            type="password"
            className="mono"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
      </div>
      <div className="setup-next">
        <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={() => void save()}>
          保存，下一步
        </button>
      </div>
    </>
  );
}

function CallbackStep({
  app,
  method,
  onMethod,
  onReady,
}: {
  app: SlackApp;
  method: Method;
  onMethod: (m: Method) => void;
  onReady: (redirect: string) => void;
}) {
  const { run, busy } = useAction();
  const [address, setAddress] = useState(MANUAL_REDIRECT);
  const [error, setError] = useState<string | null>(null);

  // The server checks the address (HTTPS) and says which it will use.
  const check = async (m: Method) => {
    setError(null);
    try {
      const out = await api.post<Started>(`/api/slack-apps/${app.id}/install`, {
        method: m,
        ...(m === "manual" ? { redirect_uri: address.trim() } : {}),
      });
      onReady(out.redirect_uri);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <p>
        在 Slack 中确认安装后，Slack 会把安装人的浏览器带到一个回调地址，带着一次性的安装代码（10 分钟内有效）。Slack
        要求这个地址使用 HTTPS，但不会自己访问它，所以有两种方式：
      </p>
      <div className="setup-modes">
        <div className="segmented">
          {(
            [
              ["public", "公网地址，自动完成（推荐）"],
              ["manual", "没有公网地址：手动粘贴"],
            ] as [Method, string][]
          ).map(([m, label]) => (
            <button
              type="button"
              key={m}
              className={m === method ? "seg seg-on" : "seg"}
              onClick={() => {
                onMethod(m);
                setError(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {method === "public" ? (
        <>
          <p className="small">
            回调地址是 witden 的公网事件地址下的一个页面，安装后 witden
            自动完成，安装人看到“已安装”的提示即可；其他组织的管理员也能在自己的电脑上完成安装。这个页面只接收安装结果，控制台仍然不对外开放。需要一个
            HTTPS 公网地址：
          </p>
          <PublicAddressStep onNext={() => void check("public")} />
        </>
      ) : (
        <>
          <p className="small">
            回调地址填任意一个 HTTPS
            地址，不需要能打开。安装后浏览器会停在一个打不开的页面，这是正常的：把地址栏中的完整地址复制回 witden，10
            分钟内有效。适合没有公网地址的部署；安装要由你本人，或能把这个地址交回给你的人完成。
          </p>
          <div className="form form-narrow">
            <Field
              label="回调地址"
              hint="默认地址指向安装人自己的电脑（localhost），安装代码不会发到别处。也可以填你自己域名下的任意 HTTPS 地址；它要与 Slack 应用中添加的 Redirect URL 一致。"
            >
              <input className="mono" value={address} onChange={(e) => setAddress(e.target.value)} />
            </Field>
          </div>
          <div className="setup-next">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !address.trim()}
              onClick={() => void run(() => check("manual"))}
            >
              下一步
            </button>
          </div>
        </>
      )}
      {error ? (
        <div className="callout callout-bad" role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
}

function DistributeStep({ redirect, onNext }: { redirect: string; onNext: () => void }) {
  return (
    <>
      <p>在应用的设置页面（api.slack.com/apps → 选择应用）中做两件事：</p>
      <div className="setup-field">
        <span className="field-label">回调地址（Redirect URL）</span>
        <CopyText text={redirect} />
      </div>
      <ol className="setup-list">
        <li>
          左侧打开 <b>OAuth &amp; Permissions</b>，在 <b>Redirect URLs</b> 中点击 <b>Add New Redirect URL</b>
          ，粘贴上面的地址，点击 <b>Add</b>，再点击 <b>Save URLs</b>。
        </li>
        <li>
          左侧打开 <b>Manage Distribution</b>，在 <b>Share Your App with Other Workspaces</b> 中确认各项已打勾（展开{" "}
          <b>Remove Hard Coded Information</b> 勾选确认），点击 <b>Activate Public Distribution</b>
          。只装到应用所在的工作区时不需要这一步。
        </li>
      </ol>
      <div className="callout">
        开放安装（Public Distribution）不是上架 Slack Marketplace：只有拿到安装链接的人才能安装。Socket Mode
        的应用不能上架 Marketplace，但可以这样安装到其他工作区。
      </div>
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          已添加回调地址并开放安装，下一步
        </button>
      </div>
    </>
  );
}

function InstallStep({
  app,
  method,
  redirect,
  num,
  onInstalled,
}: {
  app: SlackApp;
  method: Method;
  redirect: string;
  num: (k: StepKey) => number;
  onInstalled: (c: Connection) => void;
}) {
  const { run, busy } = useAction();
  const [started, setStarted] = useState<Started | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  // What the app's workspaces looked like when this step opened: a new or reinstalled one is the result.
  const before = useRef<Map<string, string | undefined> | null>(null);

  const begin = useCallback(async () => {
    setError(null);
    try {
      const out = await api.post<Started>(`/api/slack-apps/${app.id}/install`, {
        method,
        ...(method === "manual" ? { redirect_uri: redirect } : {}),
      });
      const rows = await api.get<Connection[]>("/api/connections");
      before.current = new Map(rows.filter((c) => c.slack_app?.id === app.id).map((c) => [c.id, c.updated_at]));
      setStarted(out);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [app.id, method, redirect]);

  useEffect(() => {
    void begin();
  }, [begin]);

  // Public: the callback completes the installation; notice the workspace it added or updated.
  useEffect(() => {
    if (method !== "public" || !started) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const rows = await api.get<Connection[]>("/api/connections");
        const seen = before.current;
        const done = rows.find(
          (c) => c.slack_app?.id === app.id && (!seen?.has(c.id) || seen.get(c.id) !== c.updated_at),
        );
        if (done && !stopped) onInstalled(done);
      } catch {
        // the next poll retries
      }
    }, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [method, started, app.id, onInstalled]);

  const complete = async () => {
    const out = await run(() =>
      api.post<Connection>(`/api/slack-apps/${app.id}/install/complete`, { url: pasted.trim() }),
    );
    if (out) onInstalled(out);
  };

  if (!started)
    return error ? (
      <div className="callout callout-bad" role="alert">
        没能开始安装：{error}{" "}
        <button type="button" className="btn btn-xs" onClick={() => void begin()}>
          重试
        </button>
      </div>
    ) : (
      <p className="muted">正在准备安装链接…</p>
    );
  const link = authorizeUrl(started);
  return (
    <>
      <ol className="setup-list">
        <li>
          点击{" "}
          <a className="btn btn-sm btn-primary" href={link} target="_blank" rel="noreferrer">
            打开安装页面 ↗
          </a>
          。Slack 页面右上角显示要安装到的工作区：不是目标工作区时，从那里切换（需要先登录那个工作区）。
        </li>
        <li>
          确认应用申请的权限，点击 <b>Allow</b>。如果那个工作区要求审批，等管理员批准。
        </li>
        {method === "public" ? (
          <li>Slack 把浏览器带到 witden 的回调页面，显示“已安装到 Slack 工作区”；这里会自动进入下一步。</li>
        ) : (
          <li>浏览器停在一个打不开的页面（这是正常的）。把地址栏中的完整地址粘贴到下面，10 分钟内有效。</li>
        )}
      </ol>
      {method === "public" ? (
        <>
          <div className="setup-field">
            <span className="field-label">安装链接（30 分钟内有效，可以发给对方工作区的管理员）</span>
            <CopyText text={link} />
          </div>
          <div className="small muted setup-events">正在等待安装完成（每 3 秒检查一次）。</div>
        </>
      ) : (
        <div className="form">
          <Field label="浏览器停留的页面地址" hint={`以 ${redirect} 开头，带有 code= 和 state=。`}>
            <textarea
              rows={3}
              className="mono"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={`${redirect}?code=…&state=…`}
            />
          </Field>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !pasted.includes("code=")}
              onClick={() => void complete()}
            >
              {busy ? "正在完成安装…" : "完成安装"}
            </button>
          </div>
        </div>
      )}
      <details className="setup-more">
        <summary>可能遇到的问题</summary>
        <ul className="setup-list small">
          <li>
            <b>Slack 提示 redirect_uri 不匹配：</b>第 {num("distribute")} 步的回调地址没有添加到应用的 Redirect
            URLs，或添加后没有点 Save URLs。
          </li>
          <li>
            <b>Slack 提示应用不能安装到这个工作区：</b>应用还没有开放安装（Manage Distribution → Activate Public
            Distribution），或那个工作区限制了应用安装。
          </li>
          <li>
            <b>安装代码已失效：</b>代码只能用一次、10 分钟内有效；安装链接 30 分钟内有效。过期后{" "}
            <button type="button" className="btn btn-xs" onClick={() => void begin()}>
              重新生成安装链接
            </button>
            。
          </li>
        </ul>
      </details>
    </>
  );
}

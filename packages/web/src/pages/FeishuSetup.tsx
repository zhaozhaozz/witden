import { type ReactNode, useState } from "react";
import { api } from "../api/client";
import type { Connection } from "../api/types";
import { fmtRelative } from "../lib/format";
import { useAction } from "../ui/feedback";
import { CopyText, Field, Section } from "../ui/kit";
import { PublicAddressStep } from "./PublicAddress";
import { AccessStep, SetupSteps, TryStep, useLiveConnection, useSteps, WebhookStatus } from "./setupParts";

type StepKey = "address" | "app" | "credentials" | "events" | "publish" | "access" | "try";

const STEP_TITLES: Record<StepKey, string> = {
  address: "准备公网事件地址",
  app: "在飞书开放平台创建应用",
  credentials: "填写凭据并测试连接",
  events: "订阅消息事件",
  publish: "发布应用版本",
  access: "选择机器人代表的角色",
  try: "在飞书中试一试",
};

/** Feishu pushes events to the public events URL; settings take effect once a version is published. */
const FLOW: StepKey[] = ["address", "app", "credentials", "events", "publish", "access", "try"];

type StepNumber = (k: StepKey) => number;

/** The permissions witden's Feishu adapter uses: [scope, name in the Feishu console, what for]. */
const SCOPES: [string, string, string][] = [
  ["im:message.group_at_msg:readonly", "接收群聊中@机器人消息事件", "收到群里 @ 机器人的消息"],
  ["im:message.p2p_msg:readonly", "读取用户发给机器人的单聊消息", "收到发给机器人的私聊消息"],
  ["im:message:send_as_bot", "以应用的身份发消息", "发送角色的回复"],
  ["im:chat:readonly", "获取群组信息", "读取群成员，判断回复会被谁看到"],
];

const CONSOLE = "https://open.feishu.cn/app";

interface TestResult {
  ok: boolean;
  error?: string;
  bot?: string;
}

/** Feishu only delivers events to an HTTPS address it can reach. */
function reachable(url: string | null | undefined): boolean {
  try {
    const u = new URL(url ?? "");
    return (
      u.protocol === "https:" &&
      !/^(localhost|127\.|10\.|0\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname) &&
      !u.hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

/** Feishu's answers to the connection test, explained; the bot's own info works only once it is published. */
function explain(error: string, num: StepNumber): string {
  if (/auth failed/i.test(error)) return "App ID 或 App Secret 不正确，请在应用的“凭证与基础信息”页面重新复制。";
  if (/bot\/v3\/info/.test(error))
    return `凭据正确，但还读不到机器人：应用还没有开启机器人能力，或开启后还没有发布版本。可以先继续第 ${num("events")} 步，在第 ${num("publish")} 步发布版本后再测试。`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(error))
    return "witden 服务器连不上 open.feishu.cn，请检查服务器的网络或代理设置。";
  return "请检查凭据后重试。";
}

/**
 * Guided Feishu setup shown in the page itself: an internal app with the bot ability, its credentials, the
 * event subscription to the public events URL, and a published version. ``initial`` resumes an existing one.
 */
export function FeishuSetup({
  initial,
  onCreated,
  onClose,
}: {
  initial: Connection | null;
  onCreated: (c: Connection) => void;
  onClose: (c: Connection | null) => void;
}) {
  const [conn, setConn] = useState(initial);
  const start: StepKey = initial ? (initial.bot_user_id ? "access" : "events") : "address";
  const { step, setStep, reached, go, num } = useSteps(FLOW, start);
  const [address, setAddress] = useState<string | null>(null);
  const [bot, setBot] = useState<string | null>(null);

  const body: Partial<Record<StepKey, ReactNode>> = {
    address: (
      <PublicAddressStep
        onNext={(url) => {
          setAddress(url);
          go("app");
        }}
      />
    ),
    app: <AppStep num={num} onNext={() => go("credentials")} />,
    credentials: (
      <CredentialsStep
        conn={conn}
        num={num}
        onCreated={(c) => {
          setConn(c);
          onCreated(c);
        }}
        onSaved={setConn}
        onTested={(name) => {
          setBot(name);
          go("events");
        }}
        onLater={() => go("events")}
      />
    ),
    events: conn ? (
      <EventsStep conn={conn} num={num} onNext={() => go("publish")} onFix={() => setStep("credentials")} />
    ) : null,
    publish: conn ? (
      <PublishStep
        conn={conn}
        num={num}
        onTested={(c, name) => {
          setConn(c);
          setBot(name);
          go("access");
        }}
      />
    ) : null,
    access: conn ? (
      <AccessStep
        conn={conn}
        intro="一个飞书应用就是一个机器人。选择它代表 witden 中的哪个角色：群里 @ 它的消息和发给它的私聊消息都交给这个角色处理，回复以机器人的身份发出。需要多个角色时，为每个角色各建一个飞书应用（在 witden 中各是一个接入）。"
        account="飞书账号"
        onSaved={(c) => {
          setConn(c);
          go("try");
        }}
      />
    ) : null,
    try: conn ? (
      <TryStep
        conn={conn}
        platform="飞书"
        where="提问的消息串或私聊中"
        accessStep={num("access")}
        idle={`检查第 ${num("events")} 步的请求地址是否通过验证、是否添加了“接收消息”事件，以及第 ${num("publish")} 步的版本是否已经发布。`}
        steps={
          <>
            <li>
              在一个飞书群中打开 <b>群设置 → 群机器人 → 添加机器人</b>，选择这个应用。
            </li>
            <li>
              在群里发送 <code>@{bot ?? "机器人"} 你好</code>（输入 @
              后从列表中选择机器人）；也可以在飞书中搜索机器人的名称，直接给它发私聊消息。
            </li>
          </>
        }
        onDone={() => onClose(conn)}
      />
    ) : null,
  };
  const summary: Partial<Record<StepKey, string>> = {
    address: address ? `公网事件地址：${address}` : undefined,
    credentials: bot ? `机器人「${bot}」` : conn?.name,
    publish: bot ? `机器人「${bot}」已可以使用` : undefined,
  };

  return (
    <Section
      title="接入飞书"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => onClose(conn)}>
          {conn ? "稍后继续" : "取消"}
        </button>
      }
    >
      <p className="setup-intro">
        按下面 {FLOW.length} 步把飞书接入
        witden，需要飞书企业的应用开发权限（发布应用时可能需要企业管理员审核）。完成后，大家在群里 @
        机器人或私聊它，就能把工作交给 witden 中的角色：群里的一条消息连同它的回复（消息串）是 witden
        中的一个话题，角色在同一个消息串中回复；私聊是一个话题。飞书把消息推送到 witden
        的公网事件地址，所以先要准备一个公网地址。飞书接入目前为实验性，只同步文字消息。
      </p>
      <SetupSteps
        flow={FLOW}
        step={step}
        reached={reached}
        title={(k) => STEP_TITLES[k]}
        summary={summary}
        body={body}
        // The event subscription and publishing can be done before the bot itself answers the test.
        unlocked={(_k, i) => !!conn && i > FLOW.indexOf("credentials")}
        onOpen={setStep}
      />
    </Section>
  );
}

function AppStep({ num, onNext }: { num: StepNumber; onNext: () => void }) {
  return (
    <>
      <p>
        先在飞书开放平台为 witden 创建一个企业自建应用，并开启机器人能力。witden
        目前只支持飞书（open.feishu.cn），不支持 Lark 国际版。
      </p>
      <ol className="setup-list">
        <li>
          打开{" "}
          <a className="btn btn-sm btn-primary" href={CONSOLE} target="_blank" rel="noreferrer">
            飞书开发者后台 ↗
          </a>
          ，点击 <b>创建企业自建应用</b>，填写名称（就是机器人在飞书中显示的名字）和描述，点击 <b>创建</b>。
        </li>
        <li>
          在应用左侧打开 <b>添加应用能力</b>，找到 <b>机器人</b> 并点击 <b>添加</b>。
        </li>
        <li>
          打开 <b>权限管理</b>，搜索并开通下面 4 项权限（在搜索框中输入权限标识即可找到）：
          <table className="table table-compact setup-table">
            <tbody>
              {SCOPES.map(([scope, name, why]) => (
                <tr key={scope}>
                  <td>
                    <code>{scope}</code>
                  </td>
                  <td>{name}</td>
                  <td className="muted">{why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </li>
        <li>
          打开 <b>事件与回调 → 加密策略</b>，记下 <b>Verification Token</b>，下一步要填。<b>Encrypt Key</b>{" "}
          保持为空：witden 目前不接收加密推送的事件。
        </li>
      </ol>
      <div className="callout callout-wait">
        先不要配置事件订阅：请求地址要等 witden 保存了 Verification Token 后才能通过飞书的验证，放在第 {num("events")}{" "}
        步。开通的权限要在发布版本后才生效（第 {num("publish")} 步）。
      </div>
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          已创建应用并开通权限，去填写凭据
        </button>
      </div>
    </>
  );
}

function CredentialsStep({
  conn,
  num,
  onCreated,
  onSaved,
  onTested,
  onLater,
}: {
  conn: Connection | null;
  num: StepNumber;
  onCreated: (c: Connection) => void;
  onSaved: (c: Connection) => void;
  onTested: (bot: string) => void;
  /** Go on before the bot answers (it does once a version is published). */
  onLater: () => void;
}) {
  const { run, busy } = useAction();
  const [name, setName] = useState(conn?.name ?? "飞书");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [token, setToken] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const oddId = !!appId.trim() && !appId.trim().startsWith("cli_");
  const ready = !!name.trim() && (conn ? true : !!appId.trim() && !!appSecret.trim() && !!token.trim());

  const submit = async () => {
    const credentials = Object.fromEntries(
      Object.entries({ app_id: appId.trim(), app_secret: appSecret.trim(), verification_token: token.trim() }).filter(
        ([, v]) => v,
      ),
    );
    let c = conn;
    if (!c) {
      c =
        (await run(() =>
          api.post<Connection>("/api/connections", { platform: "feishu", name: name.trim(), credentials }),
        )) ?? null;
      if (!c) return;
      onCreated(c);
    } else if (Object.keys(credentials).length || name.trim() !== c.name) {
      const id = c.id;
      c =
        (await run(() =>
          api.patch<Connection>(`/api/connections/${id}`, {
            name: name.trim(),
            ...(Object.keys(credentials).length ? { credentials } : {}),
          }),
        )) ?? null;
      if (!c) return;
      onSaved(c);
    }
    const id = c.id;
    const out = await run(() => api.post<TestResult>(`/api/connections/${id}/test`));
    if (!out) return;
    setResult(out);
    if (out.ok) {
      const fresh = (await api.get<Connection[]>("/api/connections")).find((x) => x.id === id);
      if (fresh) onSaved(fresh);
      onTested(out.bot ?? "");
    }
  };

  return (
    <>
      <p>把应用的三项凭据填到这里。witden 加密保存它们，保存后不能再查看。</p>
      <form
        className="form form-narrow"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void submit();
        }}
      >
        <Field label="接入名称" hint="在 witden 中区分不同的接入，例如公司的名称。">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="App ID"
          description={
            <>
              在应用的 <b>凭证与基础信息</b> 页面，以 <code>cli_</code> 开头。
            </>
          }
          hint={
            oddId ? (
              <span className="text-wait">飞书的 App ID 以 cli_ 开头，请确认复制的是 App ID。</span>
            ) : conn ? (
              "留空保持不变"
            ) : undefined
          }
        >
          <input className="mono" autoComplete="off" value={appId} onChange={(e) => setAppId(e.target.value)} />
        </Field>
        <Field
          label="App Secret"
          description={
            <>
              同在 <b>凭证与基础信息</b> 页面，点击显示后复制。
            </>
          }
          hint={conn ? "留空保持不变" : undefined}
        >
          <input
            type="password"
            className="mono"
            autoComplete="off"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
          />
        </Field>
        <Field
          label="Verification Token"
          description={
            <>
              在 <b>事件与回调 → 加密策略</b> 页面。witden 用它确认事件确实来自飞书。
            </>
          }
          hint={conn ? "留空保持不变" : undefined}
        >
          <input
            type="password"
            className="mono"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <div className="setup-next">
          <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
            {busy ? "正在测试…" : "保存并测试连接"}
          </button>
        </div>
      </form>
      {result && !result.ok ? (
        <div className="callout callout-bad" role="alert">
          <b>测试没有通过。</b>
          {explain(result.error ?? "", num)}
          <div className="small">飞书返回：{result.error}</div>
          {conn && /bot\/v3\/info/.test(result.error ?? "") ? (
            <div className="btn-row">
              <button type="button" className="btn btn-sm" onClick={onLater}>
                先继续配置事件订阅
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function EventsStep({
  conn: initial,
  num,
  onNext,
  onFix,
}: {
  conn: Connection;
  num: StepNumber;
  onNext: () => void;
  onFix: () => void;
}) {
  const conn = useLiveConnection(initial);
  const url = conn.events_url ?? "";
  return (
    <>
      <p>让飞书把消息推送给 witden：填写请求地址，并订阅“接收消息”事件。</p>
      {reachable(url) ? null : (
        <div className="callout callout-wait">
          飞书只能把事件发到公网可以访问的 HTTPS 地址，下面的地址不满足，飞书会验证失败。请回到第 {num("address")}{" "}
          步准备公网事件地址。
        </div>
      )}
      <div className="setup-field">
        <span className="field-label">事件地址</span>
        <CopyText text={url} />
      </div>
      <ol className="setup-list">
        <li>
          在应用左侧打开 <b>事件与回调 → 事件配置</b>，编辑 <b>订阅方式</b>，选择 <b>将事件发送至开发者服务器</b>。
        </li>
        <li>
          把事件地址粘贴到 <b>请求地址</b>，点击 <b>保存</b>。飞书会立即验证这个地址。
        </li>
        <li>
          点击 <b>添加事件</b>，搜索“接收消息”，勾选 <b>接收消息 v2.0</b>（<code>im.message.receive_v1</code>），点击{" "}
          <b>确认添加</b>。
        </li>
      </ol>
      <WebhookStatus
        conn={conn}
        platform="飞书"
        idle="还没有收到飞书的请求。保存请求地址后，这里会显示验证结果（每 3 秒刷新）。飞书提示验证失败、这里却没有记录时，检查地址能否从公网访问，以及是否设置了 Encrypt Key（witden 不接收加密推送）。"
        accepted={(at) => `${fmtRelative(at)}，飞书验证了请求地址，可以继续添加事件。`}
        fix={
          <>
            这通常是第 {num("credentials")} 步的 Verification Token 填错了：它在 事件与回调 → 加密策略
            中。改好后在飞书中重新保存请求地址。{" "}
            <button type="button" className="btn btn-xs" onClick={onFix}>
              重新填写 Verification Token
            </button>
          </>
        }
      />
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          已保存请求地址并添加事件，下一步
        </button>
      </div>
    </>
  );
}

function PublishStep({
  conn,
  num,
  onTested,
}: {
  conn: Connection;
  num: StepNumber;
  onTested: (c: Connection, bot: string) => void;
}) {
  const { run, busy } = useAction();
  const [result, setResult] = useState<TestResult | null>(null);

  const test = async () => {
    const out = await run(() => api.post<TestResult>(`/api/connections/${conn.id}/test`));
    if (!out) return;
    setResult(out);
    if (!out.ok) return;
    const fresh = (await api.get<Connection[]>("/api/connections")).find((x) => x.id === conn.id) ?? conn;
    onTested(fresh, out.bot ?? "");
  };

  return (
    <>
      <p>
        飞书中开通的权限、机器人能力和事件订阅，要发布一个应用版本后才生效。之后每次修改权限或事件，也要再发布一个新版本。
      </p>
      <ol className="setup-list">
        <li>
          在应用左侧打开 <b>版本管理与发布</b>，点击 <b>创建版本</b>。
        </li>
        <li>
          填写版本号（例如 1.0.0）和更新说明；在 <b>可用范围</b> 中选择能使用这个机器人的成员或部门。
        </li>
        <li>
          点击 <b>保存</b>，再点击 <b>申请线上发布</b>。如果企业要求审核，等企业管理员在飞书管理后台通过审核。
        </li>
        <li>发布后回到这里测试连接：witden 读取机器人的信息。</li>
      </ol>
      {result && !result.ok ? (
        <div className="callout callout-bad" role="alert">
          <b>测试没有通过。</b>
          {explain(result.error ?? "", num)}
          <div className="small">飞书返回：{result.error}</div>
        </div>
      ) : null}
      <div className="setup-next">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void test()}>
          {busy ? "正在测试…" : "已发布，测试连接"}
        </button>
      </div>
    </>
  );
}

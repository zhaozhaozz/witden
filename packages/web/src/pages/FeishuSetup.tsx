import { type ReactNode, useState } from "react";
import { api } from "../api/client";
import type { Connection } from "../api/types";
import { fmtRelative } from "../lib/format";
import { useAction } from "../ui/feedback";
import { CopyText, Field, Loaded, Section, Tag } from "../ui/kit";
import { socketText } from "./connectionParts";
import { FeishuScopePicker, useFeishuCatalog } from "./feishuParts";
import { PublicAddressStep } from "./PublicAddress";
import { AccessStep, SetupSteps, TryStep, useLiveConnection, WebhookStatus } from "./setupParts";

type Mode = "socket" | "http";
type StepKey = "address" | "app" | "credentials" | "events" | "publish" | "access" | "try";

const STEP_TITLES: Record<StepKey, string> = {
  address: "准备公网事件地址",
  app: "在飞书开放平台创建应用",
  credentials: "填写凭据并测试连接",
  events: "订阅消息事件",
  publish: "发布应用版本",
  access: "选择机器人代表的 AI 员工",
  try: "在飞书中试一试",
};

/**
 * The long connection needs no public address; the events URL starts with one. Settings in the Feishu console
 * take effect once a version is published. Switching an existing connection keeps its app.
 */
const FLOW: Record<Mode, StepKey[]> = {
  socket: ["app", "credentials", "events", "publish", "access", "try"],
  http: ["address", "app", "credentials", "events", "publish", "access", "try"],
};
const flowOf = (mode: Mode, switching: boolean) => FLOW[mode].filter((k) => !switching || k !== "app");

type StepNumber = (k: StepKey) => number;

/** The permissions witden's Feishu adapter uses: [scope, name in the Feishu console, what for]. */
const CONSOLE = "https://open.feishu.cn/app";

/** The long connection takes only a complete App ID (the server checks it the same way). */
const APP_ID = /^cli_[0-9a-f]{16}$/i;

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
 * Guided Feishu setup shown in the page itself: an internal app with the bot ability, its credentials, how
 * events arrive (the long connection by default, or the public events URL), and a published version.
 * ``initial`` resumes an existing connection, in its way unless ``initialMode`` asks to switch it.
 */
export function FeishuSetup({
  initial,
  initialMode,
  onCreated,
  onClose,
}: {
  initial: Connection | null;
  /** Open on this way of receiving events (e.g. to switch an existing connection to the long connection). */
  initialMode?: Mode;
  onCreated: (c: Connection) => void;
  onClose: (c: Connection | null) => void;
}) {
  const [conn, setConn] = useState(initial);
  // An existing connection's way when the guide opened; choosing the other way switches it in place.
  const was: Mode | null = initial ? (initial.feishu_mode ?? "http") : null;
  const [mode, setMode] = useState<Mode>(initialMode ?? was ?? "socket");
  const switching = !!was && mode !== was;
  const flow = flowOf(mode, switching);
  /** Where to start in a way's flow: the first step, or where an existing connection left off. */
  const startOf = (m: Mode): StepKey =>
    !initial || m !== was ? flowOf(m, !!was && m !== was)[0] : initial.bot_user_id ? "access" : "events";
  const [step, setStep] = useState<StepKey>(startOf(mode));
  const [reached, setReached] = useState(flow.indexOf(startOf(mode)));
  const go = (k: StepKey) => {
    setStep(k);
    setReached((r) => Math.max(r, flow.indexOf(k)));
  };
  const num: StepNumber = (k) => flow.indexOf(k) + 1;
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
    app: <AppStep mode={mode} num={num} onNext={() => go("credentials")} />,
    credentials: (
      <CredentialsStep
        mode={mode}
        conn={conn}
        switching={switching}
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
      mode === "socket" ? (
        <SocketEventsStep conn={conn} num={num} onNext={() => go("publish")} />
      ) : (
        <EventsStep conn={conn} num={num} onNext={() => go("publish")} onFix={() => setStep("credentials")} />
      )
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
        intro="一个飞书应用就是一个机器人。选择它代表 witden 中的哪位 AI 员工：群里 @ 它的消息和发给它的私聊消息都交给这位 AI 员工处理，回复以机器人的身份发出。需要多位 AI 员工时，为每位 AI 员工各建一个飞书应用（在 witden 中各是一个接入）。"
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
        where="提问的地方（群里、消息串或私聊中）"
        accessStep={num("access")}
        idle={
          mode === "socket"
            ? `检查第 ${num("events")} 步“与飞书的连接”是否为已连接、订阅方式是否已保存为长连接、是否添加了“接收消息”事件，以及第 ${num("publish")} 步的版本是否已经发布。`
            : `检查第 ${num("events")} 步的请求地址是否通过验证、是否添加了“接收消息”事件，以及第 ${num("publish")} 步的版本是否已经发布。`
        }
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
  const label = (m: Mode) => (m === "socket" ? "长连接" : "事件地址");

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
        {switching
          ? `按下面 ${flow.length} 步把这个接入改为用${label(mode)}接收事件，沿用原来的飞书应用。群聊、私聊、机器人代表的 AI 员工和已关联的账号都保持不变。`
          : `按下面 ${flow.length} 步把飞书接入 witden，需要飞书企业的应用开发权限（发布应用时可能需要企业管理员审核）。完成后，大家在群里 @ 机器人或私聊它，就能把工作交给 witden 中的 AI 员工：一个群聊是 witden 中的一个话题，和飞书中看到的一致，消息串中的消息显示为回复；AI 员工在提问的地方回复（直接在群里，或在消息串中）；私聊是一个话题。飞书接入目前为实验性，只同步文字（包括富文本和卡片中的文字）。`}
      </p>
      <div className="setup-modes">
        <div className="segmented">
          {(
            [
              ["socket", "长连接（推荐，不需要公网地址）"],
              ["http", "事件地址（HTTP，需要公网地址）"],
            ] as [Mode, string][]
          ).map(([m, text]) => (
            <button
              type="button"
              key={m}
              className={m === mode ? "seg seg-on" : "seg"}
              onClick={() => {
                setMode(m);
                setStep(startOf(m));
                setReached(flowOf(m, !!was && m !== was).indexOf(startOf(m)));
              }}
            >
              {text}
              {m === was ? "（当前）" : ""}
            </button>
          ))}
        </div>
        <p className="small muted">
          {switching
            ? `从${label(was)}改为${label(mode)}：在第 ${num("credentials")} 步保存之前，原来的方式继续工作；保存后还要在飞书开发者后台修改订阅方式（第 ${num("events")} 步），改好之前收不到消息。`
            : was
              ? `这个接入目前使用${was === "socket" ? "长连接" : "事件地址（HTTP）"}。选择另一种方式即可在这里切换。`
              : mode === "socket"
                ? "witden 主动连到飞书接收消息：不需要公网地址，witden 在公网上什么都不暴露。"
                : "飞书把消息推送到 witden 的公网事件地址：需要一个只转发到事件端口的 HTTPS 地址。"}
        </p>
      </div>
      <SetupSteps
        flow={flow}
        step={step}
        reached={reached}
        title={(k) => STEP_TITLES[k]}
        summary={summary}
        body={body}
        // The event subscription and publishing can be done before the bot itself answers the test.
        unlocked={(_k, i) => !!conn && i > flow.indexOf("credentials")}
        onOpen={setStep}
      />
    </Section>
  );
}

function AppStep({ mode, num, onNext }: { mode: Mode; num: StepNumber; onNext: () => void }) {
  const catalog = useFeishuCatalog();
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
          打开 <b>权限管理</b>，点击 <b>批量导入/导出</b>，把下面的内容粘贴到导入框中，点击 <b>申请开通</b>
          ，一次申请全部权限（也可以在搜索框中输入权限标识，逐项开通）。基础权限每个接入都需要；扩展按需勾选，勾选后
          JSON 随之更新。以后也可以在接入详情中检测已开通的权限、申请更多。
          <Loaded res={catalog}>{(c) => <FeishuScopePicker catalog={c} />}</Loaded>
        </li>
        <li>
          在 <b>权限管理 → 数据权限</b> 中，把 <b>通讯录权限范围</b> 设为会使用机器人的成员（例如全部成员）。witden
          只读取人的名字；不设置时私聊中显示对方的 ID，群聊中的名字不受影响（从群成员列表读取）。
        </li>
        {mode === "http" ? (
          <li>
            打开 <b>事件与回调 → 加密策略</b>，记下 <b>Verification Token</b>，下一步要填。<b>Encrypt Key</b>{" "}
            保持为空：witden 目前不接收加密推送的事件。
          </li>
        ) : null}
      </ol>
      <div className="callout callout-wait">
        {mode === "socket"
          ? `先不要配置事件订阅：飞书要等 witden 用长连接连上之后，才允许把订阅方式保存为长连接，放在第 ${num("events")} 步。`
          : `先不要配置事件订阅：请求地址要等 witden 保存了 Verification Token 后才能通过飞书的验证，放在第 ${num("events")} 步。`}
        开通的权限和数据权限要在发布版本后才生效（第 {num("publish")} 步）。
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
  mode,
  conn,
  switching,
  num,
  onCreated,
  onSaved,
  onTested,
  onLater,
}: {
  mode: Mode;
  conn: Connection | null;
  /** The connection uses the other way until this step saves. */
  switching: boolean;
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
  const id = appId.trim();
  const oddId = !!id && (mode === "socket" ? !APP_ID.test(id) : !id.startsWith("cli_"));
  // The events URL needs the token; a connection coming from the long connection has none saved.
  const needToken = mode === "http" && (!conn || switching);
  const ready = !!name.trim() && (conn ? true : !!id && !!appSecret.trim()) && (!needToken || !!token.trim()) && !oddId;

  const submit = async () => {
    const credentials = Object.fromEntries(
      Object.entries({
        app_id: id,
        app_secret: appSecret.trim(),
        ...(mode === "http" ? { verification_token: token.trim() } : {}),
      }).filter(([, v]) => v),
    );
    let c = conn;
    if (!c) {
      c =
        (await run(() =>
          api.post<Connection>("/api/connections", {
            platform: "feishu",
            name: name.trim(),
            credentials,
            settings: { feishu_mode: mode },
          }),
        )) ?? null;
      if (!c) return;
      onCreated(c);
    } else if (Object.keys(credentials).length || name.trim() !== c.name || switching) {
      const cid = c.id;
      c =
        (await run(() =>
          api.patch<Connection>(`/api/connections/${cid}`, {
            name: name.trim(),
            ...(switching ? { settings: { feishu_mode: mode } } : {}),
            ...(Object.keys(credentials).length ? { credentials } : {}),
          }),
        )) ?? null;
      if (!c) return;
      onSaved(c);
    }
    const cid = c.id;
    const out = await run(() => api.post<TestResult>(`/api/connections/${cid}/test`));
    if (!out) return;
    setResult(out);
    if (out.ok) {
      const fresh = (await api.get<Connection[]>("/api/connections")).find((x) => x.id === cid);
      if (fresh) onSaved(fresh);
      onTested(out.bot ?? "");
    }
  };

  return (
    <>
      <p>
        {mode === "socket"
          ? "长连接只需要应用的 App ID 和 App Secret。"
          : "事件地址方式需要应用的 App ID、App Secret 和 Verification Token。"}
        witden 加密保存它们，保存后不能再查看。
        {switching && mode === "socket" ? "原来保存的 Verification Token 会被删除。" : ""}
      </p>
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
              <span className="text-wait">
                {mode === "socket"
                  ? "飞书的 App ID 是 cli_ 加 16 位字母数字，请确认复制完整。"
                  : "飞书的 App ID 以 cli_ 开头，请确认复制的是 App ID。"}
              </span>
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
        {mode === "http" ? (
          <Field
            label="Verification Token"
            description={
              <>
                在 <b>事件与回调 → 加密策略</b> 页面（Encrypt Key 保持为空）。witden 用它确认事件确实来自飞书。
              </>
            }
            hint={conn && !needToken ? "留空保持不变" : undefined}
          >
            <input
              type="password"
              className="mono"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
        ) : null}
        <div className="setup-next">
          <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
            {busy
              ? "正在测试…"
              : switching
                ? `改用${mode === "socket" ? "长连接" : "事件地址"}并测试`
                : "保存并测试连接"}
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

/** The long connection: witden connects first, then the Feishu console accepts it as the way to send events. */
function SocketEventsStep({ conn: initial, num, onNext }: { conn: Connection; num: StepNumber; onNext: () => void }) {
  const conn = useLiveConnection(initial);
  const state = socketText(conn.socket, "feishu");
  const connected = conn.socket?.state === "connected";
  return (
    <>
      <p>让飞书通过 witden 建立的长连接发送消息：在飞书中把订阅方式改为长连接，并订阅“接收消息”事件。</p>
      <div className="setup-field">
        <span className="field-label">与飞书的连接</span>
        <span>
          <Tag tone={state.tone}>{state.text}</Tag>
          <span className="small muted"> 每 3 秒刷新</span>
        </span>
      </div>
      <ol className="setup-list">
        <li>
          确认上面显示“已连接”。飞书只有在 witden 连上之后，才允许把订阅方式保存为长连接。
          {connected ? null : (
            <span className="text-wait">
              {" "}
              还没有连上：如果一直停在这里，检查第 {num("credentials")} 步的 App ID 和 App Secret，以及 witden
              服务器能否访问 open.feishu.cn。
            </span>
          )}
        </li>
        <li>
          在应用左侧打开 <b>事件与回调 → 事件配置</b>，编辑 <b>订阅方式</b>，选择 <b>使用长连接接收事件</b>，点击{" "}
          <b>保存</b>。
        </li>
        <li>
          点击 <b>添加事件</b>，搜索“接收消息”，勾选 <b>接收消息 v2.0</b>（<code>im.message.receive_v1</code>），点击{" "}
          <b>确认添加</b>。
        </li>
      </ol>
      <div className="callout">
        同一个飞书应用只接到一个 witden：飞书把每条消息只交给一个连着的程序，同一个应用再接到另一个
        witden（例如测试环境）时，消息会被随机分走。
      </div>
      {conn.webhook?.received_at ? (
        <div className="small">{fmtRelative(conn.webhook.received_at)}，witden 通过长连接收到了飞书的事件。</div>
      ) : null}
      <div className="setup-next">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          已改为长连接并添加事件，下一步
        </button>
      </div>
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
          点击 <b>保存</b>，再点击 <b>申请线上发布</b>
          。版本中有标为需要审核的权限，或企业要求审核时，等企业管理员在飞书管理后台通过，这个版本才生效。
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

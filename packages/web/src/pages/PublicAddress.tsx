import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useUnsavedChanges } from "../lib/unsaved";
import { CopyText, Field, Tag } from "../ui/kit";

interface PublicUrl {
  url: string;
  saved: string | null;
  default: string;
}

interface UrlCheck {
  ok: boolean;
  url: string;
  problem?: string;
  detail?: string;
  overridable?: boolean;
  /** This server's DNS did not resolve the host; it was checked at this address from public DNS. */
  publicDns?: string;
}

interface SaveResult {
  saved: boolean;
  url: string;
  check: UrlCheck | null;
}

interface TunnelStatus {
  available: boolean;
  token: { account: string; tunnel: string } | null;
  state: "not_running" | "connecting" | "connected";
  routes: { hostname: string; service: string }[];
  origin: string | null;
}

type Mode = "tunnel" | "proxy";

/** Why an address cannot be used, in the words of someone setting it up. */
function explain(c: UrlCheck): string {
  const d = c.detail ? `（${c.detail}）` : "";
  switch (c.problem) {
    case "https":
      return "必须是 https:// 开头的地址：Slack、GitHub、飞书都只把事件发到 HTTPS 地址。";
    case "format":
      return "请填写“https://域名”形式的地址，不带路径。";
    case "private":
      return "这是本机或内网地址，外部平台访问不到。";
    case "dns":
      return `解析不到这个域名${d}，公共 DNS 中也没有查到。检查 DNS 记录是否已经生效。`;
    case "tls":
      return `HTTPS 证书无效${d}。这些平台不接受自签名或过期的证书。`;
    case "unreachable":
      return `witden 服务器连不上这个地址${d}。检查防火墙是否放行 443 端口，反向代理或隧道是否在运行。`;
    case "timeout":
      return "访问这个地址超时。检查防火墙和反向代理。";
    case "redirect":
      return `这个地址返回了重定向${c.detail ? `（到 ${c.detail}）` : ""}。这些平台不跟随重定向，请填写最终的地址。`;
    case "http":
      return `这个地址能访问，但返回了 ${c.detail ?? "错误"}：反向代理可能没有转发到 witden。`;
    case "not_witden":
      return "这个地址能访问，但回答的不是 witden：反向代理可能转发到了别的服务。";
    case "other_instance":
      return "这个地址转发到了另一个 witden，而不是当前这个。";
    case "console_exposed":
      return "通过这个地址能打开 witden 的控制台，整个控制台会暴露到公网。请改为只转发到事件端口 8325（Cloudflare Tunnel 的 Service URL 为 http://api:8325）。";
    default:
      return "检查没有通过。";
  }
}

// Both forward to witden's event webhook port, which serves platform events only and never the console.
const NGINX = `server {
    listen 443 ssl;
    server_name hooks.example.com;
    ssl_certificate     /etc/letsencrypt/live/hooks.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hooks.example.com/privkey.pem;
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:8325;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;

const CADDY = `hooks.example.com {
    reverse_proxy 127.0.0.1:8325
}`;

/**
 * The public address and the Cloudflare Tunnel as the connection wizards and "系统管理 → 公网地址" both see
 * them: one platform setting behind the same endpoints, so a change in either place is the same change.
 */
export function usePublicAddress({ onSaved }: { onSaved?: () => void } = {}) {
  const [current, setCurrent] = useState<PublicUrl | null>(null);
  const [check, setCheck] = useState<UrlCheck | null>(null);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [mode, setMode] = useState<Mode>("tunnel");
  const [busy, setBusy] = useState(false);
  // The last address tried and how its check went (shown under the form that tried it).
  const [tried, setTried] = useState<SaveResult | null>(null);

  useEffect(() => {
    let stopped = false;
    void (async () => {
      const [cur, tun] = await Promise.all([
        api.get<PublicUrl>("/api/settings/public-url"),
        api.get<TunnelStatus>("/api/settings/tunnel"),
      ]);
      if (stopped) return;
      setCurrent(cur);
      setTunnel(tun);
      // Open on the way the address was set up: one saved while no tunnel token is kept came from a proxy.
      if (!tun.available || (cur.saved && !tun.token)) setMode("proxy");
      const c = await api.post<UrlCheck>("/api/settings/public-url/check", { url: cur.url });
      if (!stopped) setCheck(c);
    })();
    return () => {
      stopped = true;
    };
  }, []);

  const save = async (url: string, force = false) => {
    setBusy(true);
    try {
      const out = await api.put<SaveResult>("/api/settings/public-url", { url, force });
      setTried(out);
      if (out.saved) {
        setCurrent((c) => (c ? { ...c, url: out.url, saved: out.url } : c));
        setCheck(out.check);
        onSaved?.();
      }
      return out;
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    if (!current) return;
    const before = check;
    setTried(null);
    setCheck(null);
    try {
      setCheck(await api.post<UrlCheck>("/api/settings/public-url/check", { url: current.url }));
    } catch {
      setCheck(before);
    }
  };

  // Forget the saved address: event addresses fall back to WITDEN_PUBLIC_URL, the console's own address.
  const clear = async () => {
    setBusy(true);
    try {
      const out = await api.put<SaveResult>("/api/settings/public-url", { url: "" });
      setTried(null);
      setCurrent((c) => (c ? { ...c, url: out.url, saved: null } : c));
      setCheck(null);
      setCheck(await api.post<UrlCheck>("/api/settings/public-url/check", { url: out.url }));
    } finally {
      setBusy(false);
    }
  };

  const pickMode = (m: Mode) => {
    setMode(m);
    setTried(null);
  };

  // A saved address that failed the check was kept on purpose (forced); it still counts as ready.
  const forced = !!tried?.saved && !!tried.check && !tried.check.ok;
  const ready = !!current && (!!check?.ok || forced);

  return { current, check, tunnel, setTunnel, mode, pickMode, busy, tried, save, recheck, clear, forced, ready };
}

export type PublicAddress = ReturnType<typeof usePublicAddress>;

/** What the public address is for and what it has to satisfy. */
export function PublicAddressIntro() {
  return (
    <>
      <p>
        Slack、GitHub、飞书会把事件推送到 witden 的<b>事件地址</b>
        ，即这里的公网地址加上固定路径。控制台不对公网开放：witden 有一个单独的<b>事件端口 8325</b>
        ，只接收这些平台推送的事件（另外提供 Slack 安装回调和 AI
        员工头像），不提供控制台和任何其他接口。公网地址需要满足：
      </p>
      <ul className="setup-list">
        <li>以 https:// 开头，证书有效（这些平台不接受自签名证书）；</li>
        <li>能从公网访问，并且只转发到 witden 的事件端口，不能转发到控制台端口 8320。</li>
      </ul>
    </>
  );
}

/** The address in use and how its latest check went. */
export function PublicAddressStatus({ a, actions }: { a: PublicAddress; actions?: ReactNode }) {
  const { current, check, forced } = a;
  return (
    <div className="setup-events">
      当前公网地址 {current ? <code>{current.url}</code> : <span className="muted">读取中…</span>}{" "}
      {current && !current.saved ? (
        <span className="small muted">（还没有设置，暂按 WITDEN_PUBLIC_URL 生成）</span>
      ) : null}{" "}
      {!current || !check ? (
        <span className="muted small">正在检查…</span>
      ) : check.ok ? (
        <>
          <Tag tone="ok">已通过检查</Tag>
          {check.publicDns ? <PublicDnsNote address={check.publicDns} /> : null}
        </>
      ) : forced ? (
        <Tag tone="wait">未通过检查，按你的选择继续使用</Tag>
      ) : (
        <>
          <Tag tone="bad">还不能用</Tag> <span className="small">{explain(check)}</span>
        </>
      )}
      {actions ? <div className="btn-row setup-status-actions">{actions}</div> : null}
    </div>
  );
}

/** The two ways to get an address: the Cloudflare Tunnel beside witden, or the user's own proxy. */
export function PublicAddressSetup({ a }: { a: PublicAddress }) {
  const { current, check, ready, tunnel, setTunnel, mode, pickMode, busy, tried, save } = a;
  if (!current) return null;
  return (
    <>
      <div className="segmented setup-modes">
        <button type="button" className={mode === "tunnel" ? "seg seg-on" : "seg"} onClick={() => pickMode("tunnel")}>
          Cloudflare Tunnel（推荐，无需公网 IP 和证书）
        </button>
        <button type="button" className={mode === "proxy" ? "seg seg-on" : "seg"} onClick={() => pickMode("proxy")}>
          自己的域名和反向代理（nginx、Caddy 等）
        </button>
      </div>
      {mode === "tunnel" ? (
        <TunnelSetup
          status={tunnel}
          onStatus={setTunnel}
          current={current.url}
          auto={!!check && !ready}
          tried={tried}
          busy={busy}
          onUse={(url) => save(url)}
        />
      ) : (
        <ProxySetup tried={tried} busy={busy} onSave={save} />
      )}
    </>
  );
}

/**
 * First step of connecting a platform that pushes events: a public HTTPS address that leads back to this
 * witden, set up behind the user's own proxy or through the optional Cloudflare Tunnel, and checked before
 * going on.
 */
export function PublicAddressStep({ onNext }: { onNext: (url: string) => void }) {
  const [changing, setChanging] = useState(false);
  const a = usePublicAddress({ onSaved: () => setChanging(false) });
  const { current, ready } = a;

  return (
    <>
      <PublicAddressIntro />
      <PublicAddressStatus a={a} />
      {ready && !changing ? (
        <p className="small muted">
          witden 已经通过这个地址访问到自己的事件端口，并确认从这个地址打不开控制台；接入时平台还会再验证一次。{" "}
          <button type="button" className="btn btn-xs" onClick={() => setChanging(true)}>
            更换地址
          </button>
        </p>
      ) : (
        <PublicAddressSetup a={a} />
      )}
      <p className="small muted">这里保存的就是“设置 → 系统管理 → 公网地址”中的设置，以后也可以在那里查看和修改。</p>
      <div className="setup-next">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready}
          onClick={() => current && onNext(current.url)}
        >
          下一步
        </button>
        {ready ? null : <span className="small muted">地址通过检查后才能继续。</span>}
      </div>
    </>
  );
}

/** The server's own DNS could not resolve the address; it was checked where public DNS points. */
function PublicDnsNote({ address }: { address: string }) {
  return (
    <span className="small muted">
      （服务器所在网络的 DNS 解析不到这个域名，已按公共 DNS 中的地址 {address} 检查；Slack 等平台使用公共
      DNS，不受影响）
    </span>
  );
}

function CheckResult({
  tried,
  busy,
  onForce,
  onRetry,
}: {
  tried: SaveResult | null;
  busy: boolean;
  onForce?: () => void;
  onRetry?: () => void;
}) {
  if (!tried?.check) return null;
  if (tried.check.ok)
    return (
      <div className="callout">
        已通过检查：{tried.url} 转发到这个 witden 的事件端口，打不开控制台。已保存为公网地址。
        {tried.check.publicDns ? <PublicDnsNote address={tried.check.publicDns} /> : null}
      </div>
    );
  if (tried.saved) return null;
  return (
    <div className="callout callout-bad" role="alert">
      {tried.check.url}：{explain(tried.check)}
      {onRetry ? (
        <>
          {" "}
          <button type="button" className="btn btn-xs" disabled={busy} onClick={onRetry}>
            重新检查
          </button>
        </>
      ) : null}
      {tried.check.overridable && onForce ? (
        <div className="small">
          如果确定外网可以访问（例如服务器所在网络不能从内部访问自己的公网地址），可以{" "}
          <button type="button" className="btn btn-xs" disabled={busy} onClick={onForce}>
            仍然使用这个地址
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ProxySetup({
  tried,
  busy,
  onSave,
}: {
  tried: SaveResult | null;
  busy: boolean;
  onSave: (url: string, force?: boolean) => Promise<SaveResult>;
}) {
  const [url, setUrl] = useState("");
  // An address typed but not checked and saved yet.
  useUnsavedChanges(
    !!url.trim() && !(tried?.saved && tried.url === url.trim()),
    async () => (await onSave(url.trim())).saved,
  );
  return (
    <>
      <ol className="setup-list">
        <li>
          准备一个专用于接收事件的域名（例如 hooks.example.com），把它的 DNS 记录（A 或 AAAA）指向这台服务器的公网
          IP，并在防火墙中放行 443 端口。
        </li>
        <li>
          用反向代理提供 HTTPS，<b>只转发到事件端口</b>：docker compose 部署时为本机的
          127.0.0.1:8325，不要转发到控制台端口 8320。常用写法见下面的示例，把 hooks.example.com
          换成你的域名。反向代理在另一台机器上时，在 .env 中设置 WITDEN_WEBHOOK_BIND 让事件端口对那台机器可见。
        </li>
        <li>
          把地址（例如 https://hooks.example.com）填到下面，点击“检查并使用”。witden
          会通过这个地址访问自己的事件端口，并确认从这个地址打不开控制台。
        </li>
      </ol>
      <details className="setup-more">
        <summary>Caddy（自动申请 HTTPS 证书）</summary>
        <CopyText text={CADDY} label="Caddyfile" />
        <pre className="mono-block">{CADDY}</pre>
      </details>
      <details className="setup-more">
        <summary>nginx（证书可用 certbot 申请：certbot --nginx -d hooks.example.com）</summary>
        <CopyText text={NGINX} label="nginx 配置" />
        <pre className="mono-block">{NGINX}</pre>
      </details>
      <p className="small muted">
        Slack 消息中“在 witden 中查看”等链接仍然指向控制台的内网地址，只有能访问内网的人可以打开。
      </p>
      <form
        className="form form-narrow"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim() && !busy) void onSave(url.trim());
        }}
      >
        <Field label="公网地址">
          <input value={url} placeholder="https://hooks.example.com" onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <div className="setup-next">
          <button type="submit" className="btn" disabled={!url.trim() || busy}>
            {busy ? "正在检查…" : "检查并使用"}
          </button>
        </div>
      </form>
      <CheckResult tried={tried} busy={busy} onForce={() => void onSave(url.trim(), true)} />
    </>
  );
}

function TunnelSetup({
  status,
  onStatus,
  current,
  auto,
  tried,
  busy,
  onUse,
}: {
  status: TunnelStatus | null;
  onStatus: (s: TunnelStatus) => void;
  current: string;
  /** A detected route may be checked and saved without a click: the address in use has not passed its check. */
  auto: boolean;
  tried: SaveResult | null;
  busy: boolean;
  onUse: (url: string) => Promise<SaveResult>;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  // When the tunnel was first seen not running although a token is saved.
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  // Each detected route is checked automatically once.
  const attempted = useRef(new Set<string>());

  // Follow the tunnel while it starts, connects and receives its routes.
  const tunnelId = status?.token?.tunnel;
  useEffect(() => {
    if (!tunnelId) return;
    const timer = window.setInterval(async () => {
      setNow(Date.now());
      try {
        onStatus(await api.get<TunnelStatus>("/api/settings/tunnel"));
      } catch {
        // the next poll retries
      }
    }, 3000);
    return () => {
      window.clearInterval(timer);
    };
  }, [tunnelId, onStatus]);

  const origin = (status?.origin ?? "").replace(/\/+$/, "");
  const routes = status?.routes ?? [];
  const ours = routes.filter((r) => r.service.replace(/\/+$/, "") === origin);
  const candidate = ours[0] ? `https://${ours[0].hostname}` : null;

  // A route to witden appeared: check it and use it, without another click. An address that already works is
  // never replaced this way (the settings page shows this part all the time); a button offers the route instead.
  const offered = status?.state === "connected" && !!candidate && candidate !== current;
  useEffect(() => {
    if (!auto || !offered || !candidate) return;
    if (attempted.current.has(candidate)) return;
    attempted.current.add(candidate);
    void onUse(candidate);
  }, [auto, offered, candidate, onUse]);

  const notRunning = !!status?.token && status.state === "not_running";
  useEffect(() => {
    setWaitingSince((since) => (notRunning ? (since ?? Date.now()) : null));
  }, [notRunning]);

  const saveToken = async (): Promise<boolean> => {
    setError(null);
    try {
      onStatus(await api.put<TunnelStatus>("/api/settings/tunnel", { token }));
      setToken("");
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };
  // A token pasted but not saved yet.
  useUnsavedChanges(!!token.trim(), saveToken);

  if (!status) return null;
  if (!status.available)
    return (
      <div className="callout callout-wait">
        这个部署没有配置 Cloudflare Tunnel 服务。用代码仓中的 docker compose 部署时它已包含在内；单进程部署可以自行运行
        cloudflared（见部署文档），再选择“自己的域名和反向代理”填写地址。
      </div>
    );

  const removeToken = async () => {
    setError(null);
    try {
      onStatus(await api.del<TunnelStatus>("/api/settings/tunnel"));
      setStopping(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  // The tunnel service looks for a token every few seconds.
  const waitedLong = waitingSince !== null && now - waitingSince > 30_000;

  return (
    <>
      <p className="small muted">
        Cloudflare Tunnel 由 witden 旁边的 tunnel 服务主动连到 Cloudflare，不需要公网
        IP、开放端口或自己管理证书。需要一个托管在 Cloudflare 的域名。tunnel 只转发到事件端口，控制台不经过它。
      </p>
      <ol className="setup-list">
        <li>
          打开{" "}
          <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">
            Cloudflare 控制台 ↗
          </a>
          ，进入 <b>Networking → Tunnels</b>，点击 <b>Create a tunnel</b>，输入名称后点击 <b>Create Tunnel</b>。
        </li>
        <li>
          在安装说明中选择 <b>Docker</b>，复制命令里 <code>--token</code>{" "}
          后面的一长串（也可以复制整条命令），粘贴到下面并保存。 不需要运行这条命令，witden 的 tunnel 服务会用这个 token
          自动连接。
          <div className="form form-narrow setup-inline-form">
            <textarea
              rows={2}
              className="mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="eyJhIjoi…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <div className="setup-next">
              <button type="button" className="btn" disabled={!token.trim()} onClick={() => void saveToken()}>
                {status.token ? "更换 token" : "保存 token"}
              </button>
              {status.token ? (
                <span className="small muted">
                  已保存 tunnel <code>{status.token.tunnel.slice(0, 8)}</code>，更换后几秒内自动用新 token 重新连接。
                </span>
              ) : null}
              {status.token && !stopping ? (
                <button type="button" className="btn btn-xs btn-danger-ghost" onClick={() => setStopping(true)}>
                  停用 tunnel
                </button>
              ) : null}
              {stopping ? (
                <span className="small">
                  停用后，经过这个 tunnel 的公网地址将无法访问。{" "}
                  <button type="button" className="btn btn-xs btn-danger" onClick={() => void removeToken()}>
                    确认停用
                  </button>{" "}
                  <button type="button" className="btn btn-xs" onClick={() => setStopping(false)}>
                    取消
                  </button>
                </span>
              ) : null}
            </div>
            {error ? <span className="small text-bad">{error}</span> : null}
          </div>
          {status.token ? (
            <div className="small">
              {status.state === "connected" ? (
                <Tag tone="ok">已连接到 Cloudflare</Tag>
              ) : status.state === "connecting" ? (
                <Tag tone="wait">tunnel 服务已启动，正在连接 Cloudflare；一直停在这里时，检查 token 是否完整</Tag>
              ) : waitedLong ? (
                <span className="text-bad">
                  tunnel 服务没有运行。它随代码仓中的 docker-compose.yml
                  一起部署：如果这个部署用的是旧版本，更新后在服务器上执行 <code>docker compose up -d</code>。
                </span>
              ) : (
                <Tag tone="wait">等待 tunnel 服务读取 token</Tag>
              )}
            </div>
          ) : null}
        </li>
        <li>
          在这个 tunnel 的 <b>Routes</b> 标签中点击 <b>Add route → Published application</b>：填写子域名（例如
          hooks）并选择域名，<b>Service URL</b> 填 {origin ? <CopyText text={origin} /> : null}，点击 <b>Add route</b>。
          路由生效后，witden 会自动发现它、检查并保存为公网地址；如果当前已有通过检查的公网地址，则由你确认是否改用。
          {routes.length ? (
            <ul className="plain-list setup-routes">
              {routes.map((r) => (
                <li key={r.hostname}>
                  <code>https://{r.hostname}</code> → <code>{r.service}</code>{" "}
                  {r.service.replace(/\/+$/, "") === origin ? (
                    <Tag tone="ok">只转发到事件端口</Tag>
                  ) : (
                    <Tag tone="bad">
                      {/:8320\b/.test(r.service) ? "会把控制台暴露到公网，" : ""}Service URL 应为 {origin}
                    </Tag>
                  )}
                </li>
              ))}
            </ul>
          ) : status.state === "connected" ? (
            <div className="small muted">还没有路由。</div>
          ) : null}
        </li>
      </ol>
      {candidate && busy ? (
        <div className="small muted">正在检查 {candidate}…</div>
      ) : offered && candidate && !auto && tried?.check?.url !== candidate ? (
        <div className="small">
          这个 tunnel 有指向事件端口的路由 <code>{candidate}</code>，与当前公网地址不同。{" "}
          <button type="button" className="btn btn-xs" onClick={() => void onUse(candidate)}>
            检查并改用这个地址
          </button>
        </div>
      ) : null}
      {/* A new DNS record can take a moment: the automatic check may fail once. */}
      <CheckResult tried={tried} busy={busy} onRetry={candidate ? () => void onUse(candidate) : undefined} />
    </>
  );
}

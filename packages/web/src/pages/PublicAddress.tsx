import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
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

/** Why an address cannot be used, in the words of someone setting it up. */
function explain(c: UrlCheck): string {
  const d = c.detail ? `（${c.detail}）` : "";
  switch (c.problem) {
    case "https":
      return "必须是 https:// 开头的地址：Slack 只把事件发到 HTTPS 地址。";
    case "format":
      return "请填写“https://域名”形式的地址，不带路径。";
    case "private":
      return "这是本机或内网地址，Slack 访问不到。";
    case "dns":
      return `witden 服务器解析不到这个域名${d}。检查 DNS 记录是否已经生效。`;
    case "tls":
      return `HTTPS 证书无效${d}。Slack 不接受自签名或过期的证书。`;
    case "unreachable":
      return `witden 服务器连不上这个地址${d}。检查防火墙是否放行 443 端口，反向代理或隧道是否在运行。`;
    case "timeout":
      return "访问这个地址超时。检查防火墙和反向代理。";
    case "redirect":
      return `这个地址返回了重定向${c.detail ? `（到 ${c.detail}）` : ""}。Slack 不跟随重定向，请填写最终的地址。`;
    case "http":
      return `这个地址能访问，但返回了 ${c.detail ?? "错误"}：反向代理可能没有转发到 witden。`;
    case "not_witden":
      return "这个地址能访问，但回答的不是 witden：反向代理可能转发到了别的服务。";
    case "other_instance":
      return "这个地址转发到了另一个 witden，而不是当前这个。";
    default:
      return "检查没有通过。";
  }
}

const NGINX = `map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name witden.example.com;
    ssl_certificate     /etc/letsencrypt/live/witden.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/witden.example.com/privkey.pem;
    client_max_body_size 60m;

    location / {
        proxy_pass http://127.0.0.1:8320;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # remote desktops use WebSocket, live updates use Server-Sent Events
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}`;

const CADDY = `witden.example.com {
    reverse_proxy 127.0.0.1:8320
}`;

/**
 * First step of connecting a platform that pushes events: a public HTTPS address that leads back to this
 * witden, set up behind the user's own proxy or through the optional Cloudflare Tunnel, and checked before
 * going on.
 */
export function PublicAddressStep({ onNext }: { onNext: (url: string) => void }) {
  const [current, setCurrent] = useState<PublicUrl | null>(null);
  const [check, setCheck] = useState<UrlCheck | null>(null);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [mode, setMode] = useState<"tunnel" | "proxy">("tunnel");
  const [changing, setChanging] = useState(false);
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
      if (!tun.available) setMode("proxy");
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
        setChanging(false);
      }
      return out;
    } finally {
      setBusy(false);
    }
  };

  // A saved address that failed the check was kept on purpose (forced); it still counts as ready.
  const forced = !!tried?.saved && !!tried.check && !tried.check.ok;
  const ready = !!current && (check?.ok || forced);

  return (
    <>
      <p>
        Slack 会把消息推送到 witden 的<b>事件地址</b>，即这里的公网地址加上固定路径。所以先准备一个满足以下条件的地址：
      </p>
      <ul className="setup-list">
        <li>以 https:// 开头，证书有效（Slack 不接受自签名证书）；</li>
        <li>能从公网访问，并且转发到这个 witden。</li>
      </ul>
      <div className="setup-events">
        当前公网地址 {current ? <code>{current.url}</code> : <span className="muted">读取中…</span>}{" "}
        {!current || !check ? (
          <span className="muted small">正在检查…</span>
        ) : check.ok ? (
          <Tag tone="ok">已通过检查</Tag>
        ) : forced ? (
          <Tag tone="wait">未通过检查，按你的选择继续使用</Tag>
        ) : (
          <>
            <Tag tone="bad">还不能用</Tag> <span className="small">{explain(check)}</span>
          </>
        )}
      </div>
      {ready && !changing ? (
        <p className="small muted">
          witden 已经通过这个地址访问到自己；订阅事件时 Slack 还会再验证一次。{" "}
          <button type="button" className="btn btn-xs" onClick={() => setChanging(true)}>
            更换地址
          </button>
        </p>
      ) : current ? (
        <>
          <div className="segmented setup-modes">
            <button
              type="button"
              className={mode === "tunnel" ? "seg seg-on" : "seg"}
              onClick={() => (setMode("tunnel"), setTried(null))}
            >
              Cloudflare Tunnel（推荐，无需公网 IP 和证书）
            </button>
            <button
              type="button"
              className={mode === "proxy" ? "seg seg-on" : "seg"}
              onClick={() => (setMode("proxy"), setTried(null))}
            >
              自己的域名和反向代理（nginx、Caddy 等）
            </button>
          </div>
          {mode === "tunnel" ? (
            <TunnelSetup
              status={tunnel}
              onStatus={setTunnel}
              current={current.url}
              tried={tried}
              busy={busy}
              onUse={(url) => save(url)}
            />
          ) : (
            <ProxySetup tried={tried} busy={busy} onSave={save} />
          )}
        </>
      ) : null}
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
    return <div className="callout">已通过检查：{tried.url} 能访问，并且转发到这个 witden。已保存为公网地址。</div>;
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
  return (
    <>
      <ol className="setup-list">
        <li>准备一个域名，把它的 DNS 记录（A 或 AAAA）指向这台服务器的公网 IP，并在防火墙中放行 443 端口。</li>
        <li>
          用反向代理提供 HTTPS，把请求转发到 witden（docker compose 部署时为本机的 8320 端口，即 WITDEN_PORT）。
          常用写法见下面的示例，把 witden.example.com 换成你的域名。
        </li>
        <li>
          把地址（例如 https://witden.example.com）填到下面，点击“检查并使用”。witden
          会通过这个地址访问自己，确认能回到当前这个 witden。
        </li>
      </ol>
      <details className="setup-more">
        <summary>Caddy（自动申请 HTTPS 证书）</summary>
        <CopyText text={CADDY} label="Caddyfile" />
        <pre className="mono-block">{CADDY}</pre>
      </details>
      <details className="setup-more">
        <summary>nginx（证书可用 certbot 申请：certbot --nginx -d witden.example.com）</summary>
        <CopyText text={NGINX} label="nginx 配置" />
        <pre className="mono-block">{NGINX}</pre>
      </details>
      <p className="small muted">
        只想让外部平台访问、不对公网开放控制台时，可以只转发 <code>/api/integrations/</code>{" "}
        开头的路径（检查也走这个路径）；但 Slack 消息中“在 witden 中查看”的链接需要能打开控制台。
      </p>
      <form
        className="form form-narrow"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim() && !busy) void onSave(url.trim());
        }}
      >
        <Field label="公网地址">
          <input value={url} placeholder="https://witden.example.com" onChange={(e) => setUrl(e.target.value)} />
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
  tried,
  busy,
  onUse,
}: {
  status: TunnelStatus | null;
  onStatus: (s: TunnelStatus) => void;
  current: string;
  tried: SaveResult | null;
  busy: boolean;
  onUse: (url: string) => Promise<SaveResult>;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  // Each detected route is checked automatically once.
  const attempted = useRef(new Set<string>());

  // Follow the tunnel while it starts, connects and receives its routes.
  useEffect(() => {
    if (!status?.token) return;
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
  }, [status?.token, onStatus]);

  const origin = (status?.origin ?? "").replace(/\/+$/, "");
  const routes = status?.routes ?? [];
  const ours = routes.filter((r) => r.service.replace(/\/+$/, "") === origin);
  const candidate = ours[0] ? `https://${ours[0].hostname}` : null;

  // A route to witden appeared: check it and use it, without another click.
  useEffect(() => {
    if (status?.state !== "connected" || !candidate || candidate === current) return;
    if (attempted.current.has(candidate)) return;
    attempted.current.add(candidate);
    void onUse(candidate);
  }, [status?.state, candidate, current, onUse]);

  if (!status) return null;
  if (!status.available)
    return (
      <div className="callout callout-wait">
        这个部署没有包含 Cloudflare Tunnel 服务。用代码仓中的 docker compose 部署时，在 .env 中加入{" "}
        <code>COMPOSE_PROFILES=tunnel</code>，执行 <code>docker compose up -d</code> 后刷新本页。
      </div>
    );

  const saveToken = async () => {
    setError(null);
    try {
      onStatus(await api.put<TunnelStatus>("/api/settings/tunnel", { token }));
      setSavedAt(Date.now());
      setToken("");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  // cloudflared retries about once a minute until it finds the token.
  const waitedLong = savedAt !== null && now - savedAt > 90_000;

  return (
    <>
      <p className="small muted">
        Cloudflare Tunnel 由 witden 旁边的 tunnel 服务主动连到 Cloudflare，不需要公网
        IP、开放端口或自己管理证书。需要一个托管在 Cloudflare 的域名。
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
                  已保存 tunnel <code>{status.token.tunnel.slice(0, 8)}</code>。更换 token 后，需要在服务器上执行{" "}
                  <code>docker compose restart tunnel</code>。
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
                  tunnel 服务没有运行：确认 .env 中有 <code>COMPOSE_PROFILES=tunnel</code>，并在服务器上执行{" "}
                  <code>docker compose up -d</code>。
                </span>
              ) : (
                <Tag tone="wait">等待 tunnel 服务读取 token（最长约 1 分钟）</Tag>
              )}
            </div>
          ) : null}
        </li>
        <li>
          在这个 tunnel 的 <b>Routes</b> 标签中点击 <b>Add route → Published application</b>：填写子域名（例如
          witden）并选择域名，<b>Service URL</b> 填 {origin ? <CopyText text={origin} /> : null}，点击 <b>Add route</b>
          。 路由生效后，witden 会自动发现它、检查并保存为公网地址。
          {routes.length ? (
            <ul className="plain-list setup-routes">
              {routes.map((r) => (
                <li key={r.hostname}>
                  <code>https://{r.hostname}</code> → <code>{r.service}</code>{" "}
                  {r.service.replace(/\/+$/, "") === origin ? (
                    <Tag tone="ok">指向 witden</Tag>
                  ) : (
                    <Tag tone="bad">Service URL 应为 {origin}</Tag>
                  )}
                </li>
              ))}
            </ul>
          ) : status.state === "connected" ? (
            <div className="small muted">还没有路由。</div>
          ) : null}
        </li>
      </ol>
      {candidate && busy ? <div className="small muted">正在检查 {candidate}…</div> : null}
      {/* A new DNS record can take a moment: the automatic check may fail once. */}
      <CheckResult tried={tried} busy={busy} onRetry={candidate ? () => void onUse(candidate) : undefined} />
    </>
  );
}

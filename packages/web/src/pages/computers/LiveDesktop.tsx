import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { buildUrl, getToken } from "../../api/client";

type Phase = "connecting" | "connected" | "closed";

// Close codes sent by /api/instances/{id}/vnc.
const CLOSE_REASON: Record<number, string> = {
  4401: "登录已失效，请重新登录后再连接。",
  4403: "你没有观察这台电脑的权限（需要「观察电脑」授权）。",
  4409: "这台电脑当前不是运行中的桌面电脑，启动后再连接。",
  4501: "当前的计算后端不提供实时画面（例如测试用的模拟后端），请使用下方的截图查看。",
  1011: "无法连接到电脑内的画面服务，请确认桌面环境已经启动。",
};

/**
 * Live view of a desktop computer through noVNC. `mode="control"` is only honoured by the server for the
 * person currently holding the takeover; everyone else silently gets the view-only stream, so the
 * canvas is also forced view-only on our side unless control was requested.
 */
export function LiveDesktop({ instanceId, mode, fallbackHint }: { instanceId: string; mode: "view" | "control"; fallbackHint?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const target = container.current;
    const token = getToken();
    if (!target || !token) return;
    setPhase("connecting");
    setMessage(null);
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}${buildUrl(`/api/instances/${instanceId}/vnc`, { access_token: token, mode })}`;
    let closeCode = 0;
    let connected = false;
    let disposed = false;
    const ws = new WebSocket(url, ["binary"]);
    ws.addEventListener("close", (e) => {
      closeCode = e.code;
    });
    let rfb: RFB | null = null;
    try {
      rfb = new RFB(target, ws, { shared: true });
      rfb.viewOnly = mode === "view";
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = mode === "control";
      rfb.background = "transparent";
      rfb.addEventListener("connect", () => {
        connected = true;
        setPhase("connected");
      });
      rfb.addEventListener("disconnect", () => {
        // Let the socket's own close event (with its code) land first.
        window.setTimeout(() => {
          if (disposed) return;
          setPhase("closed");
          const known = CLOSE_REASON[closeCode];
          if (known) setMessage(known);
          else if (!connected)
            setMessage(
              fallbackHint ?? "无法建立实时画面连接。可能是权限不足、电脑未运行或计算后端不支持实时画面，可以先使用截图查看。",
            );
          else setMessage("连接已断开。");
        }, 50);
      });
      rfb.addEventListener("securityfailure", () => {
        setMessage("画面服务拒绝了连接。");
      });
    } catch (err) {
      setPhase("closed");
      setMessage(`无法启动实时画面：${(err as Error).message}`);
    }
    return () => {
      disposed = true;
      try {
        rfb?.disconnect();
      } catch {
        ws.close();
      }
    };
  }, [instanceId, mode, attempt, fallbackHint]);

  return (
    <div className={`desktop desktop-${phase}${mode === "control" ? " desktop-control" : ""}`}>
      <div className="desktop-bar">
        <span className={`live-dot${phase === "connected" ? " live-on" : ""}`}>
          {phase === "connected" ? (mode === "control" ? "实时 · 可操作" : "实时 · 只读") : phase === "connecting" ? "连接中" : "未连接"}
        </span>
        {phase === "closed" ? (
          <button className="btn btn-xs" onClick={() => setAttempt((a) => a + 1)}>
            重新连接
          </button>
        ) : null}
      </div>
      <div className="desktop-screen" ref={container} />
      {message ? <div className="desktop-message">{message}</div> : null}
    </div>
  );
}

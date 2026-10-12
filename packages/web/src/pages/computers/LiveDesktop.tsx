import RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";
import { buildUrl, getToken } from "../../api/client";

type Phase = "connecting" | "connected" | "closed";

// Close codes sent by /api/instances/{id}/vnc (see packages/server/src/api/live.ts).
const CLOSE_REASON: Record<number, string> = {
  4401: "未登录或登录已失效，请重新登录后再连接。",
  4403: "你没有观察这台虚拟电脑的权限（需要对这台虚拟电脑的「观察虚拟电脑」授权）。",
  4409: "这台虚拟电脑当前不是运行中的桌面虚拟电脑，启动后再连接。",
  4501: "提供这个页面的服务进程没有运行 Runner 连接中心，无法转发实时画面。请检查部署：实时画面需要由运行 API 的进程提供。",
  1011: "无法通过 Runner 连接到虚拟电脑内的画面服务：Runner 未连接，或虚拟电脑里的桌面画面服务没有启动。可以先用下方的截图查看。",
};

/**
 * Live view of a desktop computer through noVNC. View-only by default; `mode="control"` is requested only
 * by the person holding the takeover, and the server re-checks that (anyone else silently gets the
 * view-only stream), so the canvas is also forced view-only on our side unless control was requested.
 */
export function LiveDesktop({
  instanceId,
  mode,
  fallbackHint,
}: {
  instanceId: string;
  mode: "view" | "control";
  fallbackHint?: string;
}) {
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
              fallbackHint ??
                "无法建立实时画面连接。可能是权限不足、虚拟电脑未运行或计算后端不支持实时画面，可以先使用截图查看。",
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
          {phase === "connected"
            ? mode === "control"
              ? "实时 · 可操作"
              : "实时 · 只读"
            : phase === "connecting"
              ? "连接中"
              : "未连接"}
        </span>
        {phase === "closed" ? (
          <button type="button" className="btn btn-xs" onClick={() => setAttempt((a) => a + 1)}>
            重新连接
          </button>
        ) : null}
      </div>
      <div className="desktop-screen" ref={container} />
      {message ? <div className="desktop-message">{message}</div> : null}
    </div>
  );
}

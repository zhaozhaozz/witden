import { useState } from "react";
import { useAction } from "../../ui/feedback";
import { Section } from "../../ui/kit";
import { PublicAddressIntro, PublicAddressSetup, PublicAddressStatus, usePublicAddress } from "../PublicAddress";

/**
 * The public event address and the Cloudflare Tunnel, outside any connection wizard. Same setting, endpoints
 * and checks as the wizards' "准备公网事件地址" step (pages/PublicAddress.tsx).
 */
export function PublicAddressTab() {
  const a = usePublicAddress();
  const [clearing, setClearing] = useState(false);
  const { run } = useAction();
  const { current, ready, busy } = a;

  const actions = (
    <>
      <button type="button" className="btn btn-xs" disabled={!current || busy} onClick={() => void a.recheck()}>
        重新检查
      </button>
      {current?.saved && !clearing ? (
        <button type="button" className="btn btn-xs btn-danger-ghost" onClick={() => setClearing(true)}>
          清除地址
        </button>
      ) : null}
      {clearing ? (
        <span className="small">
          清除后，各接入显示的事件地址和 AI 员工头像地址改按 WITDEN_PUBLIC_URL 生成，外部平台通常访问不到；已在
          Slack、GitHub、飞书中填写的地址不会自动改变。{" "}
          <button
            type="button"
            className="btn btn-xs btn-danger"
            disabled={busy}
            onClick={async () => {
              await run(() => a.clear(), "已清除公网事件地址");
              setClearing(false);
            }}
          >
            确认清除
          </button>{" "}
          <button type="button" className="btn btn-xs" onClick={() => setClearing(false)}>
            取消
          </button>
        </span>
      ) : null}
    </>
  );

  return (
    <>
      <Section title="公网事件地址">
        <div className="public-address">
          <PublicAddressIntro />
          <p className="small muted">
            Slack 默认的 Socket Mode 不需要公网地址；GitHub、飞书、选择“事件地址（HTTP）”的 Slack
            接入，以及通过公网地址把 Slack
            应用安装到其他工作区时需要。通讯接入设置向导中的“准备公网事件地址”一步保存的也是这里的设置，两处修改效果相同。
          </p>
          <PublicAddressStatus a={a} actions={actions} />
          {ready ? (
            <p className="small muted">
              witden 已经通过这个地址访问到自己的事件端口，并确认从这个地址打不开控制台；接入时平台还会再验证一次。
            </p>
          ) : null}
        </div>
      </Section>
      <Section title="设置方式">
        <div className="public-address">
          <PublicAddressSetup a={a} />
        </div>
      </Section>
    </>
  );
}

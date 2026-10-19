import { useState } from "react";
import { api } from "../api/client";
import type { Connection } from "../api/types";
import { useResource } from "../lib/hooks";
import { CopyText, Loaded, Tag } from "../ui/kit";

/** What a Feishu app applies for (server: integrations/feishu-tools.ts). */
export interface FeishuCatalog {
  base: { scope: string; name: string; purpose: string }[];
  products: {
    key: string;
    label: string;
    description: string;
    read: { scope: string; name: string }[];
    write: { scope: string; name: string }[];
  }[];
}

interface ScopeCheck {
  ok: boolean;
  error?: string;
  base?: { scope: string; name: string; granted: boolean }[];
  products?: { key: string; label: string; read: boolean; write: boolean; missing: string[] }[];
}

export const useFeishuCatalog = () => useResource(() => api.get<FeishuCatalog>("/api/integrations/feishu/catalog"), []);

/**
 * The permissions to apply for in the Feishu console: the base set every connection needs, and the products
 * picked for the Feishu tools. One JSON for 权限管理 → 批量导入/导出 applies for all of them.
 */
export function FeishuScopePicker({ catalog }: { catalog: FeishuCatalog }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const scopes = [
    ...catalog.base.map((s) => s.scope),
    ...catalog.products.filter((p) => picked.has(p.key)).flatMap((p) => p.write.map((s) => s.scope)),
  ];
  const text = JSON.stringify({ scopes: { tenant: scopes, user: [] } }, null, 2);
  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <>
      <table className="table table-compact setup-table">
        <thead>
          <tr>
            <th>基础权限</th>
            <th>名称</th>
            <th>用途</th>
          </tr>
        </thead>
        <tbody>
          {catalog.base.map((s) => (
            <tr key={s.scope}>
              <td>
                <code>{s.scope}</code>
              </td>
              <td>{s.name}</td>
              <td className="muted">{s.purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="setup-sub">
        扩展：飞书工具（可选）。勾选后，角色可以经 witden
        使用这家公司飞书中的这些功能；具体哪个角色能用、写入前是否要批准，在角色的权限中设置。
      </div>
      <div className="feishu-products">
        {catalog.products.map((p) => (
          <label key={p.key} className={`pick-item${picked.has(p.key) ? " pick-on" : ""}`}>
            <input type="checkbox" checked={picked.has(p.key)} onChange={() => toggle(p.key)} />
            <span>
              <b>{p.label}</b>
              <span className="small muted"> {p.description}</span>
              <span className="small feishu-scopes">
                {p.write.map((s) => (
                  <span key={s.scope}>
                    <code>{s.scope}</code> {s.name}
                  </span>
                ))}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="setup-field">
        <CopyText text={text} label={`权限列表（JSON，${scopes.length} 项）`} />
        <pre className="mono-block">{text}</pre>
      </div>
      <p className="small muted">
        是否需要审核以申请时页面上的标注为准，企业管理员可以调整。版本中有需要审核的权限时，整个版本要等企业管理员在飞书管理后台通过后才生效；不想等的话，可以先删掉那一项，以后再申请并发布新版本。
      </p>
    </>
  );
}

/** Which of them Feishu has granted this app, asked of Feishu when opened (and again on request). */
export function FeishuScopeCheck({ conn }: { conn: Connection }) {
  const res = useResource(() => api.get<ScopeCheck>(`/api/connections/${conn.id}/feishu-scopes`), [conn.id]);
  const catalog = useFeishuCatalog();
  const [adding, setAdding] = useState(false);
  return (
    <Loaded res={res}>
      {(check) =>
        !check.ok ? (
          <div className="callout callout-bad">
            没有读到飞书应用的权限：{check.error}{" "}
            <button type="button" className="btn btn-xs" onClick={() => void res.reload()}>
              重新检测
            </button>
          </div>
        ) : (
          <div className="feishu-check">
            <div className="feishu-check-row">
              <span className="feishu-check-name">基础权限</span>
              <span>
                {check.base!.every((s) => s.granted) ? (
                  <Tag tone="ok">已全部开通</Tag>
                ) : (
                  check
                    .base!.filter((s) => !s.granted)
                    .map((s) => (
                      <Tag key={s.scope} tone="bad" title={s.scope}>
                        未开通：{s.name}
                      </Tag>
                    ))
                )}
              </span>
            </div>
            {check.base!.some((s) => s.scope === "im:message:readonly" && !s.granted) ? (
              <div className="callout callout-bad">
                目前无法接收飞书中的图片和文件。请申请 im:message:readonly
                并发布新版本，等待审批生效后重新检测，再重新发送附件。 已开通 im:message 或 im:message.history:readonly
                也满足下载要求。
              </div>
            ) : null}
            {check.products!.map((p) => (
              <div key={p.key} className="feishu-check-row">
                <span className="feishu-check-name">{p.label}</span>
                <span>
                  {p.write ? (
                    <Tag tone="ok">可读写</Tag>
                  ) : p.read ? (
                    <Tag tone="wait">只读</Tag>
                  ) : (
                    <Tag tone="off">未开通</Tag>
                  )}
                  {!p.write && p.missing.length ? (
                    <span className="small muted"> 读写需要：{p.missing.join("、")}</span>
                  ) : null}
                </span>
              </div>
            ))}
            <div className="btn-row">
              <button type="button" className="btn btn-xs" onClick={() => void res.reload()}>
                重新检测
              </button>
              <button type="button" className="btn btn-xs" onClick={() => setAdding((v) => !v)}>
                {adding ? "收起" : "申请更多权限"}
              </button>
              <span className="small muted">在飞书中申请并发布新版本后，点“重新检测”。</span>
            </div>
            {adding ? <Loaded res={catalog}>{(c) => <FeishuScopePicker catalog={c} />}</Loaded> : null}
          </div>
        )
      }
    </Loaded>
  );
}

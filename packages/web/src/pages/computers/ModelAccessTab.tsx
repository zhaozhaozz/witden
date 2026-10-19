import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Instance, ModelConfig, ModelProxyInfo } from "../../api/types";
import { fmtRelative } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { useAuth } from "../../lib/session";
import { useUnsavedChanges } from "../../lib/unsaved";
import { useAction, useFeedback } from "../../ui/feedback";
import { CopyText, Empty, KV, Loaded, MultiPick, Section, Tag, Toggle } from "../../ui/kit";

const ENV_VARS = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "WITDEN_MODELS"];

/**
 * Model access for programs inside the computer: a local endpoint relayed by the runner to the platform, a
 * key issued for this computer only, and the list of models it may use.
 */
export function ModelAccessTab({ inst }: { inst: Instance }) {
  const { can } = useAuth();
  const manage = can("instance.manage");
  const res = useResource(() => api.get<ModelProxyInfo>(`/api/instances/${inst.id}/model-proxy`), [inst.id]);
  const models = useResource(() => api.get<ModelConfig[]>("/api/models"), [], manage);
  const { run, busy } = useAction();
  const { confirm } = useFeedback();
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    setPicked(res.data?.model_ids ?? []);
  }, [res.data]);

  const save = async (body: Record<string, unknown>, done: string): Promise<boolean> => {
    const out = await run(() => api.put<ModelProxyInfo>(`/api/instances/${inst.id}/model-proxy`, body), done);
    if (out) res.setData(out);
    return !!out;
  };
  // Models ticked but not saved.
  const unsaved = !!res.data && JSON.stringify([...picked].sort()) !== JSON.stringify([...res.data.model_ids].sort());
  useUnsavedChanges(manage && unsaved, () => save({ model_ids: picked }, "已保存"));

  return (
    <Loaded res={res}>
      {(p) => {
        const dirty = JSON.stringify([...picked].sort()) !== JSON.stringify([...p.model_ids].sort());
        return (
          <>
            <Section
              title="模型访问"
              actions={
                manage ? (
                  <Toggle
                    checked={p.enabled}
                    disabled={busy}
                    label={p.enabled ? "已开启" : "未开启"}
                    onChange={(on) => void save({ enabled: on }, on ? "已开启模型访问" : "已关闭模型访问")}
                  />
                ) : (
                  <Tag tone={p.enabled ? "ok" : undefined}>{p.enabled ? "已开启" : "未开启"}</Tag>
                )
              }
            >
              <p className="small muted">
                开启后，这台虚拟电脑里的程序（例如角色或成员自己安装的其他智能体、脚本）可以通过虚拟电脑内部的地址使用平台里的模型。虚拟电脑里只有这个内部地址和平台为它签发的密钥：真实的服务商地址和密钥不会进入虚拟电脑，这个密钥离开这台虚拟电脑也无法使用。下面的地址只在这台虚拟电脑内部有效，在你自己的电脑上访问不到。平台按下面的列表决定能用哪些模型，并按虚拟电脑记录用量。
              </p>
              {p.enabled ? (
                <KV
                  items={[
                    ["OpenAI 兼容地址", <CopyText key="o" text={p.endpoints.openai} />],
                    ["Anthropic 地址", <CopyText key="a" text={p.endpoints.anthropic} />],
                    ["System One 地址（Jev、Laya）", <CopyText key="s" text={p.endpoints.systemone} />],
                    [
                      "密钥",
                      <span key="k" className="inline-list">
                        {p.has_key ? "已签发（不可查看）" : <span className="muted">未签发</span>}
                        {manage && p.has_key ? (
                          <button
                            type="button"
                            className="btn btn-xs btn-danger-ghost"
                            disabled={busy}
                            onClick={async () => {
                              const ok = await confirm({
                                title: "更换密钥",
                                body: (
                                  <p>
                                    旧密钥立即失效。虚拟电脑在线时，新密钥会自动写入下面的环境变量文件；已经在运行的程序需要重启后才会读到。
                                  </p>
                                ),
                                confirmLabel: "更换",
                              });
                              if (!ok) return;
                              const out = await run(
                                () => api.post<ModelProxyInfo>(`/api/instances/${inst.id}/model-proxy/rotate-key`),
                                "已更换密钥",
                              );
                              if (out) res.setData(out);
                            }}
                          >
                            更换
                          </button>
                        ) : null}
                        {p.key_issued_at ? (
                          <span className="small muted">{fmtRelative(p.key_issued_at)}签发</span>
                        ) : null}
                      </span>,
                    ],
                    [
                      "环境变量",
                      <span key="e" className="small">
                        Runner 把它们写在 <code>{p.env_file}</code>，终端里的登录 shell 会自动加载：
                        {ENV_VARS.map((v) => (
                          <code key={v} className="id">
                            {v}
                          </code>
                        ))}
                      </span>,
                    ],
                  ]}
                />
              ) : null}
              {p.enabled && !p.runner_connected ? (
                <p className="small text-bad">虚拟电脑现在没有连上平台；Runner 连上后设置会自动生效。</p>
              ) : null}
            </Section>

            <Section
              title="允许使用的模型"
              actions={
                manage && dirty ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy}
                    onClick={() => void save({ model_ids: picked }, "已保存")}
                  >
                    保存
                  </button>
                ) : null
              }
            >
              {p.models.length ? (
                <table className="table">
                  <thead>
                    <tr>
                      <th>请求时使用的模型名</th>
                      <th>模型</th>
                      <th>接口</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.models.map((m) => (
                      <tr key={m.id} className={m.usable ? undefined : "row-muted"}>
                        <td>
                          <CopyText text={m.alias} />
                        </td>
                        <td>
                          {m.label}
                          {m.usable ? null : <span className="small text-bad">（已停用或密钥已撤销）</span>}
                        </td>
                        <td className="small">
                          {m.protocol === "anthropic"
                            ? "/v1/messages"
                            : m.protocol === "systemone"
                              ? "/v1/systemone"
                              : "/v1/chat/completions 等"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty title="还没有允许任何模型" hint={manage ? "在下面勾选模型后保存。" : undefined} />
              )}
              {manage ? (
                <div className="pick-section">
                  <div className="small muted">勾选这台虚拟电脑可以使用的模型（只能勾选你自己有权使用的模型）：</div>
                  <MultiPick
                    value={picked}
                    onChange={setPicked}
                    empty="还没有模型；先在「模型」页添加服务商和模型"
                    options={(models.data ?? []).map((m) => ({
                      value: m.id,
                      label: m.label,
                      hint: m.usable ? m.model : "已停用或密钥已撤销",
                    }))}
                  />
                </div>
              ) : null}
            </Section>
          </>
        );
      }}
    </Loaded>
  );
}

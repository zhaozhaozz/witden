import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Connection, ExplainResult, Instance, MatchKey, Rule, Topic } from "../api/types";
import { CONVERSATION_KIND } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useAuth, useDirectory } from "../lib/session";
import { useAction, useFeedback } from "../ui/feedback";
import { Empty, Field, FieldGroup, FormModal, Loaded, MultiPick, PageHeader, Section, Tag, Toggle } from "../ui/kit";
import { AssignmentTrace, zh, type NameLookups } from "../ui/trace";

const MATCH_LABEL: Record<MatchKey, string> = {
  topic_id: "话题",
  conversation_id: "外部会话",
  user_id: "成员",
  conversation_kind: "会话类型",
  connection_id: "通讯接入",
};
const MATCH_ORDER: MatchKey[] = ["topic_id", "conversation_id", "user_id", "conversation_kind", "connection_id"];

function useLookups() {
  const { can } = useAuth();
  const instances = useResource(() => api.get<Instance[]>("/api/instances").catch(() => [] as Instance[]), []);
  const topics = useResource(() => api.get<Topic[]>("/api/topics", { include_archived: true }), []);
  const connections = useResource(
    () => (can("connection.manage") ? api.get<Connection[]>("/api/connections") : Promise.resolve([] as Connection[])),
    [],
  );
  const lookups: NameLookups = useMemo(
    () => ({
      instanceName: (id) => instances.data?.find((i) => i.id === id)?.name,
      topicTitle: (id) => topics.data?.find((t) => t.id === id)?.title,
      connectionName: (id) => connections.data?.find((c) => c.id === id)?.name,
    }),
    [instances.data, topics.data, connections.data],
  );
  return { instances: instances.data ?? [], topics: topics.data ?? [], connections: connections.data ?? [], lookups };
}

export default function RulesPage() {
  const dir = useDirectory();
  const { confirm } = useFeedback();
  const { run } = useAction();
  const res = useResource(() => api.get<Rule[]>("/api/rules"), []);
  const ctx = useLookups();
  const [editing, setEditing] = useState<Rule | "new" | null>(null);

  const roleChips = (ids: string[] | null, emptyText: ReactNode) =>
    ids === null ? (
      emptyText
    ) : ids.length ? (
      <span className="inline-list">
        {ids.map((id) => (
          <Tag key={id}>{dir.roleById.get(id) ? `@${dir.roleById.get(id)!.handle}` : id}</Tag>
        ))}
      </span>
    ) : (
      <span className="text-bad">无</span>
    );

  const matchText = (r: Rule) => {
    const keys = MATCH_ORDER.filter((k) => r.match[k]);
    if (!keys.length) return <span className="muted">所有请求</span>;
    return (
      <span className="inline-list">
        {keys.map((k) => {
          const v = r.match[k]!;
          const shown =
            k === "user_id"
              ? dir.userName(v)
              : k === "topic_id"
                ? (ctx.lookups.topicTitle?.(v) ?? v)
                : k === "connection_id"
                  ? (ctx.lookups.connectionName?.(v) ?? v)
                  : k === "conversation_kind"
                    ? (CONVERSATION_KIND[v] ?? v)
                    : v;
          return (
            <Tag key={k}>
              {MATCH_LABEL[k]}：{shown}
            </Tag>
          );
        })}
      </span>
    );
  };

  return (
    <div className="page">
      <PageHeader
        title="分配规则"
        sub="决定一条请求可以交给哪些角色、在哪些电脑上执行。所有匹配的规则同时生效：允许范围取交集，拒绝优先；默认角色取最具体的规则（话题 > 外部会话 > 成员 > 会话类型 > 通讯接入 > 全局）。外部会话没有匹配规则时一律拒绝。"
        actions={
          <button className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
            新建规则
          </button>
        }
      />
      <div className="rules-layout">
        <Section title="规则" className="rules-list">
          <Loaded res={res}>
            {(rows) =>
              rows.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>规则</th>
                        <th>匹配</th>
                        <th>效果</th>
                        <th>允许的角色</th>
                        <th>排除</th>
                        <th>默认角色</th>
                        <th>允许的电脑</th>
                        <th title="具体度越高越优先决定默认角色；同级时优先级数字小的优先">具体度 / 优先级</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className={r.enabled ? undefined : "row-muted"}>
                          <td>
                            <div className="strong">{r.name}</div>
                            {r.description ? <div className="small muted">{r.description}</div> : null}
                            {!r.enabled ? <Tag tone="off">已停用</Tag> : null}
                          </td>
                          <td>{matchText(r)}</td>
                          <td>{r.effect === "deny" ? <Tag tone="bad">拒绝</Tag> : <Tag tone="ok">允许</Tag>}</td>
                          <td>{roleChips(r.allow_role_ids, <span className="muted">不限</span>)}</td>
                          <td>{r.deny_role_ids.length ? roleChips(r.deny_role_ids, null) : <span className="muted">—</span>}</td>
                          <td>{r.default_role_id ? `@${dir.roleById.get(r.default_role_id)?.handle ?? r.default_role_id}` : <span className="muted">—</span>}</td>
                          <td>
                            {r.allow_instance_ids === null ? (
                              <span className="muted">不限</span>
                            ) : r.allow_instance_ids.length ? (
                              <span className="inline-list">
                                {r.allow_instance_ids.map((id) => (
                                  <Tag key={id}>{ctx.lookups.instanceName?.(id) ?? id}</Tag>
                                ))}
                              </span>
                            ) : (
                              <span className="text-bad">无</span>
                            )}
                          </td>
                          <td className="nowrap">
                            {r.specificity} / {r.priority}
                          </td>
                          <td className="nowrap">
                            <div className="btn-row">
                              <button className="btn btn-xs" onClick={() => setEditing(r)}>
                                编辑
                              </button>
                              <button
                                className="btn btn-xs btn-danger-ghost"
                                onClick={async () => {
                                  if (!(await confirm({ title: `删除规则「${r.name}」`, danger: true, confirmLabel: "删除" }))) return;
                                  const out = await run(() => api.del(`/api/rules/${r.id}`), "规则已删除");
                                  if (out) void res.reload();
                                }}
                              >
                                删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="还没有规则"
                  hint="没有规则时，内部话题由参与的角色处理；来自 Slack 等外部会话的请求会被拒绝，直到添加覆盖它的规则。"
                />
              )
            }
          </Loaded>
        </Section>
        <ExplainPanel ctx={ctx} />
      </div>
      {editing ? (
        <RuleEditor
          rule={editing === "new" ? null : editing}
          ctx={ctx}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void res.reload();
          }}
        />
      ) : null}
    </div>
  );
}

type Ctx = ReturnType<typeof useLookups>;

function RuleEditor({ rule, ctx, onClose, onSaved }: { rule: Rule | null; ctx: Ctx; onClose: () => void; onSaved: () => void }) {
  const dir = useDirectory();
  const { run, busy } = useAction();
  const [name, setName] = useState(rule?.name ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [effect, setEffect] = useState(rule?.effect ?? "allow");
  const [match, setMatch] = useState<Partial<Record<MatchKey, string>>>(rule?.match ?? {});
  const [limitRoles, setLimitRoles] = useState(rule ? rule.allow_role_ids !== null : false);
  const [allowRoles, setAllowRoles] = useState<string[]>(rule?.allow_role_ids ?? []);
  const [denyRoles, setDenyRoles] = useState<string[]>(rule?.deny_role_ids ?? []);
  const [defaultRole, setDefaultRole] = useState(rule?.default_role_id ?? "");
  const [limitInstances, setLimitInstances] = useState(rule ? rule.allow_instance_ids !== null : false);
  const [allowInstances, setAllowInstances] = useState<string[]>(rule?.allow_instance_ids ?? []);
  const setM = (k: MatchKey, v: string) => setMatch((m) => ({ ...m, [k]: v || undefined }));
  const roleOptions = dir.roles.map((r) => ({ value: r.id, label: `${r.name} @${r.handle}` }));

  return (
    <FormModal
      title={rule ? `编辑规则「${rule.name}」` : "新建规则"}
      width={760}
      busy={busy}
      disabled={!name.trim()}
      onClose={onClose}
      onSubmit={async () => {
        const cleanMatch = Object.fromEntries(Object.entries(match).filter(([, v]) => v));
        const body = {
          name: name.trim(),
          description,
          enabled,
          priority: Number(priority) || 100,
          effect,
          match: cleanMatch,
          allow_role_ids: limitRoles ? allowRoles : null,
          deny_role_ids: denyRoles,
          default_role_id: defaultRole || null,
          allow_instance_ids: limitInstances ? allowInstances : null,
        };
        const out = await run(() => (rule ? api.patch(`/api/rules/${rule.id}`, body) : api.post("/api/rules", body)), "规则已保存");
        if (out) onSaved();
      }}
    >
      <div className="form-row">
        <Field label="名称">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：#dev 频道默认交给开发" />
        </Field>
        <Field label="效果">
          <select value={effect} onChange={(e) => setEffect(e.target.value as Rule["effect"])}>
            <option value="allow">允许（并限定范围）</option>
            <option value="deny">拒绝匹配的请求</option>
          </select>
        </Field>
        <Field label="优先级" hint="同一具体度时数字小的优先">
          <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
      </div>
      <Field label="说明">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Toggle checked={enabled} onChange={setEnabled} label="启用" />

      <FieldGroup label="匹配条件" hint="留空表示不限；条件越多越具体。" wide>
        <div className="form-grid">
          <Field label="话题">
            <select value={match.topic_id ?? ""} onChange={(e) => setM("topic_id", e.target.value)}>
              <option value="">不限</option>
              {ctx.topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="成员">
            <select value={match.user_id ?? ""} onChange={(e) => setM("user_id", e.target.value)}>
              <option value="">不限</option>
              {dir.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="会话类型">
            <select value={match.conversation_kind ?? ""} onChange={(e) => setM("conversation_kind", e.target.value)}>
              <option value="">不限</option>
              {Object.entries(CONVERSATION_KIND).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="通讯接入">
            {ctx.connections.length ? (
              <select value={match.connection_id ?? ""} onChange={(e) => setM("connection_id", e.target.value)}>
                <option value="">不限</option>
                {ctx.connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <input className="mono" value={match.connection_id ?? ""} onChange={(e) => setM("connection_id", e.target.value)} placeholder="接入 ID" />
            )}
          </Field>
          <Field label="外部会话 ID" hint="内部记录的会话 ID（在「通讯接入」中可查）">
            <input className="mono" value={match.conversation_id ?? ""} onChange={(e) => setM("conversation_id", e.target.value)} />
          </Field>
        </div>
      </FieldGroup>

      {effect === "allow" ? (
        <>
          <FieldGroup label="允许的角色" wide>
            <Toggle checked={limitRoles} onChange={setLimitRoles} label="只允许下列角色（不勾选表示不限制）" />
            {limitRoles ? <MultiPick columns={3} options={roleOptions} value={allowRoles} onChange={setAllowRoles} /> : null}
          </FieldGroup>
          <FieldGroup label="排除的角色" wide>
            <MultiPick columns={3} options={roleOptions} value={denyRoles} onChange={setDenyRoles} />
          </FieldGroup>
          <div className="form-row">
            <Field label="默认角色" hint="消息没有 @ 任何角色时由它处理">
              <select value={defaultRole} onChange={(e) => setDefaultRole(e.target.value)}>
                <option value="">无</option>
                {dir.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} @{r.handle}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <FieldGroup label="允许的电脑" hint="例如敏感话题只允许使用独立电脑上的角色" wide>
            <Toggle checked={limitInstances} onChange={setLimitInstances} label="只允许下列电脑" />
            {limitInstances ? (
              <MultiPick
                columns={3}
                options={ctx.instances.map((i) => ({ value: i.id, label: i.name }))}
                value={allowInstances}
                onChange={setAllowInstances}
                empty="没有可选的电脑（可能缺少查看电脑的权限）"
              />
            ) : null}
          </FieldGroup>
        </>
      ) : null}
    </FormModal>
  );
}

function ExplainPanel({ ctx }: { ctx: Ctx }) {
  const dir = useDirectory();
  const { me } = useAuth();
  const { run, busy } = useAction();
  const [userId, setUserId] = useState(me?.id ?? "");
  const [topicId, setTopicId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [kind, setKind] = useState("internal");
  const [roles, setRoles] = useState<string[]>([]);
  const [result, setResult] = useState<ExplainResult | null>(null);

  return (
    <Section title="规则检查" className="explain">
      <p className="small muted">模拟一条请求，查看会交给哪个角色、在哪台电脑上执行，以及每一步的判断依据。不会创建任务。</p>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const out = await run(() =>
            api.post<ExplainResult>("/api/rules/explain", {
              user_id: userId,
              topic_id: topicId || null,
              connection_id: connectionId || null,
              conversation_id: conversationId || null,
              conversation_kind: kind,
              requested_role_ids: roles,
            }),
          );
          if (out) setResult(out);
        }}
      >
        <div className="form-row">
          <Field label="请求人">
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              {dir.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="会话类型">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(CONVERSATION_KIND).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="话题">
          <select value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            <option value="">不指定</option>
            {ctx.topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </Field>
        {kind !== "internal" ? (
          <div className="form-row">
            <Field label="通讯接入">
              {ctx.connections.length ? (
                <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                  <option value="">不指定</option>
                  {ctx.connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="mono" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} />
              )}
            </Field>
            <Field label="外部会话 ID">
              <input className="mono" value={conversationId} onChange={(e) => setConversationId(e.target.value)} />
            </Field>
          </div>
        ) : null}
        <FieldGroup label="消息中 @ 的角色" hint="不选表示没有 @ 任何角色，由默认角色处理">
          <MultiPick columns={2} options={dir.roles.map((r) => ({ value: r.id, label: `@${r.handle}` }))} value={roles} onChange={setRoles} />
        </FieldGroup>
        <button className="btn btn-primary btn-sm" disabled={busy || !userId}>
          {busy ? "检查中…" : "检查"}
        </button>
      </form>
      {result ? (
        <div className="explain-result">
          <div className={`verdict verdict-${result.allowed ? "ok" : "bad"}`}>
            <strong>{result.allowed ? "允许" : "拒绝"}</strong>
            {result.allowed ? (
              <span>
                {result.candidates
                  .filter((c) => c.allowed)
                  .map((c) => `${dir.roleLabel(c.role_id)}${c.instance_id ? ` 在 ${ctx.lookups.instanceName?.(c.instance_id) ?? c.instance_id}` : ""}`)
                  .join("；")}
              </span>
            ) : (
              <span>{zh(result.reason ?? "")}</span>
            )}
          </div>
          <AssignmentTrace trace={result.trace} lookups={ctx.lookups} />
        </div>
      ) : null}
    </Section>
  );
}

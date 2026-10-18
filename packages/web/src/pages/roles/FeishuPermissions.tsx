import type { FeishuTools } from "../../api/types";

/**
 * What a role may do with each connected Feishu app (company), product by product: 禁用 / 只读 / 读写（写入需询问）
 * / 读写. Stored in the role's tool lists as ``feishu:<connection>:<product>:read|write``; a write level that
 * asks puts the write group in ``approval_required``. Every app is set on its own: allowing one company's
 * calendar allows nothing in another's.
 */
type Level = "off" | "read" | "write_ask" | "write";

const LABELS: Record<Level, [string, string]> = {
  off: ["禁用", "角色不能使用"],
  read: ["只读", "可以查看，不能创建或修改"],
  write_ask: ["读写，写入需询问", "查看直接进行；创建或修改前由有审批权限的人批准"],
  write: ["读写", "查看、创建和修改都直接进行"],
};

export const feishuGroup = (app: string, product: string, mode: "read" | "write") => `feishu:${app}:${product}:${mode}`;

function levelOf(app: string, product: string, allowed: string[], approval: string[]): Level {
  const write = feishuGroup(app, product, "write");
  if (allowed.includes(write)) return approval.includes(write) ? "write_ask" : "write";
  return allowed.includes(feishuGroup(app, product, "read")) ? "read" : "off";
}

/** What Feishu has granted each app, per product (from /api/connections/:id/feishu-scopes); absent while unknown. */
export type FeishuGranted = Record<string, Record<string, { read: boolean; write: boolean }> | null>;

export function FeishuPermissions({
  data,
  granted,
  allowed,
  approval,
  onChange,
}: {
  data: FeishuTools;
  granted?: FeishuGranted;
  allowed: string[];
  approval: string[];
  onChange: (allowed: string[], approval: string[]) => void;
}) {
  if (!data.apps.length) return null;
  const set = (app: string, product: FeishuTools["products"][number], level: Level) => {
    const read = feishuGroup(app, product.key, "read");
    const write = feishuGroup(app, product.key, "write");
    const nextAllowed = allowed.filter((g) => g !== read && g !== write);
    const nextApproval = approval.filter((g) => g !== read && g !== write);
    if (level !== "off" && product.read.length) nextAllowed.push(read);
    if (level === "write" || level === "write_ask") nextAllowed.push(write);
    if (level === "write_ask") nextApproval.push(write);
    onChange(nextAllowed.sort(), nextApproval.sort());
  };
  return (
    <div className="perm-list feishu-perms">
      {data.apps.map((app) => (
        <div key={app.id} className="perm-group">
          <div className="perm-app">飞书 · {app.name}</div>
          {data.products.map((p) => {
            const level = levelOf(app.id, p.key, allowed, approval);
            const options: Level[] = [
              "off",
              ...(p.read.length ? (["read"] as Level[]) : []),
              ...(p.write.length ? (["write_ask", "write"] as Level[]) : []),
            ];
            return (
              <div key={p.key} className={`perm-row ${level === "off" ? "perm-group-off" : ""}`}>
                <div className="perm-text">
                  <div className="perm-name">
                    {p.label}
                    <GrantNote status={granted?.[app.id]?.[p.key]} level={level} />
                  </div>
                  <div className="perm-hint">{p.description}</div>
                </div>
                <div className="segmented perm-choice" role="radiogroup" aria-label={`${app.name} ${p.label}`}>
                  {options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      role="radio"
                      aria-checked={level === o}
                      title={LABELS[o][1]}
                      className={`seg ${o === "off" ? "perm-off" : o === "write_ask" ? "perm-ask" : "perm-allow"}${level === o ? " seg-on" : ""}`}
                      onClick={() => set(app.id, p, o)}
                    >
                      {LABELS[o][0]}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Whether the app can do in Feishu what the role is allowed here. */
function GrantNote({ status, level }: { status?: { read: boolean; write: boolean }; level: Level }) {
  if (!status) return null;
  if (status.write) return null;
  if (!status.read) return <span className="perm-mixed">飞书应用未开通</span>;
  return level === "write" || level === "write_ask" ? <span className="perm-mixed">飞书应用只开通了只读</span> : null;
}

import type { PlatformTools } from "../../api/types";

/**
 * What a role may do with each connection of a platform (a Feishu app / company, a GitHub account or App), product
 * by product: 禁用 / 只读 / 读写（写入需询问）/ 读写. Stored in the role's tool lists as
 * ``<platform>:<connection>:<product>:read|write``; a write level that asks puts the write group in
 * ``approval_required``. Every connection is set on its own: allowing one company's calendar allows nothing in
 * another's.
 */
type Level = "off" | "read" | "write_ask" | "write";
export type ToolPlatform = "feishu" | "github";

const LABELS: Record<Level, [string, string]> = {
  off: ["禁用", "AI 员工不能使用"],
  read: ["只读", "可以查看，不能创建或修改"],
  write_ask: ["读写，写入需询问", "查看直接进行；创建或修改前由有审批权限的人批准"],
  write: ["读写", "查看、创建和修改都直接进行"],
};

const PLATFORM_NAME: Record<ToolPlatform, string> = { feishu: "飞书", github: "GitHub" };

const toolGroup = (platform: ToolPlatform, conn: string, product: string, mode: "read" | "write") =>
  `${platform}:${conn}:${product}:${mode}`;

/** What Feishu has granted each app, per product (from /api/connections/:id/feishu-scopes); absent while unknown. */
export type FeishuGranted = Record<string, Record<string, { read: boolean; write: boolean }> | null>;

export function ConnectionToolPermissions({
  platform,
  data,
  granted,
  allowed,
  approval,
  onChange,
}: {
  platform: ToolPlatform;
  data: PlatformTools;
  granted?: FeishuGranted;
  allowed: string[];
  approval: string[];
  onChange: (allowed: string[], approval: string[]) => void;
}) {
  if (!data.apps.length) return null;
  const group = (conn: string, product: string, mode: "read" | "write") => toolGroup(platform, conn, product, mode);
  const levelOf = (conn: string, product: string): Level => {
    const write = group(conn, product, "write");
    if (allowed.includes(write)) return approval.includes(write) ? "write_ask" : "write";
    return allowed.includes(group(conn, product, "read")) ? "read" : "off";
  };
  const set = (conn: string, product: PlatformTools["products"][number], level: Level) => {
    const read = group(conn, product.key, "read");
    const write = group(conn, product.key, "write");
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
          <div className="perm-app">
            {PLATFORM_NAME[platform]} · {app.name}
            {app.acts_as ? (
              <span className="perm-app-note">
                以 @{app.acts_as} 的身份{app.auth_only ? "（只作为认证）" : ""}
              </span>
            ) : null}
          </div>
          {data.products.map((p) => {
            const level = levelOf(app.id, p.key);
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

/** Whether the Feishu app can do in Feishu what the role is allowed here. */
function GrantNote({ status, level }: { status?: { read: boolean; write: boolean }; level: Level }) {
  if (!status) return null;
  if (status.write) return null;
  if (!status.read) return <span className="perm-mixed">飞书应用未开通</span>;
  return level === "write" || level === "write_ask" ? <span className="perm-mixed">飞书应用只开通了只读</span> : null;
}

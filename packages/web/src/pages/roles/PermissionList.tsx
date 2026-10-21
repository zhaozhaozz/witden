import { Fragment, type ReactNode, useState } from "react";
import type { ToolGroup } from "../../api/types";
import { PERMISSION_SECTIONS, TOOL_GROUP_HINT, TOOL_GROUP_LABEL, TOOL_LABEL } from "../../lib/format";

/**
 * Everything a role may do, sorted into sections by kind, each row set to 始终允许 / 询问 / 禁用.
 *
 * It edits the role's two stored lists: ``allowed_tools`` (tool groups the role may use at all) and
 * ``approval_required`` (groups or single tools that need a person's approval each time). The server enables
 * and disables whole groups only, so single tools offer 始终允许 / 询问 under an enabled group.
 */
export type Level = "allow" | "ask" | "off";

const LEVELS: { value: Level; label: string; title: string }[] = [
  { value: "allow", label: "始终允许", title: "直接使用，不需要批准" },
  { value: "ask", label: "询问", title: "每次使用前由有审批权限的人批准" },
  { value: "off", label: "禁用", title: "角色不能使用" },
];

export function groupLevel(group: string, allowed: string[], approval: string[]): Level {
  if (!allowed.includes(group)) return "off";
  return approval.includes(group) ? "ask" : "allow";
}

/** New (allowed, approval) after setting a whole group; it also clears that group's per-tool settings. */
export function setGroupLevel(
  group: ToolGroup,
  level: Level,
  allowed: string[],
  approval: string[],
): { allowed: string[]; approval: string[] } {
  const name = group.group!;
  const mine = new Set([name, ...group.tools]);
  const rest = approval.filter((a) => !mine.has(a));
  return {
    allowed: level === "off" ? allowed.filter((a) => a !== name) : [...new Set([...allowed, name])],
    approval: level === "ask" ? [...rest, name] : rest,
  };
}

/** The platform's default for new roles, as (allowed, approval) lists. */
export function defaultPermissions(groups: ToolGroup[]): { allowed: string[]; approval: string[] } {
  const allowed: string[] = [];
  const approval: string[] = [];
  for (const g of groups) {
    if (!g.group || g.default_level === "off") continue;
    allowed.push(g.group);
    if (g.default_level === "ask") approval.push(g.group);
    else approval.push(...(g.default_ask ?? []));
  }
  return { allowed: allowed.sort(), approval: approval.sort() };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function Choice({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: Level | null;
  options: Level[];
  onChange: (v: Level) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="segmented perm-choice" role="radiogroup" aria-label={label}>
      {LEVELS.filter((l) => options.includes(l.value)).map((l) => (
        <button
          key={l.value}
          type="button"
          role="radio"
          aria-checked={value === l.value}
          className={`seg perm-${l.value}${value === l.value ? " seg-on" : ""}`}
          title={l.title}
          disabled={disabled}
          onClick={() => onChange(l.value)}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A section of the list besides the tool groups (e.g. a connected app's tools), shown after the built-in section
 * ``after``, or at the end — after every built-in section — without one (apps come and go, so they go last);
 * several in the same place keep their order.
 */
export interface ExtraSection {
  key: string;
  after?: string;
  label: string;
  hint?: string;
  content: ReactNode;
}

/**
 * The role's permissions, by kind (``PERMISSION_SECTIONS``): its virtual computer, automation, material on the
 * platform, itself. ``details`` adds the settings that belong to a tool group under its row (which knowledge
 * spaces it may read); ``extra`` adds sections of their own.
 */
export function PermissionList({
  groups,
  alwaysTools,
  allowed,
  approval,
  onChange,
  defaults,
  details = {},
  extra = [],
}: {
  groups: ToolGroup[];
  /** Tools every role has (asking people, progress notes, follow-ups). */
  alwaysTools: string[];
  allowed: string[];
  approval: string[];
  onChange: (allowed: string[], approval: string[]) => void;
  /** Offer "恢复默认" when the settings differ from these. */
  defaults?: { allowed: string[]; approval: string[] } | null;
  details?: Record<string, ReactNode>;
  extra?: ExtraSection[];
}) {
  // Approvals for always-available tools are not shown here, nor the Feishu and GitHub tools of each connection
  // (ConnectionToolPermissions): keep them when restoring defaults.
  const always = approval.filter((a) => alwaysTools.includes(a));
  const isGrant = (x: string) => /^(feishu|github):/.test(x);
  const grants = (xs: string[]) => xs.filter(isGrant);
  const isDefault =
    !defaults ||
    (sameSet(
      allowed.filter((x) => !isGrant(x)),
      defaults.allowed,
    ) &&
      sameSet(
        approval.filter((x) => !isGrant(x)),
        [...defaults.approval, ...always],
      ));
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (g: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const byName = new Map(groups.map((g) => [g.group!, g]));
  const listed = new Set(PERMISSION_SECTIONS.flatMap((sec) => sec.groups));
  const sections = [
    ...PERMISSION_SECTIONS.map((sec) => ({
      ...sec,
      rows: sec.groups.map((name) => byName.get(name)).filter((g): g is ToolGroup => !!g),
    })),
    // A group the console does not know yet still shows up, under 其他.
    {
      key: "other",
      label: "其他",
      hint: "",
      groups: [],
      rows: groups.filter((g) => !listed.has(g.group!)),
    },
  ].filter((sec) => sec.rows.length);

  const row = (g: ToolGroup) => {
    const name = g.group!;
    const level = groupLevel(name, allowed, approval);
    const asking = level === "allow" ? g.tools.filter((t) => approval.includes(t)) : [];
    // Some tools ask while the rest are allowed: no single answer for the group.
    const shown = asking.length ? null : level;
    const expanded = open.has(name) || asking.length > 0;
    const groupLabel = TOOL_GROUP_LABEL[name] ?? name;
    const detail = details[name];
    return (
      <div key={name} className={`perm-group perm-group-${level}`}>
        <div className="perm-row">
          <button
            type="button"
            className="perm-expand"
            aria-expanded={expanded}
            title={expanded ? "收起" : "逐个工具设置"}
            onClick={() => toggle(name)}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          <div className="perm-text">
            <div className="perm-name">
              {groupLabel}
              {asking.length ? <span className="perm-mixed">其中 {asking.length} 项需询问</span> : null}
            </div>
            <div className="perm-hint">{TOOL_GROUP_HINT[name] ?? g.description}</div>
          </div>
          <Choice
            label={groupLabel}
            value={shown}
            options={["allow", "ask", "off"]}
            onChange={(v) => {
              const next = setGroupLevel(g, v, allowed, approval);
              onChange(next.allowed, next.approval);
            }}
          />
        </div>
        {expanded ? (
          <div className="perm-tools">
            {g.tools.map((t) => {
              const toolLevel: Level = level === "allow" ? (approval.includes(t) ? "ask" : "allow") : level;
              return (
                <div key={t} className="perm-row perm-tool">
                  <div className="perm-text">
                    <div className="perm-name">{TOOL_LABEL[t] ?? t}</div>
                    <div className="perm-hint mono">{t}</div>
                  </div>
                  <Choice
                    label={TOOL_LABEL[t] ?? t}
                    value={toolLevel}
                    options={level === "off" ? ["off"] : ["allow", "ask"]}
                    // Single tools follow a group set to 询问 or 禁用; only an allowed group can mix.
                    disabled={level !== "allow"}
                    onChange={(v) =>
                      onChange(allowed, v === "ask" ? [...approval, t] : approval.filter((a) => a !== t))
                    }
                  />
                </div>
              );
            })}
            {level !== "allow" ? (
              <div className="perm-note">
                整组设为「{level === "ask" ? "询问" : "禁用"}
                」时，其中每个工具都相同；设为「始终允许」后可以单独要求询问。
              </div>
            ) : null}
          </div>
        ) : null}
        {detail ? (
          <div className={`perm-detail${level === "off" ? " perm-detail-off" : ""}`}>
            {detail}
            {level === "off" ? <div className="perm-note">「{groupLabel}」禁用时，这项设置不起作用。</div> : null}
          </div>
        ) : null}
      </div>
    );
  };

  const head = (label: string, hint?: string) => (
    <div className="perm-section-head">
      <span className="perm-section-title">{label}</span>
      {hint ? <span className="perm-section-hint">{hint}</span> : null}
    </div>
  );

  return (
    <div className="perm-sections">
      {sections.map((sec) => (
        <Fragment key={sec.key}>
          <section className="perm-section">
            {head(sec.label, sec.hint)}
            <div className="perm-list">{sec.rows.map(row)}</div>
          </section>
          {extra
            .filter((x) => x.after === sec.key)
            .map((x) => (
              <section key={x.key} className="perm-section">
                {head(x.label, x.hint)}
                {x.content}
              </section>
            ))}
        </Fragment>
      ))}
      {extra
        .filter((x) => !x.after || !sections.some((sec) => sec.key === x.after))
        .map((x) => (
          <section key={x.key} className="perm-section">
            {head(x.label, x.hint)}
            {x.content}
          </section>
        ))}
      <div className="perm-always">
        <span>
          {alwaysTools.length
            ? `始终可用，不受这里限制：${alwaysTools.map((t) => TOOL_LABEL[t] ?? t).join("、")}`
            : null}
        </span>
        {defaults && !isDefault ? (
          <button
            type="button"
            className="btn btn-xs"
            title="虚拟电脑里的操作（包括把其中的文件分享到话题）始终允许；联系其他角色、平台记忆和修改自己的职责说明需要询问；读取其他话题禁用。飞书和 GitHub 工具不变。"
            onClick={() =>
              onChange(
                [...defaults.allowed, ...grants(allowed)],
                [...defaults.approval, ...always, ...grants(approval)],
              )
            }
          >
            恢复默认
          </button>
        ) : null}
      </div>
    </div>
  );
}

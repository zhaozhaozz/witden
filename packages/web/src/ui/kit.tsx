import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { genericStatus, hueOf, initials, type StatusMeta, shortId, type Tone } from "../lib/format";

// --- status ----------------------------------------------------------------------------------------

export function StatusChip({ meta, reason, compact }: { meta: StatusMeta; reason?: string | null; compact?: boolean }) {
  return (
    <span className={`chip chip-${meta.tone}`} title={reason ?? undefined}>
      <span className="chip-dot" aria-hidden />
      {meta.label}
      {!compact && reason ? <span className="chip-reason">{reason}</span> : null}
    </span>
  );
}

export function Status({ value, reason }: { value: string; reason?: string | null }) {
  return <StatusChip meta={genericStatus(value)} reason={reason} compact />;
}

export function Tag({ children, tone, title }: { children: ReactNode; tone?: Tone | "accent"; title?: string }) {
  return (
    <span className={`tag${tone ? ` tag-${tone}` : ""}`} title={title}>
      {children}
    </span>
  );
}

/** Reason line under a status: the "why" is always visible, never hidden in a tooltip only. */
export function Reason({ children, tone = "info" }: { children: ReactNode; tone?: Tone }) {
  if (!children) return null;
  return <div className={`reason reason-${tone}`}>{children}</div>;
}

// --- identity --------------------------------------------------------------------------------------

export function Avatar({
  id,
  name,
  kind,
  size = 28,
  src,
  color,
}: {
  id: string;
  name: string;
  kind: "role" | "user" | "system";
  size?: number;
  src?: string | null;
  /** A chosen badge colour (roles); otherwise a stable hue derived from the id. */
  color?: string | null;
}) {
  const style = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.42),
    "--hue": hueOf(id),
    ...(color ? { "--avatar-color": color } : {}),
  } as CSSProperties;
  const cls = `avatar avatar-${kind}${color ? " avatar-colored" : ""}`;
  if (src) return <img className={cls} style={style} src={src} alt="" />;
  return (
    <span className={cls} style={style} aria-hidden>
      {initials(name)}
    </span>
  );
}

/** Colour of a role or computer badge: the chosen one, or a stable colour derived from the id. */
export function badgeColor(id: string, color?: string | null): string {
  return color || `hsl(${hueOf(id)} 46% 42%)`;
}

export interface RoleLike {
  id: string;
  name: string;
  handle?: string | null;
  color?: string | null;
  avatar_url?: string | null;
}

/** A role wherever it appears: avatar, name and @handle in the role's colour. */
export function RoleBadge({ role, compact, title }: { role: RoleLike; compact?: boolean; title?: string }) {
  return (
    <span
      className="badge badge-role"
      style={{ "--badge": badgeColor(role.id, role.color) } as CSSProperties}
      title={title ?? (role.handle ? `${role.name} @${role.handle}` : role.name)}
    >
      <Avatar id={role.id} name={role.name} kind="role" size={16} src={role.avatar_url} color={role.color} />
      {compact && role.handle ? null : <span className="badge-name">{role.name}</span>}
      {role.handle ? <span className="badge-handle">@{role.handle}</span> : null}
    </span>
  );
}

export interface ComputerLike {
  id: string;
  name: string;
  color?: string | null;
}

/** A computer wherever it appears: a screen icon and its name in the computer's colour. */
export function ComputerBadge({ computer, title }: { computer: ComputerLike; title?: string }) {
  return (
    <span
      className="badge badge-computer"
      style={{ "--badge": badgeColor(computer.id, computer.color) } as CSSProperties}
      title={title ?? `虚拟电脑 ${computer.name}`}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
        <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M5.5 14h5M8 11.5V14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span className="badge-name">{computer.name}</span>
    </span>
  );
}

/** The first four characters of a name (by character, so Chinese names keep whole characters). */
const shortName = (name: string) => [...name].slice(0, 4).join("");

/**
 * Who or what, where space is short (the sidebar): a box in its colour with an icon and a four-character
 * abbreviation. ``off`` fades it (a computer that is not running).
 */
function MarkChip({
  id,
  color,
  icon,
  text,
  title,
  off,
}: {
  id: string;
  color?: string | null;
  icon: ReactNode;
  text: string;
  title: string;
  off?: boolean;
}) {
  return (
    <span
      className={`mark-chip${off ? " mark-chip-off" : ""}`}
      style={{ "--badge": badgeColor(id, color) } as CSSProperties}
      title={title}
    >
      {icon}
      <span className="mark-chip-name">{text}</span>
    </span>
  );
}

/** A computer as a chip: screen icon and the first four characters of its name; faded when not running. */
export function ComputerChip({
  computer,
  running,
  title,
}: {
  computer: ComputerLike;
  /** null: state unknown (shown as running). */
  running?: boolean | null;
  title?: string;
}) {
  const off = running === false;
  return (
    <MarkChip
      id={computer.id}
      color={computer.color}
      off={off}
      title={title ?? `虚拟电脑 ${computer.name}${off ? "（未运行）" : ""}`}
      text={shortName(computer.name)}
      icon={
        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
          <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M5.5 13.5h5M8 11v2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      }
    />
  );
}

/** A role as a chip: robot icon and the first four characters of its @-name (or its name). */
export function RoleChip({ role, title }: { role: RoleLike; title?: string }) {
  return (
    <MarkChip
      id={role.id}
      color={role.color}
      title={title ?? (role.handle ? `角色 ${role.name} @${role.handle}` : `角色 ${role.name}`)}
      text={shortName(role.handle || role.name)}
      icon={
        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
          <path d="M8 1.2v2.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <rect x="2.5" y="3.5" width="11" height="9.5" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="6" cy="8.2" r="1.2" fill="currentColor" />
          <circle cx="10" cy="8.2" r="1.2" fill="currentColor" />
          <path d="M1 7.2v3M15 7.2v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      }
    />
  );
}

export const BADGE_COLORS = [
  "#1e6fd9",
  "#0b7285",
  "#0f9d58",
  "#5c940d",
  "#b7791f",
  "#d9480f",
  "#c92a2a",
  "#c2255c",
  "#9c36b5",
  "#6741d9",
  "#495057",
];

/** Preset swatches, a custom colour, or automatic (null: derived from the id). */
export function ColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null | undefined;
  onChange: (color: string | null) => void;
  disabled?: boolean;
}) {
  const current = value?.toLowerCase() ?? null;
  return (
    <div className="color-picker" role="radiogroup" aria-label="颜色">
      <button
        type="button"
        className={`swatch swatch-auto${current ? "" : " swatch-on"}`}
        disabled={disabled}
        aria-pressed={!current}
        title="自动：按名称生成固定的颜色"
        onClick={() => onChange(null)}
      >
        自动
      </button>
      {BADGE_COLORS.map((c) => (
        <button
          type="button"
          key={c}
          className={`swatch${current === c ? " swatch-on" : ""}`}
          style={{ background: c }}
          disabled={disabled}
          aria-pressed={current === c}
          title={c}
          onClick={() => onChange(c)}
        />
      ))}
      <label className="swatch-custom" title="自定义颜色">
        <input
          type="color"
          value={current ?? "#1e6fd9"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="small">自定义</span>
      </label>
    </div>
  );
}

export function Handle({ handle }: { handle: string }) {
  return <span className="handle">@{handle}</span>;
}

export function IdText({ id, full }: { id: string | null | undefined; full?: boolean }) {
  if (!id) return <span className="muted">—</span>;
  return (
    <code className="id" title={id}>
      {full ? id : shortId(id)}
    </code>
  );
}

// --- layout ----------------------------------------------------------------------------------------

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`section${className ? ` ${className}` : ""}`}>
      {title || actions ? (
        <div className="section-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="section-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {hint ? <p className="empty-hint">{hint}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Loading({ label = "加载中" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: string | null | undefined; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="error-note" role="alert">
      <span>{error}</span>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

/** Standard loading / error / content switch for a `useResource` result. */
export function Loaded<T>({
  res,
  children,
}: {
  res: { data: T | undefined; error: string | null; loading: boolean; reload: () => void };
  children: (data: T) => ReactNode;
}) {
  if (res.data === undefined) {
    if (res.error) return <ErrorNote error={res.error} onRetry={res.reload} />;
    return <Loading />;
  }
  return (
    <>
      {res.error ? <ErrorNote error={res.error} onRetry={res.reload} /> : null}
      {children(res.data)}
    </>
  );
}

export interface TabDef {
  key: string;
  label: ReactNode;
  hidden?: boolean;
  badge?: number;
}

export function Tabs({ tabs, value, onChange }: { tabs: TabDef[]; value: string; onChange: (key: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button
            type="button"
            key={t.key}
            role="tab"
            aria-selected={t.key === value}
            className={t.key === value ? "tab tab-on" : "tab"}
            onClick={() => onChange(t.key)}
          >
            {t.label}
            {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
          </button>
        ))}
    </div>
  );
}

// --- forms -----------------------------------------------------------------------------------------

/** A field's name with its short explanation right next to it (wrapping below it when long). */
function FieldHead({ label, hint, id }: { label: ReactNode; hint?: ReactNode; id?: string }) {
  return (
    <span className="field-head">
      <span className="field-label" id={id}>
        {label}
      </span>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </span>
  );
}

export function Field({
  label,
  description,
  hint,
  children,
  wide,
}: {
  label: ReactNode;
  /** What to enter and where to find it, shown right above the input. */
  description?: ReactNode;
  /** A short explanation, shown next to the label. */
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`field${wide ? " field-wide" : ""}`}>
      <FieldHead label={label} hint={hint} />
      {description ? <span className="field-desc">{description}</span> : null}
      {children}
    </label>
  );
}

/** Field wrapper for groups of controls (checkbox lists) where a <label> would steal clicks. */
export function FieldGroup({
  label,
  hint,
  children,
  wide,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  return (
    <div className={`field${wide ? " field-wide" : ""}`} role="group" aria-labelledby={id}>
      <FieldHead label={label} hint={hint} id={id} />
      {children}
    </div>
  );
}

export interface PickOption {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

/** Checkbox list for choosing several values. */
export function MultiPick({
  options,
  value,
  onChange,
  empty = "没有可选项",
  columns,
}: {
  options: PickOption[];
  value: string[];
  onChange: (next: string[]) => void;
  empty?: string;
  columns?: number;
}) {
  if (!options.length) return <span className="muted small">{empty}</span>;
  const set = new Set(value);
  return (
    <div className="pick" style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
      {options.map((o) => (
        <label key={o.value} className={`pick-item${set.has(o.value) ? " pick-on" : ""}`}>
          <input
            type="checkbox"
            checked={set.has(o.value)}
            disabled={o.disabled}
            onChange={(e) => {
              const next = new Set(set);
              if (e.target.checked) next.add(o.value);
              else next.delete(o.value);
              onChange(options.map((x) => x.value).filter((v) => next.has(v)));
            }}
          />
          <span className="pick-text">
            <span>{o.label}</span>
            {o.hint ? <span className="pick-hint">{o.hint}</span> : null}
          </span>
        </label>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  /** What the switch does, shown right under its label. */
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle${hint ? " toggle-with-hint" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      {hint ? (
        <span className="toggle-text">
          <span>{label}</span>
          <span className="field-hint">{hint}</span>
        </span>
      ) : (
        <span>{label}</span>
      )}
    </label>
  );
}

// --- overlays --------------------------------------------------------------------------------------

export function Modal({
  title,
  children,
  footer,
  onClose,
  width,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    // Move focus into the dialog unless a child already claimed it via autoFocus.
    const t = window.setTimeout(() => {
      if (panel.current && !panel.current.contains(document.activeElement)) {
        const first = panel.current.querySelector<HTMLElement>("input, textarea, select, button.btn-primary");
        first?.focus();
      }
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" ref={panel} style={width ? { width } : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Dialog containing a form: Enter submits, the primary button shows progress. */
export function FormModal({
  title,
  children,
  onClose,
  onSubmit,
  submitLabel = "保存",
  busy,
  danger,
  width,
  disabled,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel?: string;
  busy?: boolean;
  danger?: boolean;
  width?: number;
  disabled?: boolean;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={width}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="modal-form"
            className={danger ? "btn btn-danger" : "btn btn-primary"}
            disabled={busy || disabled}
          >
            {busy ? "处理中…" : submitLabel}
          </button>
        </>
      }
    >
      <form
        id="modal-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !disabled) onSubmit();
        }}
      >
        {children}
      </form>
    </Modal>
  );
}

// --- data display ----------------------------------------------------------------------------------

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} className="kv-row">
          <dt>{k}</dt>
          <dd>{v ?? <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function JsonBlock({ value, maxHeight }: { value: unknown; maxHeight?: number }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="mono-block" style={maxHeight ? { maxHeight } : undefined}>
      {text}
    </pre>
  );
}

export function CopyText({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="copy">
      <code className="id">{label ?? text}</code>
      <button
        type="button"
        className="btn btn-xs"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          } catch {
            // clipboard unavailable (non-secure context); the text stays selectable
          }
        }}
      >
        {done ? "已复制" : "复制"}
      </button>
    </span>
  );
}

export function Capability({
  label,
  value,
  error,
  falseLabel = "不支持",
}: {
  label: string;
  value: boolean | null | undefined;
  error?: string;
  falseLabel?: string;
}) {
  const tone = value === true ? "ok" : value === false ? "bad" : "off";
  const mark = value === true ? "支持" : value === false ? falseLabel : "未检测";
  return (
    <span className={`cap cap-${tone}`} title={error}>
      <span className="cap-name">{label}</span>
      <span className="cap-val">{mark}</span>
    </span>
  );
}

/** Shows task text, or a neutral marker when the backend withheld it ("[restricted]"). */
export function Guarded({ text, label = "受限内容" }: { text: string | null | undefined; label?: string }) {
  if (text === "[restricted]")
    return (
      <span className="restricted" title="这部分内容来自你无权查看的资料，已隐藏">
        {label}
      </span>
    );
  return <>{text}</>;
}

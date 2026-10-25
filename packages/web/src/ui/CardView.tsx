import { useMemo, useState } from "react";
import { api } from "../api/client";
import type { CardBlock, CardInput, CardLeafBlock, Message, StoredCard } from "../api/types";
import { fmtTime } from "../lib/format";
import { CardChart } from "./CardChart";
import { useAction } from "./feedback";
import { Markdown } from "./Markdown";

/**
 * A card a role posted (the server's services/cards.ts): its blocks, its inputs and buttons. Tabs, table sorting
 * and the charts' hover and table view work here; a button sends the inputs' values to the server, which records
 * the action on the card and hands it to the role (the card then shows who chose what, live everywhere).
 */
type Values = Record<string, unknown>;

function initialValues(blocks: CardBlock[]): Values {
  const out: Values = {};
  const walk = (list: CardBlock[]) => {
    for (const b of list)
      if (b.type === "input")
        out[b.name] = b.default ?? (b.kind === "multiselect" ? [] : b.kind === "checkbox" ? false : "");
      else if (b.type === "tabs") for (const t of b.tabs) walk(t.blocks);
  };
  walk(blocks);
  return out;
}

function SortableTable({ block }: { block: Extract<CardLeafBlock, { type: "table" }> }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return block.rows;
    return [...block.rows].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      const nx = typeof x === "number" ? x : Number(x);
      const ny = typeof y === "number" ? y : Number(y);
      const cmp =
        Number.isFinite(nx) && Number.isFinite(ny) && x !== "" && y !== ""
          ? nx - ny
          : String(x ?? "").localeCompare(String(y ?? ""), "zh");
      return cmp * sort.dir;
    });
  }, [block.rows, sort]);
  return (
    <div className="table-wrap wcard-table">
      <table className="table table-compact">
        <thead>
          <tr>
            {block.columns.map((c) => (
              <th
                key={c.key}
                style={{ textAlign: c.align ?? "left" }}
                className="wcard-sortable"
                onClick={() =>
                  setSort((s) =>
                    s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 },
                  )
                }
                title="点击排序"
              >
                {c.label}
                {sort?.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {block.columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align ?? "left" }}>
                  {r[c.key] === null || r[c.key] === undefined ? "" : String(r[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({
  input,
  value,
  disabled,
  onChange,
}: {
  input: CardInput;
  value: unknown;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const id = `card-${input.name}`;
  const label = (
    <span className="wcard-label">
      {input.label}
      {input.required ? <span className="wcard-required"> *</span> : null}
    </span>
  );
  switch (input.kind) {
    case "checkbox":
      return (
        <label className="wcard-check">
          <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
      );
    case "multiselect": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset className="wcard-field" disabled={disabled}>
          <legend>{label}</legend>
          <div className="wcard-options">
            {(input.options ?? []).map((o) => (
              <label key={o.value} className="wcard-check">
                <input
                  type="checkbox"
                  checked={chosen.includes(o.value)}
                  onChange={(e) =>
                    onChange(e.target.checked ? [...chosen, o.value] : chosen.filter((v) => v !== o.value))
                  }
                />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    case "select":
      return (
        <label className="wcard-field" htmlFor={id}>
          {label}
          <select id={id} value={String(value ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
            <option value="">{input.placeholder || "请选择"}</option>
            {(input.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      );
    case "textarea":
      return (
        <label className="wcard-field" htmlFor={id}>
          {label}
          <textarea
            id={id}
            rows={3}
            value={String(value ?? "")}
            placeholder={input.placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
    default:
      return (
        <label className="wcard-field" htmlFor={id}>
          {label}
          <input
            id={id}
            type={input.kind === "number" ? "number" : input.kind === "date" ? "date" : "text"}
            value={String(value ?? "")}
            placeholder={input.placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
  }
}

function Tabs({
  block,
  render,
}: {
  block: Extract<CardBlock, { type: "tabs" }>;
  render: (b: CardLeafBlock, key: string) => React.ReactNode;
}) {
  const [at, setAt] = useState(0);
  return (
    <div className="wcard-tabs">
      <div className="segmented" role="tablist">
        {block.tabs.map((t, i) => (
          <button
            key={t.label}
            type="button"
            role="tab"
            aria-selected={i === at}
            className={i === at ? "seg seg-on" : "seg"}
            onClick={() => setAt(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* every tab stays mounted, so inputs in a hidden tab keep what was typed */}
      {block.tabs.map((t, i) => (
        <div key={t.label} role="tabpanel" hidden={i !== at} className="wcard-blocks">
          {t.blocks.map((b, j) => render(b, `${i}-${j}`))}
        </div>
      ))}
    </div>
  );
}

export function CardView({
  card,
  messageId,
  topicId,
  canAct,
  onChange,
}: {
  card: StoredCard;
  messageId: string;
  topicId: string;
  /** The reader may act (a participant of an open topic). */
  canAct: boolean;
  onChange?: (msg: Message) => void;
}) {
  const { spec, state } = card;
  const [values, setValues] = useState<Values>(() => initialValues(spec.blocks));
  const { run, busy } = useAction();
  const closed = state.closed;
  const disabled = closed || !canAct || busy;

  const act = async (action: string) => {
    const out = await run(() =>
      api.post<{ message: Message }>(`/api/topics/${topicId}/messages/${messageId}/card-actions`, { action, values }),
    );
    if (out) onChange?.(out.message);
  };

  const render = (b: CardLeafBlock | CardBlock, key: string): React.ReactNode => {
    switch (b.type) {
      case "text":
        return <Markdown key={key} content={b.text} />;
      case "fields":
        return (
          <dl key={key} className="wcard-fields">
            {b.items.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        );
      case "table":
        return <SortableTable key={key} block={b} />;
      case "chart":
        return <CardChart key={key} chart={b} />;
      case "list":
        return (
          <ul key={key} className="wcard-list">
            {b.items.map((it, i) => (
              <li key={i}>
                <div className="wcard-list-title">
                  {it.title}
                  {it.badge ? <span className="tag">{it.badge}</span> : null}
                </div>
                {it.subtitle ? <div className="small muted">{it.subtitle}</div> : null}
              </li>
            ))}
          </ul>
        );
      case "progress": {
        const max = b.max ?? 100;
        const pct = Math.max(0, Math.min(100, Math.round((b.value / max) * 100)));
        return (
          <div key={key} className="wcard-progress">
            <div className="wcard-progress-head">
              <span>{b.label ?? ""}</span>
              <span className="muted">{pct}%</span>
            </div>
            <div
              className="wcard-progress-track"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="wcard-progress-bar" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      }
      case "divider":
        return <hr key={key} className="wcard-divider" />;
      case "tabs":
        return <Tabs key={key} block={b} render={render} />;
      case "input":
        return (
          <Field
            key={key}
            input={b}
            value={values[b.name]}
            disabled={disabled}
            onChange={(v) => setValues((prev) => ({ ...prev, [b.name]: v }))}
          />
        );
    }
  };

  const buttons = spec.actions ?? [];
  return (
    <div className={`wcard wcard-${spec.color ?? "default"}`}>
      {spec.title ? (
        <div className="wcard-head">
          <div className="wcard-title">{spec.title}</div>
          {spec.subtitle ? <div className="wcard-subtitle">{spec.subtitle}</div> : null}
        </div>
      ) : null}
      <div className="wcard-blocks">{spec.blocks.map((b, i) => render(b, String(i)))}</div>
      {buttons.length ? (
        <div className="wcard-actions">
          {buttons.map((a) =>
            a.url ? (
              <a key={a.id} className="btn btn-sm" href={a.url} target="_blank" rel="noreferrer">
                {a.label} ↗
              </a>
            ) : (
              <button
                key={a.id}
                type="button"
                className={`btn btn-sm${a.style === "primary" ? " btn-primary" : a.style === "danger" ? " btn-danger" : ""}`}
                disabled={disabled}
                onClick={() => void act(a.id)}
              >
                {a.label}
              </button>
            ),
          )}
          {closed ? (
            <span className="small muted">已关闭</span>
          ) : !canAct ? (
            <span className="small muted">只能查看</span>
          ) : null}
        </div>
      ) : null}
      {state.actions.length ? (
        <ul className="wcard-done">
          {state.actions.map((a) => (
            <li key={`${a.user_id}-${a.at}`}>
              ✓ {a.user_name} 选择了「{a.label}」
              <span className="muted">
                {" "}
                · {fmtTime(a.at)}
                {a.via === "feishu" ? " · 飞书" : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

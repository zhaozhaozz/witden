import { useMemo, useState } from "react";

/**
 * A card's chart (bar, line or pie) as SVG. Series take the categorical slots in fixed order (the validated light
 * palette: adjacent pairs pass the colour-vision checks for up to six series); identity never rests on colour
 * alone — two or more series get a legend, and every chart can be read as a table. Hovering shows the values:
 * a crosshair on lines, the mark under the pointer on bars and slices.
 */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];

type Chart = {
  kind: "bar" | "line" | "pie";
  title?: string;
  labels: string[];
  series: { name: string; values: number[] }[];
  unit?: string;
};

const W = 560;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 40, left: 44 };

const fmt = (v: number, unit?: string) =>
  `${Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`;

/** Round steps for the value axis: 0 included, about five ticks. */
function ticks(min: number, max: number): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max) || 1;
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** A bar whose free end is rounded (4px) and whose base sits flat on the zero line. */
function barPath(x: number, y0: number, y1: number, w: number): string {
  const up = y1 < y0;
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, w / 2, h);
  if (up)
    return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`;
  return `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 - r} V${y0} Z`;
}

function Legend({ items }: { items: { name: string; color: string; value?: string }[] }) {
  return (
    <ul className="wchart-legend">
      {items.map((it) => (
        <li key={it.name}>
          <span className="wchart-swatch" style={{ background: it.color }} />
          {it.name}
          {it.value ? <span className="muted"> {it.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function DataTable({ chart }: { chart: Chart }) {
  return (
    <div className="table-wrap">
      <table className="table table-compact">
        <thead>
          <tr>
            <th />
            {chart.series.map((s) => (
              <th key={s.name} className="num">
                {s.name}
                {chart.unit ? `（${chart.unit}）` : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.labels.map((l, i) => (
            <tr key={`${l}-${i}`}>
              <td>{l}</td>
              {chart.series.map((s) => (
                <td key={s.name} className="num">
                  {s.values[i] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Bars and lines on one value axis. */
function XYChart({ chart }: { chart: Chart }) {
  const [hover, setHover] = useState<number | null>(null);
  const all = chart.series.flatMap((s) => s.values);
  const axis = ticks(Math.min(...all, 0), Math.max(...all, 0));
  const lo = axis[0];
  const hi = axis[axis.length - 1];
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const band = plotW / chart.labels.length;
  const cx = (i: number) => PAD.left + band * i + band / 2;
  const every = Math.ceil(chart.labels.length / 12);
  const n = chart.series.length;
  const barW = Math.max(2, Math.min(28, (band * 0.7) / n - 2));
  const groupW = n * barW + (n - 1) * 2;

  return (
    <div className="wchart-plot" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.title ?? "图表"}>
        {axis.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="wchart-grid" />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="wchart-tick">
              {t.toLocaleString()}
            </text>
          </g>
        ))}
        {chart.labels.map((l, i) =>
          i % every === 0 ? (
            <text key={`${l}-${i}`} x={cx(i)} y={H - PAD.bottom + 16} textAnchor="middle" className="wchart-tick">
              {l.length > 10 ? `${l.slice(0, 9)}…` : l}
            </text>
          ) : null,
        )}
        {chart.kind === "bar"
          ? chart.series.map((s, si) =>
              s.values.map((v, i) => (
                <path
                  key={`${si}-${i}`}
                  d={barPath(cx(i) - groupW / 2 + si * (barW + 2), y(0), y(v), barW)}
                  fill={SERIES[si % SERIES.length]}
                  opacity={hover === null || hover === i ? 1 : 0.55}
                />
              )),
            )
          : chart.series.map((s, si) => (
              <g key={s.name}>
                <polyline
                  points={s.values.map((v, i) => `${cx(i)},${y(v)}`).join(" ")}
                  fill="none"
                  stroke={SERIES[si % SERIES.length]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
                {hover !== null && s.values[hover] !== undefined ? (
                  <circle
                    cx={cx(hover)}
                    cy={y(s.values[hover])}
                    r={4}
                    fill={SERIES[si % SERIES.length]}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                ) : null}
              </g>
            ))}
        {chart.kind === "line" && hover !== null ? (
          <line x1={cx(hover)} x2={cx(hover)} y1={PAD.top} y2={PAD.top + plotH} className="wchart-cross" />
        ) : null}
        {/* hit areas wider than the marks: one per category */}
        {chart.labels.map((l, i) => (
          <rect
            key={`hit-${l}-${i}`}
            x={PAD.left + band * i}
            y={PAD.top}
            width={band}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {hover !== null ? (
        <div
          className="wchart-tip"
          style={{
            left: `${(cx(hover) / W) * 100}%`,
            transform: hover > chart.labels.length / 2 ? "translateX(-105%)" : "translateX(5%)",
          }}
        >
          <div className="wchart-tip-head">{chart.labels[hover]}</div>
          {chart.series.map((s, si) => (
            <div key={s.name} className="wchart-tip-row">
              <span className="wchart-swatch" style={{ background: SERIES[si % SERIES.length] }} />
              <span>{s.name}</span>
              <b>{s.values[hover] === undefined ? "—" : fmt(s.values[hover], chart.unit)}</b>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A donut: at most six slices, the rest folded into “其他”. */
function PieChart({ chart }: { chart: Chart }) {
  const [hover, setHover] = useState<number | null>(null);
  const slices = useMemo(() => {
    const raw = chart.labels.map((label, i) => ({ label, value: Math.max(0, chart.series[0]?.values[i] ?? 0) }));
    if (raw.length <= SERIES.length) return raw;
    const head = [...raw].sort((a, b) => b.value - a.value).slice(0, SERIES.length - 1);
    const rest = raw.filter((r) => !head.includes(r)).reduce((t, r) => t + r.value, 0);
    return [...head, { label: "其他", value: rest }];
  }, [chart]);
  const total = slices.reduce((t, s) => t + s.value, 0) || 1;
  const R = 80;
  const r = 50;
  let angle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const a0 = angle;
    const a1 = angle + (s.value / total) * Math.PI * 2;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${100 + rad * Math.cos(a)},${100 + rad * Math.sin(a)}`;
    const d =
      a1 - a0 >= Math.PI * 2 - 1e-6
        ? `M${p(R, 0)} A${R},${R} 0 1 1 ${p(R, Math.PI)} A${R},${R} 0 1 1 ${p(R, 0)} M${p(r, 0)} A${r},${r} 0 1 0 ${p(r, Math.PI)} A${r},${r} 0 1 0 ${p(r, 0)} Z`
        : `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z`;
    return { d, color: SERIES[i % SERIES.length], ...s };
  });
  const shown = hover === null ? null : arcs[hover];
  return (
    <div className="wchart-pie" onMouseLeave={() => setHover(null)}>
      <svg viewBox="0 0 200 200" role="img" aria-label={chart.title ?? "饼图"}>
        {arcs.map((a, i) => (
          <path
            key={a.label}
            d={a.d}
            fill={a.color}
            stroke="var(--surface)"
            strokeWidth={2}
            opacity={hover === null || hover === i ? 1 : 0.55}
            onMouseEnter={() => setHover(i)}
          />
        ))}
        <text x={100} y={96} textAnchor="middle" className="wchart-center">
          {shown ? `${Math.round((shown.value / total) * 100)}%` : fmt(total, chart.unit)}
        </text>
        <text x={100} y={114} textAnchor="middle" className="wchart-tick">
          {shown ? shown.label : "合计"}
        </text>
      </svg>
      <Legend
        items={arcs.map((a) => ({
          name: a.label,
          color: a.color,
          value: `${fmt(a.value, chart.unit)} · ${Math.round((a.value / total) * 100)}%`,
        }))}
      />
    </div>
  );
}

export function CardChart({ chart }: { chart: Chart }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="wchart">
      <figcaption className="wchart-head">
        <span>
          {chart.title ?? ""}
          {chart.unit && chart.kind !== "pie" ? <span className="muted">（{chart.unit}）</span> : null}
        </span>
        <button type="button" className="btn btn-xs btn-ghost" onClick={() => setAsTable((t) => !t)}>
          {asTable ? "图表" : "数据表"}
        </button>
      </figcaption>
      {asTable ? (
        <DataTable chart={chart} />
      ) : chart.kind === "pie" ? (
        <PieChart chart={chart} />
      ) : (
        <>
          <XYChart chart={chart} />
          {chart.series.length > 1 ? (
            <Legend items={chart.series.map((s, i) => ({ name: s.name, color: SERIES[i % SERIES.length] }))} />
          ) : null}
        </>
      )}
    </figure>
  );
}

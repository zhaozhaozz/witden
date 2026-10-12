import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef, useState } from "react";

const STORE = "witden.sidebar.";
/** The main column keeps at least this much room. */
const MAIN_MIN = 360;

/**
 * Drag handle on the edge of a sidebar column. Place it as a direct child of the two-column grid: the
 * width lives in the grid's `--side-w` CSS variable (the stylesheet supplies the default) and is
 * remembered per `name` in localStorage. Double-click restores the default; arrow keys nudge it.
 */
export function ResizeHandle({
  name,
  side,
  min = 160,
  max = 640,
}: {
  name: string;
  /** Where the sidebar sits: "start" = left column, "end" = right column. */
  side: "start" | "end";
  min?: number;
  max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState<number | null>(null);

  const grid = () => ref.current?.parentElement ?? null;
  const clamp = (w: number) => {
    const room = (grid()?.clientWidth ?? max + MAIN_MIN) - MAIN_MIN;
    return Math.round(Math.max(min, Math.min(max, room, w)));
  };
  const current = () => {
    const g = grid();
    if (!g) return min;
    const cols = getComputedStyle(g).gridTemplateColumns.split(" ").map(Number.parseFloat);
    return side === "start" ? cols[0] : cols[cols.length - 1];
  };
  const apply = (width: number | null, persist: boolean) => {
    const g = grid();
    if (!g) return;
    if (width === null) g.style.removeProperty("--side-w");
    else g.style.setProperty("--side-w", `${width}px`);
    setNow(width ?? Math.round(current()));
    if (!persist) return;
    try {
      if (width === null) localStorage.removeItem(STORE + name);
      else localStorage.setItem(STORE + name, String(width));
    } catch {
      // storage unavailable: the width still applies for this page view
    }
  };

  // Restore the remembered width once per layout.
  useLayoutEffect(() => {
    let saved = 0;
    try {
      saved = Number(localStorage.getItem(STORE + name));
    } catch {
      // ignore
    }
    if (saved > 0) apply(clamp(saved), false);
    else setNow(Math.round(current()));
    // A narrower window must not squeeze the main column away.
    const refit = () => {
      if (grid()?.style.getPropertyValue("--side-w")) apply(clamp(current()), false);
    };
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, [name]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startW = current();
    let width = startW;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("resize-active");
    document.body.classList.add("resizing");
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - startX;
      width = clamp(side === "start" ? startW + dx : startW - dx);
      apply(width, false);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.classList.remove("resize-active");
      document.body.classList.remove("resizing");
      if (width !== startW) apply(width, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = (e.shiftKey ? 64 : 16) * (e.key === "ArrowRight" ? 1 : -1);
    apply(clamp(current() + (side === "start" ? step : -step)), true);
  };

  return (
    <div
      ref={ref}
      className={`resize-handle resize-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={now ?? min}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label="拖动调整宽度（双击恢复默认）"
      title="拖动调整宽度，双击恢复默认"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => apply(null, true)}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * A window that floats over the page: drag its bar to move it, drag an edge or corner to resize it.
 * The position is kept per browser under ``storageKey`` and stays inside the viewport.
 */
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Edge = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EDGES: Exclude<Edge, "move">[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const MIN_W = 320;
const MIN_H = 260;

function fit(r: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(Math.max(r.w, MIN_W), vw - 16);
  const h = Math.min(Math.max(r.h, MIN_H), vh - 16);
  // Keep the bar reachable: at least 120px of the window stays on screen, and its top never leaves it.
  const x = Math.min(Math.max(r.x, 120 - w), vw - 120);
  const y = Math.min(Math.max(r.y, 8), vh - 48);
  return { x, y, w, h };
}

function moved(start: Rect, edge: Edge, dx: number, dy: number): Rect {
  if (edge === "move") return { ...start, x: start.x + dx, y: start.y + dy };
  let { x, y, w, h } = start;
  if (edge.includes("e")) w = Math.max(MIN_W, start.w + dx);
  if (edge.includes("s")) h = Math.max(MIN_H, start.h + dy);
  // Dragging the left or top edge keeps the opposite edge where it was.
  if (edge.includes("w")) {
    w = Math.max(MIN_W, start.w - dx);
    x = start.x + start.w - w;
  }
  if (edge.includes("n")) {
    h = Math.max(MIN_H, start.h - dy);
    y = start.y + start.h - h;
  }
  return { x, y, w, h };
}

function initial(storageKey: string, fallback: () => Rect): Rect {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (saved && ["x", "y", "w", "h"].every((k) => typeof saved[k] === "number")) return fit(saved);
  } catch {
    // ignore a broken entry
  }
  return fit(fallback());
}

export function useFloatingWindow(storageKey: string, fallback: () => Rect) {
  const [rect, setRect] = useState<Rect>(() => initial(storageKey, fallback));
  const drag = useRef<{ edge: Edge; sx: number; sy: number; start: Rect } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(rect));
    } catch {
      // storage unavailable: the position still applies for this page view
    }
  }, [rect, storageKey]);

  useEffect(() => {
    const onResize = () => setRect((r) => fit(r));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** Pointer handlers for the bar ("move") or an edge; the pointer is captured so the page below never sees it. */
  const handle = useCallback(
    (edge: Edge) => ({
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (e.button !== 0 || (edge === "move" && (e.target as HTMLElement).closest("button, a, input"))) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { edge, sx: e.clientX, sy: e.clientY, start: rect };
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (d) setRect(fit(moved(d.start, d.edge, e.clientX - d.sx, e.clientY - d.sy)));
      },
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      },
    }),
    [rect],
  );

  const style = { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
  return { rect, style, handle };
}

/** Invisible grips along the edges and corners of a floating window. */
export function ResizeGrips({ handle }: { handle: ReturnType<typeof useFloatingWindow>["handle"] }) {
  return (
    <>
      {EDGES.map((edge) => (
        <div key={edge} className={`float-grip float-grip-${edge}`} aria-hidden {...handle(edge)} />
      ))}
    </>
  );
}

/**
 * A small element (e.g. a button) that can be dragged anywhere in the viewport. A press that moves less
 * than a few pixels is a click; a drag never triggers ``onClick``. The position is kept under ``storageKey``.
 */
export function useDraggable(
  storageKey: string,
  size: { w: number; h: number },
  fallback: () => { x: number; y: number },
) {
  const place = useCallback(
    (p: { x: number; y: number }) => ({
      x: Math.min(Math.max(p.x, 8), window.innerWidth - size.w - 8),
      y: Math.min(Math.max(p.y, 8), window.innerHeight - size.h - 8),
    }),
    [size.w, size.h],
  );
  const [pos, setPos] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (saved && typeof saved.x === "number" && typeof saved.y === "number") return place(saved);
    } catch {
      // ignore a broken entry
    }
    return place(fallback());
  });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ sx: number; sy: number; start: { x: number; y: number }; moved: boolean } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(pos));
    } catch {
      // storage unavailable
    }
  }, [pos, storageKey]);
  useEffect(() => {
    const onResize = () => setPos((p) => place(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [place]);

  const bind = (onClick: () => void) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { sx: e.clientX, sy: e.clientY, start: pos, moved: false };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      if (!d.moved) setDragging(true);
      d.moved = true;
      setPos(place({ x: d.start.x + dx, y: d.start.y + dy }));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      drag.current = null;
      setDragging(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      if (d && !d.moved) onClick();
    },
    onPointerCancel: () => {
      drag.current = null;
      setDragging(false);
    },
    // Keyboard users still open it with Enter / Space.
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
  });

  return { style: { left: pos.x, top: pos.y }, dragging, bind };
}

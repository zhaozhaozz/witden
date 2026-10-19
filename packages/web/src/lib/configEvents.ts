import { useEffect, useRef } from "react";

/**
 * Configuration changed somewhere — in another browser, by another person, or by the system administrator
 * role — and the console should fetch it again. The server names only the area ("roles", "users", "models",
 * "computers", "connections", "knowledge", "settings"); the always-open stream (lib/topics.tsx) passes it on
 * here, and lists that show that area reload.
 */
const changes = new EventTarget();

export function announceConfigChange(area: string): void {
  changes.dispatchEvent(new CustomEvent<string>("change", { detail: area }));
}

/** Call ``reload`` when one of ``areas`` changes; bursts (several changes in a row) become one call. */
export function useConfigChanged(areas: string[], reload: () => unknown): void {
  const ref = useRef(reload);
  ref.current = reload;
  const key = areas.join(",");
  useEffect(() => {
    const wanted = new Set(key.split(","));
    let timer: number | undefined;
    const onChange = (e: Event) => {
      if (!wanted.has((e as CustomEvent<string>).detail)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void ref.current(), 300);
    };
    changes.addEventListener("change", onChange);
    return () => {
      window.clearTimeout(timer);
      changes.removeEventListener("change", onChange);
    };
  }, [key]);
}

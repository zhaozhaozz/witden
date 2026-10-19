/**
 * Unsaved changes are not lost without asking. Forms say whether they hold changes (and how to save them) with
 * useUnsavedChanges; one provider keeps the page's single navigation blocker. Leaving for another page inside
 * the console asks whether to save, leave without saving, or stay; reloading or closing the tab shows the
 * browser's own prompt (browsers show no text of a page there). Switches that stay on the page but take a form
 * away (another tab of a panel, another item of a list) ask the same through useLeaveGuard.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import { useFeedback } from "../ui/feedback";

interface Entry {
  dirty: boolean;
  /** Resolves true once saved; absent when the form cannot be saved from outside. */
  save?: () => Promise<boolean>;
}

type Registry = Set<{ current: Entry }>;

interface Unsaved {
  registry: Registry;
  /** Whether the forms holding changes may be left (asks only when there are some). */
  mayLeave: () => Promise<boolean>;
  dirty: () => boolean;
}

const UnsavedContext = createContext<Unsaved | null>(null);

export function UnsavedProvider({ children }: { children: ReactNode }) {
  const registry = useRef<Registry>(new Set()).current;
  const { choose, toast } = useFeedback();
  const dirtyForms = useCallback(() => [...registry].filter((r) => r.current.dirty), [registry]);
  // One question at a time; a second click while it is open is ignored.
  const asking = useRef(false);

  const mayLeave = useCallback(async () => {
    const forms = dirtyForms();
    if (!forms.length) return true;
    if (asking.current) return false;
    asking.current = true;
    const savable = forms.every((f) => f.current.save);
    try {
      const choice = await choose({
        title: "有未保存的修改",
        body: <p>离开后，还没有保存的修改会丢失。</p>,
        choices: [
          ...(savable ? [{ key: "save", label: "保存并离开", tone: "primary" as const }] : []),
          { key: "leave", label: "不保存，离开", tone: savable ? undefined : ("danger" as const) },
          { key: "stay", label: "继续编辑" },
        ],
      });
      if (choice !== "save") return choice === "leave";
      // A form that could not be saved (invalid, refused) keeps the person with it.
      let saved = true;
      for (const f of forms) if (!(await f.current.save?.())) saved = false;
      if (!saved) toast("修改没有保存成功，仍留在这里。请检查后再保存。", "bad");
      return saved;
    } finally {
      asking.current = false;
    }
  }, [choose, toast, dirtyForms]);

  // Another page, another query (tabs live in it): both replace what is on screen.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyForms().length > 0 &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );

  useEffect(() => {
    if (blocker.state !== "blocked" || asking.current) return;
    void mayLeave().then((go) => (go ? blocker.proceed() : blocker.reset()));
  }, [blocker, mayLeave]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyForms().length) return;
      e.preventDefault();
      // older browsers ask only when a value is returned
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyForms]);

  const value = useMemo(
    () => ({ registry, mayLeave, dirty: () => dirtyForms().length > 0 }),
    [registry, mayLeave, dirtyForms],
  );
  return <UnsavedContext.Provider value={value}>{children}</UnsavedContext.Provider>;
}

/**
 * For switches inside a page that take a form away: ``guard(go)`` runs ``go`` at once when nothing is unsaved,
 * otherwise after the person chose to save or to drop the changes.
 */
export function useLeaveGuard(): (go: () => void) => void {
  const ctx = useContext(UnsavedContext);
  return useCallback(
    (go: () => void) => {
      if (!ctx?.dirty()) return go();
      void ctx.mayLeave().then((ok) => ok && go());
    },
    [ctx],
  );
}

/**
 * Register a form's unsaved changes. ``save`` resolves true when saved (false keeps the person on the page).
 * Returns ``allow``: the form's own navigation right after saving goes through, before its state catches up.
 */
export function useUnsavedChanges(dirty: boolean, save?: () => Promise<boolean>): { allow: () => void } {
  const registry = useContext(UnsavedContext)?.registry;
  const entry = useRef<Entry>({ dirty, save });
  entry.current = { dirty, save };
  useEffect(() => {
    if (!registry) return;
    registry.add(entry);
    return () => {
      registry.delete(entry);
    };
  }, [registry]);
  return {
    allow: () => {
      entry.current = { ...entry.current, dirty: false };
    },
  };
}

/**
 * Whether a form's values differ from what they were when it opened. ``reset`` takes the values now as saved
 * (for forms that stay open after saving).
 */
export function useChanged(value: unknown): [boolean, () => void] {
  const json = JSON.stringify(value);
  const [initial, setInitial] = useState(json);
  return [json !== initial, () => setInitial(json)];
}

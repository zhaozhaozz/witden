import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { ApiError, errorMessage } from "../api/client";
import { Modal } from "./kit";

type ToastTone = "info" | "ok" | "bad";

interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
}

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** A question with more than two answers; the first choice is the default. */
export interface ChoiceOptions {
  title: string;
  body?: ReactNode;
  choices: { key: string; label: string; tone?: "primary" | "danger" }[];
}

interface FeedbackState {
  toast: (text: string, tone?: ToastTone) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** The key of the choice taken, or null when the dialog was closed. */
  choose: (opts: ChoiceOptions) => Promise<string | null>;
}

/** The dialog showing: its buttons, from right (default) to left. */
interface Pending {
  title: string;
  body?: ReactNode;
  buttons: { key: string; label: string; className: string }[];
  resolve: (key: string | null) => void;
}

const FeedbackContext = createContext<FeedbackState | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const nextId = useRef(1);

  const toast = useCallback((text: string, tone: ToastTone = "info") => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-4), { id, tone, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 8000 : 4000);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) =>
        setPending({
          title: opts.title,
          body: opts.body,
          buttons: [
            {
              key: "ok",
              label: opts.confirmLabel ?? "确认",
              className: opts.danger ? "btn btn-danger" : "btn btn-primary",
            },
            { key: "cancel", label: opts.cancelLabel ?? "取消", className: "btn" },
          ],
          resolve: (key) => resolve(key === "ok"),
        }),
      ),
    [],
  );

  const choose = useCallback(
    (opts: ChoiceOptions) =>
      new Promise<string | null>((resolve) =>
        setPending({
          title: opts.title,
          body: opts.body,
          buttons: opts.choices.map((c) => ({
            key: c.key,
            label: c.label,
            className: c.tone === "primary" ? "btn btn-primary" : c.tone === "danger" ? "btn btn-danger" : "btn",
          })),
          resolve,
        }),
      ),
    [],
  );

  const close = (key: string | null) => {
    pending?.resolve(key);
    setPending(null);
  };

  const value = useMemo(() => ({ toast, confirm, choose }), [toast, confirm, choose]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span>{t.text}</span>
            <button
              type="button"
              className="toast-x"
              aria-label="关闭"
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {pending && (
        <Modal
          title={pending.title}
          onClose={() => close(null)}
          footer={[...pending.buttons].reverse().map((b, i, all) => (
            <button
              key={b.key}
              type="button"
              className={b.className}
              autoFocus={i === all.length - 1}
              onClick={() => close(b.key)}
            >
              {b.label}
            </button>
          ))}
        >
          {pending.body}
        </Modal>
      )}
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackState {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error("useFeedback outside FeedbackProvider");
  return ctx;
}

/**
 * Wrap an async action: tracks a busy flag and reports failures as an error toast.
 * Returns the action's result, or undefined when it failed.
 */
export function useAction() {
  const { toast } = useFeedback();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const out = await fn();
        if (success) toast(success, "ok");
        return out;
      } catch (err) {
        toast(errorMessage(err), "bad");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

/**
 * Destructive endpoints answer `400 confirmation_required` (or another listed code) with a detail.
 * Call `attempt(false)` first; on such a refusal show a dialog built from the detail and, if the user
 * agrees, call `attempt(true)`.
 */
export async function withConfirmation<T>(
  confirm: FeedbackState["confirm"],
  attempt: (confirmed: boolean) => Promise<T>,
  describe: (err: ApiError) => ConfirmOptions,
  codes: string[] = ["confirmation_required"],
): Promise<T | undefined> {
  try {
    return await attempt(false);
  } catch (err) {
    if (err instanceof ApiError && err.status === 400 && codes.includes(err.code)) {
      const ok = await confirm(describe(err));
      if (!ok) return undefined;
      return await attempt(true);
    }
    throw err;
  }
}

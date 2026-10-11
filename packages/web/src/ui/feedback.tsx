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

interface FeedbackState {
  toast: (text: string, tone?: ToastTone) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackState | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const nextId = useRef(1);

  const toast = useCallback((text: string, tone: ToastTone = "info") => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-4), { id, tone, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 8000 : 4000);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    [],
  );

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);

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
          onClose={() => close(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => close(false)}>
                {pending.cancelLabel ?? "取消"}
              </button>
              <button
                type="button"
                className={pending.danger ? "btn btn-danger" : "btn btn-primary"}
                autoFocus
                onClick={() => close(true)}
              >
                {pending.confirmLabel ?? "确认"}
              </button>
            </>
          }
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

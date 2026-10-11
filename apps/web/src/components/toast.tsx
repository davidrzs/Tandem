import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

/** A single follow-up action on a toast, e.g. Undo. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "danger";
  action?: ToastAction;
}

type PushToast = (text: string, tone?: "ok" | "danger", action?: ToastAction) => void;

const ToastContext = createContext<PushToast>(() => {});

/** Fire-and-forget feedback for actions with no visible result (copy, archive,
 * restore…). Success is quiet green; failures should usually use inline errors
 * instead, so reach for `"danger"` sparingly. */
export const useToast = (): PushToast => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback<PushToast>(
    (text, tone = "ok", action) => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-3), { id, text, tone, action }]);
      // Toasts with an action stay long enough to reach the button.
      setTimeout(() => dismiss(id), action ? 6500 : 3200);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "danger";
}

type PushToast = (text: string, tone?: "ok" | "danger") => void;

const ToastContext = createContext<PushToast>(() => {});

/** Fire-and-forget feedback for actions with no visible result (copy, archive,
 * restore…). Success is quiet green; failures should usually use inline errors
 * instead, so reach for `"danger"` sparingly. */
export const useToast = (): PushToast => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback<PushToast>((text, tone = "ok") => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

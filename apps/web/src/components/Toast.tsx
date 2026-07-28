import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

interface ToastItem {
  id: number;
  tone: "success" | "error";
  message: string;
}

interface ToastContextValue {
  notify: (message: string, tone?: "success" | "error") => void;
}

const ToastContext = createContext<ToastContextValue>({
  notify: () => undefined,
});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const notify = useCallback(
    (message: string, tone: "success" | "error" = "success") => {
      const id = Date.now() + Math.random();
      setItems((current) => [...current, { id, tone, message }]);
      window.setTimeout(
        () => setItems((current) => current.filter((item) => item.id !== id)),
        4000,
      );
    },
    [],
  );
  const value = useMemo(() => ({ notify }), [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.tone}`}>
            {item.tone === "success" ? (
              <CheckCircle2 size={18} />
            ) : (
              <CircleAlert size={18} />
            )}
            <span>{item.message}</span>
            <button
              onClick={() =>
                setItems((current) =>
                  current.filter((candidate) => candidate.id !== item.id),
                )
              }
              aria-label="关闭通知"
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

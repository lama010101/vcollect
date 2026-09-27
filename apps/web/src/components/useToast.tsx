import { useCallback, useRef, useState, type ReactNode } from "react";
import { ToastStack, type ToastMsg, type ToastTone } from "./ui.js";

/** Global toast notification hook. Returns { toasts, push, dismiss } and a
 *  <Toasts /> element to render. Auto-dismisses after 4s by default. */
export function useToast() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((text: string, tone: ToastTone = "info", ttl = 4000) => {
    const id = `toast_${++counter.current}`;
    setToasts((prev) => [...prev, { id, tone, text }]);
    if (ttl > 0) setTimeout(() => dismiss(id), ttl);
  }, [dismiss]);

  const Toasts: ReactNode = <ToastStack toasts={toasts} onDismiss={dismiss} />;

  return { toasts, push, dismiss, Toasts };
}

import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

import { useMountEffect } from "../hooks/useEffects";
import { CloseIcon } from "./icons";
import { IconButton } from "./ui";

type ToastVariant = "default" | "success" | "error";

type ToastItem = { id: number; message: ReactNode; variant: ToastVariant };

type ShowToast = (message: ReactNode, options?: { variant?: ToastVariant; durationMs?: number }) => void;

const ToastContext = createContext<ShowToast | null>(null);

export function useToast() {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used within a ToastProvider");
  return show;
}

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  default: "border-border bg-surface-1 text-text-primary",
  success: "border-success-soft-border bg-success-soft text-success",
  error: "border-error-soft-border bg-error-soft text-error",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const show = useCallback<ShowToast>(
    (message, options) => {
      const id = (idRef.current += 1);
      const variant = options?.variant ?? "default";
      const durationMs = options?.durationMs ?? 4000;
      setToasts((current) => [...current, { id, message, variant }]);
      timersRef.current.set(
        id,
        setTimeout(() => dismiss(id), durationMs),
      );
    },
    [dismiss],
  );

  // Clear any pending auto-dismiss timers if the provider unmounts.
  useMountEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  });

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Live region is rendered unconditionally so screen readers observe it
          before any toast arrives; a region inserted already-populated is
          silently skipped by most readers. Error toasts use role="alert"
          (assertive) so they aren't postponed behind polite announcements. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-toast flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.variant === "error" ? "alert" : "status"}
            className={`editorial-rise pointer-events-auto flex items-start gap-3 border px-3.5 py-2.5 text-base leading-snug ${VARIANT_CLASSES[toast.variant]}`}
          >
            <div className="min-w-0 flex-1">{toast.message}</div>
            {/* Kit ghost coloring (gray, brightens on hover) on all variants —
                the dismiss X is an action, not part of the status treatment. */}
            <IconButton label="Dismiss" onClick={() => dismiss(toast.id)} className="-my-1 -mr-1.5">
              <CloseIcon />
            </IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

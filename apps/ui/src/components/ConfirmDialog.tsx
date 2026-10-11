import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

import { Button, Modal } from "./ui";

type ConfirmOptions = {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as a destructive action. */
  destructive?: boolean;
};

type PendingState = ConfirmOptions & { resolve: (value: boolean) => void };

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

/**
 * Returns a promise-based confirm() replacement for the native window.confirm.
 * Usage mirrors the imperative call site it replaces:
 *   if (!(await confirm({ message: "…" }))) return;
 */
export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used within a ConfirmProvider");
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingState | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending((current) => {
          // A second confirm() while one is open abandons the first as
          // cancelled so its awaiter settles instead of hanging forever.
          current?.resolve(false);
          return { ...options, resolve };
        });
      }),
    [],
  );

  const close = useCallback((result: boolean) => {
    setPending((current) => {
      current?.resolve(result);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? <ConfirmDialog pending={pending} onClose={close} /> : null}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ pending, onClose }: { pending: PendingState; onClose: (result: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      open
      role="alertdialog"
      aria-label={pending.title ?? "Confirm"}
      title={pending.title}
      onClose={() => onClose(false)}
      className="max-w-sm"
      initialFocusRef={confirmRef}
      portal={false}
      onDocumentKeyDown={(event) => {
        if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) onClose(true);
      }}
      footer={
        <>
          <Button type="button" onClick={() => onClose(false)} variant="secondary" size="md">
            {pending.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            type="button"
            ref={confirmRef}
            onClick={() => onClose(true)}
            variant={pending.destructive ? "danger" : "primary"}
            size="md"
          >
            {pending.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      {pending.message}
    </Modal>
  );
}

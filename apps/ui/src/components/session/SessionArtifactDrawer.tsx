import { type ReactNode, type RefObject, useRef } from "react";

import { useSyncEffect } from "../../hooks/useEffects";
import { CloseIcon } from "../icons";
import { Button } from "../ui";

type Props = {
  open: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal artifact workspace used below xl. Owns escape, focus trap, and focus return. */
export function SessionArtifactDrawer({ open, onClose, returnFocusRef, children }: Props) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useSyncEffect(() => {
    if (!open) return;
    closeRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [open, onClose, returnFocusRef]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-modal xl:hidden">
      <button
        type="button"
        aria-label="Close details"
        className="absolute inset-0 bg-[rgb(0_0_0_/_0.7)]"
        onClick={onClose}
      />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Session details"
        className="absolute inset-y-0 right-0 flex w-[min(100%,40rem)] min-w-0 flex-col border-l border-border bg-surface-0"
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
          <h2 className="text-md font-medium text-text-primary">Details</h2>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close details"
            title="Close details"
            className="w-8 px-0"
          >
            <CloseIcon className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </aside>
    </div>
  );
}

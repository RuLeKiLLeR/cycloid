import { type ReactNode, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { useSyncEffect } from "../../hooks/useEffects";
import { cx } from "./utils";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  "aria-label"?: string;
  role?: "dialog" | "alertdialog";
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  initialFocusRef?: React.RefObject<HTMLElement>;
  portal?: boolean;
  onDocumentKeyDown?: (event: KeyboardEvent) => void;
};

function utilityClassSegments(className: string | undefined): string[] {
  if (!className) return [];
  return className
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.slice(token.lastIndexOf(":") + 1));
}

function hasUtilityPrefix(className: string | undefined, prefixes: readonly string[]): boolean {
  const segments = utilityClassSegments(className);
  return segments.some((segment) => prefixes.some((prefix) => segment.startsWith(prefix)));
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
}

export function Modal({
  open,
  onClose,
  title,
  "aria-label": ariaLabel,
  role = "dialog",
  children,
  footer,
  className,
  initialFocusRef,
  portal = true,
  onDocumentKeyDown,
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const panelUsesCustomWidth = hasUtilityPrefix(className, ["w-"]);
  const panelUsesCustomMaxWidth = hasUtilityPrefix(className, ["max-w-"]);
  const panelUsesCustomPadding = hasUtilityPrefix(className, ["p-", "px-", "py-", "pt-", "pr-", "pb-", "pl-"]);
  // Capture the latest callbacks in refs so they are not effect deps. Both are
  // inline arrow functions at most call sites (e.g. `() => onClose(false)`),
  // so listing them would re-run the effect on every parent re-render, briefly
  // restoring focus outside the modal (announced by screen readers) while the
  // modal is still open.
  const onCloseRef = useRef(onClose);
  const onDocumentKeyDownRef = useRef(onDocumentKeyDown);
  onCloseRef.current = onClose;
  onDocumentKeyDownRef.current = onDocumentKeyDown;

  useSyncEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Lock scroll on body and any custom session scroll containers. `overflow:
    // hidden` on body does not suppress overflow on `overflow:auto` children,
    // and iOS still scrolls the background via touch, so we also lock each
    // container and add passive:false wheel/touchmove guards. Scrolling inside
    // the modal panel itself is still allowed.
    const scrollContainers: HTMLElement[] = [
      document.body,
      ...Array.from(document.querySelectorAll<HTMLElement>("#main-content, [data-session-scroll-container]")),
    ];
    const previousOverflow = scrollContainers.map((element) => element.style.overflow);
    scrollContainers.forEach((element) => {
      element.style.overflow = "hidden";
    });
    const preventScroll = (event: Event) => {
      if (panel && event.target instanceof Node && panel.contains(event.target)) return;
      event.preventDefault();
    };
    document.addEventListener("wheel", preventScroll, { passive: false, capture: true });
    document.addEventListener("touchmove", preventScroll, { passive: false, capture: true });

    requestAnimationFrame(() => {
      const target = initialFocusRef?.current ?? focusableElements(panel ?? document.body)[0] ?? panel;
      target?.focus();
    });

    function onKeyDown(event: KeyboardEvent) {
      onDocumentKeyDownRef.current?.(event);
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const elements = focusableElements(panel);
      if (elements.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("wheel", preventScroll, { capture: true });
      document.removeEventListener("touchmove", preventScroll, { capture: true });
      scrollContainers.forEach((element, index) => {
        element.style.overflow = previousOverflow[index] ?? "";
      });
      previouslyFocused?.focus();
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  const modal = (
    <div
      className="editorial-fade fixed inset-0 z-modal flex items-center justify-center bg-[rgb(0_0_0_/_0.7)] p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={!ariaLabel && title ? titleId : undefined}
        tabIndex={-1}
        // Allow call sites like the session image preview to replace the
        // primitive's default width/max-width/padding constraints instead of
        // carrying conflicting Tailwind utilities that resolve unpredictably at runtime.
        className={cx(
          // Dialog surface — the popover/modal tonal step (surface-3) + a crisp
          // 1px border. Sharp corners, no shadow, no blur (scrim only).
          // `.editorial-rise` lands the panel with a 6px rise inside the
          // scrim's fade (panel mounts on open).
          "editorial-rise overflow-hidden border border-border-strong bg-surface-3",
          panelUsesCustomWidth ? null : "w-full",
          panelUsesCustomMaxWidth ? null : "max-w-md",
          panelUsesCustomPadding ? null : "p-5",
          className,
        )}
      >
        {title ? (
          <h2 id={titleId} className="text-xl font-semibold text-text-primary">
            {title}
          </h2>
        ) : null}
        <div className={cx("text-base leading-relaxed text-text-secondary", title ? "mt-1.5" : null)}>{children}</div>
        {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );

  return portal ? createPortal(modal, document.body) : modal;
}

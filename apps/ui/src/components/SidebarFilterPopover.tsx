import { type KeyboardEvent, useRef } from "react";

import type { DisplayStatus } from "../../../../shared/session/display-status";
import { STATUS_DISPLAY_DOT } from "../constants";
import { useSyncEffect } from "../hooks/useEffects";
import { STATUS_DISPLAY_LABEL } from "../utils/status-display";

type Props = {
  open: boolean;
  options: DisplayStatus[];
  selected: Set<DisplayStatus>;
  counts: Partial<Record<DisplayStatus, number>>;
  onToggle: (status: DisplayStatus) => void;
  onClear: () => void;
  onClose: () => void;
};

/**
 * Status filter popover anchored to the sidebar's Filter button.
 *
 * Implements the WAI-ARIA `role="menu"` keyboard pattern: ArrowDown/ArrowUp
 * roves focus through the `menuitemcheckbox` options, Home/End jump to the
 * first/last, Tab dismisses, Escape closes. The first option is focused on
 * open so keyboard users can immediately act. Click-outside and Escape both
 * close the popover via the host (Layout) so the anchor button can toggle
 * it without re-opening on its own click.
 */
export function SidebarFilterPopover({ open, options, selected, counts, onToggle, onClear, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useSyncEffect(() => {
    if (!open) return;
    function handleDown(event: MouseEvent) {
      const node = ref.current;
      if (!node) return;
      const target = event.target as Node | null;
      if (target && node.contains(target)) return;
      // The anchor button manages its own toggle; treat clicks on it as a
      // separate event so we don't double-close.
      const trigger = (target as HTMLElement | null)?.closest?.("[data-sidebar-filter-trigger]");
      if (trigger) return;
      onClose();
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey as unknown as EventListener);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey as unknown as EventListener);
    };
  }, [open, onClose]);

  // Focus the first option when the popover opens so keyboard users can
  // immediately navigate without an extra Tab press.
  useSyncEffect(() => {
    if (!open) return;
    const first = optionRefs.current.find((node): node is HTMLButtonElement => node !== null);
    first?.focus();
  }, [open]);

  function moveFocus(currentIndex: number, delta: number) {
    const last = options.length - 1;
    if (last < 0) return;
    const next = (currentIndex + delta + options.length) % options.length;
    optionRefs.current[next]?.focus();
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(index, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(index, -1);
        break;
      case "Home":
        event.preventDefault();
        optionRefs.current[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        optionRefs.current[options.length - 1]?.focus();
        break;
      case "Tab":
        // Tab leaves the menu by design (per WAI-ARIA menu pattern).
        onClose();
        break;
      default:
        break;
    }
  }

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Filter sessions by status"
      className="menu-pop absolute right-0 top-[calc(100%+8px)] z-dropdown w-[min(220px,calc(100dvw-1.5rem))] border border-border-strong bg-surface-3 p-1.5"
    >
      <div className="flex items-center justify-between px-2.5 pb-1 pt-1.5">
        <span className="text-xs font-mono-tabular text-text-muted">Status</span>
        <button
          type="button"
          onClick={onClear}
          className="px-1.5 py-0.5 text-base text-text-muted transition-colors duration-150 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          disabled={selected.size === 0}
        >
          Clear
        </button>
      </div>
      {options.map((status, index) => {
        const isOn = selected.has(status);
        const dotClass = STATUS_DISPLAY_DOT[status];
        const count = counts[status] ?? 0;
        return (
          <button
            key={status}
            ref={(node) => {
              optionRefs.current[index] = node;
            }}
            type="button"
            role="menuitemcheckbox"
            aria-checked={isOn}
            onClick={() => onToggle(status)}
            onKeyDown={(event) => handleOptionKeyDown(event, index)}
            className="flex w-full items-center gap-3 px-2.5 py-1.5 text-left text-base text-text-primary transition-colors duration-150 hover:bg-surface-2 focus-visible:bg-surface-2"
          >
            <span className={`inline-block h-2 w-2 rounded-full ${dotClass} shrink-0`} />
            <span className="flex-1">{STATUS_DISPLAY_LABEL[status]}</span>
            <span className="font-mono-tabular text-2xs tabular-nums text-text-muted">{count}</span>
            <span
              className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors duration-150 ${
                isOn ? "border-accent bg-accent text-surface-0" : "border-border bg-transparent text-transparent"
              }`}
            >
              <svg
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          </button>
        );
      })}
    </div>
  );
}

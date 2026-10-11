import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useSyncEffect } from "../../hooks/useEffects";
import { EllipsisIcon } from "../icons";
import { IconButton, type IconButtonSize } from "./IconButton";
import { cx } from "./utils";

export type MenuItem = {
  label: ReactNode;
  onSelect: () => void;
  /** `danger` = destructive/unrecoverable actions only (error hue). */
  tone?: "default" | "danger";
  disabled?: boolean;
};

type MenuTriggerProps = ButtonHTMLAttributes<HTMLButtonElement> & { ref: Ref<HTMLButtonElement> };

export type MenuProps = {
  items: MenuItem[];
  /** Accessible name for the trigger and menu, e.g. "Session actions". */
  label: string;
  /**
   * Custom trigger. Spread the provided props (ref + aria wiring + onClick /
   * onKeyDown) onto a button element. Defaults to an IconButton with the
   * ellipsis glyph.
   */
  renderTrigger?: (props: MenuTriggerProps) => ReactNode;
  /** Panel horizontal anchor relative to the trigger. */
  align?: "start" | "end";
  size?: IconButtonSize;
  className?: string;
};

/** Gap between the trigger and the panel (px). Matches the old `mt-2` anchor. */
const PANEL_OFFSET_PX = 8;

/**
 * Fixed-position panel style computed from the trigger rect. The panel renders
 * in a body portal (the SearchableSelectChip fixed-panel approach) so ancestor
 * `overflow: hidden` containers — row cards, scroll panes — cannot clip it.
 */
function panelStyleFromTrigger(trigger: HTMLElement, align: "start" | "end"): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const style: CSSProperties = { position: "fixed", top: rect.bottom + PANEL_OFFSET_PX };
  if (align === "end") {
    style.right = Math.max(0, window.innerWidth - rect.right);
  } else {
    style.left = rect.left;
  }
  return style;
}

/**
 * Minimal overflow menu — the sanctioned "fold row actions behind an ellipsis"
 * idiom. The panel is portaled to `document.body` with fixed positioning from
 * the trigger rect (dropdown layer, kit popover surface) so ancestor overflow
 * cannot clip it; outside click, scroll, and Escape close; ArrowUp/Down/Home/End
 * rove focus across enabled items; selecting closes and refocuses the trigger.
 */
export function Menu({ items, label, renderTrigger, align = "end", size = "sm", className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabledIndexes = items.flatMap((item, index) => (item.disabled ? [] : [index]));

  useSyncEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      if (!(event.target instanceof Node)) {
        setOpen(false);
        return;
      }
      if (rootRef.current?.contains(event.target)) return;
      if (panelRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    // The fixed panel does not track its anchor, so any scroll or resize while
    // open would detach it — close instead of drifting.
    const onAnchorMoved = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("scroll", onAnchorMoved, { capture: true, passive: true });
    window.addEventListener("resize", onAnchorMoved);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("scroll", onAnchorMoved, { capture: true });
      window.removeEventListener("resize", onAnchorMoved);
    };
  }, [open]);

  // Position from the trigger rect, then focus the first enabled item (menu
  // pattern: focus moves into the menu).
  useSyncEffect(() => {
    if (!open) {
      setPanelStyle(null);
      return;
    }
    if (triggerRef.current) setPanelStyle(panelStyleFromTrigger(triggerRef.current, align));
    itemRefs.current.find((node, index) => node && !items[index]?.disabled)?.focus();
  }, [open, align]);

  function closeAndFocusTrigger() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function focusRelative(fromIndex: number, key: string) {
    if (enabledIndexes.length === 0) return;
    const currentEnabledIndex = Math.max(enabledIndexes.indexOf(fromIndex), 0);
    let nextIndex: number | undefined;
    switch (key) {
      case "ArrowDown":
        nextIndex = enabledIndexes[(currentEnabledIndex + 1) % enabledIndexes.length];
        break;
      case "ArrowUp":
        nextIndex = enabledIndexes[(currentEnabledIndex - 1 + enabledIndexes.length) % enabledIndexes.length];
        break;
      case "Home":
        nextIndex = enabledIndexes[0];
        break;
      case "End":
        nextIndex = enabledIndexes[enabledIndexes.length - 1];
        break;
      default:
        return;
    }
    if (nextIndex !== undefined) itemRefs.current[nextIndex]?.focus();
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    // Enter/Space toggle via the native click; ArrowDown opens explicitly.
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndFocusTrigger();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      focusRelative(index, event.key);
    }
  }

  const triggerProps: MenuTriggerProps = {
    ref: triggerRef,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: () => setOpen((current) => !current),
    onKeyDown: onTriggerKeyDown,
  };

  return (
    <div ref={rootRef} className={cx("relative inline-flex", className)}>
      {renderTrigger ? (
        renderTrigger(triggerProps)
      ) : (
        <IconButton label={label} size={size} {...triggerProps}>
          <EllipsisIcon />
        </IconButton>
      )}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={menuId}
            role="menu"
            aria-label={label}
            style={panelStyle ?? undefined}
            className={cx(
              // Kit popover surface — dropdown layer, 1px border, hairline ring.
              // Fixed position comes from panelStyle; hidden until measured so
              // the panel never flashes at the viewport origin. `.menu-pop`
              // joins only once measured so the reveal runs while visible.
              "z-dropdown min-w-40 border border-border bg-surface-1 p-1 shadow-card",
              panelStyle ? "menu-pop fixed" : "invisible fixed",
            )}
          >
            {items.map((item, index) => (
              <button
                key={index}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                onKeyDown={(event) => onMenuKeyDown(event, index)}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  triggerRef.current?.focus();
                  item.onSelect();
                }}
                className={cx(
                  "block w-full px-2.5 py-1.5 text-left text-base transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  item.tone === "danger"
                    ? "text-error hover:bg-error-soft"
                    : "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

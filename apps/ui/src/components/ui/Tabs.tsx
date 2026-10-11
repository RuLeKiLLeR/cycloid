import { type KeyboardEvent, type ReactNode, useRef } from "react";

import { cx } from "./utils";

export type TabItem = {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
};

export type TabsVariant = "underline" | "workbench";

export type TabsProps = {
  tabs: TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  variant?: TabsVariant;
  className?: string;
  /** Namespace for the generated tab/panel ids so multiple tab strips can share a page. */
  idBase?: string;
  ariaLabel?: string;
};

export function tabId(idBase: string, id: string) {
  return `${idBase}-tab-${id}`;
}

export function tabPanelId(idBase: string, id: string) {
  return `${idBase}-panel-${id}`;
}

export function Tabs({
  tabs,
  value,
  onValueChange,
  variant = "underline",
  className,
  idBase = "tabs",
  ariaLabel,
}: TabsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const nextEnabled = (from: number, dir: 1 | -1) => {
    const n = tabs.length;
    if (n === 0) return from;
    let idx = from;
    for (let i = 0; i < n; i++) {
      idx = (idx + dir + n) % n;
      if (!tabs[idx]?.disabled) return idx;
    }
    return from;
  };

  const activate = (index: number) => {
    const tab = tabs[index];
    if (!tab || tab.disabled) return;
    refs.current[index]?.focus();
    onValueChange(tab.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        target = nextEnabled(index, 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        target = nextEnabled(index, -1);
        break;
      case "Home":
        target = nextEnabled(tabs.length - 1, 1);
        break;
      case "End":
        target = nextEnabled(0, -1);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target != null) activate(target);
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className={cx(variant === "underline" ? "flex items-stretch gap-1" : "flex items-end gap-1", className)}
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={tabId(idBase, tab.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(idBase, tab.id)}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => !tab.disabled && onValueChange(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              // Same press treatment as SegmentedControl segments — .btn-press
              // darkens on :active (no transform).
              "btn-press relative inline-flex control-sm items-center gap-1.5 px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4",
              variant === "underline"
                ? selected
                  ? "text-text-primary"
                  : "text-text-muted hover:text-text-secondary"
                : cx(
                    "rounded-t-md border-x border-t-2",
                    selected
                      ? "border-x-border border-t-accent bg-surface-2 text-text-primary"
                      : "border-x-transparent border-t-transparent text-text-muted hover:bg-surface-1 hover:text-text-secondary",
                  ),
            )}
          >
            {tab.icon != null && <span className="shrink-0">{tab.icon}</span>}
            <span>{tab.label}</span>
            {tab.badge != null && <span className="shrink-0">{tab.badge}</span>}
            {variant === "underline" && (
              <span aria-hidden className={cx("filter-chip-underline", selected && "filter-chip-underline-active")} />
            )}
          </button>
        );
      })}
    </div>
  );
}

export type TabPanelProps = {
  /** Tab id this panel belongs to. */
  id: string;
  /** Currently selected tab id. */
  value: string;
  idBase?: string;
  className?: string;
  children: ReactNode;
};

export function TabPanel({ id, value, idBase = "tabs", className, children }: TabPanelProps) {
  const active = id === value;
  return (
    <div
      role="tabpanel"
      id={tabPanelId(idBase, id)}
      aria-labelledby={tabId(idBase, id)}
      hidden={!active}
      tabIndex={0}
      className={className}
    >
      {active ? children : null}
    </div>
  );
}

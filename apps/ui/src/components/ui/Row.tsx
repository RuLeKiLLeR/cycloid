import { type ReactNode, useState } from "react";
import { Link } from "react-router";

import { CaretRightIcon, SortAscIcon, SortDescIcon } from "../icons";
import { Badge } from "./Badge";
import { cx } from "./utils";

// Absolute http(s) URLs leave the app and keep a real <a>; everything else is
// an in-app route and must go through the router Link (a raw <a> forces a full
// page reload).
function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export type RowProps = {
  /** Leading slot — status dot, icon, or avatar. */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Secondary metadata rendered next to the subtitle. */
  meta?: ReactNode;
  /** Right-aligned artifact chips. */
  chips?: ReactNode;
  /** Far-right slot — time, owner, avatar. */
  trailing?: ReactNode;
  href?: string;
  onClick?: () => void;
  selected?: boolean;
  disabled?: boolean;
  /** Render a leading selection checkbox. */
  selectable?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  selectAriaLabel?: string;
  className?: string;
  ariaLabel?: string;
};

// Below sm the row may wrap: the title column keeps first-line width and the
// chip rail drops to its own line (see RowBody) instead of squeezing the
// title to zero — chips are shrink-0, so on narrow viewports they would
// otherwise consume the whole line.
const baseRow = "session-stack-dense flex w-full items-center gap-3 text-left max-sm:flex-wrap";

function surfaceClasses(interactive: boolean, selected: boolean) {
  if (selected) return "bg-surface-3";
  // Interactive rows lift on hover (surface-2 + resting shadow) via .row-hover-lift,
  // which owns its own transition (background-color + box-shadow) on the editorial curve.
  if (interactive) return "row-hover-lift";
  return "";
}

function RowBody({
  leading,
  title,
  subtitle,
  meta,
  chips,
  trailing,
}: Pick<RowProps, "leading" | "title" | "subtitle" | "meta" | "chips" | "trailing">) {
  return (
    <>
      {leading != null && <span className="flex shrink-0 items-center [&_svg]:size-4">{leading}</span>}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-md font-medium text-text-primary">{title}</span>
        {(subtitle != null || meta != null) && (
          <span className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
            {subtitle != null && <span className="truncate">{subtitle}</span>}
            {meta != null && <span className="shrink-0">{meta}</span>}
          </span>
        )}
      </span>
      {chips != null && (
        <span
          data-slot="row-chips"
          className="flex shrink-0 items-center gap-1.5 max-sm:order-last max-sm:w-full max-sm:flex-wrap"
        >
          {chips}
        </span>
      )}
      {trailing != null && (
        <span className="shrink-0 min-w-16 text-right font-mono-tabular text-xs text-text-muted">{trailing}</span>
      )}
    </>
  );
}

export function Row({
  leading,
  title,
  subtitle,
  meta,
  chips,
  trailing,
  href,
  onClick,
  selected = false,
  disabled = false,
  selectable = false,
  checked = false,
  onCheckedChange,
  selectAriaLabel = "Select row",
  className,
  ariaLabel,
}: RowProps) {
  const interactive = Boolean(href || onClick);
  const body = (
    <RowBody leading={leading} title={title} subtitle={subtitle} meta={meta} chips={chips} trailing={trailing} />
  );

  if (selectable) {
    return (
      <div className={cx(baseRow, surfaceClasses(interactive, selected), className)}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={selectAriaLabel}
          onChange={(event) => onCheckedChange?.(event.target.checked)}
          className="size-4 shrink-0 cursor-pointer accent-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
        />
        {href ? (
          isExternalHref(href) ? (
            <a href={href} aria-label={ariaLabel} className="flex min-w-0 flex-1 items-center gap-3">
              {body}
            </a>
          ) : (
            <Link to={href} aria-label={ariaLabel} className="flex min-w-0 flex-1 items-center gap-3">
              {body}
            </Link>
          )
        ) : onClick ? (
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={ariaLabel}
            className="flex min-w-0 flex-1 items-center gap-3 bg-transparent text-left disabled:cursor-not-allowed disabled:opacity-40"
          >
            {body}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>
        )}
      </div>
    );
  }

  const rowClass = cx(baseRow, surfaceClasses(interactive, selected), className);

  if (href) {
    if (isExternalHref(href)) {
      return (
        <a href={href} aria-current={selected ? "true" : undefined} aria-label={ariaLabel} className={rowClass}>
          {body}
        </a>
      );
    }
    return (
      <Link to={href} aria-current={selected ? "true" : undefined} aria-label={ariaLabel} className={rowClass}>
        {body}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-current={selected ? "true" : undefined}
        aria-label={ariaLabel}
        className={cx(rowClass, "disabled:cursor-not-allowed disabled:opacity-40")}
      >
        {body}
      </button>
    );
  }

  return (
    <div aria-label={ariaLabel} className={rowClass}>
      {body}
    </div>
  );
}

export type RowGroupProps = {
  /** Compact group header label. */
  title: ReactNode;
  count?: number;
  /** Right-aligned header actions. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Wrap the group body in a surface-1 card (border + rounded-lg); rows inside
   * stay borderless, separated by `.rule` hairlines. Default keeps the flat look.
   */
  contained?: boolean;
  className?: string;
  children: ReactNode;
};

export function RowGroup({
  title,
  count,
  actions,
  defaultOpen = true,
  open,
  onOpenChange,
  contained = false,
  className,
  children,
}: RowGroupProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;

  const toggle = () => {
    const next = !isOpen;
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <section className={className}>
      <div className="flex items-center justify-between gap-2 px-1 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={isOpen}
          className="inline-flex items-center gap-1.5 text-text-secondary transition-colors hover:text-text-primary"
        >
          <CaretRightIcon className={cx("size-3 shrink-0 transition-transform", isOpen && "rotate-90")} />
          <span data-slot="row-group-title" className="text-lg font-medium text-text-primary">
            {title}
          </span>
          {count != null && (
            <Badge tone="default" className="text-text-secondary">
              {count}
            </Badge>
          )}
        </button>
        {actions != null && <span className="flex shrink-0 items-center gap-1.5">{actions}</span>}
      </div>
      {isOpen && (
        <div
          className={cx(
            // Body mounts on open — `.group-reveal` fades it in; collapse
            // unmounts instantly by design.
            "group-reveal flex flex-col",
            // Contained variant: card around the body; rows separated by
            // hairlines (border-t border-border == the .rule editorial divider).
            contained &&
              "overflow-hidden rounded-lg border border-border bg-surface-1 [&>*+*]:border-t [&>*+*]:border-border",
          )}
        >
          {children}
        </div>
      )}
    </section>
  );
}

export type SortDirection = "asc" | "desc";

export type Column = {
  key: string;
  label: ReactNode;
  sortable?: boolean;
  align?: "left" | "right";
  /** Width/flex utility classes for this column cell. */
  className?: string;
};

export type ColumnHeaderProps = {
  columns: Column[];
  sortKey?: string;
  sortDirection?: SortDirection;
  onSort?: (key: string) => void;
  className?: string;
};

export function ColumnHeader({ columns, sortKey, sortDirection, onSort, className }: ColumnHeaderProps) {
  return (
    <div className={cx("flex items-center gap-3 px-4 py-2", className)}>
      {columns.map((column) => {
        const active = column.key === sortKey;
        const alignClass = column.align === "right" ? "justify-end text-right" : "justify-start text-left";
        const content = (
          <>
            <span className="eyebrow">{column.label}</span>
            {column.sortable && active && (
              <span aria-hidden className="text-text-secondary">
                {sortDirection === "asc" ? (
                  <SortAscIcon className="size-3 shrink-0" />
                ) : (
                  <SortDescIcon className="size-3 shrink-0" />
                )}
              </span>
            )}
          </>
        );
        if (column.sortable && onSort) {
          return (
            <button
              key={column.key}
              type="button"
              onClick={() => onSort(column.key)}
              className={cx(
                "inline-flex items-center gap-1 transition-colors hover:text-text-primary",
                alignClass,
                column.className,
              )}
            >
              {content}
            </button>
          );
        }
        return (
          <span key={column.key} className={cx("inline-flex items-center gap-1", alignClass, column.className)}>
            {content}
          </span>
        );
      })}
    </div>
  );
}

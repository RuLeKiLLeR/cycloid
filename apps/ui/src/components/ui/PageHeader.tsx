import { type ReactNode } from "react";

import { type TabItem, Tabs } from "./Tabs";
import { cx } from "./utils";

export type PageHeaderTabs = {
  items: TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  idBase?: string;
  ariaLabel?: string;
};

export type PageHeaderProps = {
  title: ReactNode;
  eyebrow?: ReactNode;
  /** Secondary metadata beside the title. */
  meta?: ReactNode;
  /** Right-aligned actions. */
  actions?: ReactNode;
  /** Renders an underline tab strip beneath the title row. */
  tabs?: PageHeaderTabs;
  /** Sticky to the top of the scroll container (default false). */
  sticky?: boolean;
  className?: string;
};

export function PageHeader({ title, eyebrow, meta, actions, tabs, sticky = false, className }: PageHeaderProps) {
  return (
    <header className={cx("px-0", sticky && "sticky top-0 z-sticky-local", className)}>
      <div className="flex min-h-12 items-end justify-between gap-4 py-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          {eyebrow != null && <span className="eyebrow">{eyebrow}</span>}
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-2xl text-text-primary">{title}</h1>
            {meta != null && <span className="shrink-0 font-mono-tabular text-xs text-text-muted">{meta}</span>}
          </div>
        </div>
        {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {tabs != null && (
        <Tabs
          tabs={tabs.items}
          value={tabs.value}
          onValueChange={tabs.onValueChange}
          variant="underline"
          idBase={tabs.idBase}
          ariaLabel={tabs.ariaLabel}
          className="-mb-px"
        />
      )}
    </header>
  );
}

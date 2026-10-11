import { type ReactNode } from "react";

import { cx } from "./utils";

export type EmptyStateProps = {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  // Heading level for the title. Defaults to h3; callers pass the level that
  // keeps document heading order valid for their surrounding context (axe
  // heading-order requires levels to increase by one). The mono/caption look is
  // class-driven, so the level can change without altering the visual.
  headingLevel?: 2 | 3 | 4;
};

export function EmptyState({ icon, title, description, action, className, headingLevel = 3 }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    // `.editorial-fade` — empty states mount once loading resolves, so the
    // fade reads as appearance feedback rather than a re-render flicker.
    <div
      className={cx("editorial-fade flex flex-col items-center justify-center gap-4 px-6 py-14 text-center", className)}
    >
      {icon != null && <span className="text-text-muted [&_svg]:size-6">{icon}</span>}
      <div className="flex flex-col gap-1">
        <Heading className="text-md text-text-primary">{title}</Heading>
        {description != null && <p className="max-w-sm text-base text-text-secondary">{description}</p>}
      </div>
      {action != null && <div className="mt-1">{action}</div>}
    </div>
  );
}

import { type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./utils";

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  /** Adds hover feedback for clickable cards. */
  interactive?: boolean;
  /**
   * Lift the card with real elevation (`--shadow-elevated`). Reserve for
   * surfaces that genuinely float — popovers, focused composers. Default cards
   * take their structure from the hairline border + surface step, not a shadow,
   * so panels read crisp instead of soft-and-generic.
   */
  elevated?: boolean;
};

export function Card({ interactive = false, elevated = false, className, ...props }: CardProps) {
  return (
    <div
      className={cx(
        // Tonal surface card: surface-1 over the void + a 1px hairline border.
        // Flat and sharp — structure comes from the border + surface step, not a
        // shadow.
        "border border-border bg-surface-1 p-4",
        elevated && "shadow-elevated",
        interactive && "cursor-pointer transition-colors hover:border-border-hover",
        className,
      )}
      {...props}
    />
  );
}

export type StatTileProps = {
  label: ReactNode;
  value: ReactNode;
  delta?: { value: ReactNode; tone?: "success" | "error" | "neutral" };
  icon?: ReactNode;
  interactive?: boolean;
  className?: string;
};

// Success is grayscale (only error keeps its hue); a delta value reads by sign
// and label, not color.
const deltaToneClasses: Record<"success" | "error" | "neutral", string> = {
  success: "text-text-secondary",
  error: "text-error",
  neutral: "text-text-muted",
};

export function StatTile({ label, value, delta, icon, interactive, className }: StatTileProps) {
  return (
    <Card interactive={interactive} className={cx("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">{label}</span>
        {icon != null && <span className="text-text-muted [&_svg]:size-4">{icon}</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="numeral text-2xl text-text-primary">{value}</span>
        {delta != null && (
          <span className={cx("numeral text-xs", deltaToneClasses[delta.tone ?? "neutral"])}>{delta.value}</span>
        )}
      </div>
    </Card>
  );
}

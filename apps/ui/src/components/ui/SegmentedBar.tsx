import { cx } from "./utils";

export type MeterTone = "accent" | "success" | "warning" | "error";

// Progress fills are ink (white) by default; success/warning stay grayscale.
// Only error carries a hue.
const fillClasses: Record<MeterTone, string> = {
  accent: "bg-accent",
  success: "bg-text-secondary",
  warning: "bg-text-primary",
  error: "bg-error",
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export type SegmentedBarProps = {
  /** Number of filled segments. */
  value: number;
  /** Total number of segments. */
  total: number;
  tone?: MeterTone;
  className?: string;
  ariaLabel?: string;
};

export function SegmentedBar({ value, total, tone = "accent", className, ariaLabel }: SegmentedBarProps) {
  const safeTotal = Math.max(0, Math.floor(total));
  const filled = clamp(Math.round(value), 0, safeTotal);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeTotal}
      aria-valuenow={filled}
      aria-label={ariaLabel}
      className={cx("flex items-center gap-0.5", className)}
    >
      {Array.from({ length: safeTotal }, (_, index) => (
        <span
          key={index}
          aria-hidden
          className={cx("h-1.5 flex-1", index < filled ? fillClasses[tone] : "bg-surface-3")}
        />
      ))}
    </div>
  );
}

export type MeterProps = {
  value: number;
  max?: number;
  tone?: MeterTone;
  className?: string;
  ariaLabel?: string;
};

export function Meter({ value, max = 100, tone = "accent", className, ariaLabel }: MeterProps) {
  const safeMax = max > 0 ? max : 1;
  const percent = clamp((value / safeMax) * 100, 0, 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={clamp(value, 0, safeMax)}
      aria-label={ariaLabel}
      className={cx("h-1 w-full overflow-hidden border border-border bg-surface-2", className)}
    >
      <span className={cx("block h-full transition-all", fillClasses[tone])} style={{ width: `${percent}%` }} />
    </div>
  );
}

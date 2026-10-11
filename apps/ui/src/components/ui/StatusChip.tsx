import { type ReactNode } from "react";

import { chipClasses } from "./chip";
import { cx } from "./utils";

export type SessionStatus =
  | "planning"
  | "running"
  | "waiting"
  | "verifying"
  | "pr-open"
  | "checks-failing"
  | "ready-for-review"
  | "done"
  | "failed";

type StatusTone = "neutral" | "accent" | "success" | "warning" | "error";

type StatusMeta = { label: string; tone: StatusTone; pulse?: boolean };

const STATUS_META: Record<SessionStatus, StatusMeta> = {
  planning: { label: "Planning", tone: "accent", pulse: true },
  running: { label: "Running", tone: "accent", pulse: true },
  waiting: { label: "Waiting", tone: "warning" },
  verifying: { label: "Verifying", tone: "accent", pulse: true },
  "pr-open": { label: "PR open", tone: "neutral" },
  "checks-failing": { label: "Checks failing", tone: "error" },
  "ready-for-review": { label: "Ready for review", tone: "success" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "error" },
};

// Tone treatment comes from the shared chip family (chipClasses); `neutral`
// maps onto the chip `default` tone.
const chipTone = (tone: StatusTone) => (tone === "neutral" ? "default" : tone);

const dotClasses: Record<StatusTone, string> = {
  neutral: "bg-text-muted",
  accent: "bg-live",
  success: "bg-text-secondary",
  warning: "bg-text-primary",
  error: "bg-error",
};

export type StatusChipVariant = "pill" | "dot";

export type StatusChipProps = {
  status: SessionStatus;
  /** Override the default sentence-case label. */
  label?: ReactNode;
  /**
   * `pill` (default): filled soft chip for actionable/live states.
   * `dot`: bare toned status dot + muted label, for dense repeated terminal
   * states where a filled pill per row would be noise.
   */
  variant?: StatusChipVariant;
  className?: string;
};

export function StatusChip({ status, label, variant = "pill", className }: StatusChipProps) {
  const meta = STATUS_META[status];
  // Live (violet) dots breathe with the sanctioned heartbeat; other pulsing
  // states fall back to the plain opacity pulse.
  const pulseClass = meta.pulse ? (meta.tone === "accent" ? "review-loop-breathe" : "status-dot-pulse") : undefined;
  const dot = (
    <span aria-hidden className={cx("status-dot size-1.5 shrink-0 rounded-full", dotClasses[meta.tone], pulseClass)} />
  );

  if (variant === "dot") {
    return (
      <span className={cx("inline-flex items-center gap-1.5 text-xs font-medium text-text-muted", className)}>
        {dot}
        <span>{label ?? meta.label}</span>
      </span>
    );
  }

  return (
    <span
      className={cx(
        // Shared mono-label chip geometry (chipClasses) plus .status-pill for
        // the tonal transition; matches Badge/ArtifactChip so chips read as one
        // family.
        chipClasses(chipTone(meta.tone), "status-pill"),
        className,
      )}
    >
      {dot}
      <span>{label ?? meta.label}</span>
    </span>
  );
}

import type { LifecycleChip, LifecycleChipTone } from "../../../../shared/session/lifecycle-chip";
import { chipClasses, type ChipTone, cx, StatusChip, type StatusChipProps } from "./ui";

type Props = Pick<StatusChipProps, "status" | "label">;

export function SessionListStatusChip({ status, label }: Props) {
  return <StatusChip status={status} label={label} variant="pill" className="justify-center whitespace-nowrap" />;
}

// LifecycleChipTone → shared chip family tone. `live` rides the accent (violet)
// tone + heartbeat; `neutral` maps to the chip `default` tone; success/warning/
// error pass through — grayscale for success/warning, pink for error (FAILED
// only), matching DESIGN.md accent discipline.
const LIFECYCLE_CHIP_TONE: Record<LifecycleChipTone, ChipTone> = {
  live: "accent",
  neutral: "default",
  success: "success",
  warning: "warning",
  error: "error",
};

// The sanctioned live dot: violet fill + review-loop heartbeat. Only rendered
// for `pulse` (live) chips; every other tone is a bare mono-uppercase label.
function LiveDot() {
  return <span aria-hidden className="status-dot size-1.5 shrink-0 rounded-full bg-live review-loop-breathe" />;
}

/**
 * Render a FSM-derived {@link LifecycleChip} directly, reusing the shared chip
 * family geometry/tones (no bespoke pill). Same square, mono-uppercase readout
 * as StatusChip/Badge/ArtifactChip.
 */
export function SessionLifecycleChip({ chip }: { chip: LifecycleChip }) {
  return (
    <span className={cx(chipClasses(LIFECYCLE_CHIP_TONE[chip.tone]), "justify-center whitespace-nowrap")}>
      {chip.pulse && <LiveDot />}
      <span>{chip.label}</span>
    </span>
  );
}

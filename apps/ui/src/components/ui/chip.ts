import { cx } from "./utils";

/**
 * Shared chip/pill family — the single source of truth for the chip treatment
 * consumed by Badge, StatusChip, and ArtifactChip (and any hand-rolled pill
 * being migrated onto the kit).
 *
 * Grayscale by default; `accent` = live (violet, liveness only), `error` =
 * blocked/failed (#ffb4ab). Success/warning are grayscale — the icon + label
 * carries the state, never a hue. Sharp corners, 1px border, Geist sentence
 * case (one-family collapse retired the mono/uppercase label register).
 */
export type ChipTone = "default" | "accent" | "success" | "warning" | "error";

export const chipBaseClasses = "inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs font-medium";

const chipToneClasses: Record<ChipTone, string> = {
  default: "border-border-strong bg-transparent text-text-secondary",
  accent: "border-live-border bg-live-tint text-live",
  success: "border-border-hover bg-transparent text-text-primary",
  warning: "border-border-hover bg-transparent text-text-primary",
  error: "border-error-soft-border bg-error-soft text-error",
};

export function chipClasses(tone: ChipTone = "default", className?: string) {
  return cx(chipBaseClasses, chipToneClasses[tone], className);
}

import { type HTMLAttributes } from "react";

import { chipClasses, type ChipTone } from "./chip";

// Badge tones are the shared chip tones (see chip.ts for the tone discipline).
export type BadgeTone = ChipTone;

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
};

// Geist sentence-case status label in a 1px border — the shared chip family
// (chipClasses) keeps Badge/StatusChip/ArtifactChip reading as one system.
export function Badge({ tone = "default", className, ...props }: BadgeProps) {
  return <span className={chipClasses(tone, className)} {...props} />;
}

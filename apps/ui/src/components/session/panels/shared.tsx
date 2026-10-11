// Small readout primitives shared across inspector panels. Panel-local only —
// promote to components/ui/ if a surface outside the inspector needs them.

import { Badge } from "../../ui";

/**
 * Check-command outcome chip. Grayscale by default; the error hue is reserved
 * for a failed check (DESIGN.md accent discipline).
 */
export function CommandStatusChip({ status }: { status: "passed" | "failed" | "skipped" }) {
  const tone = status === "failed" ? "error" : status === "passed" ? "success" : "default";
  return (
    <Badge tone={tone} className="shrink-0">
      {status}
    </Badge>
  );
}

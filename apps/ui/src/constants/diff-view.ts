/**
 * Diff rendering mode for transcript file diffs. Purely visual: persisted per
 * browser in localStorage, never sent to the control plane.
 */

export type DiffViewMode = "unified" | "split";

export const DIFF_VIEW_DEFAULT: DiffViewMode = "unified";

/** localStorage key for the per-browser diff view preference. */
export const DIFF_VIEW_STORAGE_KEY = "cycloid:preferences.diffView";

/** Narrow a stored/unknown value to a valid mode; anything else falls back to the default. */
export function parseDiffViewMode(value: unknown): DiffViewMode {
  return value === "split" ? "split" : DIFF_VIEW_DEFAULT;
}

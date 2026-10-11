export const UI_LIFECYCLE_STAGES = ["verifying", "merge_ready", "merged", "closed", "superseded"] as const;

export type UiLifecycleStage = (typeof UI_LIFECYCLE_STAGES)[number] | null;

export function normalizeUiLifecycleStage(value: unknown): UiLifecycleStage {
  if (typeof value !== "string") return null;
  return UI_LIFECYCLE_STAGES.includes(value as (typeof UI_LIFECYCLE_STAGES)[number])
    ? (value as (typeof UI_LIFECYCLE_STAGES)[number])
    : null;
}

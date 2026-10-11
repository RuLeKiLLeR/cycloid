/**
 * Deploy-safety seam for the plan approval rollout.
 *
 * Keep false until the park machinery and one complete approval path are
 * deployed. The activation PR flips this single constant for all users.
 */
export const PLAN_APPROVAL_ACTIVATION: boolean = true;

export const PLAN_PARK_PAUSE_AFTER_MS = 5 * 60 * 1000;
export const PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY = "plan_park_pause_deadline";
export const PLAN_READY_DELIVERY_STORAGE_KEY = "plan_ready_delivery";
export const PLAN_READY_NOTIFICATION_MAX_ATTEMPTS = 3;
export const PLAN_READY_NOTIFICATION_RETRY_DELAYS_MS = [30_000, 2 * 60_000] as const;

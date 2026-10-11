import { ENVIRONMENT } from "../../../../shared/constants/environment";
import { businessIdsMatch, SEEDED_BUSINESS_IDS } from "./businesses";

export const COMPANY_MEMORY_SOURCE_TYPE = {
  SLACK_APP_MENTION: "slack.app_mention",
  SLACK_INTAKE: "slack.intake",
  SLACK_THREAD_PASTE: "slack.thread_paste",
  GITHUB_PR_EVENT: "github.pr_event",
  GITHUB_REVIEW_LOOP_OUTCOME: "github.review_loop_outcome",
  SESSION_COMPLETE: "session.complete",
} as const;

export type CompanyMemorySourceType = (typeof COMPANY_MEMORY_SOURCE_TYPE)[keyof typeof COMPANY_MEMORY_SOURCE_TYPE];

export const COMPANY_MEMORY_CHANNEL_SCOPE_TYPES = ["customer", "incident", "support", "sales", "generic"] as const;

export const COMPANY_MEMORY_SCOPE_TYPES = [...COMPANY_MEMORY_CHANNEL_SCOPE_TYPES, "repo"] as const;

export type CompanyMemoryScopeType = (typeof COMPANY_MEMORY_SCOPE_TYPES)[number];

export type CompanyMemoryChannelScopeType = (typeof COMPANY_MEMORY_CHANNEL_SCOPE_TYPES)[number];

/**
 * Company-memory refinement has the same 120s model budget as memory analysis.
 * Ten minutes keeps healthy slow consumers from being reclaimed while still
 * recovering rows left in processing by a crashed queue worker.
 */
export const COMPANY_MEMORY_INGESTION_STALE_THRESHOLD_MS = 600_000;

/**
 * Minimum time between reconciliation scans of the same business. Reconciliation
 * is not latency-sensitive, so a business is interval-suppressed for 24h after a
 * completed scan. This collapses keep-both adjudication re-billing from once per
 * five-minute cron tick to at most once per interval, and the round-robin
 * scheduler cursor pairs with it so businesses past the per-tick limit still get
 * covered.
 */
export const MEMORY_RECONCILIATION_RECURRENCE_INTERVAL_MS = 86_400_000;

type MemoryRolloutEnv = {
  WORKER_ENV?: string;
  MEMORY_CONTEXT_LOCAL_DOGFOOD_ENABLED?: string;
};

export function isMemoryEnabledForBusiness(env: MemoryRolloutEnv, businessId: string | null | undefined): boolean {
  if (
    env.WORKER_ENV === ENVIRONMENT.Local &&
    env.MEMORY_CONTEXT_LOCAL_DOGFOOD_ENABLED === "1" &&
    businessIdsMatch(businessId, SEEDED_BUSINESS_IDS.cycloid)
  ) {
    return true;
  }
  return env.WORKER_ENV === ENVIRONMENT.Production && Boolean(businessId);
}

export function isCompanyMemoryDisabledForBusiness(
  env: MemoryRolloutEnv,
  businessId: string | null | undefined,
): boolean {
  return !isMemoryEnabledForBusiness(env, businessId);
}

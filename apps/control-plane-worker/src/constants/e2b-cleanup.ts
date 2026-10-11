export const E2B_RUNTIME_CLEANUP_BATCH_LIMIT_DEFAULT = 25;
export const E2B_RUNTIME_CLEANUP_BATCH_LIMIT_HARD_CAP = 100;

// Bounded retry for the DO-resident cleanup workflow (ARC-1054). After this
// many failed attempts the job becomes `terminal_failed` and stops arming its
// own retry alarm; the worker sweep is the backstop.
export const E2B_CLEANUP_MAX_ATTEMPTS_DEFAULT = 5;
export const E2B_CLEANUP_MAX_ATTEMPTS_HARD_CAP = 20;

// Retry backoff bounds for the cleanup-retry alarm. These intentionally differ
// from the in-process `DO_RETRY_*` fetch-retry defaults: a cleanup retry is a
// sweep-style alarm, so it should space out over seconds-to-minutes rather than
// the sub-request cadence the fetch helper assumes.
export const E2B_CLEANUP_RETRY_BASE_BACKOFF_MS = 30 * 1_000;
export const E2B_CLEANUP_RETRY_MAX_BACKOFF_MS = 10 * 60 * 1_000;

// Cooldown before a `terminal_failed` job is eligible for a fresh attempt
// window when the worker sweep re-discovers the still-uncleared row. Without a
// cooldown the sweep would immediately reset attempts and make the retry cap
// meaningless.
export const E2B_CLEANUP_TERMINAL_COOLDOWN_MS = 60 * 60 * 1_000;

export function getE2BCleanupMaxAttempts(env: { E2B_CLEANUP_MAX_ATTEMPTS?: string }): number {
  const raw = env.E2B_CLEANUP_MAX_ATTEMPTS;
  if (!raw) return E2B_CLEANUP_MAX_ATTEMPTS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return E2B_CLEANUP_MAX_ATTEMPTS_DEFAULT;
  return Math.min(Math.floor(parsed), E2B_CLEANUP_MAX_ATTEMPTS_HARD_CAP);
}
export const E2B_ORPHAN_REAPER_BATCH_LIMIT_DEFAULT = E2B_RUNTIME_CLEANUP_BATCH_LIMIT_DEFAULT;
export const E2B_ORPHAN_REAPER_BATCH_LIMIT_HARD_CAP = E2B_RUNTIME_CLEANUP_BATCH_LIMIT_HARD_CAP;
export const E2B_ORPHAN_REAPER_MIN_AGE_MS_DEFAULT = 10 * 60 * 1_000;

export function getE2BRuntimeCleanupBatchLimit(env: { E2B_RUNTIME_CLEANUP_BATCH_LIMIT?: string }): number {
  const raw = env.E2B_RUNTIME_CLEANUP_BATCH_LIMIT;
  if (!raw) return E2B_RUNTIME_CLEANUP_BATCH_LIMIT_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return E2B_RUNTIME_CLEANUP_BATCH_LIMIT_DEFAULT;
  return Math.min(Math.floor(parsed), E2B_RUNTIME_CLEANUP_BATCH_LIMIT_HARD_CAP);
}

export function getE2BOrphanReaperBatchLimit(env: { E2B_ORPHAN_REAPER_BATCH_LIMIT?: string }): number {
  const raw = env.E2B_ORPHAN_REAPER_BATCH_LIMIT;
  if (!raw) return E2B_ORPHAN_REAPER_BATCH_LIMIT_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return E2B_ORPHAN_REAPER_BATCH_LIMIT_DEFAULT;
  return Math.min(Math.floor(parsed), E2B_ORPHAN_REAPER_BATCH_LIMIT_HARD_CAP);
}

export function getE2BOrphanReaperMinAgeMs(env: { E2B_ORPHAN_REAPER_MIN_AGE_MS?: string }): number {
  const raw = env.E2B_ORPHAN_REAPER_MIN_AGE_MS;
  if (!raw) return E2B_ORPHAN_REAPER_MIN_AGE_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return E2B_ORPHAN_REAPER_MIN_AGE_MS_DEFAULT;
  return Math.floor(parsed);
}

// ARC-1248: orphan-reaper liveness guard. Default on. Setting the env var to "0"
// reverts the owner guard to its pure-bookkeeping decision (no E2B-status /
// heartbeat proof-of-life gate) — the kill switch for the new behavior.
export function isE2BOrphanReaperLivenessGuardEnabled(env: { E2B_ORPHAN_REAPER_LIVENESS_GUARD?: string }): boolean {
  return env.E2B_ORPHAN_REAPER_LIVENESS_GUARD !== "0";
}

// Live-lease window for a running E2B runtime (default 15 minutes). The DO uses
// its own private copy of this getter; this exported one lets the cleanup sweep
// apply the same window as a minimum-age cutoff for NULL-lease running rows so a
// freshly-created runtime is not selected before its lease would have expired.
export const E2B_RUNTIME_LIVE_LEASE_MS_DEFAULT = 15 * 60 * 1_000;

export function getE2BRuntimeLiveLeaseMs(env: { E2B_RUNTIME_LIVE_LEASE_MS?: string }): number {
  const raw = env.E2B_RUNTIME_LIVE_LEASE_MS;
  if (!raw) return E2B_RUNTIME_LIVE_LEASE_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return E2B_RUNTIME_LIVE_LEASE_MS_DEFAULT;
  return Math.floor(parsed);
}

import * as Sentry from "@sentry/cloudflare";

/**
 * In-memory repeat suppression for Sentry captures. A permanently failing
 * scheduled task on the 5-minute cron reports ~8.6K events/month, so a couple
 * of stuck loops can burn the entire monthly quota. This gate reports the
 * first occurrence of each (scope, error) pair immediately, counts repeats
 * silently within the window, then re-reports once per window with the
 * suppressed count so the Sentry issue still shows the true rate.
 *
 * State is per-isolate and resets on isolate recycle; that only weakens
 * suppression (an occasional extra event), never hides a first occurrence.
 * Full-fidelity visibility stays in Datadog via the callers' log lines.
 */

export const SENTRY_SUPPRESSION_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_KEYS = 200;
const MAX_ERROR_KEY_LENGTH = 200;

type SuppressionEntry = {
  firstSeenAt: number;
  lastReportedAt: number;
  suppressedCount: number;
};

const suppressionState = new Map<string, SuppressionEntry>();

export function resetSentryRepeatSuppression(): void {
  suppressionState.clear();
}

/**
 * Stable identity for an error. Prefers name + code/status (stable
 * classification fields on errors like E2BSandboxRuntimeError) over the raw
 * message, which can embed volatile details (IDs, durations) that defeat
 * suppression.
 */
function errorKey(err: unknown): string {
  if (err instanceof Error) {
    const { code, status } = err as { code?: unknown; status?: unknown };
    const stableParts = [code, status].filter(
      (value): value is string | number => typeof value === "string" || typeof value === "number",
    );
    const key = stableParts.length > 0 ? [err.name, ...stableParts].join(":") : `${err.name}:${err.message}`;
    return key.slice(0, MAX_ERROR_KEY_LENGTH);
  }
  return String(err).slice(0, MAX_ERROR_KEY_LENGTH);
}

/**
 * Capture `err` to Sentry unless the same (scope, error) pair was already
 * reported within the suppression window. Returns true when a Sentry event
 * was sent, false when suppressed. Callers should keep emitting their own
 * log line on every occurrence so Datadog visibility is unaffected.
 */
export function captureRepeatedException(
  scope: string,
  err: unknown,
  options: {
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    now?: () => number;
  } = {},
): boolean {
  const now = options.now ?? Date.now;
  const key = `${scope}|${errorKey(err)}`;
  const timestamp = now();
  const entry = suppressionState.get(key);

  if (entry && timestamp - entry.lastReportedAt < SENTRY_SUPPRESSION_WINDOW_MS) {
    entry.suppressedCount += 1;
    return false;
  }

  if (entry) {
    if (entry.suppressedCount === 0) {
      // Nothing was suppressed since the last report: the error went quiet
      // for a full window and recurred. That is a fresh episode, not a
      // re-report — capture without suppression stats and restart the clock.
      entry.firstSeenAt = timestamp;
      entry.lastReportedAt = timestamp;
      Sentry.captureException(err, {
        tags: options.tags,
        ...(options.extra ? { extra: options.extra } : {}),
      });
      return true;
    }
    Sentry.captureException(err, {
      tags: options.tags,
      extra: {
        ...options.extra,
        suppressedSinceLastReport: entry.suppressedCount,
        firstSeenAt: entry.firstSeenAt,
      },
    });
    entry.lastReportedAt = timestamp;
    entry.suppressedCount = 0;
    return true;
  }

  if (suppressionState.size >= MAX_TRACKED_KEYS) {
    const oldestKey = suppressionState.keys().next().value;
    if (oldestKey !== undefined) suppressionState.delete(oldestKey);
  }
  suppressionState.set(key, { firstSeenAt: timestamp, lastReportedAt: timestamp, suppressedCount: 0 });
  Sentry.captureException(err, {
    tags: options.tags,
    ...(options.extra ? { extra: options.extra } : {}),
  });
  return true;
}

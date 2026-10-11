// Live session-stall sweep. Emits, once per cron tick, the age of the OLDEST
// session still sitting in each automated FSM state plus a count of sessions
// past the stall threshold. This is the signal `arcanist.fsm.stage_dwell_ms`
// structurally cannot give: that dwell metric only fires when a session
// TRANSITIONS out of a state, so a session wedged in FINALIZING (the xyla OOM:
// 30+ min, nothing paged) emits nothing until it moves — if it ever does. A
// periodic gauge over the still-in-state anchor makes the live stall visible.
// A second, harder threshold enumerates a bounded recovery cohort and asks each
// owning DO to recheck its current state and liveness before force-failing it.
//
// Best-effort: read pr_coordination, emit gauges, log a warning per stalled
// state. Wrapped by the scheduled handler's withScheduledTask, so a throw here
// never breaks the cron tick.

import {
  FINALIZING_STALL_THRESHOLD_MS,
  PRE_PUBLISH_STALL_BACKSTOP_BATCH_SIZE,
  PRE_PUBLISH_STALL_BACKSTOP_MS,
  SESSION_STALLED_COUNT_METRIC,
  SESSION_STATE_DWELL_OLDEST_METRIC,
  STALL_WATCH_STATES,
  VERIFICATION_SESSION_AGE_OLDEST_METRIC,
  VERIFICATION_SESSION_DEADLINE_MS,
  VERIFICATION_SESSION_STALLED_COUNT_METRIC,
  VERIFICATION_SESSION_UNANCHORED_COUNT_METRIC,
} from "../constants/session-stall";
import type { Logger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { baseControlPlaneMetricTags } from "../observability/metric-tags";
import { type GaugeMetricSeries, postGaugeMetricSeries } from "../observability/pr-metrics";
import {
  type PrePublishStallFailResponse,
  SESSION_BEARER_INTERNAL_ROUTES,
  SESSION_INTERNAL_ORIGIN,
} from "../session/internal-routes";
import {
  listStalledPrePublishCandidates,
  readActiveStateDwell,
  type StateDwellAggregateRow,
} from "../session/pr-coordination-db";
import { type ActiveVerificationAgeAggregate, readActiveVerificationAge } from "../session/session-stall-db";
import { getSessionStub } from "../session/state";
import type { Env } from "../types";
import { mapBounded } from "../utils";

const JOB_NAME = "session-stall-sweep";
const VERIFICATION_JOB_NAME = "verification-session-stall-sweep";
const RECOVERY_CONCURRENCY = 5;

export interface StallGaugeResult {
  series: GaugeMetricSeries[];
  stalled: { state: string; oldestAgeMs: number; count: number; stalledCount: number }[];
}

export interface VerificationStallGaugeResult {
  series: GaugeMetricSeries[];
  oldestAgeMs: number | null;
  oldestSessionId: string | null;
  stalledCount: number;
  count: number;
}

/**
 * Pure projection of the DAO aggregate into gauge series + the stalled facets, so the arithmetic
 * (age = now − oldestEnteredAt) is unit-testable without D1 or a DD post. Emits one
 * `state_dwell_oldest_ms` gauge per state that has ≥1 anchored session, and a `stalled_count` gauge
 * only when at least one session in that state is past the threshold (a flat 0 series per state per tick
 * would be pure cardinality with no signal). `stalledCount` is the DAO's precise count of sessions past
 * the stall cutoff — NOT the full `count` of sessions in the state, so freshly-entered sessions alongside
 * a wedged one do not inflate the gauge. Tag value is the lowercased state so monitors read
 * `{state:finalizing}` alongside the existing lowercase session tags.
 */
export function computeStallGauges(
  env: Pick<Env, "WORKER_ENV">,
  rows: StateDwellAggregateRow[],
  nowMs: number,
): StallGaugeResult {
  const base = baseControlPlaneMetricTags(env);
  const series: GaugeMetricSeries[] = [];
  const stalled: StallGaugeResult["stalled"] = [];
  for (const row of rows) {
    const oldestAgeMs = Math.max(0, nowMs - row.oldestEnteredAt);
    const tags = [...base, `state:${row.state.toLowerCase()}`];
    series.push({ metric: SESSION_STATE_DWELL_OLDEST_METRIC, tags, value: oldestAgeMs });
    if (row.stalledCount > 0) {
      series.push({ metric: SESSION_STALLED_COUNT_METRIC, tags, value: row.stalledCount });
      stalled.push({ state: row.state, oldestAgeMs, count: row.count, stalledCount: row.stalledCount });
    }
  }
  return { series, stalled };
}

export function computeVerificationStallGauges(
  env: Pick<Env, "WORKER_ENV">,
  aggregate: ActiveVerificationAgeAggregate,
  nowMs: number,
): VerificationStallGaugeResult {
  const tags = [...baseControlPlaneMetricTags(env), "agent_role:verification"];
  const series: GaugeMetricSeries[] = [];
  const oldestAgeMs = aggregate.oldestCreatedAt === null ? null : Math.max(0, nowMs - aggregate.oldestCreatedAt);
  if (oldestAgeMs !== null) {
    series.push({ metric: VERIFICATION_SESSION_AGE_OLDEST_METRIC, tags, value: oldestAgeMs });
  }
  if (aggregate.stalledCount > 0) {
    series.push({ metric: VERIFICATION_SESSION_STALLED_COUNT_METRIC, tags, value: aggregate.stalledCount });
  }
  if (aggregate.unanchoredCount > 0) {
    series.push({ metric: VERIFICATION_SESSION_UNANCHORED_COUNT_METRIC, tags, value: aggregate.unanchoredCount });
  }
  return {
    series,
    oldestAgeMs,
    oldestSessionId: aggregate.oldestSessionId,
    stalledCount: aggregate.stalledCount,
    count: aggregate.count,
  };
}

export interface SessionStallRecoveryResult {
  scanned: number;
  terminalized: number;
  skipped: number;
  errors: number;
}

export async function runSessionStallSweep(env: Env, deps: { logger: Logger }): Promise<SessionStallRecoveryResult> {
  const recovery: SessionStallRecoveryResult = { scanned: 0, terminalized: 0, skipped: 0, errors: 0 };
  if (!env.DB) return recovery;
  const nowMs = Date.now();
  const rows = await readActiveStateDwell(env.DB, STALL_WATCH_STATES, nowMs, nowMs - FINALIZING_STALL_THRESHOLD_MS);
  const { series, stalled } = computeStallGauges(env, rows, nowMs);

  for (const s of stalled) {
    deps.logger.warn(
      { job: JOB_NAME, state: s.state, oldestAgeMs: s.oldestAgeMs, sessionsInState: s.count },
      "Session(s) stalled in automated FSM state past threshold",
    );
  }

  let candidates: Awaited<ReturnType<typeof listStalledPrePublishCandidates>> = [];
  try {
    candidates = await listStalledPrePublishCandidates(
      env.DB,
      STALL_WATCH_STATES,
      nowMs - PRE_PUBLISH_STALL_BACKSTOP_MS,
      PRE_PUBLISH_STALL_BACKSTOP_BATCH_SIZE,
    );
  } catch (error) {
    recovery.errors += 1;
    deps.logger.error({ job: JOB_NAME, error: String(error) }, "Pre-publish stall candidate query failed");
  }
  const route = SESSION_BEARER_INTERNAL_ROUTES.prePublishStallFail;
  await mapBounded(candidates, RECOVERY_CONCURRENCY, async (candidate) => {
    recovery.scanned += 1;
    try {
      const response = await getSessionStub(env, candidate.sessionId).fetch(
        new URL(route.path, SESSION_INTERNAL_ORIGIN).href,
        {
          method: route.method,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.SANDBOX_RUNTIME_CLEANUP_SECRET}`,
            "x-session-id": candidate.sessionId,
          },
          body: JSON.stringify({ sessionId: candidate.sessionId, nowMs }),
        },
      );
      if (!response.ok) {
        throw new Error(`Session stall backstop DO call failed: ${response.status} ${await response.text()}`);
      }
      const result = (await response.json()) as PrePublishStallFailResponse;
      if (result.terminalized) {
        recovery.terminalized += 1;
        deps.logger.warn(
          { job: JOB_NAME, sessionId: candidate.sessionId, state: candidate.state },
          "Force-failed abandoned pre-publish session",
        );
      } else {
        recovery.skipped += 1;
        deps.logger.info(
          { job: JOB_NAME, sessionId: candidate.sessionId, state: candidate.state, reason: result.reason },
          "Skipped pre-publish stall candidate after live recheck",
        );
      }
    } catch (error) {
      recovery.errors += 1;
      deps.logger.error(
        { job: JOB_NAME, sessionId: candidate.sessionId, state: candidate.state, error: String(error) },
        "Pre-publish stall recovery failed",
      );
    }
  });

  const apiKey = env.DD_API_KEY;
  await Promise.all([
    ...(apiKey ? [postGaugeMetricSeries(apiKey, series, JOB_NAME)] : []),
    runVerificationSessionStallSweep(env, deps),
  ]);
  return recovery;
}

/**
 * Tiny verifier-only query/emit path. The router runs it on each one-minute
 * fast-dispatch tick and the full five-minute sweep invokes it too, so the
 * ten-minute monitor detects within roughly one scheduler tick instead of
 * first observing an over-budget session at minute 10-15.
 */
export async function runVerificationSessionStallSweep(env: Env, deps: { logger: Logger }): Promise<void> {
  if (!env.DB) return;
  const nowMs = Date.now();
  const verificationAge = await readActiveVerificationAge(env.DB, nowMs - VERIFICATION_SESSION_DEADLINE_MS);
  const verification = computeVerificationStallGauges(env, verificationAge, nowMs);
  const diagnosticPosts: Promise<void>[] = [];

  if (verification.stalledCount > 0) {
    const event = {
      job: VERIFICATION_JOB_NAME,
      event: "verification.session_stalled",
      oldestSessionId: verification.oldestSessionId,
      oldestAgeMs: verification.oldestAgeMs,
      activeVerificationSessions: verification.count,
      stalledVerificationSessions: verification.stalledCount,
      completionBudgetMs: VERIFICATION_SESSION_DEADLINE_MS,
    };
    deps.logger.warn(event, "Verification session exceeded the ten-minute completion budget");
    diagnosticPosts.push(
      postStructuredEventToDd(env, event).then(
        () => {},
        () => {},
      ),
    );
  }
  if (verificationAge.unanchoredCount > 0) {
    diagnosticPosts.push(
      postStructuredEventToDd(env, {
        job: VERIFICATION_JOB_NAME,
        event: "verification.session_age_unanchored",
        unanchoredCount: verificationAge.unanchoredCount,
      }).then(
        () => {},
        () => {},
      ),
    );
  }

  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;
  await Promise.all([postGaugeMetricSeries(apiKey, verification.series, VERIFICATION_JOB_NAME), ...diagnosticPosts]);
}

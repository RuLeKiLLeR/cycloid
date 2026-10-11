// Phase-transition telemetry. Emits a queryable Datadog log event
// (@event:session.phase_transition) plus a Datadog v2 metric series counter
// (arcanist.session.phase.transition) tagged with previous/next phase and the
// trigger cause. Both fire-and-forget through the caller's waitUntil; failures
// are swallowed after a console warn so a telemetry hiccup never blocks a
// session-state write.

import type { Phase, PhaseInfo } from "../../../../shared/session/phase.js";
import type { Env } from "../types";
import { postStructuredEventToDd } from "./events-exporter";
import { baseControlPlaneMetricTags } from "./metric-tags";
import { postCountMetricSeries } from "./pr-metrics";

export type PhaseTransitionCause =
  | "active_prompt_started"
  | "active_prompt_cleared"
  | "pending_question_set"
  | "pending_question_cleared"
  | "sandbox_transport_event"
  | "publish_status_change"
  | "stop_requested"
  | "archive"
  | "post_execution"
  | "unknown";

// Controls whether a `persist*` lifecycle helper runs the drift check.
// Drift detection compares persisted `session_index.rich_status` to the
// DO's freshly derived phase. It must only run on paths that genuinely
// replay existing state ("passive_reconciliation"), not on mutation paths
// where a phase change is by definition the column "lagging" behind by a
// few lines of code. `PhaseTransitionCause` is telemetry attribution, not
// a path classifier — never key drift control flow off it.
//
// `source` identifies which reconciliation callsite triggered the check
// (e.g. "reconnect_grace_cleanup", "reaper_alarm"). It flows into the
// drift metric tags + structured log so triage can locate the path
// without re-reading the durable-object source.
export type DriftCheckConfig = { mode: "skip" } | { mode: "passive_reconciliation"; source: string };

export const SKIP_DRIFT_CHECK: DriftCheckConfig = { mode: "skip" };

export interface PhaseTransitionEvent {
  sessionId: string;
  previousPhase: Phase | null;
  next: PhaseInfo;
  cause: PhaseTransitionCause;
  agentRuntimeBackend?: string | null;
}

function buildPhaseTags(event: PhaseTransitionEvent, env: Pick<Env, "WORKER_ENV">): string[] {
  return [
    ...baseControlPlaneMetricTags(env),
    `previous_phase:${event.previousPhase ?? "none"}`,
    `next_phase:${event.next.phase}`,
    `sandbox_substate:${event.next.sandboxSubstate}`,
    `finalizing_step:${event.next.finalizingStep}`,
    `stop_mode:${event.next.stopMode}`,
    `cause:${event.cause}`,
    `agent_runtime_backend:${event.agentRuntimeBackend ?? "unknown"}`,
  ];
}

/**
 * Submit a single counter point to the Datadog v2 metrics API. Returns
 * silently on missing DD_API_KEY (local dev) so callers can fire-and-forget
 * without guarding.
 */
export async function postPhaseTransitionMetric(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  event: PhaseTransitionEvent,
): Promise<void> {
  const ddApiKey = env.DD_API_KEY;
  if (!ddApiKey) return;
  await postCountMetricSeries(
    ddApiKey,
    [{ metric: "arcanist.session.phase.transition", tags: buildPhaseTags(event, env), value: 1 }],
    "transition",
  );
}

/**
 * Emit the queryable phase-transition log event. Combined with
 * `postPhaseTransitionMetric` this is what a caller fans out via waitUntil on
 * every detected transition.
 */
export async function postPhaseTransitionEvent(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  event: PhaseTransitionEvent,
): Promise<void> {
  await postStructuredEventToDd(env, {
    event: "session.phase_transition",
    sessionId: event.sessionId,
    previousPhase: event.previousPhase,
    nextPhase: event.next.phase,
    sandboxSubstate: event.next.sandboxSubstate,
    finalizingStep: event.next.finalizingStep,
    stopMode: event.next.stopMode,
    cause: event.cause,
    agentRuntimeBackend: event.agentRuntimeBackend ?? "unknown",
  });
}

/**
 * Submit a single drift counter point. Drift is the (rare) condition where
 * the persisted `session_index.rich_status` projection does not match the
 * phase the DO re-derives from its live inputs on a passive reconciliation
 * path (alarm / reconnect-grace cleanup). The counter is tagged with the
 * observed/expected phase, the triggering cause, and the reconciliation
 * source so a Datadog monitor can alert before the drift spreads to
 * UI/CLI consumers and triage can locate the responsible code path.
 */
export async function postPhaseDriftMetric(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  details: {
    sessionId: string;
    persistedPhase: string | null;
    derivedPhase: Phase;
    cause: PhaseTransitionCause;
    reconciliationSource: string;
  },
): Promise<void> {
  const ddApiKey = env.DD_API_KEY;
  if (!ddApiKey) return;

  await postCountMetricSeries(
    ddApiKey,
    [
      {
        metric: "arcanist.session.phase.drift",
        tags: [
          ...baseControlPlaneMetricTags(env),
          `persisted_phase:${details.persistedPhase ?? "none"}`,
          `derived_phase:${details.derivedPhase}`,
          `cause:${details.cause}`,
          `reconciliation_source:${details.reconciliationSource}`,
        ],
        value: 1,
      },
    ],
    "drift",
  );

  await postStructuredEventToDd(env, {
    event: "session.phase_drift",
    sessionId: details.sessionId,
    persistedPhase: details.persistedPhase,
    derivedPhase: details.derivedPhase,
    cause: details.cause,
    reconciliationSource: details.reconciliationSource,
  });
}

import type { Env } from "../types";
import { baseControlPlaneMetricTags } from "./metric-tags";
import { postCountMetric } from "./pr-metrics";

// SLO for the termination chokepoint (Plan A4a). One count per decision the
// disconnect chokepoint (`confirmRuntimeDeadBeforeTerminalize`) reaches, tagged
// so the whole behavior reads off a single low-cardinality metric, the same way
// `arcanist.pr.created` carries its drafts-vs-ready split:
//   - `lane`      reconnect_grace_expiry | liveness_expiry — which disconnect lane fired.
//   - `decision`  defer | terminate — kept the prompt on its live VM, or killed + re-cloned.
//   - `liveness`  alive | dead | unknown | none — the E2B probe reading behind the decision
//                 (`none` = no probe ran: kill switch off, no E2B runtime, hold
//                 exhausted, or provider-alive deferral is ineligible for the lane).
//
// The headline SLO is the `prompt_terminalized_while_e2b_alive` slice and MUST read ~0:
//   sum:arcanist.sandbox.disconnect_terminalize{decision:terminate,liveness:alive}.as_count()
// A1's gate defers on an affirmative eligible `alive` probe, so a
// terminate-while-alive is only reachable if a future lane bypasses the chokepoint
// or routes an alive reading into a kill — exactly the regression A4b pages on.
// The positive prod signal that the gate is
// doing real work is the defer slice:
//   sum:arcanist.sandbox.disconnect_terminalize{decision:defer}.as_count()
// Non-alerting itself (A4b owns the monitor). Tags stay low-cardinality (no session_id):
// lane(2) x decision(2) x liveness(4) plus service/worker/env.
const SANDBOX_DISCONNECT_TERMINALIZE_METRIC = "arcanist.sandbox.disconnect_terminalize";

export type SandboxDisconnectTerminalizeLiveness = "alive" | "dead" | "unknown" | "none";

export async function emitSandboxDisconnectTerminalizeMetric(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  tags: { lane: string; decision: "defer" | "terminate"; liveness: SandboxDisconnectTerminalizeLiveness },
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;
  const seriesTags = [
    ...baseControlPlaneMetricTags(env),
    `lane:${tags.lane}`,
    `decision:${tags.decision}`,
    `liveness:${tags.liveness}`,
  ];
  await postCountMetric(apiKey, SANDBOX_DISCONNECT_TERMINALIZE_METRIC, seriesTags, "sandbox-disconnect-terminalize");
}

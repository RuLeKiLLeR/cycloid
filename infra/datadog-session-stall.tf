# --- Datadog: Live session-stall watch ---
#
# Closes the gap that let the OpenEvidence/xyla OOM sit invisibly: sessions wedged
# in FINALIZING for 30+ min with nothing paging. The existing arcanist.fsm.stage_dwell_ms
# only records dwell when a session TRANSITIONS out of a state, so a live stall emits
# no signal. The control-plane cron sweep (services/session-stall-sweep.ts) samples the
# age of the oldest session still in each automated state every minute; these gauges +
# monitor turn that into a page.
#
# Metrics (v2 gauge series, posted by the sweep — NOT log-based):
#   arcanist.session.state_dwell_oldest_ms{state}  age of the oldest still-in-state session
#   arcanist.session.stalled_count{state}          # sessions past the running-long threshold

resource "datadog_metric_metadata" "session_state_dwell_oldest_ms" {
  metric = "arcanist.session.state_dwell_oldest_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "session_stalled_count" {
  metric = "arcanist.session.stalled_count"
  type   = "gauge"
  unit   = "session"
}

resource "datadog_metric_metadata" "verification_session_age_oldest_ms" {
  metric = "arcanist.verification.session_age_oldest_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "verification_session_stalled_count" {
  metric = "arcanist.verification.session_stalled_count"
  type   = "gauge"
  unit   = "session"
}

resource "datadog_metric_metadata" "verification_session_unanchored_count" {
  metric = "arcanist.verification.session_unanchored_count"
  type   = "gauge"
  unit   = "session"
}

module "datadog_session_stall_monitors" {
  source = "./modules/datadog-monitor"

  metric_alerts = {
    # Age of the OLDEST session still in FINALIZING. Threshold rationale (evidence, xyla 2026-07-06):
    #   healthy normal-repo finalize ~1–5 min; an OBSERVED healthy xyla finalize took ~15 min; the
    #   OOM-wedged sessions sat 30+ min. Critical fires at 20 min — above the healthy-slow band so a
    #   heavy-repo finalize does not page, below the wedge class so a real stall does. Warning at 10 min
    #   is the "finalize is dragging" heads-up. `max` over the window: a wedged session's age only climbs,
    #   so every sample is high. The gauge is SPARSE — the sweep emits a `state:finalizing` point only
    #   while ≥1 session is in FINALIZING, so once the wedged session terminates the series disappears.
    #   `resolve` on missing data is therefore required: it auto-clears the page (and fires the recovery
    #   handle) when the stall ends, instead of leaving the monitor stuck in ALERT until manual reset.
    #   Matches the sparse-gauge resource-pressure monitors in datadog-sandbox-resource-pressure.tf.
    session_finalizing_stall = {
      name            = "[Sessions] FINALIZING stall (oldest session wedged)"
      query           = "max(last_5m):max:arcanist.session.state_dwell_oldest_ms{state:finalizing,env:production} > 1200000"
      warning         = 600000
      critical        = 1200000
      on_missing_data = "resolve"
      message         = <<-EOT
        A session has been stuck in FINALIZING (post-exec push + verify + PR open) longer than 20 minutes.

        This is the class of failure that hid the OpenEvidence/xyla sandbox OOM: the sandbox dies or thrashes during verification, never sends `post_execution`, and the session sits in FINALIZING with no page. Check the session's E2B sandbox (`e2b sandbox metrics/exec <id>`) for OOM/CPU-pegged verification, the `arcanist.sandbox.memory.undersized` metric for the repo, and recent control-plane deploys.
        ${var.datadog_slack_handle}
        {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
        {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
      EOT
      tags            = ["service:cycloid-control-plane", "component:session-stall"]
    }

    verification_session_ten_minute_budget = {
      name            = "[Verification] Live session exceeded ten-minute completion budget"
      query           = "max(last_3m):max:arcanist.verification.session_age_oldest_ms{env:production,agent_role:verification} > 600000"
      warning         = 480000
      critical        = 600000
      on_missing_data = "resolve"
      message         = <<-EOT
        A live verification-role session is older than the ten-minute end-to-end budget.

        Search control-plane logs for `@event:verification.session_stalled`, open the oldest session id from that event, then correlate `prompt.wait_pulse`, `sandbox.resource_sample`, `sandbox_liveness_probe`, and `prompt_disconnect_retry` on the Verification Session Reliability dashboard. The age is anchored to session creation, so retries do not reset this budget.
        ${var.datadog_slack_handle}
        {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
        {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
      EOT
      tags            = ["service:cycloid-control-plane", "component:verification", "slo:ten-minute-completion"]
    }

    verification_session_age_unanchored = {
      name            = "[Verification] Live session age anchor missing"
      query           = "max(last_5m):max:arcanist.verification.session_unanchored_count{env:production,agent_role:verification} > 0"
      critical        = 0
      on_missing_data = "resolve"
      message         = <<-EOT
        At least one live verification session has an unreadable `created_at`, so the ten-minute completion SLO cannot measure it.

        Inspect `session_index` verifier rows and the session projection path before trusting the completion-budget monitor.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-control-plane", "component:verification", "component:observability-integrity"]
    }
  }
}

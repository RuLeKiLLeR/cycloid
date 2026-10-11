# --- Datadog: Sandbox OOM per-repo rollup ---
#
# The control plane emits the count metric `arcanist.sandbox.memory.undersized`
# once per session that hit a kernel OOM-kill during a heavy build/test phase
# (apps/control-plane-worker/src/sandbox/undersize-notify.ts -> emitMetric, us5).
# It is tagged with reason:oom, repo_owner, repo_name, business_id, template,
# cpu, and memory_mb.
#
# The existing per-event Slack alert (SANDBOX_UNDERSIZED_NOTIFY_SLACK_CHANNEL)
# fires once per OOM'd session, so a single misconfigured repo produces a stream
# of individual lines that read as unrelated one-offs. This monitor rolls those
# up PER REPO: when one repo OOMs repeatedly in a short window, that is no longer
# a heavy-build fluke — the repo's resource spec or its verification-phase test
# parallelism is systematically too large for its sandbox tier, and the fix is a
# single deliberate action (raise the repo-sandbox-specs tier and/or cap the
# repo's test concurrency). Grouping by {repo_owner,repo_name} makes Datadog
# evaluate and alert per repo, so each affected repo is one actionable signal.
#
# Threshold / window: >= 3 OOM'd sessions for the same repo within 30 minutes.
# A single OOM is an expected tail for a genuinely heavy build and must not page;
# three on ONE repo inside 30m is the signature of a systemic mismatch (observed
# with openevidence/xyla, where multiple concurrent sessions each OOM'd their
# 16 GB tier running CI-scale pytest -n 15 / jest fan-out). Warning at 2 gives an
# early Slack heads-up before the third confirms the pattern.
#
# Severity: Slack only, no PagerDuty. Repeated OOM degrades one customer's
# sessions (slow/failed publishes) but is not a platform outage; the response is
# to tune that repo's tier/parallelism during working hours, not a 3am page.
resource "datadog_monitor" "sandbox_oom_repeated_per_repo" {
  name    = "[Sandbox] Repeated OOM-kills on a single repo"
  type    = "metric alert"
  message = <<-EOT
    A single repo has hit >= 3 sandbox OOM-kills in 30 minutes. One OOM is an expected tail for a heavy build; three on the same repo means its sandbox tier or its verification-phase test parallelism is systematically too large for the box.

    Repeated OOMs manifest as customer-visible session damage: extremely slow publishes (the OOM tears down the bridge mid-post-exec, so FINALIZING drags 30+ min while verification thrash-retries), and occasional hard failures (an OOM during codegen surfaces as codegen_error).

    Affected repo: {{repo_owner.name}}/{{repo_name.name}}

    Fix path (in priority order):
      1. Cap the repo's verification-phase test parallelism to the sandbox (e.g. the repo's .cycloid verify hook / test runner running pytest -n <cores>, lower jest --maxWorkers / --workspace-concurrency) so it stops oversubscribing RAM.
      2. If the workload is genuinely large, raise the repo's tier in
         apps/control-plane-worker/src/sandbox/repo-sandbox-specs.ts AND the
         matching build in scripts/e2b-template-build.sh (they must stay in sync),
         then rebuild the template and deploy.

    Inspect the underlying events in Datadog Metrics:
      sum:arcanist.sandbox.memory.undersized{reason:oom} by {repo_owner,repo_name,template,memory_mb}

    ${var.datadog_slack_handle}
  EOT

  query = "sum(last_30m):sum:arcanist.sandbox.memory.undersized{env:production,reason:oom} by {repo_owner,repo_name}.as_count() >= 3"

  monitor_thresholds {
    warning           = 2
    critical          = 3
    critical_recovery = 1
  }

  # Sparse count metric: groups only exist for repos that actually OOM'd, so a
  # missing series means "no OOMs" (healthy) and must not alert.
  notify_no_data    = false
  renotify_interval = 60

  # Event counter — no data points until the first OOM occurs, so skip Datadog's
  # create-time query validation (which rejects a metric-alert on an unknown metric)
  # so the monitor can be created in an environment that hasn't OOM'd yet. Same
  # reason as the ENOSPC monitor in datadog-sandbox-resource-pressure.tf.
  validate = false

  tags = ["service:cycloid-control-plane", "component:sandbox", "signal:oom"]
}

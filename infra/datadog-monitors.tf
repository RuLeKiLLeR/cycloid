locals {
  pageable_first_party_dynamic_tool_error_codes = [
    "upstream_error",
    "upstream_http_error",
    "upstream_rate_limited",
    "not_connected",
    "forbidden",
    "invalid_credential",
    "token_expired",
    "scope_missing",
    "missing_binary",
    "graphql_error",
    "workspace_uninstalled",
  ]
  # execution_failed is intentionally NOT pageable. It is emitted only by the
  # terraform `plan` tool on any non-zero exit of `terraform init`/`plan`, which
  # is dominated by the user's own broken config (bad HCL, missing vars, provider
  # errors) -- an agent-driven outcome, not a Cycloid platform fault. Genuine
  # platform failures surface as not_connected / missing_binary / invalid_credential
  # / token_expired, which stay pageable above. Kept queryable in logs + metrics.
}

module "datadog_monitors" {
  source = "./modules/datadog-monitor"

  metric_alerts = {
    terminal_outcome_coercion = {
      name            = "[Prompts] Contradictory terminal outcome coerced"
      query           = "sum(last_15m):sum:arcanist.prompt.terminal_outcome_coercions{*} by {source,error_code}.as_count() > 0"
      critical        = 0
      validate        = false
      on_missing_data = "default"
      message         = <<-EOT
        A bridge or control-plane terminal reported success while carrying hard-error telemetry.

        The write path coerced the prompt to failed. Search production logs for
        `@event:terminal_outcome_coerced` and group by source and error_code to find
        the layer that emitted the contradiction.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["component:prompt-lifecycle"]
    }

    terminal_error_code_coercion = {
      name            = "[Prompts] Terminal error code outside ErrorCode union coerced to unknown"
      query           = "sum(last_1d):sum:arcanist.prompt.terminal_error_code_coercions{*} by {source,raw_error_code}.as_count() > 0"
      critical        = 0
      validate        = false
      on_missing_data = "default"
      message         = <<-EOT
        A terminal error code outside the ErrorCode union reached normalizeTerminalOutcome
        and was collapsed to `unknown`, erasing the failure class from triage and the
        execution_failures metric.

        `raw_error_code` in this alert group names the unrecognized code. Add it to
        ERROR_CODES in shared/types/error-codes.ts (or fix the producer) — see ARC-1622.
        Search production logs for `@event:terminal_error_code_coerced` for the emitting layer.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["component:prompt-lifecycle"]
    }

    prompt_failure_spike = {
      name     = "[Prompts] Failure spike by error_code"
      query    = "sum(last_15m):sum:arcanist.prompt.execution_failures{*} by {error_code}.as_count() > 5"
      warning  = 4
      critical = 5
      # Warning threshold raised from 2 to 4 to prevent 4-count 'unknown'
      # spikes (expected noise from edge cases, new error messages,
      # user/model-caused failures) from triggering WARN. Critical threshold
      # remains at 5 for real issues.
      # Sparse as_count() spike: resolve on no-data so a per-error_code group
      # clears when its spike passes, instead of sticking in ALERT and re-paging
      # every renotify interval. See prompt_trace_completeness below.
      on_missing_data = "default"
      message         = <<-EOT
        Prompt failures have spiked for the `error_code` in this alert group.

        Review the "Prompt Lifecycle Performance" dashboard and group by `error_code`.

        When the spiking code is `unknown` the failures were not classified; open the
        [unknown-bucket failure logs](https://us5.datadoghq.com/logs?query=service:cycloid-sandbox-bridge%20env:production%20@event:prompt.complete%20@step:execution%20@phase_status:completed%20@outcome:error%20@error_code:unknown)
        and read the `@error_message` / `@error_class` facets to see the actual failure.

        Slack-only by design: at a threshold of 5/15m grouped by error_code, an
        overnight blip is usually a single flaky session or a user/model-caused
        failure class, not a platform outage. This is a quality/trend signal, not
        a page. Real outages page via the worker-error, D1, and session-phase
        monitors instead.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:prompt-lifecycle"]
    }

    first_party_dynamic_tool_pageable_failures = {
      name            = "[Tools] First-party dynamic tool pageable failures"
      query           = "sum(last_15m):sum:arcanist.tool.first_party_dynamic_failed{${join(" OR ", formatlist("error_code:%s", local.pageable_first_party_dynamic_tool_error_codes))}} by {namespace,name,error_code}.as_count() > 3"
      warning         = 1
      critical        = 3
      on_missing_data = "default"
      message         = <<-EOT
        First-party dynamic tools are failing with pageable error classes.

        The alert groups by namespace, name, and error_code. Search logs for:
          service:cycloid-sandbox-bridge env:production @event:"first_party_dynamic_tool_failed" @namespace:{{namespace.name}} @name:{{name.name}} @errorCode:{{error_code.name}}

        Expected agent-driven outcomes such as blocked, invalid_input, not_found,
        limit_exceeded, timed_out, workspace_unknown, and execution_failed are
        intentionally excluded from this monitor but remain queryable in logs and
        the metric. execution_failed is terraform-plan-only and dominated by the
        user's own broken config, so it is a session outcome, not a platform page.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:dynamic-tools"]
    }

    prompt_ttft_p95_latency = {
      name            = "[Prompts] Time to first message P95 elevated"
      query           = "avg(last_15m):p95:arcanist.prompt.time_to_first_message{*} > 60000"
      warning         = 45000
      critical        = 60000
      on_missing_data = "resolve"
      message         = <<-EOT
        Prompt time-to-first-message P95 is above the user-visible latency budget.

        Check the "Prompt Lifecycle Performance" and "Cold-start Latency Decomposition" dashboards. Split by first_event_type, repo, model, and agent before treating this as a model/runtime regression.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:prompt-lifecycle", "slo:ttft-latency"]
    }

    prompt_success_rate_error_budget_burn = {
      name = "[Prompts] Success-rate error-budget burn elevated"
      # Keep the outer sum(last_4h): with .as_count() terms. Datadog's
      # as_count evaluation path aggregates each series over the window before
      # division, which gives the intended ratio-of-sums burn calculation.
      query             = "sum(last_4h):default_zero(sum:arcanist.prompt.execution_failures{*}.as_count()) / (default_zero(count:arcanist.prompt.execution_duration{outcome:success}.as_count()) + default_zero(sum:arcanist.prompt.execution_failures{*}.as_count())) / ${local.prompt_success_rate_error_budget_fraction} > ${local.prompt_success_rate_burn_critical_threshold}"
      warning           = local.prompt_success_rate_burn_warning_threshold
      critical          = local.prompt_success_rate_burn_critical_threshold
      on_missing_data   = "default"
      renotify_interval = 120
      message           = <<-EOT
        Prompt execution errors are consuming the prompt success-rate error budget faster than the SLO allows.

        This monitor is intentionally unsliced for now because the prompt execution metrics do not yet carry an `entrypoint` tag. User-aborted prompts are excluded from the denominator; this alert tracks only execution errors against successfully completed prompts. Use the "Prompt Lifecycle Performance" dashboard to inspect recent success rate, then split failures by `error_code`, `agent_runtime_backend`, `model`, and `agent` while the entrypoint tag work is still pending.

        Burn rate here is the recent execution-error share divided by the allowed failure budget for the `[Prompts] Success rate` SLO. A value above 1 means the budget is being spent faster than planned; `{{value}}x` means the 30d budget would burn `{{value}}` times faster if the current rate continues.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:prompt-lifecycle", "slo:success-rate"]
    }

    prompt_first_visible_p95_latency = {
      name            = "[Prompts] First visible event P95 elevated"
      query           = "avg(last_15m):p95:arcanist.prompt.received_to_first_visible_event_ms{*} > 60000"
      warning         = 45000
      critical        = 60000
      on_missing_data = "resolve"
      message         = <<-EOT
        Prompt received-to-first-visible-event P95 is above the user-visible latency budget.

        Check the "Prompt Lifecycle Performance" dashboard. Split by agent_runtime_backend, model, first_event_type, and is_followup before treating this as a runtime regression.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:prompt-lifecycle", "slo:first-visible-latency"]
    }

    runtime_warmup_failure_spike = {
      name              = "[Runtime] Warmup failure spike"
      query             = "sum(last_30m):sum:arcanist.runtime.warmup_failures{*} by {agent_runtime_backend}.as_count() > 10"
      warning           = 5
      critical          = 10
      on_missing_data   = "default"
      renotify_interval = 120
      message           = <<-EOT
        Runtime warmup is failing repeatedly for at least one backend.

        Warmup is pre-dispatch safe work and must remain best-effort; failures should degrade to normal runtime startup, not break prompts. Search logs for:
          service:cycloid-sandbox-bridge env:production @event:"runtime.warmup_completed" @outcome:failed
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:runtime-warmup"]
    }

    bridge_event_subscription_p95_latency = {
      name              = "[Bridge] Runtime event subscription P95 elevated"
      query             = "avg(last_15m):p95:arcanist.prompt.activity_phase_duration{phase:event_subscribing} > 10000"
      warning           = 5000
      critical          = 10000
      on_missing_data   = "resolve"
      renotify_interval = 120
      message           = <<-EOT
        Bridge event subscription latency is elevated before prompt dispatch.

        This tracks the bridge-connection portion of predispatch work. Search logs for:
          service:cycloid-sandbox-bridge env:production @event:"prompt.activity_phase" @phase:event_subscribing
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:agent-runtime", "component:prompt-lifecycle"]
    }

    sandbox_spawn_p95_latency = {
      name            = "[Sandbox] Spawn duration P95 elevated"
      query           = "avg(last_15m):p95:arcanist.sandbox.spawn_duration{*} > 180000"
      warning         = 120000
      critical        = 180000
      on_missing_data = "resolve"
      message         = <<-EOT
        Sandbox spawn P95 is above the runtime startup latency budget.

        Check the "Sandbox Spawn Times" dashboard. Split by repo, and use the spawn failure monitor for failed attempts; this monitor tracks successful spawn duration only.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:sandbox-spawn", "slo:spawn-latency"]
    }

    # Cold-dispatch-after-stop regression (resume-stopped-session feature). After a
    # user manual stop the sandbox is kept live-idle, so the NEXT prompt should
    # dispatch straight to the live agent (dispatch_path:live). arcanist.sandbox.resume_latency
    # is emitted ONLY for post-stop dispatches (filtered on @resumed_after_stop:true),
    # so its per-dispatch_path SAMPLE count is the true "after stop" path mix -- unlike
    # arcanist.sandbox.dispatch, whose cold share is dominated by legitimate
    # brand-new-session first-prompt cold spawns and is NOT used here. Healthy feature
    # keeps cold ~0; a rising cold share means kept-alive VMs are paused/reaped and
    # cold-respawned before the user resumes (lease/reaper/keep-alive regression). New,
    # non-retroactive metric with a ~0 baseline: absolute-share threshold + default_zero
    # so a quiet window reads OK. TIGHTEN the threshold once a real baseline exists
    # (actionable-monitor rule).
    sandbox_cold_dispatch_after_stop = {
      name              = "[Sandbox] Cold dispatch share after stop elevated"
      query             = "sum(last_1d):default_zero(count:arcanist.sandbox.resume_latency{dispatch_path:cold}.as_count()) / default_zero(count:arcanist.sandbox.resume_latency{*}.as_count()) * 100 > 40"
      warning           = 25
      critical          = 40
      on_missing_data   = "default"
      renotify_interval = 240
      message           = <<-EOT
        The share of post-stop resume dispatches that cold-respawned is elevated.

        After a user manual stop the sandbox is kept live-idle so the next prompt should hit the live agent (dispatch_path:live). This monitor reads arcanist.sandbox.resume_latency, emitted only for dispatches that follow a stop, so its cold-share is the real "resume went cold" signal (the raw arcanist.sandbox.dispatch cold share is dominated by legitimate first-prompt cold spawns and is deliberately NOT used).

        A rising cold share means kept-alive VMs are being paused or reaped before the user resumes. Open the "Sandbox Spawn Times" dashboard ("Resume & live-idle" section), split arcanist.sandbox.resume_latency by dispatch_path, and check the idle live-lease window / E2B orphan reaper / e2b_idle_pause path. Correlate with arcanist.sandbox.live_idle_ms (resumed:false = walk-aways that paused). This is a low-urgency cost/behavior signal, not a page.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:sandbox-lifecycle", "component:resume-stopped-session"]
    }

    codex_raw_fallback_drift = {
      name     = "[Bridge] Codex raw-fallback drift by event/part type"
      query    = "sum(last_1h):sum:arcanist.codex.raw_fallback{*} by {codex_event_type,codex_part_type}.as_count() > 20"
      warning  = 5
      critical = 20
      # Sparse as_count() drift: resolve on no-data so a per-type group clears
      # when drift stops, instead of sticking in ALERT. See prompt_trace_completeness.
      on_missing_data = "default"
      message         = <<-EOT
        The bridge is passing through Codex events/parts it does not translate (raw_agent_runtime drift).

        The pinned Codex CLI likely started emitting a new shape. Group the arcanist.codex.raw_fallback metric by codex_event_type / codex_part_type and extend the event translator.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:agent-runtime", "agent_runtime_backend:codex"]
    }

    claude_raw_fallback_drift = {
      name     = "[Bridge] Claude raw-fallback drift by event/part type"
      query    = "sum(last_1h):sum:arcanist.claude.raw_fallback{*} by {claude_event_type,claude_part_type}.as_count() > 20"
      warning  = 5
      critical = 20
      # Sparse as_count() drift: resolve on no-data so a per-type group clears
      # when drift stops, instead of sticking in ALERT. See prompt_trace_completeness.
      on_missing_data = "default"
      message         = <<-EOT
        The bridge is passing through Claude Agent-SDK messages/blocks it does not translate (raw_agent_runtime drift).

        The pinned Claude Agent SDK (anthropic-ai/claude-agent-sdk) likely started emitting a new shape. Group the arcanist.claude.raw_fallback metric by claude_event_type / claude_part_type and extend the claude event translator.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:agent-runtime", "agent_runtime_backend:claude_code"]
    }

    opencode_raw_fallback_drift = {
      name     = "[Bridge] Opencode raw-fallback drift by event/part type"
      query    = "sum(last_1h):sum:arcanist.opencode.raw_fallback{*} by {opencode_event_type,opencode_part_type}.as_count() > 20"
      warning  = 5
      critical = 20
      # Sparse as_count() drift: resolve on no-data so a per-type group clears
      # when drift stops, instead of sticking in ALERT. See prompt_trace_completeness.
      on_missing_data = "default"
      message         = <<-EOT
        The bridge is passing through Opencode events/parts it does not translate (raw_agent_runtime drift).

        The pinned opencode SDK likely started emitting a new shape. Group the arcanist.opencode.raw_fallback metric by opencode_event_type / opencode_part_type and extend the opencode event translator.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:agent-runtime", "agent_runtime_backend:opencode"]
    }

    opencode_blocking_event_failsafe = {
      name            = "[Bridge] Opencode blocking-event failsafe fired"
      query           = "sum(last_5m):sum:arcanist.opencode.blocking_event_failsafe{*} by {opencode_event_type,action}.as_count() > 0"
      critical        = 0
      on_missing_data = "default"
      message         = <<-EOT
        Opencode emitted an unhandled blocking `.asked` event and the bridge fail-safe path fired.

        This is protocol drift that would previously hang a session until execution timeout. Search logs:
          service:cycloid-sandbox-bridge env:production @event:"opencode.blocking_event.failsafe"
        Group by `opencode_event_type` and `action`; add a real translator path for expected event families.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:agent-runtime", "agent_runtime_backend:opencode"]
    }

    opencode_permission_reply_timeout = {
      name            = "[Bridge] Opencode permission reply timed out"
      query           = "sum(last_5m):sum:arcanist.opencode.permission_reply_timeout{*} by {response}.as_count() > 0"
      critical        = 0
      on_missing_data = "default"
      message         = <<-EOT
        The bridge waited more than 10s for an opencode permission reply POST to finish.

        This means a blocking permission request may not have been released promptly. Search logs:
          service:cycloid-sandbox-bridge env:production @event:"opencode.permission.reply_timeout"
        Check nearby `opencode.permission.auto_reply_failed` logs and opencode server health before retrying.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:agent-runtime", "agent_runtime_backend:opencode"]
    }

    prompt_trace_completeness = {
      name     = "[Observability] Prompt trace completeness degraded"
      query    = "sum(last_15m):sum:arcanist.prompt.trace_finalization{trace_complete:false,!error_code:spawn_provider_error}.as_count() > 2"
      warning  = 1
      critical = 2
      # as_count() over a sparse log metric: once a spike ages out of the window
      # the series goes empty, so without no-data handling the monitor never sees
      # a sub-threshold value and stays stuck in ALERT, re-paging every renotify
      # interval. 2026-06-19: one mealie session's 3 pre-bridge spawn_provider_error
      # prompts tripped this once, then it spammed hourly for ~6h. Resolve on missing
      # data (no bad events == healthy) and stretch renotify so genuine telemetry-loss
      # pages stay rare. The metric also filters @trace_expected:true, so terminals
      # from prompts that never reached model execution (sandbox spawn/startup
      # failures, never-run disconnects) do not feed this monitor; see
      # NON_EXECUTION_TRACE_ERROR_CODES in prompt-queue.ts.
      #
      # ARC-1287: belt-and-suspenders on top of @trace_expected:true — explicitly
      # exclude spawn_provider_error, a pre-bridge terminal that finalizes
      # trace_complete:false because the sandbox never came up, so no Braintrust span
      # can ever exist. A spawn failure can never be a genuine span regression, so
      # dropping it is always safe.
      #
      # sandbox_disconnected is deliberately NOT excluded: a disconnect AFTER the
      # prompt ran (tokens / tool calls present) is real post-bridge span loss and
      # must still page. The benign never-ran disconnect carries its own
      # sandbox_never_started code (see retryActivePromptAfterDisconnect in
      # prompt-queue.ts) and is already dropped by @trace_expected:true, since
      # finalizePromptRun re-derives trace_expected:false with no execution evidence.
      # So @trace_expected:true is the discriminator for disconnects; the monitor
      # means "a prompt that SHOULD have a span didn't" and a genuine post-bridge
      # regression still pages.
      on_missing_data   = "default"
      renotify_interval = 120
      message           = <<-EOT
        Prompt execution is finalizing without Braintrust span IDs.

        The metric counts only prompts that reached model execution
        (@trace_expected:true) and excludes spawn_provider_error, a pre-bridge
        terminal that finalizes without a span by design (the sandbox never came up).
        A prompt that genuinely executed and then hit a disconnect, a max-duration
        timeout, or another error still counts. A firing alert means an executed
        prompt finalized without a Braintrust span -- real observability loss.

        Review the "Observability Integrity" dashboard, then search logs for:
          service:cycloid-control-plane @_direct_post:true @event:"prompt.trace.finalized" @trace_expected:true @trace_complete:false -@error_code:spawn_provider_error
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:observability"]
    }

    integration_failure_spike = {
      name            = "[Integrations] Swallowed failures by surface"
      query           = "sum(last_15m):sum:arcanist.integration.failure{*} by {surface}.as_count() > 5"
      warning         = 1
      critical        = 5
      on_missing_data = "default"
      message         = <<-EOT
        Integration operations are returning failures from paths that historically swallowed them.

        Search logs for:
          service:cycloid-control-plane env:production @_direct_post:true @event:"integration.failure" @surface:{{surface.name}}
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-control-plane", "component:integrations"]
    }

    session_index_reprojected = {
      name            = "[Sessions] session_index drift reprojected"
      query           = "min(last_2h):default_zero(sum:arcanist.session_index.reprojected{drift:true}.rollup(sum, 1800)) > 5"
      warning         = 2
      critical        = 5
      on_missing_data = "default"
      # The reconciler repairs drift in bursts: a single sweep that finds a backlog
      # of already-drifted rows reports a one-time spike, not an ongoing fault. On
      # first activation (2026-06-29) it drained ~248 rows in ~1h (peak 43/5m,
      # dominated by runtime_backend) then dropped to a steady 0.
      #
      # Encode duration, not magnitude: roll drift into 30m buckets, default_zero so
      # quiet buckets materialize as 0, then alert on the MIN bucket over 2h. A drain
      # shorter than ~1.5h leaves a trailing 0 bucket -> min 0 -> no page, however
      # large it was; only drift sustained in every 30m bucket for 2h (a real
      # upstream-writer leak) keeps min above threshold. renotify 120 caps spam.
      #
      # rollup(sum, 1800) gives true per-bucket counts on this count metric without
      # .as_count(), which Datadog rejects under a non-sum (min) time aggregator.
      renotify_interval = 120
      message           = <<-EOT
        The session_index reconciler repaired projection drift from SessionDO truth.

        Inspect recent control-plane logs around the affected sessions and compare with
        arcanist.session_index.reprojected grouped by outcome and drift_field by field.
        Steady-state should be ~0; a one-time spike is usually a backlog drain after a
        reconciler/metric deploy. A sustained alert across multiple hours means a state
        field's upstream projection writer is silently drifting: use drift_field (grouped
        by field) to find the drifting column, then trace its SessionDO writer.
        ${var.datadog_slack_handle} @jagrit@trycycloid.com
      EOT
      tags              = ["service:cycloid-control-plane", "component:sessions"]
    }

    trace_queue_export_failures = {
      name            = "[Observability] Trace queue export failures"
      query           = "sum(last_10m):sum:arcanist.trace_queue.export_failures{*}.as_count() > 5"
      critical        = 5
      on_missing_data = "default"
      # 120m: the consumer now has max_retries=3 + a DLQ, so a poison-pill batch
      # self-resolves instead of re-firing for hours (2026-05-29: 5h of renotify
      # spam at 30m). Telemetry loss is non-urgent; 30m renotify added no signal.
      renotify_interval = 120
      message           = <<-EOT
        Trace export failures are preventing control-plane spans from reaching Datadog.

        Failing batches retry up to 3 times, then land in the cycloid-traces-dlq
        queue (no consumer; telemetry loss is acceptable). Sustained firing means a
        systemic exporter fault, not one bad batch.

        Search logs for:
          service:cycloid-control-plane @_direct_post:true @event:trace_queue_export_failed
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:observability"]
    }

    bridge_reconnect_spike = {
      name     = "[Sandbox Bridge] Reconnect spike"
      query    = "sum(last_10m):sum:arcanist.bridge.reconnects{!connect_error_class:ws_404,!close_initiator:remote}.as_count() > 10"
      warning  = 5
      critical = 10
      # Sparse as_count() spike: resolve on no-data so the alert clears when the
      # spike passes instead of sticking in ALERT. See prompt_trace_completeness.
      on_missing_data   = "default"
      renotify_interval = 30
      message           = <<-EOT
        Sandbox bridge error reconnects have spiked, which usually indicates websocket instability, upstream worker pressure, or prompt-impacting socket churn.

        Routine `close_initiator:remote` (control-plane / network-initiated websocket closes — the dominant baseline) and `connect_error_class:ws_404` are excluded so the remaining signal is actionable. Bridge-watchdog and shutdown-initiated closes, plus all `connection_error` reconnects, still alert here.

        Check the "Sandbox Bridge Health" dashboard and split by reconnect_reason, connect_error_class, close_initiator, and prompt_work_in_flight before treating this as user-visible.
        Stale session 404 reconnect loops are monitored separately by "[Sandbox Bridge] Stale session reconnect loop".
        Prompt-impacting closes are monitored separately by "[Sandbox Bridge] Active prompt WebSocket closes".
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:sandbox-bridge"]
    }

    bridge_stale_session_reconnect_loop = {
      name     = "[Sandbox Bridge] Stale session reconnect loop"
      query    = "sum(last_30m):sum:arcanist.bridge.reconnects{connect_error_class:ws_404}.as_count() > 20"
      warning  = 10
      critical = 20
      # Sparse as_count() spike: resolve on no-data so the alert clears when the
      # 404 loop stops instead of sticking in ALERT. See prompt_trace_completeness.
      on_missing_data = "default"
      message         = <<-EOT
        Sandbox bridge reconnects are repeatedly getting websocket 404s, which usually means stale sandbox runtimes are trying to reconnect after the session is no longer routable.

        Check the "Sandbox Bridge Health" dashboard, confirm the sandbox bridge build includes the 404 fatal-stop behavior, and inspect stale E2B runtimes if this persists.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:sandbox-bridge"]
    }

    bridge_protocol_skew = {
      name     = "[Sandbox Bridge] Protocol version skew sustained"
      query    = "sum(last_1h):sum:arcanist.bridge.protocol_skew{*} by {bridge_version,worker_version}.as_count() > 25"
      warning  = 10
      critical = 25
      # Sparse as_count() skew: resolve on no-data so groups clear after old
      # sandbox bridge templates age out.
      on_missing_data   = "default"
      renotify_interval = 240
      message           = <<-EOT
        Sandbox bridge protocol skew has persisted for the version pair in this alert group.

        This usually means live sandboxes are still running an older bridge bundle after a control-plane deploy. Search logs for:
          service:cycloid-sandbox-bridge env:production @event:"bridge.protocol_skew" @bridgeVersion:{{bridge_version.name}} @workerVersion:{{worker_version.name}}

        If skew persists after templates should have rolled, inspect E2B template rollout and session age before adding any compatibility floor.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["component:sandbox-bridge", "component:bridge-protocol"]
    }

    sandbox_connection_issue_spike = {
      name     = "[Sandbox] Connection issue spike by runtime provider"
      query    = "sum(last_15m):sum:arcanist.sandbox.connection_issues{*} by {runtime_provider,runtime_backend}.as_count() > 10"
      warning  = 5
      critical = 10
      # Sparse as_count() spike: resolve on no-data so a per-provider group clears
      # when its spike passes instead of sticking in ALERT. See prompt_trace_completeness.
      on_missing_data   = "default"
      renotify_interval = 30
      message           = <<-EOT
        Sandbox connection issues have spiked for at least one runtime provider/backend.

        This counts control-plane observed abnormal/active-prompt sandbox WebSocket closes, rejected sandbox WebSocket messages, and WebSocket errors. Split arcanist.sandbox.connection_issues by event, reason, close_decision, runtime_provider, and runtime_backend to see whether E2B cloud or self-hosted E2B is implicated.

        Search logs for:
          service:cycloid-control-plane env:production (@event:sandbox_ws_message_rejected OR @event:sandbox_ws_error OR (@event:sandbox_ws_closed (@closeDecision:active_prompt_reconnect_grace OR @closeDecision:abnormal_reconnect_grace)))
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:sandbox-bridge"]
    }

    prompt_watchdog_stale_failed = {
      name     = "[Prompts] Watchdog stale failures"
      query    = "sum(last_15m):sum:arcanist.prompt.watchdog_stale_failed{*}.as_count() > 2"
      warning  = 1
      critical = 2
      # Sparse as_count() spike: resolve on no-data so the alert clears when the
      # spike passes instead of sticking in ALERT. See prompt_trace_completeness.
      on_missing_data   = "default"
      renotify_interval = 30
      message           = <<-EOT
        Watchdog stale failures are reaching users instead of being recovered.

        Search logs for:
          service:cycloid-control-plane @_direct_post:true @event:prompt.watchdog_stale_failed
        ${var.datadog_slack_handle}
        {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
        {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
      EOT
      tags              = ["service:cycloid-control-plane", "component:prompt-lifecycle"]
    }

    # Reuses the prior key so the existing monitor is updated in place (preserves
    # the monitor ID/history); only its attributes change. A single retry
    # exhaustion is expected E2B baseline and no longer pages; this fires only on a
    # cluster (3+ across all origins in 15m), the real disconnect-storm signal.
    prompt_sandbox_disconnect_terminal = {
      name              = "[Prompts] Sandbox disconnect storm"
      query             = "sum(last_15m):sum:arcanist.prompt.sandbox_disconnect_terminal{event:prompt_disconnect_retry_exhausted}.as_count() >= 3"
      critical          = 3
      on_missing_data   = "default"
      renotify_interval = 30
      message           = <<-EOT
        Multiple prompts exhausted sandbox-disconnect retries in one 15m window (>=3 across all origins).

        A single exhaustion is expected baseline: E2B drops a VM, the bounded retry already tried twice, and the root cause is owned by E2B, so singletons do not page. A cluster means a real disconnect storm. Correlate with a recent control-plane deploy (DO restarts) or an E2B provider incident.

        Search logs for:
          service:cycloid-control-plane env:production @_direct_post:true @event:prompt_disconnect_retry_exhausted
        ${var.datadog_slack_handle}
        {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
        {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
      EOT
      tags              = ["service:cycloid-control-plane", "component:prompt-lifecycle", "component:sandbox-bridge"]
    }

    # Distinct, rare failure class: the session could not retry at all (usually
    # already archived). Unlike a storm this points at a control-plane edge case,
    # not E2B flakiness, so a single firing is actionable and keeps paging.
    prompt_sandbox_disconnect_no_retry = {
      name              = "[Prompts] Sandbox disconnect: retry not possible"
      query             = "sum(last_15m):sum:arcanist.prompt.sandbox_disconnect_terminal{event:prompt_failed_sandbox_disconnect}.as_count() > 0"
      critical          = 0
      on_missing_data   = "default"
      renotify_interval = 30
      message           = <<-EOT
        A prompt failed with `sandbox_disconnected` without being able to retry, usually because the session was already archived.

        This is rare and points at a control-plane edge case rather than E2B flakiness, so a single firing is actionable.

        Search logs for:
          service:cycloid-control-plane env:production @_direct_post:true @event:prompt_failed_sandbox_disconnect
        ${var.datadog_slack_handle}
        {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
        {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
      EOT
      tags              = ["service:cycloid-control-plane", "component:prompt-lifecycle", "component:sandbox-bridge"]
    }

    prompt_max_duration_exceeded = {
      name            = "[Prompts] Maximum duration exceeded"
      query           = "sum(last_15m):sum:arcanist.prompt.max_duration_exceeded{*}.as_count() > 2"
      critical        = 2
      on_missing_data = "default"
      # 120m: sessions hitting the ceiling terminate cleanly with a user-visible
      # error (PR #3532), so a residual firing is usually one legitimately long
      # task, not a stuck session. 30m renotify re-paged the same event.
      renotify_interval = 120
      message           = <<-EOT
        Prompts are hitting the hard maximum-duration ceiling.

        Sessions terminate cleanly with a user-visible error when this fires; a
        single firing is usually a legitimately long task. This monitor alerts
        only on clusters; investigate sustained or grouped firings, not
        singletons.

        Search logs for:
          service:cycloid-control-plane env:production @_direct_post:true @event:prompt.max_duration_exceeded
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:prompt-lifecycle"]
    }

    sandbox_tracing_init_failures = {
      name              = "[Sandbox Bridge] Tracing initialization failures"
      query             = "sum(last_15m):sum:arcanist.sandbox.tracing_init_failures{*}.as_count() > 0"
      critical          = 0
      on_missing_data   = "default"
      renotify_interval = 30
      message           = <<-EOT
        Sandbox bridge tracing failed to initialize or is missing collector auth.

        Search logs for:
          @event:"observability.tracing.init"
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:observability"]
    }

    post_execution_failure_spike = {
      name = "[Post Execution] Failure spike by error_code"
      # Grouped by error_code so a page says WHAT failed: a push-path failure
      # (user work at risk) is not the same incident as a benign artifact or
      # summary failure (result still delivered). The error_code tag on the
      # completions metric only exists from this TF apply forward (log-derived
      # metrics are not retroactive); older points group under N/A.
      query    = "sum(last_15m):sum:arcanist.post_execution.completions{outcome:error} by {error_code}.as_count() > 3"
      warning  = 1
      critical = 3
      # Sparse as_count() spike: resolve on no-data so a per-error_code group clears
      # when its spike passes instead of sticking in ALERT. See prompt_trace_completeness.
      on_missing_data = "default"
      message         = <<-EOT
        Post-execution work is failing after prompt completion for at least one
        error code. Treat push-path codes as user-work-at-risk; artifact/summary
        codes are benign (the result was still delivered).

        Review the "Post-Execution and PR Pipeline" dashboard and search:
          service:cycloid-sandbox-bridge @event:"post_execution.completed" @outcome:error
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:post-execution"]
    }

    prompt_behavior_verification_gap = {
      name     = "[Agent Behavior] External-state verification gap"
      query    = "sum(last_30m):sum:arcanist.prompt.behavior_verification_gap{*}.as_count() > 15"
      critical = 15
      # Sparse as_count() spike: resolve on no-data so the alert clears when the
      # gap closes instead of sticking in ALERT. See prompt_trace_completeness.
      on_missing_data   = "default"
      renotify_interval = 120
      message           = <<-EOT
        Agent-quality trend: prompts referenced PRs/issues/external state without a verification tool signal.

        Review the "Agent Behavior and Economics" dashboard and search:
          service:cycloid-sandbox-bridge @event:"prompt.behavior.completed" @referencedExternalState:true @usedVerificationTools:false
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:agent-behavior"]
    }

    prompt_cache_share_regression = {
      name     = "[Sandbox Agent] Cache-token share week-over-week regression"
      query    = "pct_change(sum(last_1d),last_1w):(default_zero((default_zero(sum:arcanist.sandbox_agent.cache_read_tokens{*}.as_count()) + default_zero(sum:arcanist.sandbox_agent.cache_write_tokens{*}.as_count())) / (default_zero(sum:arcanist.sandbox_agent.input_tokens{*}.as_count()) + default_zero(sum:arcanist.sandbox_agent.cache_read_tokens{*}.as_count()) + default_zero(sum:arcanist.sandbox_agent.cache_write_tokens{*}.as_count()))) * 100) < -30"
      warning  = -15
      critical = -30
      # New log-derived metrics are sparse; resolve cleanly when the window is quiet
      # instead of leaving the regression alert stuck after traffic subsides.
      on_missing_data = "default"
      message         = <<-EOT
        Sandbox-agent cache-token share regressed materially week over week.

        Review the "Agent Model Throughput / Efficiency" dashboard and compare the
        cache-token share panels by model. This monitor tracks
        `(cache_read_tokens + cache_write_tokens) / (input_tokens + cache_read_tokens + cache_write_tokens)`
        across all production sandbox-agent traffic.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:agent-runtime", "component:observability"]
    }

    session_resumed_cold_spike = {
      name     = "[Sessions] Cold-restart spike"
      query    = "sum(last_30m):sum:arcanist.session.resumed_cold{*}.as_count() > 10"
      warning  = 5
      critical = 10
      # Sparse as_count() spike: resolve on no-data so the alert clears when the
      # spike passes instead of sticking in ALERT. See prompt_trace_completeness.
      on_missing_data   = "default"
      renotify_interval = 120
      message           = <<-EOT
        Sessions are cold-restarting (sandbox died, next prompt auto-spawned a fresh one) at an elevated rate. Each cold-restart loses in-sandbox state for the user.

        Likely causes:
          - E2B expiring or terminating more sandboxes than usual
          - Spawn failures (check arcanist.prompt.execution_failures grouped by error_code)
          - Bridge bundle / sandbox image version mismatch from a deploy

        Search logs for:
          service:cycloid-control-plane @event:session_resumed_cold
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:sandbox-lifecycle"]
    }

    datadog_logs_ingest_spike = {
      name              = "[Observability] Datadog log-ingest spike"
      query             = "sum(last_1h):sum:datadog.estimated_usage.logs.ingested_events{*}.rollup(sum, 3600) > 300000"
      warning           = 150000
      critical          = 300000
      renotify_interval = 60
      message           = <<-EOT
        Datadog log ingest volume is far above the normal operating band.

        Check Datadog estimated usage first, then split logs by `service`, `source`, `@EventType`, and `@Entrypoint` to isolate the spike quickly.
        This is the cost-safety monitor for runaway observability volume.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["component:observability", "cost-center:datadog"]
    }

    # --- Review Loop (RLA) + QA Tester regression monitors ---------------------
    # Week-over-week pct_change on rate formulas so they self-baseline without paging
    # on pure throughput growth. The numerator/denominator pairs match the
    # "Review Loop & QA Tester" dashboard's rate widgets.
    #
    # The triage fallback regression monitor stays out for now: it needs a verified
    # floor/history gate on top of the rate formula before we reintroduce it.
    review_loop_cap_block_regression = {
      name = "[Review Loop] Cap-block rate week-over-week growth"
      # Only genuine convergence-failure caps — `convergence_failure` is classified at emit time
      # (review-loop-events.ts), so this excludes head_changed restarts, productive truncation parks,
      # teardown/disabled, and operational failures. Kept as a simple tag filter because Datadog monitor
      # queries reject the `IN (...)` operator.
      query             = "pct_change(sum(last_1d),last_1w):(default_zero(sum:arcanist.review_loop.epoch_completed{convergence_failure:true}.as_count()) / (default_zero(sum:arcanist.review_loop.epoch_completed{terminal_status:completed}.as_count()) + default_zero(sum:arcanist.review_loop.epoch_completed{convergence_failure:true}.as_count()))) * 100 > 50"
      warning           = 25
      critical          = 50
      renotify_interval = 120
      on_missing_data   = "default"
      message           = <<-EOT
        The review-loop cap-block rate is more than 50% above the same 1-day window one week ago — the loop is converging worse.

        Open the "Review Loop & QA Tester" dashboard and group "Cap-blocks by reason" by `blocked_reason` to find which cap regressed (attempt vs CI). Correlate with recent control-plane deploys.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:review-loop"]
    }

    review_loop_suspicious_ignored_bot_ingests = {
      name              = "[Review Loop] Suspicious ignored bot ingests"
      query             = "sum(last_30m):sum:arcanist.review_loop.ingest_outcome{source_kind:bot,outcome:ignored,ignored_class:suspicious} by {bot,reason,webhook_kind}.as_count() > 10"
      warning           = 5
      critical          = 10
      renotify_interval = 120
      on_missing_data   = "default"
      message           = <<-EOT
        Review-loop bot review ingests are being ignored for suspicious reasons (`missing_head_sha` / `no_review_listening_session`) for the grouped `bot` + `reason` + `webhook_kind`.

        Low-volume `no_review_listening_session` events are expected during transient timing windows (session publish→listening transitions, lifecycle exits, head changes). Investigate only if sustained or clustered.

        Open the "Review Loop & QA Tester" dashboard and inspect the "Ignored bot ingests by class/kind/bot" widget, then search Datadog logs for:
          service:cycloid-control-plane env:production @_direct_post:true @event:"review_loop.ingest.outcome" @source_kind:bot @outcome:ignored @ignored_class:suspicious @bot:{{bot.name}} @reason:{{reason.name}} @webhook_kind:{{webhook_kind.name}}
        The event carries `@pr_url` / `@session_id` for drill-down.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:review-loop"]
    }

    # `verification_inconclusive_regression` removed: week-over-week pct_change on the QA Tester
    # INCONCLUSIVE *rate* is structurally noise at this volume. QA Tester emits single-digit runs/day,
    # so the inconclusive rate snaps between 0/50/100% on one event and there is no stable weekly
    # baseline to compare against — same failure mode as `verification_exhaustion_regression` below.
    # If QA-effectiveness alerting is wanted later, use an absolute-count monitor with a volume floor
    # (cf. `verification_schedule_failed`), not a rate pct_change.

    # `verification_exhaustion_regression` removed (ε/PR-E2): the week-over-week regression alert on
    # `review_loop.settled{final_state:verification-exhausted}` is retired. The metric still fires — the
    # `verification.run_limit` → NEEDS_YOU(verification_run_limit) terminal (transition.ts) and its
    # emit (live-side-effects.ts) remain — but ONLY for sessions draining out of the legacy VERIFYING
    # gate; the pure-CI cascade routes verdict edges to non-blocking NOTIFY_QA_ISSUE DMs instead. As
    # that stock drains the metric trends to zero, so a week-over-week regression comparison is noise.
    # The drain-observability panel on the "Review Loop & QA Tester" dashboard (datadog-review-loop.tf)
    # stays, charting the count so the tail is visible until stock is gone.

    # QA Tester hand-off is throwing (`schedule_failed`): the QA Tester never starts and the
    # review loop silently retries the same failing hand-off every sweep, so the PR sits in
    # "waiting on verification" indefinitely. Absolute count (these metrics are new / non-retroactive
    # and a healthy system emits ~0), grouped by reason_code so the failure class is on the alert.
    # A single stuck PR re-emits ~6×/30m, so > 3 means "stuck ~15+ min", not a one-off transient.
    verification_schedule_failed = {
      name              = "[QA Tester] Scheduling failing (hand-off stuck)"
      query             = "sum(last_30m):sum:arcanist.qa_tester.schedule_failed{*} by {reason_code}.as_count() > 3"
      warning           = 1
      critical          = 3
      renotify_interval = 120
      on_missing_data   = "default"
      message           = <<-EOT
        QA Tester scheduling is throwing (`schedule_failed`) for one or more PRs — the QA Tester never starts. Retry semantics are FSM_MODE-split (ARC-1330 PR 49): under shadow/off the done-state route 500s before persisting, so the review loop retries the same hand-off every ~5 min (a single stuck PR re-emits ~6×/30m, so > 3 means ~15+ min of failure, not a blip); under live the settle persists first and the D17 sweep repair owns the redelivery, so this monitor firing means the repair pass is also failing to place the spawn.

        Most common cause: the QA Tester session cannot be created — e.g. `reason_code:provider_key_not_validated` ("No validated OpenAI key") when the parent ran on subscription auth. The grouped `reason_code` is on this alert.

        Query Datadog: `@event:qa_tester.schedule.failed` (carries `@error`, `@pr_url`, `@session_id`). Runbook: docs/debugging-runbook.md (QA Tester hand-off).
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:qa-tester"]
    }

    verification_phase_failures = {
      name              = "[QA Tester] Verification phase failures by phase"
      query             = "sum(last_30m):sum:arcanist.verification_phase.phase_failed{*} by {phase,reason_code,agent_runtime_backend}.as_count() > 3"
      warning           = 1
      critical          = 3
      renotify_interval = 120
      on_missing_data   = "default"
      validate          = false
      message           = <<-EOT
        Verification v2 phase prompts are failing before producing usable phase notes.

        Open the "Review Loop & QA Tester" dashboard, Phase pipeline section. Search logs:
          service:cycloid-sandbox-bridge env:production @event:"verification_phase.phase_failed" @phase:{{phase.name}} @reason_code:{{reason_code.name}} @agent_runtime_backend:{{agent_runtime_backend.name}}

        The grouped `phase` and `reason_code` identify whether this is missing phase wiring, timeout, or backend invocation failure.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:qa-tester", "component:verification-phase"]
    }

    verification_phase_judge_repair_malformed = {
      name              = "[QA Tester] Judge repair still malformed"
      query             = "sum(last_30m):sum:arcanist.verification_phase.judge_repair{outcome:malformed} by {route,agent_runtime_backend}.as_count() > 0"
      critical          = 0
      renotify_interval = 120
      on_missing_data   = "default"
      validate          = false
      message           = <<-EOT
        The QA judge returned malformed terminal output and the one repair attempt also remained malformed.

        Search logs:
          service:cycloid-sandbox-bridge env:production @event:"verification_phase.judge_repair" @outcome:malformed @route:{{route.name}} @agent_runtime_backend:{{agent_runtime_backend.name}}

        This is a proof-quality regression: the verifier degrades to an INCONCLUSIVE blocker instead of a clean verdict or skip.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:qa-tester", "component:verification-phase"]
    }

    verification_phase_evidence_promotion_failures = {
      name              = "[QA Tester] Publishable evidence promotion failures"
      query             = "sum(last_30m):sum:arcanist.verification_phase.evidence_promotion{outcome:failed OR outcome:partial_failure} by {failure_reason_code,agent_runtime_backend}.as_count() > 3"
      warning           = 1
      critical          = 3
      renotify_interval = 120
      on_missing_data   = "default"
      validate          = false
      message           = <<-EOT
        QA selected publishable evidence, but the bridge could not promote one or more selected files into the PR evidence directory.

        Search logs:
          service:cycloid-sandbox-bridge env:production @event:"verification_phase.evidence_promotion" @outcome:(failed OR partial_failure) @failure_reason_code:{{failure_reason_code.name}}

        Common causes are missing files, unsafe paths, symlinks, unsupported extensions, or copy failures. This does not change the verifier verdict, but it weakens PR proof.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:qa-tester", "component:verification-evidence"]
    }

    verification_coordinator_spawn_failed = {
      name              = "[QA Tester] Coordinator spawn failures"
      query             = "sum(last_30m):sum:arcanist.verification_coordinator.spawn_failed{reason:schedule_failed} by {source,reason,failure_stage}.as_count() > 3"
      warning           = 1
      critical          = 3
      renotify_interval = 120
      on_missing_data   = "default"
      validate          = false
      message           = <<-EOT
        The QA coordinator admitted verification but the verifier spawn path reported schedule_failed.

        Search logs:
          service:cycloid-control-plane env:production @event:"verification_coordinator.spawn_failed" @source:{{source.name}} @reason:schedule_failed @failure_stage:{{failure_stage.name}}

        `failure_stage:pre_enqueue` means no verifier was enqueued and the coordinator should terminalize to NEEDS_YOU. `failure_stage:post_enqueue` means a verifier child may be running and should settle the row or hit the VERIFYING backstop.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:qa-tester", "component:verification-coordinator"]
    }

    verification_gate_fail_open = {
      name              = "[QA Tester] Verification gate fail-open"
      query             = "sum(last_30m):sum:arcanist.verification_gate.fail_open{*} by {gate}.as_count() > 0"
      critical          = 0
      renotify_interval = 120
      on_missing_data   = "default"
      validate          = false
      message           = <<-EOT
        A QA advisory gate failed open. Verification creation continued, but a duplicate guard, run cap, standalone fallback, or merge-conflict precheck was unavailable.

        Search logs:
          service:cycloid-control-plane env:production @event:"verification_gate.fail_open" @gate:{{gate.name}}

        This is not an auth boundary, but repeated events mean QA admission is running with degraded safety. Check D1 availability, SessionDO reads, and GitHub mergeability reads for the grouped gate.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:qa-tester", "component:verification-gate"]
    }

    verification_artifact_upload_failures = {
      name              = "[QA Tester] Verification artifact upload failures"
      query             = "sum(last_30m):sum:arcanist.post_execution.artifacts_failed{*} by {agent_runtime_backend,model} > 5"
      warning           = 2
      critical          = 5
      renotify_interval = 120
      on_missing_data   = "default"
      message           = <<-EOT
        Verification artifact uploads are failing after evidence was collected.

        Open the "Review Loop & QA Tester" dashboard, Proof quality section. Search logs:
          service:cycloid-sandbox-bridge env:production @event:e2e_post_exec_artifacts @failed:>0 @agent_runtime_backend:{{agent_runtime_backend.name}} @model:{{model.name}}

        This usually indicates artifact endpoint/token/upload issues, not a model proof failure.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:qa-tester", "component:verification-evidence"]
    }

    fsm_parity_divergence = {
      name              = "[FSM] Parity divergence observed"
      query             = "sum(last_1h):sum:arcanist.fsm.parity{result:diverge} by {spine_state,source}.as_count() > 0"
      critical          = 0
      renotify_interval = 120
      on_missing_data   = "default"
      message           = <<-EOT
        The permanent FSM parity checker found a divergence between the spine and independent GitHub/verifier ground truth.

        Open the "Lifecycle FSM (ARC-1330)" dashboard, Parity section. Search logs:
          service:cycloid-control-plane env:production @_direct_post:true @event:"fsm.parity" @result:diverge @spine_state:{{spine_state.name}} @source:{{source.name}}

        Zero parity volume is not clean; read this with the parity volume-floor widget.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:fsm"]
    }

    # A4b SLO for the termination chokepoint (Plan A). Backs the
    # `arcanist.sandbox.disconnect_terminalize{lane,decision,liveness}` count
    # emitted from `confirmRuntimeDeadBeforeTerminalize` (PR #5093). The
    # `decision:terminate,liveness:alive` slice is the A1 invariant violation:
    # an in-flight prompt was killed even though the E2B probe proved its VM
    # alive. A1 always defers on an affirmative probe, so this is structurally
    # ~0 -- a nonzero reading means a kill lane bypassed the chokepoint or
    # routed an alive reading into a terminate. Pages on any occurrence.
    sandbox_terminalize_while_e2b_alive = {
      name     = "[Sandbox survival] in-flight prompt terminalized while E2B alive"
      query    = "sum(last_15m):sum:arcanist.sandbox.disconnect_terminalize{env:production,decision:terminate,liveness:alive}.as_count() > 0"
      critical = 0
      # The violation slice structurally never emits while the chokepoint holds,
      # so treat a metric-absent window as OK (not UNKNOWN).
      on_missing_data   = "default"
      renotify_interval = 60
      message           = <<-EOT
        The termination chokepoint (Plan A1) killed an in-flight prompt and re-cloned its work even though the E2B liveness probe reported the VM alive. The whole point of the chokepoint is that this never happens -- this counter must read ~0.

        A1's authority defers on an affirmative `alive` probe, so reaching `decision:terminate` with `liveness:alive` means a kill lane terminalized outside the chokepoint, or a new caller routed an `alive` reading into a terminate. This is in-flight work loss for the tagged sessions.

        Split `arcanist.sandbox.disconnect_terminalize` by `lane` to see which disconnect lane fired (`reconnect_grace_expiry` vs `liveness_expiry`), and search control-plane logs for `@event:sandbox_disconnect_terminalize_confirmed`. The `decision:defer` series on the same metric is the healthy "gate saved a live prompt" signal.
        ${var.datadog_slack_handle}
        {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
        {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
      EOT
      tags              = ["service:cycloid-control-plane", "component:sandbox-survival"]
    }

    e2b_orphan_reaper_reaped = {
      name     = "[Sandbox] E2B orphan reaper terminated sandboxes"
      query    = "sum(last_15m):sum:arcanist.e2b.orphan_reaper.reaped_per_sweep{*} > 0"
      critical = 0
      # The termination matrix in docs/debugging-runbook.md establishes a zero
      # steady-state baseline: normal session ends are event-driven or owner-DO
      # cleanup paths, so a quiet metric window is healthy.
      on_missing_data   = "default"
      renotify_interval = 60
      message           = <<-EOT
        The E2B orphan reaper terminated at least one sandbox. The expected steady-state value is zero: user stops, archive, publish/error paths, bridge disconnect recovery, and retention cleanup should all resolve through event-driven or owner-DO cleanup before the orphan reaper is needed.

        Start with logs for `@event:e2b_orphan_reaper.swept @reaped:>0`, then correlate `@event:runtime.terminate @source:reaper` to see the sandbox/session attribution. Use docs/debugging-runbook.md "E2B termination matrix" to classify which primary path failed.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:sandbox-reaper"]
    }

    # ARC-1477: the shared Freestyle account holds a VM the prod registry has
    # never seen (aged past 30 min, not deleted). Either another env made it
    # (QA/local on the shared account) or a create response was lost and the
    # VM leaked id-less. ALERT-ONLY: never script a kill from this — deleting
    # an unregistered VM is gated on ARC-1399 env isolation.
    freestyle_vm_audit_unregistered = {
      name     = "[Sandbox] Freestyle audit found unregistered VMs on the shared account"
      query    = "max(last_2h):max:arcanist.freestyle.vm_audit.unregistered_per_sweep{*} > 0"
      critical = 0
      # The audit posts a heartbeat sweep hourly, so a quiet window is data at
      # zero, not missing data.
      on_missing_data   = "default"
      renotify_interval = 240
      validate          = false
      message           = <<-EOT
        The hourly Freestyle VM audit found at least one aged VM on the shared account that this environment's registry (runtime_vm_reservations + session_index) has never recorded. Expected steady state is zero. Suspended VMs accrue quota/cost forever — nothing can auto-delete an unregistered VM (ARC-1399 gate).

        Read the flagged ids from logs: `@event:freestyle_vm_audit.swept @unregisteredCount:>0` (field `unregisteredVms`). Look each id up in the Freestyle dashboard — Cycloid VM names embed the session id (`cycloid-<sessionId>-<sandboxId>`). If it belongs to QA/local, clean it up there; if the name matches no session in any env, it is a true orphan: delete it by exact id in the dashboard and mark the matching `runtime_vm_reservations` row `outcome='reconciled'` if one exists.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:sandbox-reaper"]
    }

    # ARC-1477: a provider vms.create failed AFTER the request was sent
    # (timeout/network/unknown) or a pending reservation never resolved — a VM
    # may exist server-side whose id nobody received. This is the id-less
    # mid-spawn leak; the reservation row is its only trace.
    freestyle_vm_audit_possible_orphans = {
      name              = "[Sandbox] Freestyle create left a possible id-less orphan VM"
      query             = "max(last_2h):max:arcanist.freestyle.vm_audit.possible_orphans_per_sweep{*} > 0"
      critical          = 0
      on_missing_data   = "default"
      renotify_interval = 240
      validate          = false
      message           = <<-EOT
        A Freestyle vms.create failed after the request was sent, so a VM may exist with an id nobody received (or the session DO died mid-create). The reservation trace row carries the session id and the exact VM name the orphan would show in the Freestyle dashboard.

        Read the rows from logs: `@event:freestyle_vm_audit.swept @possibleOrphanCount:>0` (field `possibleOrphanReservations`, includes `vmName` and `spawnAttemptId`). Search the Freestyle dashboard for that name; if a VM exists that no session_index row references, delete it by exact id. Then silence ONLY that row, keyed on the exact `vmName` you matched (the table is one row per create attempt): `UPDATE runtime_vm_reservations SET outcome='reconciled' WHERE runtime_backend='freestyle' AND vm_name='<vmName>' AND outcome IN ('possible_orphan','pending')`. Never key on `session_id` alone — a session that retried the spawn has sibling reservation rows that may still be leaking, and reconciling by session id would silence them too.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:sandbox-reaper"]
    }

    # R3: a 'created' reservation whose session projection moved on, cleared, or
    # vanished but whose VM is STILL live on the shared account — an R1
    # superseded-runtime survivor that no session_index-driven sweep can reach.
    # ALERT-ONLY: the reservations table never feeds a kill (ARC-1399 gate).
    freestyle_vm_audit_superseded = {
      name     = "[Sandbox] Freestyle audit found live superseded-runtime VMs"
      query    = "max(last_2h):max:arcanist.freestyle.vm_audit.superseded_per_sweep{*} > 0"
      critical = 0
      # The audit posts a heartbeat sweep hourly, so a quiet window is data at
      # zero, not missing data.
      on_missing_data   = "default"
      renotify_interval = 240
      # Rare-event metric with zero datapoints at monitor-creation time.
      validate = false
      message  = <<-EOT
        The hourly Freestyle VM audit found at least one live VM whose 'created' reservation's session projection has moved on, cleared, or vanished — the id no session_index sweep can reach (R1 superseded-runtime should have terminated it at cold attach). Expected steady state is zero after R1 deploys; a sustained non-zero value means superseded VMs are surviving the attach terminate and leaking quota/cost.

        Read the flagged rows from logs: `@event:freestyle_vm_audit.swept @supersededCount:>0` (field `supersededVms`, includes `vmId`, `sessionId`, and `vmName`). Look each id up in the Freestyle dashboard; if it belongs to QA/local, clean it up there; if the name matches no live session in any env, it is a true leak — delete it by exact id in the dashboard and mark the matching `runtime_vm_reservations` row `outcome='reconciled'`.
        ${var.datadog_slack_handle}
      EOT
      tags     = ["service:cycloid-control-plane", "component:sandbox-reaper"]
    }

    # R3: a `killed`-state session_index row past the reap grace window whose VM
    # is STILL live on the shared account — an R2 killed-sweep survivor the
    # cleanup cron should have reclaimed. ALERT-ONLY (ARC-1399 gate).
    freestyle_vm_audit_killed_row = {
      name     = "[Sandbox] Freestyle audit found live killed-row VMs past the reap grace"
      query    = "max(last_2h):max:arcanist.freestyle.vm_audit.killed_row_per_sweep{*} > 0"
      critical = 0
      # The audit posts a heartbeat sweep hourly, so a quiet window is data at
      # zero, not missing data.
      on_missing_data   = "default"
      renotify_interval = 240
      # Rare-event metric with zero datapoints at monitor-creation time.
      validate = false
      message  = <<-EOT
        The hourly Freestyle VM audit found at least one live VM whose session_index row is still `runtime_state='killed'` past the reap grace window (R2's killed-row cleanup sweep should have terminated it). Expected steady state is zero after R2 deploys; a sustained non-zero value means killed rows are surviving the cleanup cron and leaking quota/cost.

        Read the flagged rows from logs: `@event:freestyle_vm_audit.swept @killedRowCount:>0` (field `killedRowVms`, includes `vmId` and `sessionId`). Look each id up in the Freestyle dashboard; if it belongs to QA/local, clean it up there; if the name matches no live session in any env, delete it by exact id in the dashboard.
        ${var.datadog_slack_handle}
      EOT
      tags     = ["service:cycloid-control-plane", "component:sandbox-reaper"]
    }

    # ARC-1330 W11-G1 — post-flip soak gate signal #1: FSM live-side-effect FAILURES. FSM_MODE=live routes
    # every committed transition's side effects through the live sink; `fsm.sideeffect.failed` (an executor
    # threw) + `fsm.sideeffect.sink_failed` (a composed sink threw) are the true-error signals. Baseline is
    # STRUCTURALLY ~0 (zero failure events in the 48h pre-instrument window) — the commit stands and D17
    # redelivery covers a single blip, so a SUSTAINED nonzero means side effects (spawn/dispatch/notify) are
    # systematically not running, i.e. degraded live behavior. Slack-only (D17 makes it degraded-not-down,
    # not page-worthy). `default_zero` holds the baseline at 0 so a quiet window never trips.
    fsm_sideeffect_failure_rate = {
      name              = "[ARC-1330] FSM live side-effect failures (post-flip soak gate)"
      query             = "sum(last_1h):default_zero(sum:arcanist.fsm.sideeffect.failed{env:production}.as_count()) + default_zero(sum:arcanist.fsm.sideeffect.sink_failed{env:production}.as_count()) > 20"
      warning           = 5
      critical          = 20
      on_missing_data   = "default"
      renotify_interval = 0
      message           = <<-EOT
        FSM live side-effect failures crossed the post-flip soak baseline (structurally ~0). A committed transition's side effect (`fsm.sideeffect.failed`, an executor throw) or a whole composed sink (`fsm.sideeffect.sink_failed`) is failing at a sustained rate.

        The commit stands and D17 redelivery covers a single blip, so a sustained reading means side effects (verification spawn, epoch dispatch, loud/notify) are systematically not running — degraded live behavior. Open the "Lifecycle FSM (ARC-1330)" dashboard "Side effects" section, split `arcanist.fsm.sideeffect.failed` by `@kind` (and `sink_failed` by `@sink`) to find the failing executor, then read the `fsm.sideeffect.failed`/`sink_failed` logs for the `@error`. While this is red the Wave-11 Section-G deletion gate is NOT clean.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:lifecycle-fsm"]
    }

    # ARC-1330 W11-G1 — post-flip soak gate signal #2: the `noop:unhandled` RATE. `fsm.transition` events
    # tagged `noop:unhandled` are events that arrived at an existing spine row with NO matching edge (a
    # producer emitted an event the FSM cannot handle from that state) — a real edge/producer bug, distinct
    # from `noop:no_record` (backfill gap). The gate wants this rate FLAT: a spike means a producer started
    # emitting events the machine rejects. Rate = unhandled / all fsm.transition events. The bound here is a
    # loose flatness tripwire (no measured pre-soak baseline yet) — TIGHTEN it to ~2× the observed steady
    # rate once the soak establishes it (per the "every monitor actionable" rule). Slack-only.
    fsm_transition_unhandled_rate = {
      name              = "[ARC-1330] FSM unhandled-event rate (post-flip soak gate)"
      query             = "sum(last_4h):default_zero(sum:arcanist.fsm.transition{noop:unhandled,env:production}.as_count()) / default_zero(sum:arcanist.fsm.transition{env:production}.as_count()) * 100 > 10"
      warning           = 5
      critical          = 10
      on_missing_data   = "default"
      renotify_interval = 0
      message           = <<-EOT
        The FSM `noop:unhandled` rate crossed its flatness tripwire. Events are arriving at existing spine rows with no matching edge — a producer is emitting an event the machine cannot handle from that state (an edge/producer regression), NOT a backfill gap (that is the separate `noop:no_record` facet).

        Open the "Lifecycle FSM (ARC-1330)" dashboard "Noop events by kind" widget and split `arcanist.fsm.transition{noop:unhandled}` by `from,fsm_event` to see which (state, event) pair is being rejected, then trace the producer emitting that event. This bound is a loose default; if this is expected traffic, tighten the threshold to ~2× the observed steady rate rather than muting it. While this is spiking the Wave-11 Section-G deletion gate is NOT clean.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:lifecycle-fsm"]
    }

    baseten_daily_spend_guardrail = {
      name = "[Baseten] Daily inference spend guardrail"
      # Reads arcanist.sandbox_agent.usage_cost_usd_micros (datadog-log-metrics.tf), the REAL
      # opencode/Baseten agent inference spend emitted by writeUsageToD1 (ARC-1397). Mirror the
      # dashboard's .as_count() form, micros -> USD.
      query    = "sum(last_1d):sum:arcanist.sandbox_agent.usage_cost_usd_micros{provider:baseten}.as_count() / 1000000 > 50"
      warning  = 25
      critical = 50
      # Spend is sparse pre-GA; resolve on no-data instead of sticking in ALERT.
      on_missing_data = "resolve"
      # Daily rolling window: re-page at most every 4h (low-urgency cost signal;
      # action is "review dashboard, raise cap"), not the 60m module default.
      renotify_interval = 240
      message           = <<-EOT
        Baseten (opencode) inference spend over the last day crossed the guardrail.

        Review the "Baseten / opencode" dashboard and group spend by `model`. Pre-GA,
        opencode traffic should be low; a spike means runaway sessions or a pricing/usage
        regression. Confirm against `usage_records` cost writes before raising the cap.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:baseten-integration", "agent_runtime_backend:opencode"]
    }

    # Prompt-cache regression tripwire (ARC-1580). Cache hit rate = cache_read /
    # (cache_read + uncached input) over the sandbox_agent.usage_event token
    # metrics. Anthropic-backed agents normally sit well above 50% cache reads
    # (system prompt + repo context re-read every turn); a sustained drop means a
    # cache-busting change (prompt prefix churn, cache_control regression) that
    # directly multiplies inference cost. Thresholds are a loose default pending
    # an observed baseline — TIGHTEN once the dashboard establishes steady state
    # (per the "every monitor actionable" rule). provider:anthropic only: Baseten
    # models don't bill cache tiers and would drag the blended ratio to zero.
    prompt_cache_hit_rate_regression = {
      name     = "[ARC-1580] Prompt-cache hit rate regression"
      query    = "sum(last_4h):default_zero(sum:arcanist.sandbox_agent.cache_read_tokens{provider:anthropic}.as_count()) / (default_zero(sum:arcanist.sandbox_agent.cache_read_tokens{provider:anthropic}.as_count()) + default_zero(sum:arcanist.sandbox_agent.input_tokens{provider:anthropic}.as_count())) < 0.3"
      warning  = 0.5
      critical = 0.3
      # The queried token metrics are created in the same apply
      # (datadog-log-metrics.tf) and Terraform has no dependency edge from a
      # query string, so Datadog-side validation could reject the monitor on a
      # fresh apply before the metrics exist. Same pattern as
      # terminal_outcome_coercion above.
      validate = false
      # Datadog rejects on_missing_data:resolve alongside default_zero ("valid
      # value is: default"), so mirror the FSM ratio monitor: default_zero keeps
      # a truly-zero cache-read numerator alerting, and "default" leaves quiet
      # off-hours windows in NO DATA instead of ALERT.
      on_missing_data   = "default"
      renotify_interval = 240
      message           = <<-EOT
        The Anthropic prompt-cache hit rate for sandbox agent inference dropped below threshold over the last 4h.

        Open the "Agent Model Efficiency (ARC-1580)" dashboard and split the cache panel by `model`. A sustained drop usually means a cache-busting change shipped: a churning prompt prefix, reordered system context, or a cache_control regression in the agent runtime. Compare against the deploy timeline before assuming provider behavior changed. Cache misses re-bill the full context every turn, so this directly multiplies spend.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:prompt-lifecycle"]
    }

    automation_slack_delivery_failures = {
      name = "[Automation] Scheduled Slack delivery failures"
      # Scheduled automations (e.g. the daily changelog dogfood, ARC-1195) deliver
      # their digest to a Slack channel. A failure means the rule ran but its
      # output silently never landed. Low volume (~1 fire/day per rule), so alert
      # on any failure over a rolling day.
      query           = "sum(last_1d):sum:arcanist.automation.slack_delivery{outcome:post_failed OR outcome:workspace_not_connected}.as_count() > 0"
      critical        = 0
      on_missing_data = "default"
      # Low-urgency delivery signal; re-page at most every 4h, not the 60m default.
      renotify_interval = 240
      message           = <<-EOT
        A scheduled automation could not deliver its Slack digest
        (outcome:post_failed or workspace_not_connected). The rule still ran; only
        delivery failed, so its output is invisible until this is fixed.

        Usual cause: the Cycloid bot was removed from the target channel, or the
        workspace was disconnected. Re-invite the bot / reconnect the workspace,
        then check `last_delivery_error` on the scheduled rule. Break down by
        `outcome`: https://us5.datadoghq.com/metric/explorer?exp_metric=arcanist.automation.slack_delivery

        Slack-only trend signal, not a page.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:automation-delivery"]
    }
  }

  log_alerts = {
    control_plane_4xx_spike = {
      name              = "[Reliability] Control-plane 4xx spike"
      query             = "logs(\"service:cycloid-control-plane env:production @span.name:worker.fetch @span.http.status_code:[400 TO 499] -@span.http.status_code:404 -@span.http.route:*sandbox/telemetry/* -(@span.http.status_code:401 @span.http.route:*auth/me*) -(@span.http.status_code:401 @span.http.route:*api/settings*) -(@span.http.status_code:401 @span.http.route:*sessions*events*) -(@span.http.status_code:401 @span.http.route:*/ws*) -(@span.http.status_code:401 @span.http.route:*sessions*view*)\").index(\"*\").rollup(\"count\").last(\"10m\") > 200"
      warning           = 100
      critical          = 200
      renotify_interval = 60
      message           = <<-EOT
        Control-plane 4xx responses spiked. This usually means a broken client or
        deploy rollout spraying 4xx, not an attack: benign logged-out and
        reconnect 401s (/auth/me, /api/settings, session events, websocket + view
        streams) are excluded from this query.

        Check recent control-plane deploys first, then search logs:
          service:cycloid-control-plane env:production @span.name:worker.fetch @span.http.status_code:[400 TO 499] -@span.http.status_code:404 -@span.http.route:*sandbox/telemetry/* -(@span.http.status_code:401 @span.http.route:*auth/me*) -(@span.http.status_code:401 @span.http.route:*api/settings*) -(@span.http.status_code:401 @span.http.route:*sessions*events*) -(@span.http.status_code:401 @span.http.route:*/ws*) -(@span.http.status_code:401 @span.http.route:*sessions*view*)
        Split by @span.http.route and @span.http.status_code to find the offending
        route/status. Roll back the suspect deploy if the surge maps to one.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:reliability"]
    }

    pending_signup_burst = {
      name              = "[Security] Pending signup burst"
      query             = "logs(\"service:cycloid-control-plane env:production @_direct_post:true @event:pending_signup_created\").index(\"*\").rollup(\"count\").last(\"15m\") > 10"
      warning           = 5
      critical          = 10
      renotify_interval = 60
      message           = <<-EOT
        Pending GitHub signups are arriving above the expected invite/onboarding
        rate. Check for signup abuse before approving new users.

        Search logs:
          service:cycloid-control-plane env:production @_direct_post:true @event:pending_signup_created
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:security", "component:auth"]
    }

    session_create_rate_limit_trips = {
      name              = "[Security] Session-create rate limit trips"
      query             = "logs(\"service:cycloid-control-plane env:production @event:session_admission_rejected @code:session_create_rate_limited\").index(\"*\").rollup(\"count\").last(\"10m\") > 3"
      warning           = 1
      critical          = 3
      renotify_interval = 60
      message           = <<-EOT
        Session creation hit the per-business burst limiter repeatedly.

        Search logs:
          service:cycloid-control-plane env:production @event:session_admission_rejected @code:session_create_rate_limited
        Split by @businessId and @ownerUserId.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:security", "component:sessions"]
    }

    # Session-start DO initialize failures. createSessionState opts the DO
    # `/session/initialize` fetch into the bounded `withDORetry` retry, so a single
    # transient Cloudflare DO/D1 blip is absorbed silently. Reaching this event
    # means the initialize FAILED (retry exhausted, a non-retryable throw, or a
    # non-ok DO response), across every creation entrypoint (Slack/API/UI/CLI/
    # Linear). The event is direct-posted to Datadog (control-plane createLogger
    # output is not shipped), so this log query sees it. Rate-based so an isolated
    # one-off does not page; a sustained cluster (a regional DO incident like
    # 2026-07-03) does. Pages: session-start failure is directly user-visible
    # ("could not start this session").
    session_start_do_initialize_failures = {
      name              = "[Sessions] Session-start DO initialize failures"
      query             = "logs(\"service:cycloid-control-plane env:production @event:session_start.do_initialize_failed\").index(\"*\").rollup(\"count\").last(\"5m\") > 3"
      warning           = 1
      critical          = 3
      renotify_interval = 60
      # Sparse as_count()-style spike: resolve on no-data so the group clears when
      # the cluster passes instead of sticking in ALERT and re-paging.
      on_missing_data = "resolve"
      message         = <<-EOT
        Session-start Durable Object initialize is failing after the bounded
        transient-storage retry. This is user-visible: affected sessions surface
        "Cycloid could not start this session".

        Check the Cloudflare status page for a Durable Objects / D1 regional
        incident first, then search logs:
          service:cycloid-control-plane env:production @event:session_start.do_initialize_failed
        Split by @reason, @entrypoint, and @businessId. `reason:retry_exhausted`
        is a transient DO fault that survived the retry budget (platform incident);
        `reason:threw` is a non-retryable first-attempt throw; `reason:status_<code>`
        points at the DO handler returning a non-ok response.
        ${var.datadog_slack_handle}
        {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
        {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
      EOT
      tags            = ["service:cycloid-control-plane", "component:sessions"]
    }

    admin_token_use = {
      name              = "[Security] Admin token used"
      query             = "logs(\"service:cycloid-control-plane env:production @action:admin_token_used\").index(\"*\").rollup(\"count\").last(\"5m\") > 0"
      critical          = 0
      renotify_interval = 60
      message           = <<-EOT
        The root-tier admin bearer token was used in production.

        Search logs:
          service:cycloid-control-plane env:production @action:admin_token_used
        Confirm the path and operator were expected. Prefer scoped user/CI tokens
        for routine access.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:security", "component:auth"]
    }

    # Replaces the hand-made "[Cycloid] Worker P95 Latency > 5s" monitor
    # (18660641, created 2026-03-21 in the Datadog UI, never in Terraform).
    # Fixes vs the original: env-scoped to production, and excludes the SSE
    # event-stream route plus WebSocket upgrade route whose legitimately
    # long-lived requests made the all-routes p95 flap (11 alert cycles
    # 2026-05-26..06-10, plus WS upgrade samples during the 2026-06-11
    # incident). The root span tags http.route with the raw url.pathname
    # (router.ts), so the exclusion must be a path wildcard, not a route
    # template. Delete the hand-made monitor manually after this evaluates green
    # (documented one-time exception: it was never TF state, so there is nothing
    # to drift).
    # No warning threshold: the all-routes p95 normally rides ~2.5-3.2s (the
    # /view route alone sits at a ~5s p95 and pulls the aggregate up), so a
    # warning at 3s lived inside the normal operating band and flapped OK<->WARN
    # continuously - the composite below relayed every crossing to Slack (warn
    # band == normal band). This monitor's job is the >5s critical signal;
    # critical_recovery adds hysteresis so it does not chatter at the 5s
    # boundary either. (Per-route latency, e.g. /view, is a separate perf
    # workstream, not something an all-routes p95 warning can express.)
    worker_p95_latency = {
      name              = "[Control Plane] Worker P95 latency > 5s (non-streaming)"
      query             = "logs(\"service:cycloid-control-plane env:production @span.name:worker.fetch -@span.http.route:*/events -@span.http.route:*/ws -@span.http.status_code:101\").index(\"*\").rollup(\"pc95\", \"@span.duration_ms\").last(\"15m\") > 5000"
      critical          = 5000
      critical_recovery = 4500
      renotify_interval = 120
      message           = <<-EOT
        Control-plane worker P95 latency is above the normal operating band on
        non-streaming, non-WebSocket routes (SSE event streams and WebSocket
        upgrades are excluded; they are long-lived by design).

        Check worker.fetch spans in Log Explorer, split by @span.http.route,
        and D1 query performance.

        This monitor does not page directly; it feeds the composite "[Control Plane] Worker P95 latency elevated (not explained by D1)" so a D1 incident pages once via the D1 monitors instead of here as well.
      EOT
      tags              = ["service:cycloid-control-plane", "component:control-plane"]
    }

    # Replaces the hand-made "[Cycloid] Worker Error Rate > 20%" monitor
    # (18660639, created 2026-03-21 in the Datadog UI, never in Terraform).
    # The original was misnamed (an absolute count, not a rate), matched
    # service:cycloid-* with no env filter (so bridge errors and non-prod
    # noise paged here too), and notified a different channel. This one is
    # env-scoped to the production control plane only - bridge errors stay on
    # their dedicated monitors - with thresholds raised above the flap band
    # (7 alert cycles 2026-05-26..06-10 at >20/30m). Delete the hand-made
    # monitor manually after this evaluates green.
    worker_error_count = {
      name = "[Control Plane] Worker request errors elevated"
      # Root request spans only (@span.name:worker.fetch), counting BOTH thrown
      # errors (@span.status:error) and handled 5xx responses: the router closes
      # the root span "ok" with http.status_code when a handler returns a 5xx
      # (router.ts), so status:error alone misses most production 5xx volume.
      query             = "logs(\"service:cycloid-control-plane env:production @span.name:worker.fetch (@span.status:error OR @span.http.status_code:[500 TO 599])\").index(\"*\").rollup(\"count\").last(\"30m\") > 100"
      warning           = 50
      critical          = 100
      renotify_interval = 120
      message           = <<-EOT
        Production control-plane requests are failing (thrown error or 5xx
        response) at an elevated absolute volume (failed requests per 30m, not
        a percentage).

        Check worker.fetch spans in Log Explorer, split by @span.http.route
        and @span.error.message to find the failing route.

        This monitor does not page directly; it feeds the composite "[Control Plane] Worker request errors elevated (not explained by D1)" so a D1 incident pages once via the D1 monitors instead of here as well.
      EOT
      tags              = ["service:cycloid-control-plane", "component:control-plane"]
    }

    # Emitted by recordLinearWebhookDrop (webhooks/shared.ts) for every Linear
    # webhook the handler drops: timestamp rejections, tenant/actor skips,
    # claim losses, transient 503s, and bootstrap failures. Excludes
    # stale_session_ref_displaced here because that recovery path is monitored
    # separately below: the handler removes a dead issue ref and then continues
    # to create the new session. The 2026-06-10 label-burst incident silently
    # lost 4 issue
    # triggers; critical is >3 so a repeat of that exact burst pages instead of
    # only warning. Reasons include user-actionable skips (e.g.
    # repo_not_authorized), so warning still tolerates occasional drops.
    linear_webhook_dropped = {
      name              = "[Linear] Webhook triggers being dropped"
      query             = "logs(\"service:cycloid-control-plane env:production @event:linear.webhook_dropped -@reason:stale_session_ref_displaced\").index(\"*\").rollup(\"count\").last(\"30m\") > 3"
      warning           = 2
      critical          = 3
      renotify_interval = 60
      message           = <<-EOT
        Linear webhooks are being dropped before creating a session, so labeled
        issues may silently fail to trigger.

        Search logs for:
          service:cycloid-control-plane env:production @event:linear.webhook_dropped -@reason:stale_session_ref_displaced
        Split by `reason`: session_setup_failed / session_bootstrap_failed /
        session_claim_lost indicate control-plane faults; repo_* and actor skips
        are user-configuration issues. stale_session_ref_displaced is excluded
        here and covered by the stale-ref displacement monitor because it means a
        dead old ref was removed before retrying the issue. Cross-check the
        session_bootstrap_skipped lifecycle events in D1 for the affected
        linearIssueId.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:control-plane"]
    }

    linear_stale_session_ref_displaced = {
      name              = "[Linear] Stale issue refs being displaced"
      query             = "logs(\"service:cycloid-control-plane env:production @event:linear.webhook_dropped @reason:stale_session_ref_displaced\").index(\"*\").rollup(\"count\").last(\"30m\") > 10"
      warning           = 5
      critical          = 10
      renotify_interval = 60
      message           = <<-EOT
        Linear issue refs are being displaced at elevated volume.

        This is normally a self-healing path: the handler removes a dead old ref,
        then retries the issue and should emit `webhook_followup_enqueued` for the
        new session. High volume means stale refs are accumulating or recovery may
        be unreliable.

        Search logs for:
          service:cycloid-control-plane env:production @event:linear.webhook_dropped @reason:stale_session_ref_displaced
        Cross-check D1 integration_lifecycle_events for nearby
        webhook_followup_enqueued rows for the affected Linear issues. Hard
        setup/bootstrap failures remain covered by the Linear dropped-webhook
        monitor via session_setup_failed / session_bootstrap_failed.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:control-plane"]
    }

    prompt_execution_failed_logs = {
      name              = "[Prompts] Prompt execution failed (logs)"
      query             = "logs(\"service:cycloid-sandbox-bridge env:production status:error \\\"Prompt execution failed\\\"\").index(\"*\").rollup(\"count\").last(\"15m\") > 3"
      warning           = 1
      critical          = 3
      renotify_interval = 30
      message           = <<-EOT
        Prompt execution is failing for end users (log-based safety net).

        Search logs for:
          service:cycloid-sandbox-bridge env:production status:error "Prompt execution failed"
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:prompt-lifecycle"]
    }

    push_to_origin_failed = {
      name              = "[Sandbox Bridge] Git push to origin failing"
      query             = "logs(\"service:cycloid-sandbox-bridge env:production status:error (\\\"Failed to push to origin after retries\\\" OR \\\"clone-token auth persistently rejected\\\" OR \\\"clone-token refresh failed; aborting push\\\")\").index(\"*\").rollup(\"count\").last(\"15m\") > 0"
      critical          = 0
      renotify_interval = 30
      message           = <<-EOT
        The sandbox bridge could not push the agent's commits to origin, so the user's
        "done" state never lands as a PR. This also covers pushes aborted before any
        git push attempt because the clone-token refresh failed (auth rejection or
        timeout/network/5xx exhaustion).

        Search logs for:
          service:cycloid-sandbox-bridge env:production status:error ("Failed to push to origin after retries" OR "clone-token auth persistently rejected" OR "clone-token refresh failed; aborting push")
        ${var.datadog_slack_handle}
        {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
        {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:sandbox-bridge"]
    }

    bridge_fatal_connection_error = {
      name              = "[Sandbox Bridge] Fatal connection error spike"
      query             = "logs(\"service:cycloid-sandbox-bridge env:production status:error \\\"Fatal connection error\\\"\").index(\"*\").rollup(\"count\").last(\"15m\") > 5"
      warning           = 2
      critical          = 5
      renotify_interval = 30
      message           = <<-EOT
        Sandbox bridge is hitting fatal connection errors. Sessions typically die when this
        fires, so users see tasks stall or disconnect.

        Search logs for:
          service:cycloid-sandbox-bridge env:production status:error "Fatal connection error"
        ${var.datadog_slack_handle}
        {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
        {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
      EOT
      tags              = ["service:cycloid-sandbox-bridge", "component:sandbox-bridge"]
    }

    preview_launch_failed = {
      name     = "[Sandbox Bridge] Preview launch failed"
      query    = "logs(\"service:cycloid-sandbox-bridge env:production status:warn \\\"Preview launch failed\\\"\").index(\"*\").rollup(\"count\").last(\"15m\") > 3"
      critical = 3
      message  = <<-EOT
        The preview feature failed to launch for multiple sessions. Users cannot see
        their running apps.

        Search logs for:
          service:cycloid-sandbox-bridge env:production status:warn "Preview launch failed"
        ${var.datadog_slack_handle}
      EOT
      tags     = ["service:cycloid-sandbox-bridge", "component:preview"]
    }

    automation_session_create_failed = {
      name              = "[Automation] Scheduled session create/enqueue failed"
      query             = "logs(\"service:cycloid-control-plane env:production @_direct_post:true (@event:automation.session_create_failed OR @event:automation.prompt_enqueue_failed)\").index(\"*\").rollup(\"count\").last(\"30m\") > 2"
      warning           = 1
      critical          = 2
      renotify_interval = 60
      message           = <<-EOT
        Scheduler ticks are failing to create or enqueue automation sessions, so
        scheduled rules are silently dropping fires for end customers.

        Search logs for:
          service:cycloid-control-plane env:production @_direct_post:true (@event:automation.session_create_failed OR @event:automation.prompt_enqueue_failed)
        Investigate `reason`; if persistent, check D1 + integration-gate health.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:automation"]
    }

    automation_rule_disabled = {
      name              = "[Automation] Scheduled rule auto-disabled"
      query             = "logs(\"service:cycloid-control-plane env:production @_direct_post:true @event:automation.rule_disabled\").index(\"*\").rollup(\"count\").last(\"1h\") > 0"
      critical          = 0
      renotify_interval = 240
      message           = <<-EOT
        The scheduler durably disabled a customer's scheduled rule after a non-retryable
        integration gate failure, such as a missing install, inaccessible repo, revoked
        token, or actor mismatch. Reach out to the customer before the next expected
        fire window.

        Search logs for:
          service:cycloid-control-plane env:production @_direct_post:true @event:automation.rule_disabled
        Split by `reason_code` and `stage` to identify the disable cause.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:automation"]
    }

    automation_publish_failed = {
      name              = "[Automation] Scheduled publish failed"
      query             = "logs(\"service:cycloid-control-plane env:production @_direct_post:true @event:publish_failed @initiation_mode:automation\").index(\"*\").rollup(\"count\").last(\"30m\") > 2"
      warning           = 1
      critical          = 2
      renotify_interval = 60
      message           = <<-EOT
        Publishes for scheduled (initiation_mode:automation) sessions are failing at a
        higher rate than the publish-failure baseline. Slice scheduled vs interactive
        in Datadog by `@initiation_mode` before paging support.

        Search logs for:
          service:cycloid-control-plane env:production @_direct_post:true @event:publish_failed @initiation_mode:automation
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:automation"]
    }

    # Queue-health coverage note: the Datadog Cloudflare integration is not
    # installed (no cloudflare.* metrics in us5 as of 2026-06-11), so queue
    # backlog depth is not directly observable. These log alerts cover the
    # failure ends of each queue instead: consumer crashes and permanently
    # lost work. cycloid-traces already alerts via trace_queue_export_failures.
    memory_analysis_jobs_terminalized = {
      name              = "[Memory] Analysis jobs terminalized after max attempts"
      query             = "logs(\"service:cycloid-control-plane env:production @event:memory.jobs_terminalized\").index(\"*\").rollup(\"count\").last(\"1h\") > 0"
      critical          = 0
      renotify_interval = 240
      message           = <<-EOT
        The cron sweep permanently failed memory-analysis jobs that exhausted
        MEMORY_JOB_MAX_ATTEMPTS. This is the only path where memory-analysis work
        is truly lost (the cycloid-memory-analysis queue has no DLQ on purpose;
        the sweep re-enqueues dropped batches until this point).

        Search logs for:
          service:cycloid-control-plane env:production @event:memory.jobs_terminalized
        Then inspect memory_analysis_jobs rows with status='failed' and
        error='max attempts exhausted' to find the failing repo/session.
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:memory"]
    }

    memory_analysis_consumer_errors = {
      name              = "[Memory] Analysis queue consumer errors elevated"
      query             = "logs(\"service:cycloid-control-plane env:production @event:memory.consumer_error\").index(\"*\").rollup(\"count\").last(\"30m\") > 5"
      warning           = 2
      critical          = 5
      renotify_interval = 60
      message           = <<-EOT
        The cycloid-memory-analysis queue consumer is throwing unhandled errors.
        Individual jobs are retried by the cron sweep, but a sustained error rate
        means memory analysis is effectively down.

        Search logs for:
          service:cycloid-control-plane env:production @event:memory.consumer_error
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:memory"]
    }

    memory_refine_failed = {
      name              = "[Memory] Refine queue batches failing"
      query             = "logs(\"service:cycloid-control-plane env:production @event:memory.refine_failed\").index(\"*\").rollup(\"count\").last(\"30m\") > 3"
      warning           = 1
      critical          = 3
      renotify_interval = 60
      message           = <<-EOT
        cycloid-memory-refine batches are failing. After max_retries=3 they land in
        cycloid-memory-refine-dlq, which has no consumer, so sustained failures mean
        refine work is being lost.

        Search logs for:
          service:cycloid-control-plane env:production @event:memory.refine_failed
        ${var.datadog_slack_handle}
      EOT
      tags              = ["service:cycloid-control-plane", "component:memory"]
    }

  }
}

module "datadog_log_metrics" {
  source = "./modules/datadog-log-metric"

  metrics = {
    blocked_dm_delivery_attempts = {
      name             = "arcanist.blocked_dm.delivery_attempts"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:\"blocked_dm\""
      group_by = [
        { path = "@kind", tag_name = "kind" },
        { path = "@outcome", tag_name = "outcome" },
        { path = "@origin", tag_name = "origin" },
      ]
    }

    terminal_outcome_coercions = {
      name             = "arcanist.prompt.terminal_outcome_coercions"
      aggregation_type = "count"
      filter_query     = "env:production @event:\"terminal_outcome_coerced\""
      group_by = [
        { path = "@source", tag_name = "source" },
        { path = "@raw_success", tag_name = "raw_success" },
        { path = "@normalized_outcome", tag_name = "normalized_outcome" },
        { path = "@error_code", tag_name = "error_code" },
      ]
    }

    # ErrorCode union drift signal (ARC-1622): a producer-set terminal error
    # code was outside the ErrorCode union and normalizeTerminalOutcome
    # collapsed it to "unknown". raw_error_code names the unrecognized code so
    # the union (or the producer) can be fixed instead of the failure class
    # silently disappearing from execution_failures.
    terminal_error_code_coercions = {
      name             = "arcanist.prompt.terminal_error_code_coercions"
      aggregation_type = "count"
      filter_query     = "env:production @event:\"terminal_error_code_coerced\""
      group_by = [
        { path = "@source", tag_name = "source" },
        { path = "@raw_error_code", tag_name = "raw_error_code" },
      ]
    }

    session_active_duration = {
      name                = "arcanist.session.active_duration"
      aggregation_type    = "distribution"
      path                = "@activeDurationMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"session.completed\" @activeDurationMs:>0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@terminalStage", tag_name = "terminal_stage" },
        { path = "@prCreated", tag_name = "pr_created" },
        { path = "@sessionKind", tag_name = "session_kind" },
      ]
    }

    session_total_duration_ms = {
      name                = "arcanist.session.total_duration_ms"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"session.completed\" @duration_ms:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@repo", tag_name = "repo" },
        { path = "@terminalStage", tag_name = "terminal_stage" },
        { path = "@prCreated", tag_name = "pr_created" },
        { path = "@sessionKind", tag_name = "session_kind" },
      ]
    }

    sandbox_creation_to_ready_ms = {
      name                = "arcanist.sandbox.creation_to_ready_ms"
      aggregation_type    = "distribution"
      path                = "@session_creation_to_sandbox_ready_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"sandbox.ready\" @session_creation_to_sandbox_ready_ms:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@repo", tag_name = "repo" },
        { path = "@spawn_path", tag_name = "spawn_path" },
        { path = "@runtime_backend", tag_name = "runtime_backend" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    session_stage_duration_ms = {
      name                = "arcanist.session.stage_duration_ms"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"session.stage_timing\" @duration_ms:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@repo", tag_name = "repo" },
        { path = "@stage", tag_name = "stage" },
        { path = "@terminalStage", tag_name = "terminal_stage" },
        { path = "@prCreated", tag_name = "pr_created" },
        { path = "@sessionKind", tag_name = "session_kind" },
      ]
    }

    prompt_execution_duration = {
      name                = "arcanist.prompt.execution_duration"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "env:production @event:\"prompt.complete\" @step:execution @phase_status:completed @duration_ms:*"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
        { path = "@agent", tag_name = "agent" },
      ]
    }

    prompt_time_to_first_message = {
      name                = "arcanist.prompt.time_to_first_message"
      aggregation_type    = "distribution"
      path                = "@time_to_first_message_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.first_message\" @time_to_first_message_ms:*"
      group_by = [
        { path = "@first_event_type", tag_name = "first_event_type" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
        { path = "@agent", tag_name = "agent" },
        { path = "@is_followup", tag_name = "is_followup" },
      ]
    }

    prompt_received_to_first_visible_event_ms = {
      name                = "arcanist.prompt.received_to_first_visible_event_ms"
      aggregation_type    = "distribution"
      path                = "@prompt_received_to_first_visible_event_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.first_visible_event\" @prompt_received_to_first_visible_event_ms:*"
      group_by = [
        { path = "@first_event_type", tag_name = "first_event_type" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
        { path = "@agent", tag_name = "agent" },
        { path = "@is_followup", tag_name = "is_followup" },
      ]
    }

    # Bucket A of the warm-session per-turn latency split: prompt receipt to the
    # dispatch boundary (all pre-dispatch bridge work). Emitted by the bridge in
    # apps/sandbox-bridge/src/bridge.ts (event prompt.predispatch). Per-substep
    # durations (setup_ms, memory_ranking_ms, baseline_capture_ms, etc.) ride on
    # the same log and are read via Log Analytics rather than a metric each.
    prompt_predispatch_ms = {
      name                = "arcanist.prompt.predispatch_ms"
      aggregation_type    = "distribution"
      path                = "@predispatch_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.predispatch\" @predispatch_ms:*"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
        { path = "@agent", tag_name = "agent" },
        { path = "@is_followup", tag_name = "is_followup" },
        { path = "@has_memories", tag_name = "has_memories" },
      ]
    }

    memory_context_selector_latency_ms = {
      name                = "arcanist.memory_context.selector_latency_ms"
      aggregation_type    = "distribution"
      path                = "@selectorLatencyMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true (@event:\"memory_context.selector_returned\" OR @event:\"memory_context.selector_returned_empty\") @selectorLatencyMs:>=0"
      group_by = [
        { path = "@selectorStatus", tag_name = "selector_status" },
        { path = "@mode", tag_name = "mode" },
      ]
    }

    memory_context_selector_results = {
      name             = "arcanist.memory_context.selector_results"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true (@event:\"memory_context.selector_returned\" OR @event:\"memory_context.selector_returned_empty\")"
      group_by = [
        { path = "@selectorStatus", tag_name = "selector_status" },
        { path = "@event", tag_name = "selector_event" },
        { path = "@mode", tag_name = "mode" },
      ]
    }

    # Pre-bridge queue wait inside the control-plane DO: prompt enqueue to the
    # moment the bridge handoff actually begins. This fills the latency gap
    # ahead of bucket A (`prompt.predispatch_ms`) for queued / warm / cold
    # dispatches.
    prompt_queue_wait_ms = {
      name                = "arcanist.prompt.queue_wait_ms"
      aggregation_type    = "distribution"
      path                = "@queue_wait_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"prompt.queue_wait\" @queue_wait_ms:*"
      group_by = [
        { path = "@dispatch_path", tag_name = "dispatch_path" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
      ]
    }

    # Bucket B of the split: dispatch boundary to the first raw Codex stream
    # signal (model time-to-first-event). Emitted by the bridge (event
    # prompt.dispatch_to_first_event). reasoning_effort is indexed here because
    # it is the bucket-B lever Phase 3 would tune.
    prompt_dispatch_to_first_event_ms = {
      name                = "arcanist.prompt.dispatch_to_first_event_ms"
      aggregation_type    = "distribution"
      path                = "@dispatch_to_first_event_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.dispatch_to_first_event\" @dispatch_to_first_event_ms:*"
      group_by = [
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
        { path = "@agent", tag_name = "agent" },
        { path = "@reasoning_effort", tag_name = "reasoning_effort" },
        { path = "@is_followup", tag_name = "is_followup" },
        { path = "@has_memories", tag_name = "has_memories" },
        { path = "@first_event_type", tag_name = "first_event_type" },
      ]
    }

    prompt_backend_first_token_ms = {
      name                = "arcanist.prompt.backend_first_token_ms"
      aggregation_type    = "distribution"
      path                = "@offset_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.dispatch_subspan\" @span:backend_first_token @offset_ms:*"
      group_by = [
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
        { path = "@agent", tag_name = "agent" },
        { path = "@reasoning_effort", tag_name = "reasoning_effort" },
        { path = "@is_followup", tag_name = "is_followup" },
        { path = "@has_memories", tag_name = "has_memories" },
        { path = "@signal", tag_name = "signal" },
      ]
    }

    prompt_received_to_thinking_ms = {
      name                = "arcanist.prompt.received_to_thinking_ms"
      aggregation_type    = "distribution"
      path                = "@received_to_thinking_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.received_to_thinking\" @received_to_thinking_ms:*"
      group_by = [
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
        { path = "@agent", tag_name = "agent" },
        { path = "@reasoning_effort", tag_name = "reasoning_effort" },
        { path = "@is_followup", tag_name = "is_followup" },
        { path = "@has_memories", tag_name = "has_memories" },
        { path = "@signal", tag_name = "signal" },
      ]
    }

    prompt_bridge_delay_ms = {
      name                = "arcanist.prompt.bridge_delay_ms"
      aggregation_type    = "distribution"
      path                = "@bridge_delay_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.dispatch_subspans_completed\" @bridge_delay_ms:*"
      group_by = [
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
        { path = "@agent", tag_name = "agent" },
        { path = "@reasoning_effort", tag_name = "reasoning_effort" },
        { path = "@is_followup", tag_name = "is_followup" },
      ]
    }

    # Bucket B subspan offsets emitted by DispatchLatencyTracker (event
    # prompt.dispatch_subspan). One metric grouped by span turns the dispatch
    # waterfall milestones into queryable series without creating a metric per
    # milestone. Pre-dispatch markers can be negative because the anchor is the
    # actual dispatch boundary.
    prompt_dispatch_subspan_offset_ms = {
      name                = "arcanist.prompt.dispatch_subspan_offset_ms"
      aggregation_type    = "distribution"
      path                = "@offset_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.dispatch_subspan\" @offset_ms:* @span:*"
      group_by = [
        { path = "@span", tag_name = "span" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    # Duration of the actual backend send step inside the dispatch waterfall.
    # This rides on the prompt_sent_to_backend subspan and lets dashboards split
    # transport/send overhead from model time-to-first-event.
    prompt_send_duration_ms = {
      name                = "arcanist.prompt.prompt_send_duration_ms"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.dispatch_subspan\" @span:\"prompt_sent_to_backend\" @duration_ms:*"
      group_by = [
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    # Duration of each pulse-wrapped prompt-activity phase (event
    # prompt.activity_phase), emitted by PromptActivityReporter.withPromptActivityPulse.
    prompt_activity_phase_duration = {
      name                = "arcanist.prompt.activity_phase_duration"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.activity_phase\" @duration_ms:*"
      group_by = [
        { path = "@phase", tag_name = "phase" },
        { path = "@outcome", tag_name = "outcome" },
      ]
    }

    # Real workspace dependency-setup wall time emitted once per session from
    # the bridge's workspace_setup_timing log. setup_kind is the fixed
    # start-bridge vocabulary (npm/pnpm/repo_setup_script/*_skip_existing).
    prompt_workspace_setup_ms = {
      name                = "arcanist.prompt.workspace_setup_ms"
      aggregation_type    = "distribution"
      path                = "@setup_execution_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.dispatch\" @step:workspace_setup_timing @setup_execution_ms:*"
      group_by = [
        { path = "@setup_kind", tag_name = "setup_kind" },
      ]
    }

    # Count foreground + background workspace-setup timeouts. This stays a
    # separate counter from workspace_setup_ms because timed-out sessions do not
    # necessarily emit the completion-side timing breadcrumb.
    prompt_workspace_setup_timeouts = {
      name             = "arcanist.prompt.workspace_setup_timeouts"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.dispatch\" @step:workspace_setup @phase_status:timeout @timeout_ms:*"
    }

    # In-VM repo clone/fetch duration recorded by start-bridge.sh and surfaced
    # on the sandbox.spawn completion log as the raw repo_prep_ms field.
    sandbox_repo_prep_ms = {
      name                = "arcanist.sandbox.repo_prep_ms"
      aggregation_type    = "distribution"
      path                = "@repo_prep_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"sandbox.spawn\" @phase_status:completed @repo_prep_ms:*"
      group_by = [
        { path = "@repo_prep_path", tag_name = "repo_prep_path" },
      ]
    }

    # Periodic wait-loop status from PromptActivityReporter. Unlike the legacy
    # waiting_for_agent_event pulse itself, this age resets only when a useful
    # token/reasoning/tool/terminal event is actually delivered. Active tools
    # are a separate facet so a legitimate long command does not look idle.
    prompt_useful_activity_age_ms = {
      name                = "arcanist.prompt.useful_activity_age_ms"
      aggregation_type    = "distribution"
      path                = "@useful_activity_age_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.wait_pulse\" @useful_activity_age_ms:*"
      group_by = [
        { path = "@active_tool_call", tag_name = "active_tool_call" },
        { path = "@last_useful_event_type", tag_name = "last_useful_event_type" },
      ]
    }

    prompt_waiting_elapsed_ms = {
      name                = "arcanist.prompt.waiting_elapsed_ms"
      aggregation_type    = "distribution"
      path                = "@waiting_elapsed_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.wait_pulse\" @waiting_elapsed_ms:*"
      group_by = [
        { path = "@active_tool_call", tag_name = "active_tool_call" },
      ]
    }

    bridge_heartbeat_stall_ms = {
      name                = "arcanist.bridge.heartbeat_stall_ms"
      aggregation_type    = "distribution"
      path                = "@driftMs"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"heartbeat.stall\" @driftMs:*"
      group_by = [
        { path = "@promptInFlight", tag_name = "prompt_in_flight" },
      ]
    }

    bridge_do_liveness_failures = {
      name             = "arcanist.bridge.do_liveness_failures"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"bridge.do_liveness_failure\""
      group_by = [
        { path = "@watchdogReason", tag_name = "watchdog_reason" },
        { path = "@prompt_work_in_flight", tag_name = "prompt_work_in_flight" },
      ]
    }

    sandbox_disconnect_recovery_elapsed_ms = {
      name                = "arcanist.sandbox.disconnect_recovery_elapsed_ms"
      aggregation_type    = "distribution"
      path                = "@recoveryElapsedMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true (@event:sandbox_disconnect_terminalize_confirmed OR @event:sandbox_disconnect_terminalize_deferred) @recoveryElapsedMs:*"
      group_by = [
        { path = "@event", tag_name = "event" },
        { path = "@lane", tag_name = "lane" },
        { path = "@liveness", tag_name = "liveness" },
        { path = "@activeToolCall", tag_name = "active_tool_call" },
      ]
    }

    sandbox_disconnect_recovery_deadline_overdue_ms = {
      name                = "arcanist.sandbox.disconnect_recovery_deadline_overdue_ms"
      aggregation_type    = "distribution"
      path                = "@recoveryDeadlineOverdueMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true (@event:sandbox_disconnect_terminalize_confirmed OR @event:sandbox_disconnect_terminalize_deferred) @recoveryDeadlineOverdueMs:*"
      group_by = [
        { path = "@event", tag_name = "event" },
        { path = "@lane", tag_name = "lane" },
      ]
    }

    sandbox_heartbeat_age_at_recovery_ms = {
      name                = "arcanist.sandbox.heartbeat_age_at_recovery_ms"
      aggregation_type    = "distribution"
      path                = "@heartbeatAgeMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true (@event:sandbox_disconnect_terminalize_confirmed OR @event:sandbox_disconnect_terminalize_deferred) @heartbeatAgeMs:*"
      group_by = [
        { path = "@event", tag_name = "event" },
        { path = "@lane", tag_name = "lane" },
        { path = "@activeToolCall", tag_name = "active_tool_call" },
      ]
    }

    prompt_agent_runtime_initializing_ms = {
      name                = "arcanist.prompt.agent_runtime_initializing_ms"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.activity_phase\" @phase:agent_runtime_initializing @duration_ms:* @is_followup:*"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
        { path = "@agent", tag_name = "agent" },
        { path = "@reasoning_effort", tag_name = "reasoning_effort" },
        { path = "@is_followup", tag_name = "is_followup" },
        { path = "@has_memories", tag_name = "has_memories" },
      ]
    }

    session_view_do_fetch_ms = {
      name                = "arcanist.session_view.do_fetch_ms"
      aggregation_type    = "distribution"
      path                = "@doFetchDurationMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"session.view.metrics\" @doFetchDurationMs:*"
      group_by            = []
    }

    session_view_assembly_ms = {
      name                = "arcanist.session_view.assembly_ms"
      aggregation_type    = "distribution"
      path                = "@assemblyDurationMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"session.view.metrics\" @assemblyDurationMs:*"
      group_by            = []
    }

    session_view_total_ms = {
      name                = "arcanist.session_view.total_ms"
      aggregation_type    = "distribution"
      path                = "@totalDurationMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"session.view.metrics\" @totalDurationMs:*"
      group_by            = []
    }

    session_view_do_build_ms = {
      name                = "arcanist.session_view.do_build_ms"
      aggregation_type    = "distribution"
      path                = "@doBuildMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"session.view.metrics\" @doBuildMs:*"
      group_by            = []
    }

    session_view_do_prompt_actor_profiles_ms = {
      name                = "arcanist.session_view.do_prompt_actor_profiles_ms"
      aggregation_type    = "distribution"
      path                = "@doPromptActorProfilesMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"session.view.metrics\" @doPromptActorProfilesMs:*"
      group_by = [
        { path = "@doPromptActorProfilesOutcome", tag_name = "outcome" },
      ]
    }

    session_view_do_owner_actor_profile_ms = {
      name                = "arcanist.session_view.do_owner_actor_profile_ms"
      aggregation_type    = "distribution"
      path                = "@doOwnerActorProfileMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"session.view.metrics\" @doOwnerActorProfileMs:*"
      group_by = [
        { path = "@doOwnerActorProfileOutcome", tag_name = "outcome" },
      ]
    }

    session_view_do_spine_done_mirror_ms = {
      name                = "arcanist.session_view.do_spine_done_mirror_ms"
      aggregation_type    = "distribution"
      path                = "@doSpineDoneMirrorMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"session.view.metrics\" @doSpineDoneMirrorMs:*"
      group_by = [
        { path = "@doSpineDoneMirrorOutcome", tag_name = "outcome" },
      ]
    }

    session_view_worker_actor_profiles_ms = {
      name                = "arcanist.session_view.worker_actor_profiles_ms"
      aggregation_type    = "distribution"
      path                = "@workerActorProfilesMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"session.view.metrics\" @workerActorProfilesMs:*"
      group_by = [
        { path = "@workerActorProfilesOutcome", tag_name = "outcome" },
      ]
    }

    session_view_worker_ui_lifecycle_stage_ms = {
      name                = "arcanist.session_view.worker_ui_lifecycle_stage_ms"
      aggregation_type    = "distribution"
      path                = "@workerUiLifecycleStageMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"session.view.metrics\" @workerUiLifecycleStageMs:*"
      group_by = [
        { path = "@workerUiLifecycleStageOutcome", tag_name = "outcome" },
      ]
    }

    session_view_worker_parent_metadata_wait_ms = {
      name                = "arcanist.session_view.worker_parent_metadata_wait_ms"
      aggregation_type    = "distribution"
      path                = "@workerParentMetadataWaitMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"session.view.metrics\" @workerParentMetadataWaitMs:*"
      group_by = [
        { path = "@workerParentMetadataWaitOutcome", tag_name = "outcome" },
      ]
    }

    session_view_assembly_cpu_ms = {
      name                = "arcanist.session_view.assembly_cpu_ms"
      aggregation_type    = "distribution"
      path                = "@assemblyCpuMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"session.view.metrics\" @assemblyCpuMs:*"
      group_by            = []
    }

    runtime_warmup_duration = {
      name                = "arcanist.runtime.warmup_duration"
      aggregation_type    = "distribution"
      path                = "@runtime_warmup_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"runtime.warmup_completed\" @runtime_warmup_ms:*"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@reason", tag_name = "reason" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
      ]
    }

    runtime_warmup_completions = {
      name             = "arcanist.runtime.warmup_completions"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"runtime.warmup_completed\""
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@reason", tag_name = "reason" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
      ]
    }

    runtime_warmup_failures = {
      name             = "arcanist.runtime.warmup_failures"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"runtime.warmup_completed\" @outcome:failed"
      group_by = [
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
      ]
    }

    spawn_child_session_calls = {
      name             = "arcanist.spawn_child_session.calls"
      aggregation_type = "count"
      filter_query     = "(service:cycloid-control-plane OR service:cycloid-sandbox-bridge) env:production @event:\"spawn_child_session.create\""
      group_by = [
        { path = "@surface", tag_name = "surface" },
        { path = "@outcome", tag_name = "outcome" },
        { path = "@errorCode", tag_name = "error_code" },
      ]
    }

    spawn_child_session_per_prompt_count = {
      name                = "arcanist.spawn_child_session.per_prompt_count"
      aggregation_type    = "distribution"
      path                = "@perPromptCountAfterCreate"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"spawn_child_session.create\" @surface:control_plane @outcome:success @perPromptCountAfterCreate:*"
    }

    prompt_execution_failures = {
      name             = "arcanist.prompt.execution_failures"
      aggregation_type = "count"
      filter_query     = "env:production @event:\"prompt.complete\" @step:execution @phase_status:completed @outcome:error"
      group_by = [
        { path = "@error_code", tag_name = "error_code" },
      ]
    }

    # Session-resume rate limiter fail-open path (services/do-rate-limiter.ts).
    # The limiter fails open by design, so a fault here does not block requests -
    # but it is the incident-visible signal that the backing Durable Object is
    # unhealthy. It was previously only surfaced via Sentry.captureException,
    # which misattributed regional DO/D1 wobbles to the limiter; that capture was
    # removed, so this metric is now the sole incident-visible signal. Grouping on
    # reason distinguishes a transient backend fault (backend_unavailable) from a
    # config/protocol issue (missing_binding / non_2xx / invalid_body).
    rate_limiter_fail_open = {
      name             = "arcanist.rate_limiter.fail_open"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:\"rate_limiter.fail_open\""
      group_by = [
        { path = "@reason", tag_name = "reason" },
        { path = "@keyPrefix", tag_name = "key_prefix" },
      ]
    }

    first_party_dynamic_tool_failed = {
      name             = "arcanist.tool.first_party_dynamic_failed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"first_party_dynamic_tool_failed\""
      group_by = [
        { path = "@namespace", tag_name = "namespace" },
        { path = "@name", tag_name = "name" },
        { path = "@errorCode", tag_name = "error_code" },
      ]
    }

    plan_mode_events = {
      name             = "arcanist.plan_mode.events"
      aggregation_type = "count"
      # auto_decision is deliberately excluded: this family groups by @reason, and
      # auto_decision's @reason is free-form classifier text (unbounded tag
      # cardinality). Auto decisions get their own bounded-tag metric below.
      filter_query = "service:cycloid-control-plane env:production @_direct_post:true (@event:\"arcanist.plan_mode.turn_ran\" OR @event:\"arcanist.plan_mode.captured\" OR @event:\"arcanist.plan_mode.handoff\" OR @event:\"arcanist.plan_mode.fallback\" OR @event:\"arcanist.plan_mode.parked\" OR @event:\"arcanist.plan_mode.approved\" OR @event:\"arcanist.plan_mode.edited\" OR @event:\"arcanist.plan_mode.discussed\")"
      group_by = [
        { path = "@event", tag_name = "plan_event" },
        { path = "@valid", tag_name = "valid" },
        { path = "@reason", tag_name = "reason" },
      ]
    }

    plan_mode_auto_decision = {
      name             = "arcanist.plan_mode.auto_decision"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"arcanist.plan_mode.auto_decision\""
      group_by = [
        { path = "@planNeeded", tag_name = "plan_needed" },
        { path = "@nullFallback", tag_name = "null_fallback" },
      ]
    }

    plan_mode_duration = {
      name                = "arcanist.plan_mode.duration"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"arcanist.plan_mode.turn_ran\" @duration_ms:>=0"
      group_by = [
        { path = "@success", tag_name = "success" },
      ]
    }

    # Time from the FIRST park to approval (unaffected by discuss re-parks). Emitted
    # as a dedicated arcanist.plan_mode.time_to_approval event carrying @duration_ms
    # by the approve commit in the control plane — same event+field shape as
    # plan_mode_duration rides on turn_ran. Distribution + ms unit metadata mirrors
    # plan_mode_duration. New event class: no data points until the first gated plan
    # is approved, which is expected post-activation.
    plan_mode_time_to_approval = {
      name                = "arcanist.plan_mode.time_to_approval"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"arcanist.plan_mode.time_to_approval\" @duration_ms:>=0"
      group_by            = []
    }

    plan_mode_research_reuse_events = {
      name             = "arcanist.plan_mode.research_reuse.events"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"arcanist.plan_mode.research_reuse\""
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@backend", tag_name = "backend" },
        { path = "@excerpt_truncated", tag_name = "excerpt_truncated" },
      ]
    }

    plan_mode_research_reuse_discovery_ops = {
      name                = "arcanist.plan_mode.research_reuse.discovery_ops"
      aggregation_type    = "distribution"
      path                = "@discovery_ops"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"arcanist.plan_mode.research_reuse\" @discovery_ops:>=0"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@backend", tag_name = "backend" },
        { path = "@excerpt_truncated", tag_name = "excerpt_truncated" },
      ]
    }

    plan_mode_research_reuse_read_ops = {
      name                = "arcanist.plan_mode.research_reuse.read_ops"
      aggregation_type    = "distribution"
      path                = "@read_ops"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"arcanist.plan_mode.research_reuse\" @read_ops:>=0"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@backend", tag_name = "backend" },
        { path = "@excerpt_truncated", tag_name = "excerpt_truncated" },
      ]
    }

    plan_mode_research_reuse_plan_files_touched = {
      name                = "arcanist.plan_mode.research_reuse.plan_files_touched"
      aggregation_type    = "distribution"
      path                = "@plan_files_touched"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"arcanist.plan_mode.research_reuse\" @plan_files_touched:>=0"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@backend", tag_name = "backend" },
        { path = "@excerpt_truncated", tag_name = "excerpt_truncated" },
      ]
    }

    plan_mode_research_reuse_duration = {
      name                = "arcanist.plan_mode.research_reuse.duration"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"arcanist.plan_mode.research_reuse\" @duration_ms:>=0"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@backend", tag_name = "backend" },
        { path = "@excerpt_truncated", tag_name = "excerpt_truncated" },
      ]
    }

    plan_mode_worktree_hygiene_violation = {
      name             = "arcanist.plan_mode.worktree_hygiene_violation"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"arcanist.plan_mode.worktree_hygiene_violation\""
      group_by = [
        { path = "@reset", tag_name = "reset" },
      ]
    }

    # Reactive integration-health degradation: the control plane observed a
    # durable installer-auth failure during real provider traffic (webhook issue
    # refetch, webhook register/refresh) and degraded the integration instantly
    # instead of waiting for the periodic poll. Emitted by reactive-health
    # (event integration.reactive_degrade). Confirm this fires before widening
    # the poll interval; a rising count by reason_code is the detection signal.
    integration_reactive_degrade = {
      name             = "arcanist.integration.reactive_degrade"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:\"integration.reactive_degrade\""
      group_by = [
        { path = "@integration", tag_name = "integration" },
        { path = "@reason_code", tag_name = "reason_code" },
        { path = "@operation", tag_name = "operation" },
      ]
    }

    integration_failure = {
      name             = "arcanist.integration.failure"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"integration.failure\""
      group_by = [
        { path = "@surface", tag_name = "surface" },
      ]
    }

    # Codex version-drift signal: an event/part type the bridge translator does
    # not handle and passes through as raw_codex. Emitted by the event-translator
    # (event codex.raw_fallback). A rising count by type means Codex started
    # emitting a shape we should translate.
    codex_raw_fallback = {
      name             = "arcanist.codex.raw_fallback"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"codex.raw_fallback\""
      group_by = [
        { path = "@codex_event_type", tag_name = "codex_event_type" },
        { path = "@codex_part_type", tag_name = "codex_part_type" },
      ]
    }

    # Claude (agent SDK) version-drift signal: an SDKMessage type/subtype or
    # snapshot block the claude translator does not handle and surfaces as
    # raw_agent_runtime. Emitted by the bridge (event claude.raw_fallback).
    # A rising count by type means the pinned SDK started emitting a shape we
    # should translate.
    claude_raw_fallback = {
      name             = "arcanist.claude.raw_fallback"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"claude.raw_fallback\""
      group_by = [
        { path = "@claude_event_type", tag_name = "claude_event_type" },
        { path = "@claude_part_type", tag_name = "claude_part_type" },
      ]
    }

    opencode_raw_fallback = {
      name             = "arcanist.opencode.raw_fallback"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"opencode.raw_fallback\""
      group_by = [
        { path = "@opencode_event_type", tag_name = "opencode_event_type" },
        { path = "@opencode_part_type", tag_name = "opencode_part_type" },
      ]
    }

    opencode_blocking_event_failsafe = {
      name             = "arcanist.opencode.blocking_event_failsafe"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"opencode.blocking_event.failsafe\" -@opencode_event_type:permission.asked"
      group_by = [
        { path = "@opencode_event_type", tag_name = "opencode_event_type" },
        { path = "@action", tag_name = "action" },
      ]
    }

    opencode_permission_reply_timeout = {
      name             = "arcanist.opencode.permission_reply_timeout"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"opencode.permission.reply_timeout\""
      group_by = [
        { path = "@response", tag_name = "response" },
      ]
    }

    # Tool spans still open at prompt teardown (started but never terminated).
    # Emitted by the bridge (event bt.tool_span_leak) when forceEndAll closes
    # orphaned Braintrust child spans. Non-zero indicates a missing tool_update.
    bt_tool_span_leak = {
      name             = "arcanist.bt.tool_span_leak"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"bt.tool_span_leak\""
      group_by         = []
    }

    # ARC-1273: the QA Tester liveness watchdog terminalized a PR whose verifier
    # host died (expired-but-present per-PR lock + still-in-flight QA Tester run).
    # During rollout this is the false-reap canary: a spike that does not track real
    # host-death incidents means the death proof is mis-firing on live sessions.
    qa_tester_liveness_terminalize = {
      name             = "arcanist.qa_tester_liveness.terminalize"
      aggregation_type = "count"
      filter_query     = "service:cycloid-session-do env:production @event:\"qa_tester_liveness.terminalize\""
      group_by         = []
    }

    # ARC-1273: the watchdog deferred because the per-PR lock read failed (fail-closed
    # — never terminalizes on a D1 read blip, arm OR fire path). A sustained rate means
    # the watchdog is blind and stranded PRs are not being reconciled.
    qa_tester_liveness_lock_read_failed = {
      name             = "arcanist.qa_tester_liveness.lock_read_failed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-session-do env:production @event:\"qa_tester_liveness.lock_read_failed\""
      group_by         = []
    }

    # ARC-1273: a teardown sub-step failed AFTER the watchdog decided to terminalize
    # (interrupted comment / stage render / lock release). The terminalize count still
    # increments, so without this the partial failure is invisible. Grouped by the
    # bounded failing step enum.
    qa_tester_teardown_step_failed = {
      name             = "arcanist.qa_tester_teardown.step_failed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-session-do env:production @event:\"qa_tester_teardown.step_failed\""
      group_by = [
        { path = "@step", tag_name = "step" },
      ]
    }

    # ARC-1273: the watchdog re-armed because the live lock was re-extended (a verifier
    # rerun). Normal once per rerun; a sustained recurring rearm for one PR is the
    # stuck-verifier canary.
    qa_tester_liveness_rearm = {
      name             = "arcanist.qa_tester_liveness.rearm"
      aggregation_type = "count"
      filter_query     = "service:cycloid-session-do env:production @event:\"qa_tester_liveness.rearm\""
      group_by         = []
    }

    prompt_trace_finalization = {
      name             = "arcanist.prompt.trace_finalization"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"prompt.trace.finalized\" @trace_expected:true"
      group_by = [
        { path = "@trace_complete", tag_name = "trace_complete" },
        { path = "@outcome", tag_name = "outcome" },
        # error_code lets the completeness monitor exclude spawn_provider_error, a
        # pre-bridge terminal that finalizes trace_complete:false because the sandbox
        # never came up so no Braintrust span can exist. Emitted by
        # buildPromptTraceFinalizationEvent (prompt-trace-event.ts). Log-derived
        # metrics are not retroactive: the tag exists from this apply forward.
        { path = "@error_code", tag_name = "error_code" },
      ]
    }

    bridge_reconnects = {
      name             = "arcanist.bridge.reconnects"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"bridge.connect\" @step:reconnect @phase_status:reconnecting"
      group_by = [
        { path = "@reconnect_reason", tag_name = "reconnect_reason" },
        { path = "@last_close_initiator", tag_name = "close_initiator" },
        { path = "@prompt_work_in_flight", tag_name = "prompt_work_in_flight" },
        { path = "@last_connect_error_class", tag_name = "connect_error_class" },
      ]
    }

    bridge_ws_closes = {
      name             = "arcanist.bridge.ws_closes"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"bridge.connect\" @step:websocket @phase_status:disconnected"
      group_by = [
        { path = "@close_initiator", tag_name = "close_initiator" },
        { path = "@close_reason_class", tag_name = "close_reason_class" },
        { path = "@prompt_work_in_flight", tag_name = "prompt_work_in_flight" },
      ]
    }

    bridge_protocol_skew = {
      name             = "arcanist.bridge.protocol_skew"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"bridge.protocol_skew\""
      group_by = [
        { path = "@bridgeVersion", tag_name = "bridge_version" },
        { path = "@workerVersion", tag_name = "worker_version" },
      ]
    }

    control_plane_sandbox_ws_closes = {
      name             = "arcanist.control_plane.sandbox_ws_closes"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:sandbox_ws_closed"
      group_by = [
        { path = "@closeDecision", tag_name = "close_decision" },
        { path = "@activePromptInFlight", tag_name = "active_prompt_in_flight" },
        { path = "@wasClean", tag_name = "was_clean" },
        { path = "@runtimeProvider", tag_name = "runtime_provider" },
        { path = "@runtimeBackend", tag_name = "runtime_backend" },
      ]
    }

    sandbox_connection_issues = {
      name             = "arcanist.sandbox.connection_issues"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production ((@event:sandbox_ws_closed (@closeDecision:active_prompt_reconnect_grace OR @closeDecision:abnormal_reconnect_grace)) OR @event:sandbox_ws_message_rejected OR @event:sandbox_ws_error)"
      group_by = [
        { path = "@event", tag_name = "event" },
        { path = "@closeDecision", tag_name = "close_decision" },
        { path = "@reason", tag_name = "reason" },
        { path = "@activePromptInFlight", tag_name = "active_prompt_in_flight" },
        { path = "@runtimeProvider", tag_name = "runtime_provider" },
        { path = "@runtimeBackend", tag_name = "runtime_backend" },
        { path = "@runtimeState", tag_name = "runtime_state" },
      ]
    }

    prompt_watchdog_stale_pending = {
      name             = "arcanist.prompt.watchdog_stale_pending"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:prompt.watchdog_stale_pending"
      group_by = [
        { path = "@reason", tag_name = "reason" },
      ]
    }

    prompt_watchdog_stale_failed = {
      name             = "arcanist.prompt.watchdog_stale_failed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:prompt.watchdog_stale_failed"
      group_by = [
        { path = "@reason", tag_name = "reason" },
      ]
    }

    prompt_sandbox_disconnect_retries = {
      name             = "arcanist.prompt.sandbox_disconnect_retries"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:prompt_disconnect_retry"
      group_by = [
        { path = "@origin", tag_name = "origin" },
      ]
    }

    prompt_sandbox_disconnect_terminal = {
      name             = "arcanist.prompt.sandbox_disconnect_terminal"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true (@event:prompt_disconnect_retry_exhausted OR @event:prompt_failed_sandbox_disconnect)"
      group_by = [
        { path = "@event", tag_name = "event" },
        { path = "@origin", tag_name = "origin" },
      ]
    }

    stale_prompt_recovered = {
      name             = "arcanist.prompt.stale_recovered"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:stale_prompt_recovered"
      group_by = [
        { path = "@staleReason", tag_name = "reason" },
      ]
    }

    prompt_max_duration_exceeded = {
      name             = "arcanist.prompt.max_duration_exceeded"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:prompt.max_duration_exceeded"
    }

    bridge_pending_completion_redelivery = {
      name             = "arcanist.bridge.pending_completion_redelivery"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"bridge.connect\" @step:pending_completion_redelivery @phase_status:started"
    }

    trace_queue_export_failures = {
      name             = "arcanist.trace_queue.export_failures"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:trace_queue_export_failed"
    }

    sandbox_tracing_init_failures = {
      name             = "arcanist.sandbox.tracing_init_failures"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"observability.tracing.init\" (@init_status:init_failed OR @init_status:collector_auth_missing)"
      group_by = [
        { path = "@init_status", tag_name = "init_status" },
      ]
    }

    prompt_behavior_completions = {
      name             = "arcanist.prompt.behavior_completions"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@is_followup", tag_name = "is_followup" },
        { path = "@emptyCompletion", tag_name = "empty_completion" },
        { path = "@promptMadeRepoProgress", tag_name = "prompt_made_repo_progress" },
        { path = "@ranFunctionalCheck", tag_name = "ran_functional_check" },
      ]
    }

    prompt_behavior_first_turn_errors = {
      name             = "arcanist.prompt.behavior_first_turn_errors"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @is_followup:false @outcome:error ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@error_code", tag_name = "error_code" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
      ]
    }

    prompt_behavior_start_timeouts = {
      name             = "arcanist.prompt.behavior_start_timeouts"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @error_code:codex_startup_timeout ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
      ]
    }

    prompt_behavior_empty_completions = {
      name             = "arcanist.prompt.behavior_empty_completions"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @emptyCompletion:true ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
      ]
    }

    prompt_behavior_retry_count = {
      name                = "arcanist.prompt.behavior_retry_count"
      aggregation_type    = "distribution"
      path                = "@promptRetryCount"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @promptRetryCount:* ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
        { path = "@outcome", tag_name = "outcome" },
      ]
    }

    prompt_behavior_no_repo_progress = {
      name             = "arcanist.prompt.behavior_no_repo_progress"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @outcome:success @promptMadeRepoProgress:false ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
      ]
    }

    prompt_behavior_tool_calls = {
      name                = "arcanist.prompt.behavior_tool_calls"
      aggregation_type    = "distribution"
      path                = "@toolCallCount"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @toolCallCount:* ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
        { path = "@outcome", tag_name = "outcome" },
      ]
    }

    prompt_behavior_questions = {
      name                = "arcanist.prompt.behavior_questions"
      aggregation_type    = "distribution"
      path                = "@questionCount"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @questionCount:* ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent", tag_name = "agent" },
      ]
    }

    prompt_behavior_grep_search_commands = {
      name                = "arcanist.prompt.behavior_grep_search_commands"
      aggregation_type    = "distribution"
      path                = "@grepSearchCommandCount"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @grepSearchCommandCount:* ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent", tag_name = "agent" },
      ]
    }

    prompt_behavior_ripgrep_search_commands = {
      name                = "arcanist.prompt.behavior_ripgrep_search_commands"
      aggregation_type    = "distribution"
      path                = "@ripgrepSearchCommandCount"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @ripgrepSearchCommandCount:* ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent", tag_name = "agent" },
      ]
    }

    prompt_behavior_context_fill = {
      name                = "arcanist.prompt.behavior_context_fill"
      aggregation_type    = "distribution"
      path                = "@contextFillPercent"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @contextFillPercent:* ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@model", tag_name = "model" },
      ]
    }

    prompt_behavior_context_pressure = {
      name             = "arcanist.prompt.behavior_context_pressure"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @contextFillPercent:>0.8 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
      ]
    }

    prompt_behavior_questions_asked = {
      name             = "arcanist.prompt.behavior_questions_asked"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @questionCount:>0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
      ]
    }

    prompt_behavior_handled_automatically = {
      name             = "arcanist.prompt.behavior_handled_automatically"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @handledAutomaticallyViolation:true ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
      ]
    }

    prompt_behavior_verification_gap = {
      name             = "arcanist.prompt.behavior_verification_gap"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @referencedExternalState:true @usedVerificationTools:false ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
      ]
    }

    prompt_behavior_functional_check_gap = {
      name             = "arcanist.prompt.behavior_functional_check_gap"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.behavior.completed\" @ranFunctionalCheck:false ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@agent", tag_name = "agent" },
        { path = "@model", tag_name = "model" },
      ]
    }

    post_execution_duration = {
      name                = "arcanist.post_execution.duration"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"post_execution.completed\" @duration_ms:* ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@hasChanges", tag_name = "has_changes" },
        { path = "@publishMode", tag_name = "publish_mode" },
      ]
    }

    post_execution_completions = {
      name             = "arcanist.post_execution.completions"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"post_execution.completed\" ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@hasChanges", tag_name = "has_changes" },
        { path = "@noChangeReason", tag_name = "no_change_reason" },
        { path = "@publishMode", tag_name = "publish_mode" },
        # Lets the failure-spike monitor distinguish push-path failures (user
        # work at risk) from benign artifact/summary failures. Log-derived
        # metrics are not retroactive: the tag exists from this apply forward.
        { path = "@error_code", tag_name = "error_code" },
      ]
    }

    post_execution_missing_git_ref = {
      name             = "arcanist.post_execution.missing_git_ref"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"post_execution.completed\" @hasChanges:true (@branchPresent:false OR @commitPresent:false) ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@error_code", tag_name = "error_code" },
      ]
    }

    post_execution_summary_generation_gap = {
      name             = "arcanist.post_execution.summary_generation_gap"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"post_execution.completed\" @hasChanges:true @diffSummaryGenerated:false ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@publishMode", tag_name = "publish_mode" },
      ]
    }

    post_execution_runtime_evidence_required = {
      name             = "arcanist.post_execution.runtime_evidence_required"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"post_execution.completed\" @runtimeEvidenceRequired:true ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@publishMode", tag_name = "publish_mode" },
      ]
    }

    post_execution_publish_mode = {
      name             = "arcanist.post_execution.publish_mode"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"post_execution.completed\" @publishMode:* ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@publishMode", tag_name = "publish_mode" },
        { path = "@verdict", tag_name = "verdict" },
        { path = "@outcome", tag_name = "outcome" },
      ]
    }

    post_execution_artifacts_uploaded = {
      name                = "arcanist.post_execution.artifacts_uploaded"
      aggregation_type    = "distribution"
      path                = "@uploaded"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:e2e_post_exec_artifacts @uploaded:*"
      group_by = [
        { path = "@e2e_runtime", tag_name = "e2e_runtime" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    post_execution_artifacts_failed = {
      name                = "arcanist.post_execution.artifacts_failed"
      aggregation_type    = "distribution"
      path                = "@failed"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:e2e_post_exec_artifacts @failed:*"
      group_by = [
        { path = "@e2e_runtime", tag_name = "e2e_runtime" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    verification_phase_route_selected = {
      name             = "arcanist.verification_phase.route_selected"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.route_selected\""
      group_by = [
        { path = "@route", tag_name = "route" },
        { path = "@selected_route", tag_name = "selected_route" },
        { path = "@planner_recommended_skip", tag_name = "planner_recommended_skip" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    verification_phase_phase_completed = {
      name             = "arcanist.verification_phase.phase_completed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.phase_completed\""
      group_by = [
        { path = "@phase", tag_name = "phase" },
        { path = "@route", tag_name = "route" },
        { path = "@attempt", tag_name = "attempt" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    verification_phase_raw_output_chars = {
      name                = "arcanist.verification_phase.raw_output_chars"
      aggregation_type    = "distribution"
      path                = "@raw_output_chars"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.phase_completed\" @raw_output_chars:*"
      group_by = [
        { path = "@phase", tag_name = "phase" },
        { path = "@route", tag_name = "route" },
      ]
    }

    verification_phase_capped_output_chars = {
      name                = "arcanist.verification_phase.capped_output_chars"
      aggregation_type    = "distribution"
      path                = "@capped_output_chars"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.phase_completed\" @capped_output_chars:*"
      group_by = [
        { path = "@phase", tag_name = "phase" },
        { path = "@route", tag_name = "route" },
      ]
    }

    verification_phase_handoff_chars = {
      name                = "arcanist.verification_phase.handoff_chars"
      aggregation_type    = "distribution"
      path                = "@handoff_chars"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.phase_completed\" @handoff_present:true @handoff_chars:*"
      group_by = [
        { path = "@phase", tag_name = "phase" },
        { path = "@route", tag_name = "route" },
      ]
    }

    verification_phase_fallback_excerpt_chars = {
      name                = "arcanist.verification_phase.fallback_excerpt_chars"
      aggregation_type    = "distribution"
      path                = "@fallback_excerpt_chars"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.phase_completed\" @fallback_excerpt_used:true @fallback_excerpt_chars:*"
      group_by = [
        { path = "@phase", tag_name = "phase" },
        { path = "@route", tag_name = "route" },
      ]
    }

    verification_phase_handoff_truncated = {
      name             = "arcanist.verification_phase.handoff_truncated"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.phase_completed\" @handoff_truncated:true"
      group_by = [
        { path = "@phase", tag_name = "phase" },
        { path = "@route", tag_name = "route" },
      ]
    }

    verification_phase_fallback_excerpt_used = {
      name             = "arcanist.verification_phase.fallback_excerpt_used"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.phase_completed\" @fallback_excerpt_used:true"
      group_by = [
        { path = "@phase", tag_name = "phase" },
        { path = "@route", tag_name = "route" },
      ]
    }

    verification_phase_phase_failed = {
      name             = "arcanist.verification_phase.phase_failed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.phase_failed\""
      group_by = [
        { path = "@phase", tag_name = "phase" },
        { path = "@route", tag_name = "route" },
        { path = "@reason_code", tag_name = "reason_code" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    verification_phase_judge_repair = {
      name             = "arcanist.verification_phase.judge_repair"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.judge_repair\""
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@reason_code", tag_name = "reason_code" },
        { path = "@route", tag_name = "route" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    verification_phase_skipped = {
      name             = "arcanist.verification_phase.skipped"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.skipped\""
      group_by = [
        { path = "@route", tag_name = "route" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    verification_phase_pipeline_terminal = {
      name             = "arcanist.verification_phase.pipeline_terminal"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.pipeline_terminal\""
      group_by = [
        { path = "@terminal_kind", tag_name = "terminal_kind" },
        { path = "@verdict", tag_name = "verdict" },
        { path = "@route", tag_name = "route" },
        { path = "@needs_work_label", tag_name = "needs_work_label" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    verification_phase_evidence_promotion = {
      name             = "arcanist.verification_phase.evidence_promotion"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"verification_phase.evidence_promotion\""
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
        { path = "@failure_reason_code", tag_name = "failure_reason_code" },
        { path = "@initial_verdict", tag_name = "initial_verdict" },
        { path = "@final_verdict", tag_name = "final_verdict" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    verification_coordinator_admission_claimed = {
      name             = "arcanist.verification_coordinator.admission_claimed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"verification_coordinator.admission_claimed\""
      group_by = [
        { path = "@source", tag_name = "source" },
      ]
    }

    verification_coordinator_duplicate_returned = {
      name             = "arcanist.verification_coordinator.duplicate_returned"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"verification_coordinator.duplicate_returned\""
      group_by = [
        { path = "@source", tag_name = "source" },
      ]
    }

    verification_coordinator_run_limit_reached = {
      name             = "arcanist.verification_coordinator.run_limit_reached"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"verification_coordinator.run_limit_reached\""
      group_by = [
        { path = "@source", tag_name = "source" },
      ]
    }

    verification_coordinator_spawn_failed = {
      name             = "arcanist.verification_coordinator.spawn_failed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"verification_coordinator.spawn_failed\""
      group_by = [
        { path = "@source", tag_name = "source" },
        { path = "@reason", tag_name = "reason" },
        { path = "@failure_stage", tag_name = "failure_stage" },
      ]
    }

    verification_gate_fail_open = {
      name             = "arcanist.verification_gate.fail_open"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"verification_gate.fail_open\""
      group_by = [
        { path = "@gate", tag_name = "gate" },
      ]
    }

    llm_call_completions = {
      name             = "arcanist.llm_call.completions"
      aggregation_type = "count"
      filter_query     = "(service:cycloid-sandbox-bridge OR service:cycloid-control-plane) env:production @event:\"llm_call.completed\""
      group_by = [
        { path = "@callType", tag_name = "call_type" },
        { path = "@outcome", tag_name = "outcome" },
      ]
    }

    llm_call_timeouts = {
      name             = "arcanist.llm_call.timeouts"
      aggregation_type = "count"
      filter_query     = "(service:cycloid-sandbox-bridge OR service:cycloid-control-plane) env:production @event:\"llm_call.completed\" @outcome:failure @failureCategory:timeout"
      group_by = [
        { path = "@callType", tag_name = "call_type" },
      ]
    }

    llm_call_duration = {
      name                = "arcanist.llm_call.duration"
      aggregation_type    = "distribution"
      path                = "@durationMs"
      include_percentiles = true
      filter_query        = "(service:cycloid-sandbox-bridge OR service:cycloid-control-plane) env:production @event:\"llm_call.completed\" @durationMs:*"
      group_by = [
        { path = "@callType", tag_name = "call_type" },
        { path = "@outcome", tag_name = "outcome" },
      ]
    }

    session_resumed_cold = {
      name             = "arcanist.session.resumed_cold"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:session_resumed_cold"
    }

    e2b_orphan_reaped = {
      name             = "arcanist.e2b.orphan_reaped"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:e2b_orphan_reaped"
      group_by = [
        { path = "@terminateStatus", tag_name = "terminate_status" },
        # ARC-1248: makes a reap attributable end-to-end — `owner_session_tagged`
        # separates owner-guard reaps from true orphans; `owner_guard_reason_code`
        # records which guard branch authorized the kill.
        { path = "@ownerSessionTagged", tag_name = "owner_session_tagged" },
        { path = "@ownerGuardReasonCode", tag_name = "owner_guard_reason_code" },
        { path = "@runtimeBackend", tag_name = "runtime_backend" },
      ]
    }

    e2b_orphan_reaper_reaped_per_sweep = {
      name             = "arcanist.e2b.orphan_reaper.reaped_per_sweep"
      aggregation_type = "distribution"
      path             = "@reaped"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"e2b_orphan_reaper.swept\" @reaped:*"
    }

    # ARC-1477: hourly ALERT-ONLY Freestyle account audit. `unregisteredCount`
    # is aged, non-deleted VMs on the shared account absent from this env's
    # registry (reservation trace + session_index); `possibleOrphanCount` is
    # create reservations that never resolved to a VM id (lost create
    # response). The audit never kills — humans reconcile via the Freestyle
    # dashboard (VM names embed the session id).
    freestyle_vm_audit_unregistered_per_sweep = {
      name             = "arcanist.freestyle.vm_audit.unregistered_per_sweep"
      aggregation_type = "distribution"
      path             = "@unregisteredCount"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"freestyle_vm_audit.swept\" @unregisteredCount:*"
    }

    freestyle_vm_audit_possible_orphans_per_sweep = {
      name             = "arcanist.freestyle.vm_audit.possible_orphans_per_sweep"
      aggregation_type = "distribution"
      path             = "@possibleOrphanCount"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"freestyle_vm_audit.swept\" @possibleOrphanCount:*"
    }

    freestyle_vm_audit_superseded_per_sweep = {
      name             = "arcanist.freestyle.vm_audit.superseded_per_sweep"
      aggregation_type = "distribution"
      path             = "@supersededCount"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"freestyle_vm_audit.swept\" @supersededCount:*"
    }

    freestyle_vm_audit_killed_row_per_sweep = {
      name             = "arcanist.freestyle.vm_audit.killed_row_per_sweep"
      aggregation_type = "distribution"
      path             = "@killedRowCount"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"freestyle_vm_audit.swept\" @killedRowCount:*"
    }

    # ARC-1248: a reap the orphan-reaper's liveness guard PREVENTED — the
    # pure-bookkeeping guard would have terminated this session-tagged VM, but the
    # candidate was physically running (proven-alive protect, or stale-but-not-yet
    # debounced defer). Counts the live prevalence of the mid-prompt healthy-VM
    # reap bug; a sustained non-zero value is the bug actively firing in prod.
    sandbox_reaper_liveness_protected = {
      name             = "arcanist.sandbox.reaper.liveness_protected"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:\"sandbox.runtime.owner_guard\" @liveness_guard_prevented_reap:true"
      group_by = [
        { path = "@reason_code", tag_name = "reason_code" },
        { path = "@bookkeeping_reason_code", tag_name = "bookkeeping_reason_code" },
        { path = "@candidate_e2b_status", tag_name = "candidate_e2b_status" },
        { path = "@runtime_backend", tag_name = "runtime_backend" },
      ]
    }

    # ARC-1248: a debounced zombie the liveness guard reclaimed (physically
    # running but bridge-dead for K consecutive stale sweeps). The cost side of
    # the churn-first bias: a sustained non-zero value means real leaks are being
    # reclaimed; a spike means the debounce is mistaking live builders for zombies.
    sandbox_reaper_zombie_reclaimed = {
      name             = "arcanist.sandbox.reaper.zombie_reclaimed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:\"sandbox.runtime.owner_guard\" @reason_code:terminate_zombie_confirmed"
      group_by = [
        { path = "@runtime_backend", tag_name = "runtime_backend" },
      ]
    }

    # --- Sandbox-state owner refusals (phases 1-7 multi-writer cleanup) ---
    # Each metric counts log lines emitted by an owner helper when it
    # refuses a write because another writer's state moved underneath it.
    # Refusals here represent real races that the new ownership chokepoint
    # actually caught at runtime.

    sandbox_state_prompt_activity_refused = {
      name             = "arcanist.sandbox_state.prompt_activity_refused"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production (@event:prompt_activity_refused_record OR @event:prompt_activity_refused_clear)"
      group_by = [
        { path = "@event", tag_name = "event" },
        { path = "@reason", tag_name = "reason" },
      ]
    }

    sandbox_state_runtime_lease_refresh_refused = {
      name             = "arcanist.sandbox_state.runtime_lease_refresh_refused"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:runtime_lease_refresh_refused"
      group_by = [
        { path = "@reason", tag_name = "reason" },
      ]
    }

    sandbox_state_platform_llm_prompt_status_refused = {
      name             = "arcanist.sandbox_state.platform_llm_prompt_status_refused"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:platform_llm_prompt_status_refused"
      group_by = [
        { path = "@reason", tag_name = "reason" },
        { path = "@targetStatus", tag_name = "target_status" },
        { path = "@observedStatus", tag_name = "observed_status" },
      ]
    }

    # ---------------------------------------------------------------------------
    # Platform LLM service-tier telemetry — derived from the platform_llm.usage_event
    # logged by apps/control-plane-worker/src/services/platform-structured-output.ts.
    # Powers the standard-vs-flex cost delta and per-call-type flex latency on the
    # "Platform LLM Service Tier" dashboard (datadog-platform-llm.tf). serviceTier is
    # the ACTUAL tier the provider returned (canonical standard|flex), so a flex->default
    # fallback is costed and attributed correctly. group_by is limited to bounded enums
    # (provider + service tier + call type) to keep custom-metric cardinality bounded.
    #
    # NOTE: the @event facet value contains a dot; validate the filter query in the
    # Datadog query editor before relying on these metrics (dotted facets can be parsed
    # as nested attribute paths). Quoting the value matches @event:"session.completed".
    platform_llm_usage_cost = {
      name                = "arcanist.platform_llm.usage_cost_usd_micros"
      aggregation_type    = "distribution"
      path                = "@costUsdMicros"
      include_percentiles = false
      filter_query        = "service:cycloid-control-plane env:production @event:\"platform_llm.usage_event\" @outcome:success @costUsdMicros:*"
      group_by = [
        { path = "@provider", tag_name = "provider" },
        { path = "@serviceTier", tag_name = "service_tier" },
        { path = "@callType", tag_name = "call_type" },
        { path = "@model", tag_name = "model" },
      ]
    }

    # ---------------------------------------------------------------------------
    # Sandbox agent inference spend — derived from the sandbox_agent.usage_event
    # logged by writeUsageToD1 in apps/control-plane-worker/src/session/durable-object.ts
    # (the single usage_records write path for every backend). This is the REAL agent
    # inference cost (bridge usage event -> usage_records), unlike platform_llm.usage_event
    # above which is only the control-plane structured-output broker. @provider tags the
    # inference provider (opencode->baseten, codex->openai, claude_code->anthropic), so the
    # Baseten spend guardrail filters provider:baseten. group_by is limited to bounded
    # dimensions (provider + backend enums, plus model — Baseten model ids are namespaced
    # but bounded) to keep custom-metric cardinality bounded. include_percentiles=false
    # mirrors platform_llm_usage_cost and avoids unused billed percentile timeseries.
    #
    # NOTE: the @event facet value contains a dot; validate the filter query (and the
    # monitor/dashboard queries that read this metric) in the Datadog query editor before
    # relying on them (dotted facets can be parsed as nested attribute paths). Quoting the
    # value matches @event:"sandbox_agent.usage_event".
    sandbox_agent_usage_cost = {
      name                = "arcanist.sandbox_agent.usage_cost_usd_micros"
      aggregation_type    = "distribution"
      path                = "@costUsdMicros"
      include_percentiles = false
      filter_query        = "service:cycloid-control-plane env:production @event:\"sandbox_agent.usage_event\" @costUsdMicros:*"
      group_by = [
        { path = "@provider", tag_name = "provider" },
        { path = "@agentRuntimeBackend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    # ---------------------------------------------------------------------------
    # Agent model throughput/efficiency (ARC-1580 / OBS-602) — same
    # sandbox_agent.usage_event source and bounded group_by as the cost metric
    # above. The four token metrics make cache hit rate computable
    # (cache_read / (cache_read + input)); panels + the prompt-cache regression
    # monitor live in datadog-agent-model-throughput-efficiency.tf. group_by intentionally
    # omits business_id to keep custom-metric cardinality bounded (matches the
    # cost metric's discipline); pivot to businessId via log search when needed.
    sandbox_agent_input_tokens = {
      name                = "arcanist.sandbox_agent.input_tokens"
      aggregation_type    = "distribution"
      path                = "@inputTokens"
      include_percentiles = false
      filter_query        = "service:cycloid-control-plane env:production @event:\"sandbox_agent.usage_event\" @inputTokens:*"
      group_by = [
        { path = "@provider", tag_name = "provider" },
        { path = "@agentRuntimeBackend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    sandbox_agent_output_tokens = {
      name                = "arcanist.sandbox_agent.output_tokens"
      aggregation_type    = "distribution"
      path                = "@outputTokens"
      include_percentiles = false
      filter_query        = "service:cycloid-control-plane env:production @event:\"sandbox_agent.usage_event\" @outputTokens:*"
      group_by = [
        { path = "@provider", tag_name = "provider" },
        { path = "@agentRuntimeBackend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    sandbox_agent_cache_read_tokens = {
      name                = "arcanist.sandbox_agent.cache_read_tokens"
      aggregation_type    = "distribution"
      path                = "@cacheReadTokens"
      include_percentiles = false
      filter_query        = "service:cycloid-control-plane env:production @event:\"sandbox_agent.usage_event\" @cacheReadTokens:*"
      group_by = [
        { path = "@provider", tag_name = "provider" },
        { path = "@agentRuntimeBackend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    sandbox_agent_cache_write_tokens = {
      name                = "arcanist.sandbox_agent.cache_write_tokens"
      aggregation_type    = "distribution"
      path                = "@cacheWriteTokens"
      include_percentiles = false
      filter_query        = "service:cycloid-control-plane env:production @event:\"sandbox_agent.usage_event\" @cacheWriteTokens:*"
      group_by = [
        { path = "@provider", tag_name = "provider" },
        { path = "@agentRuntimeBackend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    sandbox_agent_total_tokens = {
      name                = "arcanist.sandbox_agent.total_tokens"
      aggregation_type    = "distribution"
      path                = "@totalTokens"
      include_percentiles = false
      filter_query        = "service:cycloid-control-plane env:production @event:\"sandbox_agent.usage_event\" @totalTokens:*"
      group_by = [
        { path = "@provider", tag_name = "provider" },
        { path = "@agentRuntimeBackend", tag_name = "agent_runtime_backend" },
        { path = "@model", tag_name = "model" },
      ]
    }

    # Output throughput samples emitted by the bridge during usage updates and
    # via a prompt-end fallback when a backend only reports one usage snapshot.
    prompt_output_tokens_per_second = {
      name                = "arcanist.prompt.output_tokens_per_second"
      aggregation_type    = "distribution"
      path                = "@output_tokens_per_second"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.output_tokens_per_second\" @output_tokens_per_second:*"
      group_by = [
        { path = "@model", tag_name = "model" },
        { path = "@reasoning_effort", tag_name = "reasoning_effort" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
      ]
    }

    sandbox_agent_rate_limited = {
      name             = "arcanist.sandbox_agent.rate_limited"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"sandbox_agent.rate_limited\""
      group_by = [
        { path = "@provider", tag_name = "provider" },
        { path = "@model", tag_name = "model" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
        { path = "@rate_limit_type", tag_name = "rate_limit_type" },
      ]
    }

    prompt_compaction = {
      name             = "arcanist.prompt.compaction"
      aggregation_type = "count"
      filter_query     = "service:cycloid-sandbox-bridge env:production @event:\"prompt.compaction\""
      group_by = [
        { path = "@model", tag_name = "model" },
        { path = "@agent", tag_name = "agent" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
      ]
    }

    prompt_compaction_tokens_reclaimed = {
      name                = "arcanist.prompt.compaction_tokens_reclaimed"
      aggregation_type    = "distribution"
      path                = "@tokens_reclaimed"
      include_percentiles = true
      filter_query        = "service:cycloid-sandbox-bridge env:production @event:\"prompt.compaction\" @tokens_reclaimed:*"
      group_by = [
        { path = "@model", tag_name = "model" },
        { path = "@agent", tag_name = "agent" },
        { path = "@agent_runtime_backend", tag_name = "agent_runtime_backend" },
      ]
    }

    platform_llm_call_duration = {
      name                = "arcanist.platform_llm.call_duration"
      aggregation_type    = "distribution"
      path                = "@durationMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"platform_llm.usage_event\" @durationMs:*"
      group_by = [
        { path = "@provider", tag_name = "provider" },
        # Latency is bucketed by the ROUTING decision (requestedServiceTier), not the actual billed
        # tier: a flex call that times out or degrades still spent its time in the flex queue, so it
        # must land in service_tier:flex. The actual tier is null on failure paths (no result),
        # which would otherwise misattribute timed-out flex calls — the exact tail this dashboard
        # exists to catch — into the standard bucket. Cost stays keyed on the actual tier (above).
        { path = "@requestedServiceTier", tag_name = "service_tier" },
        { path = "@callType", tag_name = "call_type" },
        { path = "@outcome", tag_name = "outcome" },
      ]
    }

    # ---------------------------------------------------------------------------
    # Per-tool-call telemetry — logged from the terminal `tool_update` seam in
    # SessionDO *after* durable append confirms the replay-visible event is new.
    # That gives one metric event per actual tool call (no prompt-level averaging,
    # no redelivery double-counts). `toolName` is normalized before logging so the
    # group_by stays stable across mixed-case runtime payloads. Count and timeout
    # charts key off the count metric below; latency percentiles use the duration
    # distribution and only include calls that surfaced a numeric duration.
    # ---------------------------------------------------------------------------
    tool_call_count = {
      name             = "arcanist.tool.call_count"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @event:\"tool_call.observed\""
      group_by = [
        { path = "@toolName", tag_name = "tool_name" },
        { path = "@mcpClass", tag_name = "mcp_class" },
        { path = "@outcome", tag_name = "outcome" },
        { path = "@timedOut", tag_name = "timed_out" },
      ]
    }

    tool_call_duration = {
      name                = "arcanist.tool.call_duration"
      aggregation_type    = "distribution"
      path                = "@durationMs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"tool_call.observed\" @durationMs:*"
      group_by = [
        { path = "@toolName", tag_name = "tool_name" },
        { path = "@mcpClass", tag_name = "mcp_class" },
        { path = "@outcome", tag_name = "outcome" },
        { path = "@timedOut", tag_name = "timed_out" },
      ]
    }

    # ---------------------------------------------------------------------------
    # Review Loop (RLA) + Verification (VA) telemetry — derived from the structured
    # events emitted by apps/control-plane-worker/src/observability/review-loop-events.ts.
    # group_by is intentionally limited to bounded enums (no repo/owner_user_id) to
    # keep custom-metric cardinality bounded; per-repo drill-down stays in logs.
    # Visualized on the "Review Loop & Verification" dashboard (datadog-review-loop.tf).
    # ---------------------------------------------------------------------------
    review_loop_epoch_completed = {
      name             = "arcanist.review_loop.epoch_completed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"review_loop.epoch.completed\" ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@terminal_status", tag_name = "terminal_status" },
        { path = "@source_kind", tag_name = "source_kind" },
        { path = "@blocked_reason", tag_name = "blocked_reason" },
        { path = "@head_changed", tag_name = "head_changed" },
        { path = "@convergence_failure", tag_name = "convergence_failure" },
        { path = "@model", tag_name = "model" },
      ]
    }

    review_loop_epoch_duration = {
      name                = "arcanist.review_loop.epoch_duration"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"review_loop.epoch.completed\" @duration_ms:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@terminal_status", tag_name = "terminal_status" },
        { path = "@source_kind", tag_name = "source_kind" },
      ]
    }

    review_loop_epoch_attempts = {
      name                = "arcanist.review_loop.epoch_attempts"
      aggregation_type    = "distribution"
      path                = "@attempt_count"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"review_loop.epoch.completed\" @attempt_count:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@terminal_status", tag_name = "terminal_status" },
        { path = "@source_kind", tag_name = "source_kind" },
      ]
    }

    review_loop_dispatch = {
      name             = "arcanist.review_loop.dispatch"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"prompt_admit_decision\" @review_loop_turn:true @dispatch_path:* ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@dispatch_path", tag_name = "dispatch_path" },
        { path = "@review_loop_source_kind", tag_name = "source_kind" },
      ]
    }

    review_loop_arrival_to_dispatch_ms = {
      name                = "arcanist.review_loop.arrival_to_dispatch_ms"
      aggregation_type    = "distribution"
      path                = "@arrival_to_dispatch_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"review_loop.arrival_to_dispatch_ms\" @arrival_to_dispatch_ms:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@source_kind", tag_name = "source_kind" },
        { path = "@trigger", tag_name = "trigger" },
      ]
    }

    review_loop_arrival_to_first_op_ms = {
      name                = "arcanist.review_loop.arrival_to_first_op_ms"
      aggregation_type    = "distribution"
      path                = "@arrival_to_first_op_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"review_loop.arrival_to_first_op_ms\" @arrival_to_first_op_ms:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@source_kind", tag_name = "source_kind" },
        { path = "@operation_kind", tag_name = "operation_kind" },
      ]
    }

    review_loop_ready_to_claim_ms = {
      name                = "arcanist.review_loop.ready_to_claim_ms"
      aggregation_type    = "distribution"
      path                = "@ready_to_claim_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"review_loop.ready_to_claim_ms\" @ready_to_claim_ms:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@source_kind", tag_name = "source_kind" },
      ]
    }

    review_loop_ci_first_fail_to_dispatch_ms = {
      name                = "arcanist.review_loop.ci_first_fail_to_dispatch_ms"
      aggregation_type    = "distribution"
      path                = "@ci_first_fail_to_dispatch_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"review_loop.ci_first_fail_to_dispatch_ms\" @ci_first_fail_to_dispatch_ms:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@source_kind", tag_name = "source_kind" },
        { path = "@trigger", tag_name = "trigger" },
      ]
    }

    review_loop_ingest_outcome = {
      name             = "arcanist.review_loop.ingest_outcome"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"review_loop.ingest.outcome\" ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@source_kind", tag_name = "source_kind" },
        { path = "@webhook_kind", tag_name = "webhook_kind" },
        { path = "@outcome", tag_name = "outcome" },
        { path = "@reason", tag_name = "reason" },
        { path = "@bot", tag_name = "bot" },
        { path = "@ignored_class", tag_name = "ignored_class" },
      ]
    }

    qa_tester_run_completed = {
      name             = "arcanist.qa_tester.run_completed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"qa_tester.run.completed\" ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@verdict", tag_name = "verdict" },
        { path = "@result", tag_name = "result" },
        { path = "@needs_work_label", tag_name = "needs_work_label" },
        { path = "@exhausted", tag_name = "exhausted" },
        { path = "@needs_app_runtime", tag_name = "needs_app_runtime" },
        { path = "@model", tag_name = "model" },
        { path = "@verifier_backend", tag_name = "verifier_backend" },
        { path = "@parent_model", tag_name = "parent_model" },
        { path = "@parent_backend", tag_name = "parent_backend" },
      ]
    }

    qa_tester_run_duration = {
      name                = "arcanist.qa_tester.run_duration"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"qa_tester.run.completed\" @duration_ms:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@verdict", tag_name = "verdict" },
        { path = "@result", tag_name = "result" },
        { path = "@verifier_backend", tag_name = "verifier_backend" },
        { path = "@parent_backend", tag_name = "parent_backend" },
      ]
    }

    qa_tester_run_index = {
      name                = "arcanist.qa_tester.run_index"
      aggregation_type    = "distribution"
      path                = "@run_index"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"qa_tester.run.completed\" @run_index:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@result", tag_name = "result" },
      ]
    }

    qa_tester_routing_decided = {
      name             = "arcanist.qa_tester.routing_decided"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"qa_tester.routing.decided\" ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@needs_verification", tag_name = "needs_verification" },
        { path = "@needs_app_runtime", tag_name = "needs_app_runtime" },
        { path = "@verification_reason_code", tag_name = "verification_reason_code" },
        { path = "@runtime_reason_code", tag_name = "runtime_reason_code" },
        { path = "@fail_closed", tag_name = "fail_closed" },
        { path = "@confidence", tag_name = "confidence" },
      ]
    }

    # QA Tester hand-off failures (`scheduleAutoVerificationAfterReviewLoopDone` threw →
    # `schedule_failed`). The QA Tester never starts, so the review loop stays "waiting on
    # verification" and silently retries every sweep. `reason_code` is the bounded failure class;
    # the raw `@error`, `@pr_url`, `@session_id` are log fields for drill-down only.
    qa_tester_schedule_failed = {
      name             = "arcanist.qa_tester.schedule_failed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"qa_tester.schedule.failed\" ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@reason_code", tag_name = "reason_code" },
      ]
    }

    review_loop_settled = {
      name             = "arcanist.review_loop.settled"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"review_loop.settled\" ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@final_state", tag_name = "final_state" },
        { path = "@schedule_reason", tag_name = "schedule_reason" },
        { path = "@cap_blocked", tag_name = "cap_blocked" },
        { path = "@which_cap", tag_name = "which_cap" },
        { path = "@model", tag_name = "model" },
      ]
    }

    review_loop_settled_epochs = {
      name                = "arcanist.review_loop.settled_epochs"
      aggregation_type    = "distribution"
      path                = "@total_epochs"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"review_loop.settled\" @total_epochs:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@final_state", tag_name = "final_state" },
      ]
    }

    review_loop_settled_duration = {
      name                = "arcanist.review_loop.settled_duration"
      aggregation_type    = "distribution"
      path                = "@review_listening_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"review_loop.settled\" @review_listening_ms:>=0 ${local.datadog_non_pr_dashboard_exclusion_query}"
      group_by = [
        { path = "@final_state", tag_name = "final_state" },
      ]
    }

    # PR-open -> fully-done (review loop done AND verification settled) E2E latency.
    # Emitted by emitCycloidDoneSettledEvent once per PR on the working -> done edge.
    # repo + business_id group-by departs from the bounded-enum convention above; it is
    # acceptable pre-PMF (few businesses/repos). Kill switch: if indexed-tag combinations
    # climb into the thousands, drop business_id from group_by and keep it log-only.
    # Intentionally omits datadog_non_pr_dashboard_exclusion_query: this metric measures
    # PR-open -> done latency across ALL sessions, our own repos included, so internal
    # owner_user_ids must count too. The dashboard slices by repo/business instead.
    cycloid_done_e2e_duration = {
      name                = "arcanist.arcanist_done.e2e_duration"
      aggregation_type    = "distribution"
      path                = "@duration_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"cycloid_done.settled\" @duration_ms:>=0"
      group_by = [
        { path = "@repo", tag_name = "repo" },
        { path = "@business_id", tag_name = "business_id" },
        { path = "@outcome", tag_name = "outcome" },
      ]
    }

    # See cycloid_done_e2e_duration above: exclusion intentionally omitted so internal
    # repos count alongside customer repos.
    cycloid_done_settled = {
      name             = "arcanist.arcanist_done.settled"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"cycloid_done.settled\""
      group_by = [
        { path = "@repo", tag_name = "repo" },
        { path = "@business_id", tag_name = "business_id" },
        { path = "@outcome", tag_name = "outcome" },
      ]
    }

    fsm_transition = {
      name             = "arcanist.fsm.transition"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"fsm.transition\""
      group_by = [
        { path = "@from", tag_name = "from" },
        { path = "@to", tag_name = "to" },
        { path = "@fsm_event", tag_name = "fsm_event" },
        { path = "@noop", tag_name = "noop" },
        { path = "@stage_from", tag_name = "stage_from" },
        { path = "@stage_to", tag_name = "stage_to" },
      ]
    }

    fsm_stage_dwell_ms = {
      name                = "arcanist.fsm.stage_dwell_ms"
      aggregation_type    = "distribution"
      path                = "@dwell_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"fsm.transition\" @dwell_ms:>=0"
      group_by = [
        { path = "@stage", tag_name = "stage" },
      ]
    }

    # ARC-1330 W11-G4 — producer→spine COMMIT latency. `commit_latency_ms` rides the SAME `fsm.transition`
    # event as the transition/dwell metrics (only COMMITTED transitions carry it — the noop emits do not),
    # so `@commit_latency_ms:>=0` selects the committed transitions. Grouped by `fsm_event`, the
    # per-producer facet (each event type maps to one producer). HONESTY CAVEAT: the value is the
    # entry→durable-commit span measured via the injected clock, so it is REAL for producers wiring a live
    # `Date.now` (verification/ci/head/review/cron/transport) and structurally ~0 for producers that PIN the
    # clock to a captured observation time (epoch/deadline/noshow alarms) — read the p90/p99 TAIL (the slow
    # guard-resolver / slow-D1 signal), not the 0-heavy median. Dashboard widget: datadog-fsm.tf.
    fsm_commit_latency_ms = {
      name                = "arcanist.fsm.commit_latency_ms"
      aggregation_type    = "distribution"
      path                = "@commit_latency_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @_direct_post:true @event:\"fsm.transition\" @commit_latency_ms:>=0"
      group_by = [
        { path = "@fsm_event", tag_name = "fsm_event" },
      ]
    }

    # ARC-1330 W11-G1 — post-flip soak instruments (the FSM live-side-effect sink health metrics).
    # FSM_MODE=live routes every committed transition's side effects through the live sink
    # (session/fsm/live-side-effects.ts), which emits ONE structured event per outcome. Post-flip the
    # divergence metric degrades toward self-agreement (#6359 note 3), so these are the honest gate signals.
    #
    # `failed` (:782) — a side-effect EXECUTOR threw (the commit stood; D17 owns redelivery). Baseline ~0;
    # a true error signal. `sink_failed` (:1079) — a whole composed sink threw (sibling sinks still ran);
    # also baseline ~0. These two are the gate's failure signals (monitor: fsm_sideeffect_failure_rate).
    fsm_sideeffect_failed = {
      name             = "arcanist.fsm.sideeffect.failed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"fsm.sideeffect.failed\""
      group_by = [
        { path = "@kind", tag_name = "kind" },
      ]
    }

    fsm_sideeffect_sink_failed = {
      name             = "arcanist.fsm.sideeffect.sink_failed"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"fsm.sideeffect.sink_failed\""
      group_by = [
        { path = "@sink", tag_name = "sink" },
      ]
    }

    # `skipped` (:150) — an inert/declined execution (bounded reason taxonomy). NOT an error: 85% of the
    # live volume is `epoch_row_not_materialized_legacy_owns_dispatch` (epoch authority still legacy, until
    # W11-V5) — grouped by kind+reason so the soak can attribute the baseline and watch it STEP DOWN when
    # V5 lands. `redelivered` (:971) — the D17 reconciler re-drove a committed-but-undispatched effect
    # (expected but noisy against the report-only executor pre-V5). Both are context/attribution, not gated.
    fsm_sideeffect_skipped = {
      name             = "arcanist.fsm.sideeffect.skipped"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"fsm.sideeffect.skipped\""
      group_by = [
        { path = "@kind", tag_name = "kind" },
        { path = "@reason", tag_name = "reason" },
      ]
    }

    fsm_sideeffect_redelivered = {
      name             = "arcanist.fsm.sideeffect.redelivered"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"fsm.sideeffect.redelivered\""
      group_by = [
        { path = "@kind", tag_name = "kind" },
      ]
    }

    # ARC-1330 W11-G1 — the NON-TAUTOLOGICAL parity check (session/fsm/parity-check.ts). Post-flip the
    # divergence metric self-agrees (project() writes the legacy mirrors from the spine), so this compares
    # the spine's terminal/stage state against LEGACY-INDEPENDENT ground truth (the GitHub PR's own
    # merged/open/closed state, and the verifier child's outcome). `result` is the tri-state arm
    # (agree/diverge/no_ground_truth — the last is DISTINCT from agree so an empty read never reads as a
    # clean gate). W11-G3 runs the checker in batch over TERMINAL sessions; this metric is the live-soak
    # feed. `source` names which independent signal drove the row.
    fsm_parity = {
      name             = "arcanist.fsm.parity"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"fsm.parity\""
      group_by = [
        { path = "@result", tag_name = "result" },
        { path = "@spine_state", tag_name = "spine_state" },
        { path = "@observed_pr_state", tag_name = "observed_pr_state" },
        { path = "@source", tag_name = "source" },
      ]
    }

    pr_review_trigger = {
      name             = "arcanist.pr_review.trigger"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"pr_review_trigger\" -@outcome:\"created\""
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
      ]
    }

    pr_review_trigger_model_pairing = {
      name             = "arcanist.pr_review.trigger_model_pairing"
      aggregation_type = "count"
      filter_query     = "service:cycloid-control-plane env:production @_direct_post:true @event:\"pr_review_trigger\" @outcome:\"created\" @model_pairing:*"
      group_by = [
        { path = "@model_pairing", tag_name = "model_pairing" },
      ]
    }

    pr_review_trigger_to_published_ms = {
      name                = "arcanist.pr_review.trigger_to_published_ms"
      aggregation_type    = "distribution"
      path                = "@trigger_to_published_ms"
      include_percentiles = true
      filter_query        = "service:cycloid-control-plane env:production @event:\"pr_review_trigger\" @trigger_to_published_ms:*"
      group_by = [
        { path = "@outcome", tag_name = "outcome" },
      ]
    }
  }
}

resource "datadog_metric_metadata" "pr_review_trigger_to_published_ms" {
  metric = "arcanist.pr_review.trigger_to_published_ms"
  type   = "distribution"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "plan_mode_duration" {
  metric = "arcanist.plan_mode.duration"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "platform_llm_call_duration" {
  metric = "arcanist.platform_llm.call_duration"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "prompt_workspace_setup_ms" {
  metric = "arcanist.prompt.workspace_setup_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "prompt_dispatch_subspan_offset_ms" {
  metric = "arcanist.prompt.dispatch_subspan_offset_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "sandbox_repo_prep_ms" {
  metric = "arcanist.sandbox.repo_prep_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "prompt_send_duration_ms" {
  metric = "arcanist.prompt.prompt_send_duration_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "plan_mode_time_to_approval" {
  metric = "arcanist.plan_mode.time_to_approval"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "prompt_backend_first_token_ms" {
  metric = "arcanist.prompt.backend_first_token_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "memory_context_selector_latency_ms" {
  metric = "arcanist.memory_context.selector_latency_ms"
  type   = "distribution"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "prompt_bridge_delay_ms" {
  metric = "arcanist.prompt.bridge_delay_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "prompt_received_to_thinking_ms" {
  metric = "arcanist.prompt.received_to_thinking_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "prompt_agent_runtime_initializing_ms" {
  metric = "arcanist.prompt.agent_runtime_initializing_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "plan_mode_research_reuse_duration" {
  metric = "arcanist.plan_mode.research_reuse.duration"
  type   = "gauge"
  unit   = "millisecond"
}

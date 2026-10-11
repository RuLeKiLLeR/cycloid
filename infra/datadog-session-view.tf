# --- Datadog: session view latency decomposition ---

locals {
  session_view_latency_metric_names = toset([
    "arcanist.session_view.do_fetch_ms",
    "arcanist.session_view.assembly_ms",
    "arcanist.session_view.total_ms",
    "arcanist.session_view.do_build_ms",
    "arcanist.session_view.do_prompt_actor_profiles_ms",
    "arcanist.session_view.do_owner_actor_profile_ms",
    "arcanist.session_view.do_spine_done_mirror_ms",
    "arcanist.session_view.worker_actor_profiles_ms",
    "arcanist.session_view.worker_ui_lifecycle_stage_ms",
    "arcanist.session_view.worker_parent_metadata_wait_ms",
    "arcanist.session_view.assembly_cpu_ms",
    "arcanist.ui.session_full_transcript_ms",
  ])
}

resource "datadog_metric_metadata" "session_view_latency_ms" {
  for_each = local.session_view_latency_metric_names

  metric = each.value
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_dashboard" "session_view_latency" {
  title       = "Session View Latency"
  description = "GET /api/sessions/:sessionId/view latency decomposition from the session.view.metrics log-derived metrics."
  layout_type = "ordered"

  widget {
    timeseries_definition {
      title       = "Session full-transcript timing"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "full_transcript"
            data_source = "rum"
            query       = "p95:arcanist.ui.session_full_transcript_ms{*}"
          }
        }
        formula {
          formula_expression = "full_transcript"
          alias              = "full transcript"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 /view total, DO fetch, and worker assembly"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "p95:arcanist.session_view.total_ms{*}"
          }
        }
        formula {
          formula_expression = "total"
          alias              = "total"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "do_fetch"
            data_source = "metrics"
            query       = "p95:arcanist.session_view.do_fetch_ms{*}"
          }
        }
        formula {
          formula_expression = "do_fetch"
          alias              = "DO fetch"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "assembly"
            data_source = "metrics"
            query       = "p95:arcanist.session_view.assembly_ms{*}"
          }
        }
        formula {
          formula_expression = "assembly"
          alias              = "worker assembly"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 DO internal segments"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "do_build"
            data_source = "metrics"
            query       = "p95:arcanist.session_view.do_build_ms{*}"
          }
        }
        formula {
          formula_expression = "do_build"
          alias              = "DO build"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "prompt_actor_profiles"
            data_source = "metrics"
            query       = "p95:arcanist.session_view.do_prompt_actor_profiles_ms{*}"
          }
        }
        formula {
          formula_expression = "prompt_actor_profiles"
          alias              = "prompt actor profiles"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "owner_actor_profile"
            data_source = "metrics"
            query       = "p95:arcanist.session_view.do_owner_actor_profile_ms{*}"
          }
        }
        formula {
          formula_expression = "owner_actor_profile"
          alias              = "owner actor profile"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "spine_done_mirror"
            data_source = "metrics"
            query       = "p95:arcanist.session_view.do_spine_done_mirror_ms{*}"
          }
        }
        formula {
          formula_expression = "spine_done_mirror"
          alias              = "spine done mirror"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 worker assembly segments"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "actor_profiles"
            data_source = "metrics"
            query       = "p95:arcanist.session_view.worker_actor_profiles_ms{*}"
          }
        }
        formula {
          formula_expression = "actor_profiles"
          alias              = "actor profiles"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "ui_lifecycle_stage"
            data_source = "metrics"
            query       = "p95:arcanist.session_view.worker_ui_lifecycle_stage_ms{*}"
          }
        }
        formula {
          formula_expression = "ui_lifecycle_stage"
          alias              = "UI lifecycle stage"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "parent_metadata"
            data_source = "metrics"
            query       = "p95:arcanist.session_view.worker_parent_metadata_wait_ms{*}"
          }
        }
        formula {
          formula_expression = "parent_metadata"
          alias              = "parent metadata wait"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "assembly_cpu"
            data_source = "metrics"
            query       = "p95:arcanist.session_view.assembly_cpu_ms{*}"
          }
        }
        formula {
          formula_expression = "assembly_cpu"
          alias              = "assembly CPU"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Worker read fallback counts"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "actor_profile_fallback"
            data_source = "metrics"
            query       = "count:arcanist.session_view.worker_actor_profiles_ms{outcome:fallback}.as_count()"
          }
        }
        formula {
          formula_expression = "actor_profile_fallback"
          alias              = "actor profiles"
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "lifecycle_stage_fallback"
            data_source = "metrics"
            query       = "count:arcanist.session_view.worker_ui_lifecycle_stage_ms{outcome:fallback}.as_count()"
          }
        }
        formula {
          formula_expression = "lifecycle_stage_fallback"
          alias              = "UI lifecycle stage"
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "parent_metadata_fallback"
            data_source = "metrics"
            query       = "count:arcanist.session_view.worker_parent_metadata_wait_ms{outcome:fallback}.as_count()"
          }
        }
        formula {
          formula_expression = "parent_metadata_fallback"
          alias              = "parent metadata"
        }
      }
    }
  }
}

# --- Datadog: Sandbox resource OUTCOME monitors ---
#
# This file pages ONLY on real failures, never on a resource-usage state/proxy. The
# per-session resource GAUGES the bridge emits (memory/swap/disk avail+used) go to
# us5 for DASHBOARDS, but a % or free-bytes threshold cannot separate normal from
# failure on a heavy repo: openevidence/xyla runs at ~250–643 MB free disk and swaps
# ~1 GB during heavy tests and STILL succeeds. A state threshold there is pure noise.
#
# So the only alert here is the disk-full OUTCOME, mirroring how memory pages on the
# actual OOM kill (arcanist.sandbox.memory.undersized, datadog-sandbox-oom.tf):
#   - Disk: pages on arcanist.sandbox.disk.enospc — a COUNT the bridge emits when a
#     git commit/push actually FAILS with an ENOSPC signature (full disk). A real
#     failed operation, not a level.
#   - Memory: no monitor here — the OOM counter (datadog-sandbox-oom.tf) is the
#     outcome equivalent.
#   - Swap / disk avail_bytes / disk+memory used_percent: emitted as GAUGES for
#     dashboards, NO alert. Swap use and high disk/memory % are normal heavy-load
#     states on these repos (xyla swaps ~1 GB and succeeds), so they cannot tell
#     healthy from failing.
#
# Slack-only: a disk-full session is one repo's undersized sandbox, not a platform
# outage. Sparse count → resolve on missing data (no recent failure = healthy).

module "datadog_sandbox_resource_pressure_monitors" {
  source = "./modules/datadog-monitor"

  metric_alerts = {
    sandbox_disk_enospc = {
      name            = "[Sandbox] Disk-full (ENOSPC) failure by repo"
      query           = "sum(last_5m):sum:arcanist.sandbox.disk.enospc{*} by {repo_owner,repo_name}.as_count() >= 1"
      critical        = 1
      on_missing_data = "resolve"
      # enospc is an event counter that only emits on an actual disk-full failure, so
      # it has zero data points until the first one occurs. Skip Datadog's create-time
      # query validation (which rejects a metric-alert on an unknown metric) so the
      # monitor can exist ahead of the first failure. This is why the initial apply failed.
      validate = false
      message  = <<-EOT
        A session for this repo hit a disk-full (ENOSPC) failure — a git commit/push
        could not write because the sandbox disk is exhausted, so the session cannot
        publish. This is a real failed operation, not a high-but-stable disk level
        (xyla runs at ~250–643 MB free and succeeds; only the actual failure pages).

        Fix: raise the repo's sandbox disk allocation (repo-sandbox-specs tier) or trim
        what fills it (Docker storage driver, build caches, node_modules/.venv). The
        `source` tag names the failing op (currently always "push"; commit failures
        also route here via the push-error choke point).
        ${var.datadog_slack_handle}
      EOT
      tags     = ["service:cycloid-sandbox-bridge", "component:sandbox-resources"]
    }

    sandbox_pids_exhausted = {
      name            = "[Sandbox] PID limit rejected process creation by repo"
      query           = "max(last_5m):max:arcanist.sandbox.pids.max_events_delta{env:production} by {repo_owner,repo_name} > 0"
      critical        = 0
      on_missing_data = "resolve"
      validate        = false
      message         = <<-EOT
        A sandbox cgroup incremented `pids.events:max`: at least one process/thread creation was rejected at the kernel PID limit. This is an outcome signal, not a high-utilization proxy, and can surface in Chromium as `ERR_INSUFFICIENT_RESOURCES` or make build/test tools fail to spawn.

        Search bridge logs for `@event:sandbox.resource_sample @pidsMaxEventsDelta:>0` to identify the exact session and sandbox. Then reduce test/browser process fan-out or raise the repo's PID/resource tier.
        ${var.datadog_slack_handle}
      EOT
      tags            = ["service:cycloid-sandbox-bridge", "component:sandbox-resources", "signal:pids-exhausted"]
    }
  }
}

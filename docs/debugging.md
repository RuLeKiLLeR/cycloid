# Debugging

Decision trees and command entry points for sessions, workers, and sandboxes.

> For the whole-repo symptom→code index, telemetry/log-key reference, and evidence-first methodology, see [docs/debugging-runbook.md](debugging-runbook.md).

## Start with the closest source of truth

| Situation                               | First stop                                            |
| --------------------------------------- | ----------------------------------------------------- |
| Your own session, live or completed     | Cycloid session APIs or CLI                           |
| Customer session                        | Datadog logs, then Braintrust                         |
| Control-plane request or worker failure | `wrangler tail`, Datadog, or Cloudflare observability |
| Sandbox / bridge issue                  | Datadog bridge logs and E2B sandbox state             |
| External API failure                    | Add request/response logging at the call site first   |

## Your own sessions

Start with the session APIs or CLI. For manual follow-up, inspect session state, prompts, events, artifacts, feedback, usage, and sandbox state through the control-plane routes.

## Customer sessions

Start with Datadog.

1. Query Datadog bridge logs for the session:

```bash
# In Datadog (US5): search bridge logs by session ID
@session_id:<session_id> service:cycloid-sandbox-bridge
```

2. Check sandbox runtime state via the control plane API or D1:

```bash
wrangler d1 execute cycloid-control-plane-production --remote \
  --command "SELECT session_id, runtime_provider, runtime_state, runtime_sandbox_id, runtime_state_expires_at FROM session_index WHERE session_id = '<session_id>'"
```

3. Cross-check completed prompts in Braintrust if prompt-level telemetry exists.

Skip Datadog or Sentry unless the logs show those integrations were active.

## Control-plane worker logs

Live tail:

```bash
npx wrangler tail cycloid-control-plane-production --format pretty
```

Useful flags: `--status error`, `--method POST`, `--search <text>`, `--ip self`.

Historical worker logs and analytics:

- Datadog for historical logs and D1 monitoring

## Datadog service names

`service:` is exact-match. Every Cycloid service carries the `cycloid-` prefix; the bare name returns zero — a silent miss that looks like an outage. Valid: `cycloid-control-plane`, `cycloid-session-do`, `cycloid-sandbox-bridge`.

If a query returns nothing, confirm the name before assuming telemetry is broken: in the Datadog Log Explorer, open the `service` facet (or group logs by `service`) to list the services emitting logs. The bridge emits only while a session is live; quiet hours mean no sessions, not dropped logs.

## Datadog golden path

Datadog is on US5: all URLs must use `https://us5.datadoghq.com`.

Traces one prompt from Cycloid session metadata to Datadog spans. For the end-to-end prompt lifecycle map, see [docs/lifecycle.md](lifecycle.md).

The sandbox bridge no longer exports OTLP traces. Prompt-level debugging runs through Datadog Logs and Braintrust; the control plane keeps its own span export (worker/SessionDO spans via `TRACE_QUEUE`). `dd_trace_id` on `prompt_runs` is legacy-only: populated for historical rows, null for new ones.

1. Start from the control-plane session and prompt data.
2. From the prompt rows, extract:
   - `bt_span_id` for Braintrust confirmation (primary prompt-level signal)
   - `dd_trace_id` only for historical rows that predate the OTLP removal
3. Query Datadog with the operator debugging keys.
4. Cross-check logs around the same prompt:
   - bridge log: `@event:prompt.complete @step:execution @phase_status:completed @prompt_id:<prompt_id>`
   - control-plane log: `service:cycloid-control-plane @event:prompt.trace.finalized @prompt_id:<prompt_id>`
   - exporter summaries: `service:cycloid-control-plane @event:trace_queue_export`
   - exporter failures: `service:cycloid-control-plane @event:trace_queue_export_failed`
   - queue handler failures: `service:cycloid-control-plane @event:queue.batch_failed`

Bridge logs use structured attributes. Query `@session_id:<session_id>` or `@correlationTraceId:<dd_trace_id>`; do not search bare quoted UUIDs or trace IDs as message text.

Control-plane structured events are also queryable as top-level Datadog attributes, so `@event:prompt.trace.finalized @trace_expected:true @telemetry_complete:false` and `@event:trace_queue_export_failed @exportPath:dd_logs` work directly; `@trace_expected:true` isolates prompts that actually reached execution, while pre-execution terminals such as `spawn_*` keep `@trace_expected:false`. Direct-posted control-plane copies are tagged with `@_direct_post:true` when you need to isolate them from the Cloudflare logpush duplicate.

Session-level rollup: `@event:session.completed @sessionId:<id>` returns `terminalStage`, `promptCount`, `prCreated`, `duration_ms`, `reason`, `repo`. Only fires when the session is fully closed (`DELETE /api/sessions/:id`); `cycloid sessions stop` only cancels the active run.

CF Worker logs land with empty `message`, so query by `@event:` / `@<attr>:`; free-text searches miss everything.

Expected shape when telemetry is healthy:

- bridge logs ship to Datadog Logs (query `service:cycloid-sandbox-bridge @session_id:<session_id>`)
- prompt completion logs show `@event:prompt.complete @step:execution @phase_status:completed`
- control-plane finalization logs show `@event:prompt.trace.finalized @telemetry_complete:true` (driven by `bt_span_id` presence)
- Datadog trace lookup returns spans for the worker and SessionDO; the bridge no longer emits its own spans

If a prompt appears stuck in `processing` status, check:

- `@event:prompt_admit_decision` — traces the admit decision (`send_now`, `start_spawn`, or `wait_for_inflight_spawn`). Review-loop turns tag `review_loop_turn:true`, `review_loop_epoch_id`, and `review_loop_source_kind`. `wait_for_inflight_spawn` at WARN level indicates the prompt was admitted with no scheduled work; the spawn in flight or prompt-execution alarm must make progress or the prompt stalls.
- `@event:spawn_attempt_skipped` — logs when the lifecycle reducer declines to spawn a sandbox, with `decisions` array showing reducer output and `sandboxStatus`/`sandboxRuntimeState` for context.
- `service:cycloid-sandbox-bridge @event:prompt.wait_pulse @prompt_id:<id>` — `useful_activity_age_ms` advances independently of passive wait pulses; `active_tool_call:true` identifies a legitimate long-running tool, while a growing age with no active tool is model/runtime idle.

For verification sessions approaching or exceeding ten minutes, open the
"Verification Session Reliability" dashboard and start with
`@event:verification.session_stalled`. The event contains the exact oldest
session id and total age; retries do not reset this session-creation clock.

For disconnect latency, query
`@event:sandbox_disconnect_terminalize_confirmed` or
`@event:sandbox_disconnect_terminalize_deferred`. `recoveryElapsedMs` includes
provider-probe time and measures from the last proven bridge heartbeat;
`recoveryDeadlineOverdueMs` isolates alarm/probe lateness beyond the 60-second
budget. `heartbeatAgeMs`, `activeToolCall`, `lane`, and `liveness` explain why
the decision fired.

If a prompt failed during sandbox spawn (not stuck), query spawn failure telemetry:

- `service:cycloid-control-plane @event:sandbox.spawn_failed @sessionId:<session_id>` — terminal spawn failure (deadline or provider error), with `phase` (`spawn_deadline_no_object`, `spawn_deadline_no_bridge`, `spawn_preconnect`), `spawn_retry_count`, `spawn_retry_cap_reached`, `spawn_path` (cold), `e2b_create_ms`, `bridge_launch_ms`, and `runtime_backend`.
- Metric: `sum:arcanist.sandbox.spawn_failures{*} by {phase}` on the "Sandbox Spawn Times" dashboard.

A failed spawn never reaches the bridge "ready" transition that feeds `arcanist.sandbox.spawn_duration`, so `sandbox.spawn_failed` is the only spawn-phase signal for failures.

If investigating sandbox termination attribution (why a sandbox was killed):

- `service:cycloid-control-plane @_direct_post:true @event:runtime.terminate @sessionId:<session_id>` — every kill lane emits this with `reason`, `source` (coarse facet: `reaper`, `cleanup`, `spawn`, `resume`, `layer`, or `lifecycle`), and `terminateOutcome` (`killed`, `missing`, or `error`). Queryable in Datadog; joins against `sandbox_disconnect_crosscheck_summary{signal:absent_from_all_backends}` to distinguish Cycloid-initiated kills from genuine E2B drops.

For in-sandbox pressure before a disconnect, query
`service:cycloid-sandbox-bridge @event:sandbox.resource_sample
@session_id:<session_id>`. It reports memory/swap/disk, CPU usage and throttled
periods, CPU/memory PSI, PID current/limit, and cgroup memory/PID event deltas.
`pidsMaxEventsDelta:>0` means the kernel actually rejected process creation;
`memoryOomKillEventsDelta:>0` means the cgroup killed a process. High utilization
without either outcome is diagnostic context, not an alert by itself.

If telemetry is missing, check `observabilityReadiness` on the session before digging into prompt rows. The sandbox reports Datadog log broker readiness only (`ddLogs: true` when the session-scoped broker endpoint/token exist and the control plane confirms its worker-held `DD_API_KEY`); the platform key is never injected into the sandbox. `traceExport` is always `false` and `tracingState` is `disabled` because the bridge no longer exports OTLP traces. A `@event:trace_queue_export_failed` event refers to the control-plane span export (worker/SessionDO), which is unaffected by this change.

## session.phase_drift

`arcanist.session.phase.drift` and `@event:session.phase_drift` mean exactly one thing: a passive reconciliation path (alarm tick or reconnect-grace cleanup) found that the persisted `session_index.rich_status` disagreed with the phase the DO re-derived from its live inputs. Drift detection is gated by an explicit `DriftCheckConfig` parameter at the call site — it does NOT fire on mutation paths (first prompt, prompt completion, stop, resume). A transitioning phase reading the pre-write column is by design, not drift.

When the monitor fires, use the `cause` and `reconciliation_source` tags to locate the entry point. Today there are two: `reconnect_grace_cleanup_live_socket` and `reaper_alarm_no_session`, both in `apps/control-plane-worker/src/session/durable-object.ts`.

## Operator Datadog setup

The supported operator debugging flow needs Datadog credentials plus a normal Cycloid API access path.

- `ARCANIST_API_URL`
- `DD_API_KEY`
- `DD_APP_KEY`

## Production verification script

Run this after shipping observability changes that affect prompt telemetry durability or readiness:

1. Produce one fresh prompt in production.
2. Find the session and latest prompt row:

```bash
wrangler d1 execute cycloid-control-plane-production --remote \
  --command "SELECT prompt_id, bt_span_id, dd_trace_id, created_at FROM prompt_runs WHERE session_id = '<session_id>' ORDER BY created_at DESC LIMIT 1"
```

3. Verify:
   - `bt_span_id` is present when Braintrust tracing is active
   - `dd_trace_id` is expected to be null for new rows (the bridge no longer emits it); non-null only on historical rows
4. Check Datadog logs:
   - `service:cycloid-control-plane @event:prompt.trace.finalized @prompt_id:<prompt_id>`
   - `service:cycloid-sandbox-bridge @event:prompt.complete @step:execution @phase_status:completed @prompt_id:<prompt_id>`

Treat a fresh production row with a missing `bt_span_id` (when Braintrust is configured) as an observability bug. A null `dd_trace_id` on new rows is expected by design.

## E2B sandbox inspection

Check sandbox runtime state via the session API:

```bash
# Get sandbox state for a session
curl -H "Authorization: Bearer $TOKEN" \
  https://api.trycycloid.com/api/sessions/<session_id>/sandbox-state
```

Query D1 for runtime projection data:

```bash
wrangler d1 execute cycloid-control-plane-production --remote \
  --command "SELECT runtime_provider, runtime_state, runtime_sandbox_id, runtime_state_expires_at, runtime_live_lease_expires_at FROM session_index WHERE session_id = '<session_id>'"
```

Remember that runtime sandbox IDs (E2B `sbx-xxx`) and session IDs are different identifiers.

Use the E2B debug helper for provider-side inspection:

```bash
# List Cycloid sandboxes by metadata
E2B_API_KEY=<key> npm run debug:e2b:sandbox -- list \
  --state running,paused \
  --metadata runtime_provider=e2b,session_id=<session_id>

# Fetch provider status for one sandbox
E2B_API_KEY=<key> npm run debug:e2b:sandbox -- status <runtime_sandbox_id>

# Run a command in the sandbox
E2B_API_KEY=<key> npm run debug:e2b:sandbox -- exec <runtime_sandbox_id> -- \
  pwd
```

Only use `pause` or `kill` through the helper when intentionally overriding the control plane lifecycle for cleanup or incident response.

## Local sessions disconnect

Local-only ngrok failure mode (one cause of Reconnecting banners, not all): macOS background Wi-Fi scans drop the single ngrok agent session, severing every tunneled connection. Symptoms: UI "Reconnecting", API `[api] [ERROR] Uncaught Error: Network connection lost.`, console `[tunnel] ngrok agent reconnecting -- expect session WS drops`.

- Confirm: `.ngrok.log` (repo root, truncated per run, kept after exit) or the ngrok inspector (`http://localhost:4040`; 4041/4042 if busy) shows session reconnects at the `[api]` error timestamp. Opening the Wi-Fi menu forces a scan and reproduces on demand.
- Workaround: wired Ethernet avoids it. Sessions self-heal in ~2-30s; ACK-required events are redelivered (bridge outbox + DO grace period), ordinary events are best-effort.

## Historical: pre-E2B sessions

Ignore for normal repo-session work. The active sandbox runtime is E2B. Historical sessions may carry legacy provider metadata in stored records, but the old pre-E2B runtime code has been removed from the repo.

## External API failures

Do not guess from a third-party error message alone. Add verbose request/response logging at the call boundary, reproduce, then fix the actual serialized request or response handling issue.

## Local reset

```bash
rm -rf apps/control-plane-worker/.wrangler/state
npm run db:migrate:local
```

Use this only when you need to wipe local D1 and Durable Object state.

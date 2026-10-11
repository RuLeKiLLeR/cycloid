# Reaper Liveness Guard — Proof-of-Life Across Protect _and_ Terminate

**Date:** 2026-06-17
**Ticket:** ARC-1248 (reaper liveness guard)
**Status:** Implemented (reaper-side backstop + observability). Root cause revised to the live-lease lapse; the upstream lease fix is a scoped follow-up (see end).

## Two failure modes, one missing signal

The E2B orphan reaper (`apps/control-plane-worker/src/sandbox/e2b-orphan-reaper.ts`) terminates VMs with no D1 reference. Because a live active-session VM can be _transiently_ unreferenced (projection desync), the reaper never kills a candidate carrying `metadata.session_id` directly — it consults the owner guard on the owning Session DO (`runE2BOwnerGuard`, `durable-object.ts:8551`). That guard's decision is based **entirely on DO bookkeeping** (`session_index` reference + `sandbox_state.runtimeState`), and bookkeeping is exactly what desyncs. This produces **two opposite bugs**:

### A. Churn — a healthy, in-use VM is killed (the observed ARC-1248 incident)

The guard returns `terminate` whenever the DO's bookkeeping says the runtime is gone (`durable-object.ts:8561-8602`):

- `terminate_unreferenced` — DO cleared its e2b runtime ref.
- `terminate_killed` — `runtimeState === "killed"` (set by `markRuntimeKilledAfterUnexpectedDisconnect` on a transient disconnect — **even when the VM is physically alive**).
- `terminate_superseded` — a newer runtime id/backend owns the row.

**Evidence — repo/profile/backend-agnostic, not just onboarding.** Two independent signatures:

- **mia-copy-2 (6 sandboxes / 3 sessions):** every sandbox SDK-killed (`kill_reason: 'request'`, `healthcheck: true` — physically **healthy**) ~11–13 min after its own creation, deploy-independent.
- **trycycloid/cycloid, build profile, `claude_code` (session `83862684-…`):** identical signature — every sandbox SDK-killed healthy ~12–13.5 min after creation (`iti7cm8x` 12m04s, `iuxhwam` 12m05s, `irviugi` 13m39s, `i0go9x7c` 13m27s), deploy-independent. It still reached a PR (`claude_code` resumes across respawns) but churned ~5 sandboxes.

So **any session holding a sandbox past ~10 min is hit** — long first-prompt builds, idle `review_listening`, etc.

**Revised root cause — the live-lease lapse, not a WS blip.** `minAgeMs` (10 min) is an age floor, not an idle gate: the reaper reaps sandboxes **unreferenced in `session_index` AND >10 min old**. A live in-use sandbox should not be unreferenced — but the reference drops deterministically at ~10 min because of the **live lease** (`E2B_RUNTIME_LIVE_LEASE_MS`, default 10 min): `maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl` sets `shouldRefreshLiveLease = reason !== "heartbeat"` (`durable-object.ts`), so the lease is refreshed **only by prompt activity, never by heartbeats**. A VM that emits only heartbeats for >10 min (one long `docker compose up --build` with no streamed events, or `review_listening` idle) lets the lease lapse while the VM **and** bridge are perfectly alive → the `session_index` reference drops → reaped at ~lease(10 m) + sweep(~2 m) ≈ 12 min. The owner guard (#4945) fails to protect because the DO's own bookkeeping reflects the **same** lapse. The earlier "transient WS blip → `markRuntimeKilled`" path is a second, rarer vector of the same class; both are subsumed because the heartbeat is the signal that stays true in **both**.

**Why the heartbeat is the right signal:** on every reaped VM above the bridge keeps beating every 30 s (`lastHeartbeatAt` stays fresh) — it is the prompt-activity **lease** that lapses, not the heartbeat. So the guard must key on heartbeat freshness, **not** on the lease / `runtimeState` bookkeeping.

### B. Leak — a dead VM is protected forever

The guard returns `protect` and **re-projects the runtime into `session_index`** whenever `runtimeState === "running"` (`protectAndReconcileOwnedRuntime`, `durable-object.ts:8613-8639`). But `runtimeState === "running"` only means the DO last _believed_ it was running. A zombie (E2B-running, bridge dead, DO evicted so the ~90s liveness watchdog at `durable-object.ts:2552` never converged) is protected **and its reference resurrected**, so cleanup keeps deferring it and it leaks until E2B's 1 h `onTimeout: "pause"`.

### The common root

Both bugs are the guard trusting **`runtimeState` bookkeeping** as proof of life. It isn't. There are two signals it never consults that _are_ closer to physical truth:

1. **E2B physical status.** The reaper's candidates already carry `status: "running" | "paused" | "unknown"` from the `listCycloidSandboxes` call (`candidate.status`, already logged). No extra probe needed — it just isn't passed into the guard.
2. **Bridge heartbeat.** `lastHeartbeatAt` in DO storage (`LIFECYCLE_SANDBOX_STATE_STORAGE_KEY`; the bridge beats every 30 s, `HEARTBEAT_INTERVAL_MS`), read via the existing `getSandboxHeartbeatFreshness()` (`durable-object.ts:2700`) / `evaluateSandboxHeartbeatFreshness` (`session/lifecycle/heartbeat-freshness.ts`). It survives `markRuntimeKilled` (`clearTransportMarkers` only mutates SQL transport markers, not lifecycle storage).

## Goal

One proof-of-life gate, applied to **both** the protect branch (fixes B) **and** the wrongful-terminate branches `terminate_killed` / `terminate_unreferenced` (fixes A). The reaper must **never terminate a session-tagged VM that is physically running**, and must **never protect-and-reproject a VM whose bridge is provably dead.**

## Non-goals

- `terminate_superseded`, `terminate_no_session`, `terminate_terminal`, and the paused-`defer_reconciled` branch stay **unchanged** — in those the candidate is genuinely not the DO's current in-use runtime (a newer runtime owns the row, or there is no session). The gate applies only to branches that decide the DO's _own current/last_ runtime: `protected_owned`, `terminate_killed`, `terminate_unreferenced`.
- No change to the 90 s heartbeat-liveness watchdog (primary defense), heartbeat cadence, dispatch-time zombie teardown, reaper cadence, or `minAgeMs`.
- No D1 migration, no FE change.

## Design

### 1. Pass the candidate's E2B status into the guard

`runE2BOwnerGuard` / the `/internal/runtime/e2b/owner-guard` request (`session/internal-routes.ts`) gains `candidateE2bStatus: "running" | "paused" | "unknown"`, populated from the reaper's already-listed `candidate.status`. No new E2B API call.

### 2. Compute proof-of-life on the three in-use branches

On `protected_owned`, `terminate_killed`, `terminate_unreferenced` (after the existing CAS re-read of `sandbox_state`), combine the two signals: `liveness = getSandboxHeartbeatFreshness()`; `physical = candidateE2bStatus`.

| physical  | heartbeat                                          | Decision                                          | Fixes                                                                                                                                                           |
| --------- | -------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running` | fresh (`lastHeartbeatAt!=null && ageMs<=BOUND`)    | **protect + reconcile**                           | A: live in-use VM is never reaped; reference repaired                                                                                                           |
| `running` | stale (`ageMs > BOUND`) **or** missing/future-skew | **defer + reconcile** (`defer_unproven_liveness`) | A+B: don't kill a running VM on unproven death; don't reproject as healthy. A live WS-dropped builder re-beats and converges; a true zombie stays here (see §3) |
| `paused`  | disowned branch (`killed`/`unreferenced`)          | **terminate** (`terminate_paused_unreferenced`)   | B + reclaim: a paused, owner-disowned, unreferenced, aged VM is not in active use; safe to reclaim                                                              |
| `paused`  | owned-running branch (`protected_owned`)           | **protect**                                       | review #2: E2B idle-paused the DO's own running runtime out of band — it is warm-resumable, so reaping it would force a needless cold resume                    |
| `unknown` | any                                                | **fall through to today's bookkeeping decision**  | a flaky listing must not change behavior                                                                                                                        |

Key inversion vs. the dispatch path: the reaper **fails safe toward not-killing**. We only `terminate` on _positive_ evidence the VM is not in use (`paused`), never on absence of a heartbeat. Test `ageMs > BOUND` explicitly (not the `Math.abs`-based `fresh` flag) so a future-skewed clock protects rather than kills.

### 3. Zombie reclaim is deliberately deferred, not killed inline

A `running` VM with a stale heartbeat is **ambiguous**: it is either a true zombie (bridge crashed) **or** a live builder whose WS dropped (deploy/eviction) and is still working — indistinguishable from a single sweep, and the coworker's CPU repro shows heartbeats survive load, so staleness-without-a-WS is the live-but-disconnected case we must not kill. Resolution: **defer** such candidates. A live builder's bridge reconnects and re-beats (next sweep → fresh → protect); a true zombie never re-beats. To bound the zombie leak, terminate only after **K consecutive sweeps** (`SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS`, default 3 ≈ a few minutes) of `running + stale`, tracked by a small per-runtime counter in DO storage keyed on `runtimeSandboxId` (reset on any fresh heartbeat or id change). Zero churn, genuine zombies reclaimed within minutes; the 1 h E2B `onTimeout: "pause"` is the final backstop.

> **Why defer beats inline-terminate-on-stale (the protect-only draft's approach):** terminating on stale-heartbeat alone would itself reap live WS-dropped builders — re-introducing churn for the deploy/eviction-disconnect class. Physical `running` + debounced staleness is the only combination that fixes the leak without recreating the churn.

### 4. Tear down before terminating (CAS-guarded), as today

When the gate decides `terminate` (the `paused` row, or the debounced-zombie row), mirror the ARC-1196 discipline: synchronous CAS re-read of `sandbox_state` (same id/backend/provider) — if it moved, `defer` (`defer_state_changed`); else `discardStaleSandboxTransport(sessionId, "reaper_liveness_guard")` (D1 status `stopped`, stopReason `reaped` → **cold-resumable**, so a false positive self-heals via a cold resume on the next prompt), then return `terminate`. On `terminate` the guard does **not** reproject into `session_index`.

### Thresholds

In `constants/sessions.ts` beside `SANDBOX_HEARTBEAT_LIVENESS_MS`:

- `SANDBOX_REAPER_LIVENESS_STALE_MS = 5 * 60 * 1000` — far more conservative than the 90 s dispatch bound (the reaper is a backstop; a candidate here is already unreferenced AND >10 min old; a healthy VM beats every 30 s, so >5 min ≈ 10 missed beats).
- `SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS = 3`.

### Contract + observability

The mia-copy-2 / `83862684` triage could **not** retrieve the reaper/terminate logs from Datadog (free-text on `runtimeSandboxId` and `@event` facets returned nothing); attribution rested on the E2B kill signature + elimination of the session-tagged paths + the 10-min timing — strong, but not log-confirmed _at the reaper_. So the next reap must be verifiable end-to-end:

- `E2BOrphanGuardReasonCode` (`session/internal-routes.ts`) gains: `defer_unproven_liveness`, `terminate_paused_unreferenced`, `terminate_zombie_confirmed`. The request gains `candidateE2bStatus`.
- `logE2BOwnerGuardOutcome` (`durable-object.ts`): logs the new outcomes at `warn` (event `sandbox.runtime.owner_guard`) with `candidate_e2b_status`, `heartbeat_age_ms`, `last_heartbeat_at`, `stale_sweeps`, `bookkeeping_reason_code`, and `liveness_guard_prevented_reap`.
- **Reaper reap log made reason- + session-tagged** (`e2b-orphan-reaper.ts`, event `e2b_orphan_reaped`): adds `ownerGuardReasonCode` (which guard branch authorized the kill) and `ownerSessionTagged` (owner-guard reap vs. true orphan), beside the existing `ownerSessionId` / `terminateStatus`. This is the queryable, session-tagged kill record the triage lacked.
- New Datadog counters (Terraform, `infra/datadog-log-metrics.tf`):
  - `arcanist.sandbox.reaper.liveness_protected` — a reap the gate **prevented** (`@liveness_guard_prevented_reap:true`); measures the bug's live prevalence, grouped by `reason_code` / `bookkeeping_reason_code` / `candidate_e2b_status` / `runtime_backend`.
  - `arcanist.sandbox.reaper.zombie_reclaimed` — `@reason_code:terminate_zombie_confirmed`.
  - `arcanist.e2b.orphan_reaped` gains `owner_session_tagged` / `owner_guard_reason_code` / `runtime_backend` group-bys so a reaper kill is attributable end-to-end.
- **Caveat (follow-up):** confirm control-plane DO logs for these events actually reach Datadog (logpush coverage / sampling in `infra/cloudflare-logpush.tf`) — the code now emits a queryable record, but if the original triage's "nothing in Datadog" was a forwarding gap rather than a missing field, that gap must be closed separately for the metric to populate.

## Files changed

- `durable-object.ts` — `runE2BOwnerGuard`: thread `candidateE2bStatus`; apply the §2 matrix + §3 debounce + §4 teardown on the `protected_owned`/`terminate_killed`/`terminate_unreferenced` branches via `applyReaperLivenessGate` + `terminateViaReaperLivenessGate`. `logE2BOwnerGuardOutcome`: new fields. Per-runtime stale-sweep counter helpers (`read/increment/clearReaperZombieSweeps`) over `LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY`. Reuses `getSandboxHeartbeatFreshness()` and `discardStaleSandboxTransport()`.
- `sandbox/e2b-orphan-reaper.ts` — pass `candidate.status` into the owner-guard request; tag the `e2b_orphan_reaped` log with `ownerGuardReasonCode` / `ownerSessionTagged`.
- `constants/sessions.ts` — `SANDBOX_REAPER_LIVENESS_STALE_MS`, `SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS`, `LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY`.
- `constants/e2b-cleanup.ts` — `isE2BOrphanReaperLivenessGuardEnabled` (flag `E2B_ORPHAN_REAPER_LIVENESS_GUARD`, default on; `=0` reverts to the pure-bookkeeping guard).
- `session/internal-routes.ts` — new reason codes + `candidateE2bStatus` / `E2BCandidateRuntimeStatus` on the guard request type.
- `types.ts` — declare `E2B_ORPHAN_REAPER_LIVENESS_GUARD` on `Env`.
- `infra/datadog-log-metrics.tf` — the two new counters + the `e2b_orphan_reaped` group-by additions.
- Reuse unchanged: `lifecycle/heartbeat-freshness.ts`.

## Test plan (implementation PR)

Extend `tests/test_cloudflare/session/e2b-owner-guard.test.ts` (drives the DO via `callOwnerGuard` + `seedRuntime`; seed `lastHeartbeatAt` into `LIFECYCLE_SANDBOX_STATE_STORAGE_KEY`). Each case asserts decision + whether the `UPDATE session_index` reproject ran + whether `sandboxMock.kill` ran:

- **Churn fix:** `runtimeState:"killed"` + `candidateE2bStatus:"running"` + fresh heartbeat → **defer/protect, NOT killed**, reconciled. (Today: `terminate_killed` → killed.)
- **Leak fix (debounced):** `running` + `candidateE2bStatus:"running"` + stale heartbeat, sweep < K → **defer**, no reproject, not killed; at sweep == K → **terminate**, transport finalized `reaped`, no reproject.
- **Regression:** `running` + fresh heartbeat → **protect** + reproject.
- **Fail-safe:** `running` + missing heartbeat → defer (not killed); future-skewed heartbeat → defer (not killed).
- **Paused reclaim:** `candidateE2bStatus:"paused"` + unreferenced → terminate.
- **Unchanged branches:** `terminate_superseded` / `terminate_no_session` / archived → terminate regardless of physical/heartbeat (gate not applied).
- **CAS race:** stale, but `sandbox_state` id flips between read and re-read → `defer_state_changed`.
- **Reaper wiring:** `runE2BOrphanSandboxReaper` passes `candidate.status` through (`tests/test_cloudflare/e2b-orphan-reaper.test.ts`).

`pnpm tsc --noEmit -w @cycloid/control-plane-worker`; `pnpm vitest run tests/test_cloudflare/session/e2b-owner-guard.test.ts tests/test_cloudflare/e2b-orphan-reaper.test.ts`.

## Verification (post-deploy)

Re-run a mia-copy-2 onboarding: a sandbox should survive past ~13 min and `arcanist.sandbox.reaper.liveness_protected` should fire instead of a reap; the session reaches an R1/R2 PR. Confirm zombie reclaim still works (synthetic: kill a bridge, leave the VM, expect `terminate_zombie_confirmed` after ~K sweeps).

## Risks / notes

- **Churn-first bias is intentional.** Defaulting to defer on any `running` VM accepts a bounded zombie leak (≤ K sweeps, ≤ 1 h backstop) to guarantee we never reap a live build. Cost is monitored via the reclaim counter.
- **Counter state in DO storage** must reset on fresh heartbeat / id change so a stale counter never terminates a recovered VM.
- **Self-healing false positive:** `discardStaleSandboxTransport` finalizes `reaped`/cold-resumable, so a mistaken teardown costs only a cold resume.

## Implementation notes (deltas from the original design)

- **Killed / unreferenced branches protect _without_ reprojecting.** When the gate proves a `killed`/`unreferenced`-bookkeeping VM is physically running + heartbeat-fresh, it returns `protect` but does **not** reproject — there is no authoritative running row to project, and the live bridge's reconnect performs the real `runtimeState` heal. Protect-not-kill is what stops the churn each sweep; reprojecting a non-running row would be a no-op shield (and reprojecting on the _stale_ path would shield a zombie, defeating the debounce). The running branch (`protected_owned`) still reprojects from its authoritative running state, as before.
- **`paused` is branch-aware (review #2).** A `paused` reading only reclaims (`terminate_paused_unreferenced`) on the **disowned** branches (`killed`/`unreferenced`). On the **owned-running** branch a `paused` reading means E2B idle-paused the DO's own runtime out of band; it is warm-resumable, so the gate **protects** it (the pre-ARC-1248 behavior) rather than destroying the snapshot and forcing a cold resume. Carried by the `reclaimPaused` gate flag.
- **Per-runtime zombie counters (review #1).** The debounce is a single DO-storage record mapping `runtimeSandboxId -> count`, not one shared slot. Multiple unreferenced-but-running leftover VMs of the **same** session all route to one DO; a shared slot would let their increments overwrite each other so none ever reached `K` (the zombies would leak forever). The map is reset per id on fresh-beat/terminate and capped (`SANDBOX_REAPER_ZOMBIE_SWEEP_MAX_RUNTIMES`).
- **Future-skew protects, not defers.** Staleness is `lastHeartbeatAt == null || ageMs > SANDBOX_REAPER_LIVENESS_STALE_MS` on the **signed** `ageMs` (not the `Math.abs` `fresh` flag), so a future-skewed clock is fresh → protect → never accumulates toward the zombie terminate.
- **Kill switch:** `E2B_ORPHAN_REAPER_LIVENESS_GUARD=0` reverts the guard to its pure-bookkeeping decision (`constants/e2b-cleanup.ts`).

## Follow-up (separate, scoped out of this PR)

**The upstream lease fix.** The revised root cause is the live-lease lapse (`shouldRefreshLiveLease = reason !== "heartbeat"`): a heartbeat-fresh VM drops its `session_index` reference at ~10 min. The cleaner root fix removes the trigger rather than backstopping it — either (a) let heartbeats refresh the live lease, or (b) don't drop the reference for a heartbeat-fresh VM. This was **deliberately deferred** to a separately-reviewed PR because it is behavior-changing: making heartbeats keep the lease alive means an idle-but-connected session (`review_listening`, open bridge) would never idle-pause → it holds an E2B VM (and cost) indefinitely. The right upstream fix must distinguish "busy but not streaming" from "genuinely idle," which the heartbeat alone does not — so it needs its own design + cost review. The reaper-side guard shipped here is the robust backstop that makes the bug non-fatal in the meantime.

The older "transient-disconnect `markRuntimeKilled`" question (why a WS blip kills a physically-alive VM's reference) remains a secondary follow-up of the same class.

// ARC-1330 lifecycle FSM (PR 47, the 4b emitter rewire) — the LIVE bucket-b side-effect sink + the real
// bucket-a worklist sink.
//
// UNCONDITIONALLY LIVE (ARC-1330 D-60 — the FSM_MODE kill-switch is removed). `dispatch()` always
// executes the bucket-b bag; there is no shadow/off no-op arm.
//
// SCOPE (Wave-10 decision — live authority is POST-PUBLISH only, held through PR 47). The genesis/
// codegen/transport arc stays legacy-driven: `spawn_sandbox` / `dispatch_prompt` / `open_pr` remain
// INERT under live (the transport reducer keeps its authority — transport-producer.ts
// `transportResolver` is the structural hold). PR 47 gated
// the POST-PUBLISH legacy decision sites (verification scheduling at the DO done-state path + the
// review-loop:done label webhook, the verifier rerun-after-fix) — the executor table's per-kind notes
// name each remaining inert kind's live owner. EVERY inert executor emits one best-effort structured
// DD event (`fsm.sideeffect.skipped`) so nothing silently drops at live — the "no silent caps" rule.
//
// EXECUTION DISCIPLINE (design §15 DE-2/DE-4/DE-5):
//   • Effects execute AFTER the CAS commit (the spine dispatches post-commit) and CONCURRENTLY
//     (DE-4) — with ONE ordering exception: `kill_verification` effects run to completion BEFORE
//     `spawn_verification_child` (the VERIFYING `head.changed` edge carries both in one bag; a
//     concurrent spawn would observe the superseded child still alive and be declined by the
//     `active_verification_session_exists` gate, dropping the re-run). Each effect is individually
//     try/caught, so one throwing executor never blocks the others, and a failure is logged +
//     emitted as `fsm.sideeffect.failed` (best-effort). The CAS commit is NEVER rolled back on a
//     side-effect failure (§8/inv 2).
//   • REDELIVERY IS STATE-DERIVED REPAIR, NOT AN OUTBOX. Per DE-2/DE-5 the delivery path is the
//     in-process dispatch right here; a crash/failure between commit and effect is repaired by the
//     D17 cron reconciles re-deriving the needed effect from committed state (PR 48/49 scope). Each
//     executor is therefore idempotent and keyed to a COMMITTED anchor (see the per-kind notes), so
//     an infra-retried/redelivered dispatch cannot double-execute.
//   • HOT-PATH: when a `waitUntil` seam is provided, effect execution is deferred through it so the
//     caller never awaits side-effect work; absent (tests), the work runs inline and the returned
//     promise is awaitable. PR 47 threads the seam through every producer entry point: the webhook
//     handlers' ExecutionContext (ci via the done-reconcile, review via the ingest, head via the
//     synchronize handler), the cron sweep's scheduled ctx, the DO's ctx (noshow + deadline alarms,
//     epoch replied), publish-service's host, and the prompt-queue verdict-back host.
//
// FLIP RUNBOOK NOTES (PR 46):
//   • FIRST-TICK HERD BOUND: the first live review-loop sweep tick recomputes the WHOLE active
//     review-listening cohort (the sweep's per-session `ci.signal` emit, review-loop-sweep.ts:3089,
//     drives one applyEvent each). The settled-verdict cohort exits via cascade row 7 with NO spawn
//     (the backfill seeds it fresh — see backfill.ts), so the spawn herd is only the sessions
//     GENUINELY owing verification, bounded by the active review-listening count; the flip runbook
//     schedules the flip in a low-traffic window regardless.
//   • The `project` executor's DO self-fetch (`getSessionState` from inside an applyEvent that a DO
//     request may be driving) is proven by the mandatory pre-flip live E2E (docs/testing.md — an
//     actual Cycloid session), not unit tests.
//
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.

import { isCodeReviewerAgentRole, isQaTesterAgentRole } from "../../../../../shared/agent/constants.js";
import { ENVIRONMENT } from "../../../../../shared/constants/environment.js";
import { REVIEW_LOOP_FEEDBACK_SLACK_CHANNEL } from "../../constants/slack";
import { isSmokeTestRepo } from "../../constants/smoke-test";
import { BlockerKind } from "../../enums/blocker";
import { createInstallationToken } from "../../github/octokit";
import { removeLabel } from "../../github/pr";
import { createLogger } from "../../logger";
import { postStructuredEventToDd } from "../../observability/events-exporter";
import { emitReviewLoopSettledEvent } from "../../observability/review-loop-events";
import { syncFsmLabelsForPr } from "../../services/fsm-label-sync";
import { countReviewLoopEpochsForPr, type ReviewLoopEpoch } from "../../services/review-loop-epochs";
import { syncSessionProjection } from "../../services/session-projection";
import {
  buildInternalAlertSessionFooter,
  resolveInternalAlertOwnerLabel,
} from "../../slack/internal-alert-session-context";
import { postInternalAlert } from "../../slack/internal-alerts";
import type { Env, SessionState } from "../../types";
import { countVerificationSessionsByGithubPrRef } from "../../webhooks/db";
import { runE2BRuntimeCleanupViaSessionDO } from "../cleanup";
import { getSessionIndexRuntimeProjection } from "../db";
import { publishSessionUpsertedFromDb } from "../feed-delta";
import { notifyUserBlocked } from "../notify-user-blocked";
import {
  getLegacyIntentChildId,
  getPrCoordination,
  listPrCoordinationTerminalRedeliveryCandidates,
  listPrCoordinationTransientRepairCandidates,
  type PrCoordinationRecord,
  stampVerificationChildId,
} from "../pr-coordination-db";
import { listUndispositionedActionable, registerDispositionsIfAbsent } from "../pr-review-item-disposition-db";
import { closeSessionState, getSessionState } from "../state";
import { findActiveVerificationSession } from "../verification-gate";
import {
  applyEvent,
  type ApplyEventDeps,
  type FsmDdEmit,
  type FsmSideEffectSink,
  type FsmWorklistSink,
  type SideEffectDispatch,
} from "./apply-event";
import { buildLiveGuardResolver } from "./live-resolver";
import { labelsOf, projectDisplayColumns, projectMirrorColumns } from "./project";
import type { EpochTrigger, FsmEvent, FsmRecord, FsmState, SideEffect, SideEffectKind } from "./types";

/** Parse the PR number from a canonical `.../pull/<n>` URL; null when the tail is not a PR number. */
function prNumberFromUrl(prUrl: string): number | null {
  const match = /\/pull\/(\d+)(?:$|[/?#])/.exec(prUrl);
  return match ? Number(match[1]) : null;
}

const log = createLogger({ bindings: { component: "fsm-live-side-effects" } });
const LEGACY_INTENT_MISMATCH_LABEL = "intent-mismatch:⚠";

// ── Sink construction options ─────────────────────────────────────────────────

export interface LiveFsmSinkOptions {
  /**
   * Hot-path seam: when provided (webhook `ctx.waitUntil` / DO `this.ctx.waitUntil`), effect
   * execution is deferred through it so the response path never awaits side-effect work. Absent
   * (tests / cron contexts), `dispatch()` returns the execution promise to await inline.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Clock seam (deterministic in tests). */
  now?: () => number;
  /** Defaults to {@link postStructuredEventToDd}; overridable for the skip/fail emit tests. */
  emit?: FsmDdEmit;
  /** Per-kind executor overrides — a deliberate TEST seam (spy/fake executors); production omits it. */
  executors?: Partial<Record<SideEffectKind, LiveSideEffectExecutor>>;
}

/** Everything one executor invocation needs: the committed dispatch + this effect + the I/O seams. */
export interface LiveSideEffectContext {
  env: Env;
  dispatch: SideEffectDispatch;
  effect: SideEffect;
  now: () => number;
  emit: FsmDdEmit;
}

export type LiveSideEffectExecutor = (ctx: LiveSideEffectContext) => Promise<void>;

// ── Structured-event helpers (the "no silent caps" rule) ──────────────────────

/** The bounded tag set every skip/fail event carries (task-pinned shape). */
function effectTags(dispatch: SideEffectDispatch, kind: SideEffectKind): Record<string, unknown> {
  return {
    kind,
    session_id: dispatch.sessionId,
    version: dispatch.version,
    from: dispatch.from,
    to: dispatch.to,
  };
}

/** Best-effort DD emit — a thrown/failed emit is swallowed (telemetry never blocks an effect). */
async function emitBestEffort(ctx: LiveSideEffectContext, event: Record<string, unknown>): Promise<void> {
  try {
    await ctx.emit(ctx.env, event);
  } catch (err) {
    log.warn({ event: event.event, error: String(err) }, "fsm live sink: telemetry emit failed (ignored)");
  }
}

/**
 * `fsm.sideeffect.skipped` — ONE best-effort event per inert/declined execution so nothing silently
 * drops at live. Low volume by construction (skips ride committed transitions), so no dedup.
 */
async function emitSkipped(ctx: LiveSideEffectContext, reason: string): Promise<void> {
  await emitBestEffort(ctx, {
    event: "fsm.sideeffect.skipped",
    ...effectTags(ctx.dispatch, ctx.effect.kind),
    reason,
  });
}

async function settleCommittedDispatchMarker(ctx: LiveSideEffectContext, reason: string): Promise<void> {
  await emitSkipped(ctx, reason);
  if (reason === "no_disposition_items_bare_trigger" && ctx.dispatch.worklistFailed) {
    await emitSkipped(ctx, "worklist_registration_failed_marker_preserved");
    return;
  }
  const epochId = ctx.dispatch.resultingRecord.inFlightEpochId;
  if (!epochId) return;
  const current = await getPrCoordination(ctx.env.DB, ctx.dispatch.sessionId);
  if (!current || current.inFlightEpochId !== epochId) {
    await emitSkipped(ctx, "stale_settle_marker");
    return;
  }
  let uncoveredActionableSourceIds: string[] = [];
  if (current.prUrl) {
    const { listLiveEpochCoveredSourceIds } = await import("../../services/review-loop-epochs");
    const actionable = await listUndispositionedActionable(ctx.env.DB, ctx.dispatch.sessionId, current.prUrl);
    const covered = await listLiveEpochCoveredSourceIds(ctx.env.DB, {
      sessionId: ctx.dispatch.sessionId,
      prUrl: current.prUrl,
    });
    uncoveredActionableSourceIds = actionable.filter((sourceId) => !covered.has(sourceId));
  }
  await applyEvent(
    {
      db: ctx.env.DB,
      env: ctx.env,
      now: ctx.now,
      resolver: buildLiveGuardResolver(ctx.env, ctx.dispatch.sessionId, { uncoveredActionableSourceIds }),
      ...liveFsmSinks(ctx.env, { now: ctx.now, emit: ctx.emit }),
      emit: ctx.emit,
    },
    {
      sessionId: ctx.dispatch.sessionId,
      event: { type: "epoch.settled", epochId },
      actor: "internal",
    },
  );
}

const FSM_LOUD_DEDUP_TTL_SECONDS = 24 * 60 * 60;

function terminalEffectDedupKey(dispatch: SideEffectDispatch, kind: SideEffectKind): string {
  const record = dispatch.resultingRecord;
  const reason = record.blockedReason ?? record.failureReason ?? "none";
  const head = record.headSha ?? record.verificationRunHead ?? "no-head";
  return `fsm:${kind}:${dispatch.sessionId}:v${dispatch.version}:${dispatch.to}:${reason}:${head}`;
}

async function runOncePerTerminal(
  env: Env,
  dispatch: SideEffectDispatch,
  kind: SideEffectKind,
  run: () => Promise<void>,
): Promise<"ran" | "deduped"> {
  const kv = (env as Partial<Env>).RATE_LIMITS;
  if (!kv) {
    await run();
    return "ran";
  }
  const key = terminalEffectDedupKey(dispatch, kind);
  if (await kv.get(key).catch(() => null)) return "deduped";
  await run();
  // ACCEPTED ASYMMETRY (Greptile 4/5 note): if this put itself fails after a successful run(), the next
  // redelivery within the 30-min terminal window re-runs the fanout. The user DM stays suppressed (its
  // own secondary `blocked-dm:` key survives), but the INTERNAL alert may duplicate — deliberately: the
  // ops channel errs toward at-least-once (bounded to the recency window, needs KV failing while Slack
  // works), the same silence-over-noise trade as the settle re-home's own key. No secondary marker.
  await kv.put(key, "1", { expirationTtl: FSM_LOUD_DEDUP_TTL_SECONDS }).catch(() => undefined);
  return "ran";
}

function blockerKindForTerminal(record: FsmRecord): BlockerKind | null {
  switch (record.blockedReason) {
    case "verification_noconverge":
    case "verification_unresolved":
    case "verification_run_limit":
    case "verification_stopped":
      return BlockerKind.VerificationExhausted;
    case "ci_fix_exhausted":
    case "ci_flapping":
      return BlockerKind.CiRedExhausted;
    case "review_stuck":
      return BlockerKind.CiPendingTimeout;
    case "review_response_failed":
      return BlockerKind.ReviewResponseFailed;
    case "owner_approval":
      return BlockerKind.OwnerApproval;
    case "internal_inconsistency":
    case null:
      return record.state === "FAILED" && record.failureReason ? BlockerKind.SessionFailed : null;
    default: {
      // Exhaustiveness guard (ARC-1543): a new `BlockedReason` must be mapped to a `BlockerKind` here,
      // or explicitly to null above, or this fails `tsc` — closing the failure class where a
      // silently-unmapped reason (this one) fell through to no owner DM. If a reason ever reaches this
      // at runtime (one that bypassed the type system), throw a clear diagnostic at the guard site
      // rather than returning the raw string as a bogus BlockerKind — that would make
      // `BLOCKED_DM_COPY[kind]` undefined and surface an opaque TypeError deep in the DM path. The
      // sink's per-effect try/catch turns this throw into an observable `fsm.sideeffect.failed`.
      const _exhaustive: never = record.blockedReason;
      throw new Error(`blockerKindForTerminal: unmapped BlockedReason ${String(_exhaustive)}`);
    }
  }
}

/** Classified suppression for the loud terminal's Slack fanout; null = deliver everything. */
export type LoudSlackSuppression = "non_production" | "qa_agent_role" | "review_agent_role" | "smoke_repo" | null;

/**
 * Mirror of `shouldNotifyCustomerSessionStarted` (customer-session-start-alert.ts) for the loud
 * terminal fanout. `postInternalAlert` itself gates only on SLACK_BOT_TOKEN presence and the channel
 * id is a hardcoded constant, so without this ANY control plane holding a real bot token pages the
 * shared ops channel — including local dev (the localhost-footer alerts of 07-02) — and the prod
 * smoke harness (constants/smoke-test.ts) pages it once per synthetic PR with nothing for an
 * operator to act on.
 *
 * - `non_production` suppresses the WHOLE Slack fanout (owner DM + ops channel): a non-prod control
 *   plane must never DM real owners or page the ops channel about its sessions.
 * - `qa_agent_role` / `review_agent_role` / `smoke_repo` suppress the OPS-CHANNEL post only: the synthetic cohorts keep
 *   their DM behavior (a smoke owner is synthetic; changing its DMs is a product-behavior change
 *   this alerting fix deliberately avoids).
 * - A session that failed to load fails OPEN for the channel post: a spurious page beats a silently
 *   missing one for a real customer terminal.
 *
 * DD telemetry (`fsm.loud`) is never gated — terminals stay observable in every environment.
 */
export function classifyLoudSlackSuppression(
  env: Pick<Env, "WORKER_ENV">,
  session: Pick<SessionState, "agentRole" | "repoOwner" | "repoName"> | null,
): LoudSlackSuppression {
  if (env.WORKER_ENV !== ENVIRONMENT.Production) return "non_production";
  if (!session) return null;
  if (isQaTesterAgentRole(session.agentRole)) return "qa_agent_role";
  if (isCodeReviewerAgentRole(session.agentRole)) return "review_agent_role";
  if (isSmokeTestRepo(session.repoOwner, session.repoName)) return "smoke_repo";
  return null;
}

function terminalReason(record: FsmRecord): string {
  return record.blockedReason ?? record.failureReason ?? "unknown";
}

/** `owner/repo` parsed from a GitHub PR URL, or null when there's no URL or it doesn't parse. */
function repoLabelFromPrUrl(prUrl: string | null): string | null {
  if (!prUrl) return null;
  try {
    const parts = new URL(prUrl).pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}

/**
 * Human repo label for terminal alerts/telemetry. Prefer the PR URL, then fall back to the loaded
 * session's `repoOwner/repoName`: pre-PR loud terminals (codegen_error / publish_failed FAILED, and
 * NEEDS_YOU blockers that trip before publish) have no `prUrl`, so a PR-only label paged
 * #project-review-loop with "unknown repo" even though the session record knew the repo. Only when
 * neither is known does the sentinel remain.
 */
function repoLabel(prUrl: string | null, session: Pick<SessionState, "repoOwner" | "repoName"> | null): string {
  const fromPr = repoLabelFromPrUrl(prUrl);
  if (fromPr) return fromPr;
  if (session?.repoOwner && session.repoName) return `${session.repoOwner}/${session.repoName}`;
  return "unknown repo";
}

function parseGitHubPrUrl(prUrl: string | null): { owner: string; repo: string; prNumber: number } | null {
  if (!prUrl) return null;
  try {
    const parts = new URL(prUrl).pathname.split("/").filter(Boolean);
    const prNumber = parts[2] === "pull" ? Number(parts[3]) : NaN;
    if (!parts[0] || !parts[1] || !Number.isFinite(prNumber) || prNumber <= 0) return null;
    return { owner: parts[0], repo: parts[1], prNumber };
  } catch {
    return null;
  }
}

async function cleanupLegacyIntentObserver(
  ctx: LiveSideEffectContext,
  session: { installationId?: number | null },
): Promise<void> {
  const db = ctx.env.DB;
  if (!db) return;
  let childSessionId: string | null = null;
  try {
    childSessionId = await getLegacyIntentChildId(db, ctx.dispatch.sessionId);
  } catch (error) {
    log.warn({ sessionId: ctx.dispatch.sessionId, error: String(error) }, "legacy intent child lookup failed");
  }
  const parsedPr = parseGitHubPrUrl(ctx.dispatch.resultingRecord.prUrl);
  if (parsedPr && typeof session.installationId === "number" && session.installationId > 0) {
    try {
      const token = await createInstallationToken(ctx.env, session.installationId);
      await removeLabel(token, parsedPr.owner, parsedPr.repo, parsedPr.prNumber, LEGACY_INTENT_MISMATCH_LABEL);
    } catch (error) {
      log.warn(
        { sessionId: ctx.dispatch.sessionId, prUrl: ctx.dispatch.resultingRecord.prUrl, error: String(error) },
        "legacy intent mismatch label cleanup failed",
      );
    }
  }
  if (!childSessionId) return;
  let child: Awaited<ReturnType<typeof getSessionState>> | null = null;
  try {
    child = await getSessionState(ctx.env, childSessionId);
  } catch {
    child = null;
  }
  if (child?.status !== "active") return;
  try {
    await closeSessionState(ctx.env, childSessionId, null, { reason: "legacy_intent_observer_cleanup" });
  } catch (error) {
    log.warn(
      { sessionId: ctx.dispatch.sessionId, childSessionId, error: String(error) },
      "legacy intent child close failed",
    );
  }
}

function internalLoudText(
  env: Env,
  dispatch: SideEffectDispatch,
  ownerUserLabel: string | null,
  session: Pick<SessionState, "repoOwner" | "repoName"> | null,
): string {
  const record = dispatch.resultingRecord;
  const repo = repoLabel(record.prUrl, session);
  const footer = buildInternalAlertSessionFooter(env, {
    sessionId: dispatch.sessionId,
    ownerUserLabel,
    extraLink: record.prUrl ? { url: record.prUrl, label: "View PR" } : null,
  });
  return [
    `:rotating_light: FSM loud terminal: *${dispatch.to}* (${terminalReason(record)}) on *${repo}*`,
    `Event: \`${dispatch.event.type}\` · Version: \`${dispatch.version}\``,
    footer,
  ].join("\n");
}

/** Build an INERT executor: log + emit the structured skip. `reason` names why/who owns the follow-up. */
function inertExecutor(reason: string): LiveSideEffectExecutor {
  return async (ctx) => {
    log.info(
      { ...effectTags(ctx.dispatch, ctx.effect.kind), reason },
      "fsm live sink: side-effect intentionally inert in this slice",
    );
    await emitSkipped(ctx, reason);
  };
}

// ── Per-kind executors ────────────────────────────────────────────────────────

/**
 * `project` — the canonical projection refresh (control-plane README "Projection write ownership"):
 * NEVER write `session_index` directly; re-project through `syncSessionProjection`. The session snapshot
 * is re-read from the owning DO for the rich_status/publish/runtime surfaces (still legacy-owned).
 *
 * ARC-1330 W11-P1 → D-59c — the mirror SOLE-WRITE. For a POST-PUBLISH record (ACTIVE *or* TERMINAL),
 * `project()`'s three mirror column groups (`review_loop_done_state` / `verification_state` /
 * `cycloid_done_*`, from the COMMITTED spine row `dispatch.resultingRecord`) are written UNCONDITIONALLY
 * through `syncSessionProjection` (`fsmMirror`). D-59c deleted the blind `mirror*ToIndex` fns + the DO
 * persist/recompute set, so `project()` is the SOLE writer of these D1 mirror columns — which is exactly why
 * a terminal-entering transition MUST write the (cleared) terminal projection rather than skip it: with the
 * legacy writers gone, a skipped write leaves the pre-terminal ACTIVE values STRANDED on the row forever
 * (`syncSessionProjection`'s upsert COALESCE-preserves `rich_status` and never touches the mirror cols).
 * `project()` maps every terminal to its cleared projection (null review-loop/verification mirrors +
 * `working` cycloid_done), so this write realizes the clear-on-terminal oracle.
 *
 * ARC-1330 W11-P3 → D-59c — the DISPLAY SOLE-WRITE (the status-pill twin of the P1 mirror). Under the SAME
 * post-publish gate, `project()`'s `rich_status` phase is written unconditionally (`fsmDisplay`), making
 * `project()` the sole authoritative `rich_status` writer for post-publish states (ACTIVE and TERMINAL — a
 * terminal transition flips the pill to its terminal phase, e.g. `completed`/`failed`/`superseded`). Covers
 * BOTH remaining display surfaces at once: the DO websocket display fields and the session-view builder both
 * read the same persisted display state that `project()` now owns.
 *
 * D-59c retired the P1/P3 `fsm.mirror_divergence` / `fsm.display_divergence` detectors: with the legacy
 * writers deleted, the "independent legacy side" they compared against no longer exists — the comparison
 * would degrade to self-agreement. The pure comparison fns + the samplers were removed at D-60.
 *
 * DO-SQLITE CARVE-OUT (deliberate — read before "fixing"). This write covers the D1 session_index mirror
 * cols ONLY, never the DO-SQLite copies, because STRUCTURALLY this executor never receives a DO SQLite
 * handle (`this.sql`). The DO-SQLite copies are dropped by the D-59d migration; their surviving readers —
 * the DO /state snapshot builders' `cycloid_done` / `review_loop_done_state` — were rewired to the spine
 * projection in D-59c (durable-object.ts `resolveSpineDoneMirror` via `getPrCoordination` + `cycloidDoneOf`
 * / `reviewLoopDoneStateOf`). The `verification_state` readers (scheduler suppression, effective-verification
 * reconciliation) still read the DO-SQLite copy, which retains its surviving DO setter and is NOT orphaned by
 * D-59c. (The ARC-1273 `decideVerificationLiveness` / `isVerificationInFlight` watchdog readers were deleted
 * in D-50; the done-state idempotency short-circuit was folded in D-59a.)
 */
// The ACTIVE post-publish (review-listening) states that carry the live mirror + pill projection.
const MIRROR_ACTIVE_STATES: ReadonlySet<FsmRecord["state"]> = new Set([
  "REVIEW",
  "VERIFYING",
  "MERGE_READY",
  "NEEDS_YOU",
]);

// The POST-PUBLISH TERMINAL states. On entry the mirror/display columns MUST be overwritten with the CLEARED
// terminal projection (`project()` maps each to null review-loop/verification mirrors + `working`
// cycloid_done + the terminal pill). Since D-59c made `project()` the SOLE writer of these columns, a
// SKIPPED write is NOT a clear — it strands the pre-terminal VERIFYING/MERGE_READY-era values on the row
// forever (`syncSessionProjection`'s upsert COALESCE-preserves `rich_status` and never touches the mirror
// cols). ChatGPT P2 #6526. ARCHIVED is included: the executor threads the re-read `session` (already
// `status='archived'` post-archival) into the upsert, so `status` stays coupled to the `archived` pill even
// though the isolated display statement carries no `status` side-effect (db.ts). Terminal GitHub-ground-truth
// parity is still W11-G3's audit domain; this write only owns clearing the stale spine mirror.
const MIRROR_TERMINAL_STATES: ReadonlySet<FsmRecord["state"]> = new Set([
  "MERGED",
  "CLOSED",
  "SUPERSEDED",
  "FAILED",
  "STOPPED",
  "ARCHIVED",
]);

const projectExecutor: LiveSideEffectExecutor = async (ctx) => {
  const session = await getSessionState(ctx.env, ctx.dispatch.sessionId);
  if (!session) {
    await emitSkipped(ctx, "session_not_found");
    return;
  }
  const record = ctx.dispatch.resultingRecord;
  // A POST-PUBLISH record (a PR exists) projects the mirror/display on every transition: ACTIVE states write
  // the live mirror + pill, and TERMINAL states write the CLEARED terminal projection so the pre-terminal
  // values never strand (project() is the sole writer post-D-59c — a skipped write is NOT a clear). Pre-
  // publish records (no PR) project nothing: the FSM projection never wrote those columns for them (nothing to
  // clear), and the legacy per-transition writer owns the pre-publish pill.
  const postPublish = Boolean(record.prUrl);
  const projects = postPublish && (MIRROR_ACTIVE_STATES.has(record.state) || MIRROR_TERMINAL_STATES.has(record.state));
  const mirror = projects ? projectMirrorColumns(record) : null;
  const display = projects ? projectDisplayColumns(record) : null;
  await syncSessionProjection({
    db: ctx.env.DB,
    reportEnv: ctx.env,
    sessionId: ctx.dispatch.sessionId,
    session,
    fsmMirror: mirror,
    fsmDisplay: display,
    automationExecution: display
      ? {
          reason: record.blockedReason ?? record.failureReason,
          completedAt: record.stateEnteredAt ?? Date.now(),
        }
      : null,
    source: "fsm-live-side-effects",
  });
  if (display) {
    await publishSessionUpsertedFromDb(ctx.env, ctx.env.DB, ctx.dispatch.sessionId, "fsm-display");
  }
  if (projects && MIRROR_TERMINAL_STATES.has(record.state)) {
    await cleanupLegacyIntentObserver(ctx, session);
  }
};

/**
 * The FSM-native spawn idempotency anchor (W11-V4) — the committed-spine dedup that lets D-51 drop the
 * per-PR verification lock and D-52 drop the per-head request claim. Keyed on the committed
 * `(session_id, verification_run_id, verification_run_head)` of the dispatch, decided against the LIVE
 * `pr_coordination` record (the materialized head of the `pr_coordination_events` append-only log —
 * version = log offset). Four outcomes:
 *
 *   • `no_committed_record` — the live read returned null. A live spawn ALWAYS follows the committed CAS
 *     write, so this is prod-unreachable (a lost row / a test that mocks the scheduler without a spine
 *     row); fall through to the scheduler (the stamp's atomic IS-NULL claim is the only remaining
 *     double-spawn guard now that D-52 dropped the per-head request claim).
 *   • `stale` — the run this spawn was owed for is no longer the active run (`verification_run_id`
 *     advanced — MONOTONIC, so live ≥ committed). Discriminated on `verification_run_id`,
 *     NOT `verification_run_head`: a `head.noop_changed` restamps the run head but KEEPS the same run +
 *     child (SF9), so a run-head mismatch alone must not skip a still-owed spawn. Re-spawning here would
 *     orphan a child on a dead run; the owning run (if any) emits its OWN spawn.
 *   • `already_spawned` — the current run already carries a stamped `verification_child_id` (W11-V1). The
 *     run-minting actions (`request`/`redispatch_verification`) reset the handle to NULL, so on run R a
 *     non-null child means run R's spawn already landed → a genuine infra-retried / D17-redelivered spawn.
 *   • `spawn` — run R is still the active run with a NULL child slot → owed, not yet spawned.
 *
 * H→H′→H (ABA) disambiguation WITHOUT the legacy claim: `verification_run_id` is re-stamped +1 by every
 * `redispatch_verification`, so the two visits to head H carry DIFFERENT run ids (R and R+2). A stale
 * spawn owed for run R reads live run R+2 → `stale`; the fresh spawn for R+2 reads a NULL child → `spawn`.
 * The legacy `verification_session_requests` PK was `(pr_url, head_sha)` — head-only, ABA-blind — and
 * would have conflated the two visits; the run-id anchor cannot.
 */
type SpawnAnchorDecision = "spawn" | "already_spawned" | "stale" | "no_committed_record";

function resolveSpawnAnchor(committed: FsmRecord, live: PrCoordinationRecord | null): SpawnAnchorDecision {
  if (!live) return "no_committed_record";
  // A3: run-id-keyed only. The spawn now rides the `publish.pr_opened → REVIEW` edge (A1), so the
  // committed + live records are in REVIEW, not VERIFYING — the phase gate would false-`stale` every
  // publish-time spawn. `verification_run_id` is monotonic (re-stamped +1 by every respawn), so an
  // owed spawn whose run was superseded still reads a NEWER live run id → `stale`; the H→H′→H (ABA)
  // disambiguation is carried entirely by the run id.
  if (live.verificationRunId !== committed.verificationRunId) return "stale";
  if (live.verificationChildId != null) return "already_spawned";
  return "spawn";
}

/**
 * Stamp the spawned verifier child handle onto the spine (W11-V1) so the run-scoped `kill_verification`
 * gains teeth, AND claim the run's spawn slot (W11-V4 — the `verification_child_id IS NULL` first-writer
 * guard). Best-effort: the child is ALREADY created, so a stamp fault only leaves the kill toothless for
 * THIS run (the child parks per #6310, not leaks) — never a correctness issue (soundness never depended on
 * the kill; run-scoped verdict freshness rejects a stale pass, design §7). A 0-row result means one of:
 * the run was superseded / left VERIFYING before the stamp landed, OR a CONCURRENT spawn already claimed
 * the slot (W11-V4 first-writer-wins) — in the concurrent case this dispatch's child is the loser: its
 * verdict echoes the same run so it is ghost-discarded once the winner's verdict exits VERIFYING (a second
 * verdict for a run that already left VERIFYING fails the freshness guard), and the session parks per
 * #6310 — never a double-recorded verdict. The stamp NEVER bumps `version` or appends an event: it cannot
 * mint a transition (contract §4).
 */
async function stampSpawnedVerificationChild(
  ctx: LiveSideEffectContext,
  record: FsmRecord,
  childSessionId: string,
): Promise<void> {
  const db = ctx.env.DB;
  if (!db) return;
  const tags = {
    ...effectTags(ctx.dispatch, ctx.effect.kind),
    childSessionId,
    verificationRunId: record.verificationRunId,
  };
  try {
    const stamped = await stampVerificationChildId(
      db,
      ctx.dispatch.sessionId,
      record.verificationRunId,
      childSessionId,
    );
    if (stamped === 0) {
      log.info(
        tags,
        "fsm live sink: verifier child spawned but the run was already superseded / left VERIFYING — child handle not stamped (kill stays best-effort for the superseded run)",
      );
    } else {
      log.info(
        tags,
        "fsm live sink: verification_child_id stamped — kill_verification gains teeth for this run (W11-V1)",
      );
    }
  } catch (err) {
    log.warn(
      { ...tags, error: String(err) },
      "fsm live sink: verification_child_id stamp failed (best-effort — kill stays toothless for this run, child parks per #6310)",
    );
  }
}

/**
 * `spawn_verification_child` — the FSM-native spawn destination (W11-V3(a)): the scheduling is INLINED
 * FSM-side via `verification-spawn.ts` (`fsmNative: true`), not delegated to the legacy VA orchestrator.
 *
 * CRITICAL SOUNDNESS (the FSM-native idempotency anchor, W11-V4): the PRIMARY dedup is the pre-spawn
 * `resolveSpawnAnchor` read of the committed spine (above) — an infra-retried / D17-redelivered spawn
 * no-ops on `already_spawned`/`stale` BEFORE reaching the scheduler. The anchor READ is a NON-ATOMIC
 * fast-path, not the atomic boundary: under true concurrency two executors can BOTH pass the read (both
 * see a NULL child slot) and both reach `schedule()`. The real ATOMIC double-spawn boundary is the
 * stamp's first-writer-wins claim (`stampVerificationChildId`'s `verification_child_id IS NULL` guard —
 * see pr-coordination-db.ts): exactly one concurrent spawn claims the run's slot. As of W11 D-52 the
 * anchor pair (non-atomic read + the stamp's atomic IS-NULL claim) is the SOLE double-spawn boundary:
 * the legacy per-head `verification_session_requests` claim is DROPPED (D-52) and the per-PR lock was
 * removed at D-51. ACCEPTED D-52 COST: a truly-concurrent spawn window CAN now create a second verifier
 * SESSION — bounded: a single recorded verdict (the loser's verdict fails run-scoped freshness once the
 * record leaves VERIFYING), no cap burn, and the extra session parks per #6310. The H→H′→H (ABA)
 * disambiguation the dropped `(pr, head)`-keyed claim never could do is carried by the monotonic
 * `verification_run_id`. The legacy "run count" is a COUNT of registered verifier sessions
 * (`countVerificationSessionsByGithubPrRef`); the FSM's own `verification_run_count` was already bumped in
 * the CAS by `request_verification` — this executor NEVER touches counts, so a redelivered spawn (whether
 * stopped by the anchor or the advisory active-verifier check) cannot burn the cap.
 *
 * DECLINE TAXONOMY (no silent drops — the flip dashboard must see real non-executions):
 *   • `verdict_already_settled` / `active_verification_session_exists` — REAL non-executions (the
 *     FSM committed VERIFYING but legacy's state gate declined the child): each emits
 *     `fsm.sideeffect.skipped` with its reason, like every other policy decline.
 *   • `schedule_failed` — a genuine infra failure: NO LONGER thrown (W11-V3(a)). The committed VERIFYING
 *     row is terminalized via a run-scoped `verification.failed` → NEEDS_YOU(verification_stopped) follow-up
 *     (committed-before-side-effects, the PR 49 pattern) so it can never wedge / retry forever.
 *
 * The spawn is keyed to the COMMITTED record at this version: `pr_url` + `verification_run_head`
 * (the head `request_verification`/`redispatch_verification` stamped in the same CAS). The committed
 * `verification_run_id` is the §17-A run token: the scheduler now CONSUMES it (PR 47) — it rides the
 * verifier prompt enqueue, is persisted per-prompt in the child DO's storage, and the verdict-back
 * seam echoes it as `VerifierTerminalResult.verificationRunId`, so run-scoped freshness holds
 * end-to-end (a superseded run's late verdict carries the OLD token and is ghost-discarded; under
 * live a verdict with NO echoed token is rejected — verification-producer.ts).
 *
 * Dynamic import: the scheduler transitively imports the FSM producers (which import this file for
 * sink injection), so a static import would be a module cycle — the established `router.ts` lazy
 * pattern breaks it.
 */
const spawnVerificationChildExecutor: LiveSideEffectExecutor = async (ctx) => {
  const record = ctx.dispatch.resultingRecord;
  const prUrl = record.prUrl;
  const headSha = record.verificationRunHead ?? record.headSha;
  if (!prUrl || !headSha) {
    // Defensive: a dispatching row always carries both (init_record B5 + request_verification).
    await emitSkipped(ctx, "missing_pr_or_head");
    return;
  }
  // ── FSM-native spawn idempotency anchor (W11-V4) ──
  // Decide against the committed spine BEFORE touching the scheduler. An
  // infra-retried / D17-redelivered spawn no-ops here — it never reaches `schedule()`, so it can neither
  // create a second child nor burn the cap (the cap lives in the CAS-owned `verification_run_count`, which
  // this executor NEVER touches — `request_verification` bumped it exactly once for the run). NON-ATOMIC
  // fast-path: two truly-concurrent executors can both pass this read; the ATOMIC boundary is the stamp's
  // first-writer-wins IS-NULL claim (see the executor doc header + pr-coordination-db.ts). As of D-52 the
  // per-head request claim is DROPPED and the per-PR lock was removed at D-51 — the anchor pair is the
  // sole double-spawn boundary (accepted concurrent-double-spawn cost per the doc header).
  const anchorDb = ctx.env.DB;
  if (anchorDb) {
    const live = await getPrCoordination(anchorDb, ctx.dispatch.sessionId).catch(() => null);
    const anchor = resolveSpawnAnchor(record, live);
    if (anchor === "stale") {
      // The run this spawn was owed for was superseded (newer run_id) or already recorded a verdict.
      await emitSkipped(ctx, "verification_run_superseded");
      return;
    }
    if (anchor === "already_spawned") {
      // A child was already spawned + stamped for THIS run. Only a LIVE stamped child makes this a
      // genuine idempotent redelivery — a crashed/stopped verifier must NOT suppress the D17 repair
      // re-drive (ChatGPT P1, #6419): consult the live-verifier advisory (`findActiveVerificationSession`,
      // the entry-point dedup the scheduler also uses) and fall through to the scheduler ONLY on a
      // definitive "no live verifier" (an advisory ERROR stays a no-op — fail-closed against double-spawn;
      // the VERIFYING deadline backstop covers the ambiguous case). The re-driven child stays UNSTAMPED
      // (the dead child's handle holds the IS-NULL slot) — same posture as the legacy stopped-verifier
      // rerun: kill no-ops on the dead handle (404-idempotent) and the new child parks per #6310 if
      // superseded.
      const liveVerifier = await findActiveVerificationSession(ctx.env, log, prUrl).catch(() => {
        return { sessionId: "advisory-error-treat-as-live" };
      });
      if (liveVerifier) {
        // Log only (no telemetry): a live verifier already owns this run — an idempotent no-op.
        log.info(
          { ...effectTags(ctx.dispatch, ctx.effect.kind), verificationRunId: record.verificationRunId },
          "fsm live sink: verification spawn deduped by the FSM anchor (child already stamped for this run — idempotent no-op)",
        );
        return;
      }
      log.info(
        {
          ...effectTags(ctx.dispatch, ctx.effect.kind),
          verificationRunId: record.verificationRunId,
          staleChildId: live?.verificationChildId ?? null,
        },
        "fsm live sink: stamped verifier is no longer live — falling through to the scheduler so the spawn re-drives (D17 self-repair)",
      );
    }
    // `spawn` / `no_committed_record` → fall through to the scheduler (+ the post-commit child-id stamp).
  }
  const session = await getSessionState(ctx.env, ctx.dispatch.sessionId);
  if (!session) {
    await emitSkipped(ctx, "session_not_found");
    return;
  }
  // W11-V3(a): the spawn scheduling is INLINED FSM-side — `verification-spawn.ts` is the FSM-owned
  // destination (the legacy `verification-auto-scheduler.ts` is now only a compat re-export for the
  // legacy callers D-50A removes/repoints). `fsmNative: true` selects the FSM-native path: no env-policy
  // gate (the cascade already decided; the #6395 per-user auto-verify opt-out IS still honored as a
  // structured skip) and no redundant A1 shadow-drive (the spawn fires on the publish edge in REVIEW;
  // there is no separate legacy driver to race).
  // Dynamic import: the spawn module transitively imports the FSM producers (which import this file for
  // sink injection), so a static import would be a module cycle — the established `router.ts` lazy
  // pattern breaks it.
  const { scheduleVerificationForPr } = await import("../verification-spawn");
  const schedule = () =>
    scheduleVerificationForPr({
      env: ctx.env,
      logger: log,
      parentSessionId: ctx.dispatch.sessionId,
      parentPromptId: null,
      ownerUserId: session.ownerUserId,
      businessId: session.businessId ?? null,
      repoOwner: session.repoOwner ?? null,
      repoName: session.repoName ?? null,
      installationId: session.installationId ?? null,
      prUrl,
      headSha,
      agentRole: session.agentRole ?? null,
      // The per-user/session auto-verify opt-out (#6395 user_settings toggle) is HONORED — the decline
      // returns as the first-class `auto_verify_disabled` structured skip below (flip-dashboard visible;
      // the VERIFYING deadline backstop owns unwedging the committed row). DECIDED 2026-07-06: opted-out
      // sessions are WAIVED at the caught_up cascade (guards.autoVerifyDisabled, live-resolver) and no
      // longer routed into VERIFYING at all — this decline survives only as defense-in-depth for a
      // stale/failed session read at the caught_up snapshot.
      autoVerifyDisabled: session.autoVerifyDisabled ?? null,
      requestId: null,
      // The settled-verdict cohort exits the cascade via row 7 with NO spawn, so this executor only ever
      // fires on a genuine under-cap REVIEW→VERIFYING dispatch — the scheduler's verdict-settled skip
      // never applies to the FSM path (left unthreaded → null → the skip is inert).
      currentVerificationState: null,
      currentVerificationResult: null,
      currentVerificationVerdictHeadSha: null,
      // The committed §17-A run token — the spawn threads it into the verifier prompt enqueue
      // (per-prompt DO storage) and the verdict-back echoes it (see the executor doc above and the
      // source-level pin in live-side-effects.test.ts, flipped by PR 47).
      verificationRunId: record.verificationRunId,
      fsmNative: true,
    });
  // W11 D-52: the per-head `verification_session_requests` claim is DROPPED, so the scheduler no longer
  // returns `duplicate` — the FSM anchor above (non-atomic read) + the stamp's atomic IS-NULL claim are
  // the sole double-spawn boundary. There is no stale-claim to disambiguate/release here anymore; a
  // truly-concurrent window is the accepted D-52 cost (see the executor doc + resolveSpawnAnchor).
  const result = await schedule();
  if (result.scheduled) {
    // W11-V1: consume the child-session id the scheduler returns and commit it to the spine so the
    // run-scoped `kill_verification` can tear down THIS run's child (design §17-A — the spawn
    // side-effect writes `verification_child_id`). A concurrent loser's child (if the anchor's
    // non-atomic read let two spawns through) does NOT win the stamp — the IS-NULL guard makes exactly
    // one first-writer; the loser's verdict fails run-scoped freshness and its session parks per #6310.
    await stampSpawnedVerificationChild(ctx, record, result.sessionId);
    return;
  }
  if (result.reason === "schedule_failed") {
    if (result.failureStage === "post_enqueue") {
      // ChatGPT P2 (#6425): the failure hit AFTER the verifier prompt was enqueued — the child IS
      // running, and terminalizing the parent out of VERIFYING would orphan its later valid verdict
      // (run-scoped freshness only settles a run still in VERIFYING). Leave the row in VERIFYING:
      // the child's verdict settles it normally; if the child dies instead, the VERIFYING deadline
      // backstop (W11-V2) owns the loud unwedge. Stamp the child handle when the scheduler could
      // name it (IS-NULL-guarded — safe), so kill_verification keeps its teeth for this run.
      if (result.verificationSessionId) {
        await stampSpawnedVerificationChild(ctx, record, result.verificationSessionId);
      }
      log.warn(
        {
          ...effectTags(ctx.dispatch, ctx.effect.kind),
          verificationRunId: record.verificationRunId,
          childSessionId: result.verificationSessionId ?? null,
          error: result.error ?? null,
        },
        "fsm live sink: schedule_failed AFTER prompt enqueue — child is running, NOT terminalizing (bookkeeping fault only; verdict settles normally or the deadline backstop unwedges)",
      );
      await emitSkipped(ctx, "schedule_failed_post_enqueue_child_running");
      return;
    }
    // W11-V3(a) — COMMITTED-BEFORE-SIDE-EFFECTS (the PR 49 pattern): a real PRE-ENQUEUE infra spawn
    // failure (no child was enqueued) no longer
    // THROWS (which left the row wedged in VERIFYING and let D17 re-derive the owed spawn forever — the
    // 2026-06-23 stuck-loop / 500-before-persist class). The REVIEW→VERIFYING transition already committed,
    // so instead of an un-terminalizing throw we drive a run-scoped `verification.failed` follow-up event:
    // VERIFYING→NEEDS_YOU(verification_stopped) with LOUD + kill + release (transition.ts). It is run-scoped
    // (`runId := record.verificationRunId`, the active run) so a superseded run's failure ghost-discards
    // instead of terminalizing a newer live run (FG-1). `shadowEmitVerificationOutcome` is internally
    // try-caught (never throws) — a failed drive leaves the row in VERIFYING for the deadline backstop
    // (W11-V2) to unwedge, so the session is never silently stuck. Dynamic import: the producer imports
    // this file (`liveFsmSinks`) — a static import would be a module cycle.
    const { shadowEmitVerificationOutcome } = await import("./verification-producer");
    await shadowEmitVerificationOutcome(
      ctx.env,
      ctx.dispatch.sessionId,
      { outcome: "failed", runId: record.verificationRunId, headSha: null },
      log,
    );
    // Dashboard visibility: the spawn did not execute and was terminalized to NEEDS_YOU (distinct from a
    // silent dedup or a legacy-gate decline). The VERIFYING→NEEDS_YOU transition itself is observable via
    // `fsm.transition`; this names the CAUSE so the flip dashboard can attribute the terminal.
    await emitSkipped(ctx, "schedule_failed_terminalized");
    return;
  }
  // Every other decline is a REAL non-execution (verdict_already_settled,
  // active_verification_session_exists, auto_verify_disabled, policy_not_auto, run limit, …): the
  // FSM committed VERIFYING but the legacy gate declined the child — no silent drop; the skip event
  // makes it visible on the flip dashboard, and the VERIFYING deadline backstop (PR 48/49
  // reconciles) owns unwedging the session.
  log.warn(
    { ...effectTags(ctx.dispatch, ctx.effect.kind), reason: result.reason },
    "fsm live sink: verification spawn declined by the legacy gate",
  );
  await emitSkipped(ctx, result.reason);
};

/**
 * `kill_verification{verificationChildId}` — tears down a SPECIFIC run's child session through the
 * existing close path (`closeSessionState`, which also best-effort releases the per-PR verification
 * lock for a verifier child). IDEMPOTENT: a 404 (already dead/absent child) resolves to `null` and is
 * a no-op. The run-scoped kill has TEETH as of W11-V1: the spawn executor stamps
 * `verification_child_id` post-commit (`stampVerificationChildId` — a run-id-guarded write that never
 * bumps `version`, so it honors the §15-inv-1 single writer without minting a transition), so the
 * VERIFYING-exit resolvers now supply the active run's real child handle. A null child id is still a
 * LOGGED no-op (a backfilled/never-spawned run, or a stamp that lost the supersession race). Soundness
 * never depended on the kill (`kill_verification` is best-effort by design — run-scoped verdict
 * freshness rejects a late pass, design §7; #6310 verifier-session reuse additionally parks, not leaks,
 * an unkilled child). FG-1: the ghost-discard edge targets `verdictVerificationChildId`, NOT this
 * active handle — the record carries only the ACTIVE run's child, and the ghost's (superseded) child was
 * already killed at supersession, so the resolvers pass `null` there (never the live run's child).
 */
const killVerificationExecutor: LiveSideEffectExecutor = async (ctx) => {
  const childId = (ctx.effect.args?.verificationChildId as string | null | undefined) ?? null;
  if (!childId) {
    log.info(
      effectTags(ctx.dispatch, ctx.effect.kind),
      "fsm live sink: kill_verification with null child handle (logged no-op)",
    );
    return;
  }
  const closed = await closeSessionState(ctx.env, childId, null, { reason: "fsm_kill_verification" });
  if (closed === null) {
    log.info(
      { ...effectTags(ctx.dispatch, ctx.effect.kind), childId },
      "fsm live sink: kill_verification target already gone (idempotent no-op)",
    );
  }
};

/**
 * `terminate_runtime` (R4) — reclaim a FINAL-terminal session's runtime VM (merged/closed/superseded/
 * verifier-kill archive) instead of parking it paused for the 72h retention window. It reads the session's
 * OWN `session_index` runtime projection (id + backend) and drives the SAME checkpointed DO cleanup-run
 * workflow the cron uses (`runE2BRuntimeCleanupViaSessionDO`), with reason `session_terminal` — no new
 * route, no parallel terminate path. The DO re-decides live under its ownership guards (a newer runtime
 * attached after terminal entry → `skipped_sandbox_changed`) and never yanks an in-flight turn.
 *
 * IDEMPOTENCY / ISOLATION (mirrors `killVerificationExecutor`): no projected runtime id is a logged no-op
 * (never spawned, or already cleared — the projection nulls at clear); the DO terminate is
 * missing-idempotent, so a redelivered dispatch converges. A thrown DO call is isolated by the sink's
 * per-effect try/catch (emitted as `fsm.sideeffect.failed`) and never blocks the other effects — the CAS
 * commit stands regardless.
 */
const terminateRuntimeExecutor: LiveSideEffectExecutor = async (ctx) => {
  const projection = await getSessionIndexRuntimeProjection(ctx.env.DB, ctx.dispatch.sessionId);
  if (!projection) {
    log.info(
      effectTags(ctx.dispatch, ctx.effect.kind),
      "fsm live sink: terminate_runtime with no projected runtime (logged no-op)",
    );
    return;
  }
  const result = await runE2BRuntimeCleanupViaSessionDO(ctx.env, {
    sessionId: ctx.dispatch.sessionId,
    projectedRuntimeSandboxId: projection.runtimeSandboxId,
    projectedRuntimeBackend: projection.runtimeBackend,
    reason: "session_terminal",
    nowMs: ctx.now(),
  });
  // The DO's disposition (skipped_live_activity on an in-flight turn, skipped_sandbox_changed
  // when a newer VM raced in, cleared, retry_scheduled, ...) is otherwise only visible in the
  // DO's own sandbox.runtime.cleanup event — log it here so a dispatched terminate_runtime
  // effect correlates with what actually happened at the sink level.
  log.info(
    {
      ...effectTags(ctx.dispatch, ctx.effect.kind),
      runtimeSandboxId: projection.runtimeSandboxId,
      outcome: result.outcome,
      reasonCode: result.reasonCode,
    },
    "fsm live sink: terminate_runtime cleanup-run disposition",
  );
};

/**
 * `dispatch_epoch` — keyed by the `in_flight_epoch_id` the CAS already committed (§17-B: the id is
 * stamped under the SAME CAS as this side-effect, so it is the idempotency anchor). Wave-11 W11-V5
 * transfers epoch-CREATION authority to this executor (was exists-check-only through PR 49).
 *
 *   • ANCHOR (redelivery / legacy-threaded): a committed id that ALREADY EXISTS in the epoch store is
 *     an idempotent no-op (`getReviewLoopEpochById`). PR 47 threads a legacy-created epoch id into
 *     `Guards.newEpochId` on the review-webhook path (live-resolver.ts `ctx.legacyEpochId`), so those
 *     dispatches bind to the REAL row here. A D17-redelivered dispatch re-observes the row this
 *     executor itself created on a prior pass — same id, so it re-binds instead of re-creating.
 *
 *   • CREATION (review trigger, no materialized row — `release_queued_reviews` / cascade epoch-1 for
 *     the no-legacy-id cohort): create the epoch keyed on the committed id, its worklist traced to the
 *     REGISTERED disposition-store items (`listUndispositionedActionable`). NEVER a bare trigger — an
 *     empty actionable set is a structured skip, so the FSM can never fabricate review evidence (the
 *     PR 46 objection). Double-creation is impossible on THREE independent guards: the by-id
 *     exists-check above, the `INSERT OR IGNORE` on the committed id (PK), and the source-level de-dupe
 *     against any LIVE (non-terminal) epoch's covered sources (`listLiveEpochCoveredSourceIds` — a
 *     TERMINAL epoch's prompted ids do NOT count, so an item it left undispositioned stays
 *     re-dispatchable, ARC-1445).
 *
 *   • CI-FIX creation is allowed only when a materialized CI epoch already exists for this exact
 *     session/PR/head. Its check-source ids are copied into the new committed-id row, so a still-red
 *     retry preserves provenance instead of fabricating evidence from the aggregate FSM signal.
 *
 * Dynamic import for the same producer-cycle reason as the verification spawn.
 */
const dispatchEpochExecutor: LiveSideEffectExecutor = async (ctx) => {
  const record = ctx.dispatch.resultingRecord;
  const epochId = record.inFlightEpochId;
  if (!epochId) {
    // Defensive: every dispatching edge stamps the id in the same CAS (requireNewEpochId fails loud).
    await emitSkipped(ctx, "no_committed_epoch_id");
    return;
  }
  const {
    getReviewLoopEpochById,
    getLatestCiReviewLoopEpochForHead,
    createFsmDispatchedReviewLoopEpoch,
    listLiveEpochCoveredSourceIds,
  } = await import("../../services/review-loop-epochs");
  const existing = await getReviewLoopEpochById(ctx.env.DB, epochId);
  // Kill switch (ARC-1330 Phase B B4): REVIEW_LOOP_IMMEDIATE_DISPATCH="off" reverts to the Wave-11
  // behavior — the FSM still CREATES the epoch row below, but dispatch falls back to the fast cron /
  // poll. "off" reverts dispatch TIMING only; the FSM still owns epoch creation. Default (unset) = ON.
  const immediateDispatchOff = ctx.env.REVIEW_LOOP_IMMEDIATE_DISPATCH === "off";
  if (existing) {
    // The committed id is already materialized — the §17-B anchor: legacy threaded it, a prior FSM pass
    // created it, or a redelivery re-observed it. B4 teeth: drive it on the SAME webhook-arrival turn
    // instead of waiting for the fast cron (prod bot p50 16.3 min arrival→first-op → seconds). The
    // claim-CAS inside dispatchReviewLoopEpoch is the single mutex, so a concurrent cron/poll dispatch
    // of the same epoch no-ops on the loser → "skipped". Flag OFF reverts to the idempotent no-op.
    if (!immediateDispatchOff) await dispatchFsmEpochOnArrival(ctx, existing);
    return;
  }
  const trigger = (ctx.effect.args?.trigger as EpochTrigger | undefined) ?? null;
  if (trigger !== "review" && trigger !== "ci_fix") {
    await emitSkipped(ctx, "unknown_epoch_trigger");
    return;
  }
  const prUrl = record.prUrl;
  const headSha = record.headSha;
  if (!prUrl || !headSha) {
    // Defensive: a REVIEW-state dispatching row always carries both (init_record B5 + advance_head).
    await emitSkipped(ctx, "missing_pr_or_head");
    return;
  }
  const session = await getSessionState(ctx.env, ctx.dispatch.sessionId);
  if (!session) {
    await emitSkipped(ctx, "session_not_found");
    return;
  }
  const prNumber = prNumberFromUrl(prUrl);
  if (!prNumber) {
    // Greptile P2 (#6422): a structurally-valid URL that fails the /pull/<n> parse must not mint an
    // epoch row with pr_number=0 (breaks downstream PR-number lookups) — a dedicated skip keeps the
    // never-fabricate contract tight.
    await emitSkipped(ctx, "unparseable_pr_number");
    return;
  }
  let kind: "review" | "ci";
  let sourceIds: string[];
  let predecessorEpochId: string | undefined;
  if (trigger === "ci_fix") {
    const prior = await getLatestCiReviewLoopEpochForHead(ctx.env.DB, {
      sessionId: ctx.dispatch.sessionId,
      prUrl,
      headSha,
    });
    if (!prior || prior.triggeringSourceIds.length === 0) {
      // Preserve the committed marker for D17 redelivery. Without a real predecessor there is no
      // failing-check identity to authorize a CI-fix prompt, so fail closed rather than inventing one.
      await emitSkipped(ctx, "ci_fix_retry_missing_predecessor");
      return;
    }
    kind = "ci";
    sourceIds = prior.triggeringSourceIds;
    predecessorEpochId = prior.id;
  } else {
    // TRACE (the never-fabricate guard): the epoch's worklist is the registered disposition-store items
    // (undispositioned actionable). An EMPTY set is a bare trigger — skip, never create.
    const actionable = await listUndispositionedActionable(ctx.env.DB, ctx.dispatch.sessionId, prUrl);
    if (actionable.length === 0) {
      await settleCommittedDispatchMarker(ctx, "no_disposition_items_bare_trigger");
      return;
    }
    // DE-DUPE vs legacy (parallel fallback): a source already covered by a LIVE epoch is not re-driven.
    const covered = await listLiveEpochCoveredSourceIds(ctx.env.DB, {
      sessionId: ctx.dispatch.sessionId,
      prUrl,
    });
    sourceIds = actionable.filter((sourceId) => !covered.has(sourceId));
    if (sourceIds.length === 0) {
      await settleCommittedDispatchMarker(ctx, "disposition_items_already_epoched");
      return;
    }
    kind = "review";
  }
  const created = await createFsmDispatchedReviewLoopEpoch(ctx.env.DB, {
    id: epochId,
    sessionId: ctx.dispatch.sessionId,
    ownerUserId: Number(session.ownerUserId),
    repoOwner: session.repoOwner ?? "",
    repoName: session.repoName ?? "",
    prNumber,
    prUrl,
    headSha,
    kind,
    predecessorEpochId,
    sourceIds,
    nowMs: ctx.now(),
  });
  if (!created) {
    // A null return is specifically the wave-CAS retry budget exhausted under sustained concurrent
    // creation (Greptile P2, #6422) — a genuine same-id redelivery BINDS inside the DAO and returns the
    // row, so it never reaches here. Distinct reason so dashboards can alert on real contention instead
    // of reading it as a benign dedup. Idempotent no-op — NOT a double-create.
    await emitSkipped(ctx, "epoch_create_cas_exhausted");
    return;
  }
  // B4 teeth: dispatch the freshly-created row on this same webhook-arrival turn instead of waiting for
  // the fast cron. Same claim-CAS mutex + guards as the existing-row path; the created row is `ready`,
  // so the claim succeeds immediately. Flag OFF leaves it for the cron (Wave-11 create-only behavior).
  if (!immediateDispatchOff) await dispatchFsmEpochOnArrival(ctx, created);
};

/**
 * B4 (ARC-1330 Phase B): drive a review epoch through the shared cron dispatch core
 * (`dispatchReviewLoopEpoch`) on the webhook-arrival turn — the "webhook is primary, fast cron is the
 * backstop" contract. This runs in WORKER context (the ingest handler's ExecutionContext threads
 * `waitUntil` at the sink boundary), so the `enqueueSessionPrompt` inside is a normal worker→DO call —
 * NO self-fetch. A `ready` epoch claims + dispatches immediately (the win); the 1-min fast cron is the
 * backstop for anything not yet claimable. Emits one best-effort `fsm.sideeffect.epoch_dispatched` so the dashboard sees the
 * immediate-dispatch outcome distribution alongside the arrival_to_dispatch_ms rollout gate.
 */
async function dispatchFsmEpochOnArrival(ctx: LiveSideEffectContext, epoch: ReviewLoopEpoch): Promise<void> {
  const { dispatchReviewLoopEpoch } = await import("../../services/review-loop-sweep");
  const result = await dispatchReviewLoopEpoch(ctx.env, epoch, {
    nowMs: ctx.now(),
    logger: log,
    trigger: "webhook_arrival",
  });
  await emitBestEffort(ctx, {
    event: "fsm.sideeffect.epoch_dispatched",
    ...effectTags(ctx.dispatch, ctx.effect.kind),
    result,
  });
}

/**
 * `notify_user` — the cascade row-7 happy-path "merge-ready" ping. There is NO unambiguous positive
 * merge-ready user notification in the legacy loop today (`notifyUserBlocked` is the NEEDS_YOU DM,
 * the `loud` terminal fanout posts the internal-ops negative-outcome alert, `notifySessionPrMerged`
 * fires post-merge) — so rather than inventing a new user surface in the flip slice, this is a
 * structured skip. The PR 49 loud-signal slice wires NEEDS_YOU/FAILED notifications; this positive
 * READY ping remains intentionally inert until a product surface exists for it.
 */
const notifyUserExecutor: LiveSideEffectExecutor = inertExecutor("no_unambiguous_merge_ready_notify_until_pr49");

/**
 * `notify_qa_issue` — a NON-BLOCKING QA-issue DM: verification returned a fresh run_limit/stopped/failed,
 * so the FSM stays in place (a self-loop) and we merely inform the owner. Rides notifyUserBlocked's DM
 * transport (fixed `VerificationIssue` copy) with NO blocked_reason, NO ops-channel/loud fanout. Best-
 * effort: a missing Slack target or a send fault is a swallowed no-op (verification is off-gate).
 */
const notifyQaIssueExecutor: LiveSideEffectExecutor = async (ctx) => {
  const record = ctx.dispatch.resultingRecord;
  const session = await getSessionState(ctx.env, ctx.dispatch.sessionId).catch(() => null);
  const slackSuppression = classifyLoudSlackSuppression(ctx.env, session);
  const ownerUserId = Number(session?.ownerUserId);
  if (slackSuppression === "non_production" || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
    await emitSkipped(ctx, "qa_issue_dm_suppressed_or_no_owner");
    return;
  }
  const result = await notifyUserBlocked(ctx.env, {
    sessionId: ctx.dispatch.sessionId,
    ownerUserId,
    callbackContext: session?.callbackContext ?? undefined,
    kind: BlockerKind.VerificationIssue,
    dedupKey: `${ctx.dispatch.sessionId}:qa_issue:v${ctx.dispatch.version}`,
    prUrl: record.prUrl ?? undefined,
  });
  await emitBestEffort(ctx, {
    event: "fsm.notify_qa_issue",
    ...effectTags(ctx.dispatch, ctx.effect.kind),
    fsm_event: ctx.dispatch.event.type,
    user_notify_result: result,
    slack_suppressed: slackSuppression,
  });
};

/**
 * Emit the legacy `review_loop.settled` telemetry from a committed FSM terminal — the re-home for the
 * signal PR 47 silenced when it gated the DO done-state schedule block (the sole legacy emitter, now a
 * no-op under live). The consumed fields (final_state, schedule_reason, cap_blocked, total_epochs,
 * review_listening_ms — see infra/datadog-review-loop.tf + datadog-log-metrics.tf) are preserved so the
 * `by {final_state}`/`by {schedule_reason}` dashboards keep working post-flip. `review_listening_ms` is
 * omitted (null): the last-head-armed→settle window lives in the DO's `reviewListeningEnteredAt`, not
 * on the committed FSM record, so the duration metric degrades to the emit_settle-less legacy rows
 * rather than reporting a wrong value.
 */
async function emitFsmReviewLoopSettled(
  env: Env,
  dispatch: SideEffectDispatch,
  fields: { finalState: string; scheduleReason: string; capBlocked: boolean; whichCap: string | null },
): Promise<void> {
  const record = dispatch.resultingRecord;
  const session = await getSessionState(env, dispatch.sessionId).catch(() => null);
  const prUrl = record.prUrl;
  const [totalEpochs, totalVerificationRuns] = prUrl
    ? await Promise.all([
        countReviewLoopEpochsForPr(env.DB, { sessionId: dispatch.sessionId, prUrl }).catch(() => null),
        countVerificationSessionsByGithubPrRef(env.DB, prUrl).catch(() => null),
      ])
    : [null, null];
  const ownerUserId = Number(session?.ownerUserId);
  await emitReviewLoopSettledEvent(env, {
    finalState: fields.finalState,
    scheduleReason: fields.scheduleReason,
    capBlocked: fields.capBlocked,
    whichCap: fields.whichCap,
    model: session?.model ?? null,
    repo: repoLabel(prUrl, session),
    ownerUserId: Number.isSafeInteger(ownerUserId) ? ownerUserId : 0,
    totalEpochs,
    totalVerificationRuns,
    reviewListeningMs: null,
    sessionId: dispatch.sessionId,
    prUrl,
  });
}

/**
 * `loud` — the terminal alert fanout: user DM where an existing fixed-copy `notifyUserBlocked`
 * blocker kind maps cleanly, internal operator alert, and structured DD. Dedup is per committed
 * terminal version/head/reason so D17 redelivery never spams, while a later re-entry into the same
 * terminal on a new version can alert again. The Slack legs (DM + ops channel) are gated by
 * `classifyLoudSlackSuppression` — non-prod control planes send nothing, smoke/QA cohorts skip the
 * ops channel; the DD emit below is never gated.
 */
const loudExecutor: LiveSideEffectExecutor = async (ctx) => {
  const record = ctx.dispatch.resultingRecord;
  let userNotifyResult: string | null = null;
  let internalAlertPosted: boolean | null = null;
  let slackSuppression: LoudSlackSuppression = null;
  const delivery = await runOncePerTerminal(ctx.env, ctx.dispatch, "loud", async () => {
    const session = await getSessionState(ctx.env, ctx.dispatch.sessionId).catch(() => null);
    slackSuppression = classifyLoudSlackSuppression(ctx.env, session);
    const ownerUserId = Number(session?.ownerUserId);
    const blockerKind = blockerKindForTerminal(record);
    if (blockerKind && slackSuppression !== "non_production" && Number.isSafeInteger(ownerUserId) && ownerUserId > 0) {
      userNotifyResult = await notifyUserBlocked(ctx.env, {
        sessionId: ctx.dispatch.sessionId,
        ownerUserId,
        callbackContext: session?.callbackContext ?? undefined,
        kind: blockerKind,
        dedupKey: terminalEffectDedupKey(ctx.dispatch, "loud"),
        prUrl: record.prUrl ?? undefined,
      });
    }
    if (slackSuppression === null) {
      const ownerUserLabel = await resolveInternalAlertOwnerLabel(ctx.env, session?.ownerUserId ?? null, {
        sessionId: ctx.dispatch.sessionId,
      });
      const alert = await postInternalAlert(
        ctx.env,
        REVIEW_LOOP_FEEDBACK_SLACK_CHANNEL,
        internalLoudText(ctx.env, ctx.dispatch, ownerUserLabel, session),
        undefined,
        {
          sessionId: ctx.dispatch.sessionId,
          ownerUserId: session?.ownerUserId ?? null,
          ownerUserLabel,
          fsmState: ctx.dispatch.to,
          reason: terminalReason(record),
        },
      );
      internalAlertPosted = alert?.ok ?? false;
    }
  });
  // Preserve the legacy verification-exhausted settle metric for the drain-only VERIFYING path.
  // It keeps its own terminal key so a loud dedup does not suppress D17 retry of the settle emit.
  if (record.blockedReason === "verification_run_limit") {
    await runOncePerTerminal(ctx.env, ctx.dispatch, "emit_settle", async () => {
      await emitFsmReviewLoopSettled(ctx.env, ctx.dispatch, {
        finalState: "verification-exhausted",
        scheduleReason: "fsm_verification_exhausted",
        capBlocked: true,
        whichCap: "verification_run",
      });
    }).catch((err) =>
      log.warn(
        { error: String(err) },
        "fsm live sink: exhaustion settle re-home failed (D17 retries within the window)",
      ),
    );
  }
  if (delivery === "deduped") return;
  await emitBestEffort(ctx, {
    event: "fsm.loud",
    ...effectTags(ctx.dispatch, ctx.effect.kind),
    fsm_event: ctx.dispatch.event.type,
    blocked_reason: record.blockedReason,
    failure_reason: record.failureReason,
    dedup_key: terminalEffectDedupKey(ctx.dispatch, "loud"),
    user_notify_result: userNotifyResult,
    internal_alert_posted: internalAlertPosted,
    slack_suppressed: slackSuppression,
  });
};

/** `emit_settle` — the settle telemetry effect (cascade row 7): re-home legacy `review_loop.settled`. */
const emitSettleExecutor: LiveSideEffectExecutor = async (ctx) => {
  const delivery = await runOncePerTerminal(ctx.env, ctx.dispatch, "emit_settle", async () => {
    await emitFsmReviewLoopSettled(ctx.env, ctx.dispatch, {
      finalState: "done",
      scheduleReason: "fsm_merge_ready",
      capBlocked: false,
      whichCap: null,
    });
  });
  if (delivery === "deduped") return;
  await emitBestEffort(ctx, {
    event: "fsm.settle",
    ...effectTags(ctx.dispatch, ctx.effect.kind),
    fsm_event: ctx.dispatch.event.type,
    dedup_key: terminalEffectDedupKey(ctx.dispatch, "emit_settle"),
  });
};

/** `emit_cap_trip` — the dedicated retunable-bound trip metric (Locked decision 5b): `{cap, limit}`. */
const emitCapTripExecutor: LiveSideEffectExecutor = async (ctx) => {
  await emitBestEffort(ctx, {
    event: "fsm.cap_trip",
    ...effectTags(ctx.dispatch, ctx.effect.kind),
    cap: ctx.effect.args?.cap ?? null,
    limit: ctx.effect.args?.limit ?? null,
  });
};

/**
 * The per-kind executor table — EXHAUSTIVE over `SideEffectKind` by construction (`src/` is
 * typechecked, so a future new kind is a tsc "missing property" break HERE, never a silently-dropped
 * effect at live). Inert entries each name the owning follow-up slice.
 */
const DEFAULT_EXECUTORS: Record<SideEffectKind, LiveSideEffectExecutor> = {
  // ── Genesis/codegen/transport arc — INERT (Wave-10 scope decision, held through PR 47: live
  //    authority is the POST-PUBLISH families only; the transport reducer keeps its decision
  //    authority — see transport-producer.ts `transportResolver`). Each logs a structured skip.
  spawn_sandbox: inertExecutor("genesis_arc_stays_legacy_driven"),
  dispatch_prompt: inertExecutor("genesis_arc_stays_legacy_driven"),
  open_pr: inertExecutor("genesis_arc_stays_legacy_driven"),

  // ── Post-publish surface — REAL in this slice ──
  kill_verification: killVerificationExecutor,
  // R4: reclaim a final-terminal session's runtime VM through the existing DO cleanup-run workflow.
  terminate_runtime: terminateRuntimeExecutor,
  spawn_verification_child: spawnVerificationChildExecutor,
  dispatch_epoch: dispatchEpochExecutor,
  project: projectExecutor,
  loud: loudExecutor,
  emit_settle: emitSettleExecutor,
  emit_cap_trip: emitCapTripExecutor,
  notify_user: notifyUserExecutor,
  notify_qa_issue: notifyQaIssueExecutor,

  // ── Deliberately-inert kinds, each with a named live owner (PR 47) ──
  // `disposition`: the authoritative live write is the epoch producer's `epochDispositionSink` —
  // composed at the ONE emitting seam that holds the epoch's owned source ids (this executor never
  // sees them, so making it real here would double-write or write nothing). Skip-logged for parity.
  disposition: inertExecutor("disposition_writes_owned_by_epoch_disposition_sink"),
  // `resolve_owned_threads`: GitHub thread resolution stays legacy-owned (the epoch publish path);
  // no FSM-side executor until the Section G folds re-home it.
  resolve_owned_threads: inertExecutor("thread_resolution_stays_legacy_owned"),
  // `release_queued_reviews`: legacy (+ the cron fallback) keeps epoch WORKLIST/dispatch authority for
  // webhook-arriving reviews in the Phase-B hybrid (D-53-as-deletion was cancelled), and those reviews
  // are ALSO ingested + dispatched by legacy on their own, so a GENERIC FSM `review.item_ready` drain
  // here would double-drive the same PR. The specific edges legacy does NOT cover ARM THE DRAIN directly
  // on their own transition instead — the verdict-return QA findings (`verification.app_breaks`, W11-V10)
  // and a settle that leaves undispositioned items (`epoch.settled`, ARC-1445) — and the self-heal sweep
  // (`reconcileUndispatchedReviewItems`) re-fires it for stranded stock. So this executor stays inert by
  // design, not pending a flip.
  release_queued_reviews: inertExecutor("queue_release_redundant_while_legacy_owns_dispatch"),

  // `log_noop` — the §8 sense-(ii) handled self-loop marker: nothing to execute.
  log_noop: async () => {},
};

// ── Transition-driven canonical label reconcile (W11) ─────────────────────────

/** Order-independent set equality over two managed-label projections (both are dup-free by design). */
function labelSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const label of a) {
    if (!setB.has(label)) return false;
  }
  return true;
}

/**
 * Transition-driven canonical PR-label sync (W11 — the cohort-exit immediacy fix). After a committed
 * transition, when the PURE projected managed-label set CHANGED (`labelsOf(priorRecord)` !=
 * `labelsOf(resultingRecord)`), dispatch the diff-based `syncFsmLabelsForPr` as an after-commit
 * best-effort effect so the label reaches the PR at the mint instant — closing the gap where the
 * MERGE_READY (row-7) / NEEDS_YOU mint drops the session out of the `review_listening` sweep cohort
 * (`phaseOf` = `completed`/`blocked`) at exactly the transition that changes its labels, so the sweep's
 * "guaranteed self-heal" reconcile never runs for that row.
 *
 * PURE decision, no GitHub read (the decision is projection-only; the WRITE is diff-based + idempotent):
 *   • No `priorRecord` (a D17 `repairDispatch` self-loop, or any dispatch without a prior image) → no-op;
 *     there is nothing to diff and the sweep's periodic reconcile owns that path.
 *   • No `prUrl` on the resulting record (pre-publish / OFF-user cohort) → no-op; there is no PR to label.
 *   • Identical projected label SETS (the high-frequency no-change transitions — e.g. `ci.signal`
 *     self-loops, or a `ci_fix_rounds`-only REVIEW→REVIEW step, since `labelsOf(REVIEW)` reads only
 *     `verdict`) → no-op; zero GitHub calls.
 *
 * The write reuses the canonical `syncFsmLabelsForPr` (re-reads the live spine row, reconciles the
 * managed namespace to exactly `labelsForPersistedRecord`), so it is idempotent with the sweep/webhook/
 * close-out writers — which all stay. `syncFsmLabelsForPr` never throws (fail-closed internally); the
 * extra try/catch is belt-and-suspenders so a fault here can never reject the post-commit run (the CAS
 * row stays committed — §8/inv 2).
 */
async function dispatchCanonicalLabelSync(env: Env, dispatch: SideEffectDispatch): Promise<void> {
  const priorRecord = dispatch.priorRecord;
  const record = dispatch.resultingRecord;
  const prUrl = record.prUrl;
  if (!prUrl) return;
  if (priorRecord) {
    let before: readonly string[];
    let after: readonly string[];
    try {
      before = labelsOf(priorRecord);
      after = labelsOf(record);
    } catch {
      // `labelsOf` is total over the FsmState union; a throw means a loose/unknown state — defensive only.
      return;
    }
    if (labelSetsEqual(before, after)) return;
  }
  // No `priorRecord` = a D17 `repairDispatch` redelivery (commit-before-dispatch crash left this
  // transition's effects owed). Those crashes hit exactly the cohort-exit mints this sync exists for
  // (MERGE_READY/NEEDS_YOU leave the sweep cohort — no self-heal), so with no before-image to compare
  // we dispatch unconditionally: the writer is diff-based/idempotent and repair traffic is rare, so a
  // no-change redelivery costs one listLabels and writes nothing (review P2 #6528).
  try {
    await syncFsmLabelsForPr(env, { prUrl, sessionId: dispatch.sessionId, logger: log });
  } catch (err) {
    log.warn(
      { sessionId: dispatch.sessionId, from: dispatch.from, to: dispatch.to, error: String(err) },
      "fsm live sink: transition-driven canonical label sync failed (isolated — commit stands; NOTE: at MERGE_READY/NEEDS_YOU the session has EXITED the review_listening sweep cohort, so there is no sweep retry — the label stays stale until a head-move re-enters REVIEW or the PR closes)",
    );
  }
}

// ── The live sink ─────────────────────────────────────────────────────────────

/**
 * Build the REAL bucket-b side-effect sink (PR 46). The bag executes CONCURRENTLY (DE-4) with
 * per-effect isolation: one throwing executor never blocks
 * the others; failures are logged + emitted as `fsm.sideeffect.failed` (best-effort), and the
 * already-committed CAS row is never rolled back (§8/inv 2 — the D17 cron reconciles own repair).
 *
 * ALONGSIDE the bag, the transition-driven canonical label reconcile runs (W11):
 * `dispatchCanonicalLabelSync` (PR labels). It is projection-decided, quiet on no-change transitions,
 * and isolated from the bag (a fault never blocks an effect). It is not a `SideEffectKind` — the
 * reducer does not emit it; it is derived purely from the committed before/after projection at the
 * sink seam, so it never widens the effect table.
 */
export function buildLiveSideEffectSink(env: Env, opts: LiveFsmSinkOptions = {}): FsmSideEffectSink {
  const now = opts.now ?? Date.now;
  const emit = opts.emit ?? postStructuredEventToDd;
  const executors: Record<SideEffectKind, LiveSideEffectExecutor> = { ...DEFAULT_EXECUTORS, ...opts.executors };
  return {
    dispatch(dispatch) {
      // The bag and the transition-driven label reconcile run concurrently + isolated: neither can be
      // rejected by the other (executeBag isolates per-effect; the sync is internally try/caught).
      const run = Promise.all([
        executeBag(env, dispatch, executors, now, emit),
        dispatchCanonicalLabelSync(env, dispatch),
      ]).then(() => undefined);
      if (opts.waitUntil) {
        // Hot-path seam: the webhook/DO response never awaits side-effect work.
        opts.waitUntil(run);
        return;
      }
      return run;
    },
  };
}

/**
 * Execute one committed bag: concurrent (DE-4), per-effect isolated, failures logged + emitted —
 * with the ONE ordering exception: `kill_verification` runs to completion FIRST. The VERIFYING
 * `head.changed` edge emits `kill_verification` + `spawn_verification_child` in a single bag; run
 * concurrently, the spawn can observe the superseded child still alive and be declined by the
 * `active_verification_session_exists` gate — dropping the re-run. Kill isolation still holds: a
 * FAILED kill is caught like any effect and the spawn still proceeds (the spawn gate then decides).
 */
async function executeBag(
  env: Env,
  dispatch: SideEffectDispatch,
  executors: Record<SideEffectKind, LiveSideEffectExecutor>,
  now: () => number,
  emit: FsmDdEmit,
): Promise<void> {
  const runOne = async (effect: SideEffect): Promise<void> => {
    const ctx: LiveSideEffectContext = { env, dispatch, effect, now, emit };
    try {
      await executors[effect.kind](ctx);
    } catch (err) {
      log.warn(
        { ...effectTags(dispatch, effect.kind), error: String(err) },
        "fsm live sink: side-effect executor failed (isolated — commit stands, D17 repair owns redelivery)",
      );
      try {
        await emit(env, { event: "fsm.sideeffect.failed", ...effectTags(dispatch, effect.kind), error: String(err) });
      } catch {
        // Best-effort telemetry: a failed failure-emit must never escalate.
      }
    }
  };

  const kills = dispatch.sideEffects.filter((effect) => effect.kind === "kill_verification");
  const rest = dispatch.sideEffects.filter((effect) => effect.kind !== "kill_verification");
  // Kill-before-spawn: teardown completes (isolated) before anything else observes child liveness.
  for (const effect of kills) {
    await runOne(effect);
  }
  await Promise.all(rest.map(runOne));
}

// ── The real worklist sink (bucket a, FG-5) ───────────────────────────────────

/**
 * Build the REAL bucket-a worklist sink: persist `WorklistRegistration`s (`register_review` /
 * `inject_findings`) as UNDISPOSITIONED (`disposition: "none"`) rows in the disposition store —
 * the single authoritative item set the `caught_up` conjunction reads (design §13).
 *
 * ORDERING (FG-5): `finishCommit` awaits this BEFORE taking the `caughtUpInputs` snapshot, so a
 * just-registered item is durable before any recompute reads the store — preserved, not re-implemented,
 * here. In SHADOW this sink still writes (registrations become durable ahead of the flip) but behavior
 * is unchanged: every shadow producer hard-floors its `caughtUpInputs` store, so the recompute never
 * consults these rows until live wiring reads the real snapshot.
 *
 * REGISTRATION NEVER REWINDS A TERMINAL STAMP: writes go through `registerDispositionsIfAbsent`
 * (INSERT-or-nothing), NOT `upsertDisposition` — a webhook-redelivered/re-ingested review re-registers
 * the SAME source id, and an unconditional upsert would flip a `fixed`/`replied`/`declined` row back
 * to `none`, wedging `caught_up` forever on an already-addressed item. A genuinely new review carries
 * a new source id and inserts normally; re-registering a still-`none` row is a no-op.
 *
 * BATCHING: every registration is validated before the write, then persisted with one D1 `batch()`
 * call. That preserves the fail-loud/no-partial-validation contract while avoiding one D1 round-trip
 * per review item on the finishCommit path.
 *
 * FAIL-LOUD: a failure THROWS out of `applyEvent` (the producer's try/catch isolates legacy). A
 * missing `pr_url` or a blank source id would otherwise silently advance state without registrations —
 * the exact gap that mints a premature MERGE_READY (or permanently wedges `caught_up`) — so both are
 * hard errors, never skips.
 */
export function buildLiveWorklistSink(env: Env, opts: { now?: () => number } = {}): FsmWorklistSink {
  const now = opts.now ?? Date.now;
  return {
    async commit(sessionId, version, registrations, record) {
      if (registrations.length === 0) return;
      const prUrl = record.prUrl;
      if (!prUrl) {
        throw new Error(
          `fsm worklist commit: session ${sessionId} v${version} carries registrations but no pr_url — ` +
            `refusing to advance without durable registrations (FG-5)`,
        );
      }
      for (const registration of registrations) {
        if (!registration.sourceId) {
          throw new Error(
            `fsm worklist commit: blank sourceId (origin=${registration.origin}) for session ${sessionId} ` +
              `v${version} — a blank registration would wedge caught_up forever`,
          );
        }
      }
      await registerDispositionsIfAbsent(
        env.DB,
        registrations.map((registration) => ({ sessionId, prUrl, sourceId: registration.sourceId })),
        now(),
      );
    },
  };
}

// ── Injection helpers ─────────────────────────────────────────────────────────

/**
 * The one-line injection helper the producer call sites spread into their `ApplyEventDeps`:
 * `{ ...liveFsmSinks(env) }` — the real bucket-b side-effect sink + the durable bucket-a worklist sink.
 */
export function liveFsmSinks(
  env: Env,
  opts: LiveFsmSinkOptions = {},
): Pick<ApplyEventDeps, "sideEffects" | "worklist" | "waitUntil"> {
  return {
    sideEffects: buildLiveSideEffectSink(env, opts),
    worklist: buildLiveWorklistSink(env, { now: opts.now }),
    // Thread the host seam onto ApplyEventDeps too (ChatGPT P2, #6414): apply-event's transition emit
    // reads `deps.waitUntil` to ride OFF the commit path — without this, every producer that spreads
    // `...liveFsmSinks(env, { waitUntil })` deferred its side-EFFECTS but still awaited the DD POSTs inline.
    waitUntil: opts.waitUntil,
  };
}

export interface StateDerivedSideEffectRepairResult {
  scanned: number;
  epochDispatchRedelivered: number;
  loudRedelivered: number;
  settleRedelivered: number;
}

export interface StateDerivedSideEffectRepairLogger {
  info?: (obj: Record<string, unknown>, msg: string) => void;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

function repairEventForRecord(record: PrCoordinationRecord): FsmEvent {
  const headSha = record.headSha ?? record.verificationRunHead ?? "unknown";
  if (record.state === "VERIFYING" || record.state === "MERGE_READY") {
    return { type: "caught_up", headSha };
  }
  if (record.inFlightEpochId) {
    return { type: "review.item_ready", itemId: record.inFlightEpochId };
  }
  return { type: "deadline_exceeded" };
}

function repairDispatch(record: PrCoordinationRecord, sideEffects: readonly SideEffect[]): SideEffectDispatch {
  const state = record.state as FsmState;
  return {
    sessionId: record.sessionId,
    version: record.version,
    from: state,
    to: state,
    event: repairEventForRecord(record),
    sideEffects,
    resultingRecord: record as FsmRecord,
  };
}

/**
 * The hard recency bound on the D17 TERMINAL loud/settle redelivery class (keystone review, PR 49):
 * only rows whose terminal entry is within this window are re-actioned. A few sweep intervals — long
 * enough to survive a crash-between-commit-and-dispatch plus one redelivery cycle, short enough that
 * shadow-era terminals (whose loud never ran and whose legacy DM dedup key differs) are NEVER
 * re-actioned at the first live sweep, and that the 24h loud-KV TTL can never roll a row back into
 * eligibility. The window, not the KV TTL, is the structural guard.
 */
export const D17_TERMINAL_REDELIVERY_WINDOW_MS = 30 * 60 * 1000;

/**
 * D17 side-effect redelivery: derive owed effects from committed state and re-dispatch through the
 * same version-keyed live sink. No outbox is written. The executors' anchors make this safe to call
 * repeatedly: epoch dispatch is keyed on `in_flight_epoch_id`, and loud/settle use per-terminal dedupe.
 * (A3: the transient arm no longer re-derives `spawn_verification_child` — the spawn rides the publish
 * edge, not VERIFYING entry.) The candidate scan is SPLIT (keystone review): transients (in-flight epoch)
 * are scanned without a time bound so a stranded row is always reachable — terminals never occupy that
 * window — while terminal loud/settle redelivery is recency-bounded by {@link D17_TERMINAL_REDELIVERY_WINDOW_MS}.
 */
export async function repairStateDerivedSideEffects(
  env: Env,
  opts: {
    limit?: number;
    sideEffects?: FsmSideEffectSink;
    waitUntil?: (promise: Promise<unknown>) => void;
    logger?: StateDerivedSideEffectRepairLogger;
    /** Defaults to {@link postStructuredEventToDd}; overridable for the redelivery-emit test. */
    emit?: FsmDdEmit;
  } = {},
): Promise<StateDerivedSideEffectRepairResult> {
  const result: StateDerivedSideEffectRepairResult = {
    scanned: 0,
    epochDispatchRedelivered: 0,
    loudRedelivered: 0,
    settleRedelivered: 0,
  };
  // Defensive: a sweep with an unbound/unusable DB never crashes the
  // reconcile — the cleaner just no-ops. `env.DB` is the durable candidate source; without it there is
  // nothing to re-derive from.
  const db = env.DB as D1Database | undefined;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return result;
  const limit = opts.limit ?? 100;
  const now = Date.now();
  // Best-effort: a candidate-list read fault (unbound/partial DB in a sweep) degrades the cleaner to a
  // no-op rather than crashing the sweep — the next tick re-derives. `env.DB` proved `prepare`-able above.
  let candidates: PrCoordinationRecord[];
  try {
    const [transients, terminals] = await Promise.all([
      listPrCoordinationTransientRepairCandidates(db, { limit }),
      listPrCoordinationTerminalRedeliveryCandidates(db, {
        limit,
        enteredSinceMs: now - D17_TERMINAL_REDELIVERY_WINDOW_MS,
      }),
    ]);
    candidates = [...transients, ...terminals];
  } catch (err) {
    (opts.logger?.warn ?? (() => {}))(
      { error: String(err) },
      "fsm cleaner: candidate-list read failed (ignored, best-effort)",
    );
    return result;
  }
  const sink = opts.sideEffects ?? buildLiveSideEffectSink(env, { waitUntil: opts.waitUntil });
  const emit = opts.emit ?? postStructuredEventToDd;
  const { getReviewLoopEpochById } = await import("../../services/review-loop-epochs");
  // ONE best-effort `fsm.sideeffect.redelivered` per re-dispatched kind so the flip dashboard can see
  // WHAT the reconciler re-drove (distinct from the executor's own act/skip event). Never throws.
  const emitRedelivered = async (record: PrCoordinationRecord, kind: SideEffectKind): Promise<void> => {
    try {
      await emit(env, {
        event: "fsm.sideeffect.redelivered",
        kind,
        session_id: record.sessionId,
        version: record.version,
        state: record.state,
        // N4 (keystone): repair dispatches synthesize `dispatch.event` for executor routing, so any
        // event name surfaced from a redelivery is honest-labeled here rather than masquerading as a
        // real transition trigger.
        redelivery: true,
      });
    } catch {
      // Best-effort telemetry: a failed redelivery-emit must never escalate.
    }
  };
  for (const record of candidates) {
    result.scanned += 1;
    try {
      const sideEffects: SideEffect[] = [];
      // A3: the VERIFYING spawn-redelivery arm is retired. The spawn now rides the `publish.pr_opened →
      // REVIEW` edge, so there is no VERIFYING-entry spawn to re-derive here; a dropped publish spawn is
      // non-fatal under non-blocking QA (the row still reaches MERGE_READY on green CI, and a stuck
      // verification run is caught by the run-scoped fireStuckVerificationBackstops).
      if (record.inFlightEpochId) {
        const epoch = await getReviewLoopEpochById(env.DB, record.inFlightEpochId).catch(() => null);
        // A committed `in_flight_epoch_id` with no epoch row is a crash-between-commit-and-create gap.
        // W11-V5 flips this from report-only to REAL re-dispatch: the same creating executor runs, so
        // the repair MATERIALIZES the missing epoch (traced to the disposition store, keyed to the
        // committed id → idempotent).
        if (!epoch) {
          // MINOR 4: the candidate SCAN can be stale by the time we re-dispatch. Re-read the CURRENT
          // committed record and only re-drive if the session is still an ACTIVE REVIEW row with the
          // same in-flight epoch id + head. The state check matters (Greptile P1, #6422):
          // `review_stuck`→NEEDS_YOU only writes blocked_reason — it does NOT clear in_flight_epoch_id —
          // so without it a session that raced REVIEW→NEEDS_YOU between scan and re-read would get an
          // epoch created + readied that the sweep then prompts against a blocked session.
          const fresh = await getPrCoordination(env.DB, record.sessionId).catch(() => null);
          if (
            !fresh ||
            fresh.state !== "REVIEW" ||
            fresh.inFlightEpochId !== record.inFlightEpochId ||
            fresh.headSha !== record.headSha
          ) {
            await emit(env, {
              event: "fsm.sideeffect.skipped",
              kind: "dispatch_epoch",
              reason: "repair_candidate_stale",
              session_id: record.sessionId,
              version: record.version,
            }).catch(() => undefined);
          } else if ((fresh.ciFixRounds ?? 0) > 0) {
            // The repair cannot recover the exact trigger from the committed marker. ciFixRounds > 0
            // is only a conservative indicator: a review dispatch may coexist with residual CI rounds.
            // Fail closed instead of risking review work being materialized as a CI retry.
            await emit(env, {
              event: "fsm.sideeffect.skipped",
              kind: "dispatch_epoch",
              reason: "repair_gap_possibly_ci_owned",
              session_id: record.sessionId,
              version: record.version,
            }).catch(() => undefined);
          } else {
            // Labelled `review` — a no-item gap degrades to the executor's own bare-trigger skip.
            sideEffects.push({ kind: "dispatch_epoch", args: { trigger: "review" } });
          }
        }
      }
      if (record.state === "NEEDS_YOU" || record.state === "FAILED") {
        sideEffects.push({ kind: "loud" });
      }
      if (record.state === "MERGE_READY") {
        sideEffects.push({ kind: "emit_settle" });
      }
      if (sideEffects.length === 0) continue;
      await sink.dispatch(repairDispatch(record, sideEffects));
      for (const effect of sideEffects) await emitRedelivered(record, effect.kind);
      // `dispatch_epoch` redelivery is now REAL (W11-V5): the creating executor materializes the missing
      // epoch from committed state (traced + id-keyed → idempotent). The tally + `fsm.sideeffect.redelivered`
      // above count what the reconciler actually re-drove; expect the skip/redelivery baselines to step
      // down on the W11-G1 dashboard as this collapses the `epoch_row_not_materialized_*` gap.
      if (sideEffects.some((effect) => effect.kind === "dispatch_epoch")) result.epochDispatchRedelivered += 1;
      if (sideEffects.some((effect) => effect.kind === "loud")) result.loudRedelivered += 1;
      if (sideEffects.some((effect) => effect.kind === "emit_settle")) result.settleRedelivered += 1;
    } catch (err) {
      opts.logger?.warn?.(
        { sessionId: record.sessionId, version: record.version, error: String(err) },
        "fsm D17 side-effect repair failed for candidate",
      );
    }
  }
  if (result.epochDispatchRedelivered > 0 || result.loudRedelivered > 0 || result.settleRedelivered > 0) {
    opts.logger?.info?.({ event: "fsm.d17.repair", ...result }, "FSM D17 side-effect repair redelivered effects");
  }
  return result;
}

/**
 * Fan one committed dispatch out to several sinks IN ORDER. Each sink is isolated: a failing sink is
 * logged + emitted as `fsm.sideeffect.sink_failed`, then the next sink still receives the committed
 * dispatch. Used where a site already injects its own special-purpose sink and must ALSO get the live
 * sink; bucket-b dispatches are post-commit, so a child sink fault must never drop sibling effects.
 */
export function combineSideEffectSinks(
  env: Env,
  sinks: readonly { name: string; sink: FsmSideEffectSink }[],
  opts: { emit?: FsmDdEmit } = {},
): FsmSideEffectSink {
  const emit = opts.emit ?? postStructuredEventToDd;
  return {
    async dispatch(dispatch) {
      for (const { name, sink } of sinks) {
        try {
          await sink.dispatch(dispatch);
        } catch (err) {
          log.warn(
            {
              sink: name,
              sessionId: dispatch.sessionId,
              version: dispatch.version,
              from: dispatch.from,
              to: dispatch.to,
              sideEffectKinds: dispatch.sideEffects.map((effect) => effect.kind),
              error: String(err),
            },
            "fsm live sink: composed side-effect sink failed (isolated — sibling sinks still run)",
          );
          try {
            await emit(env, {
              event: "fsm.sideeffect.sink_failed",
              sink: name,
              session_id: dispatch.sessionId,
              version: dispatch.version,
              from: dispatch.from,
              to: dispatch.to,
              side_effect_kinds: dispatch.sideEffects.map((effect) => effect.kind),
              error: String(err),
            });
          } catch {
            // Best-effort telemetry: a failed failure-emit must never escalate.
          }
        }
      }
    },
  };
}

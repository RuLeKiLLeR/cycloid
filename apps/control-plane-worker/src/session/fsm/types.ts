// ARC-1330 lifecycle FSM — the type contract for the whole FSM stack.
//
// PURE TYPES + completeness assertions. No transition logic, no I/O, no runtime
// behavior beyond the const arrays the rest of the stack enumerates over. Later
// waves (the `applyEvent` spine, the dispatch table, the projector) import these
// closed enums and the discriminated `FsmEvent`/`EventMetadata` unions; getting
// the completeness EXACTLY right here is what keeps a missing variant a one-line
// tsc break in THIS file instead of a silent gap 12 PRs downstream.
//
// The static type-level assertions at the bottom are the real guarantee: `tests/`
// is not typechecked by the repo, but `src/` IS (worker tsconfig), so the
// `Record<FsmEventType, true>` / `Record<FsmState, true>` presence literals and the
// mutual-assignability checks fail the worker `tsc --noEmit` the instant a union
// gains or loses a variant without the array/metadata being updated in lockstep.

import type { ErrorCode } from "../../../../../shared/types/sandbox.js";
import type { PrCoordinationRecord, PrCoordinationUpdate } from "../pr-coordination-db";

// ── (a) States — exactly 17 ──────────────────────────────────────────────────
// The design's conceptual `QA` state is named `VERIFYING` here; the two review
// states (CI + code review) are already collapsed into a single `REVIEW`.
// The state/reason unions are canonically declared in shared/ (the lifecycle
// chip vocabulary consumes them on both sides of the API); re-exported here so
// every FSM-internal import keeps its `./types` path and the presence pins
// below still enforce totality against the shared union.
export type { BlockedReason, FailureReason, FsmState } from "../../../../../shared/session/lifecycle-chip.js";
export { FSM_STATES } from "../../../../../shared/session/lifecycle-chip.js";
import type { BlockedReason, FailureReason, FsmState } from "../../../../../shared/session/lifecycle-chip.js";

// ── (b) Closed enums (string unions) ─────────────────────────────────────────
export type Verdict = "pass" | "app_breaks" | "skipped" | "none";

export type StopMode = "user" | "resumable";

export type ReviewerKind = "bot" | "human";

// The ci.signal event payload. `pending` is a live-read guard (reduceCiState can
// still emit it into EventMetadata), never an event state — so it is excluded here.
export type CiSignalState = "green" | "failing" | "absent";

// The spine `epoch.blocked` reasons that route REVIEW → NEEDS_YOU. `owner_approval` (the human-gate
// path) and `response_failed` (ARC-1330: an agent fix/reply POST that failed past its retry cap — the
// one give-up the caught_up cascade cannot re-derive from ground truth). Benign / cascade-derivable
// blocks (head_changed, CI-cap, not-this-session, …) emit `epoch.settled` instead, never epoch.blocked.
export type EpochBlockReason = "owner_approval" | "response_failed";

// Extensible; the two epoch trigger kinds today.
export type EpochTrigger = "ci_fix" | "review";

// The two `epoch.deferred` deferral kinds (W11-V5). A dispatch tick for an in-flight epoch could not
// proceed and re-observes it next tick: `contention` = a not-ready precondition (verification in
// progress, CI/mergeability pending, head lagging); `transient` = a transient GitHub-poll failure.
// A deferral is NEVER a state change — the epoch stays in-flight and the §10 REVIEW deadline is the
// give-up (SF10). The spine records it as a `log_noop` self-loop purely so the deferral is journaled
// on the spine (D-53 then removes the legacy `pr_review_response_epochs` lease-defer counters).
export type EpochDeferralKind = "contention" | "transient";

// The per-item disposition recorded on the worklist (design §13 — the disposition store
// finalized PR 22). `none` = registered-but-undispositioned actionable (the state
// `register_review`/`inject_findings` write); `fixed`/`replied`/`declined` are the terminal
// dispositions an epoch stamps; `no_action_needed_informational` is the terminal stamp the
// worklist noise gate (D4) applies to a known bot's purely-informational "no findings" output so
// it is counted as handled without ever being prompted. `caught_up` requires every actionable item
// NOT `none` — the terminal stamps (including informational) all settle it.
export type Disposition = "none" | "fixed" | "replied" | "declined" | "no_action_needed_informational";

export type EventActor = "transport" | "webhook" | "verification" | "cron" | "user" | "internal";

// ── (c) FsmEvent — discriminated union on `type`.
// Every design §5 event EXCEPT `qa.requested(obs)`, which is observability-only and
// intentionally NOT modeled as an FsmEvent.
//
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export type FsmEvent =
  | { type: "sandbox.spawn_requested" }
  | { type: "sandbox.ready" }
  | { type: "sandbox.spawn_failed" }
  | { type: "sandbox.death" }
  | { type: "sandbox.liveness_expired" }
  | { type: "prompt.enqueued" }
  | { type: "prompt.awaiting_input" }
  // `errorCode` + `stoppedByUser` ride the `{error}` outcome only: the transport carries the reducer's
  // terminal code AND the DO's stop corroboration through so the transition can tell a genuine user
  // stop ("aborted" + stoppedByUser → quiet STOPPED) from a codegen failure (→ loud FAILED). The bridge
  // overloads "aborted" (classifyError text-matches, external session deletes, failsafe aborts), so the
  // code alone is NOT trusted; absent fields = not a stop (timeouts, crashes, legacy emitters).
  | {
      type: "prompt.terminal";
      outcome: "changes" | "no_changes" | "error";
      errorCode?: ErrorCode | null;
      stoppedByUser?: boolean;
    }
  | { type: "prompt.max_duration_exceeded" }
  | { type: "postexec.done"; hasChanges: boolean; promptIntendsChange: boolean }
  | { type: "publish.pr_opened"; prHead: string }
  | { type: "publish.no_changes" }
  | { type: "publish.failed" }
  // Benign publish supersede (ARC-1389): a review-loop epoch publish was overtaken (head moved / the
  // session moved on) while the PR stays open — routes to the neutral SUPERSEDED terminal.
  | { type: "publish.superseded" }
  | { type: "user.input" }
  | { type: "user.stop" }
  | { type: "user.retrigger" }
  | { type: "session.archived" }
  | { type: "ci.signal"; ciState: CiSignalState }
  | { type: "review.received"; reviewerKind: ReviewerKind; actionable: boolean }
  | { type: "review.item_ready"; itemId: string }
  | { type: "epoch.committed"; epochId: string }
  | { type: "epoch.replied"; epochId: string }
  | { type: "epoch.declined"; epochId: string }
  | { type: "epoch.blocked"; epochId: string; reason: EpochBlockReason; trigger: EpochTrigger }
  | { type: "epoch.deferred"; epochId: string; deferralKind: EpochDeferralKind }
  // No-actionable-work epoch settle (ARC-1330): a review-loop epoch finalized with nothing to
  // commit/reply/decline (a bot-wait fallback drain or a benign block). Clears `in_flight_epoch_id`
  // ONLY — a REVIEW self-loop with no disposition/head/owner write — so `no_inflight_epoch` re-opens
  // and the `caught_up` cascade can re-derive the outcome. The missing terminal that stranded the
  // marker and wedged post-publish REVIEW.
  | { type: "epoch.settled"; epochId: string }
  | { type: "caught_up"; headSha: string }
  // TODO(qa-rename, ARC-1330): verification.* events keep the verification name — see the marker above.
  | { type: "verification.pass"; headSha: string; runId: number }
  | { type: "verification.app_breaks"; headSha: string; runId: number }
  | { type: "verification.skipped"; headSha: string; runId: number }
  | { type: "verification.stopped"; runId: number }
  | { type: "verification.failed"; runId: number }
  | { type: "verification.run_limit"; runId: number }
  // `force` marks a manual "Verify" button request that must SUPERSEDE an in-flight verifier for the
  // same PR (tear down the active run's child and admit a fresh run) rather than reuse it. Absent/false
  // keeps the reuse semantics: a `verification.requested` while already VERIFYING stays unhandled.
  // `bypassRunLimitForMergeConflict` is reserved for coordinated manual QA after the coordinator has
  // confirmed the PR is merge-conflicted; ordinary requests still honor the run cap.
  | { type: "verification.requested"; headSha: string; force?: boolean; bypassRunLimitForMergeConflict?: boolean }
  | { type: "head.changed"; headSha: string }
  | { type: "head.noop_changed"; headSha: string }
  | { type: "pr.merged" }
  | { type: "pr.closed" }
  | { type: "deadline_exceeded" };

export type FsmEventType = FsmEvent["type"];

// Runtime list of every FsmEvent `type` string. Consumed by the const-completeness
// test (PR 4) and the dispatch table (PR 19). The `satisfies` keeps it pinned to
// the union; the EVENT_TYPE_PRESENCE literal below proves it is also EXHAUSTIVE.
export const FSM_EVENT_TYPES = [
  "sandbox.spawn_requested",
  "sandbox.ready",
  "sandbox.spawn_failed",
  "sandbox.death",
  "sandbox.liveness_expired",
  "prompt.enqueued",
  "prompt.awaiting_input",
  "prompt.terminal",
  "prompt.max_duration_exceeded",
  "postexec.done",
  "publish.pr_opened",
  "publish.no_changes",
  "publish.failed",
  "publish.superseded",
  "user.input",
  "user.stop",
  "user.retrigger",
  "session.archived",
  "ci.signal",
  "review.received",
  "review.item_ready",
  "epoch.committed",
  "epoch.replied",
  "epoch.declined",
  "epoch.blocked",
  "epoch.deferred",
  "epoch.settled",
  "caught_up",
  "verification.pass",
  "verification.app_breaks",
  "verification.skipped",
  "verification.stopped",
  "verification.failed",
  "verification.run_limit",
  "verification.requested",
  "head.changed",
  "head.noop_changed",
  "pr.merged",
  "pr.closed",
  "deadline_exceeded",
] as const satisfies readonly FsmEventType[];

// ── (d) EventMetadata — discriminated union, one variant per FsmEvent (39) ────
// Observability-only (design §18.2). NEVER read by a guard — Invariant O1. Same
// `type` discriminator strings as FsmEvent; load-bearing variants carry the
// documented payload, the rest are minimal `{ type }`. There is NO metadata
// variant for qa.requested (it is not an FsmEvent).
export type EventMetadata =
  | { type: "sandbox.spawn_requested" }
  | { type: "sandbox.ready" }
  | { type: "sandbox.spawn_failed" }
  | { type: "sandbox.death" }
  | { type: "sandbox.liveness_expired" }
  | { type: "prompt.enqueued" }
  | { type: "prompt.awaiting_input" }
  | {
      type: "prompt.terminal";
      outcome: "changes" | "no_changes" | "error";
      errorCode?: ErrorCode | null;
      stoppedByUser?: boolean;
    }
  | { type: "prompt.max_duration_exceeded" }
  | { type: "postexec.done"; hasChanges: boolean; promptIntendsChange: boolean }
  | {
      type: "publish.pr_opened";
      /** Publish-time snapshot used for observability and merged-LOC reporting. */
      diffStats?: { insertions: number; deletions: number };
    }
  | { type: "publish.no_changes" }
  | { type: "publish.failed" }
  // Benign publish supersede (ARC-1389): a review-loop epoch publish was overtaken (head moved / the
  // session moved on) while the PR stays open — routes to the neutral SUPERSEDED terminal.
  | { type: "publish.superseded" }
  | { type: "user.input" }
  | { type: "user.stop" }
  | { type: "user.retrigger" }
  | { type: "session.archived" }
  // reduceCiState is 4-valued in metadata (incl. the live-read `pending` guard).
  | { type: "ci.signal"; ciState: "green" | "failing" | "absent" | "pending" }
  | {
      type: "review.received";
      reviewerKind: ReviewerKind;
      reviewerId: string;
      reviewSourceId: string;
      actionable: boolean;
    }
  | { type: "review.item_ready" }
  | {
      type: "epoch.committed";
      epochId: string;
      epochTrigger: EpochTrigger;
      sourceIds: string[];
      headBefore: string | null;
      headAfter: string | null;
      disposition: string | null;
    }
  | {
      type: "epoch.replied";
      epochId: string;
      epochTrigger: EpochTrigger;
      sourceIds: string[];
      headBefore: string | null;
      headAfter: string | null;
      disposition: string | null;
    }
  | {
      type: "epoch.declined";
      epochId: string;
      epochTrigger: EpochTrigger;
      sourceIds: string[];
      headBefore: string | null;
      headAfter: string | null;
      disposition: string | null;
    }
  | {
      type: "epoch.blocked";
      epochId: string;
      reason: EpochBlockReason;
      epochTrigger: EpochTrigger;
      sourceIds: string[];
      headBefore: string | null;
      headAfter: string | null;
      disposition: string | null;
    }
  | { type: "epoch.deferred"; epochId: string; deferralKind: EpochDeferralKind; reason: string }
  | {
      type: "epoch.settled";
      epochId: string;
      epochTrigger: EpochTrigger;
      sourceIds: string[];
      headBefore: string | null;
      headAfter: string | null;
      disposition: string | null;
    }
  | { type: "caught_up" }
  | { type: "verification.pass"; verificationRunId: number; verdict: Verdict; headSha: string | null }
  | { type: "verification.app_breaks"; verificationRunId: number; verdict: Verdict; headSha: string | null }
  | { type: "verification.skipped"; verificationRunId: number; verdict: Verdict; headSha: string | null }
  | { type: "verification.stopped"; verificationRunId: number; verdict: Verdict; headSha: string | null }
  | { type: "verification.failed"; verificationRunId: number; verdict: Verdict; headSha: string | null }
  | { type: "verification.run_limit"; verificationRunId: number; verdict: Verdict; headSha: string | null }
  | { type: "verification.requested"; headSha: string; force?: boolean; bypassRunLimitForMergeConflict?: boolean }
  | { type: "head.changed"; headSha: string; prevHeadSha: string | null }
  | { type: "head.noop_changed"; headSha: string; prevHeadSha: string | null }
  | { type: "pr.merged" }
  | { type: "pr.closed" }
  | { type: "deadline_exceeded" };

export type EventMetadataType = EventMetadata["type"];

// Runtime list of every EventMetadata `type` string. Kept in lockstep with the
// union (and, via the assertions below, proven equal to FSM_EVENT_TYPES as a set).
export const EVENT_METADATA_TYPES = [
  "sandbox.spawn_requested",
  "sandbox.ready",
  "sandbox.spawn_failed",
  "sandbox.death",
  "sandbox.liveness_expired",
  "prompt.enqueued",
  "prompt.awaiting_input",
  "prompt.terminal",
  "prompt.max_duration_exceeded",
  "postexec.done",
  "publish.pr_opened",
  "publish.no_changes",
  "publish.failed",
  "publish.superseded",
  "user.input",
  "user.stop",
  "user.retrigger",
  "session.archived",
  "ci.signal",
  "review.received",
  "review.item_ready",
  "epoch.committed",
  "epoch.replied",
  "epoch.declined",
  "epoch.blocked",
  "epoch.deferred",
  "epoch.settled",
  "caught_up",
  "verification.pass",
  "verification.app_breaks",
  "verification.skipped",
  "verification.stopped",
  "verification.failed",
  "verification.run_limit",
  "verification.requested",
  "head.changed",
  "head.noop_changed",
  "pr.merged",
  "pr.closed",
  "deadline_exceeded",
] as const satisfies readonly EventMetadataType[];

// ── (e) FsmRecord + FsmFieldWrites + Decision ────────────────────────────────
// Refine the loosely-typed (string) enum fields of the PR-2 persistence row into
// the FSM's closed enums. Everything else rides through unchanged.
export type FsmRecord = Omit<
  PrCoordinationRecord,
  "state" | "verdict" | "blockedReason" | "failureReason" | "stopMode" | "preStopState"
> & {
  state: FsmState;
  verdict: Verdict | null;
  blockedReason: BlockedReason | null;
  failureReason: FailureReason | null;
  stopMode: StopMode | null;
  preStopState: FsmState | null;
};

// Fields a Decision may write (everything except the key and the CAS-owned version).
// `state` is intentionally omitted: `Decision.to` is the single source of truth for the next
// state. Letting fieldWrites also carry `state` would give the spine two ways to set the column
// and allow a silent `to=FAILED` / `fieldWrites.state=REVIEW` divergence the compiler can't catch.
export type FsmFieldWrites = Partial<Omit<FsmRecord, "sessionId" | "version" | "state">>;

// Side effects (design §7 bucket b). Minimal extensible skeleton — later PRs refine
// the per-kind `args` shapes; today they ride as an opaque readonly bag.
export type SideEffectKind =
  | "spawn_sandbox"
  | "dispatch_prompt"
  | "open_pr"
  | "kill_verification"
  // `terminate_runtime` (R4) — reclaim the session's runtime VM on a FINAL terminal
  // (MERGED/CLOSED/SUPERSEDED/ARCHIVED) instead of parking it paused for 72h. Carries no args:
  // the executor resolves the session's own runtime projection (id + backend) and drives the
  // EXISTING DO cleanup-run workflow (reason `session_terminal`). NOT emitted on `user.stop →
  // STOPPED` — STOPPED stays resumable.
  | "terminate_runtime"
  | "spawn_verification_child"
  | "dispatch_epoch"
  | "disposition"
  | "resolve_owned_threads"
  | "release_queued_reviews"
  | "emit_settle"
  // `notify_user` — the happy-path user-facing "merge-ready" ping, distinct from `loud()`
  // (`notify_user + notify_arcdev + emit_dd`, the NEEDS_YOU/FAILED alert). Cascade row 7 carries
  // it alongside `emit_settle` (design §9 row 7: `/ reset_ci_fix_rounds, emit_settle, notify_user`).
  | "notify_user"
  // `notify_qa_issue` — a NON-BLOCKING QA-issue DM (verification came back run_limit/stopped/failed on a
  // fresh run). Rides notifyUserBlocked's DM transport but sets NO blocked_reason and fires NO loud/ops
  // fanout — the session stays in its current state (a self-loop), verification is off-gate.
  | "notify_qa_issue"
  | "loud"
  // `emit_cap_trip` — a DEDICATED cap-trip count metric, distinct from `loud()`'s generic `emit_dd`
  // (tech-spec Locked decision 5b). Raised alongside `loud` on a cap-trip terminal (today: the §17-D
  // `MAX_MERGE_READY_REOPENS` flap → `NEEDS_YOU{ci_flapping}`) so the bound can be retuned post-shadow
  // from the trip rate. Carries `{ cap, limit }`; the Section E spine (PR 34) emits it as a count metric.
  | "emit_cap_trip"
  | "project"
  | "log_noop";

export interface SideEffect {
  kind: SideEffectKind;
  args?: Readonly<Record<string, unknown>>;
}

// Committed-bucket (a) worklist registration (design §7 bucket a / §6 ordering / FG-5). A
// freshly-received review (`register_review`) or an injected `app_breaks` finding
// (`inject_findings`) is recorded as an UNDISPOSITIONED actionable item on the disposition-store
// worklist (finalized PR 22). Unlike a `SideEffect` (bucket b, run AFTER commit), these are
// committed in the SAME CAS as the entering transition's `fieldWrites` — durable BEFORE the
// separate `caught_up` recompute reads the worklist — so a just-injected finding can't be missed
// (SF16) and a re-opened review can't bounce straight to `MERGE_READY` (Defect 3 / B6).
export interface WorklistRegistration {
  /** Disposition-store key: the review's source id, or an injected finding's source id. */
  sourceId: string;
  /** Provenance (basis column): a received review vs an injected app_breaks finding. */
  origin: "review" | "findings";
  /** Always "none" at registration: a freshly-registered item is undispositioned actionable. */
  disposition: Extract<Disposition, "none">;
}

export interface Decision {
  to: FsmState;
  fieldWrites: FsmFieldWrites;
  sideEffects: readonly SideEffect[];
  /**
   * Committed bucket (a): worklist registrations made durable in the SAME CAS as `fieldWrites`,
   * BEFORE the separate `caught_up` recompute reads the worklist (design §6/§7, FG-5). These are
   * NOT deferred `sideEffects` (bucket b). Optional/absent on edges that register nothing.
   */
  worklistRegistrations?: readonly WorklistRegistration[];
}

// ── (f) Static type-level completeness assertions (compiled, not exported) ────
// `src/` IS typechecked by the worker tsconfig, so these fail `tsc --noEmit` the
// instant a union and its mirror array/metadata drift apart. `tests/` is NOT
// typechecked, so these — not the vitest file — are the real completeness proof.
// Kept un-exported + `_`-prefixed so they compile, satisfy no-unused-vars, and
// tree-shake out of the build.

// A Decision's writes must ride the PR-2 CAS (`casUpdatePrCoordination`) — prove
// FsmFieldWrites is assignable to PrCoordinationUpdate. Compile-only.
const _fieldWritesRideCas: PrCoordinationUpdate = {} as FsmFieldWrites;
void _fieldWritesRideCas;

// Exhaustiveness: every FsmEventType is a key (missing one → "missing property"),
// and nothing extra is allowed (extra key → "not assignable"). Either drift fails tsc.
const _EVENT_TYPE_PRESENCE: Record<FsmEventType, true> = {
  "sandbox.spawn_requested": true,
  "sandbox.ready": true,
  "sandbox.spawn_failed": true,
  "sandbox.death": true,
  "sandbox.liveness_expired": true,
  "prompt.enqueued": true,
  "prompt.awaiting_input": true,
  "prompt.terminal": true,
  "prompt.max_duration_exceeded": true,
  "postexec.done": true,
  "publish.pr_opened": true,
  "publish.no_changes": true,
  "publish.failed": true,
  "publish.superseded": true,
  "user.input": true,
  "user.stop": true,
  "user.retrigger": true,
  "session.archived": true,
  "ci.signal": true,
  "review.received": true,
  "review.item_ready": true,
  "epoch.committed": true,
  "epoch.replied": true,
  "epoch.declined": true,
  "epoch.blocked": true,
  "epoch.deferred": true,
  "epoch.settled": true,
  caught_up: true,
  "verification.pass": true,
  "verification.app_breaks": true,
  "verification.skipped": true,
  "verification.stopped": true,
  "verification.failed": true,
  "verification.run_limit": true,
  "verification.requested": true,
  "head.changed": true,
  "head.noop_changed": true,
  "pr.merged": true,
  "pr.closed": true,
  deadline_exceeded: true,
};
void _EVENT_TYPE_PRESENCE;

// Every FsmState is a key (and nothing extra) — pins the 17 states the same way.
const _STATE_PRESENCE: Record<FsmState, true> = {
  CREATED: true,
  PROVISIONING: true,
  GENERATING: true,
  AWAITING_INPUT: true,
  FINALIZING: true,
  PUBLISHING: true,
  ANSWERED_NO_PR: true,
  REVIEW: true,
  VERIFYING: true,
  MERGE_READY: true,
  NEEDS_YOU: true,
  FAILED: true,
  STOPPED: true,
  MERGED: true,
  CLOSED: true,
  SUPERSEDED: true,
  ARCHIVED: true,
};
void _STATE_PRESENCE;

// EventMetadataType and FsmEventType must be the SAME set (one metadata variant per
// event). Two-way assignability proves neither side has an extra `type`.
const _metaTypeIsEventType: FsmEventType = null as unknown as EventMetadataType;
void _metaTypeIsEventType;
const _eventTypeIsMetaType: EventMetadataType = null as unknown as FsmEventType;
void _eventTypeIsMetaType;

// Per-business realtime sidebar feed protocol (ARC-1322).
//
// The session sidebar subscribes to an always-on, business-scoped WebSocket
// (`SessionFeedDO`, keyed by `businessId`). Every list-relevant mutation
// publishes a compact `FeedDelta` to that feed, which fans it out to the
// subscribed sidebar sockets — gated per recipient by repo access.
//
// This is the single contract shared by the publisher, the feed Durable
// Object, the `/api/users/me/feed/ws` route, and the frontend reducer. It is a
// *separate* channel from the per-session `ServerMessage` protocol in
// `apps/control-plane-worker/src/ws/types.ts`; do not conflate the two.

import type { DisplayStatus } from "../session/display-status.js";
import type { UiLifecycleStage } from "../session/lifecycle-stage.js";
import type {
  CycloidDoneOutcome,
  CycloidDoneReason,
  CycloidDoneState,
  FinalizingStep,
  Phase,
  ReviewLoopDoneState,
  SandboxSubstate,
  StopMode,
  VerificationResult,
  VerificationState,
} from "../session/phase.js";

/**
 * The full sidebar-row payload carried by a `session_upserted` delta. This is
 * the exact JSON the session-list endpoint emits (the output of the control
 * plane's `toSessionApiShape`), so a feed row is byte-identical to a list row
 * and the frontend can run it through the same `normalizeSessionMetadata`
 * adapter it already applies to fetched rows.
 *
 * Enum-ish fields are intentionally widened to `string` here: this shape is
 * assigned directly from `toSessionApiShape`'s inferred (narrower) output on
 * the worker, and re-narrowed by the frontend normalizer on receipt. Keeping it
 * permissive guarantees the worker-side assignment compiles without coupling
 * this shared module to every worker enum.
 */
export interface FeedSessionRow {
  sessionId: string;
  ownerUserId: string;
  businessId: string | null;
  phase: string;
  displayStatus?: DisplayStatus;
  status: string;
  uiLifecycleStage?: UiLifecycleStage;
  createdAt: string | number;
  updatedAt?: string;
  closedAt?: string | null;
  lastEventId?: string | null;
  title: string | null;
  prUrl: string | null;
  prDraft?: boolean;
  publishStatus?: string;
  publishError?: string | null;
  publishedBranch?: string | null;
  model?: string | null;
  desktopActionPathAvailable?: boolean;
  reasoningEffort?: string;
  ownerLogin?: string;
  ownerAvatarUrl?: string;
  repoOwner?: string;
  repoName?: string;
  parentSessionId?: string;
  spawnDepth?: number;
  initiationMode?: string;
  entrypoint?: PersistedSessionEntrypoint | null;
  scheduledRuleId?: string;
  ruleNameSnapshot?: string;
  cronSnapshot?: string;
  reviewLoopDoneState?: string;
  cycloidDoneState?: string;
  cycloidDoneOutcome?: string;
  cycloidDoneReasons?: string[];
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  verificationState?: string;
  verificationAttemptCount?: number;
  verificationMaxAttempts?: number;
}

/**
 * Fields present on every `FeedDelta` variant. `ownerUserId` / `repoOwner` /
 * `repoName` are the keys the feed DO's repo-access gate
 * (`decideFeedDelivery`) reads to decide per-recipient delivery; `source`
 * tags the originating mutation site for tracing.
 */
export interface FeedDeltaBase {
  /** The session this delta describes. */
  sessionId: string;
  /** The session owner's user id (string form). Owners always receive their own deltas. */
  ownerUserId: string;
  /** Repo owner for gating cross-member delivery; null when repo context is unknown. */
  repoOwner: string | null;
  /** Repo name for gating cross-member delivery; null when repo context is unknown. */
  repoName: string | null;
  /** Originating mutation site, e.g. "session-create", "status:alarm", "pr". */
  source: string;
}

/** A new or updated session row (sidebar insert-or-replace). */
export type FeedSessionUpsertedDelta = FeedDeltaBase & {
  type: "session_upserted";
  session: FeedSessionRow;
};

/** A phase / lifecycle transition (including alarm-driven terminal flips). */
export type FeedSessionStatusDelta = FeedDeltaBase & {
  type: "session_status";
  phase: Phase;
  displayStatus?: DisplayStatus;
  uiLifecycleStage?: UiLifecycleStage;
  sandboxSubstate?: SandboxSubstate | null;
  stopMode?: StopMode | null;
  // Live-idle "kept alive after a user stop" flag; see session-websocket.ts.
  userStopped?: boolean;
  finalizingStep?: FinalizingStep | null;
  title?: string | null;
};

/** A PR created / updated / blocked transition. */
export type FeedPrDelta = FeedDeltaBase & {
  type: "pr";
  prUrl: string | null;
  prDraft?: boolean | null;
  prManualReviewReason?: string | null;
};

/** A verification / done-state transition (sidebar badge signals). */
export type FeedVerificationDelta = FeedDeltaBase & {
  type: "verification";
  phase?: Phase;
  displayStatus?: DisplayStatus;
  reviewLoopDoneState?: ReviewLoopDoneState | null;
  cycloidDoneState?: CycloidDoneState | null;
  cycloidDoneOutcome?: CycloidDoneOutcome | null;
  cycloidDoneReasons?: CycloidDoneReason[] | null;
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  verificationState?: VerificationState | null;
  verificationResult?: VerificationResult | null;
};

/** A session close / delete. */
export type FeedSessionClosedDelta = FeedDeltaBase & {
  type: "session_closed";
  phase: Phase;
  displayStatus?: DisplayStatus;
  closeReason?: string | null;
};

export type FeedDelta =
  FeedSessionUpsertedDelta | FeedSessionStatusDelta | FeedPrDelta | FeedVerificationDelta | FeedSessionClosedDelta;

/** An `Omit` that distributes over a union, preserving each member's discriminant-specific fields. */
export type DistributiveOmit<T, K extends keyof FeedDeltaBase> = T extends unknown ? Omit<T, K> : never;

/**
 * A `FeedDelta` as constructed at a Durable-Object mutation site, before the
 * repo-access gate envelope (`ownerUserId` / `repoOwner` / `repoName`) is
 * resolved from the session's stored row. `publishSessionFeedDelta` fills those
 * in from `doDb` so a site only supplies `sessionId`, `source`, and the
 * type-specific payload.
 */
export type FeedDeltaInput = DistributiveOmit<FeedDelta, "ownerUserId" | "repoOwner" | "repoName">;
import type { PersistedSessionEntrypoint } from "./session-entrypoint.js";

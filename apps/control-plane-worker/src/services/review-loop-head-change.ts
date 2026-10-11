import type { Logger } from "../logger";
import { getPrCoordination } from "../session/pr-coordination-db";
import {
  carryForwardMentionEpochsToNewHead,
  carryForwardReviewLoopEpochsToNewHead,
  carryForwardTruncatedTailEpochsToNewHead,
  markReviewLoopEpochsStaleForHeadChange,
} from "./review-loop-epochs";
import { hasSucceededReviewLoopPushToHead } from "./review-loop-operations";

/**
 * How far back a recorded succeeded push may lie and still prove a `synchronize` advance is the
 * session's own push. Generous vs the real gap (record → push → webhook is seconds), tight vs the
 * foreign-reset-to-former-own-tip case it exists to exclude.
 */
const SELF_PUSH_PROOF_WINDOW_MS = 10 * 60 * 1000;

export interface ReviewLoopHeadChangeEpochResult {
  /** Non-terminal epochs re-keyed from the previous head onto the new head. */
  carriedForward: number;
  /** Non-terminal epochs blocked as `head_changed` (no carry-forward applied). */
  staleBlocked: number;
  /**
   * Budget-truncated-tail epochs (ARC-1244) re-keyed off the stale-block onto the new head as a
   * re-driveable `ready` epoch (or, at the no-progress cap, blocked/worklist_truncation_unresolved)
   * so the un-prompted carried tail drains without a fresh bot signal. Distinct from `carriedForward`
   * (the own-base-merge carry-forward) — this happens on the foreign-push stale-block path.
   */
  truncatedRekeyed: number;
  /**
   * Non-terminal `mention` epochs (`@cycloid …`) re-keyed off the stale-block onto the new head. A
   * mention is a head-agnostic user instruction, so a head change must not drop a pending one — it is
   * carried forward and dispatched/replied on the new head instead of being stale-blocked. Only fires on
   * the foreign-push path; the own-base-merge carry-forward already re-keys mentions into `carriedForward`.
   */
  mentionRekeyed: number;
}

/**
 * Reconciles in-flight review-loop epochs when a PR head advances. Shared by the sweep's head-change
 * branch (`review-loop-sweep.ts`) and the `synchronize` webhook (`webhooks/github.ts`) so the two
 * paths cannot drift (ARC-1245) — the webhook advances the head out-of-band, so the sweep's branch is
 * skipped on the next tick (`previousHeadSha === currentHeadSha`) and any logic only on the sweep
 * side would never run for a webhook-driven advance.
 *
 * If the prior head recorded a QUEUED base-merge (`update_branch_queued_at` set — our own server-side
 * update-branch actually queued), the advance is our own base-merge commit: carry pending review work
 * forward to the new head instead of stale-blocking it (a base-merge carries no NEW feedback, so
 * re-bootstrap would not recreate it). The reader keys on the FSM spine's
 * `pr_coordination.update_branch_queued_at` marker (D-54 dropped the legacy `pr_mergeability_attempts`
 * fallback; the spine, written at the sweep caller, is now the sole source — SF22). Gating on the
 * queued marker — set ONLY when our update-branch actually queued, never on a bare attempt or a
 * merge-conflict notice — is what proves our base-merge landed rather than a foreign push (ARC-1302).
 * Fall back to the stale-block when no queued marker is recorded for the previous head (a foreign push
 * the loop should re-bootstrap against), or when carry-forward throws (e.g. a unique-index collision
 * with an epoch already on the new head); the stale-block is the safe default. (A user push racing
 * AFTER our own successful queue still carries
 * forward — the queued marker cannot disambiguate that race, and re-keying surfaces the pending
 * feedback on the current head, which is the desired outcome.) Returns a no-op result when
 * `previousHeadSha` is empty (an initial head) or equals `currentHeadSha` (no real advance), so the
 * helper is safe even if a future caller forgets the guard both current callers apply upstream.
 *
 * On the stale-block path it FIRST re-keys the settled `ready` budget-truncated tails onto the new
 * head as re-driveable `ready` epochs (ARC-1244, `carryForwardTruncatedTailEpochsToNewHead`) so an
 * un-prompted carried tail drains without a fresh bot signal — the stale-block then naturally skips
 * those rows (they moved off `previousHeadSha`). The re-key uses UPDATE OR IGNORE, so a row colliding
 * with an epoch already on the new head is left on the previous head and falls through to the
 * stale-block (no throw); the try/catch only guards an unexpected DAO error and still runs the
 * stale-block.
 */
export async function reconcileReviewLoopEpochsForHeadChange(
  db: D1Database,
  options: {
    sessionId: string;
    prUrl: string;
    previousHeadSha: string;
    currentHeadSha: string;
    nowMs: number;
    logger: Logger;
  },
): Promise<ReviewLoopHeadChangeEpochResult> {
  const { sessionId, prUrl, previousHeadSha, currentHeadSha, nowMs, logger } = options;
  // An empty previous head has no prior epochs, and stale-blocking on previousHeadSha === currentHeadSha
  // would block the LIVE head's own in-flight epochs. Both callers guard upstream; this is a no-op for
  // them and a safety net for any future caller of this exported helper.
  if (previousHeadSha.length === 0 || previousHeadSha === currentHeadSha) {
    return { carriedForward: 0, staleBlocked: 0, truncatedRekeyed: 0, mentionRekeyed: 0 };
  }
  let spineUpdateBranchQueuedAt: number | null = null;
  try {
    const spineRecord = await getPrCoordination(db, sessionId);
    // `update_branch_queued_at` is a per-current-head marker on pr_coordination. Only trust it when
    // the row still names the head being reconciled; a mismatched/absent row reads as "no queued
    // marker" and falls through to the stale-block (the conservative default).
    if (spineRecord?.prUrl === prUrl && spineRecord.headSha === previousHeadSha) {
      spineUpdateBranchQueuedAt = spineRecord.updateBranchQueuedAt;
    }
  } catch (error) {
    logger.warn(
      { sessionId, prUrl, previousHeadSha, error: String(error) },
      "Review-loop head-change spine queued-marker read failed; falling back to stale-block",
    );
  }
  // Second own-advance proof: the session itself RECENTLY recorded a succeeded push whose
  // verified/reported remote head IS the new head (the guarded publish push op, or a sandbox
  // `cycloid.git_sync` push recorded via recordReviewLoopSelfPushForSession). The agent's own
  // mid-prompt fix push must not stale-block the epoch it is fixing — that killed the epoch before
  // its verdict replies could post and left the addressed comment silently disposed (PR #7656).
  // Exact-SHA match + the recency window keep the proof fail-closed like the queued marker: a real
  // self-push's webhook lands seconds after the record, while a foreign force-push/reset back to a
  // FORMER own tip (every fix destination stays recorded for the PR's lifetime) arrives long after —
  // outside the window it stale-blocks as the foreign push it is. A read failure falls through to
  // the stale-block.
  let selfPushAdvance = false;
  if (spineUpdateBranchQueuedAt == null) {
    try {
      selfPushAdvance = await hasSucceededReviewLoopPushToHead(db, {
        sessionId,
        prUrl,
        headSha: currentHeadSha,
        recordedAfterMs: nowMs - SELF_PUSH_PROOF_WINDOW_MS,
      });
    } catch (error) {
      logger.warn(
        { sessionId, prUrl, currentHeadSha, error: String(error) },
        "Review-loop head-change self-push proof read failed; falling back to stale-block",
      );
    }
  }
  // Carry forward only on a queued base-merge marker or the session's own recorded push — never a
  // foreign push (see JSDoc, ARC-1302). The own-advance carry-forward re-keys ALL non-terminal epochs
  // (truncated or not), preserving status, so no truncated-tail split is needed on this arm.
  if (spineUpdateBranchQueuedAt != null || selfPushAdvance) {
    try {
      const carriedForward = await carryForwardReviewLoopEpochsToNewHead(db, {
        sessionId,
        prUrl,
        previousHeadSha,
        currentHeadSha,
        nowMs,
      });
      if (selfPushAdvance && spineUpdateBranchQueuedAt == null) {
        logger.info(
          {
            event: "review_loop.head_change_self_push_carry_forward",
            sessionId,
            prUrl,
            previousHeadSha,
            currentHeadSha,
            carriedForward,
          },
          "Carried review-loop epochs forward on the session's own recorded push (no stale-block)",
        );
      }
      return { carriedForward, staleBlocked: 0, truncatedRekeyed: 0, mentionRekeyed: 0 };
    } catch (error) {
      logger.warn(
        { sessionId, prUrl, previousHeadSha, currentHeadSha, error: String(error) },
        "Review-loop head-change carry-forward failed; falling back to stale-block",
      );
    }
  }
  // Stale-block path (foreign/user push). First re-key the settled `ready` budget-truncated tails onto
  // the new head as re-driveable `ready` epochs (ARC-1244) so they drain there without depending on a
  // fresh bot signal (bootstrap is CI-signal-only). The DAO uses UPDATE OR IGNORE, so a row colliding
  // with an epoch already on the new head is skipped (not re-keyed) and stays on the previous head for
  // the stale-block below — no throw on collision. The try/catch only guards an UNEXPECTED DAO error
  // (e.g. a transient storage fault): on it we warn and still run the stale-block so the head change
  // is never left half-reconciled. truncatedRekeyed stays 0 on a throw (the await never assigns).
  let truncatedRekeyed = 0;
  try {
    truncatedRekeyed = await carryForwardTruncatedTailEpochsToNewHead(db, {
      sessionId,
      prUrl,
      previousHeadSha,
      currentHeadSha,
      nowMs,
    });
    if (truncatedRekeyed > 0) {
      logger.info(
        {
          event: "review_loop.head_change_truncated_tail_rekeyed",
          sessionId,
          prUrl,
          previousHeadSha,
          currentHeadSha,
          rekeyed: truncatedRekeyed,
        },
        "Re-keyed budget-truncated review-loop tail to the new head on a stale-block head change",
      );
    }
  } catch (error) {
    logger.warn(
      { sessionId, prUrl, previousHeadSha, currentHeadSha, error: String(error) },
      "Review-loop head-change truncated-tail re-key failed; falling back to stale-block",
    );
  }
  // Also carry `@cycloid` mention epochs forward before the stale-block: a mention is a head-agnostic
  // user instruction, so a foreign push (commonly the agent's own fix for a sibling mention) must not
  // strand a pending one on the old head where the sweep would block it as `head_changed`. Same
  // UPDATE OR IGNORE + fail-open-to-stale-block contract as the truncated-tail re-key above; on an
  // unexpected DAO error we warn and still run the stale-block so reconciliation is never left partial.
  let mentionRekeyed = 0;
  try {
    mentionRekeyed = await carryForwardMentionEpochsToNewHead(db, {
      sessionId,
      prUrl,
      previousHeadSha,
      currentHeadSha,
      nowMs,
    });
    if (mentionRekeyed > 0) {
      logger.info(
        {
          event: "review_loop.head_change_mention_rekeyed",
          sessionId,
          prUrl,
          previousHeadSha,
          currentHeadSha,
          rekeyed: mentionRekeyed,
        },
        "Carried @cycloid mention epochs forward to the new head on a stale-block head change",
      );
    }
  } catch (error) {
    logger.warn(
      { sessionId, prUrl, previousHeadSha, currentHeadSha, error: String(error) },
      "Review-loop head-change mention re-key failed; falling back to stale-block",
    );
  }
  const staleBlocked = await markReviewLoopEpochsStaleForHeadChange(db, {
    sessionId,
    prUrl,
    previousHeadSha,
    currentHeadSha,
    nowMs,
  });
  return { carriedForward: 0, staleBlocked, truncatedRekeyed, mentionRekeyed };
}

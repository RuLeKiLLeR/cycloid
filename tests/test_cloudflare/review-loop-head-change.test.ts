import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the shared review-loop head-change epoch reconciliation helper (ARC-1245). The
// sweep's head-change branch and the `synchronize` webhook both route through this helper so the
// carry-forward-vs-stale-block decision cannot drift between the two paths. The epoch DAOs it
// orchestrates are mocked here. D-54 dropped the legacy `pr_mergeability_attempts` fallback, so the
// only carry-forward proof is the FSM spine's `pr_coordination.update_branch_queued_at` marker.

const mockGetPrCoordination = vi.fn();
const mockCarryForwardReviewLoopEpochsToNewHead = vi.fn();
const mockCarryForwardTruncatedTailEpochsToNewHead = vi.fn();
const mockCarryForwardMentionEpochsToNewHead = vi.fn();
const mockMarkReviewLoopEpochsStaleForHeadChange = vi.fn();
const mockHasSucceededReviewLoopPushToHead = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/pr-coordination-db", () => ({
  getPrCoordination: (...args: unknown[]) => mockGetPrCoordination(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-operations", () => ({
  hasSucceededReviewLoopPushToHead: (...args: unknown[]) => mockHasSucceededReviewLoopPushToHead(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-epochs", () => ({
  carryForwardReviewLoopEpochsToNewHead: (...args: unknown[]) => mockCarryForwardReviewLoopEpochsToNewHead(...args),
  carryForwardTruncatedTailEpochsToNewHead: (...args: unknown[]) =>
    mockCarryForwardTruncatedTailEpochsToNewHead(...args),
  carryForwardMentionEpochsToNewHead: (...args: unknown[]) => mockCarryForwardMentionEpochsToNewHead(...args),
  markReviewLoopEpochsStaleForHeadChange: (...args: unknown[]) => mockMarkReviewLoopEpochsStaleForHeadChange(...args),
}));

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
const db = {} as never;
const baseOpts = {
  sessionId: "sess-1",
  prUrl: "https://github.com/acme/repo/pull/42",
  previousHeadSha: "old-head",
  currentHeadSha: "new-head",
  nowMs: 1_000_000,
  logger: logger as never,
};

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so any unconsumed mockResolvedValueOnce from a prior test cannot
  // leak into the next — each test fully establishes the mock returns it depends on.
  vi.resetAllMocks();
  mockGetPrCoordination.mockResolvedValue(null);
  // Default: no mention epochs to carry forward. Tests exercising the mention re-key override this.
  mockCarryForwardMentionEpochsToNewHead.mockResolvedValue(0);
  // Default: no recorded self-push — the foreign-push stale-block arm. Self-push tests override this.
  mockHasSucceededReviewLoopPushToHead.mockResolvedValue(false);
});

describe("reconcileReviewLoopEpochsForHeadChange (ARC-1245)", () => {
  it("carries epochs forward on the spine queued marker for the previous head", async () => {
    // The spine row still names the previous head and carries a queued update-branch marker → the
    // advance is our own base-merge commit → carry pending work forward instead of dropping it as stale
    // (ARC-1302: only a queued marker, never a bare attempt / foreign push, is the carry-forward proof).
    mockGetPrCoordination.mockResolvedValueOnce({
      sessionId: "sess-1",
      prUrl: baseOpts.prUrl,
      headSha: "old-head",
      updateBranchQueuedAt: 800,
    });
    mockCarryForwardReviewLoopEpochsToNewHead.mockResolvedValueOnce(2);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockGetPrCoordination).toHaveBeenCalledWith(db, "sess-1");
    expect(mockCarryForwardReviewLoopEpochsToNewHead).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ previousHeadSha: "old-head", currentHeadSha: "new-head", nowMs: 1_000_000 }),
    );
    // The own-base-merge carry-forward re-keys ALL non-terminal epochs (truncated or not), so the
    // truncated-tail split is NOT used on this arm.
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).not.toHaveBeenCalled();
    expect(mockCarryForwardTruncatedTailEpochsToNewHead).not.toHaveBeenCalled();
    // The base-merge carry-forward already re-keys mentions (they are non-terminal epochs), so the
    // mention-specific re-key is NOT invoked on this arm.
    expect(mockCarryForwardMentionEpochsToNewHead).not.toHaveBeenCalled();
    expect(result).toEqual({ carriedForward: 2, staleBlocked: 0, truncatedRekeyed: 0, mentionRekeyed: 0 });
  });

  it("stale-blocks directly when spine marker carry-forward throws", async () => {
    mockGetPrCoordination.mockResolvedValueOnce({
      sessionId: "sess-1",
      prUrl: baseOpts.prUrl,
      headSha: "old-head",
      updateBranchQueuedAt: 800,
    });
    mockCarryForwardReviewLoopEpochsToNewHead.mockRejectedValueOnce(new Error("UNIQUE constraint failed"));
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(0);
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(3);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockCarryForwardReviewLoopEpochsToNewHead).toHaveBeenCalledTimes(1);
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ previousHeadSha: "old-head", currentHeadSha: "new-head", nowMs: 1_000_000 }),
    );
    expect(result).toEqual({ carriedForward: 0, staleBlocked: 3, truncatedRekeyed: 0, mentionRekeyed: 0 });
  });

  it("stale-blocks when the spine marker belongs to another head (no legacy fallback)", async () => {
    // The spine row has advanced to the new head, so its marker is not proof about the previous head's
    // advance. D-54 removed the legacy per-head mergeability fallback, so this is a plain stale-block.
    mockGetPrCoordination.mockResolvedValueOnce({
      sessionId: "sess-1",
      prUrl: baseOpts.prUrl,
      headSha: "new-head",
      updateBranchQueuedAt: 800,
    });
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(0);
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(2);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockCarryForwardReviewLoopEpochsToNewHead).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ previousHeadSha: "old-head", currentHeadSha: "new-head", nowMs: 1_000_000 }),
    );
    expect(result).toEqual({ carriedForward: 0, staleBlocked: 2, truncatedRekeyed: 0, mentionRekeyed: 0 });
  });

  it("stale-blocks (no carry-forward) when the spine row is absent (foreign head change)", async () => {
    mockGetPrCoordination.mockResolvedValueOnce(null);
    // No truncated tail owed → the re-key returns 0 and the stale-block buries the rest.
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(0);
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(3);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockCarryForwardReviewLoopEpochsToNewHead).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ previousHeadSha: "old-head", currentHeadSha: "new-head", nowMs: 1_000_000 }),
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(result).toEqual({ carriedForward: 0, staleBlocked: 3, truncatedRekeyed: 0, mentionRekeyed: 0 });
  });

  it("carries epochs forward when the new head is the session's own RECORDED push (git_sync / guarded push)", async () => {
    // No queued base-merge marker, but a succeeded push operation records the new head as the
    // session's own advance (PR #7656: the agent's mid-prompt git_sync fix push). The epoch it is
    // fixing must survive — carry forward, never stale-block.
    mockGetPrCoordination.mockResolvedValueOnce(null);
    mockHasSucceededReviewLoopPushToHead.mockResolvedValueOnce(true);
    mockCarryForwardReviewLoopEpochsToNewHead.mockResolvedValueOnce(1);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockHasSucceededReviewLoopPushToHead).toHaveBeenCalledWith(
      db,
      // recordedAfterMs = nowMs - the 10-minute proof window: a stale record (foreign reset back to a
      // former own tip) must not read as own-push proof.
      expect.objectContaining({
        sessionId: "sess-1",
        prUrl: baseOpts.prUrl,
        headSha: "new-head",
        recordedAfterMs: 1_000_000 - 10 * 60 * 1000,
      }),
    );
    expect(mockCarryForwardReviewLoopEpochsToNewHead).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ previousHeadSha: "old-head", currentHeadSha: "new-head", nowMs: 1_000_000 }),
    );
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "review_loop.head_change_self_push_carry_forward" }),
      expect.any(String),
    );
    expect(result).toEqual({ carriedForward: 1, staleBlocked: 0, truncatedRekeyed: 0, mentionRekeyed: 0 });
  });

  it("stale-blocks when the self-push proof read throws (fail-closed to the conservative default)", async () => {
    mockGetPrCoordination.mockResolvedValueOnce(null);
    mockHasSucceededReviewLoopPushToHead.mockRejectedValueOnce(new Error("d1 unavailable"));
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(0);
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(2);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockCarryForwardReviewLoopEpochsToNewHead).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalled();
    expect(result).toEqual({ carriedForward: 0, staleBlocked: 2, truncatedRekeyed: 0, mentionRekeyed: 0 });
  });

  it("does not consult the self-push proof when the queued base-merge marker already proves the advance", async () => {
    mockGetPrCoordination.mockResolvedValueOnce({
      sessionId: "sess-1",
      prUrl: baseOpts.prUrl,
      headSha: "old-head",
      updateBranchQueuedAt: 800,
    });
    mockCarryForwardReviewLoopEpochsToNewHead.mockResolvedValueOnce(2);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockHasSucceededReviewLoopPushToHead).not.toHaveBeenCalled();
  });

  it("stale-blocks (no carry-forward) when the spine marker is null on the matching head (ARC-1302)", async () => {
    // The spine row still names the previous head but never recorded a queued update-branch
    // (update_branch_queued_at === null) — an update-branch that failed (expected_head_mismatch /
    // validation_failed / unavailable) or a plain foreign push. Not proof our base-merge advanced the
    // head, so re-bootstrap via stale-block, do not carry stale review work forward.
    mockGetPrCoordination.mockResolvedValueOnce({
      sessionId: "sess-1",
      prUrl: baseOpts.prUrl,
      headSha: "old-head",
      updateBranchQueuedAt: null,
    });
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(0);
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(4);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockCarryForwardReviewLoopEpochsToNewHead).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ previousHeadSha: "old-head", currentHeadSha: "new-head", nowMs: 1_000_000 }),
    );
    expect(result).toEqual({ carriedForward: 0, staleBlocked: 4, truncatedRekeyed: 0, mentionRekeyed: 0 });
  });

  it("re-keys a budget-truncated tail to the new head BEFORE stale-blocking on a foreign head change (ARC-1244)", async () => {
    // Foreign push (no queued marker), but an in-flight epoch still owes an un-prompted truncated tail.
    // The helper must re-key that subset onto the new head as a re-driveable `ready` epoch (so the tail
    // drains without a fresh bot signal) BEFORE the stale-block buries the remaining epochs.
    // (No spine queued marker — getPrCoordination defaults to null in beforeEach.)
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(2);
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(1);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockCarryForwardTruncatedTailEpochsToNewHead).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ previousHeadSha: "old-head", currentHeadSha: "new-head", nowMs: 1_000_000 }),
    );
    // Ordering: the re-key runs before the stale-block so the moved rows are already off the previous
    // head and the stale-block naturally skips them.
    expect(mockCarryForwardTruncatedTailEpochsToNewHead.mock.invocationCallOrder[0]).toBeLessThan(
      mockMarkReviewLoopEpochsStaleForHeadChange.mock.invocationCallOrder[0],
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "review_loop.head_change_truncated_tail_rekeyed", rekeyed: 2 }),
      expect.any(String),
    );
    expect(result).toEqual({ carriedForward: 0, staleBlocked: 1, truncatedRekeyed: 2, mentionRekeyed: 0 });
  });

  it("falls back to a clean stale-block when the truncated-tail re-key throws (unexpected DAO error) — truncatedRekeyed: 0", async () => {
    // The DAO uses UPDATE OR IGNORE, so a unique-index COLLISION is skipped silently and never throws;
    // the try/catch is only for an UNEXPECTED DAO error (e.g. a transient storage fault). On it the
    // helper warns and still runs the stale-block so the head change is never left half-reconciled.
    mockCarryForwardTruncatedTailEpochsToNewHead.mockRejectedValueOnce(new Error("D1_ERROR: transient storage fault"));
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(3);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockCarryForwardTruncatedTailEpochsToNewHead).toHaveBeenCalledTimes(1);
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(result).toEqual({ carriedForward: 0, staleBlocked: 3, truncatedRekeyed: 0, mentionRekeyed: 0 });
  });

  it("no-ops (no DAO calls) when previousHeadSha is empty or equals currentHeadSha", async () => {
    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");

    const empty = await reconcileReviewLoopEpochsForHeadChange(db, { ...baseOpts, previousHeadSha: "" });
    expect(empty).toEqual({ carriedForward: 0, staleBlocked: 0, truncatedRekeyed: 0, mentionRekeyed: 0 });

    const unchanged = await reconcileReviewLoopEpochsForHeadChange(db, {
      ...baseOpts,
      previousHeadSha: "same",
      currentHeadSha: "same",
    });
    expect(unchanged).toEqual({ carriedForward: 0, staleBlocked: 0, truncatedRekeyed: 0, mentionRekeyed: 0 });

    // Guard runs before any query — stale-blocking previousHeadSha === currentHeadSha would block the
    // live head's own epochs.
    expect(mockGetPrCoordination).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).not.toHaveBeenCalled();
    expect(mockCarryForwardReviewLoopEpochsToNewHead).not.toHaveBeenCalled();
    expect(mockCarryForwardTruncatedTailEpochsToNewHead).not.toHaveBeenCalled();
    expect(mockCarryForwardMentionEpochsToNewHead).not.toHaveBeenCalled();
  });

  it("falls back to stale-block when carry-forward throws (e.g. unique-index collision on the new head)", async () => {
    mockGetPrCoordination.mockResolvedValueOnce({
      sessionId: "sess-1",
      prUrl: baseOpts.prUrl,
      headSha: "old-head",
      updateBranchQueuedAt: 900,
    });
    mockCarryForwardReviewLoopEpochsToNewHead.mockRejectedValueOnce(new Error("UNIQUE constraint failed"));
    // The carry-forward throw falls through to the stale-block path, which also runs the truncated re-key.
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(0);
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(1);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockCarryForwardReviewLoopEpochsToNewHead).toHaveBeenCalledTimes(1);
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
    expect(result).toEqual({ carriedForward: 0, staleBlocked: 1, truncatedRekeyed: 0, mentionRekeyed: 0 });
  });

  it("carries @cycloid mention epochs forward to the new head BEFORE stale-blocking on a foreign head change", async () => {
    // Foreign push (no queued marker) — commonly the agent's OWN fix pushed while responding to a sibling
    // mention. A mention is a head-agnostic user instruction, so a pending one must be re-keyed onto the
    // new head (where the sweep can still dispatch it) instead of being stale-blocked with the rest.
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(0);
    mockCarryForwardMentionEpochsToNewHead.mockResolvedValueOnce(1);
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(2);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockCarryForwardMentionEpochsToNewHead).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ previousHeadSha: "old-head", currentHeadSha: "new-head", nowMs: 1_000_000 }),
    );
    // Ordering: the re-key runs before the stale-block so the moved mention rows are already off the
    // previous head and the stale-block (keyed on previousHeadSha) naturally skips them.
    expect(mockCarryForwardMentionEpochsToNewHead.mock.invocationCallOrder[0]).toBeLessThan(
      mockMarkReviewLoopEpochsStaleForHeadChange.mock.invocationCallOrder[0],
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "review_loop.head_change_mention_rekeyed", rekeyed: 1 }),
      expect.any(String),
    );
    expect(result).toEqual({ carriedForward: 0, staleBlocked: 2, truncatedRekeyed: 0, mentionRekeyed: 1 });
  });

  it("falls back to a clean stale-block when the mention re-key throws (unexpected DAO error) — mentionRekeyed: 0", async () => {
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(0);
    mockCarryForwardMentionEpochsToNewHead.mockRejectedValueOnce(new Error("D1_ERROR: transient storage fault"));
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(2);

    const { reconcileReviewLoopEpochsForHeadChange } =
      await import("../../apps/control-plane-worker/src/services/review-loop-head-change");
    const result = await reconcileReviewLoopEpochsForHeadChange(db, baseOpts);

    expect(mockCarryForwardMentionEpochsToNewHead).toHaveBeenCalledTimes(1);
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
    expect(result).toEqual({ carriedForward: 0, staleBlocked: 2, truncatedRekeyed: 0, mentionRekeyed: 0 });
  });
});

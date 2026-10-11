import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecutePlatformLlmCall = vi.fn();
const mockEmitReviewLoopTriageMetric = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/platform-llm", () => ({
  executePlatformLlmCall: (...args: unknown[]) => mockExecutePlatformLlmCall(...args),
}));

vi.mock("../../apps/control-plane-worker/src/observability/pr-metrics", () => ({
  emitReviewLoopTriageMetric: (...args: unknown[]) => mockEmitReviewLoopTriageMetric(...args),
}));

import { PLATFORM_LLM_CALL_CONFIG } from "../../apps/control-plane-worker/src/constants/platform-llm";
import {
  reviewLoopTriageCandidatesFromWorklistItems,
  triageReviewLoopWorklist,
} from "../../apps/control-plane-worker/src/services/review-loop-triage";
import type { Env } from "../../apps/control-plane-worker/src/types";

const logger = { info: vi.fn(), warn: vi.fn() };
const env = { DB: {} } as unknown as Env;

function candidate(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    sourceId,
    kind: "comment" as const,
    authorLogin: "cursor[bot]",
    authorType: "Bot",
    location: null,
    body: `body for ${sourceId}`,
    ...overrides,
  };
}

function triageArgs(candidates = [candidate("review-comment:1"), candidate("issue-comment:2")]) {
  return {
    sessionId: "sess-1",
    epochId: "epoch-1",
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 42,
    headSha: "deadbeef",
    candidates,
    logger: logger as never,
  };
}

function llmSuccess(data: unknown) {
  // The triage output contract now requires a `conflicts` array. Default it to [] for the many
  // pre-conflict fixtures (well-formed objects only — the malformed-shape fixtures are left as-is so
  // they still fail validation). Conflict-specific tests pass `conflicts` explicitly.
  const payload =
    data &&
    typeof data === "object" &&
    Array.isArray((data as { actionItems?: unknown }).actionItems) &&
    !("conflicts" in data)
      ? { conflicts: [], ...data }
      : data;
  return { status: 200, response: { ok: true, data: payload, attempts: 1, durationMs: 5, model: "m", toolName: "t" } };
}

describe("review-loop triage service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns validated action items on a fully covering output", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [{ instruction: "Fix both comments.", sourceIds: ["review-comment:1", "issue-comment:2"] }],
        droppedItems: [],
      }),
    );

    const outcome = await triageReviewLoopWorklist(env, triageArgs());

    expect(outcome).toEqual({
      ok: true,
      actionItems: [{ instruction: "Fix both comments.", sourceIds: ["review-comment:1", "issue-comment:2"] }],
      droppedItems: [],
      conflicts: [],
      discardedActionItemCount: 0,
    });
    const plan = mockExecutePlatformLlmCall.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(plan).toMatchObject({
      callType: "review_loop_triage",
      phase: PLATFORM_LLM_CALL_CONFIG.review_loop_triage.phase,
      model: PLATFORM_LLM_CALL_CONFIG.review_loop_triage.model,
      sessionId: "sess-1",
      promptId: "epoch-1",
    });
    const input = mockExecutePlatformLlmCall.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(input).toMatchObject({ repo: "acme/repo", prNumber: 42, headSha: "deadbeef" });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ outcome: "used" }), "Review-loop triage used");
  });

  it("carries detected conflicts between two covered items without tripping duplicate_coverage", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [
          { instruction: "Add a null check.", sourceIds: ["review-comment:1"] },
          { instruction: "Remove the field entirely.", sourceIds: ["issue-comment:2"] },
        ],
        droppedItems: [],
        conflicts: [{ sourceIds: ["review-comment:1", "issue-comment:2"], summary: "guard vs remove the field" }],
      }),
    );

    const outcome = await triageReviewLoopWorklist(env, triageArgs());

    // Both items stay covered (each sourceId once) AND the conflict is echoed — the conflict's
    // double-reference of already-covered ids must NOT count as coverage, so no duplicate_coverage.
    expect(outcome).toMatchObject({
      ok: true,
      conflicts: [{ sourceIds: ["review-comment:1", "issue-comment:2"], summary: "guard vs remove the field" }],
    });
    const metric = mockEmitReviewLoopTriageMetric.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(metric).toMatchObject({ outcome: "used", conflictCount: 1 });
  });

  it("filters invalid conflict entries (under-specified, dropped, or unknown ids) without falling back", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [{ instruction: "Fix the first comment.", sourceIds: ["review-comment:1"] }],
        droppedItems: [{ sourceId: "issue-comment:2", reason: "status-only" }],
        conflicts: [
          // Only one covered id after filtering the dropped id -> dropped (needs >= 2).
          { sourceIds: ["review-comment:1", "issue-comment:2"], summary: "vs a dropped item" },
          // Single id -> dropped.
          { sourceIds: ["review-comment:1"], summary: "self" },
          // Unknown id collapses to zero covered -> dropped.
          { sourceIds: ["review-comment:999", "issue-comment:888"], summary: "phantom" },
        ],
      }),
    );

    const outcome = await triageReviewLoopWorklist(env, triageArgs());

    expect(outcome).toMatchObject({ ok: true, conflicts: [] });
    const metric = mockEmitReviewLoopTriageMetric.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(metric).toMatchObject({ outcome: "used", conflictCount: 0 });
  });

  it("drops a conflict whose ids all belong to the SAME action item (not a real pick-one choice)", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        // One action item covers BOTH ids, so flagging them as a conflict is spurious: the agent
        // applies that single item in full, with nothing to "pick" or reply "not applied" about.
        actionItems: [
          { instruction: "Address both notes together.", sourceIds: ["review-comment:1", "issue-comment:2"] },
        ],
        droppedItems: [],
        conflicts: [{ sourceIds: ["review-comment:1", "issue-comment:2"], summary: "spurious same-item conflict" }],
      }),
    );

    const outcome = await triageReviewLoopWorklist(env, triageArgs());

    expect(outcome).toMatchObject({ ok: true, conflicts: [] });
    const metric = mockEmitReviewLoopTriageMetric.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(metric).toMatchObject({ outcome: "used", conflictCount: 0 });
  });

  it("drops a conflict whose summary is empty/whitespace (a guidance-free Conflict line)", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [
          { instruction: "Add a null check.", sourceIds: ["review-comment:1"] },
          { instruction: "Remove the field.", sourceIds: ["issue-comment:2"] },
        ],
        droppedItems: [],
        conflicts: [{ sourceIds: ["review-comment:1", "issue-comment:2"], summary: "   " }],
      }),
    );

    const outcome = await triageReviewLoopWorklist(env, triageArgs());

    expect(outcome).toMatchObject({ ok: true, conflicts: [] });
    // Proposed-but-pruned conflicts are observable: 1 proposed, 0 survived.
    const metric = mockEmitReviewLoopTriageMetric.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(metric).toMatchObject({ outcome: "used", conflictCount: 0, conflictDroppedCount: 1 });
  });

  it("reduces a conflict to one representative id per distinct action item", async () => {
    // review-comment:1 and review-comment:2 are bundled into ONE action item; issue-comment:3 is its
    // own. The conflict names all three, but only the two SIDES (one id per item) should survive — so
    // the agent doesn't post a "did not apply theirs" reply to review-comment:2 (same item it applied).
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [
          { instruction: "Guard both inline notes.", sourceIds: ["review-comment:1", "review-comment:2"] },
          { instruction: "Remove the field instead.", sourceIds: ["issue-comment:3"] },
        ],
        droppedItems: [],
        conflicts: [
          { sourceIds: ["review-comment:1", "review-comment:2", "issue-comment:3"], summary: "guard vs remove" },
        ],
      }),
    );

    const outcome = await triageReviewLoopWorklist(
      env,
      triageArgs([candidate("review-comment:1"), candidate("review-comment:2"), candidate("issue-comment:3")]),
    );

    expect(outcome).toMatchObject({
      ok: true,
      conflicts: [{ sourceIds: ["review-comment:1", "issue-comment:3"], summary: "guard vs remove" }],
    });
    const metric = mockEmitReviewLoopTriageMetric.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(metric).toMatchObject({ outcome: "used", conflictCount: 1, conflictDroppedCount: 0 });
  });

  it("accepts dropped items as coverage", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [{ instruction: "Fix the first comment.", sourceIds: ["review-comment:1"] }],
        droppedItems: [{ sourceId: "issue-comment:2", reason: "status-only" }],
      }),
    );

    const outcome = await triageReviewLoopWorklist(env, triageArgs());

    expect(outcome).toMatchObject({ ok: true, droppedItems: [{ sourceId: "issue-comment:2" }] });
  });

  it("discards action items referencing unknown source ids and falls back on the coverage gap", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [
          { instruction: "Fix the first comment.", sourceIds: ["review-comment:1", "review-comment:999"] },
          { instruction: "Fix the second comment.", sourceIds: ["issue-comment:2"] },
        ],
        droppedItems: [],
      }),
    );

    const outcome = await triageReviewLoopWorklist(env, triageArgs());

    // The hallucinated-id item is discarded, leaving review-comment:1 uncovered -> fail open.
    expect(outcome).toEqual({ ok: false, reason: "coverage_gap" });

    // The fallback metric must report the real discarded count (1), not a hardcoded 0 — otherwise
    // the triage_discarded_action_items series never fires on a hallucination-driven fallback.
    const metric = mockEmitReviewLoopTriageMetric.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(metric).toMatchObject({ outcome: "fallback", reason: "coverage_gap", discardedActionItemCount: 1 });
  });

  it("does not let a co-listed drop launder a discarded action item's real feedback (PR-4)", async () => {
    // review-comment:1 is carried by a DISCARDED action item (it co-lists a hallucinated id) AND by a
    // drop. Without the fix the drop covers it and the outcome is ok:true with review-comment:1's
    // real instruction silently lost; the fix forces it uncovered so we fall back and re-prompt all.
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [
          { instruction: "Fix the first comment.", sourceIds: ["review-comment:1", "review-comment:999"] },
          { instruction: "Fix the second comment.", sourceIds: ["issue-comment:2"] },
        ],
        droppedItems: [{ sourceId: "review-comment:1", reason: "duplicate of the inline note" }],
      }),
    );

    const outcome = await triageReviewLoopWorklist(env, triageArgs());

    expect(outcome).toEqual({ ok: false, reason: "coverage_gap" });
    const metric = mockEmitReviewLoopTriageMetric.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(metric).toMatchObject({ outcome: "fallback", reason: "coverage_gap", discardedActionItemCount: 1 });
  });

  it("logs dropped item ids without the untrusted reason text on the used path (PR-4)", async () => {
    const rawReason = `status-only\nmultiline reviewer note ${"x".repeat(200)}`;
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [{ instruction: "Fix the first comment.", sourceIds: ["review-comment:1"] }],
        droppedItems: [{ sourceId: "issue-comment:2", reason: rawReason }],
      }),
    );

    const outcome = await triageReviewLoopWorklist(env, triageArgs());
    expect(outcome).toMatchObject({ ok: true });

    const usedCall = logger.info.mock.calls.find((call) => call[1] === "Review-loop triage used");
    const logged = (usedCall?.[0] as { droppedItems?: Array<{ sourceId: string; reasonLength: number }> }).droppedItems;
    // The dropped item's id is logged for visibility; only the reason's LENGTH is recorded (no text).
    expect(logged).toEqual([{ sourceId: "issue-comment:2", reasonLength: rawReason.length }]);
    // No reason text — not even a truncated prefix — reaches the structured log (PII/log-injection).
    expect(JSON.stringify(usedCall?.[0])).not.toContain("reviewer note");
    expect(JSON.stringify(usedCall?.[0])).not.toContain(rawReason.slice(0, 40));
  });

  it("ignores dropped items with unknown source ids (no coverage credit)", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [{ instruction: "Fix the first comment.", sourceIds: ["review-comment:1"] }],
        droppedItems: [{ sourceId: "issue-comment:999", reason: "unknown" }],
      }),
    );

    const outcome = await triageReviewLoopWorklist(env, triageArgs());

    expect(outcome).toEqual({ ok: false, reason: "coverage_gap" });
  });

  it("falls back when a source id is claimed more than once (contradictory instructions)", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [
          { instruction: "Fix the first comment.", sourceIds: ["review-comment:1"] },
          { instruction: "Rework the first comment differently.", sourceIds: ["review-comment:1"] },
        ],
        droppedItems: [{ sourceId: "issue-comment:2", reason: "noise" }],
      }),
    );
    expect(await triageReviewLoopWorklist(env, triageArgs())).toEqual({ ok: false, reason: "duplicate_coverage" });

    // An action item and a drop citing the same source is the same contradiction.
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [{ instruction: "Fix both.", sourceIds: ["review-comment:1", "issue-comment:2"] }],
        droppedItems: [{ sourceId: "issue-comment:2", reason: "noise" }],
      }),
    );
    expect(await triageReviewLoopWorklist(env, triageArgs())).toEqual({ ok: false, reason: "duplicate_coverage" });
  });

  it("falls back when the LLM yields zero usable action items", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce(
      llmSuccess({
        actionItems: [],
        droppedItems: [
          { sourceId: "review-comment:1", reason: "noise" },
          { sourceId: "issue-comment:2", reason: "noise" },
        ],
      }),
    );

    const outcome = await triageReviewLoopWorklist(env, triageArgs());

    expect(outcome).toEqual({ ok: false, reason: "no_action_items" });
  });

  it("falls back on a malformed output shape", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce(llmSuccess({ actionItems: "not-an-array" }));

    const outcome = await triageReviewLoopWorklist(env, triageArgs());

    expect(outcome).toEqual({ ok: false, reason: "output_invalid" });
  });

  it("maps platform-LLM categories to fallback reasons and metric tags", async () => {
    mockExecutePlatformLlmCall.mockResolvedValueOnce({
      status: 503,
      response: { ok: false, category: "provider_error_nonretryable", attempts: 0, durationMs: 0, toolName: "t" },
    });
    expect(await triageReviewLoopWorklist(env, triageArgs())).toEqual({ ok: false, reason: "llm_unavailable" });
    expect(mockEmitReviewLoopTriageMetric.mock.calls.at(-1)?.[1]).toMatchObject({
      outcome: "fallback",
      reason: "llm_unavailable",
      category: "provider_error_nonretryable",
    });

    mockExecutePlatformLlmCall.mockResolvedValueOnce({
      status: 503,
      response: { ok: false, category: "provider_error_retryable", attempts: 3, durationMs: 10, toolName: "t" },
    });
    expect(await triageReviewLoopWorklist(env, triageArgs())).toEqual({ ok: false, reason: "llm_failed" });
    expect(mockEmitReviewLoopTriageMetric.mock.calls.at(-1)?.[1]).toMatchObject({
      outcome: "fallback",
      reason: "llm_failed",
      category: "provider_error_retryable",
    });
  });

  it("falls back without calling the LLM on an empty or over-budget worklist", async () => {
    expect(await triageReviewLoopWorklist(env, triageArgs([]))).toEqual({ ok: false, reason: "empty_worklist" });

    const tooMany = Array.from({ length: (PLATFORM_LLM_CALL_CONFIG.review_loop_triage.maxItems ?? 0) + 1 }, (_, i) =>
      candidate(`issue-comment:${i}`),
    );
    expect(await triageReviewLoopWorklist(env, triageArgs(tooMany))).toEqual({ ok: false, reason: "too_many_items" });
    expect(mockExecutePlatformLlmCall).not.toHaveBeenCalled();
  });

  it("adapts worklist items to candidates with locations", () => {
    const candidates = reviewLoopTriageCandidatesFromWorklistItems(
      [
        {
          sourceId: "review-comment:1",
          sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r1",
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "Fix this",
          path: "src/app.ts",
          line: 10,
          startLine: 8,
          startSide: "LEFT",
          side: "LEFT",
          diffHunk: "@@ -8,3 +8,0 @@\n-old();",
          updatedAtMs: 1,
          isResolved: false,
          isOutdated: true,
        },
      ],
      "comment",
    );

    expect(candidates).toEqual([
      {
        sourceId: "review-comment:1",
        kind: "comment",
        authorLogin: "cursor[bot]",
        authorType: "Bot",
        location: "src/app.ts:8-10 (left side / deleted code; outdated diff; referenced code may have moved)",
        body: "Fix this",
        diffHunk: "@@ -8,3 +8,0 @@\n-old();",
      },
    ]);
  });

  it("does not collapse mixed-side ranges into a single deleted-side location", () => {
    const candidates = reviewLoopTriageCandidatesFromWorklistItems(
      [
        {
          sourceId: "review-comment:1",
          sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r1",
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "Fix this",
          path: "src/app.ts",
          line: 10,
          startLine: 8,
          startSide: "LEFT",
          side: "RIGHT",
          diffHunk: "@@ -8,3 +8,3 @@\n-old();\n+next();",
          updatedAtMs: 1,
          isResolved: false,
          isOutdated: false,
        },
      ],
      "comment",
    );

    expect(candidates[0]?.location).toBe("src/app.ts:8-10 (mixed diff sides)");
  });
});

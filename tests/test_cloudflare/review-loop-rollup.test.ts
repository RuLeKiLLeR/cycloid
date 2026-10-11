import { describe, expect, it } from "vitest";

import type { CommitCheckRun, CommitStatusContext } from "../../apps/control-plane-worker/src/github/pr";
import {
  dedupeLatestCheckRunsByName,
  FAILING_CHECK_RUN_CONCLUSIONS,
  failingCheckRunWorklistItems,
} from "../../apps/control-plane-worker/src/github/pr";
import type { ReviewLoopEpochStatus } from "../../apps/control-plane-worker/src/services/review-loop-epochs";
import {
  ciFixExhausted,
  ciRedExhaustedForCurrentRed,
  reduceCiState,
  type ReviewLoopCiState,
  type ReviewLoopEpochSummary,
} from "../../apps/control-plane-worker/src/services/review-loop-rollup";

const run = (o: Partial<CommitCheckRun>): CommitCheckRun => ({
  id: o.id ?? 1,
  name: o.name ?? "ci",
  status: o.status ?? "completed",
  conclusion: o.conclusion ?? "success",
  appSlug: o.appSlug ?? null,
  appName: o.appName ?? null,
  detailsUrl: o.detailsUrl ?? null,
});

const ctx = (o: Partial<CommitStatusContext>): CommitStatusContext => ({
  id: o.id ?? 1,
  // Use !== undefined so that an explicit null is preserved (null context names are ignored by reduceCiState).
  context: o.context !== undefined ? o.context : "ctx",
  state: o.state ?? "success",
  description: o.description ?? null,
  targetUrl: o.targetUrl ?? null,
  creatorLogin: o.creatorLogin ?? null,
  creatorType: o.creatorType ?? null,
});

const epoch = (status: ReviewLoopEpochStatus, blockedReason: string | null = null): ReviewLoopEpochSummary => ({
  status,
  blockedReason,
});

// Source-tagged epoch builders for the CI-exhaustion predicate (sourceKind matters only there).
const ciEpoch = (status: ReviewLoopEpochStatus, blockedReason: string | null = null): ReviewLoopEpochSummary => ({
  status,
  blockedReason,
  sourceKind: "ci",
});
const botEpoch = (status: ReviewLoopEpochStatus, blockedReason: string | null = null): ReviewLoopEpochSummary => ({
  status,
  blockedReason,
  sourceKind: "bot",
});

describe("stale re-run check-runs wedge (mialabs/mia#3089 regression)", () => {
  // A PR-title validator re-ran on each title edit, leaving four stale `Validate PR Title` failures
  // and one later success on the same SHA, plus otherwise-green checks. Un-deduped, reduceCiState
  // read `failing` forever and the rollup stuck at `working` -> verification-pending never cleared.
  const wedgeRuns: CommitCheckRun[] = [
    run({ id: 1, name: "Validate PR Title", conclusion: "failure" }),
    run({ id: 2, name: "Validate PR Title", conclusion: "failure" }),
    run({ id: 3, name: "Validate PR Title", conclusion: "failure" }),
    run({ id: 4, name: "Validate PR Title", conclusion: "failure" }),
    run({ id: 9, name: "Validate PR Title", conclusion: "success" }),
    run({ id: 5, name: "test-core", conclusion: "success" }),
    run({ id: 6, name: "code-quality", conclusion: "success" }),
  ];

  it("raw (un-deduped) runs reproduce the failing verdict", () => {
    expect(reduceCiState(wedgeRuns, [])).toBe<ReviewLoopCiState>("failing");
    expect(failingCheckRunWorklistItems(wedgeRuns).length).toBeGreaterThan(0);
  });

  it("dedup to latest-per-name yields green CI and no failing worklist", () => {
    const deduped = dedupeLatestCheckRunsByName(wedgeRuns);
    expect(reduceCiState(deduped, [])).toBe<ReviewLoopCiState>("green");
    expect(failingCheckRunWorklistItems(deduped)).toHaveLength(0);
    // ARC-1330 D-59b: the done-claim this used to assert (via the deleted `computeReviewLoopRollup`)
    // now lives in the FSM `transition()` reducer; the green CI read above is the input that unwedges it.
  });
});

describe("reduceCiState", () => {
  it("empty both sources -> absent", () => {
    expect(reduceCiState([], [])).toBe<ReviewLoopCiState>("absent");
  });

  it("every FAILING_CHECK_RUN_CONCLUSIONS member yields failing (completed)", () => {
    for (const conclusion of FAILING_CHECK_RUN_CONCLUSIONS) {
      expect(reduceCiState([run({ status: "completed", conclusion })], [])).toBe("failing");
    }
  });

  it("excluded conclusions (cancelled/neutral/skipped/success) are NOT failing", () => {
    expect(reduceCiState([run({ status: "completed", conclusion: "cancelled" })], [])).toBe("absent");
    expect(reduceCiState([run({ status: "completed", conclusion: "neutral" })], [])).toBe("absent");
    expect(reduceCiState([run({ status: "completed", conclusion: "skipped" })], [])).toBe("absent");
    expect(reduceCiState([run({ status: "completed", conclusion: "success" })], [])).toBe("green");
  });

  it("pending check run dominates a failing one -> pending", () => {
    expect(
      reduceCiState(
        [run({ status: "in_progress", conclusion: null }), run({ status: "completed", conclusion: "failure" })],
        [],
      ),
    ).toBe("pending");
  });

  it("queued check run is pending", () => {
    expect(reduceCiState([run({ status: "queued", conclusion: null })], [])).toBe("pending");
  });

  it("failing dominates ok signal when nothing pending -> failing", () => {
    expect(
      reduceCiState(
        [run({ id: 1, conclusion: "success" }), run({ id: 2, status: "completed", conclusion: "failure" })],
        [],
      ),
    ).toBe("failing");
  });

  it("status contexts: failure and error are failing; success is ok; pending is pending", () => {
    expect(reduceCiState([], [ctx({ state: "failure" })])).toBe("failing");
    expect(reduceCiState([], [ctx({ state: "error" })])).toBe("failing");
    expect(reduceCiState([], [ctx({ state: "success" })])).toBe("green");
    expect(reduceCiState([], [ctx({ state: "pending" })])).toBe("pending");
  });

  it("status contexts: unknown state contributes neither signal", () => {
    expect(reduceCiState([], [ctx({ state: "expected" })])).toBe("absent");
  });

  it("status contexts: null context names are ignored", () => {
    expect(reduceCiState([], [ctx({ context: null, state: "failure" })])).toBe("absent");
  });

  it("collapses to the latest (highest id) context per name before classifying", () => {
    // older failure (id 1) superseded by newer success (id 2) for the SAME context name -> green.
    expect(
      reduceCiState(
        [],
        [ctx({ id: 1, context: "build", state: "failure" }), ctx({ id: 2, context: "build", state: "success" })],
      ),
    ).toBe("green");
    // reverse: newest is the failure -> failing.
    expect(
      reduceCiState(
        [],
        [ctx({ id: 5, context: "build", state: "success" }), ctx({ id: 3, context: "build", state: "failure" })],
      ),
    ).toBe("green"); // id 5 (success) is latest, wins
    expect(
      reduceCiState(
        [],
        [ctx({ id: 3, context: "build", state: "success" }), ctx({ id: 9, context: "build", state: "failure" })],
      ),
    ).toBe("failing"); // id 9 (failure) is latest
  });

  it("combines across both sources: any pending dominates", () => {
    expect(reduceCiState([run({ status: "queued", conclusion: null })], [ctx({ state: "failure" })])).toBe("pending");
  });

  it("combines across both sources: failing beats green when nothing pending", () => {
    expect(reduceCiState([run({ conclusion: "success" })], [ctx({ state: "failure" })])).toBe("failing");
  });
});

describe("ciRedExhaustedForCurrentRed — page gate excludes the timed-out pending-cap (ARC-1301 F2)", () => {
  // The ci-red label + Slack page must claim "exhausted CI-fix attempts" ONLY when the loop actually
  // tried to fix and gave up. The timed-out pending-wait cap (ci_checks_pending_cap_reached) never
  // attempted a fix — it posts its own PR comment — so it must NOT count toward the page gate, even
  // though it STAYS in ciFixExhausted/EXHAUSTED_BLOCKED_REASONS so the done-state still settles.
  it("counts a CI attempt-cap or a ci-source generic claim-cap, NOT the pending-cap", () => {
    // Genuine fix-attempt exhaustion fires the page.
    expect(ciRedExhaustedForCurrentRed([epoch("blocked", "ci_attempt_cap_reached")])).toBe(true);
    // A ci-source epoch that crash/reclaim-looped past the GENERIC claim cap is still a fix give-up.
    expect(ciRedExhaustedForCurrentRed([ciEpoch("blocked", "attempt_cap_reached")])).toBe(true);
    // Mixed: one capped ci epoch is enough.
    expect(ciRedExhaustedForCurrentRed([epoch("processing"), epoch("blocked", "ci_attempt_cap_reached")])).toBe(true);

    // The pending-cap is a wait timeout, not a fix exhaustion → excluded here (the F2 fix), even though
    // ciFixExhausted (the done-claim atom) DOES still count it.
    expect(ciRedExhaustedForCurrentRed([epoch("blocked", "ci_checks_pending_cap_reached")])).toBe(false);
    expect(ciFixExhausted([epoch("blocked", "ci_checks_pending_cap_reached")])).toBe(true);

    // Other non-exhaustion shapes stay false.
    expect(ciRedExhaustedForCurrentRed([])).toBe(false);
    expect(ciRedExhaustedForCurrentRed([epoch("processing")])).toBe(false);
    expect(ciRedExhaustedForCurrentRed([epoch("completed")])).toBe(false);
    expect(ciRedExhaustedForCurrentRed([epoch("blocked", "github_auth_lost")])).toBe(false);
    // Status guard: a cap reason on a non-blocked epoch doesn't count.
    expect(ciRedExhaustedForCurrentRed([epoch("completed", "ci_attempt_cap_reached")])).toBe(false);
    // The bare generic cap on a NON-ci epoch (comment loop giving up) is not CI exhaustion.
    expect(ciRedExhaustedForCurrentRed([botEpoch("blocked", "attempt_cap_reached")])).toBe(false);
  });
});

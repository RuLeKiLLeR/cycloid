// PR 10 — head + verdict record/restamp/clear action tests (ARC-1330, design §9 / §4 writer table).
//
// Pure-fn suite: each action is a pure function from its live-read inputs to the
// `FsmFieldWrites` partial the edge applies, so these import the fns directly and assert the
// exact returned write set per action — no DB harness. Load-bearing cases:
//   B1 — `record_verification(app_breaks)` PRESERVES `verification_run_count` (omits the key);
//        only an approving verdict (`pass`/`skipped`) resets it to 0.
//   B4 — `record`/`restamp` are the ONLY PR-10 writers of `verdict_head_sha`; `advance_head`
//        never writes it. (`request`/`redispatch` — the other half of B4, which also do NOT
//        write it — land in PR 11; this suite asserts the PR-10-available half.)
import { describe, expect, it } from "vitest";

import {
  advanceHead,
  clearVerification,
  recordVerification,
  restampVerification,
} from "../../../apps/control-plane-worker/src/session/fsm/actions";
import type { FsmFieldWrites, Verdict } from "../../../apps/control-plane-worker/src/session/fsm/types";

const HEAD = "abc123";
const NEW_HEAD = "def456";

describe("advance_head", () => {
  it("writes head_sha and clears the consumed update-branch marker (never verdict_head_sha — B4)", () => {
    const w = advanceHead(NEW_HEAD);
    expect(w).toEqual({ headSha: NEW_HEAD, updateBranchQueuedAt: null });
    // B4: advance_head must not stamp the verdict head — that is record/restamp's job.
    expect("verdictHeadSha" in w).toBe(false);
  });
});

describe("record_verification", () => {
  it("pass → verdict + verdict_head_sha := head + clears code_changed + resets run_count to 0", () => {
    expect(recordVerification("pass", HEAD)).toEqual({
      verdict: "pass",
      verdictHeadSha: HEAD,
      codeChangedSinceVerification: false,
      verificationRunCount: 0,
    });
  });

  it("skipped → same approving shape, run_count reset to 0", () => {
    expect(recordVerification("skipped", HEAD)).toEqual({
      verdict: "skipped",
      verdictHeadSha: HEAD,
      codeChangedSinceVerification: false,
      verificationRunCount: 0,
    });
  });

  it("B1: app_breaks records the verdict but PRESERVES run_count (no run_count key)", () => {
    const w = recordVerification("app_breaks", HEAD);
    expect(w).toEqual({
      verdict: "app_breaks",
      verdictHeadSha: HEAD,
      codeChangedSinceVerification: false,
    });
    // B1: a non-approving verdict must NOT reset the consecutive-failed-round counter.
    expect("verificationRunCount" in w).toBe(false);
  });

  it("a non-approving verdict (none) likewise preserves run_count", () => {
    const w = recordVerification("none", HEAD);
    expect("verificationRunCount" in w).toBe(false);
  });

  it("stamps verdict_head_sha := head AND clears code_changed in one write (D11/SF8 freshness)", () => {
    const w = recordVerification("pass", HEAD);
    expect(w.verdictHeadSha).toBe(HEAD);
    expect(w.codeChangedSinceVerification).toBe(false);
  });

  it("carries a null head through to verdict_head_sha (type-faithful)", () => {
    expect(recordVerification("pass", null).verdictHeadSha).toBeNull();
  });
});

describe("clear_verification", () => {
  it("drops the verdict: verdict := none, verdict_head_sha := null", () => {
    const w = clearVerification();
    expect(w).toEqual({ verdict: "none", verdictHeadSha: null });
    // Does NOT touch code_changed (set_code_changed owns that edge) or the run count.
    expect("codeChangedSinceVerification" in w).toBe(false);
    expect("verificationRunCount" in w).toBe(false);
  });
});

describe("restamp_verification", () => {
  it("moves ONLY verdict_head_sha := head, KEEPS verdict (no verdict key)", () => {
    const w = restampVerification(NEW_HEAD);
    expect(w).toEqual({ verdictHeadSha: NEW_HEAD });
    // restamp keeps the existing verdict — it must not write `verdict`.
    expect("verdict" in w).toBe(false);
  });
});

describe("B4 — verdict_head_sha writers (PR-10 half)", () => {
  it("record + restamp DO write verdict_head_sha; advance_head does NOT", () => {
    const writesVerdictHead = (w: FsmFieldWrites) => "verdictHeadSha" in w;
    expect(writesVerdictHead(recordVerification("pass", HEAD))).toBe(true);
    expect(writesVerdictHead(restampVerification(HEAD))).toBe(true);
    expect(writesVerdictHead(advanceHead(NEW_HEAD))).toBe(false);
  });

  it("covers record_verification over every Verdict (exhaustive over the closed enum)", () => {
    const ALL_VERDICTS = ["pass", "app_breaks", "skipped", "none"] as const satisfies readonly Verdict[];
    for (const v of ALL_VERDICTS) {
      expect(recordVerification(v, HEAD).verdictHeadSha).toBe(HEAD);
    }
  });
});

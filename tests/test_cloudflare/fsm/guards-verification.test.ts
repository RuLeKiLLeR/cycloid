// PR 8 — verification guard tests (ARC-1330, design §6 / D11 / SF8).
//
// The four merge-ready-conjunction input guards (named in the retained 'verification'
// vocabulary; the qa-rename is the QA owner's job):
//   verification_pass  := verdict ∈ {pass, skipped}              (§6 qa_pass)
//   verification_fresh := verdict_head_sha == head_sha           (§6 qa_fresh)
//   under_verification_cap := run_count < MAX_VERIFICATION_RUNS_PER_PR  (§6 under_qa_cap)
//   code_changed_since_verification := the stored bool           (§6 code_changed_since_qa)
//
// Plus the DIRECTIONAL implication (D11/SF8) that makes the cascade's row-8 catch-all
// residual cell (`pass ∧ ¬fresh ∧ ¬code_changed`) unreachable:
//   (¬code_changed ∧ verification_pass) ⟹ verification_fresh
// — TRUE because the sole writer of a pass verdict (`record_verification`) stamps
// `verdict_head_sha := head_sha` and clears `code_changed` in the SAME write. The v4
// BICONDITIONAL `pass ⟹ (fresh ⟺ ¬code_changed)` is FALSE in a reachable state (SF8)
// and is asserted NOT to hold here.
import { describe, expect, it } from "vitest";

import { MAX_VERIFICATION_RUNS_PER_PR } from "../../../apps/control-plane-worker/src/constants/verification";
import {
  codeChangedSinceVerification,
  underVerificationCap,
  verificationFresh,
  verificationPass,
} from "../../../apps/control-plane-worker/src/session/fsm/guards";
import type { Verdict } from "../../../apps/control-plane-worker/src/session/fsm/types";

const ALL_VERDICTS = ["pass", "app_breaks", "skipped", "none"] as const satisfies readonly Verdict[];

describe("verification_pass (verdict ∈ {pass, skipped})", () => {
  it("passes on pass and skipped only", () => {
    expect(verificationPass("pass")).toBe(true);
    expect(verificationPass("skipped")).toBe(true);
    expect(verificationPass("app_breaks")).toBe(false);
    expect(verificationPass("none")).toBe(false);
    expect(verificationPass(null)).toBe(false);
  });

  it("covers every Verdict value (exhaustive over the closed enum)", () => {
    const passing = ALL_VERDICTS.filter((v) => verificationPass(v));
    expect(new Set(passing)).toEqual(new Set<Verdict>(["pass", "skipped"]));
  });
});

describe("verification_fresh (verdict_head_sha == head_sha)", () => {
  it("is fresh when the recorded verdict head equals the live head", () => {
    expect(verificationFresh("sha-a", "sha-a")).toBe(true);
  });

  it("is stale when the recorded verdict head differs from the live head", () => {
    expect(verificationFresh("sha-a", "sha-b")).toBe(false);
  });

  it("is NOT fresh with no recorded verdict head (null verdict_head_sha)", () => {
    // No recorded verdict ⇒ nothing applies to the live head, even against a null head.
    expect(verificationFresh(null, "sha-a")).toBe(false);
    expect(verificationFresh(null, null)).toBe(false);
  });

  it("is NOT fresh against a null live head when a verdict head is recorded", () => {
    expect(verificationFresh("sha-a", null)).toBe(false);
  });
});

describe("under_verification_cap (run_count < MAX_VERIFICATION_RUNS_PER_PR)", () => {
  it("reuses the =3 per-PR constant", () => {
    expect(MAX_VERIFICATION_RUNS_PER_PR).toBe(3);
  });

  it("is true strictly below the cap and false at/above it", () => {
    expect(underVerificationCap(0)).toBe(true);
    expect(underVerificationCap(MAX_VERIFICATION_RUNS_PER_PR - 1)).toBe(true);
    expect(underVerificationCap(MAX_VERIFICATION_RUNS_PER_PR)).toBe(false);
    expect(underVerificationCap(MAX_VERIFICATION_RUNS_PER_PR + 1)).toBe(false);
  });
});

describe("code_changed_since_verification (the stored bool, §6/D12)", () => {
  it("reflects the stored bool", () => {
    expect(codeChangedSinceVerification(true)).toBe(true);
    expect(codeChangedSinceVerification(false)).toBe(false);
  });
});

describe("directional implication (¬code_changed ∧ pass) ⟹ fresh (D11/SF8)", () => {
  // Model of `record_verification(verdict)` (PR 10 owns the action; this is the writer
  // semantics it WILL implement, modeled locally so PR 8 can prove the implication from
  // the guards alone): a recorded verdict stamps `verdict_head_sha := head_sha` and
  // clears `code_changed`, atomically, against the live head at accept.
  function recordVerification(
    verdict: Verdict,
    headSha: string,
  ): { verdict: Verdict; verdictHeadSha: string; headSha: string; codeChanged: boolean } {
    return { verdict, verdictHeadSha: headSha, headSha, codeChanged: false };
  }

  it("every post-record state with ¬code_changed ∧ pass is fresh", () => {
    // The sole producer of a non-null pass verdict stamps fresh + clears code_changed
    // together, so the implication holds across every verdict it can record.
    for (const verdict of ALL_VERDICTS) {
      const s = recordVerification(verdict, "head-1");
      if (!codeChangedSinceVerification(s.codeChanged) && verificationPass(s.verdict)) {
        expect(verificationFresh(s.verdictHeadSha, s.headSha)).toBe(true);
      }
    }
  });

  it("the residual catch-all cell (pass ∧ ¬fresh ∧ ¬code_changed) is unreachable", () => {
    // `record_verification` stamps `verdict_head_sha := head_sha` AND clears `code_changed` in ONE
    // write (the directional implication, SF8), so every WRITER-PRODUCED ¬code_changed state has
    // `verdict_head_sha === head_sha` ⇒ fresh. We MODEL that writer state and assert the residual
    // cell (pass ∧ ¬code_changed ∧ ¬fresh) is therefore empty — a real `expect(fresh).toBe(true)`,
    // not the tautology `fresh === fresh` that an arbitrary (verdictHeadSha, headSha) cube would give.
    let assertedCells = 0;
    for (const verdict of ALL_VERDICTS) {
      for (const headSha of ["head-1", "head-2"]) {
        // The writer-produced state for an unchanged head: verdict_head_sha was stamped to the live head.
        const pass = verificationPass(verdict);
        const codeChanged = codeChangedSinceVerification(false); // record_verification cleared it
        const fresh = verificationFresh(headSha, headSha); // stamped := head ⇒ fresh
        if (pass && !codeChanged) {
          expect(fresh).toBe(true);
          assertedCells += 1;
        }
      }
    }
    // Guard against the implication-vacuity: the antecedent (pass ∧ ¬code_changed) is actually hit.
    expect(assertedCells).toBeGreaterThan(0);
  });

  it("does NOT assert the v4 biconditional pass ⟹ (fresh ⟺ ¬code_changed) (SF8)", () => {
    // The biconditional is FALSE in a reachable state: a recorded pass whose head was
    // then advanced by a content-noop (restamp keeps fresh) while code_changed was set by
    // a prior epoch — i.e. pass ∧ fresh ∧ code_changed — would violate `fresh ⟺ ¬code_changed`.
    const pass = verificationPass("pass");
    const fresh = verificationFresh("head-1", "head-1"); // restamped to the live head
    const codeChanged = codeChangedSinceVerification(true);
    expect(pass).toBe(true);
    expect(fresh).toBe(true);
    expect(codeChanged).toBe(true);
    // fresh ⟺ ¬code_changed would be true ⟺ false = FALSE: the biconditional does NOT hold,
    // confirming we must rely on the directional implication only.
    const biconditional = fresh === !codeChanged;
    expect(biconditional).toBe(false);
  });
});

// PR 11 — verification dispatch + teardown action tests (ARC-1330, design §9 / §7 bucket b).
//
// Pure-fn suite (no DB harness): each dispatch action is a pure function from its live-read
// inputs to the `FsmFieldWrites` partial the edge applies, and `kill_verification` is a pure
// SideEffect DESCRIPTOR builder. Load-bearing cases:
//   B1 — `request_verification` is the ONLY run-count writer (`+= 1`); `redispatch_verification`
//        NEVER touches `verification_run_count` (in-VERIFYING re-run / resume burns no round).
//   B4 — NEITHER `request` nor `redispatch` writes `verdict_head_sha`; both write
//        `verification_run_head` + bump the monotonic `verification_run_id`.
//   W11-V4 — both run-minting writers ALSO reset `verification_child_id := null` so the per-run spawn
//        idempotency anchor reads a clean child slot at run start (a non-null child on run R then means
//        run R's spawn already landed). The kill on the redispatch edge captured the old handle pre-write.
//   FG-1 — `kill_verification` is run-scoped: it echoes the handle it is GIVEN (the verdict's
//        run on the ghost edge), idempotent re-kill of an already-dead child, null-safe; it
//        never reaches for the active run on its own.
import { describe, expect, it } from "vitest";

import {
  killVerification,
  redispatchVerification,
  requestVerification,
} from "../../../apps/control-plane-worker/src/session/fsm/actions";
import type { FsmFieldWrites } from "../../../apps/control-plane-worker/src/session/fsm/types";

const HEAD = "abc123";
const NEW_HEAD = "def456";

describe("request_verification", () => {
  it("burns a run (count += 1), bumps run_id (+= 1), stamps run_head := head, clears child (W11-V4)", () => {
    expect(requestVerification(0, 0, HEAD)).toEqual({
      verificationRunCount: 1,
      verificationRunHead: HEAD,
      verificationRunId: 1,
      verificationChildId: null,
    });
  });

  it("increments from arbitrary live-read current values (pure of its inputs)", () => {
    expect(requestVerification(2, 7, NEW_HEAD)).toEqual({
      verificationRunCount: 3,
      verificationRunHead: NEW_HEAD,
      verificationRunId: 8,
      verificationChildId: null,
    });
  });

  it("B4: does NOT stamp verdict_head_sha", () => {
    expect("verdictHeadSha" in requestVerification(0, 0, HEAD)).toBe(false);
  });

  it("carries a null head through to run_head (type-faithful)", () => {
    expect(requestVerification(0, 0, null).verificationRunHead).toBeNull();
  });
});

describe("redispatch_verification", () => {
  it("re-points the run (run_head := head, run_id += 1, clears child W11-V4) but does NOT touch run_count (B1)", () => {
    const w = redispatchVerification(4, NEW_HEAD);
    expect(w).toEqual({
      verificationRunHead: NEW_HEAD,
      verificationRunId: 5,
      verificationChildId: null,
    });
    // B1: re-running the in-flight round (head churn / stop-resume) is not a REVIEW→VERIFYING
    // dispatch, so it must not consume a run.
    expect("verificationRunCount" in w).toBe(false);
  });

  it("B4: does NOT stamp verdict_head_sha", () => {
    expect("verdictHeadSha" in redispatchVerification(0, HEAD)).toBe(false);
  });

  it("carries a null head through to run_head (type-faithful)", () => {
    expect(redispatchVerification(0, null).verificationRunHead).toBeNull();
  });
});

describe("B1/B4 — run-count + verdict-head writer split", () => {
  it("request is the ONLY run-count writer; redispatch never writes it", () => {
    const writesRunCount = (w: FsmFieldWrites) => "verificationRunCount" in w;
    expect(writesRunCount(requestVerification(0, 0, HEAD))).toBe(true);
    expect(writesRunCount(redispatchVerification(0, HEAD))).toBe(false);
  });

  it("both dispatch writers bump run_id by exactly 1 and write run_head, never verdict_head", () => {
    for (const w of [requestVerification(1, 9, HEAD), redispatchVerification(9, HEAD)]) {
      expect(w.verificationRunId).toBe(10);
      expect(w.verificationRunHead).toBe(HEAD);
      expect("verdictHeadSha" in w).toBe(false);
    }
  });
});

describe("kill_verification (run-scoped teardown — FG-1)", () => {
  it("returns a kill_verification SideEffect targeting the GIVEN run's child handle", () => {
    expect(killVerification("child-1")).toEqual({
      kind: "kill_verification",
      args: { verificationChildId: "child-1" },
    });
  });

  it("kill targets the verdict's run, NOT the active run (echoes only the handle it is given)", () => {
    // Ghost-discard edge: the active run is `activeChild`; the verdict's (superseded) run is
    // `ghostChild`. kill_verification must target the ghost the caller passes — never the active.
    const activeChild = "active-run-child";
    const ghostChild = "ghost-run-child";
    const eff = killVerification(ghostChild);
    expect(eff.args?.verificationChildId).toBe(ghostChild);
    expect(eff.args?.verificationChildId).not.toBe(activeChild);
  });

  it("idempotent re-kill: an already-dead child yields the same well-formed descriptor", () => {
    expect(killVerification("dead-child")).toEqual(killVerification("dead-child"));
  });

  it("null handle (no child ever spawned) still yields a well-formed no-op descriptor", () => {
    expect(killVerification(null)).toEqual({
      kind: "kill_verification",
      args: { verificationChildId: null },
    });
  });
});

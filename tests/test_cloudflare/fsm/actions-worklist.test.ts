// PR 13 — worklist registration + resolve action tests (ARC-1330, design §9 / §13 / FG-5).
//
// Pure-fn suite (no DB harness): each action is a pure descriptor builder from its live-read
// inputs. Load-bearing cases:
//   register_review — mints a SINGLE undispositioned ("none") actionable item keyed by the review
//                     source id (Defect 3 / B6: registered, not consumed, so caught_up stays false).
//                     (A4 retired `inject_findings`: QA re-intake rides the managed comment, not the spine.)
//   committed bucket — the registrations ride the Decision's COMMITTED bucket (a)
//                     (`worklistRegistrations`), NOT the after-commit `sideEffects` bag (bucket b):
//                     they are durable BEFORE any `caught_up` recompute reads the worklist (FG-5).
//                     The structural distinction (a WorklistRegistration is NOT a SideEffect — it has
//                     no `kind`) IS the "registration is committed pre-recompute" guarantee here.
//   resolve_owned_threads — the after-commit (bucket b) side-effect descriptor.
import { describe, expect, it } from "vitest";

import { registerReview, resolveOwnedThreads } from "../../../apps/control-plane-worker/src/session/fsm/actions";
import type {
  Decision,
  SideEffect,
  WorklistRegistration,
} from "../../../apps/control-plane-worker/src/session/fsm/types";

describe("register_review", () => {
  it("mints a single undispositioned actionable item keyed by the review source id", () => {
    expect(registerReview("review-src-7")).toEqual({
      sourceId: "review-src-7",
      origin: "review",
      disposition: "none",
    });
  });

  it("always registers as UNDISPOSITIONED (none), never pre-dispositioned (B6: keeps caught_up false)", () => {
    expect(registerReview("anything").disposition).toBe("none");
  });
});

describe("inject_findings is retired (A4)", () => {
  it("is no longer exported (QA re-intake now rides the managed QA comment, not the FSM spine)", async () => {
    const actions = await import("../../../apps/control-plane-worker/src/session/fsm/actions");
    expect("injectFindings" in actions).toBe(false);
  });
});

describe("registration is committed pre-recompute (FG-5 / §6 ordering)", () => {
  it("registrations ride the Decision COMMITTED bucket (a), NOT the after-commit sideEffects (b)", () => {
    // The entering transition carries the registrations in `worklistRegistrations` (committed in the
    // SAME CAS as fieldWrites, before the separate caught_up read) — never in `sideEffects`.
    const registrations: readonly WorklistRegistration[] = [registerReview("r1")];
    const decision: Decision = {
      to: "REVIEW",
      fieldWrites: { codeChangedSinceVerification: true },
      sideEffects: [],
      worklistRegistrations: registrations,
    };
    expect(decision.worklistRegistrations).toHaveLength(1);
    expect(decision.sideEffects).toHaveLength(0);
  });

  it("a WorklistRegistration is structurally NOT a SideEffect (no `kind`) — can't be mistaken for bucket b", () => {
    expect("kind" in registerReview("x")).toBe(false);
  });
});

describe("resolve_owned_threads", () => {
  it("returns the after-commit (bucket b) side-effect descriptor", () => {
    const effect: SideEffect = resolveOwnedThreads();
    expect(effect).toEqual({ kind: "resolve_owned_threads" });
  });

  it("is a side-effect (has `kind`), NOT a committed worklist registration", () => {
    expect("kind" in resolveOwnedThreads()).toBe(true);
    expect("disposition" in resolveOwnedThreads()).toBe(false);
  });
});

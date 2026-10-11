// ARC-1330 §17-A run-identity carry/echo (PR 23). Proves the verification verdict → spine-event mapper
// (`fsmEventFromVerifierResult`) echoes the carried `verification_run_id`, and that the echoed token drives
// the spine's run-scoped verdict freshness end-to-end: the H→H′→H ABA case (a late verdict from a SUPERSEDED
// run is rejected, never a stale-pass false accept) and the run-scoped `kill_verification` (the ghost-discard
// kills the VERDICT's-run child handle, not the live run's). Pure-fn suite — mapper + `transition`, no DB.
import { describe, expect, it } from "vitest";

import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import { fsmEventFromVerifierResult } from "../../../apps/control-plane-worker/src/session/fsm/verification-event";
import type { VerifierTerminalResult } from "../../../shared/types/sandbox";

// Minimal well-formed VerifierTerminalResult; each test overrides only the carry/echo fields it exercises.
const verifierResult = (over: Partial<VerifierTerminalResult> = {}): VerifierTerminalResult => ({
  verdict: "CONCLUSIVE",
  verifiedHeadSha: "headH",
  summary: "ok",
  evidence: [],
  blockers: [],
  ...over,
});

// VERIFYING guard bag mirroring transition-verifying.test.ts: run 6 is the ACTIVE run (the freshness anchor),
// `child-active` its handle (killed on a real exit), `child-ghost` the spine-resolved VERDICT's-run handle
// (killed ONLY by the FG-1 ghost-discard — a DIFFERENT handle, by FG-1).
const VERIFYING_BASE: Guards = {
  sandboxAlive: true,
  verificationRunId: 6,
  verificationChildId: "child-active",
  verdictVerificationChildId: "child-ghost",
  findingSourceIds: [],
  reviewSourceId: "rev-src",
};
const g = (over: Partial<Guards> = {}): Guards => ({ ...VERIFYING_BASE, ...over });

const KILL_ACTIVE = { kind: "kill_verification", args: { verificationChildId: "child-active" } } as const;
const KILL_GHOST = { kind: "kill_verification", args: { verificationChildId: "child-ghost" } } as const;
const RELEASE = { kind: "release_queued_reviews" } as const;

describe("fsmEventFromVerifierResult — verdict → spine event (run_id echo)", () => {
  it("CONCLUSIVE → verification.pass, echoing verificationRunId + verifiedHeadSha", () => {
    const event = fsmEventFromVerifierResult(
      verifierResult({ verdict: "CONCLUSIVE", verifiedHeadSha: "abc", verificationRunId: 6 }),
    );
    expect(event).toEqual({ type: "verification.pass", headSha: "abc", runId: 6 });
  });

  it("INCONCLUSIVE → verification.app_breaks, echoing verificationRunId + verifiedHeadSha", () => {
    const event = fsmEventFromVerifierResult(
      verifierResult({ verdict: "INCONCLUSIVE", verifiedHeadSha: "def", verificationRunId: 4 }),
    );
    expect(event).toEqual({ type: "verification.app_breaks", headSha: "def", runId: 4 });
  });

  it("missing verificationRunId → null (no token ⇒ no spine verdict; fails toward NOT-fresh, never a token-less accept)", () => {
    expect(fsmEventFromVerifierResult(verifierResult({ verificationRunId: undefined }))).toBeNull();
  });
});

describe("§17-A carry/echo end-to-end — the echoed run_id drives spine freshness", () => {
  it("fresh verdict (echoed run_id == active) → REVIEW / record_verification + drain + kill(active)", () => {
    // The active run is 6; the child echoes run 6 → fresh accept.
    const event = fsmEventFromVerifierResult(
      verifierResult({ verdict: "CONCLUSIVE", verifiedHeadSha: "headH", verificationRunId: 6 }),
    );
    const d = transition("VERIFYING", event!, g());
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: {
        verdict: "pass",
        verdictHeadSha: "headH",
        codeChangedSinceVerification: false,
        verificationRunCount: 0,
      },
      sideEffects: [RELEASE, KILL_ACTIVE],
    });
  });

  it("H→H′→H ABA ghost (echoed run_id of a SUPERSEDED run) → VERIFYING / log_noop, kill resolves the VERDICT's child — NOT an exit, NO drain, NO record", () => {
    // ABA: head went H (run 5) → H′ (redispatch ⇒ run 6) → reverted back to H. A late verdict from run 5
    // (validated at the ORIGINAL H) arrives — its head matches the live head again, but run 5 ≠ active run 6,
    // so head-only identity would FALSE-ACCEPT a stale pass; run-scoped identity rejects it.
    const ghost = fsmEventFromVerifierResult(
      verifierResult({ verdict: "CONCLUSIVE", verifiedHeadSha: "headH", verificationRunId: 5 }),
    );
    expect(ghost).toEqual({ type: "verification.pass", headSha: "headH", runId: 5 });
    const d = transition("VERIFYING", ghost!, g());
    expect(d).toEqual({
      to: "VERIFYING",
      fieldWrites: {},
      // kill is RUN-SCOPED to the verdict's (already-dead) run via verdictVerificationChildId, never the live run.
      sideEffects: [{ kind: "log_noop" }, KILL_GHOST],
    });
    expect(d?.sideEffects).not.toContainEqual(RELEASE);
    expect(d?.sideEffects).not.toContainEqual(KILL_ACTIVE);
  });
});

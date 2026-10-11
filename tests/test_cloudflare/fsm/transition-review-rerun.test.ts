// A4 — the bounded QA re-run arm on the REVIEW `epoch.committed` edge. When a review epoch fixes a
// QA-sourced finding (a `known:cycloid-qa` item) and the head advanced past the verified head, QA respawns
// to re-verify — under the per-PR run cap. Pure-fn suite: `transition(state, event, guards)` is pure, so the
// re-run inputs are threaded as guards (the live resolver sources them from the record + the committed epoch).
import { describe, expect, it } from "vitest";

import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";

const SPAWN = { kind: "spawn_verification_child" } as const;
const COMMITTED = { type: "epoch.committed", epochId: "e1" } as const;

// A fully-populated REVIEW guard bag for the re-run arm; each test overrides only the conjunct it exercises.
const BASE: Guards = {
  sandboxAlive: true,
  committedHead: "newhead",
  currentHeadSha: "newhead",
  verdictHeadSha: "oldhead",
  // The prior (app_breaks) run was requested at the verified head; the fix has since advanced the live head.
  verificationRunHead: "oldhead",
  recordedVerdict: "app_breaks",
  verificationRunCount: 1,
  verificationRunId: 3,
  committedEpochDispositionedQaFinding: true,
};
const g = (over: Partial<Guards> = {}): Guards => ({ ...BASE, ...over });

describe("epoch.committed → QA re-run arm (A4)", () => {
  it("respawns QA when a QA-sourced finding was fixed, verdict app_breaks, head advanced, under cap", () => {
    const d = transition("REVIEW", COMMITTED, g());
    expect(d?.to).toBe("REVIEW");
    expect(d?.sideEffects).toContainEqual(SPAWN);
    // requestVerification burns a run + repoints the run head + mints a fresh run id + nulls the child handle.
    expect(d?.fieldWrites).toMatchObject({
      verificationRunCount: 2,
      verificationRunHead: "newhead",
      verificationRunId: 4,
      verificationChildId: null,
    });
  });

  it("does NOT respawn when the committed epoch touched no QA-sourced finding", () => {
    const d = transition("REVIEW", COMMITTED, g({ committedEpochDispositionedQaFinding: false }));
    expect(d?.sideEffects).not.toContainEqual(SPAWN);
    expect(d?.fieldWrites).not.toHaveProperty("verificationRunCount");
  });

  it("does NOT respawn when the recorded verdict is not app_breaks", () => {
    for (const verdict of ["pass", "skipped", "none", null] as const) {
      const d = transition("REVIEW", COMMITTED, g({ recordedVerdict: verdict }));
      expect(d?.sideEffects).not.toContainEqual(SPAWN);
    }
  });

  it("does NOT respawn when the head did not advance past the verified head", () => {
    const d = transition("REVIEW", COMMITTED, g({ verdictHeadSha: "newhead" }));
    expect(d?.sideEffects).not.toContainEqual(SPAWN);
  });

  it("does NOT respawn when the current head is unknown (fail toward no re-run)", () => {
    const d = transition("REVIEW", COMMITTED, g({ currentHeadSha: null }));
    expect(d?.sideEffects).not.toContainEqual(SPAWN);
  });

  it("does NOT respawn when the run cap is reached (NEEDS_YOU is the terminal, not another run)", () => {
    const d = transition("REVIEW", COMMITTED, g({ verificationRunCount: 3 }));
    expect(d?.sideEffects).not.toContainEqual(SPAWN);
  });

  it("does NOT respawn a second time when a run is already in flight at the current head (redelivered epoch.committed)", () => {
    // After the first arm `requestVerification` stamps `verification_run_head = currentHeadSha`. A redelivered /
    // retried `epoch.committed` for the same committed epoch must NOT spawn a duplicate verifier or burn a
    // second run — `verdictHeadSha` still lags so `headAdvanced` alone would (wrongly) stay true.
    const d = transition("REVIEW", COMMITTED, g({ verificationRunHead: "newhead" }));
    expect(d?.sideEffects).not.toContainEqual(SPAWN);
    expect(d?.fieldWrites).not.toHaveProperty("verificationRunCount");
    // The ordinary committed bookkeeping still applies (idempotent re-application is otherwise harmless).
    expect(d?.sideEffects).toContainEqual({ kind: "disposition", args: { epochId: "e1", disposition: "fixed" } });
  });

  it("still records the ordinary committed writes + fixed disposition + thread resolution (re-run OR not)", () => {
    for (const guards of [g(), g({ committedEpochDispositionedQaFinding: false })]) {
      const d = transition("REVIEW", COMMITTED, guards);
      expect(d?.fieldWrites).toMatchObject({ headSha: "newhead", codeChangedSinceVerification: true });
      expect(d?.sideEffects).toContainEqual({ kind: "disposition", args: { epochId: "e1", disposition: "fixed" } });
      expect(d?.sideEffects).toContainEqual({ kind: "resolve_owned_threads" });
    }
  });
});

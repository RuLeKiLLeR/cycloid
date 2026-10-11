// ARC-1330 (PR 35) — LEGACY-ADAPTER parity (F47).
//
// Proves the adapter record feeds the SAME pure `project()` to reproduce the legacy session's
// user-facing surface until the spine row is populated:
//   • `phase` parity holds for EVERY non-`idle` legacy phase (the FE pill is correct).
//   • `cycloid_done` parity holds by construction for the well-defined phases (`completed`, `blocked`,
//     the pre-PR `working` phases).
//   • the verification `verdict` threads through to the REVIEW / VERIFYING labels.
import { describe, expect, it } from "vitest";

import {
  type LegacyAdapterInput,
  legacyAdapterRecord,
} from "../../../apps/control-plane-worker/src/session/fsm/legacy-adapter";
import { project } from "../../../apps/control-plane-worker/src/session/fsm/project";
import type { CycloidDoneReason, CycloidDoneStatus, Phase } from "../../../shared/session/phase";

const WORKING: CycloidDoneStatus = { state: "working", outcome: null, reasons: [] };
const DONE_SUCCESS: CycloidDoneStatus = { state: "done", outcome: "success", reasons: [] };

function input(overrides: Partial<LegacyAdapterInput> & { phase: Exclude<Phase, "idle"> }): LegacyAdapterInput {
  return {
    sessionId: "sess-1",
    prUrl: null,
    headSha: null,
    verificationState: null,
    verificationResult: null,
    reviewLoopDoneState: null,
    cycloidDone: WORKING,
    ...overrides,
  };
}

describe("legacyAdapterRecord — phase parity (F47)", () => {
  const cases: ReadonlyArray<[string, LegacyAdapterInput]> = [
    ["running", input({ phase: "running" })],
    ["waiting_for_input", input({ phase: "waiting_for_input" })],
    ["finalizing", input({ phase: "finalizing" })],
    ["review_listening (REVIEW)", input({ phase: "review_listening" })],
    [
      "review_listening (VERIFYING)",
      input({ phase: "review_listening", verificationState: "verification-in-progress" }),
    ],
    ["completed (no PR)", input({ phase: "completed" })],
    ["completed (merge-ready)", input({ phase: "completed", prUrl: "https://gh/x/pull/1", cycloidDone: DONE_SUCCESS })],
    ["completed (merged PR)", input({ phase: "completed", prUrl: "https://gh/x/pull/1" })],
    ["blocked", input({ phase: "blocked" })],
    ["failed", input({ phase: "failed" })],
    ["stopped", input({ phase: "stopped" })],
    ["superseded", input({ phase: "superseded" })],
    ["archived", input({ phase: "archived" })],
  ];

  for (const [name, legacy] of cases) {
    it(`reproduces legacy phase '${legacy.phase}' (${name})`, () => {
      expect(project(legacyAdapterRecord(legacy)).phase).toBe(legacy.phase);
    });
  }

  it("maps legacy 'superseded' to its own SUPERSEDED terminal (ARC-1389 — the former lossy edge round-trips)", () => {
    // `superseded` (publish benignly overtaken) now has a distinct FSM state; the CLOSED stopgap (which
    // projected `completed` and broke phase parity for exactly this phase) is gone.
    const rec = legacyAdapterRecord(input({ phase: "superseded" }));
    expect(rec.state).toBe("SUPERSEDED");
    expect(project(rec).phase).toBe("superseded");
  });
});

describe("legacyAdapterRecord — cycloid_done parity", () => {
  it("pre-PR working phases project a working done aggregate", () => {
    for (const phase of ["running", "waiting_for_input", "finalizing"] as const) {
      expect(project(legacyAdapterRecord(input({ phase }))).cycloidDone).toEqual(WORKING);
    }
  });

  it("completed + done/success → MERGE_READY projects done/success", () => {
    const rec = legacyAdapterRecord(
      input({ phase: "completed", prUrl: "https://gh/x/pull/1", cycloidDone: DONE_SUCCESS }),
    );
    expect(rec.state).toBe("MERGE_READY");
    expect(project(rec).cycloidDone).toEqual(DONE_SUCCESS);
  });

  it("completed merged PR (working) projects a working done aggregate", () => {
    const rec = legacyAdapterRecord(input({ phase: "completed", prUrl: "https://gh/x/pull/1" }));
    expect(rec.state).toBe("MERGED");
    expect(project(rec).cycloidDone).toEqual(WORKING);
  });

  it("blocked + each degraded reason → NEEDS_YOU reproduces done/needs_attention with that reason", () => {
    const reasons: CycloidDoneReason[] = [
      "ci_red",
      "verification_exhausted",
      "verification_stopped",
      "verification_inconclusive",
    ];
    for (const reason of reasons) {
      const cycloidDone: CycloidDoneStatus = { state: "done", outcome: "needs_attention", reasons: [reason] };
      const rec = legacyAdapterRecord(input({ phase: "blocked", cycloidDone }));
      expect(rec.state).toBe("NEEDS_YOU");
      expect(project(rec).cycloidDone).toEqual(cycloidDone);
    }
  });

  it("blocked human-action (owner-approval, no done reason) projects working", () => {
    const rec = legacyAdapterRecord(input({ phase: "blocked", cycloidDone: WORKING }));
    expect(rec.state).toBe("NEEDS_YOU");
    expect(rec.blockedReason).toBe("owner_approval");
    expect(project(rec).cycloidDone).toEqual(WORKING);
  });
});

describe("legacyAdapterRecord — verification verdict threads through (PR-E1: labels scrapped)", () => {
  it("review_listening + verification-done/needs-work stamps app_breaks; no managed label (scrapped)", () => {
    const rec = legacyAdapterRecord(
      input({
        phase: "review_listening",
        verificationState: "verification-done",
        verificationResult: "needs-work",
      }),
    );
    expect(rec.state).toBe("REVIEW");
    expect(rec.verdict).toBe("app_breaks");
    // PR-E1: QA is a parallel signal now, not a gating label — REVIEW projects no managed label.
    expect(project(rec).labels).toEqual([]);
  });

  it("review_listening + verification-in-progress → VERIFYING projects no label (drain-only, scrapped)", () => {
    const rec = legacyAdapterRecord(
      input({ phase: "review_listening", verificationState: "verification-in-progress" }),
    );
    expect(rec.state).toBe("VERIFYING");
    expect(project(rec).labels).toEqual([]);
  });
});

// ARC-1330 W11 — verdict-stamp spine counterpart (D-59 fold). The live head producer now ALSO maintains
// the LEGACY session verification store on a head advance (`syncLegacyVerificationStoreForHeadChange`), so
// the standalone `clearVerificationVerdictForHeadChange` / `stampVerificationVerdictHeadForHeadChange` calls
// in webhooks/github.ts become provably redundant and the D-59 residue fold (deferred #6523) can delete them.
//
// These tests pin the counterpart's semantics EXACTLY to the legacy writers': clear-on-real-change,
// restamp-on-noop (to the NEW head — the value the ARC-1243 scheduler skip-gate compares), the never-wipe
// active-run guard, the needless-write guard, and LIVE-only (shadow stays observe-only). The dynamic imports
// inside the helper (`../state`, `../verification-state`) and `./apply-event` are module-mocked so the unit
// is drivable without a DO/D1/GitHub harness (the repo's vi.hoisted idiom).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  closeSessionState: vi.fn(),
  clearVerificationVerdictForHeadChange: vi.fn(async () => {}),
  stampVerificationVerdictHeadForHeadChange: vi.fn(async () => {}),
  applyEvent: vi.fn(async () => ({ outcome: "handled", to: "REVIEW" })),
}));

// `../state` is also statically imported by live-side-effects (getSessionState + closeSessionState); provide
// both so that module's bindings resolve at load.
vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: mocks.getSessionState,
  closeSessionState: mocks.closeSessionState,
}));

vi.mock("../../../apps/control-plane-worker/src/session/verification-state", () => ({
  clearVerificationVerdictForHeadChange: mocks.clearVerificationVerdictForHeadChange,
  stampVerificationVerdictHeadForHeadChange: mocks.stampVerificationVerdictHeadForHeadChange,
}));

// Keep the real `parseFsmMode` (the helper + producer gate on it); only `applyEvent` is stubbed so the
// wiring test drives `shadowEmitHeadChange` at live without the live resolver's GitHub CI read.
vi.mock("../../../apps/control-plane-worker/src/session/fsm/apply-event", async () => {
  const actual = await vi.importActual<typeof import("../../../apps/control-plane-worker/src/session/fsm/apply-event")>(
    "../../../apps/control-plane-worker/src/session/fsm/apply-event",
  );
  return { ...actual, applyEvent: mocks.applyEvent };
});

import {
  classifyHeadChange,
  shadowEmitHeadChange,
  syncLegacyVerificationStoreForHeadChange,
} from "../../../apps/control-plane-worker/src/session/fsm/head-producer";
import type { Env, SessionState } from "../../../apps/control-plane-worker/src/types";

const PR_URL = "https://github.com/o/r/pull/1";

function liveEnv(): Env {
  return { DB: { prepare: () => ({}) }, FSM_MODE: "live" } as unknown as Env;
}

/** A settled (non-awaiting) verdict on the OLD head — the state the head-change maintenance acts on. */
function settledSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    verificationState: "verification-done",
    verificationResult: "merge-ready",
    verificationVerdictHeadSha: "h1",
    verificationAttemptCount: 1,
    verificationMaxAttempts: 3,
    reviewListeningPrUrl: PR_URL,
    ...overrides,
  } as unknown as SessionState;
}

const realChange = classifyHeadChange({ headSha: "h2", prevHeadSha: "h1", isContentNoop: false });
const noopChange = classifyHeadChange({ headSha: "h2", prevHeadSha: "h1", isContentNoop: true });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyEvent.mockResolvedValue({ outcome: "handled", to: "REVIEW" } as never);
});

describe("D-59 counterpart — syncLegacyVerificationStoreForHeadChange", () => {
  it("head.changed at live CLEARS the session verdict store (real change → force re-QA)", async () => {
    mocks.getSessionState.mockResolvedValue(settledSession());
    await syncLegacyVerificationStoreForHeadChange(liveEnv(), "sess-1", realChange);

    expect(mocks.clearVerificationVerdictForHeadChange).toHaveBeenCalledTimes(1);
    expect(mocks.clearVerificationVerdictForHeadChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prUrl: PR_URL, sessionId: "sess-1" }),
    );
    expect(mocks.stampVerificationVerdictHeadForHeadChange).not.toHaveBeenCalled();
  });

  it("head.noop_changed at live RESTAMPS the verdict head to the NEW head (noop → preserve verdict, ARC-1243 skip stays valid)", async () => {
    mocks.getSessionState.mockResolvedValue(settledSession());
    await syncLegacyVerificationStoreForHeadChange(liveEnv(), "sess-1", noopChange);

    // The restamp writes verdict_head_sha := the NEW head "h2". That is EXACTLY the value the ARC-1243
    // scheduler skip-gate compares (`currentVerificationVerdictHeadSha === headSha`), which
    // verification-auto-scheduler.test.ts ("skips re-scheduling when a settled verdict is stamped for THIS
    // head") proves yields `verdict_already_settled` — so the settled verdict on unchanged content still
    // skips re-verification.
    expect(mocks.stampVerificationVerdictHeadForHeadChange).toHaveBeenCalledTimes(1);
    expect(mocks.stampVerificationVerdictHeadForHeadChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "sess-1",
        headSha: "h2",
        currentState: "verification-done",
        attemptCount: 1,
        maxAttempts: 3,
      }),
    );
    expect(mocks.clearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
  });

  it("head.changed does NOT clear a store already stamped for the NEW head — the head-scoped clear (race: a declining spawn wrote a current-head verification-stopped, ChatGPT P2 #6527)", async () => {
    // The FSM spawn side-effect can DECLINE (checkVerificationConflict) and write a CURRENT-head terminal
    // state for the new head. The pre-spawn ordering (shadowEmitHeadChange runs this before applyEvent
    // queues the spawn) is the primary guard; this head-scope check is belt-and-braces: even if the helper
    // observed such a state, `verificationVerdictHeadSha === the new head` marks it validated for the new
    // head — not a stale prior-head verdict — so it is left untouched rather than erased.
    mocks.getSessionState.mockResolvedValue(
      settledSession({
        verificationState: "verification-stopped",
        verificationResult: null,
        verificationVerdictHeadSha: "h2",
      }),
    );
    await syncLegacyVerificationStoreForHeadChange(liveEnv(), "sess-1", realChange);
    expect(mocks.clearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
    expect(mocks.stampVerificationVerdictHeadForHeadChange).not.toHaveBeenCalled();
  });

  it("head.changed DOES clear a genuine prior-head verdict (verdict stamped for the OLD head)", async () => {
    // Counterpart to the head-scope test above: a verdict stamped for a head OTHER than the new head is
    // stale and must be cleared so it cannot bind to the new head.
    mocks.getSessionState.mockResolvedValue(
      settledSession({
        verificationState: "verification-done",
        verificationResult: "needs-work",
        verificationVerdictHeadSha: "h1",
      }),
    );
    await syncLegacyVerificationStoreForHeadChange(liveEnv(), "sess-1", realChange);
    expect(mocks.clearVerificationVerdictForHeadChange).toHaveBeenCalledTimes(1);
  });

  it("NEVER wipes an active run — verification-in-progress is skipped (clearing it would drop the running verifier's state)", async () => {
    mocks.getSessionState.mockResolvedValue(
      settledSession({ verificationState: "verification-in-progress", verificationResult: null }),
    );
    await syncLegacyVerificationStoreForHeadChange(liveEnv(), "sess-1", realChange);
    expect(mocks.clearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
    expect(mocks.stampVerificationVerdictHeadForHeadChange).not.toHaveBeenCalled();
  });

  it("skips when there is no settled verdict to maintain (the legacy needless-write guard)", async () => {
    mocks.getSessionState.mockResolvedValue(settledSession({ verificationState: null, verificationResult: null }));
    await syncLegacyVerificationStoreForHeadChange(liveEnv(), "sess-1", realChange);
    await syncLegacyVerificationStoreForHeadChange(liveEnv(), "sess-1", noopChange);
    expect(mocks.clearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
    expect(mocks.stampVerificationVerdictHeadForHeadChange).not.toHaveBeenCalled();
  });

  it("head.changed cannot clear without a PR url on the session (targeting fail-safe)", async () => {
    mocks.getSessionState.mockResolvedValue(settledSession({ reviewListeningPrUrl: null }));
    await syncLegacyVerificationStoreForHeadChange(liveEnv(), "sess-1", realChange);
    expect(mocks.clearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
  });

  it("a session-read/writer fault is swallowed (best-effort — never perturbs the committed spine transition)", async () => {
    mocks.getSessionState.mockRejectedValue(new Error("DO unreachable"));
    await expect(syncLegacyVerificationStoreForHeadChange(liveEnv(), "sess-1", realChange)).resolves.toBeUndefined();
  });
});

describe("D-59 counterpart — shadowEmitHeadChange wiring", () => {
  it("at live, runs the legacy-store maintenance BEFORE applyEvent (pre-spawn ordering closes the spawn race, #6527)", async () => {
    mocks.getSessionState.mockResolvedValue(settledSession());
    await shadowEmitHeadChange(liveEnv(), "sess-1", realChange);
    expect(mocks.applyEvent).toHaveBeenCalledTimes(1);
    expect(mocks.clearVerificationVerdictForHeadChange).toHaveBeenCalledTimes(1);
    // The clear MUST be sequenced before applyEvent queues the spawn side-effect, so a declining spawn's
    // current-head write can never precede (and then be observed + erased by) the maintenance.
    expect(mocks.clearVerificationVerdictForHeadChange.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyEvent.mock.invocationCallOrder[0],
    );
  });

  it("runs the maintenance synchronously (inline) — NOT deferred onto waitUntil, so it precedes the spawn (#6527)", async () => {
    mocks.getSessionState.mockResolvedValue(settledSession());
    const deferred: Promise<unknown>[] = [];
    await shadowEmitHeadChange(liveEnv(), "sess-1", realChange, undefined, (p) => deferred.push(p));
    // The maintenance ran inline (clear already recorded on resolve) and was NOT handed to waitUntil —
    // deferring it onto the same waitUntil as the spawn side-effect is exactly the race this fixes.
    expect(mocks.clearVerificationVerdictForHeadChange).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveLength(0);
  });
});

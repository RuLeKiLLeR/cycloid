/// <reference types="@cloudflare/workers-types" />
/**
 * Tests for ARC-1045 resume replay-safety.
 *
 * Two load-bearing decisions, extracted as pure helpers so they unit-test
 * without the session DO (mirroring the `resumableBridgeStart` pattern):
 *
 *  1. Post-attach convergence: a successful resume flips runtimeState to
 *     "running" but does NOT set sandbox.status='ready', so the cold-create
 *     `sandboxReady` abort can't catch it. `shouldConvergeResumeToRunning` makes
 *     `tryResumeE2BRuntimeForSpawn` return true when a running E2B runtime
 *     already exists, so `spawnSandbox` does not fall through and spawn a
 *     duplicate.
 *  2. Superseded-attempt cleanup skip: both resume attempts share ONE persisted
 *     paused sandbox, so a superseded attempt must skip the entire cleanup
 *     (terminate + row clear + release). The DO reuses
 *     `shouldReleaseSupersededCapacity` (asserted in PR1) for that gate.
 */
import { describe, expect, it } from "vitest";

import {
  shouldConvergeResumeReplay,
  shouldConvergeResumeToRunning,
  shouldReleaseSupersededCapacity,
} from "../../apps/control-plane-worker/src/session/spawn-workflow";

const RUNNING = { runtimeProvider: "e2b", runtimeState: "running", runtimeSandboxId: "e2b-1" } as const;

describe("shouldConvergeResumeReplay (marker-gated convergence)", () => {
  it("converges only when attempt id + running runtime + this attempt's attach marker all hold", () => {
    expect(shouldConvergeResumeReplay({ sandbox: RUNNING, hasAttemptId: true, hasRuntimeAttachedMarker: true })).toBe(
      true,
    );
  });

  it("does NOT converge on a running row without this attempt's attach marker (reaped-stale case)", () => {
    // A sandbox reaped by discardStaleSandboxTransport leaves runtimeState='running'
    // uncleared but no runtimeAttached marker for the new attempt — must fall
    // through to a fresh spawn so the prompt gets a live bridge.
    expect(shouldConvergeResumeReplay({ sandbox: RUNNING, hasAttemptId: true, hasRuntimeAttachedMarker: false })).toBe(
      false,
    );
  });

  it("does NOT converge without a resumable attempt id", () => {
    expect(shouldConvergeResumeReplay({ sandbox: RUNNING, hasAttemptId: false, hasRuntimeAttachedMarker: true })).toBe(
      false,
    );
  });

  it("does NOT converge for a non-running runtime even with the marker", () => {
    expect(
      shouldConvergeResumeReplay({
        sandbox: { runtimeProvider: "e2b", runtimeState: "paused", runtimeSandboxId: "e2b-1" },
        hasAttemptId: true,
        hasRuntimeAttachedMarker: true,
      }),
    ).toBe(false);
  });
});

describe("shouldConvergeResumeToRunning (post-attach convergence)", () => {
  it("converges when a running E2B runtime already exists for the session", () => {
    expect(
      shouldConvergeResumeToRunning({ runtimeProvider: "e2b", runtimeState: "running", runtimeSandboxId: "e2b-1" }),
    ).toBe(true);
  });

  it("converges when a running Freestyle runtime already exists (no duplicate cold-create)", () => {
    // With the provider-agnostic guard, an honest "freestyle" running row must also
    // short-circuit the resume replay; otherwise the replay falls through to a cold
    // create and spawns a duplicate VM.
    expect(
      shouldConvergeResumeToRunning({
        runtimeProvider: "freestyle",
        runtimeState: "running",
        runtimeSandboxId: "fs-1",
      }),
    ).toBe(true);
  });

  it("does not converge for a paused runtime (the normal resume path runs)", () => {
    expect(
      shouldConvergeResumeToRunning({ runtimeProvider: "e2b", runtimeState: "paused", runtimeSandboxId: "e2b-1" }),
    ).toBe(false);
    expect(
      shouldConvergeResumeToRunning({ runtimeProvider: "freestyle", runtimeState: "paused", runtimeSandboxId: "fs-1" }),
    ).toBe(false);
  });

  it("does not converge for killed / missing / non-provider / id-less states", () => {
    expect(
      shouldConvergeResumeToRunning({ runtimeProvider: "e2b", runtimeState: "killed", runtimeSandboxId: "e2b-1" }),
    ).toBe(false);
    expect(shouldConvergeResumeToRunning(null)).toBe(false);
    // A legacy/unknown provider tag is NOT a managed runtime and must not converge.
    expect(
      shouldConvergeResumeToRunning({ runtimeProvider: "modal", runtimeState: "running", runtimeSandboxId: "m-1" }),
    ).toBe(false);
    expect(
      shouldConvergeResumeToRunning({ runtimeProvider: "e2b", runtimeState: "running", runtimeSandboxId: null }),
    ).toBe(false);
  });
});

describe("superseded resume cleanup gate", () => {
  it("skips the shared-sandbox cleanup when the resume attempt is superseded", () => {
    // The DO's cleanupResumedRuntimeIfCurrent runs the cleanup only when this
    // returns true. Superseded (not current) -> false -> cleanup skipped, so the
    // shared paused sandbox the current attempt owns is never terminated.
    expect(shouldReleaseSupersededCapacity("resume-attempt", /* isCurrent */ false)).toBe(false);
  });

  it("runs cleanup for a terminal failure of the still-current attempt", () => {
    expect(shouldReleaseSupersededCapacity("resume-attempt", /* isCurrent */ true)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { applyServerAuthoritativePublishMode } from "../../apps/control-plane-worker/src/session/authoritative-publish.js";
import type { SandboxEvent } from "../../apps/control-plane-worker/src/ws/types.js";
import { buildGateResults } from "../../shared/post-execution.js";

type PostExecutionEvent = Extract<SandboxEvent, { type: "post_execution" }>;

function postExecutionEvent(overrides: Partial<PostExecutionEvent> = {}): PostExecutionEvent {
  return {
    type: "post_execution",
    messageId: "prompt-1",
    sandboxId: "sbx-1",
    timestamp: 0,
    hasChanges: true,
    branch: "cycloid/feature",
    pushed: true,
    gateResults: buildGateResults({ tests: "passed" }),
    publishMode: "normal",
    ...overrides,
  } as PostExecutionEvent;
}

describe("applyServerAuthoritativePublishMode", () => {
  it("leaves a genuinely-normal event normal and reports agreement", () => {
    const event = postExecutionEvent({
      verification: { verified: true, explanation: "ok", publishMode: "normal" },
    });

    const decision = applyServerAuthoritativePublishMode(event);

    expect(decision.mismatch).toBe(false);
    expect(decision.publishMode).toBe("normal");
    expect(event.publishMode).toBe("normal");
    expect(event.verification?.publishMode).toBe("normal");
  });

  it("clamps a too-permissive sandbox up to the gate floor and rewrites the event", () => {
    // Gates drafted, but a buggy/compromised sandbox reported normal.
    const event = postExecutionEvent({
      gateResults: buildGateResults({ tests: "draft" }),
      publishMode: "normal",
      verification: { verified: true, explanation: "looks fine", publishMode: "normal" },
    });

    const decision = applyServerAuthoritativePublishMode(event);

    expect(decision).toMatchObject({ publishMode: "draft", mismatch: true, reason: "clamped_to_floor" });
    expect(event.publishMode).toBe("draft");
    expect(event.verification?.publishMode).toBe("draft");
  });

  it("clears a REFUTED verdict when clamping it away", () => {
    // A REFUTED verifier result forces draft and the verdict is deleted from the
    // PR-body-facing field.
    const event = postExecutionEvent({
      gateResults: buildGateResults({ tests: "draft" }),
      publishMode: "draft",
      verification: { verified: false, explanation: "tests disagree", publishMode: "draft", verdict: "REFUTED" },
    });

    applyServerAuthoritativePublishMode(event);

    expect(event.publishMode).toBe("draft");
    expect(event.verification?.verdict).toBeUndefined();
  });

  it("fails closed to draft when the gate signal is absent/invalid", () => {
    const event = postExecutionEvent({ gateResults: undefined, publishMode: "normal", verification: undefined });

    const decision = applyServerAuthoritativePublishMode(event);

    expect(decision).toMatchObject({ publishMode: "draft", mismatch: true, reason: "missing_signal" });
    expect(event.publishMode).toBe("draft");
  });

  it("does not accept browser artifacts as a substitute for missing gate signals", () => {
    const event = postExecutionEvent({
      gateResults: undefined,
      publishMode: "normal",
      prReadiness: {
        changedFiles: [
          "core/src/api/conversations/routes.py",
          "dashboard/src/views/admin/default/components/ConvTable.tsx",
        ],
        diffStats: { filesChanged: 2, insertions: 1, deletions: 0 },
        commandsRun: [],
        checksDetected: { tests: false, lint: false, typecheck: false },
        skippedChecks: [],
        filesMentionedInFinalAnswer: [],
      },
      verification: {
        verified: true,
        explanation: "Browser verification artifacts were captured in the sandbox.",
        publishMode: "normal",
        artifacts: [{ type: "screenshot", label: "conversation.png", url: "https://example.com/conversation.png" }],
      },
    });

    const decision = applyServerAuthoritativePublishMode(event);

    expect(decision).toMatchObject({ publishMode: "draft", mismatch: true, reason: "missing_signal" });
    expect(event.publishMode).toBe("draft");
  });

  it("synthesizes a verification when the sandbox omitted one but the derived mode is non-normal", () => {
    const event = postExecutionEvent({
      gateResults: buildGateResults({ tests: "draft" }),
      publishMode: "normal",
      verification: undefined,
    });

    applyServerAuthoritativePublishMode(event);

    expect(event.verification).toBeDefined();
    expect(event.verification?.publishMode).toBe("draft");
    expect(event.verification?.verified).toBe(false);
  });

  it("treats a removed blocked gate value as skipped", () => {
    const event = postExecutionEvent({
      gateResults: buildGateResults({ tests: "blocked" }),
      publishMode: "normal",
      verification: undefined,
    });

    const decision = applyServerAuthoritativePublishMode(event);

    expect(decision.publishMode).toBe("normal");
    expect(decision).toMatchObject({ reason: "agreement", gateFloor: "normal", functionalForcedDraft: false });
    expect(event.verification).toBeUndefined();
  });

  it("passes a stricter sandbox mode (failure path) through without a mismatch", () => {
    const event = postExecutionEvent({
      gateResults: buildGateResults({}), // all skipped → floor normal
      publishMode: "draft",
      verification: { verified: false, explanation: "aborted", publishMode: "draft" },
    });

    const decision = applyServerAuthoritativePublishMode(event);

    expect(decision).toMatchObject({ publishMode: "draft", mismatch: false, reason: "sandbox_stricter" });
    expect(event.verification?.publishMode).toBe("draft");
  });

  it.each(["REFUTED", "INCONCLUSIVE"] as const)(
    "clamps to draft through the verification verdict (%s) when functional verification forced the draft",
    (verdict) => {
      // A buggy/compromised sandbox reports normal on a result the verification
      // verdict refused, so the rewriter clamps to draft/manual-review mode.
      const event = postExecutionEvent({
        gateResults: buildGateResults({ tests: "passed" }),
        publishMode: "normal",
        verification: { verified: true, explanation: "ui change", publishMode: "normal", verdict },
      });

      const decision = applyServerAuthoritativePublishMode(event);

      // The verdict-driven draft cause is surfaced via gateFloor (clean `normal`
      // fold) + functionalForcedDraft, not a dedicated reason.
      expect(decision).toMatchObject({
        publishMode: "draft",
        mismatch: true,
        reason: "clamped_to_floor",
        gateFloor: "normal",
        functionalForcedDraft: true,
      });
      expect(event.publishMode).toBe("draft");
      expect(event.verification?.publishMode).toBe("draft");
    },
  );

  it("uses verification.publishMode as the old-payload fallback when publishMode is missing", () => {
    const event = postExecutionEvent({
      gateResults: undefined,
      publishMode: undefined,
      verification: { verified: false, explanation: "legacy draft", publishMode: "draft", verdict: "INCONCLUSIVE" },
    });

    const decision = applyServerAuthoritativePublishMode(event);

    expect(decision).toMatchObject({
      publishMode: "draft",
      sandboxMode: "draft",
      mismatch: false,
      reason: "missing_signal",
      functionalForcedDraft: true,
    });
    expect(event.publishMode).toBe("draft");
    expect(event.verification?.publishMode).toBe("draft");
  });

  it("is idempotent: re-deriving the rewritten event yields agreement", () => {
    const event = postExecutionEvent({
      gateResults: buildGateResults({ tests: "draft" }),
      publishMode: "normal",
      verification: { verified: true, explanation: "x", publishMode: "normal" },
    });

    applyServerAuthoritativePublishMode(event);
    const second = applyServerAuthoritativePublishMode(event);

    expect(second.mismatch).toBe(false);
    expect(second.publishMode).toBe("draft");
    expect(event.publishMode).toBe("draft");
  });

  it("clears a sandbox-reported verdict when clamping an existing verification", () => {
    // resolveVerificationVerdict (pr-body.ts) returns verification.verdict FIRST,
    // so a retained CONFIRMED would render "ready for review" on a draft PR.
    const event = postExecutionEvent({
      gateResults: buildGateResults({ tests: "draft" }),
      publishMode: "normal",
      verification: { verified: true, explanation: "ok", verdict: "CONFIRMED", publishMode: "normal" },
    });

    const decision = applyServerAuthoritativePublishMode(event);

    expect(decision.publishMode).toBe("draft");
    expect(event.verification?.publishMode).toBe("draft");
    expect(event.verification?.verdict).toBeUndefined();
  });

  it("explains a missing-signal draft as absent rather than failing gates", () => {
    const event = postExecutionEvent({ gateResults: undefined, publishMode: "normal", verification: undefined });

    applyServerAuthoritativePublishMode(event);

    expect(event.verification?.explanation).toContain("absent");
  });
});

import { describe, expect, it } from "vitest";

import { deriveEffectiveVerification } from "../../apps/control-plane-worker/src/session/effective-verification";
import type { ExecutionVerification } from "../../shared/types/sandbox";

// Outdated manual-review snapshot from storage. Authoritative PR/verifier columns
// must reconcile it before surfacing session state.
const manualReviewSnapshot: ExecutionVerification = {
  verified: true,
  status: "manual_review_required",
  publishMode: "draft",
  manualReviewReason: "Manual review required.",
  explanation: "Manual review required.",
  evidence: [],
  caveats: ["manual review"],
};

describe("deriveEffectiveVerification", () => {
  describe("no stored snapshot", () => {
    it("returns null verification but still derives prDraft/reason from columns", () => {
      const result = deriveEffectiveVerification({
        stored: null,
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        prDraft: true,
        prManualReviewReason: "held for review",
      });
      expect(result.verification).toBeNull();
      expect(result.prDraft).toBe(true);
      expect(result.prManualReviewReason).toBe("held for review");
    });

    it("prDraft falls back to false when both column and snapshot are absent", () => {
      const result = deriveEffectiveVerification({
        stored: null,
        verificationState: null,
        verificationResult: null,
        prDraft: null,
        prManualReviewReason: null,
      });
      expect(result.prDraft).toBe(false);
      expect(result.prManualReviewReason).toBeNull();
    });
  });

  describe("verification-done + merge-ready (the reported bug)", () => {
    it("reconciles a stale draft/manual-review snapshot to passed/normal", () => {
      const result = deriveEffectiveVerification({
        stored: manualReviewSnapshot,
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        prDraft: false,
        prManualReviewReason: null,
      });
      expect(result.verification).toMatchObject({
        verified: true,
        status: "passed",
        publishMode: "normal",
      });
      expect(result.verification?.manualReviewReason).toBeUndefined();
      // Descriptive fields are preserved.
      expect(result.verification?.explanation).toBe(manualReviewSnapshot.explanation);
      expect(result.verification?.caveats).toEqual(["manual review"]);
      expect(result.prDraft).toBe(false);
      expect(result.prManualReviewReason).toBeNull();
    });

    it("keeps publishMode draft when the column still holds the PR as a draft", () => {
      const result = deriveEffectiveVerification({
        stored: manualReviewSnapshot,
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        prDraft: true,
        prManualReviewReason: "kept as draft by policy",
      });
      expect(result.verification?.publishMode).toBe("draft");
      expect(result.verification?.verified).toBe(true);
      expect(result.verification?.status).toBe("passed");
      expect(result.verification?.manualReviewReason).toBe("kept as draft by policy");
      expect(result.prManualReviewReason).toBe("kept as draft by policy");
    });

    it("clears stale manual-review fields on merge-ready", () => {
      const result = deriveEffectiveVerification({
        stored: { ...manualReviewSnapshot, manualReviewReason: "tests failed earlier" },
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        prDraft: false,
        prManualReviewReason: null,
      });
      expect(result.verification?.manualReviewReason).toBeUndefined();
    });
  });

  describe("verification-done + needs-work", () => {
    it("reconciles to verified:false / failed and keeps the column reason", () => {
      const result = deriveEffectiveVerification({
        stored: { ...manualReviewSnapshot, verified: true, status: "passed", publishMode: "normal" },
        verificationState: "verification-done",
        verificationResult: "needs-work",
        prDraft: true,
        prManualReviewReason: "verifier found a regression",
      });
      expect(result.verification).toMatchObject({
        verified: false,
        status: "failed",
        publishMode: "draft",
        manualReviewReason: "verifier found a regression",
      });
      expect(result.prManualReviewReason).toBe("verifier found a regression");
    });
  });

  describe("not concluded (gate honored)", () => {
    it("leaves a manual-review snapshot untouched while verification is pending", () => {
      const result = deriveEffectiveVerification({
        stored: manualReviewSnapshot,
        verificationState: "verification-in-progress",
        verificationResult: null,
        prDraft: true,
        prManualReviewReason: null,
      });
      expect(result.verification).toEqual(manualReviewSnapshot);
      expect(result.prDraft).toBe(true);
      // Falls back to the nested reason because the PR is a draft.
      expect(result.prManualReviewReason).toBe(manualReviewSnapshot.manualReviewReason);
    });

    it("strips a stale terminal verdict left by a prior run (result cleared for re-run)", () => {
      const priorPassed: ExecutionVerification = {
        verified: true,
        status: "passed",
        publishMode: "normal",
        explanation: "prior run passed",
      };
      const result = deriveEffectiveVerification({
        stored: priorPassed,
        verificationState: "verification-in-progress",
        verificationResult: null,
        prDraft: false,
        prManualReviewReason: null,
      });
      expect(result.verification).toMatchObject({ verified: false, explanation: "prior run passed" });
      expect(result.verification?.status).toBeUndefined();
    });

    it("preserves a legit local verdict when no verifier is active (state null)", () => {
      // No async verifier run: storage holds the current post-execution result.
      // It must not be neutralized just because verificationState is unset.
      const localPassed: ExecutionVerification = {
        verified: true,
        status: "passed",
        publishMode: "normal",
        explanation: "local checks passed",
      };
      const result = deriveEffectiveVerification({
        stored: localPassed,
        verificationState: null,
        verificationResult: null,
        prDraft: false,
        prManualReviewReason: null,
      });
      expect(result.verification).toMatchObject({ verified: true, status: "passed", publishMode: "normal" });
    });

    it("reconciles publishMode/manualReviewReason against columns while verification runs", () => {
      // Draft PR flipped to non-draft (prDraft column false) mid-verification: the
      // snapshot must not keep surfacing draft / a stale manual-review reason.
      const result = deriveEffectiveVerification({
        stored: {
          verified: true,
          status: "manual_review_required",
          publishMode: "draft",
          manualReviewReason: "optimistic placeholder",
        },
        verificationState: "verification-in-progress",
        verificationResult: null,
        prDraft: false,
        prManualReviewReason: null,
      });
      expect(result.verification?.publishMode).toBe("normal");
      expect(result.verification?.manualReviewReason).toBeUndefined();
      expect(result.prDraft).toBe(false);
      expect(result.prManualReviewReason).toBeNull();
    });

    it("reconciles draft publishMode while not concluded", () => {
      const result = deriveEffectiveVerification({
        stored: { verified: false, status: "manual_review_required", publishMode: "draft" },
        verificationState: "verification-in-progress",
        verificationResult: null,
        prDraft: false,
        prManualReviewReason: null,
      });
      expect(result.verification?.publishMode).toBe("normal");
    });
  });

  describe("prDraft / prManualReviewReason gates", () => {
    it("suppresses the stale nested reason when the PR is not a draft", () => {
      const result = deriveEffectiveVerification({
        stored: { verified: false, manualReviewReason: "stale nested reason" },
        verificationState: null,
        verificationResult: null,
        prDraft: false,
        prManualReviewReason: null,
      });
      expect(result.prManualReviewReason).toBeNull();
    });

    it("keeps the authoritative column reason even when not a draft", () => {
      const result = deriveEffectiveVerification({
        stored: { verified: false, manualReviewReason: "stale nested reason" },
        verificationState: null,
        verificationResult: null,
        prDraft: false,
        prManualReviewReason: "authoritative column reason",
      });
      expect(result.prManualReviewReason).toBe("authoritative column reason");
    });

    it("derives prDraft from the snapshot publishMode when the column is null", () => {
      expect(
        deriveEffectiveVerification({
          stored: { verified: true, publishMode: "draft" },
          verificationState: null,
          verificationResult: null,
          prDraft: null,
          prManualReviewReason: null,
        }).prDraft,
      ).toBe(true);
      expect(
        deriveEffectiveVerification({
          stored: { verified: true, publishMode: "normal" },
          verificationState: null,
          verificationResult: null,
          prDraft: null,
          prManualReviewReason: null,
        }).prDraft,
      ).toBe(false);
    });

    it("prefers the column reason over the nested reason while a draft", () => {
      const result = deriveEffectiveVerification({
        stored: { verified: false, publishMode: "draft", manualReviewReason: "nested" },
        verificationState: null,
        verificationResult: null,
        prDraft: true,
        prManualReviewReason: "column",
      });
      expect(result.prManualReviewReason).toBe("column");
    });
  });

  it("is idempotent on an already-reconciled snapshot", () => {
    const once = deriveEffectiveVerification({
      stored: manualReviewSnapshot,
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      prDraft: false,
      prManualReviewReason: null,
    });
    const twice = deriveEffectiveVerification({
      stored: once.verification,
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      prDraft: false,
      prManualReviewReason: null,
    });
    expect(twice.verification).toEqual(once.verification);
    expect(twice.prDraft).toBe(once.prDraft);
    expect(twice.prManualReviewReason).toBe(once.prManualReviewReason);
  });
});

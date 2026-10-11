import { describe, expect, it } from "vitest";

import { translateBridgeEventToCycloidEvent } from "../../apps/sandbox-bridge/src/events/translate";
import { buildVerificationPhaseArtifactEvent } from "../../apps/sandbox-bridge/src/services/verification-phase-runner";
import { buildVerificationPhaseNoteRecord } from "../../shared/verification/phase-artifacts";

describe("verification phase artifact bridge event", () => {
  it("translates as a non-terminal bridge event with intermediate metadata", () => {
    const record = buildVerificationPhaseNoteRecord({
      runId: "run-1",
      sessionId: "s-1",
      promptId: "p-1",
      phase: "verification-operator",
      attempt: 0,
      createdAt: "2026-06-24T00:00:00.000Z",
      targetPrUrl: "https://github.com/acme/repo/pull/1",
      headSha: "abc123",
      output: "Operator note: focused test passed.",
    });

    const translated = translateBridgeEventToCycloidEvent(
      "s-1",
      buildVerificationPhaseArtifactEvent({ record, sandboxId: "sbx-1", timestamp: 1 }),
    );

    expect(translated).toMatchObject({
      phase: "bridge.event",
      promptId: "p-1",
      payload: {
        bridgeEventType: "verification_phase_artifact",
        verificationPhase: "verification-operator",
        intermediate: true,
        bridgeData: {
          artifactType: "VerificationOperatorArtifact",
          attempt: 0,
          validationStatus: "accepted",
          evidenceRefCount: 0,
          blockerCount: 0,
        },
      },
    });
  });
});

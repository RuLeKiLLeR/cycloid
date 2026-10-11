// Side-effect import: path isolation must run before sandbox-bridge imports.
import "./helpers/isolated-bridge-paths.ts";

import { rmSync } from "fs";
import { afterEach, describe, expect, it } from "vitest";

import { initialPublishDecision } from "../../apps/sandbox-bridge/src/services/post-execution/publish-gates.js";
import {
  finalizeVerification,
  type FinalizeVerificationContext,
} from "../../apps/sandbox-bridge/src/services/post-execution/verification-finalizer.js";
import { isolatedSandboxBridgePaths } from "./helpers/isolated-bridge-paths.ts";

function stubCtx(overrides: Partial<FinalizeVerificationContext> = {}): FinalizeVerificationContext {
  return {
    timePostExecutionStep: (_name, fn) => fn(),
    readPreviewContract: () => undefined,
    collectVerificationArtifacts: async () => [],
    buildFailureCaveats: (base = []) => Array.from(new Set(base.map((c) => c.trim()).filter(Boolean))),
    ...overrides,
  };
}

afterEach(() => {
  rmSync(isolatedSandboxBridgePaths.runtimeEvidenceDir, { recursive: true, force: true });
  rmSync(isolatedSandboxBridgePaths.baselineEvidenceDir, { recursive: true, force: true });
});

describe("finalizeVerification", () => {
  it("includes every successfully uploaded runtime artifact", async () => {
    const artifacts = [
      {
        artifactId: "proof-1",
        type: "screenshot" as const,
        label: "desktop-checkout-proof-1.png",
        url: "https://app.example/artifacts/proof-1",
      },
      {
        artifactId: "walkthrough-1",
        type: "video" as const,
        label: "desktop-checkout-walkthrough.webm",
        url: "https://app.example/artifacts/walkthrough-1",
      },
    ];
    const { payload } = await finalizeVerification(
      initialPublishDecision(),
      stubCtx({ collectVerificationArtifacts: async () => artifacts }),
      {
        responseTextForAssertion: "Done",
        useCurrentPublishDecision: true,
      },
    );

    expect(payload?.artifacts).toEqual(artifacts);
    expect(payload?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactId: "proof-1", type: "screenshot" }),
        expect.objectContaining({ artifactId: "walkthrough-1", type: "video" }),
      ]),
    );
  });

  it("uses the folded publish decision when useCurrentPublishDecision is set", async () => {
    const decision = initialPublishDecision();
    decision.publishMode = "draft";
    decision.publishWarnReasons = ["needs review"];
    decision.manualReviewReason = "manual";

    const { payload } = await finalizeVerification(decision, stubCtx(), {
      responseTextForAssertion: "Done",
      useCurrentPublishDecision: true,
    });

    expect(payload?.publishMode).toBe("draft");
    expect(payload?.publishWarnReasons).toEqual(["needs review"]);
    expect(payload?.manualReviewReason).toBe("manual");
  });

  it("uses explicit publish options (old-payload path) when useCurrentPublishDecision is unset", async () => {
    const decision = initialPublishDecision();
    // Folded decision says normal, but an explicit option overrides it.
    const { payload } = await finalizeVerification(decision, stubCtx(), {
      responseTextForAssertion: "Done",
      publishMode: "draft",
      publishWarnReasons: ["explicit warn"],
    });

    expect(payload?.publishMode).toBe("draft");
    expect(payload?.publishWarnReasons).toEqual(["explicit warn"]);
  });

  it("withholds verbose runtime diagnostics from caveats and notes in the payload", async () => {
    const { payload } = await finalizeVerification(initialPublishDecision(), stubCtx(), {
      responseTextForAssertion: "Done",
      useCurrentPublishDecision: true,
      caveats: [
        [
          "UI evidence was required, but automatic screenshot capture failed.",
          "Browser logs:",
          "<launching> chromium --token=secret",
          "Call log:",
          "  - process exited",
        ].join("\n"),
      ],
      notes: [
        [
          "Preview startup failed.",
          "Startup log tail:",
          "DATABASE_URL=postgres://user:password@example/db",
          "docker compose logs:",
        ].join("\n"),
      ],
    });

    expect(payload?.caveats).toContain(
      "Detailed runtime diagnostics were withheld because they may contain sensitive startup or application log data.",
    );
    expect(payload?.notes).toContain(
      "Detailed runtime diagnostics were withheld because they may contain sensitive startup or application log data.",
    );
    expect(JSON.stringify(payload)).not.toContain("DATABASE_URL");
    expect(JSON.stringify(payload)).not.toContain("chromium --token");
  });
});

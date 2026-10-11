import { describe, expect, it } from "vitest";

import {
  bindPublishableEvidenceToArtifacts,
  buildCommandVerificationEvidence,
  buildExecutionVerificationPayload,
  extractVisualAssertion,
} from "../../apps/sandbox-bridge/src/services/runtime-evidence.js";

describe("runtime evidence", () => {
  it("keeps automatically staged desktop evidence alongside explicitly selected evidence", () => {
    const bound = bindPublishableEvidenceToArtifacts(
      [
        {
          path: "/tmp/cycloid-evidence/focused-proof.log",
          label: "focused-proof.log",
          reason: "Focused passing proof output",
        },
      ],
      [
        {
          type: "log",
          label: "focused-proof.log",
          filename: "focused-proof.log",
          url: "https://example.com/focused-proof.log",
        },
        {
          type: "screenshot",
          label: "desktop-selection-proof-1.png",
          filename: "desktop-selection-proof-1.png",
          url: "https://example.com/desktop-selection-proof-1.png",
        },
        {
          type: "log",
          label: "unselected-debug.log",
          filename: "unselected-debug.log",
          url: "https://example.com/unselected-debug.log",
        },
      ],
    );

    expect(bound.artifacts.map((artifact) => artifact.filename)).toEqual([
      "focused-proof.log",
      "desktop-selection-proof-1.png",
    ]);
    expect(bound.evidence.map((evidence) => evidence.label)).toEqual([
      "focused-proof.log",
      "desktop-selection-proof-1.png",
    ]);
    expect(bound.missingRefs).toEqual([]);
  });

  it("publishes normal under the optimistic default when screenshots or app runtime evidence are missing", () => {
    // Visual evidence is advisory: a missing screenshot is no longer a draft
    // signal, so with no block/warn/manual signal the verdict is optimistic.
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: true,
      },
      artifacts: [],
      previewContract: undefined,
    });

    expect(payload).toMatchObject({
      verified: true,
      verdict: "CONFIRMED",
      status: "passed",
      publishMode: "normal",
      mode: "browser",
      runtimeEvidenceRequired: true,
      runtimeEvidenceSatisfied: false,
      explanation: "Runtime verification evidence was not captured; PR publication was not blocked.",
    });
  });

  it("does not draft from implementation-session command failures alone", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: { required: false },
      artifacts: [],
      previewContract: undefined,
      commandEvidence: [
        {
          type: "command",
          label: "tests",
          command: "npm test",
          status: "failed",
        },
      ],
    });

    expect(payload).toMatchObject({
      verified: true,
      verdict: "CONFIRMED",
      publishMode: "normal",
    });
  });

  it("marks resource-killed broad checks as draft/manual-review publication", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: false,
      },
      artifacts: [],
      previewContract: undefined,
      publishMode: "draft",
      manualReviewReason:
        "Broad typecheck could not complete because the command was killed by resource limits; review the scoped verification evidence before merge.",
    });

    expect(payload).toMatchObject({
      verified: false,
      verdict: "INCONCLUSIVE",
      status: "manual_review_required",
      publishMode: "draft",
      manualReviewReason:
        "Broad typecheck could not complete because the command was killed by resource limits; review the scoped verification evidence before merge.",
      explanation:
        "Broad typecheck could not complete because the command was killed by resource limits; review the scoped verification evidence before merge.",
    });
  });

  it("marks draft publication with warning status", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: false,
      },
      artifacts: [],
      previewContract: undefined,
      publishMode: "draft",
      publishWarnReasons: ["Manual review requested for verification evidence."],
      caveats: ["Manual review requested for verification evidence."],
    });

    expect(payload).toMatchObject({
      verified: false,
      verdict: "INCONCLUSIVE",
      status: "warn",
      publishMode: "draft",
      explanation: "Manual review requested for verification evidence.",
      publishWarnReasons: ["Manual review requested for verification evidence."],
    });
  });

  it("marks optional runtime evidence satisfied when screenshots and app runtime evidence are present", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: false,
      },
      artifacts: [
        {
          type: "screenshot",
          label: "updated-banner",
          url: "https://example.com/banner.png",
        },
      ],
      previewContract: {
        cwd: "/repo",
        kind: "web",
        runner: "docker",
        entry: {
          type: "compose",
          files: ["docker-compose.yml"],
          service: "web",
        },
        url: {
          hostPort: 5173,
          path: "/settings",
        },
        ready: {
          path: "/settings",
        },
      },
      visualAssertion: 'The screenshot shows "Verified Agent Control Room 2318" as the main heading.',
    });

    expect(payload).toMatchObject({
      verified: true,
      verdict: "CONFIRMED",
      status: "passed",
      mode: "browser",
      runtimeEvidenceRequired: false,
      runtimeEvidenceSatisfied: true,
      visualAssertion: 'The screenshot shows "Verified Agent Control Room 2318" as the main heading.',
    });
    expect(payload?.explanation).toBeUndefined();
    expect(payload?.artifacts).toHaveLength(1);
    expect(payload?.previewContract?.url.hostPort).toBe(5173);
  });

  it("treats a captured screenshot as positive runtime evidence even without a persisted preview contract", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: true,
      },
      artifacts: [
        {
          type: "screenshot",
          label: "post-change-home",
          url: "https://example.com/post-change-home.png",
        },
      ],
      previewContract: undefined,
    });

    expect(payload).toMatchObject({
      verified: true,
      verdict: "CONFIRMED",
      runtimeEvidenceRequired: true,
      runtimeEvidenceSatisfied: true,
    });
  });

  it("keeps visual evidence notes from forcing draft publication", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: true,
      },
      artifacts: [
        {
          type: "screenshot",
          label: "agent/sign-in.png",
          url: "https://example.com/sign-in.png",
        },
      ],
      previewContract: undefined,
      notes: ["Before/after screenshot evidence was required, but a matched before and after pair was not captured."],
    });

    expect(payload).toMatchObject({
      verified: true,
      verdict: "CONFIRMED",
      status: "passed",
      publishMode: "normal",
      notes: ["Before/after screenshot evidence was required, but a matched before and after pair was not captured."],
    });
    expect(payload?.caveats).toBeUndefined();
  });

  it("renders an advisory walkthrough-failure caveat without drafting a screenshot-backed ui change", () => {
    // A failed walkthrough recording is an advisory caveat now; with no block /
    // warn / manual signal the verdict stays optimistic and the caveat renders
    // as context only.
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: true,
      },
      artifacts: [
        {
          type: "screenshot",
          label: "post-change-home",
          url: "https://example.com/post-change-home.png",
        },
      ],
      caveats: ["Walkthrough video was requested, but recording failed: recorder crashed."],
    });

    expect(payload).toMatchObject({
      verified: true,
      verdict: "CONFIRMED",
      runtimeEvidenceRequired: true,
      runtimeEvidenceSatisfied: true,
      publishMode: "normal",
      caveats: ["Walkthrough video was requested, but recording failed: recorder crashed."],
    });
  });

  it("does not require or attach a visual assertion for non-frontend verification payloads", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: false,
      },
      artifacts: [],
      previewContract: undefined,
      visualAssertion: "The screenshot shows the changed heading.",
    });

    expect(payload).toBeUndefined();
  });

  it("keeps backend-only command verification as confirmed without browser artifacts", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: false,
      },
      artifacts: [],
      previewContract: {
        cwd: "/repo",
        kind: "web",
        runner: "docker",
        entry: {
          type: "compose",
          files: ["docker-compose.yml"],
          service: "web",
        },
        url: {
          hostPort: 5173,
        },
      },
      commandEvidence: [
        {
          type: "command",
          label: "tests (post_execution)",
          status: "passed",
          command: "npx vitest run tests/test_cloudflare/session/pr-workflow.test.ts",
        },
      ],
      claim: "Targeted backend verification passed.",
    });

    expect(payload).toMatchObject({
      verified: true,
      verdict: "CONFIRMED",
      status: "passed",
      publishMode: "normal",
      mode: undefined,
      explanation: "Command verification completed in the sandbox.",
      claim: "Targeted backend verification passed.",
      evidence: [
        expect.objectContaining({
          type: "command",
          status: "passed",
        }),
      ],
    });
  });

  it("includes command output excerpts in command evidence summaries", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: false,
      },
      artifacts: [],
      commandEvidence: [
        {
          type: "command",
          label: "tests (post_execution)",
          status: "passed",
          command: "npm run test -- src/api/session.test.ts",
          summary: "PASS src/api/session.test.ts | 4 passed | Duration 412ms",
        },
      ],
      claim: "Targeted backend verification passed.",
    });

    expect(payload?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "command",
          summary: "PASS src/api/session.test.ts | 4 passed | Duration 412ms",
        }),
      ]),
    );
  });

  it("preserves failed command output in command evidence", () => {
    const evidence = buildCommandVerificationEvidence([
      {
        command: "npm run test -- tests/failing.test.ts",
        status: "error",
        check: "tests",
        source: "post_execution",
        summary: "FAIL tests/failing.test.ts",
        failureOutput: "FAIL tests/failing.test.ts\nAssertionError: expected true to be false",
      },
    ]);

    expect(evidence).toEqual([
      expect.objectContaining({
        type: "command",
        status: "failed",
        command: "npm run test -- tests/failing.test.ts",
        summary: "FAIL tests/failing.test.ts",
        failureOutput: "FAIL tests/failing.test.ts\nAssertionError: expected true to be false",
      }),
    ]);
  });

  it("allows docs-only confirmation with an explicit explanation override", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: false,
      },
      artifacts: [],
      previewContract: undefined,
      verdict: "CONFIRMED",
      claim: "Docs-only change; no runtime evidence required.",
      explanationOverride: "No runtime evidence was required because this is a docs-only change.",
      commandEvidence: [],
    });

    expect(payload).toMatchObject({
      verified: true,
      verdict: "CONFIRMED",
      explanation: "No runtime evidence was required because this is a docs-only change.",
      claim: "Docs-only change; no runtime evidence required.",
    });
  });

  it("captures structured caveats and command evidence for abnormal finalization", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: false,
      },
      artifacts: [
        {
          type: "report",
          label: "playwright-report.html",
          url: "https://example.com/playwright-report.html",
        },
      ],
      previewContract: undefined,
      verdict: "INCONCLUSIVE",
      claim:
        "Prompt changes were preserved, but post-execution publish preparation did not complete before the session stopped.",
      caveats: ["Session was stopped before post-execution publish preparation completed."],
      commandEvidence: [
        {
          type: "command",
          label: "tests (agent)",
          status: "passed",
          command: "npm test",
        },
      ],
    });

    expect(payload).toMatchObject({
      verified: false,
      verdict: "INCONCLUSIVE",
      publishMode: "draft",
      claim:
        "Prompt changes were preserved, but post-execution publish preparation did not complete before the session stopped.",
      caveats: ["Session was stopped before post-execution publish preparation completed."],
    });
    expect(payload?.evidence).toEqual([
      expect.objectContaining({
        type: "report",
        status: "partial",
        url: "https://example.com/playwright-report.html",
      }),
      expect.objectContaining({
        type: "command",
        status: "passed",
        command: "npm test",
      }),
    ]);
  });

  it("confirms skipped-only command evidence under the optimistic default (no positive-evidence caveat)", () => {
    // Lack of positive proof no longer drafts: a skipped check with no failed /
    // warn / block signal resolves to the optimistic CONFIRMED, and the former
    // synthetic "did not produce positive evidence" caveat is gone.
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: false,
      },
      artifacts: [],
      previewContract: undefined,
      commandEvidence: [
        {
          type: "command",
          label: "tests (post_execution)",
          status: "skipped",
          command: "npm test",
          summary:
            "No test command declared (looked for package.json test script, pytest config, go.mod, Cargo.toml, .rspec).",
        },
      ],
    });

    expect(payload).toMatchObject({
      verified: true,
      verdict: "CONFIRMED",
      publishMode: "normal",
      status: "passed",
    });
    expect(payload?.caveats?.some((caveat) => caveat.includes("did not produce positive evidence"))).toBeFalsy();
  });

  it("does not add a positive-evidence caveat for explicit confirmed no-runtime verdicts", () => {
    const payload = buildExecutionVerificationPayload({
      runtimeEvidenceRequirement: {
        required: false,
      },
      artifacts: [],
      previewContract: undefined,
      verdict: "CONFIRMED",
      claim: "Docs-only change; no runtime evidence required.",
      explanationOverride: "No runtime evidence was required because this is a docs-only change.",
    });

    expect(payload).toMatchObject({
      verified: true,
      verdict: "CONFIRMED",
      publishMode: "normal",
    });
    expect(payload?.caveats ?? []).toEqual([]);
  });

  it("extracts explicit visual assertions from the agent final answer", () => {
    expect(
      extractVisualAssertion(
        [
          "Changed the heading.",
          'Visual assertion (verified): The screenshot shows "Verified Agent Control Room 2318" as the main heading.',
        ].join("\n"),
      ),
    ).toBe('The screenshot shows "Verified Agent Control Room 2318" as the main heading.');
  });

  it("ignores generic final-answer prose when no visual assertion is present", () => {
    expect(extractVisualAssertion("Changed the heading and opened a PR.")).toBeUndefined();
  });

  it("does not infer visual assertions from unprefixed screenshot prose", () => {
    expect(extractVisualAssertion("The screenshot shows the updated heading.")).toBeUndefined();
  });
});

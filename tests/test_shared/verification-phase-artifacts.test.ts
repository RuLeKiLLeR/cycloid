import { describe, expect, it } from "vitest";

import {
  buildEffectiveVerificationProofContract,
  buildVerificationPhaseArtifactRecord,
  buildVerificationPhaseNoteRecord,
  compactVerificationPhaseArtifactRecordForDurableStorage,
  makeMinimalVerificationPhaseArtifact,
  parseVerificationLauncherArtifactOutput,
  parseVerificationOperatorArtifactOutput,
  parseVerificationPhaseArtifactOutput,
  upsertVerificationPhaseArtifactRecord,
  validateJudgeProofCoverage,
  validateLauncherArtifactAgainstProofContract,
  validateMinimalVerificationPhaseArtifact,
  validateOperatorArtifactAgainstProofContract,
  VERIFICATION_PHASE_ARTIFACT_FENCE,
  VERIFICATION_PHASE_NAMES,
  type VerificationEvidenceDomain,
  type VerificationRequiredProof,
} from "../../shared/verification/phase-artifacts";

function proof(
  id: string,
  claim = `Prove ${id}`,
  evidenceDomain: VerificationEvidenceDomain = "runtime-readiness",
): VerificationRequiredProof {
  return {
    id,
    claim,
    whyRequired: `${id} is required for merge readiness.`,
    evidenceDomain,
    evidenceStandard: `${id} must be backed by concrete evidence.`,
    acceptableEvidenceTypes:
      evidenceDomain === "static" || evidenceDomain === "diff-inspection"
        ? ["diff-inspection"]
        : ["runtime-log", "visual-artifact"],
    ...(evidenceDomain === "static" || evidenceDomain === "diff-inspection"
      ? {}
      : {
          proofScenario: {
            actor: "verifier",
            preconditions: ["target PR head is checked out"],
            steps: [{ id: `${id}-step`, action: `Exercise ${id}`, expectedObservation: `${id} is proven` }],
            expectedObservations: [`${id} is proven`],
            negativeChecks: [`${id} does not regress adjacent behavior`],
          },
        }),
  };
}

function plannerRunArtifact(requiredProof: VerificationRequiredProof[]) {
  return makeMinimalVerificationPhaseArtifact({
    phase: "verification-planner",
    targetPrUrl: "https://github.com/acme/repo/pull/1",
    headSha: "abc123",
    decision: "run",
    verificationReason: "Verification is required.",
    appRuntime: {
      needed: requiredProof.some(
        (entry) => entry.evidenceDomain !== "static" && entry.evidenceDomain !== "diff-inspection",
      ),
      reason: "Runtime need follows the proof contract.",
      evidence: [{ source: "diff", reference: "changed files", summary: "Changed files require proof." }],
    },
    requiredProof,
    residualRisks: [],
  });
}

function plannerSkipArtifact(extra: Record<string, unknown> = {}) {
  return makeMinimalVerificationPhaseArtifact({
    phase: "verification-planner",
    targetPrUrl: "https://github.com/acme/repo/pull/1",
    headSha: "abc123",
    decision: "skip",
    reason: "Only documentation files changed.",
    evidence: [
      { source: "diff", reference: "docs-only", summary: "The diff only changes docs." },
      { source: "changed_file", reference: "docs/usage.md", summary: "docs/usage.md is documentation." },
    ],
    residualRisk: "No source, config, runtime, auth, prompt, migration, dependency, or test behavior changed.",
    ...extra,
  });
}

function launcherArtifact(extra: Record<string, unknown> = {}) {
  return makeMinimalVerificationPhaseArtifact({
    phase: "verification-launcher",
    targetPrUrl: "https://github.com/acme/repo/pull/1",
    headSha: "abc123",
    summary: { status: "ready", explanation: "Head runtime is ready for operator use." },
    effectiveRuntimeNeeded: true,
    launchTargets: [
      {
        id: "head-web",
        purpose: "Head runtime for operator proof.",
        sourceRef: "head",
        requiredForProofIds: ["runtime-proof"],
        supportsScenarioStepIds: ["runtime-proof-step"],
        environment: {
          kind: "local-web",
          url: "http://127.0.0.1:5173",
          apiUrl: "http://127.0.0.1:3000",
          stablePorts: [5173, 3000],
        },
        readiness: {
          status: "ready",
          checks: [
            {
              id: "health",
              kind: "health",
              status: "passed",
              summary: "Local web health check passed.",
              evidenceRef: "health-log",
            },
          ],
        },
        auth: {
          status: "authenticated",
          userHint: "local verifier user",
          evidenceRef: "auth-ready",
        },
        operatorEntry: {
          primaryUrl: "http://127.0.0.1:5173",
          notes: ["Use the authenticated local web target."],
        },
      },
    ],
    setupAttempts: [
      {
        targetId: "head-web",
        action: "Start local web runtime and poll health.",
        result: "passed",
        summary: "Runtime started and health passed.",
        outputRef: "startup-log",
      },
    ],
    proofAssessments: [
      {
        proofId: "runtime-proof",
        status: "satisfied-readiness",
        launchTargetIds: ["head-web"],
        evidenceRefs: ["health-log", "auth-ready"],
        explanation: "Launcher proved runtime and auth readiness only.",
      },
    ],
    blockers: [],
    residualRisks: [],
    ...extra,
  });
}

function operatorArtifact(extra: Record<string, unknown> = {}) {
  return makeMinimalVerificationPhaseArtifact({
    phase: "verification-operator",
    targetPrUrl: "https://github.com/acme/repo/pull/1",
    headSha: "abc123",
    summary: { status: "satisfied", explanation: "Operator completed runtime proof." },
    operatedProofIds: ["runtime-proof"],
    proofResults: [
      {
        proofId: "runtime-proof",
        source: "planner",
        status: "satisfied",
        launchTargetIds: ["head-web"],
        claim: "Prove runtime-proof",
        steps: ["Exercise runtime-proof"],
        scenarioTrace: [
          {
            stepId: "runtime-proof-step",
            action: "Exercise runtime-proof",
            status: "performed",
            observation: "runtime-proof is proven",
            evidenceRefIds: ["runtime-log"],
          },
        ],
        observedBehavior: "runtime-proof is proven",
        evidenceRefIds: ["runtime-log"],
        explanation: "Runtime log proves the required behavior.",
      },
    ],
    evidenceRefs: [
      {
        id: "runtime-log",
        type: "runtime-log",
        label: "Runtime log",
        launchTargetId: "head-web",
        summary: "Runtime log proves the scenario step.",
      },
    ],
    proofAmendments: [],
    blockers: [],
    mutationGuard: { checked: true, mutatedTrackedSource: false, summary: "No tracked source mutation." },
    residualRisks: [],
    ...extra,
  });
}

function beforeAfterProof(id: string): VerificationRequiredProof {
  return {
    ...proof(id, `Same user flow is fixed for ${id}`, "interactive-flow"),
    proofScenario: {
      actor: "verifier",
      preconditions: ["target PR head is checked out"],
      steps: [{ id: `${id}-step`, action: "Exercise the same user flow", expectedObservation: "Bug is absent" }],
      expectedObservations: ["Bug is absent"],
      sameFlowGroupId: "same-flow-1",
    },
    mustUseSameFlowAsUser: true,
    beforeAfter: {
      required: true,
      beforeClaim: "Bug reproduces on base or a controlled pre-fix reproduction.",
      afterClaim: "The same path is fixed on head.",
      sameFlowGroupId: "same-flow-1",
    },
  };
}

describe("verification phase artifacts", () => {
  it("parses and validates a canonical phase artifact fence", () => {
    const artifact = plannerRunArtifact([proof("runtime-proof")]);

    const parsed = parseVerificationPhaseArtifactOutput(
      `\`\`\`${VERIFICATION_PHASE_ARTIFACT_FENCE}\n${JSON.stringify(artifact)}\n\`\`\``,
    );

    expect(parsed).toEqual({ ok: true, artifact });
    expect(
      validateMinimalVerificationPhaseArtifact(parsed.ok ? parsed.artifact : null, "verification-planner"),
    ).toEqual({
      ok: true,
      artifact,
    });
  });

  it("normalizes flexible descriptive taxonomy fields across phase artifacts", () => {
    const flexibleProof = {
      ...proof("flexible-runtime-proof"),
      evidenceDomain: "ui",
      acceptableEvidenceTypes: ["HTTP Response", "source file", "custom-observability-export"],
    };
    const planner = {
      ...plannerRunArtifact([flexibleProof as VerificationRequiredProof]),
      phase: "planner",
      artifactType: "planner",
      appRuntime: {
        needed: true,
        reason: "Runtime evidence is needed.",
        evidence: [{ source: "source file", reference: "src/app.tsx", summary: "Source changed." }],
      },
    };
    const parsedPlanner = parseVerificationPhaseArtifactOutput(
      `\`\`\`${VERIFICATION_PHASE_ARTIFACT_FENCE}\n${JSON.stringify(planner)}\n\`\`\``,
    );
    const plannerValidation = validateMinimalVerificationPhaseArtifact(
      parsedPlanner.ok ? parsedPlanner.artifact : null,
      "verification-planner",
    );

    expect(parsedPlanner).toMatchObject({ ok: true });
    expect(plannerValidation).toMatchObject({ ok: true });
    if (!plannerValidation.ok) throw new Error(plannerValidation.error);
    const plannerArtifact = plannerValidation.artifact as Record<string, unknown>;
    const normalizedProof = ((plannerArtifact.requiredProof as Record<string, unknown>[]) ?? [])[0] as Record<
      string,
      unknown
    >;
    expect(plannerArtifact.phase).toBe("verification-planner");
    expect(plannerArtifact.artifactType).toBe("VerificationPlannerArtifact");
    expect(normalizedProof.evidenceDomain).toBe("interactive-flow");
    expect(normalizedProof.acceptableEvidenceTypes).toEqual([
      "http-response-capture",
      "source-snippet",
      "custom-observability-export",
    ]);

    const launcher = launcherArtifact({
      summary: { status: "success", explanation: "Runtime is ready." },
      launchTargets: [
        {
          ...(launcherArtifact().launchTargets as Record<string, unknown>[])[0],
          sourceRef: "target",
          environment: { kind: "browser", url: "http://127.0.0.1:5173" },
          readiness: {
            status: "success",
            checks: [
              {
                id: "health",
                kind: "http health",
                status: "success",
                summary: "Health passed.",
                evidenceRef: "health-log",
              },
            ],
          },
          auth: { status: "logged in", evidenceRef: "auth-log" },
        },
      ],
      setupAttempts: [
        { targetId: "head-web", action: "Start runtime.", result: "success", summary: "Runtime started." },
      ],
      proofAssessments: [
        {
          proofId: "runtime-proof",
          status: "ready",
          launchTargetIds: ["head-web"],
          evidenceRefs: ["health-log"],
          explanation: "Runtime is ready.",
        },
      ],
    });
    const launcherValidation = validateMinimalVerificationPhaseArtifact(launcher, "verification-launcher");

    expect(launcherValidation).toMatchObject({ ok: true });
    if (!launcherValidation.ok) throw new Error(launcherValidation.error);
    const launcherArtifactRecord = launcherValidation.artifact as Record<string, unknown>;
    const launchTarget = ((launcherArtifactRecord.launchTargets as Record<string, unknown>[]) ?? [])[0] as Record<
      string,
      unknown
    >;
    const launchEnvironment = launchTarget.environment as Record<string, unknown>;
    expect(launchTarget.sourceRef).toBe("head");
    expect(launchEnvironment.kind).toBe("local-web");

    const operator = operatorArtifact({
      summary: { status: "success", explanation: "Operator satisfied the proof." },
      proofResults: [
        {
          ...(operatorArtifact().proofResults as Record<string, unknown>[])[0],
          source: "planner proof",
          status: "success",
          scenarioTrace: [
            {
              stepId: "runtime-proof-step",
              action: "Exercise the proof.",
              status: "done",
              observation: "The proof passed.",
              evidenceRefIds: ["runtime-log"],
            },
          ],
        },
      ],
      evidenceRefs: [
        {
          id: "runtime-log",
          type: "screenshot",
          label: "Runtime proof",
          launchTargetId: "head-web",
          summary: "Screenshot captured.",
        },
      ],
    });
    const operatorValidation = validateMinimalVerificationPhaseArtifact(operator, "verification-operator");

    expect(operatorValidation).toMatchObject({ ok: true });
    if (!operatorValidation.ok) throw new Error(operatorValidation.error);
    const operatorArtifactRecord = operatorValidation.artifact as Record<string, unknown>;
    const operatorResult = ((operatorArtifactRecord.proofResults as Record<string, unknown>[]) ?? [])[0] as Record<
      string,
      unknown
    >;
    const operatorEvidence = ((operatorArtifactRecord.evidenceRefs as Record<string, unknown>[]) ?? [])[0] as Record<
      string,
      unknown
    >;
    expect(operatorResult.source).toBe("planner");
    expect(operatorResult.status).toBe("satisfied");
    expect(operatorEvidence.type).toBe("visual-artifact");

    const judge = {
      ...makeMinimalVerificationPhaseArtifact({
        phase: "verification-judge",
        targetPrUrl: "https://github.com/acme/repo/pull/1",
        headSha: "abc123",
      }),
      phase: "judge",
      artifactType: "judge",
      verdict: "ready to merge",
      verifiedHeadSha: "abc123",
      computedAgainstHeadSha: "abc123",
      summary: "Merge-ready.",
      proofCoverage: [
        {
          proofId: "flexible-runtime-proof",
          status: "pass",
          sourcePhases: ["planner", "operator"],
          evidenceRefs: ["runtime-log"],
          assessment: "Runtime proof passed.",
        },
      ],
      evidence: ["runtime-log"],
      blockers: [],
      residualRisks: [],
    };
    const judgeValidation = validateMinimalVerificationPhaseArtifact(judge, "verification-judge");

    expect(judgeValidation).toMatchObject({ ok: true });
    if (!judgeValidation.ok) throw new Error(judgeValidation.error);
    expect(judgeValidation.artifact).toMatchObject({
      phase: "verification-judge",
      artifactType: "VerificationJudgeArtifact",
      verdict: "CONCLUSIVE",
      proofCoverage: [
        {
          status: "satisfied",
          sourcePhases: ["verification-planner", "verification-operator"],
        },
      ],
    });
  });

  it("normalizes planner citation shape drift from live QA Tester output", () => {
    const artifact = plannerRunArtifact([proof("pr-evidence-proof", "PR evidence proof", "static")]) as Record<
      string,
      unknown
    >;
    artifact.appRuntime = {
      needed: true,
      reason: "Runtime proof is needed.",
      evidence: [
        {
          source: "pr",
          reference: "PR title and body",
          summary: "The PR describes the changed behavior.",
        },
        {
          type: "source file",
          path: "apps/control-plane-worker/src/settings/routes.ts",
          description: "Settings routes changed.",
        },
        "Verifier request targets head 87dfb8c9c3c6a405461654c3f25f4fbb3809d990.",
      ],
    };

    const validation = validateMinimalVerificationPhaseArtifact(artifact, "verification-planner");

    expect(validation).toMatchObject({
      ok: true,
      artifact: {
        appRuntime: {
          evidence: [
            { source: "pr_body", reference: "PR title and body" },
            { source: "source_code", reference: "apps/control-plane-worker/src/settings/routes.ts" },
            { source: "diff" },
          ],
        },
      },
    });
  });

  it("uses the last valid artifact fence when the model emits a corrected artifact", () => {
    const first = plannerRunArtifact([proof("first-proof", "First proof", "static")]);
    const second = plannerRunArtifact([proof("second-proof", "Second proof", "static")]);
    const parsed = parseVerificationPhaseArtifactOutput(
      [
        `\`\`\`${VERIFICATION_PHASE_ARTIFACT_FENCE}`,
        JSON.stringify(first),
        "```",
        "Corrected artifact:",
        `\`\`\`${VERIFICATION_PHASE_ARTIFACT_FENCE}`,
        JSON.stringify(second),
        "```",
      ].join("\n"),
    );

    expect(parsed).toEqual({ ok: true, artifact: second });
  });

  it("rejects drifted artifact names", () => {
    const validation = validateMinimalVerificationPhaseArtifact(
      {
        schemaVersion: 1,
        artifactType: "VerificationPlan",
        phase: "verification-planner",
        target: { targetPrUrl: "https://github.com/acme/repo/pull/1", headSha: "abc123" },
      },
      "verification-planner",
    );

    expect(validation).toEqual({
      ok: false,
      error: "artifactType is not a canonical verification artifact type",
    });
  });

  it("replaces a retry artifact without dropping other phases", () => {
    const plannerAttempt0 = buildVerificationPhaseArtifactRecord({
      runId: "run-1",
      sessionId: "s-1",
      promptId: "p-1",
      phase: "verification-planner",
      attempt: 0,
      createdAt: "2026-06-24T00:00:00.000Z",
      artifact: makeMinimalVerificationPhaseArtifact({
        phase: "verification-planner",
        targetPrUrl: "https://github.com/acme/repo/pull/1",
        headSha: "abc123",
        summary: "first",
      }),
    });
    const plannerAttempt0Replacement = {
      ...plannerAttempt0,
      artifact: { ...plannerAttempt0.artifact, summary: "replacement" },
    };
    const launcherAttempt0 = buildVerificationPhaseArtifactRecord({
      runId: "run-1",
      sessionId: "s-1",
      promptId: "p-1",
      phase: "verification-launcher",
      attempt: 0,
      createdAt: "2026-06-24T00:01:00.000Z",
      artifact: makeMinimalVerificationPhaseArtifact({
        phase: "verification-launcher",
        targetPrUrl: "https://github.com/acme/repo/pull/1",
        headSha: "abc123",
      }),
    });

    const records = upsertVerificationPhaseArtifactRecord(
      upsertVerificationPhaseArtifactRecord([plannerAttempt0], launcherAttempt0),
      plannerAttempt0Replacement,
    );

    expect(records.map((record) => `${record.phase}:${record.attempt}:${record.artifact.summary ?? ""}`)).toEqual([
      "verification-planner:0:replacement",
      "verification-launcher:0:",
    ]);
  });

  it("redacts credential material before persisting phase artifact records", () => {
    const record = buildVerificationPhaseArtifactRecord({
      runId: "run-1",
      sessionId: "s-1",
      promptId: "p-1",
      phase: "verification-launcher",
      attempt: 0,
      artifact: makeMinimalVerificationPhaseArtifact({
        phase: "verification-launcher",
        targetPrUrl: "https://github.com/acme/repo/pull/1",
        headSha: "abc123",
        summary: { status: "blocked", explanation: "Auth failed with Bearer live-secret-token-value" },
        authToken: "ghp_liveSecretTokenValue1234567890",
        launchTargets: [
          {
            id: "head-web",
            purpose: "Head runtime",
            sourceRef: "head",
            requiredForProofIds: ["runtime-proof"],
            environment: { kind: "local-web", url: "http://127.0.0.1:5173?access_token=secret-query-token" },
            readiness: { status: "failed", checks: [] },
            auth: {
              status: "blocked",
              blocker: "cookie=session=secret-cookie-value",
            },
            operatorEntry: { notes: [] },
          },
        ],
      }),
    });

    const serialized = JSON.stringify(record.artifact);

    expect(serialized).not.toContain("live-secret-token-value");
    expect(serialized).not.toContain("ghp_liveSecretTokenValue1234567890");
    expect(serialized).not.toContain("secret-query-token");
    expect(serialized).not.toContain("secret-cookie-value");
    expect(serialized).toContain("[REDACTED_VERIFICATION_SECRET]");
  });

  it("compacts raw phase notes before storing them in one Durable Object value", () => {
    const longOutput = "x".repeat(120_000);
    const records = VERIFICATION_PHASE_NAMES.map((phase) =>
      compactVerificationPhaseArtifactRecordForDurableStorage(
        buildVerificationPhaseNoteRecord({
          runId: "run-1",
          sessionId: "s-1",
          promptId: "p-1",
          phase,
          attempt: 0,
          output: longOutput,
          targetPrUrl: "https://github.com/acme/repo/pull/1",
          headSha: "abc123",
          createdAt: "2026-06-24T00:00:00.000Z",
        }),
      ),
    );

    expect(JSON.stringify(records).length).toBeLessThan(128 * 1024);
    expect(records[0].note?.output).toContain("[phase output truncated for durable storage]");
    expect(records[0].artifact.rawOutput).toContain("[phase output truncated for durable storage]");
  });

  it("merges planner proof, operator amendments, and provenance", () => {
    const plannerProof = proof("planned");
    const operatorProof = proof("operator-added");
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        createdAt: "2026-06-24T00:00:00.000Z",
        artifact: plannerRunArtifact([plannerProof]),
      }),
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-operator",
        attempt: 0,
        createdAt: "2026-06-24T00:02:00.000Z",
        artifact: operatorArtifact({
          operatedProofIds: [plannerProof.id],
          proofAmendments: [
            {
              proof: operatorProof,
              reason: "Operator found an additional runtime branch.",
              evidenceRefIds: ["browser-log"],
              introducedBy: "verification-operator",
              status: "not-run",
            },
          ],
          proofResults: [
            {
              proofId: plannerProof.id,
              source: "planner",
              status: "satisfied",
              launchTargetIds: ["head-web"],
              claim: plannerProof.claim,
              steps: ["Exercise planned proof"],
              scenarioTrace: [
                {
                  stepId: "planned-step",
                  action: "Exercise planned proof",
                  status: "performed",
                  observation: "planned is proven",
                  evidenceRefIds: ["browser-log"],
                },
              ],
              observedBehavior: "planned is proven",
              evidenceRefIds: ["browser-log"],
              explanation: "Browser runtime evidence satisfied planned proof.",
            },
          ],
          evidenceRefs: [
            {
              id: "browser-log",
              type: "runtime-log",
              label: "Browser log",
              launchTargetId: "head-web",
              summary: "Browser runtime evidence.",
            },
          ],
        }),
      }),
    ];

    const contract = buildEffectiveVerificationProofContract(records);

    expect(contract).toMatchObject({
      ok: true,
      proofs: [
        { id: "planned", status: "satisfied", sourcePhases: ["verification-planner", "verification-operator"] },
        { id: "operator-added", status: "needs-runtime", sourcePhases: ["verification-operator"] },
      ],
    });
  });

  it("rejects duplicate proof IDs with conflicting definitions", () => {
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([proof("same-id", "Original definition")]),
      }),
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-operator",
        attempt: 0,
        artifact: makeMinimalVerificationPhaseArtifact({
          phase: "verification-operator",
          targetPrUrl: "https://github.com/acme/repo/pull/1",
          headSha: "abc123",
          proofAmendments: [
            {
              proof: proof("same-id", "Conflicting definition"),
              reason: "Operator found conflicting proof.",
              evidenceRefIds: ["operator-log"],
              introducedBy: "verification-operator",
              status: "not-run",
            },
          ],
        }),
      }),
    ];

    expect(buildEffectiveVerificationProofContract(records)).toEqual({
      ok: false,
      error: "proof same-id has conflicting definitions",
    });
  });

  it("validates docs-only planner skip with concrete diff and file evidence", () => {
    const artifact = plannerSkipArtifact({ status: "skipped", summary: "Only documentation files changed." });

    expect(validateMinimalVerificationPhaseArtifact(artifact, "verification-planner")).toEqual({
      ok: true,
      artifact,
    });
  });

  it("rejects vague planner skip evidence", () => {
    const validation = validateMinimalVerificationPhaseArtifact(
      makeMinimalVerificationPhaseArtifact({
        phase: "verification-planner",
        targetPrUrl: "https://github.com/acme/repo/pull/1",
        headSha: "abc123",
        decision: "skip",
        status: "skipped",
        reason: "Looks harmless.",
        evidence: [{ source: "parent_prompt", reference: "prompt-1", summary: "The prompt sounded low risk." }],
        residualRisk: "Unverified.",
      }),
      "verification-planner",
    );

    expect(validation).toEqual({
      ok: false,
      error: "planner skip evidence must cite changed_file, diff, or check evidence",
    });
  });

  it("rejects duplicate proof IDs in planner requiredProof", () => {
    const duplicate = proof("same-id");
    const validation = validateMinimalVerificationPhaseArtifact(
      plannerRunArtifact([duplicate, duplicate]),
      "verification-planner",
    );

    expect(validation).toEqual({
      ok: false,
      error: "requiredProof contains duplicate proof id same-id",
    });
  });

  it("synthesizes a structured scenario for runtime proof when the model omits one", () => {
    const validation = validateMinimalVerificationPhaseArtifact(
      makeMinimalVerificationPhaseArtifact({
        phase: "verification-planner",
        targetPrUrl: "https://github.com/acme/repo/pull/1",
        headSha: "abc123",
        decision: "run",
        verificationReason: "Runtime path changed.",
        appRuntime: {
          needed: true,
          reason: "Runtime evidence is needed for the changed path.",
          evidence: [{ source: "diff", reference: "src/app.ts", summary: "Runtime code changed." }],
        },
        requiredProof: [
          {
            id: "runtime-missing-scenario",
            claim: "The runtime path works.",
            whyRequired: "The PR changes runtime behavior.",
            evidenceDomain: "runtime-readiness",
            evidenceStandard: "Runtime startup or equivalent logs prove readiness.",
            acceptableEvidenceTypes: ["runtime-log"],
          },
        ],
        residualRisks: [],
      }),
      "verification-planner",
    );

    expect(validation).toMatchObject({
      ok: true,
      artifact: {
        requiredProof: [
          {
            id: "runtime-missing-scenario",
            proofScenario: {
              actor: "verifier",
              steps: [
                {
                  id: "runtime-missing-scenario-step-1",
                },
              ],
            },
          },
        ],
      },
    });
  });

  it("accepts planner proof evidence types used for API request logs and check summaries", () => {
    const artifact = plannerRunArtifact([
      {
        ...proof("api_and_check_evidence", "Prove API behavior and current check status.", "static"),
        acceptableEvidenceTypes: [
          "request-response-log",
          "http-response-capture",
          "check-run-summary",
          "source-snippet",
          "kv-state-capture",
          "diff-hunk",
        ],
      },
    ]);

    expect(validateMinimalVerificationPhaseArtifact(artifact, "verification-planner")).toEqual({
      ok: true,
      artifact,
    });
  });

  it("validates before/after bug proof with same-flow mapping", () => {
    const artifact = plannerRunArtifact([beforeAfterProof("bug_absent_on_head_same_flow")]);

    expect(validateMinimalVerificationPhaseArtifact(artifact, "verification-planner")).toEqual({
      ok: true,
      artifact,
    });
  });

  it("synthesizes same-flow mapping for before/after proof when the model omits one", () => {
    const missingMapping: VerificationRequiredProof = {
      ...beforeAfterProof("missing_same_flow"),
      proofScenario: {
        actor: "verifier",
        preconditions: ["target PR head is checked out"],
        steps: [{ id: "exercise-flow", action: "Exercise the user flow" }],
        expectedObservations: ["Bug is absent"],
      },
      beforeAfter: {
        required: true,
        beforeClaim: "Bug reproduces before the fix.",
        afterClaim: "Bug is absent after the fix.",
      },
    };

    const validation = validateMinimalVerificationPhaseArtifact(
      plannerRunArtifact([missingMapping]),
      "verification-planner",
    );

    expect(validation).toMatchObject({
      ok: true,
      artifact: {
        requiredProof: [
          {
            id: "missing_same_flow",
            beforeAfter: { sameFlowGroupId: "missing_same_flow-same-flow" },
            proofScenario: { sameFlowGroupId: "missing_same_flow-same-flow" },
          },
        ],
      },
    });
  });

  it("allows unknown planner artifact fields without dropping the artifact", () => {
    expect(
      validateMinimalVerificationPhaseArtifact(
        plannerRunArtifact([proof("unknown_field")]) as Record<string, unknown>,
        "verification-planner",
      ),
    ).toEqual({
      ok: true,
      artifact: plannerRunArtifact([proof("unknown_field")]),
    });

    const artifact = { ...plannerRunArtifact([proof("unknown_field")]), unexpected: true };
    expect(validateMinimalVerificationPhaseArtifact(artifact, "verification-planner")).toMatchObject({
      ok: true,
      artifact: { unexpected: true },
    });
  });

  it("infers a supported proof evidence domain when the model emits an unknown domain", () => {
    const invalidProof = {
      ...proof("unsupported_domain"),
      evidenceDomain: "not-a-real-domain",
    };

    expect(
      validateMinimalVerificationPhaseArtifact(
        plannerRunArtifact([invalidProof as VerificationRequiredProof]),
        "verification-planner",
      ),
    ).toMatchObject({
      ok: true,
      artifact: {
        requiredProof: [
          {
            id: "unsupported_domain",
            evidenceDomain: "interactive-flow",
          },
        ],
      },
    });
  });

  it("parses and validates a ready launcher artifact with readiness and auth evidence", () => {
    const artifact = launcherArtifact();
    const parsed = parseVerificationLauncherArtifactOutput(
      `\`\`\`${VERIFICATION_PHASE_ARTIFACT_FENCE}\n${JSON.stringify(artifact)}\n\`\`\``,
    );

    expect(parsed).toEqual({ ok: true, artifact });
    expect(validateMinimalVerificationPhaseArtifact(artifact, "verification-launcher")).toEqual({
      ok: true,
      artifact,
    });
  });

  it("validates launcher partial, blocked, and skipped statuses", () => {
    const partial = launcherArtifact({
      summary: { status: "partial", explanation: "Head target is ready but base is blocked." },
      blockers: [
        {
          targetId: "base-web",
          proofIds: ["runtime-proof"],
          blocker: "Base checkout could not install dependencies.",
          attempts: ["npm ci on base failed"],
        },
      ],
    });
    const blocked = launcherArtifact({
      summary: { status: "blocked", explanation: "No usable runtime target could be prepared." },
      launchTargets: [],
      setupAttempts: [
        {
          targetId: "head-web",
          action: "Start local web runtime.",
          result: "failed",
          summary: "Startup failed.",
          outputRef: "startup-error",
        },
      ],
      proofAssessments: [
        {
          proofId: "runtime-proof",
          status: "blocked",
          launchTargetIds: [],
          evidenceRefs: ["startup-error"],
          explanation: "Runtime startup failed after concrete attempts.",
        },
      ],
      blockers: [
        {
          targetId: "head-web",
          proofIds: ["runtime-proof"],
          blocker: "Runtime startup failed.",
          attempts: ["npm run dev failed"],
        },
      ],
    });
    const skipped = launcherArtifact({
      summary: { status: "skipped", explanation: "No runtime proof remains." },
      effectiveRuntimeNeeded: false,
      launchTargets: [],
      setupAttempts: [],
      proofAssessments: [],
      blockers: [],
    });

    expect(validateMinimalVerificationPhaseArtifact(partial, "verification-launcher")).toMatchObject({ ok: true });
    expect(validateMinimalVerificationPhaseArtifact(blocked, "verification-launcher")).toMatchObject({ ok: true });
    expect(validateMinimalVerificationPhaseArtifact(skipped, "verification-launcher")).toMatchObject({ ok: true });
  });

  it("rejects runtime-needed launcher output without launch targets or blockers", () => {
    expect(
      validateMinimalVerificationPhaseArtifact(
        launcherArtifact({ launchTargets: [], setupAttempts: [], proofAssessments: [], blockers: [] }),
        "verification-launcher",
      ),
    ).toEqual({
      ok: false,
      error: "launcher runtime-needed artifact requires launchTargets or blockers",
    });
  });

  it("requires ready launch targets to include readiness evidence and operator entry", () => {
    expect(
      validateMinimalVerificationPhaseArtifact(
        launcherArtifact({
          launchTargets: [
            {
              ...(launcherArtifact().launchTargets as Record<string, unknown>[])[0],
              readiness: { status: "ready", checks: [] },
            },
          ],
        }),
        "verification-launcher",
      ),
    ).toEqual({
      ok: false,
      error: "launch target head-web ready target requires readiness evidence",
    });
    expect(
      validateMinimalVerificationPhaseArtifact(
        launcherArtifact({
          launchTargets: [
            {
              ...(launcherArtifact().launchTargets as Record<string, unknown>[])[0],
              operatorEntry: { notes: [] },
            },
          ],
        }),
        "verification-launcher",
      ),
    ).toEqual({
      ok: false,
      error: "launch target head-web ready target requires an operator entry",
    });
  });

  it("requires authenticated launch targets to carry auth evidence", () => {
    expect(
      validateMinimalVerificationPhaseArtifact(
        launcherArtifact({
          launchTargets: [
            {
              ...(launcherArtifact().launchTargets as Record<string, unknown>[])[0],
              auth: { status: "authenticated", userHint: "local verifier user" },
            },
          ],
        }),
        "verification-launcher",
      ),
    ).toEqual({
      ok: false,
      error: "launch target head-web authenticated auth requires evidenceRef",
    });
  });

  it("validates launcher proof references against the effective contract", () => {
    const required = proof("runtime-proof");
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([required]),
      }),
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-operator",
        attempt: 0,
        artifact: operatorArtifact(),
      }),
    ];
    const contract = buildEffectiveVerificationProofContract(records);

    expect(validateLauncherArtifactAgainstProofContract(launcherArtifact(), contract)).toBeNull();
    expect(
      validateLauncherArtifactAgainstProofContract(
        launcherArtifact({
          proofAssessments: [
            {
              proofId: "unknown-proof",
              status: "satisfied-readiness",
              launchTargetIds: ["head-web"],
              evidenceRefs: ["health-log"],
              explanation: "Unknown proof should be rejected.",
            },
          ],
        }),
        contract,
      ),
    ).toBe("launcher proof assessment references unknown proof unknown-proof");
  });

  it("records base and head launch targets for before/after proof", () => {
    const beforeAfter = beforeAfterProof("runtime-proof");
    const artifact = launcherArtifact({
      launchTargets: [
        ...(launcherArtifact().launchTargets as Record<string, unknown>[]),
        {
          ...(launcherArtifact().launchTargets as Record<string, unknown>[])[0],
          id: "base-web",
          purpose: "Base runtime for before evidence.",
          sourceRef: "base",
          operatorEntry: {
            primaryUrl: "http://127.0.0.1:6173",
            notes: ["Use this target only for before evidence."],
          },
        },
      ],
    });
    const contract = buildEffectiveVerificationProofContract([
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([beforeAfter]),
      }),
    ]);

    expect(validateMinimalVerificationPhaseArtifact(artifact, "verification-launcher")).toMatchObject({ ok: true });
    expect(validateLauncherArtifactAgainstProofContract(artifact, contract)).toBeNull();
    expect((artifact.launchTargets as Record<string, unknown>[]).map((target) => target.sourceRef)).toEqual([
      "head",
      "base",
    ]);
  });

  it("requires launch blockers to carry proof IDs and attempts", () => {
    expect(
      validateMinimalVerificationPhaseArtifact(
        launcherArtifact({
          summary: { status: "blocked", explanation: "Auth setup failed." },
          launchTargets: [],
          setupAttempts: [],
          proofAssessments: [],
          blockers: [{ proofIds: [], blocker: "Auth setup failed.", attempts: ["login failed"] }],
        }),
        "verification-launcher",
      ),
    ).toEqual({
      ok: false,
      error: "launch blocker proofIds must be non-empty strings",
    });
  });

  it("rejects launcher setup attempts that pass after mutating tracked source", () => {
    expect(
      validateMinimalVerificationPhaseArtifact(
        launcherArtifact({
          setupAttempts: [
            {
              targetId: "head-web",
              action: "Patch config to make runtime boot.",
              result: "passed",
              summary: "Runtime passed after a tracked edit.",
              mutatedTrackedSource: true,
            },
          ],
        }),
        "verification-launcher",
      ),
    ).toEqual({
      ok: false,
      error: "setup attempt head-web cannot pass after mutating tracked source",
    });
  });

  it("parses and validates operator statuses", () => {
    const satisfied = operatorArtifact();
    const failed = operatorArtifact({
      summary: { status: "failed", explanation: "Operator observed contradictory behavior." },
      proofResults: [
        {
          ...(operatorArtifact().proofResults as Record<string, unknown>[])[0],
          status: "failed",
          observedBehavior: "The legacy error still appears.",
          explanation: "Runtime behavior contradicted the required proof.",
        },
      ],
    });
    const blocked = operatorArtifact({
      summary: { status: "blocked", explanation: "Operator could not reach the flow." },
      proofResults: [
        {
          ...(operatorArtifact().proofResults as Record<string, unknown>[])[0],
          status: "blocked",
          evidenceRefIds: [],
          explanation: "The changed element was not reachable.",
        },
      ],
      blockers: [
        {
          proofIds: ["runtime-proof"],
          launchTargetIds: ["head-web"],
          blocker: "The changed element was not reachable.",
          attempts: ["Opened the launcher-provided URL", "Reloaded once"],
        },
      ],
    });
    const partial = operatorArtifact({
      summary: { status: "partial", explanation: "One proof was not run." },
      proofResults: [
        {
          ...(operatorArtifact().proofResults as Record<string, unknown>[])[0],
          status: "not-run",
          steps: [],
          evidenceRefIds: [],
          explanation: "The base launch target was unavailable.",
        },
      ],
      blockers: [
        {
          proofIds: ["runtime-proof"],
          launchTargetIds: ["head-web"],
          blocker: "The base launch target was unavailable.",
          attempts: ["Checked launcher target list"],
        },
      ],
    });
    const skipped = operatorArtifact({
      summary: { status: "skipped", explanation: "No operator proof remained." },
      operatedProofIds: [],
      proofResults: [],
      evidenceRefs: [],
    });

    for (const artifact of [satisfied, failed, blocked, partial, skipped]) {
      expect(validateMinimalVerificationPhaseArtifact(artifact, "verification-operator")).toMatchObject({ ok: true });
    }
    expect(
      parseVerificationOperatorArtifactOutput(
        `\`\`\`${VERIFICATION_PHASE_ARTIFACT_FENCE}\n${JSON.stringify(satisfied)}\n\`\`\``,
      ),
    ).toEqual({
      ok: true,
      artifact: satisfied,
    });
  });

  it("allows carried-through operator not-run proof results to omit steps and blocker attempts", () => {
    const artifact = operatorArtifact({
      summary: { status: "partial", explanation: "One proof was operated; one proof was carried through as not run." },
      proofResults: [
        ...(operatorArtifact().proofResults as Record<string, unknown>[]),
        {
          proofId: "carried-through-proof",
          source: "planner",
          status: "not-run",
          launchTargetIds: [],
          claim: "Proof was not operated in this phase.",
          steps: [],
          scenarioTrace: [],
          observedBehavior: "The proof was intentionally not operated in this phase.",
          evidenceRefIds: [],
          explanation: "The operator recorded this proof for continuity, but it was outside operatedProofIds.",
        },
      ],
    });

    expect(validateMinimalVerificationPhaseArtifact(artifact, "verification-operator")).toMatchObject({ ok: true });
  });

  it("requires operator satisfied proof to cite evidence refs", () => {
    expect(
      validateMinimalVerificationPhaseArtifact(
        operatorArtifact({
          proofResults: [
            {
              ...(operatorArtifact().proofResults as Record<string, unknown>[])[0],
              evidenceRefIds: [],
            },
          ],
        }),
        "verification-operator",
      ),
    ).toEqual({
      ok: false,
      error: "operator proof result runtime-proof satisfied proof requires evidenceRefIds",
    });
  });

  it("requires scenario-step traces for satisfied structured operator proof", () => {
    const required = proof("runtime-proof", "Runtime proof");
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([required]),
      }),
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-launcher",
        attempt: 0,
        artifact: launcherArtifact({
          proofAssessments: [
            {
              proofId: required.id,
              status: "unsatisfied-needs-operator",
              launchTargetIds: ["head-web"],
              evidenceRefs: ["health-log"],
              explanation: "Operator must prove behavior.",
            },
          ],
        }),
      }),
    ];
    const contract = buildEffectiveVerificationProofContract(records);
    const artifact = operatorArtifact({
      proofResults: [
        {
          ...(operatorArtifact().proofResults as Record<string, unknown>[])[0],
          scenarioTrace: [],
        },
      ],
    });

    expect(validateMinimalVerificationPhaseArtifact(artifact, "verification-operator")).toMatchObject({ ok: true });
    expect(validateOperatorArtifactAgainstProofContract(artifact, contract, records)).toBe(
      "operator proof result runtime-proof satisfied structured scenario proof requires scenarioTrace",
    );
  });

  it("requires before/after operator proof to record separate base and head evidence", () => {
    const required = beforeAfterProof("runtime-proof");
    const baseTarget = {
      ...(launcherArtifact().launchTargets as Record<string, unknown>[])[0],
      id: "base-web",
      sourceRef: "base",
      operatorEntry: { primaryUrl: "http://127.0.0.1:6173", notes: ["Use for before evidence."] },
    };
    const launchArtifact = launcherArtifact({
      launchTargets: [...(launcherArtifact().launchTargets as Record<string, unknown>[]), baseTarget],
      proofAssessments: [
        {
          proofId: required.id,
          status: "unsatisfied-needs-operator",
          launchTargetIds: ["head-web", "base-web"],
          evidenceRefs: ["health-log"],
          explanation: "Operator must prove before and after behavior.",
        },
      ],
    });
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([required]),
      }),
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-launcher",
        attempt: 0,
        artifact: launchArtifact,
      }),
    ];
    const valid = operatorArtifact({
      evidenceRefs: [
        {
          id: "before-log",
          type: "runtime-log",
          label: "Before",
          launchTargetId: "base-web",
          summary: "Bug reproduced.",
        },
        { id: "after-log", type: "runtime-log", label: "After", launchTargetId: "head-web", summary: "Bug absent." },
      ],
      proofResults: [
        {
          ...(operatorArtifact().proofResults as Record<string, unknown>[])[0],
          launchTargetIds: ["base-web", "head-web"],
          scenarioTrace: [
            {
              stepId: "runtime-proof-step",
              action: "Exercise the same user flow",
              status: "performed",
              observation: "Bug reproduced on base and absent on head.",
              evidenceRefIds: ["before-log", "after-log"],
            },
          ],
          evidenceRefIds: ["before-log", "after-log"],
        },
      ],
    });
    const missingBase = operatorArtifact({
      evidenceRefs: [
        { id: "after-log", type: "runtime-log", label: "After", launchTargetId: "head-web", summary: "Bug absent." },
      ],
      proofResults: [
        {
          ...(operatorArtifact().proofResults as Record<string, unknown>[])[0],
          launchTargetIds: ["head-web"],
          scenarioTrace: [
            {
              stepId: "runtime-proof-step",
              action: "Exercise the same user flow",
              status: "performed",
              observation: "Bug absent on head only.",
              evidenceRefIds: ["after-log"],
            },
          ],
          evidenceRefIds: ["after-log"],
        },
      ],
    });

    const contract = buildEffectiveVerificationProofContract(records);
    expect(validateOperatorArtifactAgainstProofContract(valid, contract, records)).toBeNull();
    expect(validateOperatorArtifactAgainstProofContract(missingBase, contract, records)).toBe(
      "operator proof result runtime-proof before/after proof requires separate base and head evidence",
    );
  });

  it("rejects operator proof results that reference unknown proof", () => {
    const required = proof("runtime-proof");
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([required]),
      }),
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-launcher",
        attempt: 0,
        artifact: launcherArtifact(),
      }),
    ];
    const artifact = operatorArtifact({
      operatedProofIds: ["unknown-proof"],
      proofResults: [
        {
          ...(operatorArtifact().proofResults as Record<string, unknown>[])[0],
          proofId: "unknown-proof",
        },
      ],
    });

    expect(
      validateOperatorArtifactAgainstProofContract(artifact, buildEffectiveVerificationProofContract(records), records),
    ).toBe("operator proof result references unknown proof unknown-proof");
  });

  it("requires operator-domain proof to appear in operator results", () => {
    const required = proof("runtime-proof", "Runtime proof");
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([required]),
      }),
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-launcher",
        attempt: 0,
        artifact: launcherArtifact({
          proofAssessments: [
            {
              proofId: required.id,
              status: "unsatisfied-needs-operator",
              launchTargetIds: ["head-web"],
              evidenceRefs: ["health-log"],
              explanation: "Operator must prove behavior.",
            },
          ],
        }),
      }),
    ];

    expect(
      validateOperatorArtifactAgainstProofContract(
        operatorArtifact({ operatedProofIds: [], proofResults: [] }),
        buildEffectiveVerificationProofContract(records),
        records,
      ),
    ).toBe("operator proofResults missing required proof runtime-proof");
  });

  it("requires launcher assessments for planner proof forwarded to launcher", () => {
    const required = proof("runtime-proof", "Runtime proof");
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([required]),
      }),
    ];
    const contract = buildEffectiveVerificationProofContract(records);

    expect(validateLauncherArtifactAgainstProofContract(launcherArtifact({ proofAssessments: [] }), contract)).toBe(
      "launcher-needed proof runtime-proof requires a launcher proof assessment",
    );
    expect(
      validateLauncherArtifactAgainstProofContract(
        launcherArtifact({
          proofAssessments: [
            {
              proofId: required.id,
              status: "unsatisfied-needs-operator",
              launchTargetIds: ["head-web"],
              evidenceRefs: ["health-log"],
              explanation: "Launcher prepared handles; operator must prove behavior.",
            },
          ],
        }),
        contract,
      ),
    ).toBeNull();
  });

  it("requires operator amendments to cite runtime evidence and use a unique proof ID", () => {
    const added = proof("operator-added-runtime", "Operator added persistence proof", "interactive-flow");
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([proof("runtime-proof")]),
      }),
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-launcher",
        attempt: 0,
        artifact: launcherArtifact(),
      }),
    ];
    const valid = operatorArtifact({
      proofAmendments: [
        {
          proof: added,
          reason: "Runtime observation showed reload persistence is necessary.",
          evidenceRefIds: ["runtime-log"],
          introducedBy: "verification-operator",
          status: "satisfied",
        },
      ],
    });
    const missingEvidence = operatorArtifact({
      proofAmendments: [
        {
          proof: added,
          reason: "Runtime observation showed reload persistence is necessary.",
          evidenceRefIds: [],
          introducedBy: "verification-operator",
          status: "satisfied",
        },
      ],
    });
    const duplicateExisting = operatorArtifact({
      proofAmendments: [
        {
          proof: proof("runtime-proof"),
          reason: "Duplicate existing proof.",
          evidenceRefIds: ["runtime-log"],
          introducedBy: "verification-operator",
          status: "satisfied",
        },
      ],
    });

    const contract = buildEffectiveVerificationProofContract(records);
    expect(validateMinimalVerificationPhaseArtifact(valid, "verification-operator")).toMatchObject({ ok: true });
    expect(validateMinimalVerificationPhaseArtifact(missingEvidence, "verification-operator")).toEqual({
      ok: false,
      error: "operator proof amendment operator-added-runtime requires runtime evidenceRefIds",
    });
    expect(validateOperatorArtifactAgainstProofContract(duplicateExisting, contract, records)).toBe(
      "operator proof amendment duplicates existing proof runtime-proof",
    );
  });

  it("validates judge coverage against the effective proof contract", () => {
    const required = proof("runtime-proof");
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([required]),
      }),
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-operator",
        attempt: 0,
        artifact: operatorArtifact(),
      }),
    ];
    const contract = buildEffectiveVerificationProofContract(records);
    const judge = makeMinimalVerificationPhaseArtifact({
      phase: "verification-judge",
      targetPrUrl: "https://github.com/acme/repo/pull/1",
      headSha: "abc123",
      verdict: "CONCLUSIVE",
      verifiedHeadSha: "abc123",
      computedAgainstHeadSha: "abc123",
      summary: "Runtime proof passed.",
      proofCoverage: [
        {
          proofId: required.id,
          status: "satisfied",
          sourcePhases: ["verification-planner"],
          evidenceRefs: ["runtime-log"],
          assessment: "Runtime log proves the path and scenario step runtime-proof-step.",
        },
      ],
      evidence: ["runtime-log"],
      blockers: [],
      residualRisks: [],
    });

    expect(validateJudgeProofCoverage(judge, contract)).toBeNull();
    expect(validateJudgeProofCoverage({ ...judge, proofCoverage: [] }, contract)).toBe(
      "judge proofCoverage must include exactly one record per effective proof",
    );
    expect(
      validateJudgeProofCoverage(
        {
          ...judge,
          proofCoverage: [{ ...(judge.proofCoverage as Record<string, unknown>[])[0], status: "skipped" }],
        },
        contract,
      ),
    ).toBe("judge proofCoverage must contain judge proof coverage objects");
    expect(
      validateJudgeProofCoverage(
        {
          ...judge,
          proofCoverage: [{ ...(judge.proofCoverage as Record<string, unknown>[])[0], evidenceRefs: ["invented"] }],
        },
        contract,
      ),
    ).toBe("judge proofCoverage proof runtime-proof cites unknown evidence ref invented");

    const failedContract = buildEffectiveVerificationProofContract([
      records[0],
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-launcher",
        attempt: 0,
        artifact: launcherArtifact({
          proofAssessments: [
            {
              proofId: required.id,
              status: "failed",
              launchTargetIds: [],
              evidenceRefs: ["feature-test"],
              explanation: "The focused feature test failed.",
            },
          ],
        }),
      }),
    ]);
    expect(
      validateJudgeProofCoverage(
        {
          ...judge,
          proofCoverage: [{ ...(judge.proofCoverage as Record<string, unknown>[])[0], evidenceRefs: ["feature-test"] }],
          evidence: ["feature-test"],
        },
        failedContract,
      ),
    ).toBe("judge proofCoverage cannot satisfy proof runtime-proof because effective proof status is failed");
  });

  it("validates judge verdict semantics, labels, head SHA, and scenario evidence", () => {
    const required = proof("scenario-proof", "Scenario proof", "interactive-flow");
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([required]),
      }),
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-operator",
        attempt: 0,
        artifact: operatorArtifact({
          operatedProofIds: [required.id],
          proofResults: [
            {
              proofId: required.id,
              source: "planner",
              status: "satisfied",
              launchTargetIds: ["head-web"],
              claim: required.claim,
              steps: ["Exercise scenario proof"],
              observedBehavior: "The operator completed the scenario.",
              evidenceRefIds: ["operator-log"],
              explanation: "The operator completed the scenario.",
              scenarioTrace: [
                {
                  stepId: "scenario-proof-step",
                  action: "Exercise scenario proof",
                  status: "performed",
                  observation: "Scenario step completed.",
                  evidenceRefIds: ["operator-log"],
                },
              ],
            },
          ],
          evidenceRefs: [
            {
              id: "operator-log",
              type: "runtime-log",
              label: "Operator log",
              launchTargetId: "head-web",
              summary: "The scenario completed.",
            },
          ],
        }),
      }),
    ];
    const contract = buildEffectiveVerificationProofContract(records);
    const baseJudge = makeMinimalVerificationPhaseArtifact({
      phase: "verification-judge",
      targetPrUrl: "https://github.com/acme/repo/pull/1",
      headSha: "abc123",
      verdict: "INCONCLUSIVE",
      verifiedHeadSha: "abc123",
      computedAgainstHeadSha: "abc123",
      summary: "Runtime proof remains blocked.",
      proofCoverage: [
        {
          proofId: required.id,
          status: "blocked",
          sourcePhases: ["verification-operator"],
          evidenceRefs: ["operator-log"],
          assessment: "The operator could not complete scenario-proof-step.",
        },
      ],
      evidence: ["operator-log"],
      blockers: [
        {
          proofIds: [required.id],
          blocker: "The operator could not reach the scenario.",
          sourcePhase: "verification-operator",
          evidenceRefs: ["operator-log"],
        },
      ],
      needsWorkLabel: "verification-gap",
      residualRisks: [],
    });

    expect(validateJudgeProofCoverage(baseJudge, contract)).toBeNull();
    expect(
      validateJudgeProofCoverage(
        {
          ...baseJudge,
          verdict: "CONCLUSIVE",
          needsWorkLabel: undefined,
        },
        contract,
      ),
    ).toBe("judge CONCLUSIVE verdict must not include blockers");
    expect(validateJudgeProofCoverage({ ...baseJudge, computedAgainstHeadSha: "different" }, contract)).toBe(
      "judge computedAgainstHeadSha must match target.headSha",
    );
    expect(
      validateJudgeProofCoverage(
        {
          ...baseJudge,
          verdict: "CONCLUSIVE",
          needsWorkLabel: undefined,
          blockers: [],
          proofCoverage: [
            {
              proofId: required.id,
              status: "satisfied",
              sourcePhases: ["verification-operator"],
              evidenceRefs: ["operator-log"],
              assessment: "Runtime log proves the path without naming the scenario step.",
            },
          ],
        },
        contract,
      ),
    ).toBe(
      "judge proofCoverage satisfied structured scenario proof scenario-proof without scenario-step evidence scenario-proof-step",
    );
    expect(
      validateJudgeProofCoverage(
        {
          ...baseJudge,
          proofCoverage: [...(baseJudge.proofCoverage as unknown[]), ...(baseJudge.proofCoverage as unknown[])],
        },
        contract,
      ),
    ).toBe("judge proofCoverage must include exactly one record per effective proof");
  });

  it("rejects duplicate judge proof coverage IDs", () => {
    const first = proof("first-proof", "First proof", "static");
    const second = proof("second-proof", "Second proof", "static");
    const records = [
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-planner",
        attempt: 0,
        artifact: plannerRunArtifact([first, second]),
      }),
      buildVerificationPhaseArtifactRecord({
        runId: "run-1",
        sessionId: "s-1",
        promptId: "p-1",
        phase: "verification-operator",
        attempt: 0,
        artifact: operatorArtifact({
          operatedProofIds: [first.id],
          proofResults: [
            {
              proofId: first.id,
              source: "planner",
              status: "satisfied",
              launchTargetIds: ["head-web"],
              claim: first.claim,
              steps: ["Inspect the diff for first proof"],
              observedBehavior: "First proof was satisfied.",
              evidenceRefIds: ["first-proof-log"],
              explanation: "First proof was satisfied.",
            },
          ],
          evidenceRefs: [
            {
              id: "first-proof-log",
              type: "runtime-log",
              label: "First proof log",
              launchTargetId: "head-web",
              summary: "First proof was satisfied.",
            },
          ],
        }),
      }),
    ];
    const contract = buildEffectiveVerificationProofContract(records);
    const duplicate = makeMinimalVerificationPhaseArtifact({
      phase: "verification-judge",
      targetPrUrl: "https://github.com/acme/repo/pull/1",
      headSha: "abc123",
      verdict: "CONCLUSIVE",
      verifiedHeadSha: "abc123",
      computedAgainstHeadSha: "abc123",
      summary: "Both proofs were assessed.",
      proofCoverage: [
        {
          proofId: first.id,
          status: "satisfied",
          sourcePhases: ["verification-operator"],
          evidenceRefs: ["first-proof-log"],
          assessment: "Diff inspection satisfies the first proof.",
        },
        {
          proofId: first.id,
          status: "satisfied",
          sourcePhases: ["verification-operator"],
          evidenceRefs: ["first-proof-log"],
          assessment: "Diff inspection duplicates the first proof.",
        },
      ],
      evidence: ["first-proof-log"],
      blockers: [],
      residualRisks: [],
    });

    expect(validateJudgeProofCoverage(duplicate, contract)).toBe(
      "judge proofCoverage contains duplicate proof first-proof",
    );
  });
});

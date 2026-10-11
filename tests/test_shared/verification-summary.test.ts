import { describe, expect, it } from "vitest";

import type { ExecutionVerification, PrReadinessEvidence } from "../../shared/types/sandbox";
import { buildVerificationSummary } from "../../shared/verification-summary";

function makeReadiness(overrides: Partial<PrReadinessEvidence> = {}): PrReadinessEvidence {
  return {
    changedFiles: [],
    diffStats: { filesChanged: 0, insertions: 0, deletions: 0 },
    commandsRun: [],
    checksDetected: { tests: false, lint: false, typecheck: false },
    skippedChecks: [],
    filesMentionedInFinalAnswer: [],
    ...overrides,
  };
}

describe("buildVerificationSummary", () => {
  it("returns an unverified empty summary with no evidence", () => {
    const summary = buildVerificationSummary({});
    expect(summary).toEqual({
      outcome: "unverified",
      commands: [],
      checksPassed: [],
      skippedChecks: [],
      visualArtifacts: [],
      runtimeEvidence: null,
      caveats: [],
    });
  });

  it("treats completed post-execution commands with non-zero exit codes or failure output as failed", () => {
    const summary = buildVerificationSummary({
      verification: { verified: true } as ExecutionVerification,
      readiness: makeReadiness({
        commandsRun: [
          {
            command: "npm test",
            status: "completed",
            exitCode: 1,
            source: "post_execution",
            check: "tests",
            hasOutput: true,
          },
          {
            command: "curl -s localhost:3000/health",
            status: "completed",
            exitCode: null,
            source: "post_execution",
            check: "lint",
            hasOutput: true,
            summary: "HTTP/1.1 500 Internal Server Error",
            failureOutput: "Error: health probe returned 500",
          },
          {
            command: "npx tsc --noEmit",
            status: "completed",
            exitCode: 0,
            source: "post_execution",
            check: "typecheck",
            hasOutput: true,
          },
        ],
      }),
    });

    expect(summary.commands.map((c) => c.status)).toEqual(["failed", "failed", "passed"]);
    expect(summary.checksPassed).toEqual(["typecheck"]);
    // summary/failureOutput ride along for failure-detail renderers.
    expect(summary.commands[1].summary).toContain("500");
    expect(summary.commands[1].failureOutput).toContain("health probe");
  });

  it("maps command evidence with statuses, exit codes, and checks", () => {
    const summary = buildVerificationSummary({
      verification: { verified: true } as ExecutionVerification,
      readiness: makeReadiness({
        commandsRun: [
          { command: "npm test", status: "completed", exitCode: 0, source: "agent", check: "tests", hasOutput: true },
          {
            command: "npm run test:unit",
            status: "completed",
            exitCode: 0,
            source: "post_execution",
            check: "tests",
            hasOutput: true,
          },
          {
            command: "npx tsc --noEmit",
            status: "error",
            exitCode: 2,
            source: "post_execution",
            checks: ["typecheck"],
            hasOutput: true,
          },
          {
            command: "npm run lint",
            status: "skipped",
            exitCode: null,
            source: "post_execution",
            check: "lint",
            hasOutput: false,
            skipReason: "verify.test lint skipped",
          },
        ],
        skippedChecks: [{ check: "lint", reason: "verify.test lint skipped" }],
      }),
    });

    expect(summary.outcome).toBe("verified");
    expect(summary.commands).toEqual([
      { command: "npm run test:unit", status: "passed", exitCode: 0, source: "post_execution", checks: ["tests"] },
      { command: "npx tsc --noEmit", status: "failed", exitCode: 2, source: "post_execution", checks: ["typecheck"] },
      {
        command: "npm run lint",
        status: "skipped",
        exitCode: null,
        source: "post_execution",
        checks: ["lint"],
        skipReason: "verify.test lint skipped",
      },
    ]);
    expect(summary.checksPassed).toEqual(["tests"]);
    expect(summary.skippedChecks).toEqual([{ check: "lint", reason: "verify.test lint skipped" }]);
  });

  it("keeps only screenshot/video artifacts", () => {
    const summary = buildVerificationSummary({
      verification: {
        verified: true,
        artifacts: [
          { type: "screenshot", label: "home", url: "https://x/s.png" },
          { type: "video", label: "flow", url: "https://x/v.webm" },
          { type: "log", label: "server log", url: "https://x/l.txt" },
          { type: "report", label: "report", url: "https://x/r.html" },
        ],
      } as ExecutionVerification,
    });
    expect(summary.visualArtifacts.map((artifact) => artifact.type)).toEqual(["screenshot", "video"]);
  });

  it("reports draft outcome with the manual-review reason", () => {
    const summary = buildVerificationSummary({
      verification: {
        verified: false,
        publishMode: "draft",
        manualReviewReason: "needs human eyes",
      },
    });
    expect(summary.outcome).toBe("draft");
    expect(summary.draftReason).toBe("needs human eyes");
  });

  it("surfaces runtime evidence flags and caveats", () => {
    const summary = buildVerificationSummary({
      verification: {
        verified: false,
        runtimeEvidenceRequired: true,
        runtimeEvidenceSatisfied: false,
        caveats: ["preview port guessed"],
      },
    });
    expect(summary.runtimeEvidence).toEqual({ required: true, satisfied: false });
    expect(summary.caveats).toEqual(["preview port guessed"]);
  });
});

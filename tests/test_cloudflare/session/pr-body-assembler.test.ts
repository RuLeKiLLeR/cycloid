import { describe, expect, it } from "vitest";

import {
  buildFailedVerificationComment,
  collectVerboseVerificationDiagnostics,
  looksLikeVerboseVerificationDetail,
  shouldRenderFailedVerificationComment,
} from "../../../apps/control-plane-worker/src/session/pr-body-assembler";
import type { ExecutionVerification, PrReadinessEvidence } from "../../../shared/types/sandbox";

function failedCommand(overrides: Partial<PrReadinessEvidence["commandsRun"][number]> = {}) {
  return {
    command: "npm test",
    status: "error" as const,
    source: "post_execution" as const,
    exitCode: 1,
    hasOutput: true,
    failureOutput: "1 test failed",
    ...overrides,
  };
}

function evidence(commands: PrReadinessEvidence["commandsRun"]): PrReadinessEvidence {
  return {
    changedFiles: [],
    diffStats: { filesChanged: 0, insertions: 0, deletions: 0 },
    commandsRun: commands,
    checksDetected: { tests: false, lint: false, typecheck: false },
    skippedChecks: [],
    filesMentionedInFinalAnswer: [],
    agentTimeline: [],
  } as PrReadinessEvidence;
}

describe("buildFailedVerificationComment", () => {
  it("returns undefined without verification", () => {
    expect(buildFailedVerificationComment(undefined, evidence([failedCommand()]))).toBeUndefined();
  });

  it("returns undefined when nothing failed and no verbose diagnostics exist", () => {
    const verification: ExecutionVerification = { verified: true };
    expect(buildFailedVerificationComment(verification, evidence([]))).toBeUndefined();
  });

  it("renders failed post-execution commands with output", () => {
    const verification: ExecutionVerification = { verified: false };
    const comment = buildFailedVerificationComment(verification, evidence([failedCommand()]));

    expect(comment).toContain("<!-- cycloid:failed-verification -->");
    expect(comment).toContain("## Failed Command Details");
    expect(comment).toContain("npm test");
    expect(comment).toContain("1 test failed");
    expect(comment).toContain("Exit code: `1`");
    expect(comment).not.toContain("Source: `post_execution`");
  });

  it("caps rendered commands at five and reports the omission", () => {
    const commands = Array.from({ length: 7 }, (_, i) => failedCommand({ command: `cmd-${i}` }));
    const comment = buildFailedVerificationComment({ verified: false }, evidence(commands));

    expect(comment).toContain("cmd-4");
    expect(comment).not.toContain("<summary><code>cmd-5</code>");
    expect(comment).toContain("Omitted 2 additional failed command(s).");
  });

  it("renders a diagnostics-only comment for verbose verification details", () => {
    const verification: ExecutionVerification = {
      verified: false,
      caveats: [`Browser logs\n${"x".repeat(10)}`],
    };
    const comment = buildFailedVerificationComment(verification, evidence([]));

    expect(comment).toContain("## Verification Diagnostic Details");
    expect(comment).toContain("withheld from the PR comment");
  });

  it("escapes HTML in command names", () => {
    const comment = buildFailedVerificationComment(
      { verified: false },
      evidence([failedCommand({ command: "echo <script>" })]),
    );
    expect(comment).toContain("echo &lt;script&gt;");
  });
});

describe("shouldRenderFailedVerificationComment", () => {
  it("requires verification to exist", () => {
    expect(shouldRenderFailedVerificationComment(undefined, [failedCommand()])).toBe(false);
  });

  it("is true with failed commands", () => {
    expect(shouldRenderFailedVerificationComment({ verified: false }, [failedCommand()])).toBe(true);
  });

  it("is false with no failures and no verbose diagnostics", () => {
    expect(shouldRenderFailedVerificationComment({ verified: true }, [])).toBe(false);
  });
});

describe("collectVerboseVerificationDiagnostics", () => {
  it("collects only verbose entries and dedupes them", () => {
    const verbose = `Traceback\n${"y".repeat(20)}`;
    const diagnostics = collectVerboseVerificationDiagnostics({
      verified: false,
      caveats: [verbose, verbose, "short note"],
      notes: [verbose],
    });

    // The repeated caveat collapses to one entry; the same value under a
    // different label survives.
    expect(diagnostics).toEqual([
      { label: "Caveat", value: verbose },
      { label: "Note", value: verbose },
    ]);
  });
});

describe("looksLikeVerboseVerificationDetail", () => {
  it("flags long, multiline, and log-shaped text", () => {
    expect(looksLikeVerboseVerificationDetail("z".repeat(501))).toBe(true);
    expect(looksLikeVerboseVerificationDetail("line one\nline two")).toBe(true);
    expect(looksLikeVerboseVerificationDetail("Traceback (most recent call last)")).toBe(true);
    expect(looksLikeVerboseVerificationDetail("short human sentence")).toBe(false);
  });
});

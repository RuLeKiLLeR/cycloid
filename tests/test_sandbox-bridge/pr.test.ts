import { describe, expect, it } from "vitest";

import { renderPrEvidenceCommentFromReadiness } from "../../apps/sandbox-bridge/src/services/pr.js";
import { BRIDGE_VERIFICATION_RENDERED_MARKER } from "../../shared/post-execution.js";
import type { PrReadinessEvidence } from "../../shared/types/sandbox.js";

function evidence(overrides: Partial<PrReadinessEvidence> = {}): PrReadinessEvidence {
  return {
    changedFiles: ["src/app.ts"],
    diffStats: { filesChanged: 1, insertions: 5, deletions: 1 },
    commandsRun: [],
    checksDetected: { tests: false, lint: false, typecheck: false },
    skippedChecks: [],
    filesMentionedInFinalAnswer: [],
    evidenceBundle: {
      originalPrompt: "Update the health endpoint to return ok=true.",
      agentFinalMessage: "Changed the health endpoint to return ok=true.",
    },
    ...overrides,
  };
}

describe("renderPrEvidenceCommentFromReadiness", () => {
  it("renders only the agent summary on the normal path", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      verification: { verified: false, verdict: "INCONCLUSIVE", publishMode: "draft" },
    });

    expect(body).toBe(
      ["## Summary", "Changed the health endpoint to return ok=true.", BRIDGE_VERIFICATION_RENDERED_MARKER].join(
        "\n\n",
      ),
    );
    expect(body).not.toContain("**Verdict:** INCONCLUSIVE");
    expect(body).not.toContain("Verification Evidence");
    expect(body).not.toContain("Caveats");
    expect(body).not.toContain("Reviewer action");
    expect(body).not.toContain("Changed Files");
  });

  it("does not render a verdict line even when verification is confirmed", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      verification: { verified: true, verdict: "CONFIRMED", publishMode: "normal" },
    });

    expect(body).not.toContain("**Verdict:** INCONCLUSIVE");
    expect(body).not.toContain("**Verdict:** CONFIRMED");
  });

  it("renders failed verify.test commands before the summary", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence({
        commandsRun: [
          {
            command: "npm run test -- tests/failing.test.ts",
            status: "error",
            source: "post_execution",
            check: "tests",
            exitCode: 1,
            hasOutput: true,
            summary: "Configured pre-publish test failed with exit code 1.",
            failureOutput: "FAIL tests/failing.test.ts\nAssertionError: expected true to be false",
          },
        ],
      }),
      verification: { verified: false, verdict: "INCONCLUSIVE", publishMode: "draft" },
    });

    expect(body.startsWith("## Failed\n<details>")).toBe(true);
    expect(body).toContain("<summary><code>npm run test -- tests/failing.test.ts</code> failed</summary>");
    expect(body).toContain("FAIL tests/failing.test.ts\nAssertionError: expected true to be false");
    expect(body.indexOf("## Failed")).toBeLessThan(body.indexOf("## Summary"));
    expect(body).not.toContain("**Verdict:** INCONCLUSIVE");
    expect(body).not.toContain("- Source:");
    expect(body).not.toContain("- Check:");
  });

  it("keeps a multi-target failed verify.test command when only one target later passes", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence({
        commandsRun: [
          {
            command: "npx vitest run tests/a.test.ts tests/b.test.ts",
            status: "error",
            source: "post_execution",
            check: "tests",
            exitCode: 1,
            hasOutput: true,
            failureOutput: "FAIL tests/b.test.ts",
          },
          {
            command: "npx vitest run tests/a.test.ts",
            status: "completed",
            source: "post_execution",
            check: "tests",
            exitCode: 0,
            hasOutput: true,
            summary: "1 passed",
          },
        ],
      }),
      verification: { verified: false, verdict: "INCONCLUSIVE", publishMode: "draft" },
    });

    expect(body).toContain("<summary><code>npx vitest run tests/a.test.ts tests/b.test.ts</code> failed</summary>");
    expect(body).toContain("FAIL tests/b.test.ts");
  });

  it("suppresses a multi-target failed verify.test command when later commands collectively cover every target", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence({
        commandsRun: [
          {
            command: "npx vitest run tests/a.test.ts tests/b.test.ts",
            status: "error",
            source: "post_execution",
            check: "tests",
            exitCode: 1,
            hasOutput: true,
            failureOutput: "FAIL tests/b.test.ts",
          },
          {
            command: "npx vitest run tests/a.test.ts",
            status: "completed",
            source: "post_execution",
            check: "tests",
            exitCode: 0,
            hasOutput: true,
            summary: "1 passed",
          },
          {
            command: "npx vitest run tests/b.test.ts",
            status: "completed",
            source: "post_execution",
            check: "tests",
            exitCode: 0,
            hasOutput: true,
            summary: "1 passed",
          },
        ],
      }),
      verification: { verified: true, verdict: "CONFIRMED", publishMode: "normal" },
    });

    expect(body).not.toContain("## Failed");
    expect(body).not.toContain("FAIL tests/b.test.ts");
  });

  it("keeps a targeted failed verify.test command when a later same-check wrapper has no parsed targets", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence({
        commandsRun: [
          {
            command: "npx vitest run tests/a.test.ts tests/b.test.ts",
            status: "error",
            source: "post_execution",
            check: "tests",
            exitCode: 1,
            hasOutput: true,
            failureOutput: "FAIL tests/b.test.ts",
          },
          {
            command: "npm test -- tests/a.test.ts tests/b.test.ts",
            status: "completed",
            source: "post_execution",
            check: "tests",
            exitCode: 0,
            hasOutput: true,
            summary: "2 passed",
          },
        ],
      }),
      verification: { verified: false, verdict: "INCONCLUSIVE", publishMode: "draft" },
    });

    expect(body).toContain("<summary><code>npx vitest run tests/a.test.ts tests/b.test.ts</code> failed</summary>");
    expect(body).toContain("FAIL tests/b.test.ts");
  });

  it("does not render failed agent-run tests as verify.test failures", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence({
        commandsRun: [
          {
            command: "npm test",
            status: "error",
            source: "agent",
            check: "tests",
            exitCode: null,
            hasOutput: true,
            failureOutput: "agent-run test failed",
          },
        ],
      }),
      verification: { verified: false, verdict: "INCONCLUSIVE", publishMode: "draft" },
    });

    expect(body).not.toContain("## Failed");
    expect(body).not.toContain("agent-run test failed");
  });

  it("falls back to generated body and removes a leading Summary heading", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence({ evidenceBundle: undefined }),
      generatedBody: "## Summary\n- Added health endpoint.\n- Updated tests.",
    });

    expect(body).toContain("## Summary\n\n- Added health endpoint.\n- Updated tests.");
  });

  it("strips a trailing agent Verified block from the summary", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence({
        evidenceBundle: {
          agentFinalMessage: [
            "Changed the endpoint.",
            "",
            "Verified: npm test passed.",
            "Verification target: tests/app.test.ts",
          ].join("\n"),
        },
      }),
      verification: { verified: true, verdict: "CONFIRMED", publishMode: "normal" },
    });

    expect(body).toContain("## Summary\n\nChanged the endpoint.");
    expect(body).not.toContain("Verified: npm test passed.");
    expect(body).not.toContain("Verification target:");
  });

  it("gives templates only the agent summary", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      prTemplate: {
        status: "found",
        candidate: {
          path: ".github/pull_request_template.md",
          source: "repo_local",
          content: "## Summary\n{{CYCLOID_SUMMARY}}\n\n## Testing\n{{CYCLOID_VERIFICATION}}",
        },
      },
    });

    expect(body.startsWith("## Summary")).toBe(true);
    expect(body).toContain("<!-- cycloid:managed:start summary -->\nChanged the health endpoint to return ok=true.");
    expect(body).not.toContain("{{CYCLOID_VERIFICATION}}");
    expect(body).not.toContain("<!-- cycloid:managed:start verification -->");
    expect(body).not.toContain("**Verdict:** INCONCLUSIVE");
    expect(body).not.toContain("## Request");
    expect(body).toContain(BRIDGE_VERIFICATION_RENDERED_MARKER);
  });

  const headingTemplate = {
    status: "found",
    candidate: {
      path: ".github/pull_request_template.md",
      source: "repo_local",
      content: "## Description\n\n## Implementation\n\n## Testing\n",
    },
  } as const;

  it("spreads the LLM section fill across template headings when prTemplateFill is provided", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      verification: { verified: true, verdict: "CONFIRMED", publishMode: "normal" },
      prTemplate: headingTemplate,
      prTemplateFill: {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "Top-level summary of the change.",
            factRefs: null,
            emptyReason: null,
          },
          {
            index: 1,
            heading: "Implementation",
            kind: "prose",
            text: "Edited the sign-in helper.",
            factRefs: null,
            emptyReason: null,
          },
          { index: 2, heading: "Testing", kind: "facts", text: null, factRefs: ["verification"], emptyReason: null },
        ],
      },
    });

    expect(body.indexOf("Top-level summary of the change.")).toBeGreaterThan(body.indexOf("## Description"));
    expect(body.indexOf("Edited the sign-in helper.")).toBeGreaterThan(body.indexOf("## Implementation"));
    expect(body.indexOf(BRIDGE_VERIFICATION_RENDERED_MARKER)).toBeGreaterThan(body.indexOf("## Testing"));
    // The verdict lives in the managed Cycloid QA comment, never the body.
    expect(body).not.toMatch(/\b(CONFIRMED|REFUTED|INCONCLUSIVE)\b/);
    expect(body).toContain(BRIDGE_VERIFICATION_RENDERED_MARKER);
  });

  it("includes explicitly recorded post-execution checks in verification facts", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence({
        commandsRun: [
          {
            command: "bash .cycloid/verify.sh",
            status: "completed",
            source: "post_execution",
            check: "tests",
            exitCode: 0,
            hasOutput: true,
          },
        ],
      }),
      prTemplate: headingTemplate,
      prTemplateFill: {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "Top-level summary of the change.",
            factRefs: null,
            emptyReason: null,
          },
          { index: 2, heading: "Testing", kind: "facts", text: null, factRefs: ["verification"], emptyReason: null },
        ],
      },
    });

    expect(body).toContain("`bash .cycloid/verify.sh` (tests) — passed.");
  });

  it("pulls visual evidence facts from the verification payload", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      verification: {
        verified: true,
        verdict: "CONFIRMED",
        publishMode: "normal",
        evidence: [{ type: "screenshot", label: "Checkout totals", url: "https://artifacts.example/shot.png" }],
      },
      prTemplate: {
        status: "found",
        candidate: {
          path: ".github/pull_request_template.md",
          source: "repo_local",
          content: "## Description\n\n## Screenshots\n",
        },
      },
      prTemplateFill: {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "Top-level summary of the change.",
            factRefs: null,
            emptyReason: null,
          },
          {
            index: 1,
            heading: "Screenshots",
            kind: "facts",
            text: null,
            factRefs: ["visualEvidence"],
            emptyReason: null,
          },
        ],
      },
    });

    expect(body).toContain("- [Checkout totals](https://artifacts.example/shot.png)");
  });

  it("falls back to the deterministic summary when the fill only renders facts", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence({
        commandsRun: [
          {
            command: "npm test",
            status: "completed",
            source: "post_execution",
            check: "tests",
            exitCode: 0,
            hasOutput: true,
          },
        ],
      }),
      prTemplate: {
        status: "found",
        candidate: {
          path: ".github/pull_request_template.md",
          source: "repo_local",
          content: "## Testing\n",
        },
      },
      prTemplateFill: {
        sections: [
          { index: 0, heading: "Testing", kind: "facts", text: null, factRefs: ["verification"], emptyReason: null },
        ],
      },
    });

    expect(body).toContain("## Cycloid Summary");
    expect(body).toContain("Changed the health endpoint to return ok=true.");
    expect(body).toContain("`npm test` (tests) — passed.");
  });

  it("does not render a Cycloid QA block when no verification commands were captured", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      prTemplate: headingTemplate,
    });

    expect(body).not.toContain("## Cycloid QA");
    expect(body).not.toContain("No verification commands were captured.");
  });

  it("drops fill verification prose that states a verdict word", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      verification: { verified: true, verdict: "CONFIRMED", publishMode: "normal" },
      prTemplate: headingTemplate,
      prTemplateFill: {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "Agent narrative.",
            factRefs: null,
            emptyReason: null,
          },
          {
            index: 2,
            heading: "Testing",
            kind: "prose",
            text: "Verdict: INCONCLUSIVE — needs another look.",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
    });

    expect(body).toContain("Agent narrative.");
    expect(body).not.toContain("INCONCLUSIVE");
    expect(body).toContain("## Testing");
    // Fail-closed: verdict-bearing prose is dropped entirely — no verification
    // managed block may be inserted under the Testing heading.
    expect(body).not.toContain("<!-- cycloid:managed:start verification -->");
  });

  it("falls back to the deterministic render when the fill has no sections", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      prTemplate: headingTemplate,
      prTemplateFill: { sections: [] },
    });

    expect(body).toContain("<!-- cycloid:managed:start narrative -->\nChanged the health endpoint to return ok=true.");
  });

  it("falls back to the deterministic render when no fill section matches a template heading", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      prTemplate: headingTemplate,
      prTemplateFill: {
        sections: [
          {
            index: 99,
            heading: "Overview",
            kind: "prose",
            text: "Prose aimed at a heading that is not there.",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
    });

    expect(body).not.toContain("Prose aimed at a heading that is not there.");
    expect(body).toContain("<!-- cycloid:managed:start narrative -->\nChanged the health endpoint to return ok=true.");
  });

  it("falls back to the deterministic template render when no prTemplateFill is provided", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      prTemplate: headingTemplate,
    });

    expect(body).toContain("<!-- cycloid:managed:start narrative -->\nChanged the health endpoint to return ok=true.");
    expect(body.indexOf("## Cycloid Summary")).toBeLessThan(body.indexOf("## Description"));
  });

  it("bypasses the section fill for templates with Cycloid placeholders", () => {
    const body = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      prTemplate: {
        status: "found",
        candidate: {
          path: ".github/pull_request_template.md",
          source: "repo_local",
          content: "## Summary\n{{CYCLOID_SUMMARY}}\n\n## Testing\n{{CYCLOID_VERIFICATION}}",
        },
      },
      prTemplateFill: {
        sections: [
          {
            index: 0,
            heading: "Summary",
            kind: "prose",
            text: "Fill prose that must not be used.",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
    });

    expect(body).not.toContain("Fill prose that must not be used.");
    expect(body).not.toContain("{{CYCLOID_SUMMARY}}");
    expect(body).toContain("<!-- cycloid:managed:start summary -->\nChanged the health endpoint to return ok=true.");
  });

  it("uses the default summary template when the repo has no PR template and a section fill is provided", () => {
    const fill = {
      sections: [
        {
          index: 0,
          heading: "Summary",
          kind: "prose",
          text: "Custom two-sentence summary.",
          factRefs: null,
          emptyReason: null,
        },
      ],
    } as const;
    const verification = { verified: true, verdict: "CONFIRMED", publishMode: "normal" } as const;

    const withoutFill = renderPrEvidenceCommentFromReadiness({ evidence: evidence(), verification });
    const withFillNoTemplate = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      verification,
      prTemplateFill: fill,
    });
    const withFillTemplateNone = renderPrEvidenceCommentFromReadiness({
      evidence: evidence(),
      verification,
      prTemplate: { status: "none", reason: "no_template" },
      prTemplateFill: fill,
    });

    expect(withFillNoTemplate).toContain(
      "## Summary\n\n<!-- cycloid:managed:start narrative -->\nCustom two-sentence summary.",
    );
    expect(withFillTemplateNone).toBe(withFillNoTemplate);
    expect(withFillNoTemplate).not.toBe(withoutFill);
    expect(withoutFill).toContain(BRIDGE_VERIFICATION_RENDERED_MARKER);
    expect(withoutFill).not.toContain("Custom two-sentence summary.");
    expect(withoutFill).not.toContain("## Verdict");
  });
});

import { describe, expect, it } from "vitest";

import {
  appendSessionLink,
  buildPrBody,
  fallbackPrBody,
  preserveImplementationSummary,
  preservePrEvidenceSections,
  renderCycloidVisualEvidenceFallbackSection,
  renderGithubReleaseVisualEvidenceSection,
  resolvePrTitle,
  stripCycloidCoAuthorTrailer,
  upsertVisualEvidenceSection,
} from "../../../apps/control-plane-worker/src/session/pr-body";
import type { PromptState } from "../../../apps/control-plane-worker/src/types";
import { renderPrEvidenceCommentFromReadiness } from "../../../apps/sandbox-bridge/src/services/pr";
import { CYCLOID_CO_AUTHOR_TRAILER } from "../../../shared/constants/git-identity";
import { BRIDGE_VERIFICATION_RENDERED_MARKER } from "../../../shared/post-execution";
import type { PrReadinessEvidence } from "../../../shared/types/sandbox";

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

function promptState(prompt: string, overrides: Partial<PromptState> = {}): PromptState {
  const timestamp = new Date().toISOString();
  return {
    promptId: "prompt-1",
    prompt,
    actorUserId: "user-1",
    status: "completed",
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
    result: null,
    error: null,
    ...overrides,
  };
}

describe("pr-body helpers", () => {
  it("strips the Cycloid co-author trailer from PR bodies without dropping markers", () => {
    const marker = "<!-- cycloid-dedup: sess-1:prompt-1 -->";
    const body = ["## Changes", "Updated files", "", CYCLOID_CO_AUTHOR_TRAILER, "", marker].join("\n");

    expect(stripCycloidCoAuthorTrailer(body)).toBe(["## Changes", "Updated files", "", marker].join("\n"));
  });

  it("builds a normal PR body from explicit summary text", () => {
    expect(buildPrBody(null, fallbackPrBody("Updated the session workflow"))).toBe(
      "## Changes\nUpdated the session workflow\n\n🤖 Generated with [Cycloid](https://trycycloid.com)",
    );
  });

  it("embeds explicit screenshot URL lines as markdown images", () => {
    const body = buildPrBody(
      null,
      [
        "## Verification",
        "- Before screenshot: https://github.com/user-attachments/assets/4d807a83-176e-4a2d-9f43-bb9662b96f5b",
      ].join("\n"),
    );

    expect(body).toContain(
      "- Before screenshot: ![Before screenshot](https://github.com/user-attachments/assets/4d807a83-176e-4a2d-9f43-bb9662b96f5b)",
    );
  });

  it("embeds token-gated Cycloid artifact screenshot URLs", () => {
    const url =
      "https://app.trycycloid.com/api/sessions/session-1/artifacts/artifact-1/after.png?artifactToken=token-1";
    const body = buildPrBody(null, ["## Verification", `- After screenshot: ${url}`].join("\n"));

    expect(body).toContain(`- After screenshot: ![After screenshot](${url})`);
  });

  it("leaves auth-gated Cycloid artifact screenshot URLs as links", () => {
    const url = "https://app.trycycloid.com/api/sessions/session-1/artifacts/artifact-1/after.png";
    const body = buildPrBody(null, ["## Screenshots", `- [after](${url})`].join("\n"));

    expect(body).toContain(`- [after](${url})`);
    expect(body).not.toContain(`![after](${url})`);
  });

  it("does not append deterministic verification detail text", () => {
    const beforeUrl = "https://github.com/user-attachments/assets/4d807a83-176e-4a2d-9f43-bb9662b96f5b";
    const afterUrl = "https://github.com/user-attachments/assets/aa078d1d-9882-4d06-a531-a738d822c659";

    const body = buildPrBody(null, "## Changes\nUpdated screenshots.", {
      verified: true,
      explanation: `Before screenshot: ${beforeUrl}`,
      visualAssertion: `After screenshot: ${afterUrl}`,
    });

    expect(body).toContain("- Verdict: Pass.");
    expect(body).toContain("- Publish: ready for review.");
    expect(body).not.toContain(beforeUrl);
    expect(body).not.toContain(afterUrl);
  });

  it("renders only typed verdict evidence references", () => {
    const selectedUrl = "https://app.trycycloid.com/api/sessions/session-1/artifacts/artifact-selected/selected.png";
    const unselectedUrl = "https://app.trycycloid.com/api/sessions/session-1/artifacts/artifact-extra/extra.png";

    const body = buildPrBody(null, "## Changes\nUpdated screenshots.", {
      verified: true,
      verdict: "CONFIRMED",
      artifacts: [
        {
          artifactId: "artifact-selected",
          type: "screenshot",
          label: "selected.png",
          filename: "selected.png",
          url: selectedUrl,
        },
        {
          artifactId: "artifact-extra",
          type: "screenshot",
          label: "extra.png",
          filename: "extra.png",
          url: unselectedUrl,
        },
      ],
      evidence: [
        {
          type: "screenshot",
          label: "selected.png",
          artifactId: "artifact-selected",
          status: "uploaded",
          url: selectedUrl,
          summary: "Screenshot of the fixed state",
        },
        {
          type: "log",
          label: "typecheck-pass.log",
          status: "partial",
          summary: "Focused typecheck output passed",
        },
      ],
    });

    expect(body).toContain("- Evidence:");
    expect(body).toContain(`  - [selected.png](${selectedUrl}): Screenshot of the fixed state.`);
    expect(body).toContain("  - typecheck-pass.log: Focused typecheck output passed.");
    expect(body).not.toContain(unselectedUrl);
  });

  it("appends only the compact verdict for publish preparation", () => {
    const body = buildPrBody(null, "## Changes\nUpdated publish preparation.", {
      verified: false,
      verdict: "INCONCLUSIVE",
      claim:
        "Prompt changes were preserved, but post-execution publish preparation did not complete before the session stopped.",
      explanation: "Session was stopped before post-execution publish preparation completed.",
      publishMode: "draft",
      caveats: ["No runtime artifacts were captured before session termination."],
      evidence: [
        {
          type: "command",
          label: "tests (agent)",
          status: "passed",
          command: "npm test",
        },
      ],
    });

    expect(body).toContain("## Verdict");
    expect(body).toContain("- Verdict: Needs review.");
    expect(body).toContain("- Publish: manual review.");
    expect(body).toContain("Prompt changes were preserved");
    expect(body).not.toContain("### Command Evidence");
    expect(body).toContain("Targeted tests passed.");
    expect(body).not.toContain("`npm test`");
  });

  it("renders overlapping multi-file verification runs once per target file", () => {
    const command = (files: string[]) => `npx vitest run ${files.join(" ")}`;
    const webhooksDb = "tests/test_cloudflare/webhooks-db.test.ts";
    const slackFixtures = "tests/test_cloudflare/slack-webhook-fixtures.test.ts";
    const githubWebhook = "tests/test_cloudflare/github-webhook.test.ts";
    const webhookDurability = "tests/test_cloudflare/github-webhook-durability.test.ts";
    const webhookRoutes = "tests/test_cloudflare/webhook-routes.test.ts";
    const schemaValidation = "tests/test_cloudflare/schema-validation.test.ts";

    const body = buildPrBody(null, "## Changes\nUpdated webhook verification rendering.", {
      verified: true,
      verdict: "CONFIRMED",
      evidence: [
        {
          type: "command",
          label: "tests (agent)",
          status: "passed",
          command: command([webhooksDb, slackFixtures]),
          summary: "Tests 45 passed (45).",
        },
        {
          type: "command",
          label: "tests (agent)",
          status: "passed",
          command: command([webhooksDb, slackFixtures, githubWebhook, webhookDurability, webhookRoutes]),
          summary: "Tests 86 passed (86).",
        },
        {
          type: "command",
          label: "tests (agent)",
          status: "passed",
          command: command([
            webhooksDb,
            slackFixtures,
            githubWebhook,
            webhookDurability,
            webhookRoutes,
            schemaValidation,
          ]),
          summary: "Tests 424 passed (424).",
        },
      ],
    });

    for (const file of [webhooksDb, slackFixtures, githubWebhook, webhookDurability, webhookRoutes, schemaValidation]) {
      expect(body.match(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
    }
    expect(body).toContain(`${webhooksDb} passed: ran in a suite of 6.`);
    expect(body).toContain(`${schemaValidation} passed: ran in a suite of 6.`);
    expect(body).not.toContain("Tests 45 passed");
    expect(body).not.toContain("Tests 86 passed");
    expect(body).not.toContain("Tests 424 passed");
  });

  it("ignores Vitest and Jest test-name filters when extracting target files", () => {
    const actualTarget = "tests/test_cloudflare/session/pr-body.test.ts";
    const body = buildPrBody(null, "## Changes\nUpdated target parsing.", {
      verified: true,
      verdict: "CONFIRMED",
      evidence: [
        {
          type: "command",
          label: "tests (agent)",
          status: "passed",
          command: `npx vitest run -t fake.spec.ts ${actualTarget}`,
          summary: "Tests 1 passed (1).",
        },
        {
          type: "command",
          label: "tests (agent)",
          status: "passed",
          command: `jest --testNamePattern ignored.test.ts ${actualTarget}`,
          summary: "Tests 1 passed (1).",
        },
      ],
    });

    expect(body).toContain(`${actualTarget} passed: Tests 1 passed (1).`);
    expect(body).not.toContain("fake.spec.ts passed");
    expect(body).not.toContain("ignored.test.ts passed");
  });

  it("caps expanded verification evidence lines and renders an overflow note", () => {
    const files = Array.from({ length: 14 }, (_, index) => `tests/test_cloudflare/generated-${index}.test.ts`);
    const body = buildPrBody(null, "## Changes\nUpdated target capping.", {
      verified: true,
      verdict: "CONFIRMED",
      evidence: [
        {
          type: "command",
          label: "tests (agent)",
          status: "passed",
          command: `npx vitest run ${files.join(" ")}`,
          summary: "Tests 14 passed (14).",
        },
      ],
    });

    expect(body).toContain("tests/test_cloudflare/generated-0.test.ts passed: ran in a suite of 14.");
    expect(body).toContain("tests/test_cloudflare/generated-11.test.ts passed: ran in a suite of 14.");
    expect(body).not.toContain("tests/test_cloudflare/generated-12.test.ts");
    expect(body).not.toContain("tests/test_cloudflare/generated-13.test.ts");
    expect(body).toContain("  - …and 2 more (full output in the session transcript)");
  });

  it("keeps repo-wide evidence visible when many per-file targets exceed the cap", () => {
    const files = Array.from({ length: 14 }, (_, index) => `tests/test_cloudflare/generated-${index}.test.ts`);
    const body = buildPrBody(null, "## Changes\nUpdated repo-wide evidence ordering.", {
      verified: true,
      verdict: "CONFIRMED",
      evidence: [
        {
          type: "command",
          label: "tests (agent)",
          status: "passed",
          command: `npx vitest run ${files.join(" ")}`,
          summary: "Tests 14 passed (14).",
        },
        {
          type: "command",
          label: "lint (agent)",
          status: "passed",
          command: "npm run lint",
          summary: "Lint completed successfully.",
        },
        {
          type: "command",
          label: "typecheck (agent)",
          status: "passed",
          command: "npm run typecheck",
          summary: "Typecheck completed successfully.",
        },
      ],
    });

    // Repo-wide checks must survive the cap even though 14 per-file targets follow them.
    expect(body).toContain("Lint passed: Lint completed successfully.");
    expect(body).toContain("Typecheck passed: Typecheck completed successfully.");
    // Per-file test lines overflow instead of the high-value repo-wide checks.
    expect(body).toContain("tests/test_cloudflare/generated-0.test.ts passed: ran in a suite of 14.");
    expect(body).not.toContain("tests/test_cloudflare/generated-13.test.ts");
    expect(body).toContain("  - …and 4 more (full output in the session transcript)");
  });

  it("keeps the first equal-rank target evidence entry", () => {
    const target = "tests/test_cloudflare/session/pr-body.test.ts";
    const body = buildPrBody(null, "## Changes\nUpdated target ranking.", {
      verified: true,
      verdict: "CONFIRMED",
      evidence: [
        {
          type: "command",
          label: "tests (agent)",
          status: "passed",
          command: `npx vitest run ${target}`,
          summary: "Tests 1 passed (1).",
        },
        {
          type: "command",
          label: "tests (post_execution)",
          status: "passed",
          command: `npx vitest run ${target}`,
          summary: "Tests 2 passed (2).",
        },
      ],
    });

    expect(body).toContain(`${target} passed: Tests 1 passed (1).`);
    expect(body).not.toContain(`${target} passed: Tests 2 passed (2).`);
  });

  it("collapses duplicate repo-wide command evidence by rendered line", () => {
    const body = buildPrBody(null, "## Changes\nUpdated lint rendering.", {
      verified: true,
      verdict: "CONFIRMED",
      evidence: [
        {
          type: "command",
          label: "lint (agent)",
          status: "passed",
          command: "npm run lint",
          summary: "Lint completed successfully.",
        },
        {
          type: "command",
          label: "lint (post_execution)",
          status: "passed",
          command: "npm run lint",
          summary: "Lint completed successfully.",
        },
      ],
    });

    expect(body.match(/Lint passed: Lint completed successfully\./g)).toHaveLength(1);
  });

  it("renders a structured Checks block with pass/fail and exit codes from readiness commands", () => {
    const body = buildPrBody(
      null,
      "## Changes\nUpdated checks rendering.",
      { verified: true },
      makeReadiness({
        commandsRun: [
          {
            command: "npm test",
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
            check: "typecheck",
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
      }),
    );

    expect(body).toContain("**Checks**");
    expect(body).toContain("- `npm test` — passed (exit 0)");
    expect(body).toContain("- `npx tsc --noEmit` — failed (exit 2)");
    expect(body).toContain("- `npm run lint` — skipped (verify.test lint skipped)");
  });

  it("omits the Checks block when no commands ran and caps long command lists", () => {
    const noCommands = buildPrBody(null, "## Changes\nNo checks.", { verified: false }, makeReadiness());
    expect(noCommands).not.toContain("**Checks**");

    const many = buildPrBody(
      null,
      "## Changes\nMany checks.",
      { verified: true, runtimeEvidenceRequired: true, runtimeEvidenceSatisfied: true },
      makeReadiness({
        commandsRun: Array.from({ length: 15 }, (_, i) => ({
          command: `npm run check-${i}`,
          status: "completed" as const,
          exitCode: 0,
          source: "post_execution" as const,
          hasOutput: true,
        })),
      }),
    );
    expect(many).toContain("- `npm run check-11` — passed (exit 0)");
    expect(many).not.toContain("- `npm run check-12`");
    expect(many).toContain("…and 3 more (full output in the session transcript)");
    expect(many).toContain("- Runtime evidence: captured");
  });

  it("omits the exit suffix for completed commands without a numeric exit code", () => {
    const body = buildPrBody(
      null,
      "## Changes\nPost-execution command.",
      { verified: true },
      makeReadiness({
        commandsRun: [
          {
            command: "npm test",
            status: "completed",
            exitCode: null,
            source: "post_execution",
            check: "tests",
            hasOutput: true,
          },
        ],
      }),
    );
    expect(body).toContain("- `npm test` — passed\n");
    expect(body).not.toContain("- `npm test` — passed (exit");
  });

  it("renders skipped checks and runtime evidence even when no commands ran", () => {
    const body = buildPrBody(
      null,
      "## Changes\nNo commands recorded.",
      { verified: false, runtimeEvidenceRequired: true, runtimeEvidenceSatisfied: false },
      makeReadiness({
        skippedChecks: [{ check: "typecheck", reason: "no_typecheck_command_detected" }],
      }),
    );
    expect(body).toContain("**Checks**");
    expect(body).toContain("- typecheck — skipped (no\\_typecheck\\_command\\_detected)");
    expect(body).toContain("- Runtime evidence: not captured");
  });

  it("replaces the Checks block on republish instead of duplicating it", () => {
    const readiness = makeReadiness({
      commandsRun: [
        {
          command: "npm test",
          status: "completed",
          exitCode: 0,
          source: "post_execution",
          check: "tests",
          hasOutput: true,
        },
      ],
    });
    const first = buildPrBody(null, "## Changes\nFirst publish.", { verified: true }, readiness);
    const second = buildPrBody(null, first, { verified: true }, readiness);
    expect(second.match(/\*\*Checks\*\*/g)).toHaveLength(1);
    expect(second.match(/- `npm test` — passed \(exit 0\)/g)).toHaveLength(1);
  });

  it("does not re-inject ## Verdict when the bridge body already rendered verification (#1)", () => {
    const bridgeBody = [
      "## Summary",
      "",
      "Added a guard for the lost-race path.",
      "",
      "> **✅ Verified:** Resume returns the fresh winner env.",
      "",
      "## Verification",
      "- Typecheck passed.",
      "",
      "## Changed Files",
      "- `apps/x.ts`",
      "",
      "🤖 Generated with [Cycloid](https://trycycloid.com)",
      "",
      BRIDGE_VERIFICATION_RENDERED_MARKER,
    ].join("\n");

    const body = buildPrBody(null, bridgeBody, {
      verified: true,
      verdict: "CONFIRMED",
      claim: "Resume returns the fresh winner env.",
      publishMode: "normal",
      evidence: [{ type: "command", label: "tests", status: "passed", command: "npm test" }],
    });

    // The bridge already owns verification rendering, so no second ## Verdict is injected.
    expect(body).not.toContain("## Verdict");
    expect(body).toContain("## Summary");
    expect(body).toContain("> **✅ Verified:**");
    // The claim is not duplicated (only the bridge callout carries it).
    expect(body.split("Resume returns the fresh winner env").length - 1).toBe(1);
  });

  it("keeps a bridge-rendered templated section-fill body intact (ARC-1129 end to end)", () => {
    const bridgeBody = renderPrEvidenceCommentFromReadiness({
      evidence: makeReadiness({
        evidenceBundle: {
          originalPrompt: "Fix the sign-in redirect loop.",
          agentFinalMessage: "Fixed the sign-in redirect loop.",
        },
      }),
      verification: { verified: true, verdict: "CONFIRMED", publishMode: "normal" },
      prTemplate: {
        status: "found",
        candidate: {
          path: ".github/pull_request_template.md",
          source: "repo_local",
          content: "## Description\n\n## Testing\n",
        },
      },
      prTemplateFill: {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "Restructured summary of the redirect fix.",
            factRefs: null,
            emptyReason: null,
          },
          { index: 1, heading: "Testing", kind: "facts", text: null, factRefs: ["verification"], emptyReason: null },
        ],
      },
    });

    const body = buildPrBody(null, bridgeBody, {
      verified: true,
      verdict: "CONFIRMED",
      publishMode: "normal",
    });

    // The section fill survives the control-plane pass untouched, and the
    // verdict context is never injected on top of a marker-bearing bridge body.
    expect(body).toContain("Restructured summary of the redirect fix.");
    expect(body.indexOf("Restructured summary")).toBeGreaterThan(body.indexOf("## Description"));
    expect(body.indexOf("<!-- cycloid:verification:rendered -->")).toBeGreaterThan(body.indexOf("## Testing"));
    expect(body).not.toContain("## Verdict");
    // The verdict belongs solely to the managed Cycloid QA comment.
    expect(body).not.toMatch(/\b(CONFIRMED|REFUTED|INCONCLUSIVE)\b/);
    expect(body).not.toContain("Reviewer action");
  });

  it("strips ANSI escape codes from bridge-rendered narrative and verification details", () => {
    const bridgeBody = renderPrEvidenceCommentFromReadiness({
      evidence: makeReadiness({
        evidenceBundle: {
          agentFinalMessage: "Updated \u001b[32msrc/app.ts\u001b[39m and added coverage.",
        },
        commandsRun: [
          {
            command: "npm test",
            status: "error",
            exitCode: 1,
            source: "post_execution",
            check: "tests",
            hasOutput: true,
            failureOutput: "\u001b[31mFAIL\u001b[39m tests/app.test.ts\n\u001b[2m1 failed\u001b[22m",
          },
        ],
      }),
    });

    expect(bridgeBody).toContain("Updated src/app.ts and added coverage.");
    expect(bridgeBody).toContain("FAIL tests/app.test.ts");
    expect(bridgeBody).not.toMatch(/\u001b\[/);
  });

  it("preserves the prior ## Summary narrative on automated epoch republishes (#1)", () => {
    const layout = (narrative: string, claim: string) =>
      [
        "## Summary",
        "",
        narrative,
        "",
        `> **✅ Verified:** ${claim}`,
        "",
        "## Verification",
        "- Typecheck passed.",
      ].join("\n");

    const result = preserveImplementationSummary(
      layout("Touch-up: fixed a lint nit.", "New claim."),
      layout("Original implementation: added the guard.", "Old claim."),
      true,
    );

    expect(result).toContain("Original implementation: added the guard.");
    expect(result).not.toContain("Touch-up: fixed a lint nit.");
    // Only the narrative is carried forward; the fresh run's callout stays.
    expect(result).toContain("> **✅ Verified:** New claim.");
  });

  it("keeps verbose browser diagnostics out of verdict notes", () => {
    const verboseNote = [
      "UI evidence was required, but automatic screenshot capture failed for /organization: browser capture failed (browserType.launch: Target page, context or browser has been closed",
      "Browser logs:",
      "<launching> /usr/bin/chromium --no-sandbox --disable-gpu --user-data-dir=/tmp/profile",
      "Call log:",
      "  - [pid=11766] <process did exit: exitCode=null, signal=SIGSEGV>",
      ").",
    ].join("\n");

    const body = buildPrBody(null, "## Changes\nUpdated org select.", {
      verified: true,
      verdict: "CONFIRMED",
      publishMode: "normal",
      notes: [verboseNote],
    });

    expect(body).toContain("- Verdict: Pass.");
    expect(body).toContain("Full diagnostic details are posted in the Verification Diagnostic Details PR comment.");
    expect(body).not.toContain("Browser logs:");
    expect(body).not.toContain("<launching>");
    expect(body).not.toContain("SIGSEGV");
  });

  it("adds readiness final message to the verdict summary", () => {
    const body = buildPrBody(
      null,
      "## Changed Files\n- `src/public/index.html`",
      {
        verified: true,
        verdict: "CONFIRMED",
        claim: "The rendered UI changed.",
        explanation: "Verified.",
      },
      {
        changedFiles: ["src/public/index.html"],
        diffStats: { filesChanged: 1, insertions: 1, deletions: 0 },
        commandsRun: [],
        checksDetected: { tests: false, lint: false, typecheck: false },
        skippedChecks: [],
        filesMentionedInFinalAnswer: [],
        evidenceBundle: {
          finalSummary: "Earlier progress text.",
          agentFinalMessage: "Implemented the UI change.\n\nValidated with:\n\n- npm test",
        },
      },
    );

    expect(body).toContain("Summary:\n\nImplemented the UI change.");
    expect(body).toContain("- npm test");
    expect(body).not.toContain("Earlier progress text");
    expect(body).not.toContain("```text");
    expect(body).not.toContain("Agent output");
  });

  it("does not render artifact screenshots in verification details", () => {
    const body = buildPrBody(null, "## Changes\nUpdated screenshots.", {
      verified: true,
      explanation: "Scoped verification passed.",
      artifacts: [
        {
          type: "screenshot",
          label: "After",
          url: "https://app.trycycloid.com/api/sessions/session-1/artifacts/artifact-1/after.png",
        },
      ],
    });

    expect(body).not.toContain("### Evidence");
    expect(body).not.toContain("artifact-1/after.png");
  });

  it("does not duplicate verification when the bridge rendered a managed template block", () => {
    const body = buildPrBody(
      null,
      [
        "## Testing",
        "<!-- cycloid:managed:start verification -->",
        "**Cycloid:** CONFIRMED",
        "- Verified with `npm test`.",
        "<!-- cycloid:managed:end verification -->",
      ].join("\n"),
      {
        verified: true,
        verdict: "CONFIRMED",
        explanation: "Scoped verification passed.",
        evidence: [{ type: "command", label: "tests (agent)", status: "passed", command: "npm test" }],
      },
    );

    expect(body).toContain("<!-- cycloid:managed:start verification -->");
    expect(body).not.toContain("## Verification Verdict");
    expect(body).not.toContain("## Verification Details");
    expect(body).not.toContain("## Verdict");
  });

  it("puts the verdict before fallback Changes bodies", () => {
    const body = buildPrBody(null, fallbackPrBody("Updated the session workflow"), {
      verified: true,
      verdict: "CONFIRMED",
      explanation: "Scoped verification passed.",
      evidence: [{ type: "command", label: "tests (agent)", status: "passed", command: "npm test" }],
    });

    expect(body.indexOf("## Verdict")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("## Changes")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("## Verdict")).toBeLessThan(body.indexOf("## Changes"));
  });

  it("keeps the verdict before walkthrough video sections", () => {
    const body = buildPrBody(
      null,
      [
        "## Walkthrough Video",
        "[walkthrough.webm](https://app.trycycloid.com/api/sessions/s-1/artifacts/a-1/walkthrough.webm)",
        "",
        "## Summary",
        "- Captured UI evidence.",
      ].join("\n"),
      {
        verified: false,
        verdict: "INCONCLUSIVE",
        explanation: "Manual review required.",
        publishMode: "draft",
      },
    );

    expect(body.indexOf("## Verdict")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("## Walkthrough Video")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("## Verdict")).toBeLessThan(body.indexOf("## Walkthrough Video"));
  });

  it("renders GitHub release visual evidence in the PR body", () => {
    const section = renderGithubReleaseVisualEvidenceSection([
      {
        type: "screenshot",
        label: "before-after/after-home.png",
        browserDownloadUrl:
          "https://github.com/acme/repo/releases/download/cycloid-evidence-0001/pr-42-sess-session1-art-after-a1.png",
      },
      {
        type: "video",
        label: "auto-ui/walkthrough-home.webm",
        browserDownloadUrl:
          "https://github.com/acme/repo/releases/download/cycloid-evidence-0001/pr-42-sess-session1-art-video-b2.webm",
      },
    ]);

    expect(section).toContain("## Screenshots or Recordings");
    expect(section).toContain("<!-- cycloid:managed:start visualEvidence -->");
    expect(section).toContain(
      "[before-after/after-home.png](https://github.com/acme/repo/releases/download/cycloid-evidence-0001/pr-42-sess-session1-art-after-a1.png)",
    );
    expect(section).toContain("<img");
    expect(section).toContain('width="720"');
    expect(section).toContain("### Recordings");
    expect(section).toContain("[auto-ui/walkthrough-home.webm]");
  });

  it("renders staged desktop evidence as concise PR copy", () => {
    const section = renderGithubReleaseVisualEvidenceSection([
      {
        type: "video",
        label: "desktop-checkout-flow-walkthrough.webm",
        browserDownloadUrl: "https://github.com/acme/repo/releases/download/cycloid-evidence-0001/desktop-video.webm",
      },
      {
        type: "screenshot",
        label: "desktop-checkout-flow-proof-1.webp",
        browserDownloadUrl: "https://github.com/acme/repo/releases/download/cycloid-evidence-0001/desktop-proof-1.webp",
      },
      {
        type: "screenshot",
        label: "desktop-checkout-flow-proof-2.webp",
        browserDownloadUrl: "https://github.com/acme/repo/releases/download/cycloid-evidence-0001/desktop-proof-2.webp",
      },
    ]);

    expect(section).toContain("### Desktop evidence");
    expect(section).toContain(
      "Desktop walkthrough: [Desktop walkthrough video](https://github.com/acme/repo/releases/download/cycloid-evidence-0001/desktop-video.webm)",
    );
    expect(section).toContain(
      "Proof screenshots: [Proof screenshot 1](https://github.com/acme/repo/releases/download/cycloid-evidence-0001/desktop-proof-1.webp), [Proof screenshot 2](https://github.com/acme/repo/releases/download/cycloid-evidence-0001/desktop-proof-2.webp)",
    );
    expect(section).toContain("Verified flow: Checkout flow.");
    expect(section).not.toContain("<img");
    expect(section).not.toContain("Evidence caveat:");
  });

  it("replaces only the managed visual evidence block and preserves nearby user edits", () => {
    const body = [
      "## Summary",
      "- User summary.",
      "",
      "## Screenshots or Recordings",
      "User note above.",
      "<!-- cycloid:managed:start visualEvidence -->",
      "- [old](https://app.trycycloid.com/old.png)",
      "<!-- cycloid:managed:end visualEvidence -->",
      "User note below.",
      "",
      "## Verification",
      "- Passed.",
    ].join("\n");

    const next = upsertVisualEvidenceSection(
      body,
      renderGithubReleaseVisualEvidenceSection([
        {
          type: "screenshot",
          label: "after.png",
          browserDownloadUrl:
            "https://github.com/acme/repo/releases/download/cycloid-evidence-0001/pr-42-sess-session1-art-after-a1.png",
        },
      ]),
    );

    expect(next).toContain("User note above.");
    expect(next).toContain("User note below.");
    expect(next).toContain("<img");
    expect(next).not.toContain("old.png");
  });

  it("renders fallback visual evidence as links to Cycloid artifacts", () => {
    const section = renderCycloidVisualEvidenceFallbackSection([
      {
        type: "screenshot",
        label: "After",
        url: "https://app.trycycloid.com/api/sessions/s-1/artifacts/a-1/after.png",
      },
      {
        type: "video",
        label: "Walkthrough",
        url: "https://app.trycycloid.com/api/sessions/s-1/artifacts/a-2/walkthrough.webm",
      },
    ]);

    expect(section).toContain("- [After](https://app.trycycloid.com/api/sessions/s-1/artifacts/a-1/after.png)");
    expect(section).toContain(
      "- [Walkthrough](https://app.trycycloid.com/api/sessions/s-1/artifacts/a-2/walkthrough.webm)",
    );
    expect(section).not.toContain("<img");
  });

  it("renders fallback desktop evidence with a concise caveat", () => {
    const section = renderCycloidVisualEvidenceFallbackSection([
      {
        type: "video",
        label: "desktop-checkout-flow-walkthrough.webm",
        url: "https://app.trycycloid.com/api/sessions/s-1/artifacts/a-1/desktop-checkout-flow-walkthrough.webm",
        renderMode: "link",
      },
      {
        type: "screenshot",
        label: "desktop-checkout-flow-proof-1.webp",
        url: "https://app.trycycloid.com/api/sessions/s-1/artifacts/a-2/desktop-checkout-flow-proof-1.webp",
        renderMode: "link",
      },
    ]);

    expect(section).toContain("### Desktop evidence");
    expect(section).toContain("Desktop walkthrough: [Desktop walkthrough video]");
    expect(section).toContain("Proof screenshots: [Proof screenshot 1]");
    expect(section).toContain("Verified flow: Checkout flow.");
    expect(section).toContain(
      "Evidence caveat: GitHub-hosted evidence could not be published; links use Cycloid artifact URLs.",
    );
    expect(section).not.toContain("### Screenshots");
    expect(section).not.toContain("<img");
  });

  // ARC-947 regression: buildPrBody must still prepend the Linear `Resolves`
  // line when the body contains an Evidence Bundle list item carrying the same
  // Linear URL. The old appendLinearLink dedupe treated any URL substring as
  // proof of existing link and skipped insertion, leaving Linear unable to
  // associate the PR with the originating ticket.
  it("prepends Linear Resolves line even when Evidence Bundle contains the issue URL", () => {
    const linearContext = {
      identifier: "ARC-947",
      url: "https://linear.app/cycloid2/issue/ARC-947/linear-pr-linking-regression",
    };
    const incomingBody = [
      "## Summary",
      "- Fixed Linear PR-linking dedupe.",
      "",
      "## Evidence Bundle",
      "- Session: https://app.trycycloid.com/sessions/session-1",
      `- Issue: ${linearContext.url}`,
      "- Original task: Fix Linear PR-linking regression.",
    ].join("\n");

    const body = buildPrBody({ linearContext }, incomingBody);
    expect(body.startsWith(`Resolves ${linearContext.url}`)).toBe(true);
    expect(body).toContain(`- Issue: ${linearContext.url}`);
  });

  it("adds session links outside the pure body builder", () => {
    const body = buildPrBody(
      {
        linearContext: {
          identifier: "ARC-778",
          url: "https://linear.app/cycloid2/issue/ARC-778/reduce-sessionprworkflowimpl",
        },
      },
      fallbackPrBody("Split PR workflow helpers"),
    );

    expect(appendSessionLink(body, "sess-123", "https://app.trycycloid.com")).toContain(
      "📋 [Session transcript](https://app.trycycloid.com/sessions/sess-123)",
    );
  });

  it("derives titles from edge-case task input without leaking metadata", () => {
    const prompts = [
      promptState("Earlier request", { promptId: "prompt-1" }),
      promptState(
        [
          "verify=true",
          "Repository: trycycloid/cycloid",
          "Head SHA: abc123",
          "Base Branch: main",
          "[cycloid:review-loop attempt=2]",
          "Review-loop worklist:",
          "Review-loop action items:",
          "Issue URL: https://linear.app/cycloid2/issue/ARC-778/foo",
          "<user_content>",
          "- [x] Reduce SessionPrWorkflowImpl into helpers",
          "</user_content>",
        ].join("\n"),
      ),
    ];

    expect(resolvePrTitle(undefined, "Repository: trycycloid/cycloid", prompts)).toBe(
      "Reduce SessionPrWorkflowImpl into helpers",
    );
    expect(resolvePrTitle(undefined, "verify=true", prompts)).toBe("Reduce SessionPrWorkflowImpl into helpers");
  });

  it("normalizes explicit titles without the ARC prefix", () => {
    expect(resolvePrTitle("Fix login bug", null, [])).toBe("Fix login bug");
    expect(resolvePrTitle("[ARC] Fix login bug", null, [])).toBe("Fix login bug");
    expect(resolvePrTitle("[ARC]Fix login bug", null, [])).toBe("Fix login bug");
  });

  it("prefixes the resolved title with the provided ticket key", () => {
    expect(resolvePrTitle(undefined, "Fix dashboard setup documentation", [], "ENG-9001")).toBe(
      "ENG-9001 Fix dashboard setup documentation",
    );
  });

  it("collapses a `KEY:` colon in the resolved title to the bare `KEY ` form", () => {
    // A sessionTitle that still carries the colon would fail the title check.
    expect(resolvePrTitle(undefined, "ENG-9001: Fix dashboard setup documentation", [], "ENG-9001")).toBe(
      "ENG-9001 Fix dashboard setup documentation",
    );
  });

  it("prefixes an explicit override title and is idempotent if already prefixed", () => {
    expect(resolvePrTitle("Fix dashboard setup documentation", null, [], "ENG-9001")).toBe(
      "ENG-9001 Fix dashboard setup documentation",
    );
    expect(resolvePrTitle("ENG-9001 Fix dashboard setup documentation", null, [], "ENG-9001")).toBe(
      "ENG-9001 Fix dashboard setup documentation",
    );
  });

  it("does not prefix when no ticket key is provided", () => {
    expect(resolvePrTitle(undefined, "Fix the dashboard setup documentation", [], null)).toBe(
      "Fix the dashboard setup documentation",
    );
  });

  it("does not double the key when the resolved title already contains it mid-string", () => {
    expect(resolvePrTitle(undefined, "hey cycloid work on ENG-9001", [], "ENG-9001")).toBe(
      "ENG-9001 hey cycloid work on",
    );
  });

  it("prefixes the prompt-derived fallback title with the ticket key", () => {
    // No override and no sessionTitle → fallbackPrTitle derives from the prompt;
    // the pre-resolved key still prefixes it.
    const prompts = [promptState("Fix the dashboard setup documentation")];
    expect(resolvePrTitle(undefined, null, prompts, "ENG-9001")).toBe("ENG-9001 Fix the dashboard setup documentation");
  });

  it("preserves sticky evidence content that contains fenced markdown headings", () => {
    const previousBody = [
      "## Summary",
      "- Captured evidence.",
      "",
      "## Screenshots",
      "```md",
      "## not a real section boundary",
      "```",
      "![after](https://app.trycycloid.com/api/sessions/session-1/artifacts/after.png)",
      "",
      "## Verification",
      "- Passed.",
    ].join("\n");

    const nextBody = "## Summary\n- Follow-up.\n\n## Verification\n- Passed again.";

    const preserved = preservePrEvidenceSections(nextBody, previousBody);

    expect(preserved).toContain("```md\n## not a real section boundary\n```");
    expect(preserved).toContain("![after](https://app.trycycloid.com/api/sessions/session-1/artifacts/after.png)");
  });

  it("normalizes preserved screenshot evidence links to markdown images", () => {
    const previousBody = [
      "## Summary",
      "- Captured evidence.",
      "",
      "## Screenshots",
      "- [after](https://github.com/user-attachments/assets/4d807a83-176e-4a2d-9f43-bb9662b96f5b)",
      "",
      "## Verification",
      "- Passed.",
    ].join("\n");

    const nextBody = "## Summary\n- Follow-up.\n\n## Verification\n- Passed again.";

    const preserved = preservePrEvidenceSections(nextBody, previousBody);

    expect(preserved).toContain(
      "- ![after](https://github.com/user-attachments/assets/4d807a83-176e-4a2d-9f43-bb9662b96f5b)",
    );
  });

  it("does not restore verbose readiness sections when a retry falls back to a plain body", () => {
    const previousBody = [
      "## Summary",
      "- Captured evidence.",
      "",
      "## Evidence Bundle",
      "- Session: https://app.trycycloid.com/sessions/session-1",
      "- Issue: https://linear.app/acme/issue/ARC-777/fix-evidence",
      "- Original task: Fix evidence capture.",
      "",
      "## Changed Files",
      "- Sandbox bridge: `apps/sandbox-bridge/src/services/pr.ts`",
      "",
      "## Verification",
      "- Tests: completed (agent) `docker exec web pytest tests/test_api.py`.",
      "",
      "## Risk Notes",
      "- Sandbox bridge: `apps/sandbox-bridge/src/services/pr.ts`",
    ].join("\n");

    const nextBody = fallbackPrBody("Fallback body after PR update retry");

    const preserved = preservePrEvidenceSections(nextBody, previousBody);

    expect(preserved).not.toContain("## Evidence Bundle");
    expect(preserved).not.toContain("## Changed Files");
    expect(preserved).not.toContain("## Verification");
    expect(preserved).not.toContain("## Risk Notes");
  });

  it("preserves screenshots and videos after a fresh verdict instead of before it", () => {
    const previousBody = [
      "## Verification Verdict",
      "- Verdict: INCONCLUSIVE.",
      "",
      "## Walkthrough Video",
      "- [walkthrough.webm](https://example.com/walkthrough.webm)",
      "",
      "## Screenshots",
      "![before](https://github.com/user-attachments/assets/before)",
      "",
      "## Videos",
      "- [secondary.webm](https://example.com/secondary.webm)",
    ].join("\n");

    const nextBody = [
      "## Verification Verdict",
      "- Verdict: CONFIRMED.",
      "- Publish: ready for review.",
      "- Evidence:",
      "  - command: tests (agent) passed. `npm test`",
      "- Caveats: none recorded.",
      "- Reviewer action: inspect the evidence and changed files before merge.",
      "",
      "## Summary",
      "- Follow-up.",
    ].join("\n");

    const preserved = preservePrEvidenceSections(nextBody, previousBody);

    expect(preserved.indexOf("## Verification Verdict")).toBeGreaterThanOrEqual(0);
    expect(preserved.indexOf("## Walkthrough Video")).toBeGreaterThanOrEqual(0);
    expect(preserved.indexOf("## Screenshots")).toBeGreaterThanOrEqual(0);
    expect(preserved.indexOf("## Videos")).toBeGreaterThanOrEqual(0);
    expect(preserved.indexOf("## Verification Verdict")).toBeLessThan(preserved.indexOf("## Walkthrough Video"));
    expect(preserved.indexOf("## Verification Verdict")).toBeLessThan(preserved.indexOf("## Screenshots"));
    expect(preserved.indexOf("## Verification Verdict")).toBeLessThan(preserved.indexOf("## Videos"));
    expect(preserved).toContain("- Verdict: CONFIRMED.");
    expect(preserved).not.toContain("- Verdict: INCONCLUSIVE.");
  });

  it("does not restore old evidence when the new body explicitly includes the sticky section", () => {
    const previousBody = [
      "## Summary",
      "- Captured evidence.",
      "",
      "## Screenshots",
      "![stale](https://app.trycycloid.com/api/sessions/session-1/artifacts/stale.png)",
      "",
      "## Verification",
      "- Passed.",
    ].join("\n");

    const nextBody = "## Summary\n- Follow-up.\n\n## Screenshots\n\n## Verification\n- Passed again.";

    const preserved = preservePrEvidenceSections(nextBody, previousBody);

    expect(preserved).toContain("## Screenshots\n\n## Verification");
    expect(preserved).not.toContain("![stale]");
  });

  it("ignores sticky heading text inside fenced code blocks in the new body", () => {
    const previousBody = [
      "## Summary",
      "- Captured evidence.",
      "",
      "## Screenshots",
      "![after](https://app.trycycloid.com/api/sessions/session-1/artifacts/after.png)",
      "",
      "## Verification",
      "- Passed.",
    ].join("\n");

    const nextBody = [
      "## Summary",
      "- Follow-up.",
      "",
      "```md",
      "## Screenshots",
      "```",
      "",
      "## Verification",
      "- Passed again.",
    ].join("\n");

    const preserved = preservePrEvidenceSections(nextBody, previousBody);

    expect(preserved).toContain("```md\n## Screenshots\n```");
    expect(preserved).toContain("![after](https://app.trycycloid.com/api/sessions/session-1/artifacts/after.png)");
  });
});

describe("preserveImplementationSummary", () => {
  const implementationBody = [
    "## Verdict",
    "- Verdict: CONFIRMED.",
    "- Publish: ready for review.",
    "",
    "Summary:",
    "",
    "Implemented IN-clause chunking for getEvaluationsBySessions.",
    "",
    "## Changed Files",
    "- apps/control-plane-worker/src/dao/eval-db.ts",
  ].join("\n");

  const reviewLoopBody = [
    "## Verdict",
    "- Verdict: INCONCLUSIVE.",
    "- Publish: manual review.",
    "",
    "Summary:",
    "",
    "Addressed the review-loop item and replied through cycloid.review_loop_reply.",
    "",
    "## Changed Files",
    "- apps/control-plane-worker/src/dao/eval-db.ts",
  ].join("\n");

  it("restores the prior summary on an automated epoch run", () => {
    const result = preserveImplementationSummary(reviewLoopBody, implementationBody, true);
    expect(result).toContain("Implemented IN-clause chunking for getEvaluationsBySessions.");
    expect(result).not.toContain("Addressed the review-loop item");
    expect(result).toContain("- Verdict: INCONCLUSIVE.");
    expect(result).toContain("## Changed Files");
  });

  it("leaves the summary untouched on a non-epoch run", () => {
    expect(preserveImplementationSummary(reviewLoopBody, implementationBody, false)).toBe(reviewLoopBody);
  });

  it("returns the body unchanged when the previous body has no Summary block", () => {
    const previousWithoutSummary = "## Verdict\n- Verdict: CONFIRMED.\n\n## Changed Files\n- a.ts";
    expect(preserveImplementationSummary(reviewLoopBody, previousWithoutSummary, true)).toBe(reviewLoopBody);
  });

  it("does not inject a summary when the current body has none", () => {
    const currentWithoutSummary = "## Verdict\n- Verdict: INCONCLUSIVE.\n\n## Changed Files\n- a.ts";
    expect(preserveImplementationSummary(currentWithoutSummary, implementationBody, true)).toBe(currentWithoutSummary);
  });

  it("does not match a Summary: line inside a fenced code block", () => {
    const fencedPrevious = ["## Verdict", "", "```", "Summary:", "fenced not real", "```"].join("\n");
    expect(preserveImplementationSummary(reviewLoopBody, fencedPrevious, true)).toBe(reviewLoopBody);
  });

  it("ignores a previous Summary label that has no content", () => {
    const previousEmptySummary = [
      "## Verdict",
      "- Verdict: CONFIRMED.",
      "",
      "Summary:",
      "",
      "## Changed Files",
      "- a.ts",
    ].join("\n");
    expect(preserveImplementationSummary(reviewLoopBody, previousEmptySummary, true)).toBe(reviewLoopBody);
  });

  it("targets the verdict's Summary, not a stray Summary line above it", () => {
    const bodyWithStraySummary = [
      "Summary:",
      "Unrelated free-text note from the agent body.",
      "",
      "## Verdict",
      "- Verdict: INCONCLUSIVE.",
      "",
      "Summary:",
      "",
      "Addressed the review-loop item and replied through cycloid.review_loop_reply.",
      "",
      "## Changed Files",
      "- apps/control-plane-worker/src/dao/eval-db.ts",
    ].join("\n");
    const result = preserveImplementationSummary(bodyWithStraySummary, implementationBody, true);
    // the stray free-text note above the verdict is left intact
    expect(result).toContain("Unrelated free-text note from the agent body.");
    // the verdict's Summary is the one swapped for the prior implementation summary
    expect(result).toContain("Implemented IN-clause chunking for getEvaluationsBySessions.");
    expect(result).not.toContain("Addressed the review-loop item");
  });

  it("preserves the Summary in the PR-template managed-verification layout (no `## Verdict` heading)", () => {
    const templatePrevious = [
      "## Cycloid QA",
      "**Verdict:** CONFIRMED. Ready for review.",
      "",
      "Summary:",
      "",
      "Implemented IN-clause chunking for getEvaluationsBySessions.",
    ].join("\n");
    const templateCurrent = [
      "## Cycloid QA",
      "**Verdict:** INCONCLUSIVE. Draft/manual review required.",
      "",
      "Summary:",
      "",
      "Addressed the review-loop item and replied through cycloid.review_loop_reply.",
    ].join("\n");
    const result = preserveImplementationSummary(templateCurrent, templatePrevious, true);
    expect(result).toContain("Implemented IN-clause chunking for getEvaluationsBySessions.");
    expect(result).not.toContain("Addressed the review-loop item");
    expect(result).toContain("**Verdict:** INCONCLUSIVE. Draft/manual review required.");
  });

  it("preserves a multi-paragraph Summary including its internal blank lines", () => {
    const multiParagraphPrevious = [
      "## Verdict",
      "- Verdict: CONFIRMED.",
      "",
      "Summary:",
      "",
      "Implemented IN-clause chunking for getEvaluationsBySessions.",
      "",
      "Validated with:",
      "",
      "- npx vitest run tests/test_cloudflare/eval-db.test.ts",
      "",
      "## Changed Files",
      "- apps/control-plane-worker/src/dao/eval-db.ts",
    ].join("\n");
    const result = preserveImplementationSummary(reviewLoopBody, multiParagraphPrevious, true);
    expect(result).toContain(
      "Implemented IN-clause chunking for getEvaluationsBySessions.\n\nValidated with:\n\n- npx vitest run",
    );
    expect(result).not.toContain("Addressed the review-loop item");
  });

  it("stays stable across successive epoch republishes (idempotent)", () => {
    const firstReviewLoopBody = reviewLoopBody;
    const secondReviewLoopBody = [
      "## Verdict",
      "- Verdict: INCONCLUSIVE.",
      "- Publish: manual review.",
      "",
      "Summary:",
      "",
      "Fixed the failing typecheck CI check.",
      "",
      "## Changed Files",
      "- apps/control-plane-worker/src/dao/eval-db.ts",
    ].join("\n");
    // first epoch run preserves the implementation summary
    const afterFirst = preserveImplementationSummary(firstReviewLoopBody, implementationBody, true);
    expect(afterFirst).toContain("Implemented IN-clause chunking for getEvaluationsBySessions.");
    // second epoch run feeds the prior result back in as previousBody and must not drift
    const afterSecond = preserveImplementationSummary(secondReviewLoopBody, afterFirst, true);
    expect(afterSecond).toContain("Implemented IN-clause chunking for getEvaluationsBySessions.");
    expect(afterSecond).not.toContain("Fixed the failing typecheck CI check.");
    // the preserved Summary block is identical across runs (no compounding)
    expect(afterSecond).toBe(afterFirst);
  });
});

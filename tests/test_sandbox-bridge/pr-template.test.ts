// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  type RenderPrBodyFromReadinessInput,
  renderPrEvidenceCommentFromReadiness as renderPrBodyFromReadiness,
} from "../../apps/sandbox-bridge/src/services/pr.js";
import {
  assembleSectionFilledBody,
  type CompactPrTemplateContent,
  CycloidJsonPrTemplateProvider,
  type PrTemplateCandidate,
  renderPrBodyFromTemplate,
  RepoLocalPrTemplateProvider,
  resolvePrTemplate,
  resolvePrTemplateChain,
} from "../../apps/sandbox-bridge/src/services/pr-template.js";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "cycloid-pr-template-"));
}

function writeRepoFile(repoRoot: string, path: string, content: string): void {
  const fullPath = join(repoRoot, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

function candidate(content: string): PrTemplateCandidate {
  return { path: ".github/pull_request_template.md", source: "repo_local", content };
}

function compactContent(overrides: Partial<CompactPrTemplateContent> = {}): CompactPrTemplateContent {
  return {
    narrative: "Updated the authentication flow so expired sessions redirect to sign-in.",
    summary: "- Updated authentication flow.",
    verification: "**Cycloid:** CONFIRMED\n- Verified with `npm test -- auth.test.ts`.",
    ...overrides,
  };
}

const DUMMY_DOCKER_APP_TEMPLATE = [
  "## Summary",
  "",
  "<!-- Describe what changed and why. Keep this short and specific. -->",
  "",
  "## Related Issue",
  "",
  "<!-- Link the issue this PR closes or relates to, if any. -->",
  "<!-- Example: Closes #123 -->",
  "",
  "## Type of Change",
  "",
  "<!-- Check all that apply. -->",
  "",
  "- [ ] Bug fix",
  "- [ ] New feature",
  "- [ ] Breaking change",
  "- [ ] Documentation update",
  "- [ ] Refactor",
  "- [ ] Test update",
  "- [ ] Chore",
  "",
  "## Testing",
  "",
  "<!-- Describe the commands or manual checks you ran. -->",
  "",
  "- [ ] I ran the relevant tests",
  "- [ ] I manually verified the affected behavior",
  "- [ ] Not applicable",
  "",
  "## Screenshots or Recordings",
  "",
  "<!-- Add screenshots, recordings, or before/after notes for UI changes. Delete this section if not applicable. -->",
  "",
  "## Checklist",
  "",
  "- [ ] My changes are focused and limited to the stated scope",
  "- [ ] I updated documentation where needed",
  "- [ ] I added or updated tests where needed",
  "- [ ] I checked that the app still builds or runs locally where relevant",
].join("\n");

function readinessInput(prTemplate?: RenderPrBodyFromReadinessInput["prTemplate"]): RenderPrBodyFromReadinessInput {
  return {
    generatedBody: "## Summary\n- Update checkout copy.\n\n## Test plan\n- Tests pass.",
    prTemplate,
    evidence: {
      changedFiles: ["apps/sandbox-bridge/src/services/pr.ts"],
      diffStats: { filesChanged: 1, insertions: 3, deletions: 1 },
      commandsRun: [
        {
          command: "npx vitest run tests/test_sandbox-bridge/pr-template.test.ts",
          status: "completed",
          exitCode: 0,
          source: "post_execution",
          check: "tests",
          hasOutput: true,
        },
      ],
      checksDetected: { tests: true, lint: false, typecheck: false },
      skippedChecks: [],
      filesMentionedInFinalAnswer: ["apps/sandbox-bridge/src/services/pr.ts"],
      evidenceBundle: {
        agentFinalMessage: "Updated the checkout copy to clarify the totals line.",
        originalPrompt: "Update the checkout copy and keep the PR body compact.",
      },
    },
    verification: {
      verified: true,
      verdict: "CONFIRMED",
      status: "passed",
      explanation: "Focused tests passed.",
      mode: "commands",
      runtimeEvidenceRequired: false,
      runtimeEvidenceSatisfied: false,
      claim: "The PR template renderer preserves customer structure.",
      caveats: [],
      evidence: [
        {
          type: "command",
          label: "tests (post_execution)",
          status: "passed",
          command: "npx vitest run tests/test_sandbox-bridge/pr-template.test.ts",
        },
      ],
    },
  };
}

describe("resolvePrTemplate", () => {
  it("returns none when no template exists", async () => {
    const resolved = await resolvePrTemplate(new RepoLocalPrTemplateProvider(tempRepo()));
    expect(resolved).toEqual({ status: "none", reason: "no_template" });
  });

  it("selects cycloid.md before default templates", async () => {
    const repo = tempRepo();
    writeRepoFile(repo, ".github/PULL_REQUEST_TEMPLATE/cycloid.md", "cycloid");
    writeRepoFile(repo, ".github/pull_request_template.md", "default");

    const resolved = await resolvePrTemplate(new RepoLocalPrTemplateProvider(repo));

    expect(resolved.status).toBe("found");
    expect(resolved.status === "found" ? resolved.candidate.path : "").toBe(".github/PULL_REQUEST_TEMPLATE/cycloid.md");
    expect(resolved.status === "found" ? resolved.candidate.content : "").toBe("cycloid");
  });

  it("selects default templates before generic directory templates", async () => {
    const repo = tempRepo();
    writeRepoFile(repo, ".github/pull_request_template.md", "default");
    writeRepoFile(repo, ".github/PULL_REQUEST_TEMPLATE/feature.md", "feature");

    const resolved = await resolvePrTemplate(new RepoLocalPrTemplateProvider(repo));

    expect(resolved.status).toBe("found");
    expect(resolved.status === "found" ? resolved.candidate.path : "").toBe(".github/pull_request_template.md");
  });

  it("uses one generic template and refuses ambiguous generic templates", async () => {
    const one = tempRepo();
    writeRepoFile(one, ".github/PULL_REQUEST_TEMPLATE/feature.md", "feature");
    const oneResolved = await resolvePrTemplate(new RepoLocalPrTemplateProvider(one));
    expect(oneResolved.status).toBe("found");
    expect(oneResolved.status === "found" ? oneResolved.candidate.path : "").toBe(
      ".github/PULL_REQUEST_TEMPLATE/feature.md",
    );

    const many = tempRepo();
    writeRepoFile(many, ".github/PULL_REQUEST_TEMPLATE/feature.md", "feature");
    writeRepoFile(many, ".github/PULL_REQUEST_TEMPLATE/fix.md", "fix");
    await expect(resolvePrTemplate(new RepoLocalPrTemplateProvider(many))).resolves.toEqual({
      status: "none",
      reason: "multiple_templates_ambiguous",
    });
  });

  it("fails soft for oversized template files", async () => {
    const repo = tempRepo();
    writeRepoFile(repo, ".github/pull_request_template.md", "x".repeat(129 * 1024));

    await expect(resolvePrTemplate(new RepoLocalPrTemplateProvider(repo))).resolves.toEqual({
      status: "none",
      reason: "no_template",
    });
  });

  it("ignores symlinked template files before reading their targets", async () => {
    const repo = tempRepo();
    writeRepoFile(repo, ".env", "SECRET_TOKEN=should-not-render");
    mkdirSync(join(repo, ".github"), { recursive: true });
    symlinkSync("../.env", join(repo, ".github/pull_request_template.md"));

    const resolved = await resolvePrTemplate(new RepoLocalPrTemplateProvider(repo));

    expect(resolved).toEqual({ status: "none", reason: "no_template" });
  });
});

describe("CycloidJsonPrTemplateProvider", () => {
  function writeCycloidConfig(repo: string, config: unknown): void {
    writeRepoFile(repo, ".cycloid.json", JSON.stringify(config));
  }

  it("resolves the template at pr.templatePath", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { pr: { templatePath: "docs/templates/pr.md" } });
    writeRepoFile(repo, "docs/templates/pr.md", "## Summary\n\n{{CYCLOID_SUMMARY}}\n");
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo));
    expect(resolved).toEqual({
      status: "found",
      candidate: {
        path: "docs/templates/pr.md",
        source: "cycloid_config",
        content: "## Summary\n\n{{CYCLOID_SUMMARY}}\n",
      },
    });
  });

  it("returns none when there is no .cycloid.json", async () => {
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(tempRepo()));
    expect(resolved).toEqual({ status: "none", reason: "no_template" });
  });

  it("returns none when .cycloid.json is invalid JSON", async () => {
    const repo = tempRepo();
    writeRepoFile(repo, ".cycloid.json", "{ not json");
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo));
    expect(resolved.status).toBe("none");
  });

  it("returns none when pr.templatePath is absent", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { appRuntime: { kind: "web" } });
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo));
    expect(resolved.status).toBe("none");
  });

  it("returns none when pr.templatePath is not a string", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { pr: { templatePath: 42 } });
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo));
    expect(resolved.status).toBe("none");
  });

  it("refuses path traversal and non-markdown paths", async () => {
    const repo = tempRepo();
    writeRepoFile(repo, "secret.md", "## secret");
    writeCycloidConfig(repo, { pr: { templatePath: "../secret.md" } });
    expect((await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo))).status).toBe("none");

    writeCycloidConfig(repo, { pr: { templatePath: "/etc/passwd.md" } });
    expect((await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo))).status).toBe("none");

    writeRepoFile(repo, "pr.txt", "not markdown");
    writeCycloidConfig(repo, { pr: { templatePath: "pr.txt" } });
    expect((await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo))).status).toBe("none");
  });

  it("returns none when the configured template file does not exist", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { pr: { templatePath: "docs/missing.md" } });
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo));
    expect(resolved.status).toBe("none");
  });

  it("refuses a path that escapes the repo via an intermediate symlinked directory", async () => {
    const repo = tempRepo();
    // A markdown file outside the repo, reachable only through a symlinked dir.
    const outside = tempRepo();
    writeRepoFile(outside, "template.md", "## secret outside the repo");
    symlinkSync(outside, join(repo, "link"));
    writeCycloidConfig(repo, { pr: { templatePath: "link/template.md" } });
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo));
    expect(resolved.status).toBe("none");
  });
});

describe("resolvePrTemplateChain", () => {
  function writeCycloidConfig(repo: string, config: unknown): void {
    writeRepoFile(repo, ".cycloid.json", JSON.stringify(config));
  }

  it("prefers the .cycloid.json template over the .github auto-discovered one", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { pr: { templatePath: "docs/custom-pr.md" } });
    writeRepoFile(repo, "docs/custom-pr.md", "## Custom\n");
    writeRepoFile(repo, ".github/pull_request_template.md", "## GitHub default\n");
    const resolved = await resolvePrTemplateChain([
      new CycloidJsonPrTemplateProvider(repo),
      new RepoLocalPrTemplateProvider(repo),
    ]);
    expect(resolved).toEqual({
      status: "found",
      candidate: { path: "docs/custom-pr.md", source: "cycloid_config", content: "## Custom\n" },
    });
  });

  it("falls through to .github auto-discovery when the .cycloid.json path is invalid", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { pr: { templatePath: "docs/missing.md" } });
    writeRepoFile(repo, ".github/pull_request_template.md", "## GitHub default\n");
    const resolved = await resolvePrTemplateChain([
      new CycloidJsonPrTemplateProvider(repo),
      new RepoLocalPrTemplateProvider(repo),
    ]);
    expect(resolved).toEqual({
      status: "found",
      candidate: { path: ".github/pull_request_template.md", source: "repo_local", content: "## GitHub default\n" },
    });
  });

  it("REGRESSION: a repo with only a .github template resolves exactly as today", async () => {
    const repo = tempRepo();
    writeRepoFile(repo, ".github/pull_request_template.md", "## GitHub default\n");
    const viaChain = await resolvePrTemplateChain([
      new CycloidJsonPrTemplateProvider(repo),
      new RepoLocalPrTemplateProvider(repo),
    ]);
    const viaLegacy = await resolvePrTemplate(new RepoLocalPrTemplateProvider(repo));
    expect(viaChain).toEqual(viaLegacy);
    expect(viaChain.status).toBe("found");
  });

  it("returns none when no provider resolves a template", async () => {
    const repo = tempRepo();
    const resolved = await resolvePrTemplateChain([
      new CycloidJsonPrTemplateProvider(repo),
      new RepoLocalPrTemplateProvider(repo),
    ]);
    expect(resolved.status).toBe("none");
  });
});

describe("renderPrBodyFromTemplate", () => {
  it("replaces placeholders with managed blocks", () => {
    const body = renderPrBodyFromTemplate({
      template: candidate("## Summary\n{{CYCLOID_SUMMARY}}\n\n## Test Plan\n{{CYCLOID_VERIFICATION}}"),
      content: compactContent(),
    });

    expect(body).toContain("<!-- cycloid:managed:start summary -->");
    expect(body).toContain("- Updated authentication flow.");
    expect(body).toContain("<!-- cycloid:managed:start verification -->");
    expect(body).not.toContain("{{CYCLOID_SUMMARY}}");
    expect(body).not.toContain("{{CYCLOID_VERIFICATION}}");
  });

  it("removes placeholders for empty slots", () => {
    const body = renderPrBodyFromTemplate({
      template: candidate("## Summary\n{{CYCLOID_SUMMARY}}\n\n## Test Plan\n{{CYCLOID_VERIFICATION}}"),
      content: compactContent({ verification: "" }),
    });

    expect(body).toContain("<!-- cycloid:managed:start summary -->");
    expect(body).not.toContain("{{CYCLOID_VERIFICATION}}");
    expect(body).not.toContain("<!-- cycloid:managed:start verification -->");
    expect(body).not.toContain("## Cycloid QA");
  });

  it("prepends a complete Cycloid fallback without changing customer checklist text", () => {
    const body = renderPrBodyFromTemplate({
      template: candidate(
        [
          "## Description",
          "Customer-written text.",
          "",
          "## Testing",
          "- [ ] I ran the tests",
          "",
          "## Screenshots",
          "N/A",
        ].join("\n"),
      ),
      content: compactContent(),
    });

    expect(body).toContain("## Cycloid Summary");
    expect(body.indexOf("## Cycloid Summary")).toBeLessThan(body.indexOf("## Description"));
    expect(body).toContain("Customer-written text.");
    expect(body).toContain("- [ ] I ran the tests");
    expect(body).toContain("<!-- cycloid:managed:start narrative -->");
    expect(body).toContain("<!-- cycloid:managed:start verification -->");
  });

  it("keeps one complete Cycloid fallback section when rerendered", () => {
    const first = renderPrBodyFromTemplate({
      template: candidate("## Summary\nCustomer summary."),
      content: compactContent(),
    });
    const second = renderPrBodyFromTemplate({
      template: { ...candidate(first), content: first },
      content: compactContent({ verification: "**Cycloid:** INCONCLUSIVE\n- Preview startup failed." }),
    });

    expect(second.match(/## Cycloid Summary/g)).toHaveLength(1);
    expect(second.match(/<!-- cycloid:managed:start verification -->/g)).toHaveLength(1);
    expect(second).toContain("**Cycloid:** INCONCLUSIVE");
    expect(second).not.toContain("**Cycloid:** CONFIRMED");
  });

  it("integrates Cycloid verification into the dummy Docker app PR template", () => {
    const body = renderPrBodyFromReadiness(
      readinessInput({
        status: "found",
        candidate: candidate(DUMMY_DOCKER_APP_TEMPLATE),
      }),
    );

    expect(body).toContain("## Related Issue");
    expect(body).toContain("## Type of Change");
    expect(body).toContain("## Checklist");
    expect(body).toContain("<!-- cycloid:managed:start narrative -->");
    expect(body).toContain("<!-- cycloid:managed:start verification -->");
    expect(body).not.toContain("<!-- cycloid:managed:start visualEvidence -->");
    expect(body).not.toContain("**Verdict:** INCONCLUSIVE");
    expect(body).toContain("Updated the checkout copy to clarify the totals line.");
    expect(body).toContain("- [ ] I ran the relevant tests");
    expect(body).toContain("- [ ] I manually verified the affected behavior");
    expect(body).toContain("- [ ] Not applicable");
    expect(body).toContain("- [ ] My changes are focused and limited to the stated scope");
    expect(body).toContain("- [ ] I updated documentation where needed");
    expect(body).toContain("- [ ] I added or updated tests where needed");
    expect(body).toContain("- [ ] I checked that the app still builds or runs locally where relevant");
    expect(body).toContain("- [ ] Documentation update");
    expect(body).toContain("- [ ] Test update");
    expect(body).not.toContain("## Changed Files");
    expect(body).not.toContain("## Quality Gates");

    const screenshotsSection = body.slice(body.indexOf("## Screenshots or Recordings"), body.indexOf("## Checklist"));
    expect(screenshotsSection).not.toContain("<!-- cycloid:managed:start visualEvidence -->");
    expect(screenshotsSection).not.toContain("[checkout screenshot](https://example.com/checkout.png)");
  });

  it("prepends fallback content above non-placeholder customer headings", () => {
    const body = renderPrBodyFromTemplate({
      template: candidate(["## Description", "", "## Testing", "", "## Changed Files", ""].join("\n")),
      content: compactContent(),
    });
    const fallbackIndex = body.indexOf("## Cycloid Summary");
    const descIndex = body.indexOf("## Description");
    const narrativeIndex = body.indexOf("<!-- cycloid:managed:start narrative -->");
    const testingIndex = body.indexOf("## Testing");
    const verificationIndex = body.indexOf("<!-- cycloid:managed:start verification -->");
    expect(fallbackIndex).toBe(0);
    expect(narrativeIndex).toBeGreaterThan(fallbackIndex);
    expect(narrativeIndex).toBeLessThan(testingIndex);
    expect(body).toContain("Updated the authentication flow so expired sessions redirect to sign-in.");
    expect(verificationIndex).toBeLessThan(descIndex);
    expect(descIndex).toBeLessThan(testingIndex);
  });

  it("does not render the full default Cycloid body in template mode", () => {
    const body = renderPrBodyFromReadiness(
      readinessInput({
        status: "found",
        candidate: candidate("## Summary\n{{CYCLOID_SUMMARY}}\n\n## Test Plan\n{{CYCLOID_VERIFICATION}}"),
      }),
    );

    expect(body).toContain("## Test Plan");
    expect(body).toContain("<!-- cycloid:managed:start verification -->");
    expect(body).not.toContain("{{CYCLOID_VERIFICATION}}");
    expect(body).not.toContain("## Changed Files");
    expect(body).not.toContain("## Quality Gates");
    expect(body).not.toContain("## Skipped Verification");
  });

  it("does not add a compact risk bullet when no risk notes exist", () => {
    const body = renderPrBodyFromReadiness(
      readinessInput({
        status: "found",
        candidate: candidate(
          "## Summary\n{{CYCLOID_SUMMARY}}\n\n## Testing\n{{CYCLOID_VERIFICATION}}\n\n## Risk\nCustomer notes.",
        ),
      }),
    );

    expect(body).toContain("## Risk");
    expect(body).toContain("Customer notes.");
    expect(body).not.toContain("<!-- cycloid:managed:start risk -->");
    expect(body).not.toContain("No PR-specific risk notes were captured.");
  });

  it("uses the minimal default body when no template is selected", () => {
    const body = renderPrBodyFromReadiness(readinessInput({ status: "none", reason: "no_template" }));

    expect(body).not.toContain("**Verdict:** INCONCLUSIVE");
    expect(body).toContain("## Summary");
    expect(body).not.toContain("## Changed Files");
    expect(body).not.toContain("## Verification");
    expect(body).not.toContain("## Verification Details");
    expect(body).not.toContain("## Skipped Verification");
  });

  it("REGRESSION (#154): Mia template gets narrative under Description without verification detail", () => {
    const miaTemplate = [
      "## Description",
      "",
      "## Implementation",
      "",
      "## Testing",
      "",
      "### Local Tests",
      "",
      "### Unit Tests",
      "",
      "## Results",
      "",
    ].join("\n");
    const body = renderPrBodyFromReadiness(
      readinessInput({
        status: "found",
        candidate: { path: ".github/pull_request_template.md", source: "repo_local", content: miaTemplate },
      }),
    );

    const fallbackIndex = body.indexOf("## Cycloid Summary");
    const descIndex = body.indexOf("## Description");
    const narrativeIndex = body.indexOf("<!-- cycloid:managed:start narrative -->");
    const implIndex = body.indexOf("## Implementation");
    expect(narrativeIndex).toBeGreaterThan(-1);
    expect(fallbackIndex).toBe(0);
    expect(narrativeIndex).toBeLessThan(descIndex);
    expect(descIndex).toBeLessThan(implIndex);

    expect(body).toContain("<!-- cycloid:managed:start verification -->");
    expect(body).not.toContain("**Verdict:** INCONCLUSIVE");
  });

  it("renders an .cycloid.json-pointed template identically to an auto-discovered one", async () => {
    const template = [
      "## Summary",
      "",
      "{{CYCLOID_SUMMARY}}",
      "",
      "## Testing",
      "",
      "{{CYCLOID_VERIFICATION}}",
      "",
    ].join("\n");

    const cycloidRepo = tempRepo();
    writeRepoFile(cycloidRepo, ".cycloid.json", JSON.stringify({ pr: { templatePath: "docs/pr.md" } }));
    writeRepoFile(cycloidRepo, "docs/pr.md", template);

    const githubRepo = tempRepo();
    writeRepoFile(githubRepo, ".github/pull_request_template.md", template);

    const fromCycloid = await resolvePrTemplateChain([
      new CycloidJsonPrTemplateProvider(cycloidRepo),
      new RepoLocalPrTemplateProvider(cycloidRepo),
    ]);
    const fromGithub = await resolvePrTemplate(new RepoLocalPrTemplateProvider(githubRepo));
    expect(fromCycloid.status).toBe("found");
    expect(fromGithub.status).toBe("found");
    if (fromCycloid.status !== "found" || fromGithub.status !== "found") return;

    const content = compactContent();
    const renderedCycloid = renderPrBodyFromTemplate({ template: fromCycloid.candidate, content });
    const renderedGithub = renderPrBodyFromTemplate({ template: fromGithub.candidate, content });

    expect(renderedCycloid).toBe(renderedGithub);
    expect(renderedCycloid).toContain("<!-- cycloid:managed:start summary -->");
    expect(renderedCycloid).toContain("<!-- cycloid:managed:start verification -->");
  });
});

describe("assembleSectionFilledBody", () => {
  const deterministic = {
    verificationBlock: "Commands run:\n- `npm test` — passed.",
    visualEvidence: "- [shot](https://example.com/shot.png)",
    checkedCheckboxes: [] as string[],
  };

  it("places prose and fact refs under indexed headings and keeps customer headings intact", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Description", "", "## Testing", "", "## Screenshots", ""].join("\n"),
      fill: {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "Tightened the totals copy.",
            factRefs: null,
            emptyReason: null,
          },
          {
            index: 1,
            heading: "Testing",
            kind: "facts",
            text: null,
            factRefs: ["verification"],
            emptyReason: null,
          },
          {
            index: 2,
            heading: "Screenshots",
            kind: "facts",
            text: null,
            factRefs: ["visualEvidence"],
            emptyReason: null,
          },
        ],
      },
      deterministic,
    });
    expect(body.indexOf("Tightened the totals copy.")).toBeGreaterThan(body.indexOf("## Description"));
    expect(body).toContain("Commands run:");
    expect(body).toContain("https://example.com/shot.png");
  });

  it("materializes deterministic verification for a verification fact ref", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Testing", ""].join("\n"),
      fill: {
        sections: [
          { index: 0, heading: "Testing", kind: "facts", text: null, factRefs: ["verification"], emptyReason: null },
        ],
      },
      deterministic,
    });
    expect(body).toContain("Commands run:");
  });

  it("keeps later indexed fills on customer headings when prose contains markdown headings", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Description", "", "## Testing", ""].join("\n"),
      fill: {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "Summary.\n\n## Generated heading\nMore details.",
            factRefs: null,
            emptyReason: null,
          },
          { index: 1, heading: "Testing", kind: "facts", text: null, factRefs: ["verification"], emptyReason: null },
        ],
      },
      deterministic,
    });

    expect(body.indexOf("Commands run:")).toBeGreaterThan(body.indexOf("## Testing"));
    expect(body.indexOf("Commands run:")).toBeGreaterThan(body.indexOf("<!-- cycloid:managed:end narrative -->"));
  });

  it("keeps verdict words in descriptive prose", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Description", ""].join("\n"),
      fill: {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "This behavior was confirmed by the ticket author.",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
      deterministic,
    });

    expect(body).toContain("This behavior was confirmed by the ticket author.");
  });

  it("falls back when the LLM text states a verdict word (verdicts live in the QA Tester comment)", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Testing", ""].join("\n"),
      fill: {
        sections: [
          {
            index: 0,
            heading: "Testing",
            kind: "prose",
            text: "Verdict: INCONCLUSIVE — needs review.",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
      deterministic,
    });
    expect(body).toContain("Commands run:");
    expect(body).not.toContain("INCONCLUSIVE");
  });

  it("falls back even when the verdict word matches the session's own verdict", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Testing", ""].join("\n"),
      fill: {
        sections: [
          {
            index: 0,
            heading: "Testing",
            kind: "prose",
            text: "CONFIRMED — lint and tests passed cleanly.",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
      deterministic,
    });
    expect(body).toContain("Commands run:");
    expect(body).not.toContain("CONFIRMED — lint and tests passed cleanly.");
  });

  it("rejects verdict words in any casing", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Testing", ""].join("\n"),
      fill: {
        sections: [
          {
            index: 0,
            heading: "Testing",
            kind: "prose",
            text: "Confirmed: the redirect behavior works.",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
      deterministic,
    });
    expect(body).toContain("Commands run:");
    expect(body).not.toContain("Confirmed: the redirect behavior works.");
  });

  it("leaves a customer heading untouched when no fill section targets it", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Description", "Customer wrote this.", "", "## Checklist", "- [ ] done"].join("\n"),
      fill: {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "Agent narrative.",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
      deterministic,
    });
    expect(body).toContain("Customer wrote this.");
    expect(body).toContain("- [ ] done");
    expect(body).toContain("Agent narrative.");
  });

  it("renders nothing extra for an empty-kind heading", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Related Issue", "", "## Description", ""].join("\n"),
      fill: {
        sections: [
          {
            index: 0,
            heading: "Related Issue",
            kind: "empty",
            text: null,
            factRefs: null,
            emptyReason: "No related issue was supplied.",
          },
          {
            index: 1,
            heading: "Description",
            kind: "prose",
            text: "Did the thing.",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
      deterministic,
    });
    expect(body).toContain("## Related Issue");
    expect(body).toContain("Did the thing.");
  });

  it("fills duplicate heading text by stable index", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Testing", "", "## Testing", ""].join("\n"),
      fill: {
        sections: [
          { index: 0, heading: "Testing", kind: "prose", text: "First.", factRefs: null, emptyReason: null },
          { index: 1, heading: "Testing", kind: "prose", text: "Second.", factRefs: null, emptyReason: null },
        ],
      },
      deterministic,
    });
    expect(body.match(/<!-- cycloid:managed:start narrative -->/g)).toHaveLength(2);
    expect(body).toContain("First.");
    expect(body).toContain("Second.");
  });

  it("strips Cycloid managed-block markers the model echoes into its text (no nesting)", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Description", ""].join("\n"),
      fill: {
        sections: [
          {
            heading: "Description",
            index: 0,
            kind: "prose",
            text: "<!-- cycloid:managed:start narrative -->\nReal prose.\n<!-- cycloid:managed:end narrative -->",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
      deterministic,
    });
    expect(body).toContain("Real prose.");
    expect(body.match(/<!-- cycloid:managed:start narrative -->/g)).toHaveLength(1);
    expect(body.match(/<!-- cycloid:managed:end narrative -->/g)).toHaveLength(1);
  });

  it("strips absolute URLs from LLM-authored prose", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Description", ""].join("\n"),
      fill: {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "See [preview](https://example.com/secret) and https://example.com/raw.",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
      deterministic,
    });
    const narrative = body.slice(
      body.indexOf("<!-- cycloid:managed:start narrative -->"),
      body.indexOf("<!-- cycloid:managed:end narrative -->"),
    );
    expect(narrative).toContain("See preview and");
    expect(narrative).not.toContain("https://example.com");
  });

  it("emits at most one verification block even when several headings reference it", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Testing", "", "### Local Tests", "", "### Unit Tests", ""].join("\n"),
      fill: {
        sections: [
          {
            index: 1,
            heading: "Local Tests",
            kind: "facts",
            text: null,
            factRefs: ["verification"],
            emptyReason: null,
          },
          {
            index: 2,
            heading: "Unit Tests",
            kind: "facts",
            text: null,
            factRefs: ["verification"],
            emptyReason: null,
          },
        ],
      },
      deterministic,
    });
    expect(body.match(/<!-- cycloid:managed:start verification -->/g)).toHaveLength(1);
    expect(body.match(/<!-- cycloid:managed:end verification -->/g)).toHaveLength(1);
    expect(body).toContain("Commands run:");
  });

  it("appends deterministic verification + screenshots when the model maps no proof heading", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Description", ""].join("\n"),
      fill: {
        sections: [
          {
            index: 0,
            heading: "Description",
            kind: "prose",
            text: "Did the thing.",
            factRefs: null,
            emptyReason: null,
          },
        ],
      },
      deterministic,
    });
    // proof never disappears even when no testing/screenshot heading exists or was truncated
    expect(body).toContain("## Cycloid QA");
    expect(body).toContain("Commands run:");
    expect(body).toContain("## Screenshots");
    expect(body).toContain("https://example.com/shot.png");
  });
});

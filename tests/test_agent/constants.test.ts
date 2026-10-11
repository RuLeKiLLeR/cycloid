import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BLOCKED_CLI_PATTERNS,
  BLOCKED_GIT_PATTERNS,
  buildOnboardingAgentGuidance,
  buildPlanAgentGuidance,
  buildPrWorkflowGuidanceBullets,
  buildSandboxLayerGuidance,
  buildSessionStaticBehavioralGuidance,
  MAX_CONFIGURED_TEST_COMMANDS,
  PR_WORKFLOW_AUTOMATION_CLAUSE,
  PR_WORKFLOW_COMMIT_RULE,
} from "../../apps/sandbox-bridge/src/constants/bridge.js";
import { buildSystemContext } from "../../apps/sandbox-bridge/src/services/prompt-context-builder.js";
import {
  CODEX_PROJECT_DOC_MAX_BYTES,
  PROJECT_DOC_PRECEDENCE,
} from "../../apps/sandbox-bridge/src/utils/project-doc-setup.js";
import { OPENCODE_AGENT_RUNTIME_BACKEND } from "../../shared/agent/agent-runtime-backend.js";
import {
  BUILTIN_AGENTS,
  DEFAULT_AGENT_NAME,
  getValidAgentNames,
  isCodeReviewerAgentRole,
  isQaTesterAgentRole,
  isReadOnlyAgentRole,
  normalizePublicQaRequest,
  ONBOARD_AGENT_NAME,
  PLAN_AGENT_NAME,
  PR_REVIEW_MIN_CONFIDENCE,
  QA_TESTER_AGENT_PROFILE,
  QA_TESTER_AGENT_ROLE,
  QA_TESTER_RUNTIME_STARTUP_PROFILE,
  resolveAgentRuntimeMetadata,
  resolveEffectiveVerificationRuntimeMode,
  REVIEW_AGENT_DISPLAY_NAME,
  REVIEW_AGENT_ROLE,
  reviewVerificationExemptReason,
} from "../../shared/agent/constants.js";

describe("BUILTIN_AGENTS", () => {
  it("defines the expected agents", () => {
    expect(BUILTIN_AGENTS).toStrictEqual({
      build: {
        name: "build",
        description: "The default Cycloid coding agent.",
        mode: "primary",
      },
      verify: {
        name: "verify",
        description: "Cycloid QA Tester agent for checking existing pull requests.",
        mode: "primary",
      },
      onboard: {
        name: "onboard",
        description: "Cycloid agent that onboards a repository onto Cycloid.",
        mode: "internal",
      },
      plan: {
        name: "plan",
        description: "Internal read-only Cycloid planning pass.",
        mode: "internal",
      },
      review: {
        name: "review",
        description: `${REVIEW_AGENT_DISPLAY_NAME}.`,
        mode: "internal",
      },
    });
  });

  it("DEFAULT_AGENT_NAME is build", () => {
    expect(DEFAULT_AGENT_NAME).toBe("build");
    expect(BUILTIN_AGENTS[DEFAULT_AGENT_NAME]).toBeDefined();
    expect(PLAN_AGENT_NAME).toBe("plan");
  });
});

describe("buildPlanAgentGuidance", () => {
  it("requires a plan-only final answer", () => {
    const guidance = buildPlanAgentGuidance();

    expect(guidance).toContain("# Plan mode");
    expect(guidance).toContain("Produce a plan only");
    expect(guidance).toContain("starts with exactly:\n# Plan");
    expect(guidance).toContain("On a follow-up plan turn, re-emit the complete revised `# Plan` document");
    expect(guidance).toContain("Never return a conversational reply or delta");
    expect(guidance).toContain("Always include these core sections");
    expect(guidance).toContain("## Intent Restatement");
    expect(guidance).toContain("## Ordered Steps");
    expect(guidance).toContain("## Files To Touch");
    expect(guidance).toContain("Include these sections only when they carry real information");
    expect(guidance).toContain("## Verification Plan");
    expect(guidance).toContain("do not pad it with empty ceremony sections");
    expect(guidance).toContain("must still include ## Verification Plan and ## Risks");
    expect(guidance).toContain("### XS docs-only");
    expect(guidance).toContain("Add one troubleshooting note to README.md.");
    expect(guidance).toContain("### Code behavior");
    expect(guidance).toContain("Reject duplicate API token names per user.");
    expect(guidance).toContain("Never ask questions");
  });

  it("requires repo-relative file references and forbids sandbox-absolute paths and path links", () => {
    const guidance = buildPlanAgentGuidance();

    expect(guidance).toContain("repo-relative path in backticks");
    expect(guidance).toContain("/workspace/repo/...");
    expect(guidance).toContain("[name](/workspace/repo/...)");
  });

  it("keeps the worked examples free of sandbox-absolute paths and path links", () => {
    const guidance = buildPlanAgentGuidance();
    const examples = guidance.split("Examples:")[1];

    // Only the prose rule may reference the forbidden forms; the examples must model the good pattern.
    expect(examples).not.toContain("/workspace/repo");
    // No markdown link whose target is a file path (`](path)`); backtick-wrapped repo-relative paths only.
    expect(examples).not.toMatch(/\]\((?!https?:\/\/)[^)]*\)/);
  });

  it("keeps the XS worked example to the compact core sections", () => {
    const guidance = buildPlanAgentGuidance();
    const compactExample = guidance.split("### XS docs-only")[1].split("### Code behavior")[0];

    expect(compactExample).toContain("## Intent Restatement");
    expect(compactExample).toContain("## Ordered Steps");
    expect(compactExample).toContain("## Files To Touch");
    expect(compactExample).not.toContain("## Scope In/Out");
    expect(compactExample).not.toContain("## Approach");
    expect(compactExample).not.toContain("## Verification Plan");
    expect(compactExample).not.toContain("## Risks");
    expect(compactExample).not.toContain("## Breadth");
    expect(compactExample).not.toContain("## Open Assumptions");
  });

  it("layers compact plan guidance over session-static implementation guidance", () => {
    const planSystemContext = buildSystemContext({
      hasSentPromptInCurrentSession: false,
      identity: {
        gitAuthorName: undefined,
        ownerUserId: undefined,
        promptActorUserId: null,
      },
      perPromptSections: [
        {
          name: "plan_agent_profile",
          content: buildPlanAgentGuidance(),
          cadence: "always_on",
        },
      ],
      pendingDiagnostics: [],
    }).systemContext;
    const assembledPlanModeContext = [
      buildSessionStaticBehavioralGuidance({ agentRole: "implementation" }),
      planSystemContext.text,
    ].join("\n\n");
    const compactExample = assembledPlanModeContext.split("### XS docs-only")[1].split("### Code behavior")[0];

    expect(assembledPlanModeContext).toContain("# Implementation checks");
    expect(assembledPlanModeContext).toContain("# Plan mode");
    expect(planSystemContext.sections.map((section) => section.name)).toEqual(["plan_agent_profile"]);
    expect(compactExample).not.toContain("## Verification Plan");
    expect(compactExample).not.toContain("## Risks");
  });
});

describe("split behavioral guidance builders", () => {
  function sliceSection(guidance: string, heading: string): string {
    const parts = guidance.split(`# ${heading}`);
    if (parts.length < 2) return "";
    return parts[1].split(/\n# /)[0];
  }

  it("limits build initial guidance to Cycloid platform contracts", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).toContain("Sandbox environment");
    expect(guidance).toContain("Investigation and checks");
    expect(guidance).toContain("Task completion");
    expect(guidance).toContain("Git restrictions");

    const investigationSection = sliceSection(guidance, "Investigation and checks");
    expect(investigationSection).toContain("Diagnose with evidence, not speculation");
    expect(investigationSection).toContain("present a guess as a finding");
    expect(investigationSection).toContain("label it unverified");
    expect(guidance).not.toContain("Budget and planning");
    expect(guidance).not.toContain("Implementation discipline");
    expect(guidance).not.toContain("Data boundary verification");
    expect(guidance).not.toContain("External interactions");
  });

  it("keeps implementation guidance focused on changed behavior", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });

    expect(guidance).toContain("# Implementation checks");
    expect(guidance).toContain("Implement the requested change");
    expect(guidance).toContain("verify the changed behavior with the smallest applicable checks");
    expect(guidance).not.toContain("PR creation does not require screenshot or runtime evidence");
  });

  it("omits implementation and commit guidance for verification sessions", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "verification" });

    expect(guidance).toContain("# Sandbox environment");
    expect(guidance).toContain("# Investigation and checks");
    expect(guidance).toContain("# Verification boundaries");
    expect(guidance).toContain("cycloid sessions create");
    expect(guidance).toContain("cycloid.spawn_child_session");
    expect(guidance).not.toContain("# Task completion");
    expect(guidance).not.toContain("# Git restrictions");
    expect(guidance).not.toContain("# Implementation verification");
    expect(guidance).not.toContain("# Implementation checks");
    expect(guidance).not.toContain("Implement the requested change");
    expect(guidance).not.toContain("implement and commit it instead of only describing it");
    expect(guidance).not.toContain("start with the files and line numbers named");
    expect(guidance).not.toContain("context may no longer retain the exact detail");
    expect(guidance).not.toContain(PR_WORKFLOW_COMMIT_RULE);
  });

  it("keeps reviewer guidance read-only without injecting QA boundaries", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "review" });

    expect(guidance).toContain("# Sandbox environment");
    expect(guidance).toContain("# Investigation and checks");
    expect(guidance).not.toContain("# Verification boundaries");
    expect(guidance).not.toContain("# Task completion");
    expect(guidance).not.toContain("# Git restrictions");
    expect(guidance).not.toContain("# Implementation checks");
  });

  it("keeps session-static guidance byte-stable within each role", () => {
    const implementation = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const verification = buildSessionStaticBehavioralGuidance({ agentRole: "verification" });

    expect(buildSessionStaticBehavioralGuidance({ agentRole: "implementation" })).toBe(implementation);
    expect(buildSessionStaticBehavioralGuidance({ agentRole: "verification" })).toBe(verification);
    expect(verification).not.toBe(implementation);
  });

  it("does not include visual-evidence prompting in implementation guidance", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });

    expect(sliceSection(guidance, "Artifact collection")).toBe("");
    expect(sliceSection(guidance, "Visual verification for UI changes")).toBe("");
    expect(guidance).not.toContain("Prefer a static browser screenshot");
    expect(guidance).not.toContain("chromium --headless");
    expect(guidance).not.toContain("/tmp/cycloid-evidence/e2e-<timestamp>/");
    expect(guidance).not.toContain("Verification target:");
  });

  it("avoids duplicating post-execution gates and recovers changed-file failures", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const checksSection = sliceSection(guidance, "Implementation checks");

    expect(checksSection).toContain(
      "Cycloid post-execution freshly runs configured `.cycloid.json` `verify.test` gates",
    );
    expect(checksSection).toContain("Do not pre-run a configured gate solely to duplicate that work");
    expect(checksSection).toContain(
      "When you change an asserted value (a literal, constant, default, user-facing message/label, or wire/event/DB shape)",
    );
    expect(checksSection).toContain(
      "grep the test tree for the old value and run the affected suite before declaring done",
    );
    expect(checksSection).not.toContain("Inspect repo check config");
    expect(checksSection).toContain("lint, format-check, typecheck, migration/db, infra/config, or build");
    expect(checksSection).not.toContain("screenshot count");
    expect(checksSection).toContain("fix the cause within the changed files and rerun that exact check");
    expect(checksSection).toContain("`--frozen-lockfile`, `npm ci`, or `--locked`");
    expect(checksSection).toContain("Explicit user prohibitions are hard constraints");
    expect(checksSection).not.toContain(
      "If a command cannot be run because of missing credentials, missing dependencies, sandbox limits, or external service access, state the exact blocker and do not claim it passed.",
    );
  });

  it("derives self-chosen checks from the current prompt without per-turn git bookkeeping", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const checksSection = sliceSection(guidance, "Implementation checks");

    expect(checksSection).toContain("files changed in the current prompt");
    expect(checksSection).toContain("full-PR verification");
    expect(checksSection).not.toContain("record the current commit");
    expect(checksSection).not.toContain("git rev-parse HEAD");
  });

  it("keeps scoped checks stable without forcing one cwd or rerunning unaffected checks", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const checksSection = sliceSection(guidance, "Implementation checks");

    expect(checksSection).toContain("Resolve the working directory for each check once");
    expect(checksSection).toContain("do not alternate paths for the same check");
    expect(checksSection).toContain("A later edit invalidates only checks whose covered inputs changed");
  });

  it("preserves intentional lockfile-only work while reverting incidental lockfile mutations", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const checksSection = sliceSection(guidance, "Implementation checks");

    expect(checksSection).toContain("the explicit task targets lockfiles or dependency resolution");
    expect(checksSection).toContain("revert incidental lockfile changes");
  });

  it("defers pre-existing failure handling to repo policy and reports unresolved evidence separately", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const checksSection = sliceSection(guidance, "Implementation checks");

    expect(checksSection).toContain("follow explicit repo policy");
    expect(checksSection).toContain(
      "separately list unresolved or pre-existing failures with the failed command and base-confirmation evidence",
    );
    expect(checksSection).toContain("trailing `## Verification` heading");
    expect(checksSection).toContain("no commit was created instead of citing an unrelated SHA");
    expect(checksSection).not.toContain("list the final successful check commands only");
  });

  it("uses narrow CI-equivalent checks without mapping unrelated jobs", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const checksSection = sliceSection(guidance, "Implementation checks");

    expect(checksSection).toContain("narrowest package or workspace command");
    expect(checksSection).not.toContain("identify applicable pull-request jobs");
  });

  it("moves generalized fact precedence and performance coaching out of the build overlay", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).not.toContain("Verify facts or state what's unknown");
    expect(guidance).not.toContain("Fact precedence");
    expect(guidance).not.toContain("recent baseline");
    expect(guidance).not.toContain("Generic advice");
    expect(guidance).not.toContain("When uncertain, investigate or propose an experiment.");
    expect(guidance).not.toContain("85%");
    expect(guidance).not.toContain("Phrases like");
    expect(guidance).not.toContain("red flags");
  });

  it("keeps Cycloid-internal conventions out of customer-facing guidance", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const investigationSection = sliceSection(guidance, "Investigation and checks");

    // Cycloid HQ timezone preference; sessions run on customer repos worldwide.
    expect(investigationSection).not.toContain("Eastern and Pacific");
    expect(investigationSection).not.toContain("EST/EDT");
    // Ticket guidance must stay tracker-agnostic (no Cycloid Linear prefix).
    expect(investigationSection).not.toContain("ARC-");
    expect(investigationSection).not.toContain("Linear");
    expect(investigationSection).toContain("are not GitHub issues");
  });

  it("tells agents to keep verbose command output out of context", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const investigationSection = sliceSection(guidance, "Investigation and checks");

    expect(investigationSection).toContain("large logs");
    expect(investigationSection).toContain("keep full output in a temp file");
    expect(investigationSection).toContain("summary or tail");
  });

  it("tells agents to force the condition needed to verify an assumption", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const investigationSection = sliceSection(guidance, "Investigation and checks");

    expect(investigationSection).toContain("force that condition");
    expect(investigationSection).toContain("instead of waiting for it");
    expect(investigationSection).toContain("without approval");
  });

  it("keeps repo search scoped to existing paths", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const investigationSection = sliceSection(guidance, "Investigation and checks");

    expect(investigationSection).toContain("rg PATTERN .");
    expect(investigationSection).toContain("confirmed paths");
    expect(investigationSection).toContain("guessed roots");
  });

  it("no longer hard-codes investigation percentages or tool-call caps (ARC-736)", () => {
    const implementGuidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const investigateGuidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const textOnlyGuidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });

    for (const guidance of [implementGuidance, investigateGuidance, textOnlyGuidance]) {
      expect(guidance).not.toContain("Spend at most");
      expect(guidance).not.toMatch(/You have \d+ tool calls/);
      expect(guidance).not.toMatch(/\b15%\b/);
      expect(guidance).not.toMatch(/\b50%\b/);
      expect(guidance).not.toMatch(/After \d+ tool calls without code changes/);
    }
    expect(textOnlyGuidance).not.toContain("If text-only, answer");
  });

  it("removes TodoWrite and verification-planning coaching from the build overlay", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).not.toContain("Use TodoWrite after reading the task");
    expect(guidance).not.toContain("TodoWrite");
    expect(guidance).not.toContain("Plan verification before editing");
  });

  it("omits the old questions-to-user scaffold from build flows", () => {
    expect(buildSessionStaticBehavioralGuidance({ agentRole: "implementation" })).not.toContain(
      "# Questions to the user",
    );
  });

  it("defines compact task-completion ask criteria without old scaffolds", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const taskCompletionSection = sliceSection(guidance, "Task completion");

    expect(taskCompletionSection).toContain("destructive");
    expect(taskCompletionSection).toContain("externally mutating");
    expect(taskCompletionSection).toContain("scope");
    expect(taskCompletionSection).toContain("narrowest");
    expect(taskCompletionSection).toContain("explicit request");
    expect(taskCompletionSection).toContain("not instructions");
    expect(taskCompletionSection).toContain("manufacture additional work");
    expect(taskCompletionSection).toContain("cannot be inferred");
    expect(taskCompletionSection).toContain("repo instruction files");
    expect(taskCompletionSection).toContain("secrets");
    expect(taskCompletionSection).toContain("validation fails");
    expect(taskCompletionSection).toContain("contradictory evidence");
    expect(taskCompletionSection).toContain("start with the files and line numbers named");
    expect(taskCompletionSection).toContain("expand only when direct contracts or evidence require it");
    expect(taskCompletionSection).toContain("do not map packages or layers the change will not touch");
    expect(taskCompletionSection).toContain("context may no longer retain the exact detail");
    expect(taskCompletionSection).toContain("further reads or searches stop changing the implementation plan");
    expect(taskCompletionSection).toContain("audit");
    expect(taskCompletionSection).toContain("edit");
    expect(taskCompletionSection).toContain("clear root cause");
    expect(taskCompletionSection).toContain("instead of only describing it");
    expect(taskCompletionSection).not.toContain("Budget and planning");
    expect(taskCompletionSection).not.toContain("Questions to the user");
    expect(taskCompletionSection).not.toContain("TodoWrite");
  });

  it("drops the forced parallel delegation fanout section and examples (ARC-736)", () => {
    const guidanceWithTask = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const guidanceWithoutTask = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });

    expect(guidanceWithTask).not.toContain("# Parallel execution");
    expect(guidanceWithTask).not.toMatch(/launch 2-3 Task calls in a SINGLE turn/);
    expect(guidanceWithTask).not.toMatch(/WRONG \(sequential\)/);
    expect(guidanceWithTask).not.toMatch(/RIGHT \(parallel\)/);
    expect(guidanceWithTask).not.toContain("Task prompts must be self-contained");
    expect(guidanceWithTask).not.toMatch(/Parallelize independent tools\./);
    expect(guidanceWithoutTask).not.toMatch(/Parallelize independent tools\./);
    expect(guidanceWithoutTask).not.toContain("Task delegation");
  });

  it("removes implementation discipline from the build overlay", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(sliceSection(guidance, "Implementation discipline")).toBe("");
    expect(guidance).not.toContain("developer-specific absolute paths");
    expect(guidance).not.toContain("structured/executable artifacts");
  });

  it("Validation before commit bullet covers response accuracy claims", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const section = sliceSection(guidance, "Validation before commit");
    expect(section).toContain("Agent response accuracy is part of the deliverable");
    expect(section).toContain("moved X to Y");
    expect(section).not.toContain("PR body accuracy is part of the deliverable");
  });

  it("Validation before commit forbids bare success for empty-diff task endings", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const section = sliceSection(guidance, "Validation before commit");

    expect(section).toContain("If this prompt ends with no code diff and no successful guarded side effect");
    expect(section).toContain("do not report success");
    expect(section).toContain("scope that claim to this prompt");
    expect(section).not.toContain("title updated via tool");
  });

  it("places Validation before commit directly after Task completion", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const taskCompletionIndex = guidance.indexOf("# Task completion");
    const validationIndex = guidance.indexOf("# Validation before commit");
    const gitRestrictionsIndex = guidance.indexOf("# Git restrictions");

    expect(taskCompletionIndex).toBeGreaterThanOrEqual(0);
    expect(validationIndex).toBeGreaterThan(taskCompletionIndex);
    expect(gitRestrictionsIndex).toBeGreaterThan(validationIndex);
    expect(guidance.slice(taskCompletionIndex + "# Task completion".length, validationIndex)).not.toMatch(/\n# /);
  });

  it("includes Linked repo guidance without the automation clause", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).toContain("# Linked repo guidance");
    expect(guidance).toContain("Repo instruction files link the docs");
    const linkedSection = sliceSection(guidance, "Linked repo guidance");
    expect(linkedSection).not.toContain(PR_WORKFLOW_AUTOMATION_CLAUSE);
  });

  it("tells agents to consult repo-local agent profiles", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const profileSection = sliceSection(guidance, "Agent profiles");

    expect(profileSection).toContain("For each user prompt");
    expect(profileSection).toContain("Cycloid provides `.cycloid/agent-profiles/index.md` first");
    expect(profileSection).toContain("before choosing repo skills or a workflow");
    expect(profileSection).toContain("read that profile file and use it as the primary guidance");
    expect(profileSection).toContain("skills as tactical guidance");
    expect(profileSection).toContain("continue normally");
  });

  it("does not include the deleted SQL safety section", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).not.toContain("# SQL and database safety");
  });

  it("includes the code-minimalism ladder with the existing-repo-helper rung", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).toContain("# Code minimalism");
    const section = sliceSection(guidance, "Code minimalism");
    expect(section).toContain("stop at the first rung that holds");
    // Rung 2 must steer to existing repo abstractions before stdlib (conventions.md:16,31,34).
    expect(section).toContain("Does the repo already have a helper, pattern, registry, or parser");
    expect(section).toContain("Does the stdlib already do it?");
    // Shortcuts route through stated assumptions unless the fork is load-bearing and uninferable.
    expect(section).toContain("load-bearing and uninferable under the task-completion guidance");
  });

  it("keeps the guardrails so minimalism never weakens safety, repo conventions, or QA", () => {
    const section = sliceSection(
      buildSessionStaticBehavioralGuidance({ agentRole: "implementation" }),
      "Code minimalism",
    );
    expect(section).toContain("input validation at trust boundaries");
    expect(section).toContain("repo's existing layering/conventions");
    expect(section).not.toContain("routes -> services -> DAOs");
    // Must not lobotomize the QA Tester agent, which receives the same static guidance.
    expect(section).toContain("Does not reduce QA evidence");
    expect(section).toContain("INCONCLUSIVE escalation ladder");
  });

  it("defines the cycloid-shortcut marker without colliding with the bare cycloid: namespace", () => {
    const section = sliceSection(
      buildSessionStaticBehavioralGuidance({ agentRole: "implementation" }),
      "Code minimalism",
    );
    expect(section).toContain("`cycloid-shortcut:`");
    // Guard the bare `cycloid:` namespace in any comment form (`// cycloid:`, `<!-- cycloid: -->`)
    // and the `cycloid:scheduled` label. `cycloid-shortcut:` does not contain the `cycloid:` substring.
    expect(section).not.toContain("cycloid:");
  });

  it("keeps the always-on minimalism block within its token budget", () => {
    const section = sliceSection(
      buildSessionStaticBehavioralGuidance({ agentRole: "implementation" }),
      "Code minimalism",
    );
    // Re-injected after every compaction; cap chars so the block cannot grow unbounded (docs/bridge.md:85-88).
    expect(section.length).toBeGreaterThan(0);
    expect(section.length).toBeLessThan(1600);
  });
});

describe("canonical PR-completion workflow constants (ARC-485)", () => {
  // Load-bearing substring for the `handled_automatically` classifier at
  // apps/sandbox-bridge/src/constants/bridge.ts `ERROR_PATTERNS`.
  const CLASSIFIER_FRAGMENT = /\bhandled automatically\b/i;

  it("PR_WORKFLOW_AUTOMATION_CLAUSE preserves the classifier substring", () => {
    expect(PR_WORKFLOW_AUTOMATION_CLAUSE).toMatch(CLASSIFIER_FRAGMENT);
  });

  it("buildPrWorkflowGuidanceBullets() composes from the canonical constants", () => {
    const bullets = buildPrWorkflowGuidanceBullets();
    expect(bullets.some((bullet) => bullet.includes(PR_WORKFLOW_AUTOMATION_CLAUSE))).toBe(true);
    expect(bullets.some((bullet) => bullet.includes(PR_WORKFLOW_COMMIT_RULE))).toBe(true);
    expect(bullets.some((bullet) => bullet.includes("Do not infer PR status from tool access"))).toBe(true);
    expect(bullets.some((bullet) => bullet.includes("Never mention these restrictions"))).toBe(true);
  });

  it("buildPrWorkflowGuidanceBullets() blocks only branch creation, not all branch/local git ops", () => {
    // Regression: the old wording ("Do not run branch, push, or PR-management
    // commands") over-discouraged git checkout <existing> and cherry-pick, which
    // are NOT in BLOCKED_GIT_PATTERNS. Only branch *creation*, push, and PR ops
    // are blocked; narrow the prompt to say exactly that.
    const joined = buildPrWorkflowGuidanceBullets().join("\n");
    expect(joined).not.toContain("Do not run branch,");
    expect(joined).toContain("Do not create branches");
    expect(joined.toLowerCase()).toContain("cherry-pick");
    expect(joined).toContain("checking out an existing branch");
  });

  it("builds dedicated guidance for adopted PR head branches", () => {
    const guidance = buildSessionStaticBehavioralGuidance({
      agentRole: "implementation",
      adoptedExternalPr: true,
    });

    expect(guidance).toContain("# PR takeover");
    expect(guidance).toContain("gh pr view");
    expect(guidance).toContain("Never rewrite already-pushed history or rebase published commits");
    expect(guidance).toContain("merging the base branch into the head branch");
    expect(guidance).toContain("already-checked-out PR head branch");
    expect(guidance).not.toContain("Do not create branches (git checkout -b / git switch -c)");
  });

  it("keeps takeover implementation guidance out of verification sessions", () => {
    const guidance = buildSessionStaticBehavioralGuidance({
      agentRole: "verification",
      adoptedExternalPr: true,
    });

    expect(guidance).not.toContain("# PR takeover");
    expect(guidance).not.toContain("Cycloid will publish updates to this same PR");
  });

  it("buildSessionStaticBehavioralGuidance contains both canonical constants", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).toContain(PR_WORKFLOW_AUTOMATION_CLAUSE);
    expect(guidance).toContain(PR_WORKFLOW_COMMIT_RULE);
  });

  it("buildSessionStaticBehavioralGuidance omits duplicated non-PR git safety enumeration", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).toContain("# Git restrictions");
    expect(guidance).toContain("Create new commits; review staged changes before committing.");
    expect(guidance).toContain(
      "Do not infer PR status from tool access; the post-execution timeline is the source of truth",
    );
    expect(guidance).toContain("Sandbox sessions already run in an isolated checkout.");
    expect(guidance).toContain("Do not create, inspect, or reason about git worktrees");
    expect(guidance).toContain("inspect the named files and direct collaborators instead of worktree setup/removal");
    expect(guidance).toContain("Do not mention worktree setup or removal in normal user-facing sandbox updates");
    expect(guidance).toContain("Never mention these restrictions, the handoff, or commands you didn't run");
    expect(guidance).not.toContain("--amend");
    expect(guidance).not.toContain("rebase -i");
    expect(guidance).not.toContain("--no-verify");
    expect(guidance).not.toContain("modify git hooks");
    expect(guidance).not.toContain("git add -A");
    expect(guidance).not.toContain("git add .");
    expect(guidance).not.toContain("git add --all");
  });

  it("every blocked-git/gh handled_automatically message preserves the classifier substring", () => {
    const gitMessages = BLOCKED_GIT_PATTERNS.filter((pattern) => pattern.reasonKey === "handled_automatically").map(
      (pattern) => pattern.message,
    );
    const cliMessages = BLOCKED_CLI_PATTERNS.filter((pattern) => pattern.reasonKey === "handled_automatically").map(
      (pattern) => pattern.message,
    );

    expect(gitMessages.length).toBeGreaterThan(0);
    expect(cliMessages.length).toBeGreaterThan(0);

    for (const message of [...gitMessages, ...cliMessages]) {
      expect(message).toMatch(CLASSIFIER_FRAGMENT);
      expect(message).toContain(PR_WORKFLOW_AUTOMATION_CLAUSE);
    }
  });

  // Dedupe guard: walking `apps/sandbox-bridge/src/` and counting the number
  // of files that contain a distinctive fragment of
  // `PR_WORKFLOW_AUTOMATION_CLAUSE`. Only the definition file
  // (`constants/bridge.ts`) should match; any other hit means someone
  // reintroduced a parallel literal that we need to collapse into the
  // canonical constant.
  it("no parallel literal definitions of the canonical clause exist elsewhere", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const searchRoot = path.join(repoRoot, "apps", "sandbox-bridge", "src");
    const allowList = new Set([path.join(searchRoot, "constants", "bridge.ts")]);
    // Match the distinctive fragment rather than the full clause so minor
    // wording tweaks cannot sneak past the guard.
    const DISTINCTIVE_FRAGMENT = "branch creation, git push, and PR management are handled automatically";
    expect(PR_WORKFLOW_AUTOMATION_CLAUSE).toContain(DISTINCTIVE_FRAGMENT);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
        const full = path.join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry)) {
          if (allowList.has(full)) continue;
          const text = readFileSync(full, "utf8");
          if (text.includes(DISTINCTIVE_FRAGMENT)) {
            offenders.push(path.relative(repoRoot, full));
          }
        }
      }
    };
    walk(searchRoot);

    expect(offenders).toEqual([]);
  });
});

describe("root instruction parity", () => {
  it("keeps AGENTS.md and CLAUDE.md byte-identical as a single source of truth", () => {
    // Codex reads AGENTS.md, Claude Code reads CLAUDE.md; keeping them identical
    // is the only guard that stops the two from drifting rule-by-rule. Both must be
    // real files (not symlinks) because local agent loaders may skip symlinks.
    const agentsPath = path.resolve("AGENTS.md");
    const claudePath = path.resolve("CLAUDE.md");

    for (const p of [agentsPath, claudePath]) {
      const stat = lstatSync(p);
      expect(stat.isFile(), p).toBe(true);
      expect(stat.isSymbolicLink(), p).toBe(false);
    }

    expect(readFileSync(agentsPath, "utf-8")).toBe(readFileSync(claudePath, "utf-8"));
  });

  it("keeps repo docs reachable for rules trimmed from the build overlay", () => {
    const agents = readFileSync(path.resolve("AGENTS.md"), "utf-8");
    const claude = readFileSync(path.resolve("CLAUDE.md"), "utf-8");
    const conventions = readFileSync(path.resolve("docs/conventions.md"), "utf-8");
    const testing = readFileSync(path.resolve("docs/testing.md"), "utf-8");

    for (const rootInstructions of [agents, claude]) {
      expect(rootInstructions).toContain("docs/conventions.md");
      expect(rootInstructions).toContain("docs/testing.md");
      expect(rootInstructions).toContain("docs/security.md");
    }

    expect(conventions).toContain("Verify current external facts");
    expect(conventions).toContain("pricing, rate limits, API behavior, SDK signatures");
    expect(conventions).toContain("New or changed functions and endpoints need tests");
    expect(testing).toContain("Prove risky assumptions with the fastest local or disposable verifier");
  });

  it("keeps Cycloid-only publish guidance out of root instructions and in workflow docs", () => {
    const agents = readFileSync(path.resolve("AGENTS.md"), "utf-8");
    const claude = readFileSync(path.resolve("CLAUDE.md"), "utf-8");
    const workflow = readFileSync(path.resolve("docs/workflow.md"), "utf-8");
    const oldConflictingRule = "commit the scoped changes, push the branch, and open a PR marked ready for review";
    const cycloidPublishRule =
      "Cycloid handles branch creation and push after post-execution succeeds, and the control plane creates or updates the PR";
    const rootInstructionBoundaryRule =
      "not in root instruction files such as `AGENTS.md`, `CLAUDE.md`, or `agents.md`";

    for (const rootInstructions of [agents, claude]) {
      expect(rootInstructions).toContain("Keep root instruction files environment-agnostic");
      expect(rootInstructions).toContain(rootInstructionBoundaryRule);
      expect(rootInstructions).not.toContain(cycloidPublishRule);
      expect(rootInstructions).not.toContain("check out the published branch in their main checkout");
      expect(rootInstructions).not.toContain(oldConflictingRule);
    }

    expect(workflow).toContain("canonical place for Cycloid-owned publish and handoff workflow");
    expect(workflow).not.toContain("no manual action needed");
    expect(workflow).toContain(
      "The sandbox bridge handles branch creation and push after post-execution succeeds, and the control plane creates or updates the PR.",
    );
    expect(workflow).toContain("never explain bridge/control-plane ownership");
    expect(workflow).not.toContain(oldConflictingRule);
    expect(workflow).not.toContain("Do not wait for a separate user prompt to open the PR");
    expect(workflow).not.toContain("The bridge opens the PR once the change is ready");
  });
});

describe("repo-local agent profile catalog", () => {
  it("keeps every indexed profile link backed by a markdown file", () => {
    const expectedProfileFiles = [
      "build.md",
      "fix-ci.md",
      "review-pr.md",
      "verify-cycloid-app.md",
      "investigate-incident.md",
      "update-docs.md",
    ];
    const profileDir = path.resolve(__dirname, "..", "..", ".cycloid", "agent-profiles");
    const index = readFileSync(path.join(profileDir, "index.md"), "utf-8");
    const linkedFiles = [...index.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) => match[1]);

    expect(linkedFiles).toHaveLength(expectedProfileFiles.length);
    expect(linkedFiles).toEqual(expect.arrayContaining(expectedProfileFiles));

    for (const linkedFile of linkedFiles) {
      const profileText = readFileSync(path.join(profileDir, linkedFile), "utf-8");
      expect(profileText).toMatch(/^# .+/);
      expect(profileText).toContain("Use when");
    }
  });

  it("keeps the incident investigation prompt and call gates in the agent profile", () => {
    const profilePath = path.resolve(__dirname, "..", "..", ".cycloid", "agent-profiles", "investigate-incident.md");
    const profileText = readFileSync(profilePath, "utf-8");

    expect(profileText).toContain("Call gates:");
    expect(profileText).toContain("Explicit incident asks");
    expect(profileText).toContain("Operational context handoffs");
    expect(profileText).toContain("You are Cycloid Incident Analyzer V1");
    expect(profileText).toContain("Scrub every reasonable accessible source before concluding");
    expect(profileText).toContain("Work hypothesis-first");
    expect(profileText).toContain("Required Investigation Output");
    expect(profileText).toContain(
      "In Verdict, include `Context: session=<id|unknown> repo=<owner/name|unknown> username=<name|unknown> business=<name|unknown>` on its own line.",
    );
    expect(profileText).toContain(
      "Session: the UUID of the session that had this bug/error; username: the user who got this error (not the person requesting the investigation); repo: where this error surfaced; business: the customer or organization affected by the error.",
    );
  });
});

describe("buildOnboardingAgentGuidance", () => {
  const guidance = buildOnboardingAgentGuidance();

  it("teaches the real .cycloid.json contract field names", () => {
    // Field names must match the parsers (shared/types/sandbox.ts PreviewContract,
    // utils/pre-publish-tests.ts) — phase-0 showed agents hallucinate a schema otherwise.
    expect(guidance).toContain('"type":"compose","files":[...],"service"');
    expect(guidance).toContain('"hostPort"');
    expect(guidance).toContain("portMapping.containerPort");
    expect(guidance).toContain("additionalPorts");
    expect(guidance).toContain('"timeoutSeconds"');
    expect(guidance).toContain("ARCANIST_AUTH_STATE_PATH");
    expect(guidance).toContain("validatePath");
    expect(guidance).toContain("Do not invent other keys");
  });

  it("teaches the full top-level key set including pr.templatePath (ARC-1126)", () => {
    expect(guidance).toContain("`appRuntime`, `verify`, and optional `pr`");
    expect(guidance).toContain('"templatePath"');
  });

  it("teaches deriving .cycloid/pr-template.md from repo PR conventions when no template ships", () => {
    // The fill path is semantic, so the playbook must teach synthesis from
    // encoded conventions (cursor rules, AGENTS/CLAUDE, CONTRIBUTING),
    // customer-format headings, and an honest skip when neither exists.
    expect(guidance).toContain("author `.cycloid/pr-template.md` from those conventions");
    // Filename-first discovery across agent-instruction dirs — a repo-wide
    // content grep for common words drowned .cursor/commands/write-pr-description.md
    // in the mia-copy-2 PR #18 validation run.
    expect(guidance).toContain("rg --files .cursor .claude .github .agents docs");
    expect(guidance).toContain("do not lean on one repo-wide content grep");
    expect(guidance).toContain("`write-pr-description` command under `.cursor/commands/`");
    expect(guidance).toContain("mirror its headings and structure");
    // mia-copy-2 PR #28 used {{CYCLOID_SUMMARY}}/{{CYCLOID_EVIDENCE}} tokens
    // that collided in the deterministic renderer (one slot, two tokens; summary
    // token under a narrative-aliased heading) → nested/duplicated blocks and a
    // literal token. The fix is generation-side: author bare headings only and
    // let Cycloid fill them semantically — no tokens at all.
    expect(guidance).toContain("NO `{{...}}` placeholder tokens of any kind");
    expect(guidance).toContain("Author BARE HEADINGS only");
    expect(guidance).not.toContain("{{CYCLOID_SUMMARY}}");
    expect(guidance).toContain("fills arbitrary headings semantically");
    expect(guidance).toContain("`## Testing` or `## Screenshots`");
    expect(guidance).toContain("skip `pr` and say which places you checked");
    expect(guidance).toContain("takes priority over `.github/pull_request_template.md` discovery");
  });

  it("teaches the real >limit semantics: the gate fails instead of truncating", () => {
    // resolvePrePublishTestPlan fails the whole gate above the cap; teaching a
    // soft cap makes agents author self-blocking rule sets.
    expect(guidance).toContain(`If more than ${MAX_CONFIGURED_TEST_COMMANDS} distinct commands match`);
    expect(guidance).toContain("the command set FAILS without running any of them");
    expect(guidance).toContain("must not mutate tracked files");
  });

  it("seeds stale-assertion verification into future customer repos", () => {
    expect(guidance).toContain(
      "Before declaring done after changing a literal, constant, default, user-facing message/label, or wire/event/DB shape",
    );
    expect(guidance).toContain("grep the test tree for the old value and run the affected suite locally");
  });

  it("does not promise the publish gate validates product-scoped rules", () => {
    // The gate only runs rules whose paths match the onboarding PR's own files.
    expect(guidance).toContain("run EVERY authored `verify.test` command yourself");
    expect(guidance).toContain("rules scoped to product paths will NOT run here");
    expect(guidance).toContain("Include one rule scoped to `.cycloid/**`");
  });

  it("shows the nested verify JSON shape and forbids the dotted top-level key", () => {
    // QA session 9adfa1d7 wrote a literal "verify.test" top-level key, which
    // resolvePrePublishTestPlan silently reads as unconfigured.
    expect(guidance).toContain('{"verify":{"fix":');
    expect(guidance).toContain('"test":{"command":"<read-only backstop>"');
    expect(guidance).toContain('never dotted \`"verify.fix"\` or \`"verify.test"\` top-level keys');
  });

  it("requires boot proof and forbids credential declarations", () => {
    expect(guidance).toContain("set `ready.timeoutSeconds` from the measurement");
    expect(guidance).toContain("Do NOT declare `auth.credentials` or `e2e.credentials`");
    expect(guidance).toContain("cycloid test-creds set");
  });

  it("defines the completeness ladder with evidence-gated descent (phase 2)", () => {
    // PR #15 audit: the agent stopped at dashboard-only on assumed blockers.
    expect(guidance).toContain("R1: full stack boots; migrations and seed run in the boot chain");
    expect(guidance).toContain("R2: full stack boots with migrations; auth deferred");
    expect(guidance).toContain("record the exact command + error that forced a descent");
    expect(guidance).toContain('("slow" or "probably needs credentials" is not evidence)');
  });

  it("hard-gates descent below R2 on quoted boot evidence + a traced vault fallback (mia-copy-2 #34 audit)", () => {
    // #34 repeated the PR #15 failure: it settled at R3 on a Key Vault block
    // without tracing the env fallback. The gate forbids that descent without
    // a quoted `docker compose up` error and a fallback attempt, and requires
    // the true rung + exact blocker be surfaced in the report.
    expect(guidance).toContain("Descent gate — you may NOT publish a rung below R2");
    expect(guidance).toContain(
      "a vault or Key Vault error is a configuration step to work through, NOT a wall to descend on",
    );
    expect(guidance).toContain("named exactly — the specific service plus the env var or secret it needs");
    expect(guidance).toContain("state the true rung and the one exact blocker at the TOP of the QA/testing section");
    // The vault hygiene bullet now points back at the gate.
    expect(guidance).toContain("a vault error is never on its own a valid reason to settle below R2");
  });

  it("detects an IP-safe skeleton and authors a completable real-runtime handoff config (openevidence-skeleton audit)", () => {
    // The skeleton onboarding PR is handed to the customer to fill in against their
    // real code, so the deliverable is a completable REAL runtime config + a fill-in
    // checklist — NOT a green static diagnostic stack (which the customer would just
    // delete). The product cannot boot on the skeleton (stubbed bodies); that R4 is
    // expected, and the agent must not waste the session forcing a doomed build.
    expect(guidance).toContain("## First: is this a runnable checkout?");
    expect(guidance).toContain("make-skeleton metadata (`MANIFEST.txt`, `repo-stats.json`, `env-keys.txt`)");
    expect(guidance).toContain("begin with `// Stubbed by make-skeleton`");
    // make-skeleton keeps standard lockfiles verbatim — a present lockfile is NOT
    // a "not a skeleton" signal; detection rides on metadata files + the stub marker.
    expect(guidance).toContain("a PRESENT lockfile does not rule out a skeleton");
    // R4 is expected for the skeleton and not a shortfall; detection is the descent evidence.
    expect(guidance).toContain("R4 (statically validated only) is the honest rung");
    expect(guidance).toContain("the skeleton's whole job is to produce a config the customer completes");
    expect(guidance).toContain("skeleton detection above is the descent evidence");
    expect(guidance).toContain("Do NOT spend the session building the product image or running the stubbed source");
    // Deliverable = a completable REAL runtime config reconstructed from preserved infra.
    expect(guidance).toContain("author the REAL runtime config the customer will fill in");
    expect(guidance).toContain("Reconstruct a real `appRuntime` from the skeleton's PRESERVED infra");
    expect(guidance).toContain("Do NOT substitute a static server or stand-in image");
    // A fill-in checklist tells the customer exactly what to supply.
    expect(guidance).toContain("Enumerate the FILL-IN CHECKLIST");
    expect(guidance).toContain("in the PR body itself");
    expect(guidance).toContain("may not rely on CYCLOID.md for missing action items");
    expect(guidance).toContain(
      "any build input make-skeleton dropped (non-allowlisted lockfiles like `uv.lock`/`bun.lock`, vendored dirs)",
    );
    expect(guidance).toContain("Read `MANIFEST.txt` and enumerate EVERY preserved or dropped build/verify lockfile");
    expect(guidance).toContain("if the manifest mentions a lockfile or generated build input");
    // Normal app secrets go in the repo .env store (merged into composeEnv), not test-creds —
    // test-creds only feeds declared auth/e2e credentials, which a follow-up turn adds.
    expect(guidance).toContain("added as repo `.env` under Settings → Repositories");
    expect(guidance).toContain(
      "reserving `cycloid test-creds set` for any `auth`/`e2e` credentials a follow-up turn declares",
    );
    // Honesty: config is inferred, not proven; verification happens on the real repo.
    expect(guidance).toContain("the config is INFERRED, not proven");
    expect(guidance).toContain("Never present the skeleton run as a green or product boot");
    expect(guidance).toContain("Scaffold the seed path and auth path separately even when auth is deferred");
    expect(guidance).toContain("Reserve `auth.command` for real login/auth-state creation only");
    expect(guidance).toContain(
      "seed/dev-user/bootstrap hooks that do NOT authenticate belong in the boot chain, `e2e` path",
    );
    expect(guidance).toContain("QUOTE the exact search that justified stopping short of a proven login");
    expect(guidance).toContain("Document migration routing explicitly");
    expect(guidance).toContain("entrypoint, prestart script, dedicated job, one-shot service");
    expect(guidance).toContain("default `ready.timeoutSeconds` to a conservative `900` seconds");
    // The descent gate admits a non-runnable checkout as a valid reason, landing at R4 (not R3),
    // and only when confirmed by detection — not a recoverable missing build input.
    expect(guidance).toContain("a non-runnable checkout confirmed by the skeleton detection above");
    expect(guidance).toContain("which lands at R4 — the product cannot boot at all, so R3 does not apply");
    expect(guidance).toContain("non-runnable only once you confirm you cannot regenerate or source-mount past it");
    // Boot-chain hygiene: only lockfiles NOT in make-skeleton's allowlist drop — incl. bun.lock (text) and bun.lockb.
    expect(guidance).toContain("Before any `--build`, confirm the inputs the Dockerfile COPYs");
    expect(guidance).toContain("`uv.lock`, `bun.lock`/`bun.lockb`");
  });

  it("rejects DB-free 200s as boot proof (PR #15 audit blocker)", () => {
    // PR #15's evidence was a sign-in page and a shim "OK" route over a
    // schema-less database.
    expect(guidance).toContain("A 200 from a sign-in page or health route is NOT boot proof");
    expect(guidance).toContain("DB-backed endpoint or a logged-in page after migrations ran");
    expect(guidance).toContain("Never present a lower rung as more proven than it is");
  });

  it("teaches dockerd recovery before ladder descent", () => {
    // Docker availability rides on the template-snapshot daemon; a stopped
    // daemon must be restarted, not used as descent evidence.
    expect(guidance).toContain("sudo /app/scripts/start-dockerd.sh");
    expect(guidance).toContain("a stopped daemon is recoverable, not evidence");
  });

  it("forbids confabulated repo claims (PR #15 audit: false no-seed-user claim)", () => {
    expect(guidance).toContain("QUOTE the searches in your report");
    expect(guidance).toContain("Never assert the repo lacks something without showing the search that failed");
  });

  it("teaches boot-chain hygiene from confirmed PR #15 gaps", () => {
    expect(guidance).toContain("Wire migrations + seed into the boot chain itself");
    expect(guidance).toContain("set placeholder env for every secret the boot and login paths read");
    expect(guidance).toContain("long-form `depends_on` with `condition: service_healthy`");
    expect(guidance).toContain("dev-mode, source-mounted web service");
    expect(guidance).toContain("do not collide with the repo's own dev-tooling defaults");
    expect(guidance).toContain(
      'Do NOT "fix" a failing skeleton build by swapping the real Docker/compose build context',
    );
    expect(guidance).toContain("treat that as a build blocker");
    expect(guidance).toContain("a client left retry-looping forever is not a stub");
  });

  it("steers env-contract discovery to readable templates, not protected env files (mia-copy-2 #36 audit)", () => {
    // #36 bundled core/.env.example (allowed) with dashboard/.env.local (blocked
    // by the protected-path policy) in one `&&` command, so the whole read died.
    expect(guidance).toContain("Discover the env contract from the repo's COMMITTED templates");
    expect(guidance).toContain("blocked by the sandbox protected-path policy");
    expect(guidance).toContain("never bundle one into a compound command");
    expect(guidance).toContain("Read the templates on their own");
  });

  it("guides follow-up turns to deepen on the same branch", () => {
    expect(guidance).toContain("deepen the runtime to the requested rung");
    expect(guidance).toContain("a follow-up turn may add `auth.credentials` declarations");
    // Injection-accurate: declared credential env only materializes at spawn.
    expect(guidance).toContain("the values materialize for the NEXT session");
  });

  it("requires scope-honest verification claims in the report", () => {
    expect(guidance).toContain("SCOPE (say what it actually exercises");
    expect(guidance).toContain("every stubbed or no-oped integration by name");
    expect(guidance).toContain("migration routing (where migrations run, or what is still missing)");
    expect(guidance).toContain(
      'ordered FILL-IN CHECKLIST / "Before merge" checklist for the customer in the PR body itself',
    );
    expect(guidance).toContain("every missing build/verify input from `MANIFEST.txt`");
  });

  it("derives the CYCLOID.md precedence and size ceiling from the shared constants", () => {
    expect(guidance).toContain(PROJECT_DOC_PRECEDENCE.join(" > "));
    expect(guidance).toContain(`hard ceiling ${Math.floor(CODEX_PROJECT_DOC_MAX_BYTES / 1024)} KiB`);
    expect(guidance).toContain("frontmatter or title");
  });

  it("publishes the simulation report through the final response, not a fenced dump", () => {
    // QA session 9adfa1d7 wrapped "the PR body" in a fenced block inside its
    // final message, which rendered as a nested dump in the managed Summary.
    expect(guidance).toContain("Your final response is published as the PR's Summary section");
    expect(guidance).toContain('never a fenced code block labeled as "the PR body"');
  });

  it("never instructs the agent to publish (PR workflow is handled automatically)", () => {
    // QA session ac232ab6: "publish the setup PR" contradicted the always-on
    // Git-restrictions clause and the agent narrated the conflict into the PR body.
    expect(guidance).not.toContain("and publish the setup PR");
    expect(guidance).toContain("published automatically as a setup PR");
    expect(guidance).toContain("do not run branch, push, or PR commands");
  });

  it("splices the custom sandbox-layer section and conditional deliverable (ARC-1286)", () => {
    expect(guidance).toContain("## Custom sandbox layer (when the repo needs a toolchain the base sandbox lacks)");
    expect(guidance).toContain(
      "`.cycloid/sandbox.yaml` + `.cycloid/sandbox.layer.Dockerfile` — ONLY when the repo needs a toolchain the base sandbox lacks (see Custom sandbox layer below); otherwise omit.",
    );
    expect(guidance).toContain("cycloid sandbox build <owner/repo> --ref <default-branch> --wait --follow");
  });

  it("tells a skeleton onboarding to author the sandbox layer from preserved infra (oe-skeleton-new gap)", () => {
    expect(guidance).toContain("Author the sandbox layer too if the repo's toolchain surface exceeds the base");
  });

  it("stays out of the session-static behavioral guidance (profile-gated only)", () => {
    expect(buildSessionStaticBehavioralGuidance({ agentRole: "implementation" })).not.toContain("# Onboarding session");
  });
});

describe("buildSandboxLayerGuidance (ARC-1286)", () => {
  const guidance = buildSandboxLayerGuidance();

  it("scopes detection to the whole repo and records the no-op case", () => {
    expect(guidance).toContain("## Custom sandbox layer (when the repo needs a toolchain the base sandbox lacks)");
    expect(guidance).toContain("scope it to the WHOLE repo, not just the one service you boot");
    expect(guidance).toContain("Go, Swift, Rust, Java, .NET, Ruby");
    // ARC-1286: the layer trigger must not read as "language runtimes only" — a
    // CI-only IaC/cloud/codegen CLI the base lacks is just as much a layer entry.
    expect(guidance).toContain("not just language runtimes");
    expect(guidance).toContain("command not found");
    expect(guidance).toContain("command -v <tool>");
    expect(guidance).toContain('author NO sandbox-layer files and record "base template sufficient"');
  });

  it("enumerates the toolchain surface across the whole tree, including skeletons that cannot boot", () => {
    expect(guidance).toContain("Scan EVERY directory for toolchain manifests");
    expect(guidance).toContain("build.gradle");
    // ARC-1286: CI workflows are a first-class detector (CI runs on the host),
    // so a tool whose only surviving signal is a CI step still counts on a
    // stripped/skeleton checkout that deletes the source manifests.
    expect(guidance).toContain("first-class detector, not a trailing hint");
    expect(guidance).toContain("whose only surviving signal is a CI step");
    expect(guidance).toContain("A tool a service's OWN Dockerfile installs inside its image does NOT");
    expect(guidance).toContain("add it only if sessions also run it directly on the host");
    expect(guidance).toContain(
      "On a non-runnable skeleton you do NOT boot, so the manifest/Dockerfile/CI enumeration IS the detection",
    );
  });

  it("teaches the init -> edit -> validate flow with the RUN/ENV-only constraint", () => {
    expect(guidance).toContain("cycloid sandbox init");
    expect(guidance).toContain("`RUN`/`ENV` instructions ONLY");
    expect(guidance).toContain("every other instruction (`FROM`, `COPY`, `ADD`, `ARG`");
    expect(guidance).toContain('["bash","-lc","command -v go"]');
    expect(guidance).toContain("cycloid sandbox validate");
  });

  it("frames live apply as best-effort user-space install given the non-root sandbox", () => {
    expect(guidance).toContain("you run as a non-root user with no general `sudo`");
    expect(guidance).toContain("static `validate` is then the honest in-session ceiling");
    expect(guidance).toContain("never call the layer broken because a root install could not run live");
  });

  it("hands the admin post-merge build off in the report and never builds in-session", () => {
    expect(guidance).toContain("`cycloid sandbox build` needs admin auth");
    expect(guidance).toContain("cycloid sandbox build <owner/repo> --ref <default-branch> --wait --follow");
    expect(guidance).toContain("git symbolic-ref --short refs/remotes/origin/HEAD");
    expect(guidance).toContain("Do NOT assume `main` or `master`");
    expect(guidance).toContain("an unbuilt layer falls back safely");
  });
});

describe("resolveAgentRuntimeMetadata", () => {
  it("defaults to the build implementation profile", () => {
    expect(resolveAgentRuntimeMetadata()).toStrictEqual({
      agentRole: "implementation",
      agentProfile: "build",
      harnessKind: "codex-session",
      runtimeStartupProfile: "implementation_default",
      verificationRuntimeMode: "none",
      targetPrUrl: null,
    });
  });

  it("maps qa to the current verification profile", () => {
    expect(resolveAgentRuntimeMetadata({ qa: true, targetPrUrl: "https://github.com/o/r/pull/1" })).toStrictEqual({
      agentRole: "verification",
      agentProfile: "verify",
      harnessKind: "codex-session",
      runtimeStartupProfile: "verification_ready_runtime",
      verificationRuntimeMode: "none",
      targetPrUrl: "https://github.com/o/r/pull/1",
    });
  });

  it("maps onboarding to the onboard implementation profile", () => {
    expect(resolveAgentRuntimeMetadata({ onboarding: true })).toStrictEqual({
      agentRole: "implementation",
      agentProfile: ONBOARD_AGENT_NAME,
      harnessKind: "codex-session",
      runtimeStartupProfile: "implementation_default",
      verificationRuntimeMode: "none",
      targetPrUrl: null,
    });
  });
});

describe("PR_REVIEW_MIN_CONFIDENCE", () => {
  it("keeps the native reviewer gate at the agreed starting threshold", () => {
    expect(PR_REVIEW_MIN_CONFIDENCE).toBe(3);
  });
});

describe("resolveEffectiveVerificationRuntimeMode", () => {
  it("does not escalate internal review sessions to the QA app runtime", () => {
    expect(
      resolveEffectiveVerificationRuntimeMode({
        agentRole: "verification",
        agentProfile: "review",
        declaredMode: "none",
        hasAppRuntimeContract: true,
      }),
    ).toBe("none");
  });

  it("escalates QA sessions with an app runtime contract to the bridge-owned boot", () => {
    expect(
      resolveEffectiveVerificationRuntimeMode({
        agentRole: "verification",
        declaredMode: "none",
        hasAppRuntimeContract: true,
      }),
    ).toBe("app_runtime");
  });

  it("treats an absent declared mode as none and still escalates QA", () => {
    expect(
      resolveEffectiveVerificationRuntimeMode({
        agentRole: "verification",
        declaredMode: undefined,
        hasAppRuntimeContract: true,
      }),
    ).toBe("app_runtime");
  });

  it("keeps QA sessions without a runtime contract on none", () => {
    expect(
      resolveEffectiveVerificationRuntimeMode({
        agentRole: "verification",
        declaredMode: "none",
        hasAppRuntimeContract: false,
      }),
    ).toBe("none");
  });

  it("never escalates implementation sessions", () => {
    expect(
      resolveEffectiveVerificationRuntimeMode({
        agentRole: "implementation",
        declaredMode: "none",
        hasAppRuntimeContract: true,
      }),
    ).toBe("none");
  });

  it("preserves an explicit non-none declaration verbatim", () => {
    expect(
      resolveEffectiveVerificationRuntimeMode({
        agentRole: "implementation",
        declaredMode: "app_runtime",
        hasAppRuntimeContract: false,
      }),
    ).toBe("app_runtime");
  });
});

describe("reviewVerificationExemptReason", () => {
  it("returns the exempt reason for verification sessions", () => {
    expect(reviewVerificationExemptReason({ agentRole: "verification" })).toBe("verification_session");
  });

  it("returns the distinct exempt reason for reviewer sessions", () => {
    expect(reviewVerificationExemptReason({ agentRole: "review" })).toBe("review_session");
    expect(reviewVerificationExemptReason({ agentProfile: "review" })).toBe("review_session");
    expect(reviewVerificationExemptReason({ agentRole: "verification", agentProfile: "review" })).toBe(
      "review_session",
    );
  });

  it("returns the exempt reason for onboarding sessions", () => {
    expect(reviewVerificationExemptReason({ agentProfile: ONBOARD_AGENT_NAME })).toBe("onboarding_session");
  });

  it("does NOT exempt opencode sessions (Phase 8/9: opencode runs verification + review like prod backends)", () => {
    expect(reviewVerificationExemptReason({ agentRuntimeBackend: OPENCODE_AGENT_RUNTIME_BACKEND })).toBeNull();
  });

  it("returns null for participating session types", () => {
    expect(
      reviewVerificationExemptReason({
        agentRole: "implementation",
        agentProfile: DEFAULT_AGENT_NAME,
        agentRuntimeBackend: "codex",
      }),
    ).toBeNull();
    expect(reviewVerificationExemptReason({})).toBeNull();
    expect(
      reviewVerificationExemptReason({
        agentRole: null,
        agentProfile: null,
        agentRuntimeBackend: null,
      }),
    ).toBeNull();
  });

  it("uses deterministic first-match precedence for overlapping metadata", () => {
    // The role/profile exemptions still win regardless of backend; opencode
    // itself is no longer an exemption source.
    expect(
      reviewVerificationExemptReason({
        agentRole: "verification",
        agentRuntimeBackend: OPENCODE_AGENT_RUNTIME_BACKEND,
      }),
    ).toBe("verification_session");
    expect(
      reviewVerificationExemptReason({
        agentProfile: ONBOARD_AGENT_NAME,
        agentRuntimeBackend: OPENCODE_AGENT_RUNTIME_BACKEND,
      }),
    ).toBe("onboarding_session");
  });
});

describe("QA Tester runtime compatibility helpers", () => {
  it("map QA Tester source semantics to the current persisted runtime values", () => {
    expect(QA_TESTER_AGENT_ROLE).toBe("verification");
    expect(QA_TESTER_AGENT_PROFILE).toBe("verify");
    expect(QA_TESTER_RUNTIME_STARTUP_PROFILE).toBe("verification_ready_runtime");
    expect(isQaTesterAgentRole("verification")).toBe(true);
    expect(isQaTesterAgentRole("implementation")).toBe(false);
  });

  it("keeps reviewer identity separate from QA while classifying both as read-only", () => {
    expect(REVIEW_AGENT_ROLE).toBe("review");
    expect(isCodeReviewerAgentRole("review")).toBe(true);
    expect(isCodeReviewerAgentRole("verification")).toBe(false);
    expect(isQaTesterAgentRole("review")).toBe(false);
    expect(isReadOnlyAgentRole("verification")).toBe(true);
    expect(isReadOnlyAgentRole("review")).toBe(true);
    expect(isReadOnlyAgentRole("implementation")).toBe(false);
  });
});

describe("normalizePublicQaRequest", () => {
  it("normalizes only the canonical qa flag", () => {
    expect(normalizePublicQaRequest({ qa: true })).toStrictEqual({ ok: true, qaRequested: true });
    expect(normalizePublicQaRequest({ qa: false })).toStrictEqual({ ok: true, qaRequested: false });
  });

  it("rejects non-boolean qa and the removed verify alias", () => {
    expect(normalizePublicQaRequest({ qa: "true" })).toStrictEqual({
      ok: false,
      error: "qa must be a boolean, got: true",
    });
    expect(normalizePublicQaRequest({ verify: true })).toStrictEqual({
      ok: false,
      error: "verify is no longer supported; use qa instead",
    });
  });
});

describe("getValidAgentNames", () => {
  it("excludes internal agents from built-in set", () => {
    const names = getValidAgentNames();
    expect(names.has("build")).toBe(true);
    expect(names.has("plan")).toBe(false);
    expect(names.has("title")).toBe(false);
    // onboard is create-flag-only: selecting it per prompt would inject the
    // onboarding playbook on non-onboarding sessions.
    expect(names.has("onboard")).toBe(false);
  });

  it("excludes internal agents from custom set", () => {
    const custom = {
      ...BUILTIN_AGENTS,
      myagent: { name: "myagent", description: "custom", mode: "primary" as const },
    };
    const names = getValidAgentNames(custom);
    expect(names.has("myagent")).toBe(true);
    expect(names.has("title")).toBe(false);
  });

  it("returns empty set when all agents are internal", () => {
    const allInternal = {
      a: { name: "a", description: "a", mode: "internal" as const },
    };
    const names = getValidAgentNames(allInternal);
    expect(names.size).toBe(0);
  });
});

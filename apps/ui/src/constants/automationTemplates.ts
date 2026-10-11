import type { SchedulePreset } from "./scheduleCron";

// Narrow to the presets a template may use so anything else is unrepresentable
// (illegal states unrepresentable; "preset is weekly-* or daily" becomes a type
// guarantee rather than a runtime check). `daily` exists for the nightly
// template; everything else runs weekly.
type ScheduledTemplatePreset = Extract<SchedulePreset, `weekly-${number}` | "daily">;

// Display order for grouping and the category filter.
export const AUTOMATION_TEMPLATE_CATEGORIES = ["Maintenance", "Security", "CI"] as const;
export type AutomationTemplateCategory = (typeof AUTOMATION_TEMPLATE_CATEGORIES)[number];

// Connectors a template touches, rendered as grayscale chips on the card.
export const AUTOMATION_TEMPLATE_CONNECTORS = ["GitHub"] as const;
export type AutomationTemplateConnector = (typeof AUTOMATION_TEMPLATE_CONNECTORS)[number];

/** Sentinel for the gallery's "all categories" filter choice. */
export const AUTOMATION_TEMPLATE_FILTER_ALL = "all";

type AutomationTemplateBase = {
  id: string;
  title: string; // card heading
  outcome: string; // one line on the card: what a run produces (the "then")
  category: AutomationTemplateCategory;
  connectors: readonly AutomationTemplateConnector[];
};

// The enabled shape: a scheduled rule the builder can create today. The
// schedule fields are the trigger — the gallery derives its "when" label from
// them via buildCronFromPreset + humanizeCron, keeping the display in lockstep
// with what the builder actually prefills. Do not add a schedule label field.
export type ScheduledAutomationTemplate = AutomationTemplateBase & {
  trigger: { kind: "schedule" };
  name: string; // pre-fills the rule name. Keep <= 80 (AUTOMATION_RULE_NAME_MAX_LENGTH)
  preset: ScheduledTemplatePreset;
  hour: number; // UTC. MUST be a value in HOUR_OPTIONS (0-23)
  minute: 0 | 15 | 30 | 45; // MUST be a value in MINUTE_OPTIONS
  prompt: string; // pre-fills the prompt. Keep <= 8000 (AUTOMATION_RULE_PROMPT_MAX_LENGTH)
};

export type AutomationTemplate = ScheduledAutomationTemplate;

// Templates are framed as trigger → outcome. The only trigger the platform
// supports today is a cron schedule (scheduled_rules), so every template below
// is scheduled.
//
// A scheduled run's only output is a PR (or a clean no-op when there is no
// diff) and it cannot pause for input, so every template is a self-contained,
// non-interactive task and `outcome` states that PR-or-no-op result plainly.
// Every prompt spells out its no-op arm ("make no changes and do not open a
// PR") so the agent never manufactures a diff to have something to show.
// Limits mirror AUTOMATION_RULE_NAME_MAX_LENGTH (80) /
// AUTOMATION_RULE_PROMPT_MAX_LENGTH (8000) in
// apps/control-plane-worker/src/constants/automation.ts (server source of
// truth, not importable across apps); the unit test pins those literals so
// drift is visible. Weekly runs are spread across days at low-traffic UTC
// hours (originals Mon–Fri 09:00, additions Mon–Sat 10:00) so they do not
// cluster; the nightly template runs daily at 03:00 UTC.
export const SCHEDULED_AUTOMATION_TEMPLATES: ScheduledAutomationTemplate[] = [
  {
    id: "dependency-bumps",
    title: "Dependency bumps",
    outcome: "Opens one PR with safe patch and minor bumps; no PR when everything is current.",
    category: "Maintenance",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Weekly dependency bumps",
    preset: "weekly-1",
    hour: 9,
    minute: 0,
    prompt:
      "Update this repository's dependencies to safe newer versions. Apply only non-breaking patch and minor updates; skip any major version bump and skip anything whose changelog notes a breaking change. After updating, install dependencies and run the build and the test suite to confirm everything still passes. If a specific update breaks the build or tests, revert just that update and continue with the rest. Open a single pull request describing which packages were bumped and from which versions to which. If every dependency is already current or no safe update can be applied cleanly, make no changes and do not open a PR.",
  },
  {
    id: "flake-sweep",
    title: "Flake sweep",
    outcome: "Opens a PR fixing root-caused test failures; no PR when the suite is green.",
    category: "CI",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Weekly flake sweep",
    preset: "weekly-2",
    hour: 9,
    minute: 0,
    prompt:
      "Run this repository's test suite and look for failing or flaky tests. For each failure, root-cause it and implement the smallest safe fix in the code or the test setup, then re-run to confirm it passes reliably. Never weaken, skip, or delete a test to make it pass, and never mark a test as ignored to hide a real failure. Open a pull request explaining each fix and the root cause. If the suite is fully green and stable, make no changes and do not open a PR.",
  },
  {
    id: "lint-format-cleanup",
    title: "Lint & format cleanup",
    outcome: "Opens a PR with mechanical lint, format, and type fixes; no PR when the code is clean.",
    category: "Maintenance",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Weekly lint & format cleanup",
    preset: "weekly-3",
    hour: 9,
    minute: 0,
    prompt:
      "Run this repository's linter, formatter, and type checker. Fix only mechanical violations that do not change runtime behavior: formatting, import ordering, unused imports, and trivial lint or type-annotation fixes. Do not refactor logic, rename public APIs, or change behavior. After fixing, run the build and test suite to confirm nothing changed behaviorally. Open a single pull request summarizing the categories of fixes applied. If the code is already clean, make no changes and do not open a PR.",
  },
  {
    id: "dead-code-trim",
    title: "Dead-code trim",
    outcome:
      "Opens a PR removing provably unused code, with evidence per removal; no PR when nothing is safe to remove.",
    category: "Maintenance",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Weekly dead-code trim",
    preset: "weekly-4",
    hour: 9,
    minute: 0,
    prompt:
      "Find and remove provably unused code in this repository: unreferenced exports, functions, files, and variables. Exclude anything that is part of a public API or package entry point, anything referenced only by tests (keep both the code and its tests), and anything reachable via dynamic imports, reflection, or framework conventions. Leave anything you are uncertain about in place. After removing, run the build and test suite to confirm nothing broke. Open a pull request that lists each removal with the evidence that it was unused. If nothing can be safely removed, make no changes and do not open a PR.",
  },
  {
    id: "doc-drift-fix",
    title: "Doc drift fix",
    outcome: "Opens a docs-only PR correcting drift from the code; no PR when docs already match.",
    category: "Maintenance",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Weekly doc drift fix",
    preset: "weekly-5",
    hour: 9,
    minute: 0,
    prompt:
      "Compare this repository's README and documentation against the actual code: setup and run commands, environment variables, config keys, file paths, and script names. Where the docs are wrong or stale, correct the docs to match the code. Change documentation only; do not change application code or behavior. Open a docs-only pull request describing each correction and what it was previously. If the documentation already matches the code, make no changes and do not open a PR.",
  },
  {
    id: "nightly-qa",
    title: "Nightly QA & smoke tests",
    outcome:
      "Opens a PR fixing root-caused failures; no PR when everything passes or failures are flaky or environment-only.",
    category: "CI",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Nightly QA & smoke tests",
    preset: "daily",
    hour: 3,
    minute: 0,
    prompt:
      "Run this repository's documented test and smoke commands — whatever the README, contributing guide, or CI configuration names as the way to verify the project (test suite, build, smoke or e2e scripts). For each failure, reproduce it a second time to confirm it is real, then root-cause it and implement the smallest safe fix in the code or the test setup, and re-run to confirm the fix passes. Never weaken, skip, or delete a test to make it pass. If a failure is flaky or caused only by the environment (network access, missing credentials, sandbox limits) rather than the code, make no code change for it; record it with the evidence you gathered instead. Open a single pull request describing each fix and its root cause. If every command passes, or the only failures are flaky or environment-only, make no changes and do not open a PR — leave a short report of what ran and the evidence instead.",
  },
  {
    id: "security-dependency-fixes",
    title: "Security dependency fixes",
    outcome: "Opens one PR patching critical and high CVEs, grouped by risk; no PR when no advisories apply.",
    category: "Security",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Weekly security dependency fixes",
    preset: "weekly-1",
    hour: 10,
    minute: 0,
    prompt:
      "Run this ecosystem's security audit tooling (for example npm audit, pip-audit, cargo audit, or the equivalent for this repository's package manager). Fix critical and high severity advisories by applying patch or minor upgrades only. Skip major version bumps unless the advisory has no safe patch or minor alternative; if you must take a major bump, say so explicitly in the PR and keep it isolated so it is easy to review. Leave low and moderate advisories alone. After upgrading, install dependencies and run the build and test suite to confirm nothing broke; if a specific upgrade breaks them, revert just that upgrade and list the advisory as unresolved. Open one pull request grouped by risk: which advisories were fixed at which severity, and which were skipped and why. If there are no critical or high advisories, or none can be fixed safely, make no changes and do not open a PR.",
  },
  {
    id: "secret-scan",
    title: "Secret scan",
    outcome: "Opens a PR fixing safe findings or reporting ones that need rotation; no PR when the scan is clean.",
    category: "Security",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Weekly secret scan",
    preset: "weekly-2",
    hour: 10,
    minute: 0,
    prompt:
      "Scan this repository for committed secrets: API keys, tokens, passwords, private keys, and hardcoded credentials in code and configuration. Be deliberately conservative — rewriting a secret that is live can break runtime configuration, so only change what is provably safe. You may replace values that are clearly test or demo placeholders, and you may move a clearly hardcoded application secret into an environment variable only when the repository already uses that pattern (an existing .env.example, config-from-env convention, or documented equivalent). Never rotate, delete, or rewrite anything that might be a live credential; a human must rotate those. If you make safe changes, run the build and test suite to confirm nothing broke, then open a pull request describing each change and separately listing every finding that needs human rotation. If the only findings need rotation, open a docs-only PR listing them with file references. If the scan is clean, make no changes and do not open a PR — leave a short summary of what was scanned instead.",
  },
  {
    id: "changelog-draft",
    title: "Changelog draft",
    outcome:
      "Opens a PR updating the changelog from merged PRs; no PR when there is no changelog convention or nothing merged.",
    category: "Maintenance",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Weekly changelog draft",
    preset: "weekly-5",
    hour: 10,
    minute: 0,
    prompt:
      "Compile the pull requests merged into the default branch since the last changelog entry. Look for CHANGELOG.md or the repository's existing release-notes convention (a changelog file, a docs/releases directory, or similar). Group the entries by feature, fix, infra, docs, and internal, one line per PR with its number, and match the existing file's formatting and tone. Change only the changelog or release-notes file; do not change application code. Open a pull request updating that file. If the repository has no changelog or release-notes convention, do not invent one — make no changes and do not open a PR; leave a short summary of what merged instead. If nothing has merged since the last entry, make no changes and do not open a PR.",
  },
  {
    id: "code-pattern-audit",
    title: "Code pattern audit",
    outcome:
      "Opens a small PR restoring this repo's own conventions; no PR when nothing has drifted or fixes need judgment.",
    category: "Maintenance",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Weekly code pattern audit",
    preset: "weekly-3",
    hour: 10,
    minute: 0,
    prompt:
      "Audit recently changed code in this repository for drift from the repository's own documented conventions and dominant patterns: duplicated helpers where a shared one already exists, bypassed layering (for example a route reaching around its service layer), stale or unused feature flags, and error handling that is inconsistent with how the surrounding code does it. Judge only against this repository's own conventions, instruction files, and prevailing patterns — do not apply outside style preferences or compare against other codebases. Fix only mechanical, pattern-backed issues where the repo already shows the correct pattern to copy, and keep the diff small. Run the build and test suite after fixing. Open a small pull request that names the convention each fix restores. If the findings need judgment calls or larger refactors, make no changes and do not open a PR — report the findings with file references instead. If nothing has drifted, make no changes and do not open a PR.",
  },
  {
    id: "reliability-sweep",
    title: "Reliability sweep",
    outcome: "Opens a PR with small reliability fixes, each pinned by a test; no PR when nothing obvious needs fixing.",
    category: "Maintenance",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Weekly reliability sweep",
    preset: "weekly-4",
    hour: 10,
    minute: 0,
    prompt:
      "Review recently changed code in this repository for reliability gaps: missing error handling around I/O and network calls, hardcoded timeouts, unbounded retries or loops, unsafe fallbacks that swallow failures, and brittle parsing of external data. Fix only small, obvious issues where the correct behavior is unambiguous, and add or extend a test for every fix so the corrected behavior is pinned — do not ship a fix without its test. Do not restructure code or change intended behavior. Run the build and test suite to confirm everything passes. Open a pull request explaining each gap, the fix, and the test that covers it. If every issue found would need design decisions or larger changes, make no changes and do not open a PR — report the findings with file references instead. If nothing needs fixing, make no changes and do not open a PR.",
  },
  {
    id: "coverage-gaps",
    title: "Type & test coverage gaps",
    outcome:
      "Opens a PR adding regression tests for risky changed code; no PR when recent changes are already covered.",
    category: "CI",
    connectors: ["GitHub"],
    trigger: { kind: "schedule" },
    name: "Weekly type & test coverage gaps",
    preset: "weekly-6",
    hour: 10,
    minute: 0,
    prompt:
      "Find recently changed files in this repository that carry meaningful logic but lack regression tests or type coverage, prioritizing high-risk code: payments, auth, data mutation, and external integrations. Add focused tests that pin the existing behavior exactly as it is today. Do not refactor production code to make it more testable unless a minimal seam is strictly required to write the test, and never change behavior. Where types are loose (any, missing annotations) in those same files, tighten them only when the fix is mechanical and provable. Run the full test suite and type checker to confirm everything passes. Open a pull request listing each file covered and what the new tests pin. If the recently changed code is already well covered, make no changes and do not open a PR.",
  },
];

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = SCHEDULED_AUTOMATION_TEMPLATES;

# PR-Template Fill — Layer 1 (Decomposition) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans, task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop welding the agent narrative into the template `verification` slot: split it into its own `narrative` slot placed into descriptive template headings — fixing the structural half of `mia-copy` PR #154 deterministically, with the default (no-template) PR body byte-identical.

**Architecture:** Two files change. `pr.ts` (sandbox-bridge): extract `buildCleanNarrative`, remove the welded `buildVerdictSummaryBlock` from `buildCompactVerificationContent`, add a populated `narrative` slot to `buildCompactTemplateContent`. `pr-template.ts` (deterministic renderer): add `narrative` to its slot type, managed-block regex, alias table (repartitioned: prose headings → `narrative`; only "changed files" headings → `summary`), and render loop. Foundation for PR 2 (bridge-side LLM section fill).

**Tech Stack:** TypeScript, Vitest. Run tests with `npx vitest run <path>` from repo root. sandbox-bridge is `@ts-nocheck` in tests (excluded from root tsconfig) but compiled by its own `tsc --noEmit`.

**Scope note:** PR 1 of the stacked feature (spec: `docs/superpowers/specs/2026-06-05-section-aware-pr-template-fill-design.md`). The structured proof-facts object and broker LLM fill are PR 2. After this PR, a template's first descriptive heading (e.g. `## Description`) gets the real narrative and its testing heading gets a clean verdict-only verification block; headings with no alias (e.g. `## Implementation`) stay empty until PR 2's LLM distributes content — the expected, documented intermediate state.

---

## File Structure

- `apps/sandbox-bridge/src/services/pr.ts` — MODIFY. Add `buildCleanNarrative`; refactor `buildSummarySection` to use it (no output change); strip the summary block out of `buildCompactVerificationContent`; delete the now-unused `buildVerdictSummaryBlock`; add `narrative` to `buildCompactTemplateContent`.
- `apps/sandbox-bridge/src/services/pr-template.ts` — MODIFY. Add `"narrative"` to `PrTemplateSlot`, `MANAGED_BLOCK_RE`, repartitioned `SLOT_ALIASES`, and the render-loop slot order in `renderPrBodyFromTemplate`.
- `tests/test_sandbox-bridge/pr-template.test.ts` — MODIFY. Extend `compactContent` helper with `narrative`; update the heading-routing test; add narrative-placement and #154-regression tests.
- `tests/test_sandbox-bridge/pr.test.ts` — MODIFY. Add a default-path byte-identical guard and a "verification slot has no narrative" test.

---

## Task 1: Extract `buildCleanNarrative` (no behavior change)

**Files:**

- Modify: `apps/sandbox-bridge/src/services/pr.ts` (`buildSummarySection`, ~pr.ts:659)
- Test: `tests/test_sandbox-bridge/pr.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_sandbox-bridge/pr.test.ts` inside the existing `describe("renderPrBodyFromReadiness", ...)` block. Pins the default-path `## Summary` output so the refactor can't change it.

```ts
function readinessWithNarrative(): RenderPrBodyFromReadinessInput {
  return {
    generatedBody: "",
    evidence: {
      changedFiles: ["src/a.ts"],
      diffStats: { filesChanged: 1, insertions: 2, deletions: 0 },
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
      checksDetected: { tests: true, lint: false, typecheck: false },
      skippedChecks: [],
      filesMentionedInFinalAnswer: [],
      evidenceBundle: {
        agentFinalMessage:
          "Updated the helper copy on the sign-in page.\n\nVerified: /auth/sign-in renders the new copy.",
      },
    },
    verification: {
      verified: true,
      verdict: "CONFIRMED",
      status: "passed",
      explanation: "ok",
      mode: "commands",
      runtimeEvidenceRequired: false,
      runtimeEvidenceSatisfied: false,
      claim: "Sign-in copy updated.",
      caveats: [],
      evidence: [],
    },
  };
}

it("renders the agent narrative under ## Summary with the trailing Verified: line stripped", () => {
  const body = renderPrBodyFromReadiness(readinessWithNarrative());
  expect(body).toContain("## Summary");
  expect(body).toContain("Updated the helper copy on the sign-in page.");
  // The trailing "Verified:" claim is promoted to the callout, not left in ## Summary.
  const summaryBlock = body.slice(body.indexOf("## Summary"), body.indexOf("##", body.indexOf("## Summary") + 1));
  expect(summaryBlock).not.toContain("Verified: /auth/sign-in");
});
```

- [ ] **Step 2: Run test — baseline guard**

Run: `npx vitest run tests/test_sandbox-bridge/pr.test.ts -t "renders the agent narrative under"`
Expected: PASS (current behavior; guards the refactor).

- [ ] **Step 3: Refactor — extract `buildCleanNarrative`**

In `apps/sandbox-bridge/src/services/pr.ts`, replace `buildSummarySection` (near line 659) with:

```ts
function buildCleanNarrative(evidence: PrReadinessEvidence): string {
  const finalSummary = resolveFinalSummary(evidence);
  if (!finalSummary) return "";
  const narrative = finalSummary.replace(TRAILING_VERIFIED_CLAIM_RE, "").trimEnd();
  return narrative ? neutralizeReviewerInaccessibleLinks(narrative) : "";
}

function buildSummarySection(evidence: PrReadinessEvidence): string | undefined {
  const narrative = buildCleanNarrative(evidence);
  return narrative ? ["## Summary", "", narrative].join("\n") : undefined;
}
```

- [ ] **Step 4: Re-run the test**

Run: `npx vitest run tests/test_sandbox-bridge/pr.test.ts -t "renders the agent narrative under"`
Expected: PASS (output unchanged).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run -w @cycloid/sandbox-bridge typecheck` — expect no errors.

```bash
git add apps/sandbox-bridge/src/services/pr.ts tests/test_sandbox-bridge/pr.test.ts
git commit -m "refactor(bridge): extract buildCleanNarrative from buildSummarySection"
```

---

## Task 2: Remove the welded summary block from the compact verification slot

**Files:**

- Modify: `apps/sandbox-bridge/src/services/pr.ts` (`buildCompactVerificationContent` ~pr.ts:1107; delete `buildVerdictSummaryBlock` ~pr.ts:643)
- Test: `tests/test_sandbox-bridge/pr.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_sandbox-bridge/pr.test.ts` — asserts the template-mode verification slot no longer carries the agent narrative.

```ts
it("template verification slot contains the verdict and commands but not the agent narrative", () => {
  const input = readinessWithNarrative();
  const body = renderPrBodyFromReadiness({
    ...input,
    prTemplate: {
      status: "found",
      candidate: {
        path: ".github/pull_request_template.md",
        source: "repo_local",
        content: "## Testing\nManual notes.",
      },
    },
  });
  const verificationStart = body.indexOf("<!-- cycloid:managed:start verification -->");
  const verificationEnd = body.indexOf("<!-- cycloid:managed:end verification -->");
  const verificationSlot = body.slice(verificationStart, verificationEnd);
  expect(verificationStart).toBeGreaterThan(-1);
  expect(verificationSlot).toContain("CONFIRMED");
  expect(verificationSlot).not.toContain("Updated the helper copy on the sign-in page.");
  expect(verificationSlot).not.toContain("Summary:");
});
```

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run tests/test_sandbox-bridge/pr.test.ts -t "template verification slot contains the verdict"`
Expected: FAIL — `verificationSlot` currently contains "Updated the helper copy…" and "Summary:" (the welded block).

- [ ] **Step 3: Strip the summary block and delete the dead helper**

In `apps/sandbox-bridge/src/services/pr.ts`, change the end of `buildCompactVerificationContent` from:

```ts
  const compactLines = lines.slice(0, 5);
  const summaryBlock = buildVerdictSummaryBlock(evidence);
  return summaryBlock ? [...compactLines, "", summaryBlock].join("\n") : compactLines.join("\n");
}
```

to:

```ts
  return lines.slice(0, 5).join("\n");
}
```

Delete the now-unused `buildVerdictSummaryBlock` (near pr.ts:643). Verify no other callers:

Run: `grep -n "buildVerdictSummaryBlock" apps/sandbox-bridge/src/services/pr.ts`
Expected: no matches after deletion. (`resolveFinalSummary` stays — still used by `buildCleanNarrative`.)

- [ ] **Step 4: Verify it passes**

Run: `npx vitest run tests/test_sandbox-bridge/pr.test.ts -t "template verification slot contains the verdict"`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run -w @cycloid/sandbox-bridge typecheck` — expect no errors.

```bash
git add apps/sandbox-bridge/src/services/pr.ts tests/test_sandbox-bridge/pr.test.ts
git commit -m "fix(bridge): drop welded agent narrative from compact verification slot (ARC-1129)"
```

---

## Task 3: Add the `narrative` slot to the renderer types

**Files:**

- Modify: `apps/sandbox-bridge/src/services/pr-template.ts` (`PrTemplateSlot`, `MANAGED_BLOCK_RE`, `SLOT_ALIASES`)
- Modify: `apps/sandbox-bridge/src/services/pr.ts` (`buildCompactTemplateContent` ~pr.ts:1201)
- Modify: `tests/test_sandbox-bridge/pr-template.test.ts` (`compactContent` helper)

Makes everything compile with the new slot; placement behavior lands in Task 4.

- [ ] **Step 1: Add `narrative` to the slot union and managed-block regex**

In `apps/sandbox-bridge/src/services/pr-template.ts`:

```ts
export type PrTemplateSlot = "narrative" | "summary" | "verification" | "visualEvidence" | "risk" | "followUps";
```

```ts
const MANAGED_BLOCK_RE =
  /<!--\s*cycloid:managed:start\s+(narrative|summary|verification|visualEvidence|risk|followUps)\s*-->[\s\S]*?<!--\s*cycloid:managed:end\s+\1\s*-->/g;
```

- [ ] **Step 2: Repartition `SLOT_ALIASES`**

Replace the `SLOT_ALIASES` constant with (prose headings → `narrative`; only changed-files headings → `summary`):

```ts
const SLOT_ALIASES: Record<PrTemplateSlot, string[]> = {
  narrative: ["description", "implementation", "overview", "summary", "what changed", "changes", "details"],
  summary: ["changed files", "files changed"],
  verification: ["testing", "test plan", "verification", "qa", "evidence", "proof"],
  visualEvidence: ["screenshots", "screenshots or recordings", "recordings", "demo", "video", "walkthrough"],
  risk: ["risk", "impact", "rollout"],
  followUps: ["follow-ups", "follow ups", "known issues", "todo"],
};
```

`deterministicHeadingSlot` iterates `Object.entries(SLOT_ALIASES)` in insertion order, so `narrative` is checked before `summary` — a `## Summary` heading routes to prose narrative, which is correct.

- [ ] **Step 3: Populate `narrative` in `buildCompactTemplateContent`**

In `apps/sandbox-bridge/src/services/pr.ts`, update the object returned by `buildCompactTemplateContent` (near pr.ts:1208):

```ts
return {
  narrative: buildCleanNarrative(input.evidence),
  summary: buildCompactChangedFilesContent(input.evidence),
  verification: buildCompactVerificationContent(input.evidence, input.verification),
  visualEvidence: buildCompactVisualEvidenceContent({
    screenshots: input.screenshots,
    linkOnlyScreenshots: input.linkOnlyScreenshots,
    videos: input.videos,
  }),
  risk: buildCompactRiskContent(input.evidence, input.verification),
  followUps: buildCompactFollowUpContent(input.evidence, input.verification),
  checkedCheckboxes: buildTemplateCheckedCheckboxes(input),
};
```

- [ ] **Step 4: Update the `compactContent` test helper**

In `tests/test_sandbox-bridge/pr-template.test.ts`, add `narrative` to the helper (near line 35) so it satisfies `Record<PrTemplateSlot, string>`:

```ts
function compactContent(overrides: Partial<CompactPrTemplateContent> = {}): CompactPrTemplateContent {
  return {
    narrative: "Updated the authentication flow so expired sessions redirect to sign-in.",
    summary: "- Updated authentication flow.",
    verification: "**Cycloid:** CONFIRMED\n- Verified with `npm test -- auth.test.ts`.",
    visualEvidence: "- [checkout screenshot](https://example.com/checkout.png)",
    risk: "- Auth/access control: `apps/api/auth.ts`",
    followUps: "- Add browser coverage for OAuth retry.",
    ...overrides,
  };
}
```

- [ ] **Step 5: Typecheck + full template/pr suites**

Run: `npm run -w @cycloid/sandbox-bridge typecheck`
Expected: no errors (the union change forces every `CompactPrTemplateContent` literal to include `narrative`; the two above are the only ones).

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts`
Expected: PASS or, if any heading-routing test now also picks up a `narrative` block, note the failures — they are fixed in Task 4. If all pass, proceed.

- [ ] **Step 6: Commit**

```bash
git add apps/sandbox-bridge/src/services/pr-template.ts apps/sandbox-bridge/src/services/pr.ts tests/test_sandbox-bridge/pr-template.test.ts
git commit -m "feat(bridge): add narrative slot to PR-template content model"
```

---

## Task 4: Place the narrative into descriptive headings in the renderer

**Files:**

- Modify: `apps/sandbox-bridge/src/services/pr-template.ts` (`renderPrBodyFromTemplate` render-loop ~pr-template.ts:444)
- Test: `tests/test_sandbox-bridge/pr-template.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `describe("renderPrBodyFromTemplate", ...)` block in `tests/test_sandbox-bridge/pr-template.test.ts`:

```ts
it("places the narrative under a Description heading and clean verification under Testing", () => {
  const body = renderPrBodyFromTemplate({
    template: candidate(["## Description", "", "## Testing", "", "## Changed Files", ""].join("\n")),
    content: compactContent(),
  });
  const descIndex = body.indexOf("## Description");
  const narrativeIndex = body.indexOf("<!-- cycloid:managed:start narrative -->");
  const testingIndex = body.indexOf("## Testing");
  const verificationIndex = body.indexOf("<!-- cycloid:managed:start verification -->");
  // narrative goes under Description, before Testing
  expect(narrativeIndex).toBeGreaterThan(descIndex);
  expect(narrativeIndex).toBeLessThan(testingIndex);
  expect(body).toContain("Updated the authentication flow so expired sessions redirect to sign-in.");
  // verification goes under Testing
  expect(verificationIndex).toBeGreaterThan(testingIndex);
  // the changed-files summary goes under Changed Files, not Description
  const summaryIndex = body.indexOf("<!-- cycloid:managed:start summary -->");
  expect(summaryIndex).toBeGreaterThan(body.indexOf("## Changed Files"));
});
```

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts -t "places the narrative under a Description heading"`
Expected: FAIL — `<!-- cycloid:managed:start narrative -->` is absent (render loop doesn't handle the slot yet).

- [ ] **Step 3: Add `narrative` to the render-loop slot order**

In `renderPrBodyFromTemplate` (`apps/sandbox-bridge/src/services/pr-template.ts`), change the slot-iteration array (near pr-template.ts:449) from:

```ts
  for (const slot of ["summary", "verification", "visualEvidence", "risk", "followUps"] as PrTemplateSlot[]) {
```

to:

```ts
  for (const slot of ["narrative", "summary", "verification", "visualEvidence", "risk", "followUps"] as PrTemplateSlot[]) {
```

- [ ] **Step 4: Verify it passes**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts -t "places the narrative under a Description heading"`
Expected: PASS.

- [ ] **Step 5: Update the pre-existing heading-routing test**

`"routes content into matching headings without changing customer checklist text"` (near line 352) asserts the old behavior (`summary` under `## Description`). Update its assertions to the new partition:

```ts
it("routes content into matching headings without changing customer checklist text", () => {
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

  expect(body).toContain("Customer-written text.");
  expect(body).toContain("- [ ] I ran the tests");
  expect(body).toContain("<!-- cycloid:managed:start narrative -->");
  expect(body).toContain("<!-- cycloid:managed:start verification -->");
  expect(body).toContain("<!-- cycloid:managed:start visualEvidence -->");
  expect(body.match(/checkout screenshot/g)).toHaveLength(1);
});
```

- [ ] **Step 6: Run the full template suite**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts`
Expected: PASS. If `"replaces placeholders with managed blocks"` fails because a `narrative` block is now also inserted into its `## Summary` heading, update that test to additionally allow/expect the narrative block (the `{{CYCLOID_SUMMARY}}` token still resolves to the summary slot; the `## Summary` heading additionally attracts the narrative slot — both acceptable; existing `toContain`/`not.toContain` assertions still hold). Do not weaken the `not.toContain("{{CYCLOID_SUMMARY}}")` assertion.

- [ ] **Step 7: Commit**

```bash
git add apps/sandbox-bridge/src/services/pr-template.ts tests/test_sandbox-bridge/pr-template.test.ts
git commit -m "feat(bridge): route narrative slot into descriptive template headings"
```

---

## Task 5: #154 regression test (Mia-shaped template end-to-end)

**Files:**

- Test: `tests/test_sandbox-bridge/pr-template.test.ts`

- [ ] **Step 1: Write the regression test**

Reproduces the Mia template via the full readiness renderer and asserts the #154 failure is gone.

```ts
it("REGRESSION (#154): Mia template gets narrative under Description and verdict-only Testing", () => {
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

  const descIndex = body.indexOf("## Description");
  const narrativeIndex = body.indexOf("<!-- cycloid:managed:start narrative -->");
  const implIndex = body.indexOf("## Implementation");
  // The narrative lands under Description, not jammed into a verification block under Testing.
  expect(narrativeIndex).toBeGreaterThan(descIndex);
  expect(narrativeIndex).toBeLessThan(implIndex);

  // The verification block no longer carries the narrative/Summary monolith.
  const verificationStart = body.indexOf("<!-- cycloid:managed:start verification -->");
  const verificationSlot = body.slice(verificationStart, body.indexOf("<!-- cycloid:managed:end verification -->"));
  expect(verificationStart).toBeGreaterThan(-1);
  expect(verificationSlot).not.toContain("Summary:");
});
```

Note: `readinessInput` (the helper near line 88) has no `evidenceBundle`, so `buildCleanNarrative` returns `""` and no narrative block renders. Update `readinessInput`'s `evidence` to include one:

```ts
      filesMentionedInFinalAnswer: ["apps/sandbox-bridge/src/services/pr.ts"],
      evidenceBundle: { agentFinalMessage: "Updated the checkout copy to clarify the totals line." },
    },
```

- [ ] **Step 2: Verify it passes**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts -t "REGRESSION"`
Expected: PASS.

- [ ] **Step 3: Confirm no other test regressed from the `readinessInput` change**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts tests/test_sandbox-bridge/pr.test.ts`
Expected: PASS. (Adding `evidenceBundle` makes the existing `"does not render the full default Cycloid body in template mode"` and dummy-Docker-template tests now include a narrative block; if any exact-body-equality assert fails, adjust it to `toContain` the customer headings rather than full-string equality. Do not remove existing assertions.)

- [ ] **Step 4: Commit**

```bash
git add tests/test_sandbox-bridge/pr-template.test.ts
git commit -m "test(bridge): regression for #154 narrative-in-verification structural bug"
```

---

## Task 6: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Run both bridge test files**

Run: `npx vitest run tests/test_sandbox-bridge/pr.test.ts tests/test_sandbox-bridge/pr-template.test.ts`
Expected: PASS.

- [ ] **Step 2: Run the bridge typecheck**

Run: `npm run -w @cycloid/sandbox-bridge typecheck`
Expected: no errors.

- [ ] **Step 3: Confirm the default path is untouched**

Run: `npx vitest run tests/test_sandbox-bridge/pr.test.ts -t "renders the agent narrative under"`
Expected: PASS — the no-template `## Summary` output is unchanged from Task 1's baseline.

- [ ] **Step 4: Final commit (if any staged remnants)**

```bash
git status --short
# commit only if something is staged/modified by the sweep
```

---

## Self-Review notes

- **Spec coverage (PR 1 slice):** decomposition (Tasks 2–3), narrative split + placement (Tasks 3–4), default-path byte-identical (Tasks 1, 6), #154 fix (Task 5). Structured proof-facts object, broker fill, verdict guardrail, and broker-failure fallback are **PR 2** (separate plan) — intentionally out of scope.
- **Known intermediate state (documented):** headings with no alias (e.g. `## Implementation`) stay empty until PR 2's LLM distributes narrative across multiple descriptive headings. The deterministic loop fills only the first heading matching each slot.
- **Type consistency:** `PrTemplateSlot` gains `"narrative"` in one place (pr-template.ts); every `Record<PrTemplateSlot, string>` site (the `buildCompactTemplateContent` return and the test `compactContent` helper) is updated in Task 3. `buildCleanNarrative` is defined in Task 1 and consumed in Task 3.
- **No dead code:** `buildVerdictSummaryBlock` is deleted in Task 2; `resolveFinalSummary` is retained (used by `buildCleanNarrative`).

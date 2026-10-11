# PR-Template Fill — Layer 2b (render integration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `pr_template_fill` broker call (PR 2a) into the PR-body publish path: precompute the section fill asynchronously in post-execution, assemble it deterministically into the resolved template with a fail-closed **verdict-word guard**, issue the capability, fall back cleanly when the broker is unavailable. This PR changes real PR output.

**Architecture:** `renderPrEvidenceCommentFromReadiness` is synchronous, so the async broker call happens BEFORE it in post-execution-runner; result passed via a new optional `prTemplateFill` field. New `assembleSectionFilledBody` (in `pr-template.ts`) places each LLM-decided section into the template: narrative → LLM prose; verification → LLM prose guarded by verdict-word check (deterministic verification block on violation); visualEvidence → deterministic evidence links (LLM never authors URLs); empty → nothing; headings with no fill → customer's original text untouched. Proof slots come from existing `buildCompactTemplateContent`. No fill (broker down) → existing `renderPrBodyFromTemplate` path unchanged.

**Tech Stack:** TypeScript, Vitest. `npx vitest run <path>` from repo root.

**Locked design decisions (call out for reviewer):**

- **visualEvidence is deterministic, not LLM-authored.** LLM picks which heading is the screenshots section; links come from `buildCompactTemplateContent().visualEvidence`. Rationale: a link list gains nothing from presentation and a hallucinated URL is real harm; no guard needed.
- **verification is LLM-authored prose + fail-closed verdict-word guard.** If the LLM text omits the resolved verdict word or contains a different one, that section falls back to the deterministic verification block. Command wording/layout trusted to the model (agreed permissive model).
- **Headings the LLM didn't fill (or returned `empty`) keep the customer's original section content** — never blank a customer section unless the fill targets it.
- **Two distinct fallbacks:** broker fails/unusable → no `prTemplateFill` → existing `renderPrBodyFromTemplate` (skeleton + deterministic slots). Verdict guard fails on a section → that section uses the deterministic verification block; rest of the assembled body kept.

---

## Phase A — pure assembler + render seam (no deploy needed; fully unit-testable)

## Task 1: `assembleSectionFilledBody` + verdict-word guard

**Files:**

- Modify: `apps/sandbox-bridge/src/services/pr-template.ts` (new exported function + helpers, reusing the file's existing private `parseTemplateHeadings`, `managedBlock`, `insertIntoHeadingSection`, `applyCheckedCheckboxes`)
- Test: `tests/test_sandbox-bridge/pr-template.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/test_sandbox-bridge/pr-template.test.ts` (import `assembleSectionFilledBody` from the pr-template module alongside the existing imports):

```ts
describe("assembleSectionFilledBody", () => {
  const deterministic = {
    verificationBlock: "**Verdict:** CONFIRMED. Ready for review.\n- Lint passed.",
    visualEvidence: "- [shot](https://example.com/shot.png)",
    verdict: "CONFIRMED" as const,
    checkedCheckboxes: [] as string[],
  };

  it("places narrative prose under a narrative heading and keeps customer headings intact", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Description", "", "## Testing", "", "## Screenshots", ""].join("\n"),
      fill: {
        sections: [
          { heading: "Description", kind: "narrative", text: "Tightened the totals copy." },
          {
            heading: "Testing",
            kind: "verification",
            text: "**Verdict:** CONFIRMED. Ready for review.\n- Lint passed.",
          },
          { heading: "Screenshots", kind: "visualEvidence", text: null },
        ],
      },
      deterministic,
    });
    expect(body.indexOf("Tightened the totals copy.")).toBeGreaterThan(body.indexOf("## Description"));
    expect(body).toContain("CONFIRMED");
    // visualEvidence uses the deterministic links, not anything the LLM wrote
    expect(body).toContain("https://example.com/shot.png");
  });

  it("falls back to the deterministic verification block when the LLM text drops the verdict word", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Testing", ""].join("\n"),
      fill: { sections: [{ heading: "Testing", kind: "verification", text: "Everything looks great, merging." }] },
      deterministic,
    });
    expect(body).toContain("**Verdict:** CONFIRMED. Ready for review.");
    expect(body).not.toContain("Everything looks great, merging.");
  });

  it("falls back when the LLM text asserts a contradictory verdict word", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Testing", ""].join("\n"),
      fill: { sections: [{ heading: "Testing", kind: "verification", text: "Verdict: INCONCLUSIVE — needs review." }] },
      deterministic,
    });
    expect(body).toContain("**Verdict:** CONFIRMED. Ready for review.");
    expect(body).not.toContain("INCONCLUSIVE");
  });

  it("keeps the LLM verification prose when it preserves the verdict word", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Testing", ""].join("\n"),
      fill: {
        sections: [{ heading: "Testing", kind: "verification", text: "CONFIRMED — lint and tests passed cleanly." }],
      },
      deterministic,
    });
    expect(body).toContain("CONFIRMED — lint and tests passed cleanly.");
  });

  it("leaves a customer heading untouched when no fill section targets it", () => {
    const body = assembleSectionFilledBody({
      templateContent: ["## Description", "Customer wrote this.", "", "## Checklist", "- [ ] done"].join("\n"),
      fill: { sections: [{ heading: "Description", kind: "narrative", text: "Agent narrative." }] },
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
          { heading: "Related Issue", kind: "empty", text: null },
          { heading: "Description", kind: "narrative", text: "Did the thing." },
        ],
      },
      deterministic,
    });
    expect(body).toContain("## Related Issue");
    expect(body).toContain("Did the thing.");
  });
});
```

- [ ] **Step 2: Run — expect FAIL (function missing)**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts -t "assembleSectionFilledBody"`
Expected: FAIL — `assembleSectionFilledBody` is not exported.

- [ ] **Step 3: Implement the assembler in `pr-template.ts`**

Add this exported function (and the small guard helper) to `apps/sandbox-bridge/src/services/pr-template.ts`. It reuses the file's existing private helpers `parseTemplateHeadings`, `managedBlock`, `insertIntoHeadingSection`, and `applyCheckedCheckboxes`. Import the section type from the shared module at the top of the file:

```ts
import type { PrTemplateFillLlmOutput, PrTemplateFillSection } from "../../../../shared/llm/post-execution.js";
```

```ts
const VERDICT_WORDS = ["CONFIRMED", "REFUTED", "INCONCLUSIVE"] as const;

/**
 * Fail-closed verdict-word guard. The LLM may present the verification facts in
 * its own words, but it must not change the verdict: the resolved verdict word
 * must appear and no other verdict word may. Returns true when the text is safe
 * to publish, false when it must fall back to the deterministic block.
 */
export function verificationTextPreservesVerdict(text: string, verdict: (typeof VERDICT_WORDS)[number]): boolean {
  const upper = text.toUpperCase();
  if (!upper.includes(verdict)) return false;
  return VERDICT_WORDS.filter((w) => w !== verdict).every((w) => !upper.includes(w));
}

/**
 * Assemble an LLM section-fill into a resolved template. The LLM decides a kind
 * per heading; proof slots stay deterministic:
 * - narrative   -> the LLM prose
 * - verification -> the LLM prose IF it preserves the verdict word, else the
 *                   deterministic verification block (fail-closed)
 * - visualEvidence -> the deterministic evidence links (LLM never authors URLs)
 * - empty       -> nothing
 * Headings with no matching fill section keep the customer's original content.
 */
export function assembleSectionFilledBody(input: {
  templateContent: string;
  fill: PrTemplateFillLlmOutput;
  deterministic: {
    verificationBlock: string;
    visualEvidence: string;
    verdict: (typeof VERDICT_WORDS)[number];
    checkedCheckboxes?: string[];
  };
}): string {
  const bySection = new Map<string, PrTemplateFillSection>();
  for (const section of input.fill.sections) bySection.set(section.heading, section);

  let rendered = input.templateContent;
  // Re-parse headings each iteration because insertion shifts line indices.
  for (const section of input.fill.sections) {
    const block = blockForSection(section, input.deterministic);
    if (!block) continue;
    const heading = parseTemplateHeadings(rendered).find((h) => h.text === section.heading);
    if (!heading) continue;
    rendered = insertIntoHeadingSection(rendered, heading, block);
  }

  return applyCheckedCheckboxes(rendered.replace(/\n{3,}/g, "\n\n").trim(), input.deterministic.checkedCheckboxes);
}

function blockForSection(
  section: PrTemplateFillSection,
  deterministic: { verificationBlock: string; visualEvidence: string; verdict: (typeof VERDICT_WORDS)[number] },
): string | null {
  switch (section.kind) {
    case "narrative": {
      const text = section.text?.trim();
      return text ? managedBlock("narrative", text) : null;
    }
    case "verification": {
      const text = section.text?.trim();
      const safe =
        text && verificationTextPreservesVerdict(text, deterministic.verdict)
          ? text
          : deterministic.verificationBlock.trim();
      return safe ? managedBlock("verification", safe) : null;
    }
    case "visualEvidence": {
      const links = deterministic.visualEvidence.trim();
      return links ? managedBlock("visualEvidence", links) : null;
    }
    case "empty":
      return null;
  }
}
```

Note: `insertIntoHeadingSection` inserts a managed block into the heading's section (after any template helper comments, else at section end), exactly as the `renderPrBodyFromTemplate` loop does — customer checklist text and prose preserved.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts -t "assembleSectionFilledBody"` → PASS (6/6).
Run the whole file: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts` → all PASS (no regressions to existing renderer tests).

- [ ] **Step 5: Bridge typecheck + commit**

Run: `npm run -w @cycloid/sandbox-bridge typecheck` → no errors.

```bash
git add apps/sandbox-bridge/src/services/pr-template.ts tests/test_sandbox-bridge/pr-template.test.ts
git commit -m "feat(bridge): assembleSectionFilledBody with fail-closed verdict guard"
```

---

## Task 2: Render seam — accept a precomputed fill

**Files:**

- Modify: `apps/sandbox-bridge/src/services/pr.ts` (`RenderPrBodyFromReadinessInput`, the template branch of `renderPrEvidenceCommentFromReadiness`, and `export` two helpers)
- Test: `tests/test_sandbox-bridge/pr.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/test_sandbox-bridge/pr.test.ts` (reuse the `readinessWithNarrative` helper added in PR 1):

```ts
it("uses the LLM section fill to populate a template when prTemplateFill is provided", () => {
  const input = readinessWithNarrative();
  const body = renderPrBodyFromReadiness({
    ...input,
    prTemplate: {
      status: "found",
      candidate: {
        path: ".github/pull_request_template.md",
        source: "repo_local",
        content: "## Description\n\n## Implementation\n\n## Testing\n",
      },
    },
    prTemplateFill: {
      sections: [
        { heading: "Description", kind: "narrative", text: "Top-level summary of the change." },
        { heading: "Implementation", kind: "narrative", text: "Edited the sign-in helper." },
        { heading: "Testing", kind: "verification", text: "CONFIRMED — lint passed." },
      ],
    },
  });
  expect(body).toContain("Top-level summary of the change.");
  expect(body).toContain("Edited the sign-in helper."); // Implementation now filled (PR 1 left it empty)
  expect(body).toContain("CONFIRMED");
});

it("falls back to the deterministic template render when no prTemplateFill is provided", () => {
  const input = readinessWithNarrative();
  const body = renderPrBodyFromReadiness({
    ...input,
    prTemplate: {
      status: "found",
      candidate: {
        path: ".github/pull_request_template.md",
        source: "repo_local",
        content: "## Description\n\n## Testing\n",
      },
    },
  });
  // Existing PR-1 deterministic behavior: narrative managed block under Description.
  expect(body).toContain("<!-- cycloid:managed:start narrative -->");
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/test_sandbox-bridge/pr.test.ts -t "uses the LLM section fill"`
Expected: FAIL — `prTemplateFill` is not a known field and is ignored.

- [ ] **Step 3: Add the field + branch + exports**

In `apps/sandbox-bridge/src/services/pr.ts`:

(a) Import the assembler and types from `pr-template.js` (extend the existing import from that module) and the fill output type from the shared module:

```ts
import { /* existing imports */, assembleSectionFilledBody } from "./pr-template.js";
import type { PrTemplateFillLlmOutput } from "../../../../shared/llm/post-execution.js";
```

(b) Add an optional field to `RenderPrBodyFromReadinessInput` (after `videos`):

```ts
  /**
   * Precomputed section fill from the platform-LLM broker (pr_template_fill).
   * When present AND a template is resolved, sections are assembled into the
   * template via {@link assembleSectionFilledBody}. When absent, the deterministic
   * {@link renderPrBodyFromTemplate} path is used (broker-down fallback).
   */
  prTemplateFill?: PrTemplateFillLlmOutput;
```

(c) Replace the template branch of `renderPrEvidenceCommentFromReadiness` (the `if (input.prTemplate?.status === "found") { return renderPrBodyFromTemplate({...}); }` block) with:

```ts
if (input.prTemplate?.status === "found") {
  const content = buildCompactTemplateContent({
    evidence,
    verification: input.verification,
    screenshots,
    linkOnlyScreenshots: input.linkOnlyScreenshots ?? [],
    videos,
  });
  if (input.prTemplateFill) {
    return assembleSectionFilledBody({
      templateContent: input.prTemplate.candidate.content,
      fill: input.prTemplateFill,
      deterministic: {
        verificationBlock: content.verification,
        visualEvidence: content.visualEvidence,
        verdict: (resolveVerificationVerdict(input.verification) ?? "INCONCLUSIVE") as
          "CONFIRMED" | "REFUTED" | "INCONCLUSIVE",
        checkedCheckboxes: content.checkedCheckboxes,
      },
    });
  }
  return renderPrBodyFromTemplate({ template: input.prTemplate.candidate, content });
}
```

(d) Export the two helpers needed by the post-execution input builder (Task 4): add `export` to `function resolveVerificationVerdict(...)` (~pr.ts:449) and `function buildCleanNarrative(...)` (~pr.ts:653).

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/test_sandbox-bridge/pr.test.ts -t "section fill"` → PASS.
Run: `npx vitest run tests/test_sandbox-bridge/pr.test.ts tests/test_sandbox-bridge/pr-template.test.ts` → all PASS.

- [ ] **Step 5: Bridge typecheck + commit**

Run: `npm run -w @cycloid/sandbox-bridge typecheck` → no errors.

```bash
git add apps/sandbox-bridge/src/services/pr.ts tests/test_sandbox-bridge/pr.test.ts
git commit -m "feat(bridge): render seam for precomputed pr_template_fill sections"
```

---

## Phase B — integration wiring (requires a control-plane deploy to E2E-verify)

Thread the broker client into post-execution, build the fill input, call it, issue the capability. Where noted, MATCH the existing `memory_ranking` wiring — read the cited reference and mirror exactly, don't guess.

## Task 3: Thread `platformLlmCapabilities` into post-execution

**Files:**

- Modify: `apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts` (`PostExecutionContext` interface)
- Modify: `apps/sandbox-bridge/src/bridge.ts` (context construction + post-execution scheduling)

- [ ] **Step 1: Add the capability to `PostExecutionContext`**

In `post-execution-runner.ts`, add to the `PostExecutionContext` interface (alongside the other injected deps):

```ts
  /** Platform-LLM capability manifest for this prompt, used to obtain a
   * pr_template_fill broker client during post-execution. Undefined when the
   * session has no platform-LLM capabilities. */
  platformLlmCapabilities?: HandlePromptOptions["platformLlmCapabilities"];
```

Add the `HandlePromptOptions` import if not already present (it is imported elsewhere in the bridge; match the existing path `../../../../../shared/types/sandbox.js`).

- [ ] **Step 2: Pass it through in `bridge.ts`**

In the `postExecutionContext(...)` builder (~bridge.ts:1675) and `schedulePostExecution` (~bridge.ts:2017): the bridge already has `platformLlmCapabilities` in `HandlePromptContext` (passed to `rankMemoriesForPrompt`). Thread that same value into the `PostExecutionContext`. READ how `rankMemoriesForPrompt`/`createPlatformLlmClient` obtain it (~bridge.ts:3272, 3512) and pass the identical value. Do not change its type.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run -w @cycloid/sandbox-bridge typecheck` → no errors.

```bash
git add apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts apps/sandbox-bridge/src/bridge.ts
git commit -m "feat(bridge): expose platformLlmCapabilities to post-execution"
```

## Task 4: Build the fill input and call the broker at the render sites

**Files:**

- Modify: `apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts`
- Test: `tests/test_sandbox-bridge/` (a new focused test for the input builder)

- [ ] **Step 1: Add a private input-builder + fill method**

In `post-execution-runner.ts`, add a helper that builds `PrTemplateFillLlmInput` and a method that obtains the client and calls `fillPrTemplateSections`. Import: `fillPrTemplateSections` from `../pr-template-fill.js`; `buildCleanNarrative`, `resolveVerificationVerdict` from `../pr.js`; `parseTemplateHeadings` from `../pr-template.js`; types from `../../../../../shared/llm/post-execution.js`; `PlatformLlmBrokerClient`/`createPlatformLlmClient` access — see note. Build the input:

```ts
private buildPrTemplateFillInput(args: {
  template: PrTemplateCandidate;
  evidence: PrReadinessEvidence;
  verification: ExecutionVerification | undefined;
  diffSummary: string;
  screenshotUrls: string[];
}): PrTemplateFillLlmInput {
  const headings = parseTemplateHeadings(args.template.content).map((h) => h.text).slice(0, 25); // INPUT SHAPING: cap headings
  const verdict = (resolveVerificationVerdict(args.verification) ?? "INCONCLUSIVE") as PrTemplateFillLlmInput["verdict"];
  const commands = args.evidence.commandsRun
    .filter((c) => c.status === "completed" || c.status === "error")
    .slice(0, 12) // INPUT SHAPING: cap commands
    .map((c) => ({
      label: c.check ? c.check : "Command",
      command: c.command,
      status: (c.status === "completed" ? "passed" : "failed") as "passed" | "failed" | "skipped",
    }));
  return {
    headings,
    narrative: buildCleanNarrative(args.evidence).slice(0, 8_000), // INPUT SHAPING: cap narrative
    taskPrompt: (args.evidence.evidenceBundle?.originalPrompt ?? "").slice(0, 4_000),
    diffSummary: args.diffSummary.slice(0, 4_000),
    verdict,
    commands,
    evidenceUrls: args.screenshotUrls.slice(0, 10),
  };
}
```

INPUT SHAPING (the note carried from PR 2a's reviewer): the caps above keep the request comfortably under the broker's 256 KB `maxInputBytes` so a large diff/long session can't make the call silently no-op.

Then a method:

```ts
private async computePrTemplateFill(args: {
  template: PrTemplateCandidate;
  evidence: PrReadinessEvidence;
  verification: ExecutionVerification | undefined;
  diffSummary: string;
  screenshotUrls: string[];
  log: BridgeLogger;
  signal: AbortSignal;
}): Promise<PrTemplateFillLlmOutput | null> {
  const client = createPlatformLlmClient(this.ctx.platformLlmCapabilities, "pr_template_fill", "post_execution", { /* see note */ });
  if (!client) return null;
  return fillPrTemplateSections(this.buildPrTemplateFillInput(args), args.log, args.signal, { client });
}
```

NOTE on client construction: `createPlatformLlmClient` is a PRIVATE method on `AgentBridge` (`bridge.ts:3272`). Options: (a) extract an exported factory (e.g. `apps/sandbox-bridge/src/services/platform-llm-client.ts` — `createPlatformLlmBrokerClient({ capabilities, callType, phase, controlPlaneUrl, sessionId, getAuthToken, fetchImpl, signal })`) called from both `bridge.ts` and here; or (b) add a `createPlatformLlmClient: (callType, phase, signal) => BridgeStructuredOutputClient | undefined` factory to `PostExecutionContext`, supplied by `bridge.ts`. **Implement (b)** — keeps control-plane URL / auth-token / fetch wiring in `bridge.ts` (which owns them) and matches how other capabilities are injected. Supply it from `bridge.ts` reusing the existing private method; call `this.ctx.createPlatformLlmClient("pr_template_fill", "post_execution", signal)` here.

- [ ] **Step 2: Call it at the two render sites**

At the success render site (~line 1351) and the failure render site (~line 596), precompute the fill BEFORE the synchronous render and pass it in. Only attempt when a template was resolved:

```ts
const prTemplateFill =
  prTemplate.status === "found"
    ? await this.computePrTemplateFill({
        template: prTemplate.candidate,
        evidence: prReadiness, // (lightweightReadiness at the failure site)
        verification: verificationPayload, // (failureVerificationPayload at the failure site)
        diffSummary: diffSummary ?? prep.diffStat ?? "", // (the failure site's diff source)
        screenshotUrls: [
          ...embeddableScreenshots.map((s) => s.url),
          ...linkOnlyScreenshots.map((s) => s.url),
          ...videoArtifacts.map((v) => v.url),
        ].filter(Boolean),
        log: promptLog, // match the in-scope logger var name at each site
        signal: this.ctx.serverAbortSignal, // match the in-scope signal at each site
      })
    : null;
```

Then add `prTemplateFill` to the `renderPrEvidenceCommentFromReadiness({ ... })` call object at that site. Use the EXACT in-scope variable names at each site (success site: `prReadiness`/`verificationPayload`/`diffSummary`/`prep`; failure site: `lightweightReadiness`/`failureVerificationPayload`/`preparedDiff`). Read the surrounding ~30 lines at each site and bind accordingly.

- [ ] **Step 3: Unit-test the input builder**

Focused test — construct a runner, or (preferred for testability) extract `buildPrTemplateFillInput` as an exported module-level pure function — asserting: headings capped, verdict mapped from verification, commands mapped (`completed`→`passed`, `error`→`failed`) and capped, narrative/task/diff truncated, evidenceUrls assembled and capped.

- [ ] **Step 4: Run + typecheck + commit**

Run: the new test + `npx vitest run tests/test_sandbox-bridge/` (full bridge suite) → all PASS.
Run: `npm run -w @cycloid/sandbox-bridge typecheck` → no errors.

```bash
git add apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts apps/sandbox-bridge/src/services/platform-llm-client.ts tests/test_sandbox-bridge/
git commit -m "feat(bridge): compute pr_template_fill and apply it at PR render sites"
```

## Task 5: Issue the `pr_template_fill` capability

**Files:**

- Modify: `apps/control-plane-worker/src/session/durable-object.ts` (~line 2806)
- Test: `tests/test_cloudflare/` (capability issuance test if one exists for memory_ranking)

- [ ] **Step 1: Add to the issued call types**

In `attachPlatformLlmCapabilities` (~durable-object.ts:2806), change:

```ts
const callTypes: PlatformLlmCallType[] = ["memory_ranking"];
```

to:

```ts
const callTypes: PlatformLlmCallType[] = ["memory_ranking", "pr_template_fill"];
```

The loop already reads `PLATFORM_LLM_CALL_CONFIG[callType].phase` (`post_execution` for `pr_template_fill`) and issues a capability with the correct phase and 2h TTL — no other change needed.

- [ ] **Step 2: Test the manifest includes both call types**

Find the existing test covering `attachPlatformLlmCapabilities` / the minted manifest in `tests/test_cloudflare/` (search `capability_minted` or `platformLlmCapabilities`). Extend or add a test asserting the manifest contains a `pr_template_fill` capability with `phase: "post_execution"`, mirroring the memory_ranking assertion. If none exists, add a focused one.

- [ ] **Step 3: Run + typecheck + commit**

Run: the relevant control-plane test → PASS.
Run: `npm run -w @cycloid/control-plane-worker typecheck` → no errors.

```bash
git add apps/control-plane-worker/src/session/durable-object.ts tests/test_cloudflare/
git commit -m "feat(platform-llm): issue pr_template_fill capability per prompt"
```

## Task 6: Verification sweep

**Files:** none.

- [ ] **Step 1: Full bridge + control-plane suites**

Run: `npx vitest run tests/test_sandbox-bridge/ tests/test_cloudflare/platform-llm.test.ts tests/test_shared/post-execution-llm.test.ts` → all PASS.

- [ ] **Step 2: Full typechecks**

Run: `npm run typecheck` (root) and `npm run -w @cycloid/sandbox-bridge typecheck` → no errors.

- [ ] **Step 3: Fallback-intact check**

Confirm the no-template default body and the no-fill template body are unchanged from PR 1 behavior:
Run: `npx vitest run tests/test_sandbox-bridge/pr.test.ts -t "renders the agent narrative under"` and `-t "falls back to the deterministic template render"` → PASS.

- [ ] **Step 4: Note E2E requirement**

Live behavior (broker filling a real PR) is only verifiable after a **control-plane deploy** (capability issuance + broker route run there) via a Cycloid session against a templated repo (e.g. `mia-copy`). Record as a post-merge verification step per docs/testing.md — not runnable from unit tests alone.

---

## Self-Review notes

- **Spec coverage:** async-fill-before-sync-render seam (Task 2), deterministic assembler (Task 1), verdict-word guard fail-closed (Task 1), visualEvidence deterministic (Task 1), broker-down fallback = existing deterministic template render (Task 2), capability issuance (Task 5), input shaping caps (Task 4). LLM-presents-proof permissive model = proof facts passed in (PR 2a) + LLM verification prose accepted under the verdict guard (Task 1).
- **Phase boundary:** Phase A (Tasks 1–2) pure, fully unit-tested, no deploy dependency. Phase B (Tasks 3–5) wiring; live effect needs a control-plane deploy.
- **Type consistency:** `assembleSectionFilledBody` consumes `PrTemplateFillLlmOutput`/`PrTemplateFillSection` from `shared/llm/post-execution.ts` (PR 2a); `RenderPrBodyFromReadinessInput.prTemplateFill` is the same type. `verificationTextPreservesVerdict` and the assembler's `verdict` use the same three-word union as the input `verdict`.
- **Mirror-instruction spots (read surrounding code, don't guess):** Task 3 (bridge DI threading) and Task 4's client-construction seam (`PostExecutionContext.createPlatformLlmClient` factory). Match the existing `memory_ranking` wiring at `bridge.ts:3272/3512`.

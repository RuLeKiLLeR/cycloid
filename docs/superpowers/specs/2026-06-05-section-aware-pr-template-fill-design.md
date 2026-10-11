# Section-aware PR-template fill — decomposition-first redesign

Redo of the reverted **ARC-1129** (`[2/2]` of the PR-structure work; parent design:
`2026-06-04-pr-structure-memory-template-design.md`). ARC-1126 (template resolution
precedence + deterministic renderer) is live and unchanged. This spec covers filling each
resolved template's sections with the current session's content.

## Background: why ARC-1129 was reverted

Evidence: `trycycloid/mia-copy` PR #154. The Mia template
(`## Description / ## Implementation / ## Testing / ### Local Tests / ### Unit Tests / ## Results`)
rendered with the skeleton present but sections wrong:

- `## Description` → only a bare changed-files list.
- `## Implementation`, `## Testing`, `### Local Tests`, `### Unit Tests` → empty.
- The real narrative ("Updated sign-in.tsx so the helper text now reads…") plus commands
  and the `Verified:` claim were all dumped into one `verification` managed block under
  `### Unit Tests`.

### Root cause (not the LLM)

The defect is upstream of the fill, in the deterministic decomposition.
`buildCompactVerificationContent` (apps/sandbox-bridge/src/services/pr.ts) ends with:

```js
const summaryBlock = buildVerdictSummaryBlock(evidence); // = "Summary:\n\n" + raw agentFinalMessage
return summaryBlock ? [...compactLines, "", summaryBlock].join("\n") : compactLines.join("\n");
```

So the `verification` slot = verdict + check bullets + the entire raw agent final message
welded on. ARC-1129 fed that monolith in as deterministic verification content, so the
narrative was trapped inside verification before the LLM ran. Description/Implementation
could never be filled because their content was never separated out.

Corroborating facts:

- The default (non-template) path already separates narrative and proof:
  `buildSummarySection` → `## Summary` and `buildSuccessfulVerificationSection` →
  `## Verification`. The compact/template path re-merged them (ARC-1119 / #4018
  post-processing) and is strictly worse — it uses `resolveFinalSummary` raw, skipping the
  `TRAILING_VERIFIED_CLAIM_RE` stripping the default path applies.
- ARC-1129's other weaknesses (control-plane factsheet round-trip; 4s/1-attempt budget;
  silent fallback to a too-weak deterministic body) compounded it, but decomposition is
  the primary cause.

## Goals

1. **Decompose deterministic content into clean atomic facts.** Never weld narrative into
   the `verification` slot. The LLM only ever presents already-separated, ground-truth
   facts, so it cannot reproduce the bundled blob.
2. **Bridge-side, silent section fill** for templated repos via the existing
   `PlatformLlmBrokerClient` (already used by broker memory-ranking). No control-plane
   factsheet hop, no agent-visible prompt turn.
3. **Robust, non-empty fallback** when the broker call fails on a templated repo.
4. **Default (no-template) path byte-identical.**

## Non-goals

- Restructuring the default body — stacked follow-up (see end).
- Control-plane factsheet round-trip (removed).
- Any agent-visible prompt turn / new session-window content.
- The `pr_structure` memory tier (ARC-1124).

## Invariants (must hold)

- **Default path untouched.** Fill engages only inside the
  `input.prTemplate?.status === "found"` branch of `renderPrEvidenceCommentFromReadiness`.
- **The LLM may author proof _presentation_, not alter proof _facts_.** Fact determination
  — verdict value, which commands ran and each one's pass/fail status, changed files,
  screenshot URLs, checkboxes — stays deterministic and is fed to the LLM as ground truth;
  the LLM lays the facts out readably (avoiding deterministic slop and verbatim-line +
  framing redundancy). A fail-closed verdict-word check backstops the single
  highest-stakes fact (Layer 2); command-level wording is trusted to the model.
- **No new session-window content** — silent post-execution computation.
- **Placeholder templates (`{{CYCLOID_*}}`) keep routing to the deterministic renderer**
  (LLM skipped) — `containsCycloidPlaceholders` short-circuit.

## Architecture

Two layers. Layer 1 is the foundation both this feature and the default-path cleanup ride.

### Layer 1 — Clean atomic slot decomposition

Replace bundled compact content with separable, single-purpose slots. Key change: split a
new `narrative` slot out of `verification`, and stop appending `buildVerdictSummaryBlock`
to the verification slot.

Slot set consumed by the template path:

| Slot                                     | Content                                                                                                             | Notes                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `narrative` _(new)_                      | agent final message with the `Verified:`/target tail stripped (reuse `TRAILING_VERIFIED_CLAIM_RE`), grounded per A1 | feeds Description / Implementation                                                             |
| `summary`                                | changed-files list (`buildCompactChangedFilesContent`)                                                              | unchanged                                                                                      |
| proof facts _(structured)_               | verdict enum, per-command `{label, command, status}`, evidence URLs                                                 | data fed to the LLM, not pre-rendered prose; `buildVerdictSummaryBlock` removed from this path |
| `verificationFallback`                   | deterministic verdict + command bullets (`buildCompactVerificationContent` minus the summary block)                 | used only by the verdict guardrail / broker-failure fallback                                   |
| `claim` _(new, optional)_                | the promoted `Verified:` callout (mirrors default-path `buildClaimCallout`)                                         | callout or Testing                                                                             |
| `visualEvidence`                         | screenshot/video links (`buildCompactVisualEvidenceContent`)                                                        | unchanged                                                                                      |
| `risk`, `followUps`, `checkedCheckboxes` | unchanged                                                                                                           | unchanged                                                                                      |

Behavior-preserving for the default path: the default body already renders `## Summary`
and `## Verification` separately, so removing the welded block from the compact path does
not touch default output (verified by a byte-identical snapshot test).

### A1 — Narrative grounding

The narrative slot is grounded on bounded diff summary + original task prompt + agent
final message, not the final message alone. All three already live in
`PrReadinessEvidence` (`diffStats`, `evidenceBundle.originalPrompt`,
`evidenceBundle.agentFinalMessage`). The diff is the always-present ground truth, so a
terse final message degrades gracefully. The diff is passed as a bounded summary (file
list + diffStats, optionally a truncated `diffStats.raw`), never the full diff, to keep
the call cheap.

### Layer 2 — Section fill (bridge-side LLM)

- **Trigger:** template `found` AND no `{{CYCLOID_*}}` placeholders.
- **Client:** `PlatformLlmBrokerClient.generateStructuredOutput` with a new
  `PlatformLlmCallType` `pr_template_fill`; structured-output tool returning
  `sections: [{heading, kind, text?}]`, `kind ∈ narrative|verification|visualEvidence|empty`.
- **Input (ground truth):** template headings (in order) + clean `narrative` + bounded
  diff summary + original task prompt + structured proof facts (verdict enum; per-command
  `{label, command, status}`; evidence URLs), passed as data the model must present, with
  an explicit instruction: _these are the only true facts — present them readably; never
  change a verdict or a pass/fail status, never invent commands or URLs._
- **LLM job:** (a) map each heading → kind; (b) write prose for `narrative` headings from
  the clean narrative; (c) for `verification`/`visualEvidence` headings, render the
  supplied proof facts into a readable, non-redundant section (replaces injecting a
  verbatim deterministic block).
- **Assembly (`assembleSectionFilledBody`):** places each section's text under its
  heading; `empty` → blank.

### Proof guardrail (fail-closed, verdict only)

After the LLM renders, a deterministic check verifies the verdict word: the resolved
verdict (`CONFIRMED` | `REFUTED` | `INCONCLUSIVE`) must appear in the rendered
verification section and the other two verdict words must be absent. On violation, that
section only falls back to the deterministic proof block (verdict + command bullets); the
rest of the body is kept. This is intentionally the only enforced fact: a single enum
(cheapest, least constraining pin), the highest-stakes fact (an INCONCLUSIVE→CONFIRMED
flip published as the user is catastrophic), and a presence check can't introduce
redundancy. Command-level wording, layout, and framing have no validator.

### Fallback contract

If the broker call fails, times out, or returns unusable output on a templated repo:
render the template skeleton with deterministic proof slots filled, and fill descriptive
headings with a changed-files / diff-derived summary. Never leave a descriptive heading
empty, never dump narrative into verification, and do not fall back to the non-template
default body (that would discard the customer's template structure — the point of the
feature). This fixes PR #154's failure mode even with the LLM unavailable. (Distinct from
the verdict guardrail, which is per-section when the call succeeded but failed the check.)

### Ownership (unchanged)

The bridge renders the full templated body. The control-plane publish path
(`pr-body.ts buildPrBody`) keeps light post-processing only: honor
`BRIDGE_VERIFICATION_RENDERED_MARKER` (skip duplicate verdict), anchor the
`visualEvidence` managed block, append the transcript link/footer, publish as the user.

### Data flow

```
post-execution evidence (PrReadinessEvidence + ExecutionVerification + artifacts)
        │
        ▼
Layer 1: decompose → { narrative, summary, structured proof facts (verdict enum,
                       commands+statuses, URLs), risk, followUps, checkedCheckboxes }
        │
        ├─ template "found" & no placeholders ─► Layer 2: broker fill (headings→kinds,
        │                                              narrative prose, + readable proof from facts)
        │                                              │  success → verdict-word guard
        │                                              │             ├ ok → assembleSectionFilledBody
        │                                              │             └ fail → deterministic proof block (that section)
        │                                              └─ call fail/unusable → deterministic skeleton + diff-derived narrative
        │
        └─ no template ─────────────────────────► unchanged default body (renderPrEvidenceCommentFromReadiness)
        │
        ▼
control-plane buildPrBody (dedup / anchor / transcript link) → publish
```

## Components / files

- `apps/sandbox-bridge/src/services/pr.ts` — split `narrative` out of
  `buildCompactVerificationContent`; remove `buildVerdictSummaryBlock` from that path;
  extend `buildCompactTemplateContent` / the slot type with `narrative` (+ `claim`).
- `shared/pr-template-fill.ts` — slot/kind types, `assembleSectionFilledBody`.
- `apps/sandbox-bridge/src/services/pr-template.ts` — `renderPrBodyFromTemplate` wiring
  - fill invocation + fallback.
- `apps/sandbox-bridge/src/services/platform-llm-client.ts` /
  `shared/llm/platform-llm-contract.ts` — new `pr_template_fill` call type.
- `apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts` — pass the
  broker client + narrative grounding into the render call.
- `shared/pr-template-render.ts` — `containsCycloidPlaceholders` reused; renderer untouched.

## Error handling

- Broker failure / timeout / unusable shape → fallback contract above (logged via the
  existing platform-LLM completion fields, `callType: pr_template_fill`).
- Placeholder templates → deterministic renderer (no model call).
- Empty/whitespace narrative from the LLM for a descriptive heading → degrade that heading
  to the diff-derived summary, not blank.

## Testing

Unit (same-PR):

- Decomposition: `verification` slot / proof facts contain no narrative / `Summary:` block.
- Narrative cleaning: trailing `Verified:`/target stripped; diff/task grounding present.
- Heading → kind mapping + `assembleSectionFilledBody` (narrative/verification/visualEvidence/empty).
- Verdict guardrail: missing or contradictory verdict word falls back to the deterministic
  proof block for that section only; correct render passes through unchanged.
- Fallback: broker failure yields a templated body with filled proof slots and non-empty
  descriptive sections; never narrative-in-verification.
- Default-path byte-identical snapshot (no template → unchanged body).
- Placeholder-template skip (no broker call).

E2E (Cycloid session evidence per docs/testing.md): a `mia-copy` session reproducing
PR #154's task, confirming Description/Implementation/Testing populate correctly and the
welded block is gone.

## Sequencing / stacking

- **PR 1 — Layer 1 decomposition (foundation).** Behavior-preserving for the default path;
  fixes the welded-block defect in the compact/template content. Lands first.
- **PR 2 — Layer 2 bridge-side section fill.** Stacks on PR 1.
- **PR 3 — default-path cleanup (parallel track, below).** Stacks on PR 1.

PR 2 and PR 3 are independent given PR 1 and can proceed in parallel; if they touch
overlapping render code they stack sequentially.

## Parallel track: default-path cleanup (own stacked spec)

Goal: reduce "slop" in the non-template body. Rides Layer 1's clean slots. Known slop
sources in `pr.ts`:

- `## Summary` emits the raw agent final message (verbose / meandering).
- The `<details>Publish &amp; evidence details</details>` block is dense fine-print.
- Overlap between the `✅ Verified` callout, `## Summary`, and `## Verification` can
  restate the same facts.

These involve product/taste calls, so detailed scope lives in a separate spec/PR (stacked
on PR 1), not designed here.

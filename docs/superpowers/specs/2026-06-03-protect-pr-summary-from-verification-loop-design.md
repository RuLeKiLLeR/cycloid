# Protect the PR summary from the verification loop

Date: 2026-06-03
Owner: jag
Status: implemented (#3957)

> **Note:** The PR body structure described below (`## Verdict` with embedded
> `Summary:` block) was replaced in #4018 by a human-readable layout with a
> top-level `## Summary` heading and claim callout. The summary preservation
> logic still applies but now operates on the `## Summary` section instead of
> the `Summary:` block within `## Verdict`.

## Problem

When a session's verification / review loop runs after the implementation publish, the
PR-body summary gets overwritten: it flips from "I implemented X" to a review-loop
narrative ("I addressed the review-loop item ...").

**Proof — merged PR #3642 ("[ARC] Batch session evaluation lookups"):**

> **## Verdict**
> ...
> **Summary:**
> Addressed the review-loop item and replied through `cycloid.review_loop_reply`.
> Committed `8459b8e Chunk session evaluation lookups`: ...

The implementation narrative was demoted; the lead is the review-loop run's closing
message. PRs without a post-implementation loop run keep an intact
"Implemented ... / Updated ..." summary (e.g. #3804, #3813, #3747, #3560, #3536).

## Root cause

The summary is the `Summary:` block rendered from `evidenceBundle.agentFinalMessage` by
`buildVerdictSummaryBlock` — the line `["Summary:", "", finalSummary].join("\n")`, placed at
the end of the `## Verdict` section. Two render paths, both using the same block shape:

- **Bridge-authored body (the common path, e.g. #3642).** The bridge renders the entire PR
  body via `renderPrEvidenceCommentFromReadiness`
  (`apps/sandbox-bridge/src/services/pr.ts:1110`, called at
  `apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts:1338`), including
  `## Verdict` + `Summary:` (`pr.ts:566`). The body is regenerated fresh every run from that
  run's readiness. Control-plane `buildPrBody`
  (`apps/control-plane-worker/src/session/pr-body.ts:856`) early-returns for bodies containing
  `## Functional Verification` or the managed verification block (`pr-body.ts:867`), so it
  passes the bridge body through untouched.
- **Control-plane-built verdict (plain bodies).** When the body has no managed verification,
  `buildPrBody` adds `## Verdict` itself via `buildVerdictSection` →
  `buildVerdictSummaryBlock` (`pr-body.ts:776`).

In both paths the `Summary:` block is re-derived from the current run's `agentFinalMessage`.
A review-loop / CI-fix republish carries a fresh readiness whose message describes the
touch-up, so the implementation summary is lost. `preservePrEvidenceSections`
(`pr-body.ts:209`) only protects screenshot/video headings — never the summary.

Only the control plane has the previous PR body (`pr_body:latest` in Durable Object
storage, read at `publish-service.ts:1814`). The bridge runs in the sandbox and cannot see
the prior body, so preservation must live control-plane-side.

## Approach (approved: Option A — control-plane only, preserve in place)

On automated review-loop / CI-fix runs, preserve the prior `Summary:` block **in place** in
`composePrBody`: swap the freshly-rendered summary for the previous PR body's summary. No
bridge change, no section move.

### Why this is the middle ground

- **Not freeze-on-first:** a genuine follow-up _user_ prompt regenerates the summary, so the
  PR body stays correct as the implementation grows.
- **Not review-loop-only-coupled:** the gating signal (`prompt.reviewLoopEpochId`) covers
  **all** automated touch-up runs — review-comment responses _and_ CI-fix runs are both
  modeled as review-loop epochs (`[cycloid:review-loop epoch=...]`). The rule reads as
  "automated response runs don't rewrite the human summary."
- **No overcoding:** reuses the existing `reviewLoopEpochId` prompt column already read by
  `validateReviewLoopPublishGuard` (`publish-service.ts:1628`). No new storage key, no
  migration, no GitHub calls, no bridge change.

### The cheap signal

```ts
const prompt = promptId ? doDb.getPrompt(this.sql, promptId) : null;
const isAutomatedEpochRun = Boolean(prompt?.reviewLoopEpochId?.trim());
```

A pure D1 read available inside `composePrBody`, before any auth/GitHub work.

### Why in-place (not a section move)

The body is bridge-authored in the common path, so giving the summary its own `## Summary`
heading would require changing `renderPrEvidenceCommentFromReadiness` (which also drives the
evidence _comment_) **and** the control-plane preservation. In-place preservation of the
stable `Summary:` block handles both render paths with a control-plane-only change and fully
meets the bug goal ("the loop never overwrites the summary").

## Design details

### New pure helpers in `pr-body.ts`

`extractVerdictSummaryBlock(markdown)` — returns the `Summary:` block (the `Summary:` line plus
its body, bounded by the next markdown heading or footer line), or `null`. Reuses the existing
`findMarkdownBoundaryIndex` / `isMarkdownHeading` / `isPrBodyFooterLine` helpers, so a
`Summary:` inside a fenced code block is not matched.

`preserveImplementationSummary(body, previousBody, isAutomatedEpochRun)`:

- `isAutomatedEpochRun === false` → return `body` unchanged (follow-up user prompts and the
  initial publish refresh normally).
- otherwise, if `previousBody` has a `Summary:` block **and** `body` has one, replace `body`'s
  block region with the previous block. If either is missing, return `body` unchanged (never
  inject a summary where the current body has none).

The preserved summary is written back into the body and `rememberPrBody`
(`publish-service.ts:1821`) stores it as the next `pr_body:latest`, so the implementation
summary survives an unbounded number of loop runs.

### Wiring in `composePrBody` (`publish-service.ts:1795`)

Compute `isAutomatedEpochRun` from `doDb.getPrompt(this.sql, promptId)?.reviewLoopEpochId`,
then apply `preserveImplementationSummary(composedBody, previousBody, isAutomatedEpochRun)`
before `preservePrEvidenceSections` (both read the same `previousBody`).

### Files

- `apps/control-plane-worker/src/session/pr-body.ts` — add `extractVerdictSummaryBlock` and
  exported `preserveImplementationSummary`.
- `apps/control-plane-worker/src/session/publish-service.ts` — import
  `preserveImplementationSummary`; compute `isAutomatedEpochRun` and apply it in
  `composePrBody`.

## Out of scope

- **Bridge changes.** No edits to `renderPrEvidenceCommentFromReadiness` or the bridge verdict
  rendering. The summary stays inside `## Verdict`; only its content is protected.
- **Bridge evidence comment.** The per-run PR evidence comment continues to reflect the latest
  run (diagnostic artifact, not the PR narrative).

## Testing

Unit (`tests/test_cloudflare/session/pr-body.test.ts`, pure functions):

- epoch run + previous body with a `Summary:` block → previous summary retained (#3642
  regression).
- non-epoch run → body unchanged (summary refreshed).
- epoch run with no previous `Summary:` block → unchanged.
- epoch run where current body has no `Summary:` block → unchanged (no injection).

Integration (`tests/test_cloudflare/session/pr-workflow.test.ts`, mirrors the existing
"allows scoped review-loop PR updates" harness): seed `pr_body:latest` with an implementation
`Summary:` block, drive a review-loop publish (`reviewLoopEpochId: "epoch-1"`) whose readiness
`agentFinalMessage` is a review-loop message, and assert the updated PR body keeps the
implementation summary and drops the review-loop summary.

## Risks

- The `Summary:` block is matched by the literal line `Summary:`; both render paths use the
  identical `buildVerdictSummaryBlock` shape, so the marker is stable. Code-fence false matches
  are avoided by reusing the fence-aware boundary scan.
- If a future change renames the `Summary:` label, the matcher must be updated in lockstep;
  covered by the unit tests asserting on the literal block.

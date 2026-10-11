# Follow-up: PR body describes the latest follow-up, not the whole PR (multi-prompt sessions)

Status: **diagnosed, not yet fixed.** Found during QA E2E of the section-aware PR-template
fill (`2026-06-05-section-aware-pr-template-fill-design.md`). Single-prompt PRs are correct;
this only affects PRs built across **multiple prompts** in one session.

## Symptom (live evidence)

`trycycloid/mia-copy` PR **#164**. Session `0a7e6ecf`:

- **p-1** implemented a full feature: a "Booking Opportunity Gap" dashboard metric — backend
  helper in `core`, exposed via the summary API, rendered as a KPI card in
  `DashboardMetricsPanel.tsx`, with tests. The PR body's `## Description` correctly described
  that feature.
- **p-2** (follow-up) renamed it to "Unbooked Capacity" and changed it to a percentage.
- After p-2 republished, `## Description` became:
  > "Renamed the dashboard metric from Booking Opportunity Gap to Unbooked Capacity and
  > changed its representation from a raw count to a percentage…"

The body now describes the **last delta** (the rename), not the **PR as a whole** (a new
full-stack dashboard metric). A reviewer reading the PR sees a rename, not the feature.

(Positive corollary, also from this test: the body is **not frozen** — it re-rendered on
republish. The bug is the _scope_ of the regenerated content, not staleness.)

## Root cause (code-pinpointed)

`apps/sandbox-bridge/src/services/post-execution/format.ts` — `buildPostExecutionEvidenceBundle`
populates the evidence bundle **per-turn**:

```ts
originalPrompt: extractCurrentTaskText(input.promptContent), // the CURRENT prompt (p-2), despite the name
agentFinalMessage: input.agentFinalMessage,                  // the CURRENT turn's final message (p-2)
```

The section-fill input (`buildPrTemplateFillInput`, post-execution-runner.ts) grounds the
descriptive sections on exactly these:

- `narrative` = `buildCleanNarrative(evidence)` = `evidenceBundle.agentFinalMessage` → **p-2 only**
- `taskPrompt` = `evidence.evidenceBundle?.originalPrompt` → **p-2 only**
- `diffSummary` = branch-vs-base diff → **cumulative** (the only cumulative input)

The system prompt tells the model to write Description/Implementation "grounded in the
narrative, task, and diff summary." Because the narrative explicitly says "renamed X→Y," the
model leads with the delta. The cumulative diff is present but is the weakest semantic signal
(a bounded summary), so it doesn't override the delta narrative.

**This also affects the default (non-template) body**: `buildSummarySection` →
`buildCleanNarrative` uses the same per-turn `agentFinalMessage`, so a follow-up's `## Summary`
is likewise delta-scoped. The fix should cover both paths.

## Why it isn't a trivial fix

The cumulative _semantic_ context (p-1's task + p-1's narrative) is **not in the bridge's
current-turn evidence**. The bridge only has this turn's final message; the full
prompt/message history lives in the control-plane session Durable Object. So a correct fix has
to source cumulative context from somewhere the bridge currently doesn't read.

## Fix options

- **(A) Cumulative context (recommended).** Make PR-body generation describe the whole PR:
  feed the fill (and the default `## Summary`) the session's **original task** plus a
  **cumulative narrative** (e.g. the control-plane passes session-level prompt/summary history
  to the bridge for publish, or the bridge persists the first prompt + accumulates per-turn
  final messages across the session). Most correct; touches the session→bridge boundary.
- **(B) Lean on the cumulative diff (stopgap).** Pass a richer cumulative diff and nudge the
  prompt: "describe what this PR does _as a whole_ from the diff; the agent narrative may
  cover only the latest edit — don't let it dominate." No cross-turn state, lower cost, but
  the diff is weaker semantic grounding than the original task and a richer diff costs tokens.

Recommendation: **A**. B is an acceptable interim mitigation if a quick win is wanted before A
lands.

## Scope / impact

- Multi-prompt sessions only. Single-prompt PRs (the common case) are correct — verified live
  on `mia-copy` #163.
- Affects both the templated section-fill and the default-body `## Summary`.

## Verification when fixed

Reproduce the #164 test: create a full-stack feature in one prompt, then send a follow-up that
changes a detail, and assert the republished `## Description`/`## Implementation` describe the
**whole** PR (the feature), not only the follow-up delta. Run on `mia-copy` (templated) and a
no-template repo (default `## Summary`).

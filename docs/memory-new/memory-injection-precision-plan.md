# Memory Injection Precision Plan

Date: 2026-06-19

This doc replaces the narrower Phase 2 false-positive writeup. Bootstrap is now disabled by default, so the next work is explicit recall and injection precision: return fewer memories, require stronger evidence, and make false positives diagnosable.

Artifacts from the Phase 2 live run:

- Live run: `.tmp/phase2-live-run-20260619-072313/`
- Rollup: `.tmp/phase2-live-run-20260619-072313/final-rollup.md`
- Normalized metrics: `.tmp/phase2-live-run-20260619-072313/normalized-memory-metrics.md`
- Durable usage rows: `.tmp/phase2-live-run-20260619-072313/all-memory-usage-events.json`
- Test plan context: `docs/memory-new/prod-memory-simulation-test-plan.md`

Live reruns should use the canonical browser-use Slack workflow in `docs/slack-testing.md#browser-use-live-session-runs`: post through Slack with `@Cycloid (DEV)`, launch sessions from the browser-use Slack session, then fan out subagents for result collection.

## Current State

- Bootstrap company-memory injection currently runs for production sessions with a business id.
- Explicit repo recall and company recall are exposed to sandboxes only when the control plane passes `ARCANIST_MEMORY_TOOLS_ENABLED=1`.
- The Phase 2 live run showed recall-tool precision around 45-47% and recall around 34-41%.
- Strict combined precision was much worse because bootstrap added many extras; that is less relevant while bootstrap is off.
- The remaining product risk is explicit recall returning adjacent but non-actionable memories.

## What Counts As A True Positive

A selected memory is a true positive only when the available pre-injection evidence proves it should change the agent's next action.

Required conditions:

- Scope is correct: repo, business, customer, thread, or source context matches.
- The memory is active, sourced, and not stale, superseded, contradicted, or unsupported.
- It matches a concrete task anchor: file/path, symbol, command/tool, error fingerprint, PR/session id, customer/incident, or exact subsystem phrase.
- The expected effect is actionable for this task: prevent a repeated failure, enforce a repo rule, choose the right implementation path, or avoid a known dead end.

Topical similarity is not enough. A memory can be harmless, adjacent, or interesting and still be a false positive for injection because it consumes prompt budget and trust.

## Metrics To Report

Score retrieval diagnostics separately from product impact. For live-session
evaluation, product-impact false positives are the primary decision metric.
Strict expected-ID precision remains useful for debugging retrieval, but it is
not the canonical false-positive score.

Retrieval diagnostic labels:

- `true_positive_actionable`: correct scope and expected action change.
- `false_positive_noise`: related words but no expected action change.
- `false_positive_wrong_mechanism`: same domain, wrong subsystem or action surface.
- `false_positive_wrong_scope`: wrong customer, repo, thread, or source scope.
- `false_positive_unsupported`: stale, contradicted, superseded, or weak provenance.
- `false_negative_missed`: concrete useful memory existed but was not returned.
- `true_negative_abstain`: no memory returned and no memory should have been returned.
- `ambiguous_needs_human`: compromised session or insufficient evidence.

Impact labels:

- `useful`: memory was helpful for the task or plausibly changed the next action correctly.
- `neutral`: memory was adjacent or harmless, but probably did not help.
- `bad`: memory was wrong-mechanism, wrong-scope, misleading, or likely distracting.
- `unknown`: evidence is insufficient to judge usefulness.

Report two impact false-positive rates:

- `neutral_plus_bad_fp_rate`: `(neutral + bad) / known_selected`.
- `bad_only_fp_rate`: `bad / known_selected`.

Use `known_selected = useful + neutral + bad`. Keep `unknown` rows visible, but
exclude them from the impact-rate denominators unless a reviewer later resolves
them.

Always split metrics by path:

- `repo_recall`
- `company_recall`
- `company_bootstrap` for production sessions with a business id

Do not report a combined score without path rows. When using strict expected-ID
metrics, label them as strict diagnostics and do not call the strict extra-ID
rate the product false-positive rate.

## Why False Positives Remain

### Generic Domain Terms Still Act Like Evidence

Terms such as `Linear`, `Slack`, `Datadog`, `sandbox`, `bridge`, `message`, `parser`, `original`, `prod`, and `qa` create lexical overlap but often do not prove the memory applies.

Representative wrong-mechanism examples:

- Datadog provider-runtime telemetry vs Terraform sparse-counter monitor semantics.
- Slack delivery/retry behavior vs Slack repo directive parsing.
- Review-loop prompt-source logic vs Slack thread reconstruction.
- Dogfood local env/bootstrap behavior vs GitHub CLI token-type startup auth.

### Explicit Recall Calls Are Often Underspecified

The retrieval-only replay used source identifiers from the manifest and hit 50/50 expected repo memories. Live Slack prompts rarely include those identifiers, so live behavior looked closer to prompt-only retrieval.

Live recall calls often lack:

- concrete files,
- symbols,
- exact PR numbers,
- source session ids,
- error names,
- subsystem-specific phrases.

### Company Recall Is Still Broad

Bootstrap-off does not disable `cycloid.company_memory_recall`. Explicit company recall still returns formatted memory blocks and records usage. The ranker is more permissive for explicit recall than bootstrap, so broad terms can still pull adjacent company memories unless the return gate gets stricter.

### Telemetry Can Blur Retrieval vs Injection

Empty bootstrap retrieval used to emit `memory_usage` events with no active ids. Explicit company recall also has query-time usage rows and bridge recall telemetry. Future scoring should count only non-empty returned or injected memories and dedupe by `{session_id, prompt_id, memory_id, source}`.

## Plan

### 1. Precision-First Recall Gate

Temporarily accept lower recall to reduce false positives.

For repo recall and company recall, require at least one concrete action anchor before returning a memory:

- path or file overlap,
- symbol/function/class/command overlap,
- error or stack fingerprint,
- exact PR/session/source identifier,
- customer or incident evidence,
- exact subsystem phrase beyond a generic integration name.

Reject or heavily down-rank domain-only matches. `Slack`, `Linear`, `Datadog`, `sandbox`, `bridge`, `message`, and `prod` should never be sufficient by themselves.

### 2. Wrong-Mechanism Rejection

Add a final reject step that asks whether the memory and task share the same action surface.

Examples:

- A Datadog memory about sandbox telemetry attribution should not match a Datadog Terraform monitor task.
- A Slack memory about delivery/retry should not match a Slack parser/directive task.
- A local startup/env memory should not match a GitHub CLI auth-token task unless token-type auth evidence is present.

### 3. Better Live Prompt Evidence

Improve evidence extraction before recall:

- extract likely files and symbols from Linear titles, issue text, Slack prompts, and URLs;
- extract PR numbers, session ids, ticket keys, errors, command names, and subsystem phrases;
- pass extracted anchors into recall tool calls;
- include rejected bridge-prefilter candidates in traces so misses can be diagnosed.

This is the recall-preserving counterweight to stricter gates.

### 4. Hard-Negative Regression Corpus

Create focused cases where a tempting memory must not return.

Hard-negative shape:

`task prompt + tempting-but-wrong memory => expected result: do not return it`

Initial cases:

- `Linear ticket` prompt must not recall generic resolve-comments assignee memory unless assignment handling is part of the task.
- `Slack message parser` prompt must not recall Slack delivery or retry memories.
- `Datadog monitor` prompt must not recall sandbox telemetry attribution memories.
- `GitHub local startup auth` prompt must not recall adjacent dogfood env/bootstrap memories unless token-type auth is implicated.
- Downvoted June company-bootstrap memories must not return for the prompt shapes that triggered downvotes.

These tests should protect precision while gates are tightened.

### 5. Trace And Scoring Cleanup

Persist enough evidence to explain every decision:

- raw and denoised prompt hashes,
- denoised excerpt,
- removed boilerplate sections,
- extracted files, symbols, errors, PRs, sessions, customers, incidents, and subsystem phrases,
- candidate channels,
- raw score and final score,
- selected or rejected decision,
- reject reason,
- retrieval config version,
- source age and provenance count.

Scoring should ignore empty retrieval telemetry and dedupe repeated usage rows.

## Historical Phase 2 Metrics

These numbers describe the pre-bootstrap-off live run and should not be used as the current state after the bootstrap flag change.

### All 30 Sessions

| Path        |  TP |  FP |  FN | Precision | Recall |
| ----------- | --: | --: | --: | --------: | -----: |
| Bootstrap   |   0 |  24 |  50 |      0.0% |   0.0% |
| Recall tool |  17 |  21 |  33 |     44.7% |  34.0% |
| Combined    |  17 |  45 |  33 |     27.4% |  34.0% |

### Comparable Sessions Only

| Path        |  TP |  FP |  FN | Precision | Recall |
| ----------- | --: | --: | --: | --------: | -----: |
| Bootstrap   |   0 |  21 |  37 |      0.0% |   0.0% |
| Recall tool |  15 |  17 |  22 |     46.9% |  40.5% |
| Combined    |  15 |  38 |  22 |     28.3% |  40.5% |

Broken or compromised sessions excluded in the comparable subset:

- P2-07: stream/disconnect failure.
- P2-14: `CodexStreamError`.
- P2-21: no-start.
- P2-23: nonterminal at cutoff.
- P2-27: nonterminal and prompt truncated.
- P2-28: reposted prompt still truncated.

## Representative False Positives

### Former Bootstrap Noise

| Scenario                      | Memory                                | Why It Matched                                                  |
| ----------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| P2-03/P2-04/P2-13/P2-14/P2-15 | `mf_ca55eb43b49895f4908f62e3263e5fba` | Generic `Linear` / `ticket` overlap with an assignee rule       |
| P2-24/P2-25/P2-27/P2-28/P2-29 | `mf_8fddb06749c0669cc22c46907d939ace` | Broad process terms like `original`, `Linear`, and `gh pr view` |
| P2-19                         | Slack completion/retry facts          | Shared `retry` / `Slack` terms                                  |
| P2-26                         | Slack/message/parser company facts    | Generic Slack/message/parser overlap                            |

### Explicit Recall Noise

| Scenario | Returned                        | Expected                                 | Problem                                         |
| -------- | ------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| P2-01    | verification/comment memories   | `mem_pr_5100_add_1`                      | Adjacent terms; exact stop-reason memory missed |
| P2-12    | dogfood startup/env memories    | `mem_pr_4939_add_1`                      | Adjacent startup domain, wrong mechanism        |
| P2-24    | durable/session/env memory      | `mem_pr_4856_add_1`, `mem_pr_4856_add_2` | Harmless extra while expected memories returned |
| P2-28    | unrelated Slack/thread memories | `mem_pr_4819_add_1`, `mem_pr_4819_add_2` | Compromised prompt plus weak anchors            |
| P2-30    | sandbox telemetry memory        | `mem_pr_4804_add_1`                      | Same Datadog domain, wrong monitor mechanism    |

## Next Implementation Order

1. Add hard-negative fixtures for the known wrong-mechanism and downvoted-memory cases.
2. Add trace fields for selected and rejected recall candidates.
3. Tighten explicit recall gates around concrete action anchors.
4. Add wrong-mechanism rejection.
5. Improve live prompt evidence extraction to recover recall under the stricter gates.

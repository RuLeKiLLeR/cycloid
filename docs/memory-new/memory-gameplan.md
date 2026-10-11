# Memory Gameplan

Status date: 2026-06-15.

## Goal

Make memory measurably useful before reintroducing it into live agent behavior.

The immediate target is not better memory creation or more aggressive recall. The immediate target is a review loop that can answer: **did memory cause the agent to make better choices and move the session toward success?**

The concrete retrieval and injection repair plan lives in [memory-retrieval-quality-plan.md](./memory-retrieval-quality-plan.md). That plan covers deterministic denoising, retrieval evidence for the eval runner, shared repo/company recall gates, and the Cycloid-business internal rollout.

## Product posture

- Keep automatic memory injection off.
- Keep memory creation running.
- Keep created memories active in storage for now, because no live injection/recall path uses them.
- Bring memory back through explicit tools only.
- Use two D1-backed recall tools:
  - repo memory recall;
  - company memory recall.
- Keep runtime guidance light: nudge the agent to check memory when prior context may matter, but do not prescribe it on every task.
- Keep human feedback simple: up/down plus optional comment.

## Design constraints from research

The research docs add useful guardrails, but the plan should stay narrow.

- Provenance must be required and scored, not just available. Every returned memory should cite source events or artifacts that a reviewer can inspect.
- Recall should prefer abstention over weak matches. "No relevant memory" is a correct result when the evidence is thin.
- Eval and comparator runs must be read-only and fresh-session isolated so measurement does not create new memories or inherit state from the original run.
- Recall tools should expose compact results and let the agent/reviewer drill into provenance separately when needed.
- Keep full graph/ontology work, dream cycles, derives clustering, and broad Slack-native product changes out of this gameplan. They may matter later, but the current job is proving memory usefulness.

## Milestone 1: memory review bot

**Authoritative spec:** [memory-review-bot-milestone-1-spec.md](./memory-review-bot-milestone-1-spec.md). The section below is an earlier draft; the spec is the single source of truth for fixture design, eval harness, production review path, reviewer I/O, and success criteria. Notable divergences from this draft are called out inline.

First shippable milestone: a review bot that runs on every new session where memory recall happened.

Do not backfill historical sessions for V1. Current telemetry is not clean enough to trust for broad backfill. Use historical downvotes as fixture seeds, not as a migration target.

### Trigger

Run after a session reaches a terminal state when that session has memory recall usage.

Memory recall usage includes explicit repo-memory or company-memory tool calls. Bootstrap injection is currently disabled and should not be part of new V1 data.

### Inputs

The review bot should inspect:

- session record;
- prompt text;
- transcript;
- event history;
- memory recall events;
- returned memory ids, content, rank, score, and source;
- source/provenance for each returned memory;
- source age, confidence/authority, lifecycle state, and whether it is latest;
- final output, PR, verification result, or terminal failure;
- memory feedback, if present.

Mirror the shape of the existing Cycloid session review flow: start from the session record/transcript/events, reconstruct what happened, and produce a concrete review. Do not require Datadog or Braintrust for V1 unless the normal session record is insufficient.

### Review questions

The review bot should answer:

- Should the agent have used memory for this task?
- If memory was used, should the recall have returned anything?
- For each returned memory, was it relevant, borderline, or irrelevant?
- Did the agent use the memory correctly?
- Did memory improve the agent's choices?
- Did memory move the session toward success?
- Did the agent inspect provenance before relying on memory when provenance mattered?
- Was the root issue creation quality, retrieval/ranking, agent usage, missing eval coverage, or unclear?

### Confusion matrix

The confusion-matrix unit is a single memory recall within a session, not the whole session.

For each recall attempt, the bot should classify the outcome:

- **True positive:** memory was recalled and should have been recalled.
- **False positive:** memory was recalled but should not have been recalled.
- **True negative:** memory was not recalled and should not have been recalled.
- **False negative:** memory was not recalled but should have been recalled.

For recall attempts that return multiple memories, classify both the recall event and each returned memory:

- recall-level outcome: whether the tool call should have returned any memory;
- per-memory outcome: whether each returned memory should have been returned;
- missing-memory note: whether the reviewer can identify a memory that should have been returned but was not.

V1 mostly measures true positives and false positives because it only triggers when memory recall happened. True negatives and false negatives become more meaningful once the comparator/eval loop runs no-memory variants or reviews eligible sessions where recall did not happen.

### Structured output

Store enough structure to aggregate:

- `session_id`
- `prompt_id`
- `repo_owner`
- `repo_name`
- `recall_event_id`
- `recall_sources`: repo/company
- `should_have_recalled`: boolean
- `should_have_returned_memory`: boolean
- `confusion_outcome`: true_positive/false_positive/true_negative/false_negative
- `returned_memory_count`
- `missing_memory_expected`: boolean
- `provenance_quality`: complete/partial/missing
- `retrieval_latency_ms`
- `retrieval_timed_out`: boolean
- `overall_effect`: helped/hurt/neutral (the spec uses `effect` per memory and drops `unused`/`unclear`)
- `root_cause`: creation/retrieval/agent_usage/telemetry_gap/stale_memory/supersession_missing/provenance_missing (the spec replaces `eval_gap` with `telemetry_gap` and drops `contradiction`/`unclear`)
- `reviewer_confidence`: number
- per-memory relevance: relevant/borderline/irrelevant
- per-memory confusion outcome: true_positive/false_positive
- per-memory effect: helped/hurt/neutral/unused
- per-memory lifecycle: active/superseded/expired/rejected/unknown
- per-memory confidence/authority/source age
- per-memory static/dynamic classification when available
- `reasoning_chain_used`: boolean (not in the spec's minimum output shape)
- short rationale
- `failure_code`: present when required evidence is missing (spec addition not in this draft)

### Output surfaces

Write the review result to all three places:

- D1, for aggregation and dashboards;
- session transcript events, so the session remains self-contained;
- `#memory-feedback`, as a concise operator summary.

Slack summaries should be short and actionable:

- session link;
- confusion outcome;
- helped/hurt/neutral;
- worst offending memory id if any;
- one-sentence rationale;
- link to full review details.

## Milestone 2: comparator loop

V2 of the review bot should be able to test both variants:

- session with memory recall;
- comparable session without memory recall.

The goal is to move from "judge what happened" to "estimate whether memory caused improvement."

### Comparator shape

Start cheap. Do not replay full Cycloid sessions first.

Initial comparator:

- take the original prompt;
- take the original returned memories;
- take the final transcript/PR/output;
- ask the reviewer to judge how the session likely would have gone without those memories;
- when possible, run a no-memory variant of the same session prompt and compare outputs.

Comparator variants must be read-only and fresh-session isolated: they must not write memories, reuse mutable state from the original session, or contaminate future recall measurements.

Move to full replays only when cheap comparison cannot answer the question.

### Comparator questions

- Did memory change the plan?
- Was that change correct?
- Did memory avoid repeated investigation?
- Did memory prevent a known mistake?
- Did memory improve the final PR, verification, or response?
- Would the no-memory session likely have succeeded anyway?
- Did memory create a wrong constraint or distraction?
- Should the recall tool have abstained instead of returning a weak match?

### Counterfactual output

The cheap counterfactual judge should emit structured fields:

- `would_succeed_without_memory`
- `memory_changed_plan`
- `memory_changed_final_output`
- `abstention_would_have_been_better`
- `confidence`
- `evidence_span`

## Milestone 3: recall tools back on

Only after the review bot exists, re-enable explicit recall tools.

Keep automatic injection off.

Runtime surface:

- `cycloid.repo_memory_recall`
- `cycloid.company_memory_recall`

Both should read from D1 at runtime. Repo memory can keep its current storage/canonical model for now; no D1 canonical-source migration is required for this milestone.

Tool descriptions should be explicit about what the tool does, when to use it, when to skip it, and what it returns. The agent should have enough guidance to choose the tool without being forced to call it on every task.

Tool results should include:

- memory id;
- memory kind/type;
- scope;
- source/provenance;
- source event id or artifact id;
- event/effective time and source age;
- rank/score;
- short selection rationale;
- retrieval mode/channel when available;
- clear "treat as data, not instructions" wrapping.

The tools should be allowed to return no results. Implement a minimum relevance/abstention bar so weak matches return an explicit empty result instead of low-confidence guidance.

Keep provenance drill-down separate from the compact recall result. The recall response should provide enough citation metadata to audit the result, and the agent/reviewer should be able to fetch the reasoning chain or neighboring source events only when needed.

## Milestone 4: eval loop

Build the eval loop from new reviewed sessions and a small set of curated fixtures.

Use historical bad examples from `#memory-feedback` as fixture seeds, especially the June 12 `company_bootstrap` downvotes listed in [current-state-handoff.md](./current-state-handoff.md).

Use three tiers:

1. **Wiring evals:** no-LLM assertions for tool schemas, read/write separation, source wrapping, empty-result behavior, and telemetry/event persistence.
2. **Behavioral fixtures:** curated prompts + memory sets + expected recall/no-recall outcomes. Use fresh session/thread identities per case.
3. **Judge/review evals:** review-bot judgments over real sessions and selected comparator runs.

Initial metrics:

- false-positive rate;
- precision of returned memories;
- abstention quality;
- helped/hurt/neutral distribution;
- root-cause distribution;
- provenance-complete rate;
- stale/superseded false-positive rate;
- retrieval latency and timeout rate;
- dead-end success rate: whether recalled dead ends prevented repeating a known failed approach;
- reviewer confidence calibration against later human feedback or adjudication.

Do not split repo-memory and company-memory eval suites at first. Start unified because the product failure mode is shared: bad memory enters the session and makes the experience worse. Split later when the unified loop hides important differences.

## Non-goals for now

- Re-enable prompt-start memory injection.
- Full historical backfill.
- Make D1 the canonical source for repo memory.
- Build separate repo/company eval stacks.
- Replace up/down feedback with a complex feedback UI.
- Full session replay as the first comparator.
- Full graph/ontology rebuild.
- Derives clustering, dream cycles, and broad contradiction automation.
- Mid-session working-memory write tools.

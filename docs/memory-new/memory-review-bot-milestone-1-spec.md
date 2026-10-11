# Memory Review Bot Milestone 1

**Date:** 2026-06-15
**Status:** Draft spec
**Author:** Codex

## Problem

We need empirical answers to two questions:

1. How useful are generated memories?
2. How good are we at surfacing useful memories to Cycloid?

The immediate quality issue is false positives: memories surfaced into a task
where they do not apply, sometimes making Cycloid's output worse. Milestone 1
builds a review bot that labels observed memory usage so we can measure this
instead of debating anecdotes.

Braintrust is used for fixture evals of the review bot. Production review state
stays in D1, session events, and `#memory-feedback`; production reviews do not
invoke or mirror into Braintrust.

## Data Findings

Read-only production analysis on 2026-06-15 used D1
`cycloid-control-plane-production` and Slack `#memory-feedback`.

- Bootstrap noise: `company_bootstrap` returned 3,235 memories across 610
  prompts. Bootstrap feedback had 25 downvotes across five sessions and one
  upvote. This is sparse and selection-biased, but useful for fixture discovery.
- Mechanical task false positives: session
  `8ed59b14-b0e3-427e-a3c4-e4fcc2b36086` asked to create a file with exact
  content, but received unrelated review-loop/webhook/pagination/Linear
  memories. Downvoted IDs:
  `mf_3820dd2880239f1e6dd5861bba6fcbacd6b91cdb09ee45a1b682a4b1d652e621`,
  `mf_38e5198526a96e9de1df76e997ce474bea6a38f38999eb8dee91bc52fc95790a`,
  `mf_9377e1d01007bdffb6673e98cb387b01a87de3af8c05902715bba0caf8f4904c`,
  `mf_8fddb06749c0669cc22c46907d939aced454b54105f794251b29e0493fdd2bce`.
  Fixture: `mechanical-file-create-abstains`. Slack:
  `https://trycycloid.slack.com/archives/C0B9G5TCATB/p1781279778777159`.
- Linear webhook false positives: session
  `e73b8b4a-7b02-455e-a83b-7002a159f21a` investigated dropped Linear webhook
  triggers but received Slack session/completion memories at ranks 3 and 4:
  `mf_b77d63ceb513cf537f1125e1c133bdbaea9068c46db1e98617496579c913c838`,
  `mf_5ed511772dcf55102973b7644d09a7814c9e6496514360d5e90e652dc3385c4c`.
  Fixture: `linear-webhook-excludes-slack-delivery`. Slack:
  `https://trycycloid.slack.com/archives/C0B9G5TCATB/p1781294378786489`.
- Narrow edit false positives: a 2026-06-14 "Add emoji to readme heading" task
  received credential/OpenAI key/sandbox/shell-parser memories. Fixture:
  `narrow-readme-edit-abstains`. Slack:
  `https://trycycloid.slack.com/archives/C0B9G5TCATB/p1781457795886129`.
- Stale positive feedback: the one positive bootstrap example found,
  `mf_5389b4a2d425918bd989e40e2371f4d88a1111bc0b5c6b27ca3b96d90bc5ad61`,
  is now `superseded`. Fixture: `superseded-memory-filtered`.
- True positives must be represented too. Initial production-derived candidates:
  `eed9c694-80b5-4ca1-836f-a48bb863b538` recalled `mem-28b3e956`
  (rank 1, score 0.98) and `mem-2e609b5a` (rank 2, score 0.86) for
  targeted SessionDO max-duration observability / PR #3358; session
  `ee623af9-ff2a-427b-8f41-e02100b2ecb2` recalled `mem-9c504116`
  (rank 1, score 0.97), `mem-28b3e956` (rank 2, score 0.85), and
  `mem-2e609b5a` (rank 3, score 0.74) for webhook archival projection
  consistency / PR #3304; session `010e77ad-e53c-4d34-96df-2cb8f48950ba`
  recalled `mem-adf8f2ce` (rank 1, score 0.96) for prompt-upload SQL payload
  validation / PR #3289. Candidate fixtures:
  `sessiondo-max-duration-observability-true-positive`,
  `webhook-archival-projection-true-positive`, and
  `prompt-upload-sql-validation-true-positive`. Curate these into TP fixtures
  only after transcript or output evidence shows Cycloid used the memory
  correctly. Do not reuse superseded-memory IDs as true positives unless a
  fixture explicitly models the historical pre-supersession state.
- Generation confidence is not calibrated: all 42 persisted repo-memory
  generation judgments were `store` decisions with average confidence around
  0.948 and no rejection examples.

## Build

### 1. Fixture corpus first

Create checked-in fixtures before writing the production reviewer. Each fixture
contains:

- prompt/task summary;
- returned memory IDs, source, rank, score, lifecycle, scope, and bounded
  content excerpt;
- evidence snippets from D1/session/Slack with stable evidence IDs;
- expected review labels.

Required labels:

- recall confusion outcome: `true_positive`, `false_positive`,
  `true_negative`, `false_negative`;
- per-memory relevance: `relevant`, `borderline`, `irrelevant`;
- usefulness: `useful`, `not_useful`;
- effect: `helped`, `hurt`, `neutral`;
- root cause: `creation`, `retrieval`, `agent_usage`, `stale_memory`,
  `provenance_missing`, `supersession_missing`, `telemetry_gap`.

Use `neutral` when a memory was surfaced and the task succeeded, but there is
no evidence that the memory helped or hurt the output. Missing prompt,
transcript, output, memory, or usage evidence is not a neutral review; fail the
review with an observable error code and do not write partial result rows.

The first fixture set must include both production-derived false positives and
production-derived true positives. Add synthetic controls only for labels that
production data does not yet cover cleanly: true negatives, false negatives,
and ignored memories.

Split curated fixtures into two sets:

- `tuning`: checked in and visible to the agent while iterating on the reviewer
  prompt/model;
- `verify`: hidden from the agent's context and used only as the acceptance gate.

Keep true positives, false positives, and false-positive-hurt cases represented
in both sets when enough production-derived cases exist. The verify set must not
be printed, pasted into prompts, committed to the branch, or included in
Braintrust/local run output beyond aggregate score, failed scorer names, and
fixture IDs. Store it as a private Braintrust dataset or CI-only fixture source
that the development agent cannot read during the tuning loop.

### 2. Review-bot evals

Use Braintrust when configured and a local deterministic runner otherwise.
Both runners load the same fixture schema. The shape mirrors Braintrust's
data/task/scores model: fixture = data, reviewer prompt/model = task,
deterministic scorer functions = scores. It also borrows Scout's split between
cheap structural checks and behavior checks.

Fixture execution:

1. Load fixture JSON and validate required prompt, returned-memory, expected
   label, and evidence fields.
2. Build the same reviewer input shape production will build, using only the
   fixture's bounded prompt, returned memories, output/transcript snippets, and
   evidence IDs.
3. Run the reviewer prompt/model and parse strict structured output.
4. Run deterministic scorers in code. Do not use a second LLM to grade the
   reviewer in V1; the reviewer LLM is the behavior under test.
5. For tuning, emit one report row per fixture with expected labels, actual
   labels, failed scorers, reviewer prompt version, model, confidence, token
   usage, and cost. For hidden verify, emit only the opaque gate output.

The local runner used during model iteration is not part of the supported
production workflow.

Scorers are split by job:

| Scorer                      | Used for                                                                                                                                          | Why                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `schema_valid`              | Hard validity gate on every fixture. Checks parseability, allowed enum values, one judgment for every returned memory, and no unknown memory IDs. | Prevents partial or fabricated reviewer output from being counted as a quality judgment.                  |
| `evidence_valid`            | Hard validity gate on every fixture. Checks that every non-neutral judgment cites real fixture evidence IDs.                                      | Forces the reviewer to ground labels in transcript/output/memory evidence instead of plausible guesses.   |
| `confusion_exact`           | Primary fixture-level pass/fail label: `true_positive`, `false_positive`, `true_negative`, or `false_negative`.                                   | Builds the confusion matrix we need to track useful vs harmful memory behavior.                           |
| `item_labels_exact`         | Per-memory relevance/usefulness/effect labels when a fixture has multiple returned memories.                                                      | Prevents a correct fixture-level label from hiding that the reviewer credited or blamed the wrong memory. |
| `false_positive_hurt_exact` | Release-blocking check for false positives that made output worse.                                                                                | This is the main risk to monitor: injected memories that degrade Cycloid's answer.                        |
| `root_cause_exact`          | Diagnostic label for why the case failed, e.g. stale memory, overbroad memory, misapplication, ignored useful memory, or missing evidence.        | Turns failures into actionable buckets for prompt, generation, lifecycle, or review-bot fixes.            |
| `lifecycle_exact`           | Diagnostic label for active vs superseded/expired/rejected memory state when the fixture includes lifecycle evidence.                             | Separates bad agent judgment from bad memory hygiene.                                                     |

Confusion labels mean:

- `true_positive`: surfaced memory was relevant, used correctly, and improved or
  materially guided the output.
- `false_positive`: surfaced memory was irrelevant, stale, overbroad, or
  misapplied; `effect = hurt` marks the severe subtype where output got worse.
- `true_negative`: no surfaced memory should be credited as useful, and the
  reviewer correctly does not claim memory helped.
- `false_negative`: fixture evidence shows a memory should have mattered, but
  the reviewer/system misses that value or marks it neutral/not useful.

Gate:

- `schema_valid` and `evidence_valid` must pass for every fixture.
- All production-derived true-positive and false-positive fixtures must pass
  `confusion_exact`.
- All false-positive-hurt fixtures must pass `false_positive_hurt_exact`.
- Prompt/model changes fail if any production-derived tuning or hidden verify
  fixture regresses.
- Synthetic fixtures are allowed only to fill label gaps; they cannot be the
  only passing evidence for true-positive or false-positive behavior.
- Any scorer failure writes a machine-readable reason, e.g.
  `missing_memory_result`, `invalid_enum`, `fabricated_evidence_id`,
  `confusion_mismatch`, `effect_mismatch`, or `root_cause_mismatch`.

Braintrust payloads are bounded to fixture IDs, evidence IDs, expected/actual
labels, prompt version, model, confidence, scorer output, token usage, and
cost. Do not send full raw transcripts. Hidden verify runs may store expected
labels inside the private runner/dataset, but must not return expected labels or
raw fixture evidence to the development agent.

Autoresearch-style iteration is allowed for reviewer prompt/model tuning:

- editable: reviewer prompt, model choice, output schema wording, and bounded
  post-processing repair logic;
- fixed during the loop: fixture labels, scorer code, scorer thresholds, fixture
  loader, verify dataset, and production persistence code;
- loop: propose one reviewer change, run the tuning fixtures, keep the change
  only if the score improves without validity failures, log the experiment, and
  revert otherwise;
- final gate: run hidden verify through CI or a human-triggered private runner
  that withholds raw verify fixtures and expected labels from the agent context.

### 3. Production review path

Review only completed prompts with prompt-linked explicit recall:

- eligible: completed prompt with `memory_usage_events` rows for
  `(session_id, prompt_id)` and source `recall` or prompt-linked
  `company_recall`;
- excluded from production eligibility: failed prompts, `prompt_start`,
  `company_bootstrap`, and current synthetic
  `prompt_id='company-memory-recall'` rows;
- historical bootstrap rows still seed fixtures and generated-memory recall
  counts.

Reuse existing `memory_usage_events`; do not add a new recall-attempt ledger for
Milestone 1.

Persist production output in D1:

- `memory_review_jobs`: idempotent queue state keyed by session and prompt;
- `memory_review_runs`: reviewer model, prompt version, input snapshot, overall
  outcome, confidence, rationale, evidence;
- `memory_review_recall_results`: source-level confusion/effect/provenance;
- `memory_review_item_results`: per-memory relevance, usefulness, effect,
  lifecycle, root cause evidence.

After D1 persistence, append `memory_review_completed` to the session and post
a concise summary to `#memory-feedback`.

### 4. Reviewer input and output

The reviewer model is an evidence-bound auditor, not a second retrieval system.
It judges whether the memories already surfaced to Cycloid were useful for the
completed prompt. It must not search for extra memories, infer tenant context,
or reward a memory without transcript/output evidence that it influenced or
should have influenced the answer.

Reviewer prompt contract:

- role: classify observed memory usage quality for one completed prompt;
- inputs: task summary, bounded transcript/output snippets, returned memories,
  recall metadata, lifecycle/provenance/scope, and feedback available at review
  time;
- decisions: per-memory relevance, usefulness, effect, lifecycle state, root
  cause, and evidence IDs; plus one prompt-level confusion outcome;
- abstention: when required evidence is missing, return a stable failure code
  instead of guessing `neutral`;
- versioning: prompt version, model name, structured-output schema version,
  confidence, token usage, and cost are recorded on every run.

The implementation should run the reviewer with deterministic settings where
the provider supports them and strict structured output. Prompt/model changes
must pass the fixture gate before production enqueue is enabled.

The reviewer reconstructs input from durable product data:

- session/prompt records and transcript;
- existing usage events;
- memory records, lifecycle, scope, and provenance;
- publish/PR/verification state;
- memory feedback available at review time.

Every read is scoped by `business_id`. Out-of-scope memory references are
reported as scope defects without enriching from another tenant.

The reviewer returns strict structured output. Every substantive judgment must
cite evidence IDs. One bounded structured-output repair is allowed; invalid
output after repair fails the job without partial writes.

Minimum output shape:

- `prompt_outcome`: `true_positive`, `false_positive`, `true_negative`, or
  `false_negative`;
- `confidence`: reviewer confidence for the prompt-level outcome;
- `summary`: concise evidence-grounded explanation;
- `memory_results[]`: one row per returned memory with `memory_id`,
  `relevance`, `usefulness`, `effect`, `lifecycle_state`, `root_causes`,
  `evidence_ids`, and short rationale;
- `failure_code`: present only when required evidence is missing or output
  validation cannot be repaired.

## Implementation Plan

1. **Fixtures**
   - Define fixture schema, evidence bounds, and secret checks.
   - Add production-derived false-positive fixtures from the failures above.
   - Add production-derived true-positive fixtures where memory clearly helped
     or correctly guided Cycloid.
   - Add synthetic controls for true-negative, false-negative, and
     ignored-memory cases.
   - Split curated cases into visible tuning and hidden verify sets, preserving
     true-positive, false-positive, and false-positive-hurt coverage in both.

2. **Eval harness**
   - Implement shared fixture loader with schema, evidence-ID, memory-ID, and
     redaction validation.
   - Implement the reviewer runner that builds production-shaped reviewer input
     from each fixture and captures strict structured output.
   - Implement deterministic scorers: schema/evidence validity, confusion
     exact match, per-memory label match, false-positive-hurt, root cause, and
     lifecycle recognition.
   - Add scorer unit tests with tiny hand-written expected/actual outputs for
     every mismatch class, so a broken scorer fails before running the reviewer.
   - Add local runner plus Braintrust runner that emit the same report shape.
   - Add `tuning` and `verify` modes. `verify` requires private fixture access
     and emits only aggregate scores, failed scorer names, and fixture IDs.
   - Make the scorer gate block reviewer prompt/model changes when required
     production-derived tuning or verify fixtures fail.

3. **Generated-memory cohorts**
   - Normalize generated memories across `repo_memories`, `memory_facts`, and
     `memory_takes`.
   - Join to existing explicit-recall `memory_usage_events`.
   - Report generated total, active total, observed recalled,
     never-observed-recalled, reviewed useful, reviewed not useful,
     false-positive, and false-positive-hurt.
   - Add report-level `coverage_status` (`complete`, `partial`, `unknown`) and
     `coverage_notes` describing disabled recall/injection periods or missing
     prompt-linked telemetry. Do not assign per-memory exposure labels in V1;
     roll those caveats into the report-level coverage fields.

4. **Production review service**
   - Add D1 tables, indexes, DAOs, queue producer/consumer, and stale-job retry.
   - Enqueue one job per eligible completed `(session_id, prompt_id)`.
   - Reconstruct review input, run reviewer, validate evidence, persist results.
   - Fail reviews with observable error codes when required evidence is missing.

5. **Delivery**
   - Append compact session event.
   - Add read-only admin detail route.
   - Post one concise Slack summary per completed review.
   - Log job lifecycle, review latency, model cost, classifications, root
     causes, and delivery state.

## Success Criteria

Fixture/eval success:

- The runner executes all checked-in tuning fixtures locally without Braintrust.
- Braintrust runs the same tuning fixture set when configured.
- Hidden verify fixtures are not checked in, not loaded into the development
  agent's context, and are accessible only through private CI/Braintrust runner
  configuration.
- Scorers are deterministic code, not LLM judgments.
- Tuning fixture reports include expected labels, actual labels, failed scorers,
  prompt version, model, confidence, and evidence references.
- Hidden verify reports expose only aggregate score, pass/fail, failed scorer
  names, and fixture IDs; they do not expose expected labels or raw evidence.
- Production-derived true-positive and false-positive fixtures match expected
  confusion outcomes on both tuning and hidden verify before production enqueue
  is enabled.
- False-positive-hurt fixtures match expected hurt labels before production
  enqueue is enabled.
- Any fabricated evidence ID, missing returned-memory judgment, or invalid enum
  fails the fixture run.
- Reviewer prompt/model changes cannot merge if tuning or hidden verify fixture
  labels regress.

Production success:

- Each eligible completed prompt creates at most one review job.
- Failed, bootstrap-only, prompt-start-only, and synthetic company-recall
  prompt-ID cases do not enqueue production reviews.
- Completed reviews are visible in D1, session events, admin detail, and
  `#memory-feedback`.
- Missing required evidence fails the review with a stable error code visible
  in logs and review job state.
- Slack/session delivery failures retry independently without duplicating the
  completed review.

Measurement success:

- Daily cohort report includes `never_observed_recalled_rate`,
  `recalled_not_useful_rate`, false-positive rate,
  false-positive-hurt rate, root-cause distribution, and lifecycle/scope
  failures.
- Daily cohort report includes `coverage_status` and `coverage_notes` instead
  of trying to classify exposure per memory. `never_observed_recalled_rate` is
  interpreted alongside those coverage fields.
- The primary alerting surface is false-positive-hurt rate.

## Source Notes

- `docs/memory-new/current-state-handoff.md`: separate memory generation from
  injection/surfacing; use Slack feedback as fixture seed data.
- `docs/memory-new/memory-gameplan.md`: Milestone 1 is a review bot with
  D1/session/Slack outputs and no historical backfill.
- `docs/bridge.md`: prompt-start injection is not the production recall surface
  for this milestone.
- `docs/slack.md`: Slack output must use installed workspace/token paths and
  fail closed when identity/install state is missing.
- `docs/memory-new/honcho-learnings.md`,
  `docs/memory-new/scout-learnings.md`,
  `docs/memory-new/gbrain-learnings.md`, and
  `docs/memory-new/supermemory-learnings.md`: fixture evals, fresh eval
  identities, provenance, lifecycle awareness, and prompt-injection-safe memory
  wrapping.
- `docs/memory-new/scout-learnings.md`: eval harness inspiration from wiring
  checks, behavioral cases, and judged cases as separate tiers.
- [Braintrust evaluation docs](https://www.braintrust.dev/docs/evaluation-quickstart)
  and [scorer docs](https://www.braintrust.dev/docs/evaluate/write-scorers):
  evals are data + task + scores, and scorers/classifiers measure expected vs
  actual outputs.
- [Braintrust dataset docs](https://www.braintrust.dev/docs/annotate/datasets):
  fixtures should be versioned records with input, expected output, metadata,
  and tags.
- [OpenAI grader docs](https://developers.openai.com/api/docs/guides/graders):
  graders compare reference answers to generated answers; V1 intentionally uses
  deterministic code scorers for reviewer-output grading rather than a second
  model grader.
- [Karpathy autoresearch](https://github.com/karpathy/autoresearch): use the
  agentic loop pattern only where the metric is fixed and the agent cannot edit
  the evaluator.
- [Cerebras autoresearch writeup](https://www.cerebras.ai/blog/how-to-stop-your-autoresearch-loop-from-cheating):
  strict scope, isolated runs, and validation checkpoints are required to avoid
  drift or evaluator gaming.

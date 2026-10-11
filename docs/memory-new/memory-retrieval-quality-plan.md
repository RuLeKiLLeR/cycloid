# Memory Retrieval Quality Plan

Status date: 2026-06-17.

Companion to [memory-gameplan.md](./memory-gameplan.md). The gameplan defines the review loop. This plan turns the retrieval failures into implementation rules so memory can become concise, powerful, and low-noise.

## Goal

Bring memory back only when retrieval is precise, measurable, and explainable.

The product bar is simple:

- Tasks without good memories should not use memory.
- Returned memories should be useful for the exact task.
- We should be able to trace how and why each memory was chosen.
- We should be able to measure whether memory helped, hurt, or was unused.

Assumption for this plan: memory generation is good enough to test retrieval. If evals show creation quality is the root cause, that becomes a separate lane.

## Failure Modes To Fix

### 1. Boilerplate pollutes similarity

Launch surfaces prepend recurring text: Slack context, Linear issue wrappers, GitHub/review-loop metadata, agent instructions, attachment notices, and prior injected context. Current retrieval paths often use raw prompt text, so common prefixes or generic platform terms can dominate retrieval.

Concrete failures:

- Repo prompt-start ranking passes the raw prompt prefix into `rankMemoriesForTask`.
- Repo task-shift detection compares the first prompt characters, which are often boilerplate.
- Company bootstrap retrieval passes raw `promptText` into broad FTS.

### 2. Ranking is too eager

The current shape is roughly "rank active memories, take top K." That is unsafe for memory because every injected memory looks important to the agent.

Concrete failures:

- Repo memory uses LLM-only ranking over a broad active pool.
- Repo recall accepts borderline scores.
- Company memory uses OR-based FTS, confidence, recency, and graph scoring, then slices top K with no final applicability decision.
- Scope filters prevent cross-tenant/cross-repo leakage but do not stop in-scope topical junk.

### 3. Retrieval evidence is too thin

Current telemetry records selected/returned memories, but not enough about the rejected candidates and scoring path. That makes false positives hard to debug and false negatives hard to detect.

The new eval runner should become the source of truth for measuring fixes. Retrieval needs to produce the artifacts that runner needs: normalized input, candidate set, selected/rejected decisions, rationales, and outcome labels.

## Release Shape

This is not meant to add product ceremony. The rollout is:

1. Test locally against the eval runner and fixture cases.
2. Enable only for the Cycloid business ID.
3. Watch retrieval traces, eval results, and internal feedback.
4. Remove the business gate when internal sessions show low false positives and useful true positives.

Automatic bootstrap injection and explicit tools should use the same retrieval core. They are separated in rollout only because bootstrap has higher blast radius: it affects the prompt before the agent has chosen to ask for memory. Explicit tools are easier to observe first because every result is tied to a concrete recall request.

## Retrieval Contract

Every memory read path should use the same high-level contract:

1. Denoise the task input.
2. Build a candidate pool from structured retrieval signals.
3. Rerank the narrowed candidate set.
4. Decide whether each candidate is materially useful for this exact task.
5. Return compact, cited results or an explicit empty result.
6. Persist retrieval evidence for the eval runner.

Top-K without a final "should this be returned?" decision is not allowed for model-facing memory.

## Deterministic Denoising

Create one shared denoising helper used by repo memory, company memory, bootstrap injection, explicit tools, and evals.

Suggested module:

- `shared/memory/task-denoising.ts`

This helper should be as deterministic as possible. The injected text is defined in code, so denoising should import or share those same constants/builders instead of copying strings into a second parser. If a prompt section is created by Cycloid code, the removal rule should be derived from the same source of truth that created it.

Inputs:

- raw prompt text;
- launch source when available: Slack, Linear, GitHub, UI, API, review loop;
- attached file paths;
- current repo owner/name;
- callback context.

Output:

- `denoisedTaskText`;
- `removedSections`: short labels such as `slack_wrapper`, `linear_metadata`, `agent_instruction`, `memory_context`, `attachment_notice`;
- `taskFingerprint`;
- structured signals extracted by existing parsers or exact metadata: repo, customer, ticket keys, PR numbers, Slack thread refs, file paths, symbols, provider names.

Rules:

- Strip existing `<cycloid:company_memory>` and repo memory sections before retrieval.
- Strip standard Slack/Linear/GitHub wrapper text using the same code-owned templates or section markers that generated them.
- Strip default agent behavioral guidance and repeated session scaffolding using code-owned section names or markers.
- Preserve user-authored task text, quoted error messages, file paths, identifiers, ticket keys, and explicit constraints.
- Avoid ad hoc regex classification of task meaning. Regex is acceptable for exact syntax already defined elsewhere, such as ticket keys, PR URLs, Slack permalinks, XML-like Cycloid tags, or file paths.
- Keep raw prompt in the existing session record; retrieval traces should store hashes and denoised excerpts, not duplicate full sensitive text.

Use the denoised task for:

- repo prompt-start ranking if that path is ever re-enabled;
- repo recall;
- company recall;
- task-shift detection;
- eval fixture input.

Normalization does not decide whether to return memory. It only removes known noise and exposes structured metadata. The return/no-return decision belongs to retrieval and reranking.

## Repo Memory Retrieval

Repo memory is for codebase rules, gotchas, procedures, and enforcement. It should not behave like a generic semantic search over all active memories.

### Candidate generation

Generate candidates from structured channels:

- `path_match`: `applies_to` intersects attached files, touched files, mentioned files, or directory prefixes.
- `symbol_match`: task metadata or existing code parsers identify symbols referenced by a memory.
- `tool_trigger_match`: memory trigger matches a requested tool, command, or MCP tool.
- `domain_match`: task source or repo metadata maps to a memory engineering domain.
- `text_retrieval`: the retrieval index finds a candidate from denoised user-authored task text.
- `recent_positive`: memory had recent helpful feedback and at least one other match channel.

Do not send the full active memory pool to an LLM unless the repo has fewer than a small candidate cap and evals prove this is safe.

### Hard filters

Exclude before reranking:

- `status != active`;
- superseded/rejected memories;
- memories with known incorrect feedback unless a strong path/tool trigger exists;
- memories whose `applies_to` conflicts with the task's files when the memory is file-scoped;
- generic strategic memories for concrete edit requests unless the task asks for architecture/planning.

### Rerank decision

The reranker should see only candidates with retrieval evidence. Its output must include:

- `score`;
- `decision`: `return` or `reject`;
- `match_channels`;
- `why_this_changes_next_action`;
- `false_positive_risk`;
- `needed_provenance`.

Final acceptance should be controlled by eval-tuned config, not a hardcoded magic number. The threshold and any channel-specific floors should live in a versioned retrieval config so eval runs can compare variants.

Acceptance requires:

- score above the active eval-selected threshold;
- at least one strong structured channel, or a rationale that names a concrete file/subsystem/tool/risk from the task;
- no known stale/incorrect/superseded conflict;
- concise expected effect.

For `warn` or `block` enforcement memories, do not use scoring floors to inject weak matches. Enforcement should run through hook/diff enforcement paths where trigger conditions are concrete.

## Company Memory Retrieval

Company memory is for sourced decisions, customer constraints, dead ends, preferences, and prior commitments. It must be scoped and cited.

### Candidate generation

Use multiple channels, then fuse:

- FTS or other retrieval index over active facts/takes using denoised user-authored task text.
- Entity graph traversal from customer/repo/channel/thread/service/person anchors supplied by metadata or existing parsers.
- Exact source-scope matches from Slack team/channel/thread, repo, customer, and time window.
- File/repo hints from recall input when available.
- Historical helpful feedback only as a boost after another match channel.

### Index query changes

The current OR query is too permissive. Replace broad OR-only behavior with a safer retrieval query builder, but do not build a semantic classifier out of regexes.

Rules:

- Use exact structured metadata where available: customer slug, repo name, ticket key, PR number, file path, incident id, service name, Slack thread.
- Use the retrieval index for denoised task text instead of hand-authored regex meaning extraction.
- Keep stopword/domain-boilerplate handling in the shared denoising layer, derived from known Cycloid prompt sections where possible.
- Record the final query/index request in retrieval traces.

Any heuristic that affects selection must be justified by eval performance. If the eval runner does not show an improvement in false positives or true positives, remove the heuristic.

### Score decision

Do not let confidence or HITL approval turn a weak match into a returned memory. Confidence means "this claim is likely true"; it does not mean "this claim is relevant to this task."

Final acceptance requires:

- explicit business scope;
- provenance attached;
- active lifecycle state;
- score above the active eval-selected threshold;
- match explanation tied to current task;
- source not contradicted/superseded by newer memory.

Bootstrap and explicit recall should share scoring. Bootstrap may use stricter configured thresholds because it has higher blast radius, but those thresholds should be eval-selected and versioned.

### Output shape

Recall output should be compact:

- memory id;
- kind/type;
- claim summary;
- scope;
- source URI or artifact id;
- source age;
- confidence/authority;
- retrieval mode and score;
- one-line selection rationale.

Do not inject long source text by default. Use `company_memory_reasoning_chain` for drill-down.

## Explicit Tools And Bootstrap

Runtime tools:

- `cycloid.repo_memory_recall`
- `cycloid.company_memory_recall`
- `cycloid.company_memory_reasoning_chain`

Bootstrap injection and explicit tools should call the same retrieval core. The difference is when memory enters the prompt:

- explicit tools: the agent asks for memory during a task, so the request has an intent and is easier to review;
- bootstrap: memory enters before the agent acts, so a false positive starts the session on the wrong footing.

That is why rollout should start with explicit tools even though the implementation should avoid building two separate retrieval systems.

Both recall tools should return one of:

- compact cited memories; or
- an explicit empty result: `No relevant memory found for this task.`

An empty result should produce telemetry and count as a valid eval outcome.

## Retrieval Evidence For Evals

Persist enough data for the eval runner to replay and judge each retrieval decision. Align the schema with the eval runner rather than creating a parallel reporting format.

Minimum retrieval record:

- `id`
- `session_id`
- `prompt_id`
- `source`: repo/company/bootstrap/tool
- `raw_prompt_hash`
- `denoised_prompt_hash`
- `denoised_task_excerpt`
- `removed_sections_json`
- `structured_signals_json`
- `scope_json`
- `candidate_count`
- `selected_count`
- `returned_empty`: boolean
- `retrieval_config_version`
- `latency_ms`
- `timed_out`

Per-candidate evidence:

- `memory_id`
- `memory_source`: repo/company
- `candidate_channels_json`
- `raw_scores_json`
- `final_score`
- `decision`: selected/rejected
- `reject_reason`
- `selection_rationale`
- `lifecycle_state`
- `confidence`
- `authority`
- `source_age_ms`
- `provenance_count`

Keep retention bounded. These records are eval artifacts, not a new user-facing memory store.

## Eval Runner Integration

Do not build a separate eval system if the new eval runner already covers this shape. Extend or configure that runner so memory retrieval cases can assert:

- tasks with no good memory return no memory;
- tasks with good memory return the expected memory;
- returned memories are useful for the exact task;
- false positives are visible at recall-level and per-memory level;
- retrieval traces explain selected and rejected candidates;
- bootstrap and explicit recall can be compared under different retrieval config versions.

Fixture shape should include:

- raw task text with launch boilerplate;
- expected denoised task text or denoising assertions;
- repo/company scope;
- candidate memories;
- expected selected ids;
- expected rejected ids;
- whether an empty result is expected;
- rationale labels.

### User-Realistic Retrieval Eval Scenarios

The first eval batch should be scenario-style, not sentinel-style. Each case should use a realistic launch surface, a realistic memory corpus, and assertions over both the user-visible result and the retrieval trace. Use fresh session/thread ids per case so prior eval history cannot leak.

Each case should run in two modes when feasible:

- **bootstrap mode:** company memory is eligible for pre-prompt injection;
- **explicit recall mode:** the agent calls repo/company memory from a concrete intent and file list.

For each case, assert:

- selected memory ids exactly match expectation, unless the case is judged and allows equivalent ids;
- rejected high-risk distractors have concrete reject reasons;
- trace includes denoised input, scope, candidate count, selected count, empty flag, and retrieval config version;
- the final agent output either uses the memory correctly or explicitly proceeds without memory;
- no memory is returned from generic launch boilerplate, sentinel/eval wrapper text, or common platform prefixes alone.

#### 1. Slack bug report with repeated workspace boilerplate

Task:

- Slack-originated prompt with channel/thread metadata, default Slack launch text, requester identity, and one real user sentence: "Checkout is failing after coupon apply; inspect `apps/api/src/checkout/coupons.ts` and fix the 500."

Memories:

- useful repo memory: coupon code path requires normalizing merchant ids before lookup; applies to `apps/api/src/checkout/**`;
- useful company memory: Acme checkout rollout is blocked by coupon failures this week;
- distractor company memory: default Slack onboarding text and channel usage norms;
- distractor repo memory: payment webhooks require idempotency keys; applies to `apps/api/src/webhooks/**`.

Expected:

- select coupon repo memory and Acme checkout company memory;
- reject Slack boilerplate memory and webhook memory;
- denoised task should preserve the checkout/coupon sentence and file path, and strip Slack wrapper text.

#### 2. Linear ticket with generic team instructions

Task:

- Linear-originated prompt with default Linear issue context, team project instructions, acceptance criteria, and task: "ARC-1245: add retry telemetry to the Notion OAuth callback."

Memories:

- useful repo memory: Notion OAuth callback errors must fail closed and avoid logging tokens; applies to Notion integration routes;
- distractor repo memory: all OAuth integrations use `state` validation, too generic unless callback file is in scope;
- distractor company memory: Linear triage instructions are prepended to all launch sessions.

Expected:

- select Notion OAuth memory if route/file scope matches;
- maybe select generic OAuth `state` memory only if the task mentions state handling or target files include shared OAuth helpers;
- reject Linear triage/instruction memories;
- trace should show ticket key and route/file signal.

#### 3. UI-originated vague task with no relevant memory

Task:

- UI prompt: "Can you make the settings page look cleaner on mobile?"

Memories:

- repo memory about a specific billing page mobile layout;
- company memory about a customer preferring compact dashboard cards;
- repo memory about using lucide icons in toolbar buttons.

Expected:

- return no company memory;
- return no repo memory unless a concrete settings-file path is provided and the memory applies there;
- final output should not mention old billing/dashboard preferences;
- trace should contain candidates rejected as generic/topical overlap.

#### 4. Explicit repo recall for file-scoped gotcha

Task:

- Agent calls `cycloid.memory_recall` with intent: "Modify session prompt queue retry handling" and files: `apps/control-plane-worker/src/session/prompt-queue.ts`.

Memories:

- useful repo memory: prompt queue terminal side effects must be idempotent because duplicate terminal events arrive;
- distractor repo memory: sandbox bridge post-execution rendering rules;
- distractor repo memory: UI transcript reducer idempotency rules.

Expected:

- select prompt-queue idempotency memory;
- reject bridge/UI memories even though they share terms like transcript, terminal, prompt;
- trace should include `path_match` and no full active-pool rerank.

#### 5. Explicit repo recall with stale/superseded memory

Task:

- Agent calls repo recall for "update model routing for verification sessions" with files in model-routing code.

Memories:

- active memory: verification sessions must use the latest verification model constant;
- superseded memory: verification sessions use old `gpt-5.4-mini`;
- rejected memory: use legacy provider env var.

Expected:

- select active memory only;
- exclude superseded/rejected before reranking where possible;
- trace should expose stale candidates as filtered or rejected, not selected.

#### 6. Company memory true positive from customer-scoped commitment

Task:

- Slack-originated customer request: "For Globex, update the renewal checklist so SOC2 evidence is requested before legal review."

Memories:

- useful company memory: Globex requires SOC2 controls before renewal;
- distractor company memory: Acme requires SOC2 evidence packet;
- distractor company memory: generic SOC2 audit-prep note;
- repo memory unrelated to docs checklist formatting.

Expected:

- select Globex memory only;
- reject Acme/generic SOC2 memories despite topic overlap;
- trace should show customer/scope anchor and matched evidence.

#### 7. Company memory false positive with same domain, different customer

Task:

- UI/API prompt: "Draft SOC2 launch notes for Acme."

Memories:

- Globex requires SOC2 controls before renewal;
- Acme prefers short Slack updates, but nothing about SOC2;
- general company memory about SOC2 from unrelated internal planning.

Expected:

- return no SOC2 memory unless Acme-specific source exists;
- optionally return Acme Slack-style preference only if the task asks for Slack copy;
- false-positive risk is high because domain term overlaps. This case should fail the suite if Globex SOC2 is injected.

#### 8. Dead-end recall prevents repeated failed approach

Task:

- "Verify Slack OAuth locally for the install callback."

Memories:

- useful dead-end: localhost callback failed because Slack requires stable HTTPS; use ngrok/control-plane URL;
- distractor dead-end: old ngrok domain failed for Datadog callback;
- repo memory: Slack scopes live in Slack docs and integration config.

Expected:

- select Slack OAuth HTTPS/ngrok dead-end;
- reject Datadog callback dead-end;
- judge final output for "does not retry localhost-only callback".

#### 9. Multi-hop but still scoped company memory

Task:

- "For repo `trycycloid/dummy-docker-app`, prepare the deployment checklist for the customer's billing migration."

Memories:

- customer memory: customer is Acme;
- Acme memory: billing migration must avoid weekend deploys;
- repo memory: dummy-docker-app deploy uses Docker compose health check;
- distractor memory: Globex billing deploy process.

Expected:

- select repo deploy memory and Acme billing migration memory only if graph/source links establish repo-to-customer scope;
- reject Globex;
- trace should show anchors/provenance chain or explicitly abstain if chain evidence is unavailable.

#### 10. Common-prefix adversarial batch

Run the same user task across Slack, Linear, GitHub issue comment, UI, API, and review-loop launch wrappers.

Task core:

- "Fix Notion OAuth callback token refresh."

Memories:

- useful Notion OAuth memory;
- six distractor memories created from each launch surface's boilerplate;
- generic OAuth memory;
- unrelated Notion database-search memory.

Expected:

- selected ids are stable across launch surfaces;
- denoised fingerprints should match or differ only by structured launch metadata;
- no boilerplate memory ever selected.

#### 11. Ambiguous task that should abstain until files appear

Task:

- "Clean up auth handling."

Memories:

- repo memory for GitHub auth;
- repo memory for Slack OAuth;
- repo memory for app session auth;
- company memory about customer SSO preference.

Expected:

- no bootstrap company memory;
- explicit repo recall should return empty unless files, tool calls, or follow-up intent disambiguate;
- if the agent later calls recall with `apps/control-plane-worker/src/auth/session.ts`, only app session auth memory may return.

#### 12. Memory useful but should not be injected at bootstrap

Task:

- "Investigate failing CI."

Memories:

- repo memory: Playwright flakes often come from missing browser install;
- repo memory: backend typecheck failures require generated types;
- company memory: QA deploy webhooks require HTTPS.

Expected:

- bootstrap returns empty because the failure class is unknown;
- explicit recall after the agent reads CI logs may return the specific memory matching the observed failure;
- suite should measure this as correct abstention, not a false negative.

#### 13. Contradictory same-scope memories

Task:

- "Update the GitHub issue-comment webhook behavior."

Memories:

- active memory: GitHub issue comments must verify installation access before session creation;
- active contradictory memory: GitHub issue comments can trust webhook repo payload;
- superseding adjudication memory says the verify-installation rule wins.

Expected:

- return only the winning memory or abstain if conflict cannot be resolved;
- never return both contradictory memories;
- trace must expose contradiction/supersession handling.

#### 14. Provenance missing means no injection

Task:

- "For Acme, update the data retention copy."

Memories:

- plausible Acme retention claim without source event/provenance;
- sourced Acme preference about concise customer-facing language;
- unrelated sourced Globex retention claim.

Expected:

- reject unsourced retention claim even if semantically strong;
- select concise-language preference only if the output surface is customer-facing copy;
- trace should mark provenance failure.

#### 15. Real historical downvote replay

Task:

- Use each downvoted June 12/June 14 `company_bootstrap` session from [current-state-handoff.md](./current-state-handoff.md), preserving raw launch text and memory corpus at the time as closely as possible.

Expected:

- the previously downvoted memory should not be injected unless the new trace gives a materially stronger reason than the original;
- reviewer label should be `fixed_false_positive`, `still_false_positive`, or `ambiguous_needs_human`;
- this is the highest-priority regression bucket because it mirrors actual trust damage.

#### 16. Real upvote replay

Task:

- Use the one useful upvoted memory example from [current-state-handoff.md](./current-state-handoff.md).

Expected:

- the useful memory still returns;
- returned memory should be cited and used in the final response;
- this guards against solving false positives by deleting recall entirely.

### Eval Metrics And Gates

Treat the scenario suite as a regression harness, not as proof of retrieval quality. If a small hand-authored suite goes 16/16, that only means the known edge cases are currently covered. It does not estimate production precision, and it should not be used as the release gate by itself.

The ML-quality eval layer should add:

- **Held-out replay:** real historical sessions split by time, including downvoted injections, useful upvotes, and ordinary sessions with no memory use. Tune retrieval config on one slice and report metrics on a later untouched slice.
- **Hard-negative mining:** for every true-positive memory, include same-domain distractors from different customers, repos, launch surfaces, stale memories, and unsupported facts. These should be near misses, not obviously unrelated fixtures.
- **Perturbation tests:** run the same task under Slack, Linear, GitHub, UI, API, review-loop, paraphrased task text, reordered boilerplate, and extra irrelevant context. Expected selected ids should remain stable unless structured scope changes.
- **Counterfactual shuffling:** swap customer/repo/thread scope while keeping the task text similar. Correct behavior is usually abstention, not selecting a topically related memory from the wrong scope.
- **Paired impact comparison:** run final-agent evals with memory disabled, with candidate memory visible, and with rejected/distractor memory visible. Label whether memory helped, hurt, was unused, or caused drift.
- **Score calibration:** report precision/recall curves by retrieval config version and source. Thresholds should be chosen from eval performance, not hardcoded from a single passing test run.
- **Active learning loop:** every internal false positive becomes a new hard-negative replay case with the raw denoising trace and candidate set preserved.

The target is not perfect accuracy on a tiny set. The target is a retrieval system whose abstention/selection tradeoff is measurable, whose thresholds are calibrated on hard negatives, and whose failures create new eval cases.

Report both retrieval-level and session-level metrics:

- **False-positive rate:** any memory returned when expected selected ids is empty.
- **Per-memory precision:** selected expected ids / selected ids.
- **True-positive recall:** expected selected ids returned / expected selected ids.
- **Abstention correctness:** empty result when task is ambiguous or lacks scoped/provenance support.
- **Launch-surface stability:** same core task under multiple wrappers selects the same ids.
- **Trace completeness:** every selected/rejected candidate has source, score or decision rationale, channels, and reject reason.
- **Impact label:** judge final output as helped/hurt/neutral/unused. A relevant memory that the agent ignores is not a retrieval false positive, but it is still a product failure.

Initial internal gate before widening beyond the Cycloid business:

- 0 false positives on the high-risk negative set: scenarios 3, 7, 10, 11, 12, 14, and historical downvote replays.
- At least 80% true-positive recall on scenarios 1, 4, 6, 8, 9, 16.
- 100% trace completeness for every returned memory.
- No launch-surface boilerplate memory selected in the common-prefix adversarial batch.
- Any failing case must be assigned a root cause: denoising, candidate generation, rerank decision, stale/supersession, provenance, agent usage, or fixture ambiguity.

Seed fixtures from:

- June 12 and June 14 downvoted `company_bootstrap` examples in [current-state-handoff.md](./current-state-handoff.md);
- the one known useful upvoted memory in that same doc;
- synthetic no-memory tasks with common Slack/Linear prefixes;
- file-scoped repo memory tasks where only path-specific memories should return;
- dead-end tasks where a known failed approach should return.

Metrics the runner should report:

- false-positive rate;
- true-positive rate;
- precision;
- empty-result correctness;
- false-negative rate, secondary;
- per-source precision: repo/company;
- provenance-complete rate;
- stale/superseded false-positive rate;
- denoising regression count;
- impact labels when outcome review is available: helped/hurt/neutral/unused.

## Internal Rollout

Rollout should be narrow and practical:

1. Run locally through the eval runner and focused tests.
2. Enable for the Cycloid business ID only.
3. Review traces, eval output, and internal feedback.
4. Remove the business gate when internal sessions show the success criteria.

Keep a kill switch for memory retrieval separate from memory creation/refinement.

## Implementation Order

1. Add deterministic denoising helper and no-LLM denoising fixtures.
2. Add retrieval evidence persistence in the shape needed by the eval runner.
3. Rework repo recall candidate generation and final decision.
4. Rework company recall query construction, scope/file scoring, and final decision.
5. Add memory retrieval cases to the eval runner.
6. Enable explicit recall locally, then for the Cycloid business ID.
7. Use the same retrieval core for bootstrap experiments once explicit recall is healthy.
8. Drop the internal gate only when eval and internal usage support it.

## Non-Goals

- Re-enable automatic prompt-start injection immediately.
- Treat vector search as the first fix.
- Merge repo and company memory storage models.
- Build broad graph/ontology automation before retrieval quality is proven.
- Optimize for recall volume.
- Hide false positives by suppressing telemetry.
- Build a second eval system outside the eval runner.

## Success Criteria

Memory is ready to re-enter live behavior when:

- tasks that do not have good memories do not use memory;
- returned memories are useful true positives;
- each memory decision is traceable: denoised input, candidates, scores, selected/rejected reasons, and provenance;
- evals can measure memory impact;
- internal Cycloid-business usage shows memory helps more often than it hurts.

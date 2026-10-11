# Memory Current State Handoff

Audience: engineers onboarding to Cycloid memory work.

Status date: 2026-06-15.

## Executive summary

Memory is currently spun down on the injection path because it was making sessions worse.

The failure mode was not "memory exists"; it was that recalled or bootstrapped memory entered sessions when it did not materially apply. The agent then treated that context as important, and the result was worse plans, irrelevant constraints, and extra cognitive load for the user.

There are two related but separable problems:

1. **Creation quality**: are we extracting and storing memories that are grounded, durable, actionable, and non-duplicative?
2. **Injection quality**: given a new session, can we reliably decide whether any memory should affect this task, and if so which one?

Creation may be acceptable in some lanes, but we cannot trust that yet because our measurement is thin. Injection is the acute problem. We do not currently have a reliable, session-level way to prove that memory improved the outcome.

## Current runtime state

Memory injection and recall are gated by the control plane per business.

`shared/constants/memory.ts` sets:

```ts
export const MEMORY_FEATURE_DISABLED = true;
```

That flag hides UI-only memory surfaces. Model-facing memory is controlled by
`apps/control-plane-worker/src/constants/company-memory.ts`: production sessions
with a business id receive `ARCANIST_MEMORY_TOOLS_ENABLED=1`.

The current rollout does five important things:

- Session bootstrap searches company memory for production sessions with a business id.
- Prompt dispatch discards stored company-memory context when bootstrap is not enabled.
- Company-memory and repo-memory dynamic tools register only when the sandbox env has `ARCANIST_MEMORY_TOOLS_ENABLED=1`.
- Customer businesses receive model-facing memory tools and bootstrap injection in production.
- The UI hides memory transcript rows. Workspace memory settings stays visible so admins can manage
  Slack channel intake configuration while prompt injection remains disabled.

Repo memories are still loaded for storage/enforcement compatibility; automatic
prompt injection and `cycloid.memory_recall` require the sandbox env capability.

Memory creation/refinement infrastructure still exists. Disabling injection does not delete the ingestion/refine/reconcile code paths.

## Memory surfaces

### Repo memory

Repo memory is for codebase-specific rules, gotchas, procedures, and enforcement.

Sources and storage:

- File-backed memories under `.cycloid/memory/**/*.md`.
- D1-backed repo memories in `repo_memories` when `MEMORY_REPO_SINK=d1`.
- Parsing lives in `shared/memory/parser.ts`.
- Creation and reconciliation live under `apps/control-plane-worker/src/memory/`.
- Bridge recall/tooling lives under `apps/sandbox-bridge/src/services/memory-dynamic-tool.ts`.

Recent direction:

- 2026-05-12: `d51f0573b` completed memory recall and hook runtime.
- 2026-06-12: `3b05cf080` redesigned repo memory generation, storage, and recall, including the D1 sink, judge-gated writes, and recall ranking through the control plane.
- 2026-06-12: `ceab67dc4` disabled repo memory injection/recall.

The redesign added stricter creation and recall gates. It did not prove that injection helps real sessions.

### Company memory

Company memory is for Slack/customer/session/PR context.

Sources and storage:

- Slack app mentions and opted-in Slack channel intake.
- Slack thread paste/refine.
- GitHub PR events.
- Review-loop outcomes.
- Session-complete summaries.
- Raw source artifacts go through `ingestion_events`.
- Derived memory lands in `memory_pages`, `memory_facts`, `memory_takes`, `memory_links`, and `memory_provenance`.

Implementation areas:

- `apps/control-plane-worker/src/company-memory/service.ts`: ingestion.
- `apps/control-plane-worker/src/company-memory/refine.ts`: LLM extraction into typed facts/entities/edges.
- `apps/control-plane-worker/src/company-memory/retrieve.ts`: D1 FTS/graph retrieval and prompt block formatting.
- `apps/control-plane-worker/src/company-memory/session-query.ts`: session-scoped query/reasoning-chain routes.
- `apps/control-plane-worker/src/session/durable-object.ts`: bootstrap retrieval before prompt dispatch.
- `apps/control-plane-worker/src/session/prompt-queue.ts`: prompt prepend and `memory_usage` event emission.

Recent direction:

- 2026-05-29: `01bfdb497` added Phase 1 Slack ingestion.
- 2026-05-29: `cece0c553` added Phase 2 refinement.
- 2026-05-29: `b6ae7f78e` added Phase 3 retrieval.
- 2026-06-14: `355650513` disabled company-memory injection end-to-end.

## What went wrong

The product failure is straightforward: memory recall/injection was too often negative.

Observed class of failures from current code/history:

- Memory was selected because it had lexical or topical overlap, not because it would materially change the current task.
- The injected context was authoritative-looking even when it was weakly related.
- The agent had no robust reason to ignore irrelevant injected memory once it appeared in the prompt.
- Bootstrap injection created a high-blast-radius failure mode: the session started with bad context before the agent did any local investigation.
- Company-memory retrieval used D1 FTS, graph anchors, confidence, recency, and simple scoring, but no final "would this help this exact session?" outcome gate.
- Repo-memory recall eventually got an LLM relevance judge, but that still measured selected-memory relevance, not end-to-end session improvement.

The underlying quality issue is not just bad ranking. It is that our memory system has no strong feedback loop that says, "this memory changed the session in a good way."

## Creation vs injection

Creation and injection interact, but they should be evaluated separately.

Creation asks:

- Is the claim grounded in source material?
- Is it durable, not prompt-local?
- Is it actionable for future work?
- Is it scoped correctly to business/repo/customer/channel?
- Is it non-duplicative and not contradicted by newer evidence?

Injection asks:

- Does this memory apply to this exact task?
- Would it change what the agent should do next?
- Is it more useful than letting the agent inspect the repo/session normally?
- Is the risk of distraction lower than the expected benefit?
- Can we cite where it came from and later audit whether it helped?

The current system has more machinery for creation than for proving injection value. That is backwards for user experience: a mediocre memory that never gets injected is mostly harmless; a mediocre memory injected at session start is actively harmful.

## What measurement exists today

There is some telemetry and some offline judging, but it is not enough.

Existing usage evidence:

- `memory_usage_events` records selected memory ids, prompt/session ids, source values, rank/score, intent, and file hints.
- Durable session events include `memory_usage` and `memory_recall_usage`.
- The UI has feedback controls for visible memory events.
- `memory_feedback` stores thumbs up/down and comments by session/prompt/memory/display event.
- Slack posting for memory feedback exists when configured.

Existing offline scripts:

- `scripts/evaluate-memory-ranking.ts` samples historical prompt-start memory usage and asks an LLM judge whether selected repo memories were relevant.
- `scripts/evaluate-memory-redesign.ts` (removed — redesign eval retired as obsolete) evaluated whether the repo-memory analyzer made good create/update/remove/no-memory decisions for merged PRs.

What these do well:

- Catch obviously irrelevant selected memories.
- Produce aggregate counts for selected, relevant, borderline, and irrelevant memories.
- Help debug creation false positives and false negatives.

What they do not prove:

- Whether a session with memory succeeds more often than the same session without memory.
- Whether memory reduced time, tool calls, loops, review comments, or user corrections.
- Whether the agent actually used the memory correctly.
- Whether a memory was helpful enough to justify being injected at prompt start.
- Whether company-memory retrieval improves Slack-originated task quality.

## Important docs to read first

Read these in order:

1. `docs/memory-new/memory-2.0-plan.md`
2. `docs/memory-new/memory-2.0-tech-spec.md`
3. `docs/bridge.md`
4. `docs/slack.md`
5. `docs/memory-new/honcho-learnings.md`
6. `docs/memory-new/scout-learnings.md`
7. `docs/memory-new/gbrain-learnings.md`
8. `docs/memory-new/supermemory-learnings.md`

Why:

- The plan/spec explain what we intended to build.
- `docs/bridge.md` explains the current prompt/runtime reality.
- `docs/slack.md` explains current Slack constraints, including opt-in ambient capture and no DM support.
- Honcho is the most relevant measurement inspiration: baseline-vs-memory harnesses and scenario judges.
- Scout is the most relevant Slack-native product inspiration.
- GBrain is the best data-model and graph-consolidation inspiration.
- Supermemory is useful for versioning, provenance, soft delete, and fail-open retrieval patterns.

## Code map

Repo memory:

- `apps/control-plane-worker/src/memory/analyzer.ts`
- `apps/control-plane-worker/src/memory/judge.ts`
- `apps/control-plane-worker/src/memory/recall.ts`
- `apps/control-plane-worker/src/memory/db.ts`
- `apps/control-plane-worker/src/memory/service.ts`
- `apps/sandbox-bridge/src/services/memory-dynamic-tool.ts`
- `apps/sandbox-bridge/src/services/memory-ranking.ts`
- `shared/memory/parser.ts`

Company memory:

- `apps/control-plane-worker/src/constants/company-memory.ts`
- `apps/control-plane-worker/src/company-memory/db.ts`
- `apps/control-plane-worker/src/company-memory/service.ts`
- `apps/control-plane-worker/src/company-memory/refine.ts`
- `apps/control-plane-worker/src/company-memory/retrieve.ts`
- `apps/control-plane-worker/src/company-memory/session-query.ts`
- `apps/control-plane-worker/src/company-memory/reconcile*.ts`

Session injection path:

- `apps/control-plane-worker/src/session/durable-object.ts`
- `apps/control-plane-worker/src/session/prompt-queue.ts`
- `apps/sandbox-bridge/src/memory-manager.ts`
- `apps/sandbox-bridge/src/services/first-party-dynamic-tools.ts`

Measurement and feedback:

- `apps/control-plane-worker/src/session/memory-feedback-db.ts`
- `apps/control-plane-worker/src/services/memory-feedback.ts`
- `apps/ui/src/components/Transcript.tsx`
- `scripts/evaluate-memory-ranking.ts`
- `scripts/evaluate-memory-redesign.ts` (removed — redesign eval retired as obsolete)

## Slack evidence

The target Slack channels are `#cycloid-memory` and `#memory-feedback`.

Evidence from `#memory-feedback`:

- 2026-06-14: J asked, "Has there been a successful prod session with memory injection" after reporting a recent failure. The same cluster includes "This literally makes 0 sense" and "Pls just turn off htis feature."
- 2026-06-12 15:59: `company_bootstrap` memory was downvoted by `shiv-cycloid` with the comment "no idea why these got pulled in." The two visible memories were Slack-session implementation facts:
  - `mf_5ed511772dcf55102973b7644d09a7814c9e6496514360d5e90e652dc3385c4c`: Slack completion delivery previously being best-effort.
  - `mf_b77d63ceb513cf537f1125e1c133bdbaea9068c46db1e98617496579c913c838`: Slack session creation bug fixed by passing business id into `createSessionState`.
- 2026-06-12 11:56: four `company_bootstrap` memories were downvoted by `josiah-arcanist` on `trycycloid/cycloid`, followed by "is memory injection fixed or not." The visible memories were unrelated implementation details about skill assignees, review-listening pagination, and PR #4418 webhook/review-listening behavior:
  - `mf_8fddb06749c0669cc22c46907d939aced454b54105f794251b29e0493fdd2bce`
  - `mf_9377e1d01007bdffb6673e98cb387b01a87de3af8c05902715bba0caf8f4904c`
  - `mf_38e5198526a96e9de1df76e997ce474bea6a38f38999eb8dee91bc52fc95790a`
  - `mf_3820dd2880239f1e6dd5861bba6fcbacd6b91cdb09ee45a1b682a4b1d652e621`
- 2026-06-12 04:58: one `company_bootstrap` memory was upvoted by `shiv-cycloid`: `mf_5389b4a2d425918bd989e40e2371f4d88a1111bc0b5c6b27ca3b96d90bc5ad61`, about a change affecting only comment markdown formatting. This is useful because the failure is not "all memories are bad"; the problem is discriminating when they help.

Evidence from `#cycloid-memory`:

- 2026-04-06: Shiv wrote, "FWIW i think we also need to do a substantially better job of actually injecting memories" and then "we probably need a sidecar LLM that only does this."
- 2026-04-03: Shiv noted a memory was acceptable but "doesnt line up with the new standard of memories," and merged it because it was "probably better than not having the memory at all." This points at creation-quality uncertainty before the later injection failures.
- 2026-04-09: Shiv wrote that a proposed convention cleanup "should have been part of the original PR" and "it's not a memory," which is a creation-boundary failure: the system confused missed implementation/review work with reusable future memory.

Takeaway: the Slack evidence matches the code-history arc. We did not only have stale docs or theoretical concerns; real users saw `company_bootstrap` memories injected into prod sessions, downvoted them, and asked whether the feature should be turned off. The clearest eval fixtures should start from the downvoted memory ids above, their source sessions/prompts, and the original task text.

## Current working hypothesis

Injection should stay disabled until we can run a repeatable evaluation showing a positive lift.

The bar should be stronger than "selected memories are usually relevant." The useful bar is closer to:

- on tasks with known relevant memory, memory improves the session outcome;
- on tasks without relevant memory, the system injects nothing;
- on ambiguous tasks, memory is available via an explicit tool or citation-backed preview, not forced into the initial prompt;
- selected memories are traceable to source material and can be audited after the session;
- false positives are rare enough that users do not experience memory as noise.

## Next steps

The forward implementation plan lives in [memory-gameplan.md](./memory-gameplan.md). The concrete retrieval-quality repair plan lives in [memory-retrieval-quality-plan.md](./memory-retrieval-quality-plan.md). For Milestone 1 specifically, the authoritative review/eval spec is [memory-review-bot-milestone-1-spec.md](./memory-review-bot-milestone-1-spec.md).

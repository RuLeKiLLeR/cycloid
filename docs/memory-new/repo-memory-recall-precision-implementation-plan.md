# Repo Memory Recall Precision Implementation Plan

Date: 2026-06-19

Goal: reduce explicit recall false positives without brittle term lists or a storage rewrite. Bootstrap remains disabled. This plan covers the repo/company recall implementation work and the fast eval loop needed before the next Slack live batch.

## Evidence Behind The Plan

The latest live subset still returned adjacent memories for the same broad domain but wrong mechanism. The clearest causes are technical, not threshold-only:

- `apps/control-plane-worker/src/memory/recall.ts` currently treats bridge `candidate_channels` as proof. A bridge-side `path_match` or `symbol_match` can add recall score even when the control plane did not independently prove that evidence.
- Path evidence is too binary. A broad directory or glob can compete with an exact task file.
- The recall trace does not preserve enough matched evidence to distinguish `same domain, right mechanism` from `same domain, wrong mechanism`.
- `shared/memory/parser.ts` keeps rich frontmatter in `MemoryFile`, but `toRuntimeMemory()` drops `subjects`, `symbols`, `tags`, `source_pr_urls`, and `source_session_ids`, so the sandbox path loses useful non-brittle anchors.
- No migration is required for the first pass. D1 already stores `memory_json`, source PR/session columns, `applies_to_json`, `action_type`, `primitive`, `authority`, and `enforcement`.

External repo investigation supports this direction:

- GBrain uses hybrid lanes and weighted RRF while preserving source-aware identities and fail-open fallback.
- Honcho separates explicit observations from derived observations before injection.
- Supermemory dedupes by source priority and keeps retrieval fail-open.
- Scout exposes narrow provider-specific tools instead of leaking provider internals.
- Empirica ranks by memory type and suppresses known dead-end lanes.

We should copy those shapes, not their storage stacks.

## Implementation Shape

### 1. Make Bridge Channels Hints Only

Change `rankRepoMemoryRecallCandidates()` so `candidate_channels` from the bridge are copied into trace as `bridgeCandidateChannels` but never directly add score.

Control-plane recall must recompute all proof from:

- task files and memory `applies_to`,
- explicit task symbols and memory `symbols` / `subjects` / `tags`,
- exact PR or session identifiers,
- command/tool names,
- error fingerprints,
- distinctive text overlap,
- memory type/action metadata.

Expected code shape:

```ts
type RepoMemoryRecallEvidence = {
  bridgeCandidateChannels: string[];
  matchedChannels: CandidateChannel[];
  rawChannelScores: Partial<Record<CandidateChannel, number>>;
  pathMatches: PathMatchEvidence[];
  matchedTerms: Partial<Record<"symbol" | "tool" | "error" | "text", string[]>>;
  actionSurface: ActionSurfaceDecision;
};
```

Keep the bridge prefilter for performance, but treat it like candidate-pool shaping, not proof.

### 2. Add Path Specificity

Add shared helpers in `shared/memory/retrieval-signals.ts`:

- `pathSpecificityScore(memoryPaths, taskPaths)`
- `bestPathMatch(memoryPath, taskPath)`
- `pathSpecificityWeight(path)`

Use structural path evidence instead of term lists:

- exact file match: strongest,
- task file under explicit memory directory: strong,
- explicit glob prefix: medium,
- broad directory overlap: weak,
- no concrete overlap: none.

Broad directory overlap can help ranking, but it must not satisfy the action-anchor gate by itself.

### 3. Add Action-Surface Gating

Add a final reject step in `repoMemoryRecallRejectReason()` after scoring and before selection.

A memory can be returned only if it has at least one concrete action anchor:

- exact source PR/session id,
- specific path evidence,
- symbol/function/class/command evidence,
- error fingerprint evidence,
- distinctive mechanism overlap,
- source-linked derived evidence.

Domain-only overlap should be rejected as `missing_action_anchor` or `same_domain_wrong_mechanism`.

Action surface should be derived generically from existing structured signals, not hardcoded integration terms:

```ts
type ActionSurface = {
  memoryType: string | null;
  actionType: string | null;
  primitive: string | null;
  pathRoots: string[];
  toolTerms: string[];
  mechanismTerms: string[];
};
```

Mechanism terms should come from `buildRetrievalSignals()` plus distinctiveness filtering over the task and memory corpus. Do not encode lists like `Slack`, `Datadog`, `Linear`, or `sandbox` as special cases.

### 4. Preserve Existing Metadata Through Runtime Projection

Extend the runtime/wire memory context so repo memories retain:

- `subjects`,
- `symbols`,
- `tags`,
- `source_pr_urls`,
- parsed `source_pr_number`,
- `source_session_ids`.

This should be in-memory serialization work only. Do not add a migration unless we later need SQL filtering over these arrays.

The sandbox recall builder is already prepared to forward most of these fields when present, so this mainly fixes the lossy projection path.

### 5. Use Lane Fusion Instead Of One Blended Score

Keep implementation small, but structure scoring as lanes:

- exact source id lane,
- path lane,
- symbol/tool/error lane,
- distinctive text lane,
- source/derived-memory lane.

Fuse lane ranks with a simple weighted RRF-style score, source-aware identity keys, and source-priority dedup. This matches the external research without importing a new retrieval framework.

If embeddings or a future lane fails, retrieval should continue with the deterministic lanes.

### 6. Improve Traceability

Extend `RepoMemoryRecallTrace` so every selected and rejected candidate includes:

- retrieval config version,
- bridge candidate channels,
- control-plane-proven channels,
- path match kind and matched paths,
- matched symbols/tools/errors/text terms,
- action-surface decision,
- fused score and final score,
- reject reason.

The trace must answer: “why did this memory change the agent’s next action?” If it cannot, the memory should not be injected.

## Fast Eval Plan

Do not use Slack live sessions as the primary iteration loop for recall quality. Use a recall-only scratch runner or maintained eval surface that calls runtime retrieval code directly:

- repo recall: `rankRepoMemoryRecallCandidates()`,
- company recall: `retrieveCompanyMemory()` with explicit recall mode,
- optional bridge check: `executeMemoryRecallDynamicToolCall()` for candidate-pool loss.

Fixture scenarios should start with:

- the 30 Phase 2 scenarios from `prod-memory-simulation-test-plan.md`,
- known hard negatives from `memory-injection-precision-plan.md`,
- prompt-only variants with source PR/session ids removed,
- true-negative abstain scenarios,
- generated candidate scenarios from prod memory exports, promoted to curated fixtures only after review.

Each scenario should declare expected repo/company ids, forbidden ids, labels, and tags.

Report metrics by path, never only combined:

- precision,
- recall,
- MRR,
- recall@1 / recall@2 / recall@4,
- wrong-mechanism hit rate,
- abstain accuracy,
- candidate loss reason,
- trace completeness,
- selected-count distribution.

Target gates before another Slack batch:

- repo recall smoke precision >= 75%,
- repo recall smoke recall >= 70%,
- wrong-mechanism hits = 0 in smoke,
- trace completeness = 100%,
- no expected memory missing because of candidate-pool truncation.

Slack live sessions should then test whether the agent uses correct memories productively, not debug basic recall ranking.

## Work Order

1. Add recall-only fixture and runner skeleton.
2. Add path-specificity helpers and tests.
3. Stop scoring bridge `candidate_channels` as proof.
4. Preserve repo memory metadata through runtime projection.
5. Add action-surface evidence and reject reasons.
6. Convert scoring into lane fusion with source-aware dedup.
7. Expand tests with hard negatives and trace completeness assertions.
8. Run the recall corpus, tune only generic weights/gates, then run a small Slack live subset.

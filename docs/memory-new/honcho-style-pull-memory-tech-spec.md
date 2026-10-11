# Honcho-Style Pull Memory Tech Spec

## Verdict

This adds real surface area: new D1 schema, FTS indexes, a vector index, a bounded selector agent, query traces, and a multi-phase cutover. The current memory path already produced high-blast-radius pre-prompt injection failures, and Honcho parity is not achievable with FTS-only retrieval plus ad hoc fusion.

Durable version: remove push injection, keep hooks as reminders/guards, add D1-authoritative Honcho-style context memory with semantic candidate generation and an agentic final selector. `build`

## Goal

Mimic Honcho's pull-based memory behavior in Cycloid, while preserving Cycloid's more prescriptive repo-memory semantics.

Target behavior:

- No memory body enters a coding session before the agent asks for it.
- Hooks guide the agent to recall memory when conditions suggest prior context may matter, but do not inject memory content.
- One pull tool retrieves repo/company/session memory through a shared candidate-generation pipeline.
- Retrieval has a real semantic lane backed by a vector index, not RRF over only lexical lists.
- A small bounded GPT-5.4 selector agent receives surfaced candidates plus session context and chooses the final return set, including returning nothing.
- Every returned memory is scoped, traceable, and explainable through provenance.

Non-goals:

- Delete the entire concept of automatic pre-prompt memory injection.
- Do not port Honcho's Postgres/pgvector schema verbatim.
- Do not use an unbounded dialectic chat loop in the hot path.
- Do not make repo-memory enforcement depend on the new graph until parity is proven.

## Evidence

Honcho:

- `session.context` is pull-based. It returns bounded session messages, summary, and optional peer representation/card only when requested.
- `peer.context` and `peer.representation` read long-term memory directly with semantic query and max-conclusion limits.
- Long-term memory is directional: collections are keyed by `(observer, observed, workspace)`.
- Memory units have levels: `explicit`, `deductive`, `inductive`, `contradiction`.
- Retrieval separates explicit observations from derived observations to prevent dilution.
- RRF appears in Honcho's hybrid message search, where semantic and full-text ranked lists are genuinely independent. It is not the primary representation-retrieval mechanism.

Cycloid today:

- Company memory is D1 + FTS + graph traversal, not semantic vector retrieval.
- Repo memory D1 has B-tree indexes, but no repo-memory FTS, vector catalog, embedding queue, or ANN search.
- `apps/control-plane-worker/src/session/prompt-queue.ts` and `apps/control-plane-worker/src/session/durable-object.ts` still contain company memory storage/injection paths that must be deleted.
- `apps/sandbox-bridge/src/memory-manager.ts`, `apps/sandbox-bridge/src/bridge.ts`, and `apps/sandbox-bridge/src/services/prompt-context-builder.ts` still support prompt-time repo memory injection.
- `apps/sandbox-bridge/src/services/memory-hook-runner.ts` injects full memory bodies on some hooks today.
- `queryPlatformStructuredOutput` and `OpenAIModel.GPT54` already exist for structured selector/deriver calls.

Provider check:

- Cloudflare Vectorize is a Worker-integrated vector database and supports metadata filtering and Workers AI embedding flows in current Cloudflare docs.
- Vectorize upserts are asynchronous, so D1 must remain authoritative and retrieval must rehydrate/filter every vector hit from D1.
- Implementation must re-verify current Vectorize binding/API details before adding config or code.

## Architecture

### Compatibility Invariants

- Existing memory storage schemas and rows remain readable during the migration.
- `.cycloid/memory/**/*.md`, D1 `repo_memories`, and `MEMORY_REPO_SINK=d1` compatibility stay intact.
- Session creation, prompt dispatch, replay/export, PR publication, and Codex/Claude backend selection remain unchanged except for removing memory injection.
- Businesses without memory tools enabled see no new tool or prompt behavior.
- Old memory ids either remain stable or gain explicit lineage/redirect metadata before any compatibility code is removed.
- No destructive compaction or customer-visible memory deletion ships without a separate dry-run report and approval.

### Pull Surface

Expose one agent-facing recall tool:

```text
cycloid.memory_context
```

Input:

```ts
{
  intent: string;
  files: string[];
  symbols: string[];
  tool: string | null;
  currentTaskSummary: string;
  recentSessionSummary: string | null;
  maxMemories: number;
  reasoningLevel: "minimal" | "standard" | "deep";
}
```

Output:

```ts
{
  memories: Array<{
    id: string;
    kind: "repo_rule" | "company_fact" | "company_take" | "session_observation" | "derived_conclusion" | "scope_card";
    content: string;
    whyReturned: string;
    confidence: "low" | "medium" | "high";
    enforcement: "none" | "suggest" | "warn" | "block";
    provenance: Array<{ sourceKind: string; sourceId: string; excerpt: string | null }>;
  }>;
  traceId: string;
}
```

Compatibility:

- `cycloid.memory_recall` becomes a thin repo-focused wrapper over `cycloid.memory_context`.
- `cycloid.company_memory_recall` becomes a company-focused wrapper over `cycloid.memory_context`.
- `cycloid.company_memory_reasoning_chain` remains available and moves to the new source-chain store after parity.

### Data Model

D1 remains source of truth. Vectorize is candidate generation only.

Do not create a table per concept just because Honcho has one. The defensible split is: one table for each lifecycle boundary where rows need different retention, authorization, indexing, or write cadence. Everything else stays JSON or is deferred.

Core tables:

- `memory_scopes`: authorization/search boundary for business, repo, customer, Slack thread, Cycloid session, incident, or person.
- `memory_peers`: canonical observed/observer subjects such as human, agent, repo, customer, channel, or system.
- `memory_sessions`: durable source conversations.
- `memory_messages`: ordered raw turns/data units with `seq_in_session`.
- `memory_collections`: directional `(scope, observer_peer, observed_peer)` namespaces.
- `memory_conclusions`: public memory units, equivalent to Honcho documents.
- `memory_conclusion_sources`: provenance and reasoning-chain edges.
- `memory_work_items`: derive, consolidate, vector sync, and backfill queue.
- `memory_context_queries`: query trace and selector audit.

Additive retrieval tables:

- `memory_semantic_documents`: D1 catalog for vectorized chunks. Vectorize is not authoritative.
- FTS virtual tables for repo memories, conclusions, and messages.

Deferred tables:

- `memory_scope_peers`: only add when we need per-scope membership flags such as `observe_me` or `observe_others`. Until then, collection rows encode the observer/observed pair.
- `memory_scope_cards`: only add with consolidation. Before then, cards can be absent.
- `memory_scope_card_entries`: only add if JSON card entries become hard to validate/query. Start with one card row containing typed JSON.
- `memory_consolidation_runs`: only add when consolidation needs a durable audit table separate from `memory_work_items` and `memory_context_queries`.

Defense:

- `scopes`, `peers`, and `collections` are the minimum needed to mimic Honcho's directional memory without leaking across business/repo/customer/thread boundaries.
- `sessions` and `messages` are separate because raw source turns have different retention, ordering, FTS, and provenance needs than distilled conclusions.
- `conclusions` and `conclusion_sources` are separate because one conclusion can cite many messages/conclusions/repo memories, and source-chain traversal must be queryable without parsing JSON.
- `semantic_documents` is separate because vector sync state, embedding model, chunk hash, and vector id are operational metadata, not memory content.
- `work_items` and `context_queries` are operational tables: queues and traces should not be mixed into domain memory rows.

Key `memory_conclusions` fields:

```sql
id TEXT PRIMARY KEY,
business_id TEXT NOT NULL,
collection_id TEXT NOT NULL,
scope_id TEXT NOT NULL,
kind TEXT NOT NULL,
content TEXT NOT NULL,
level TEXT NOT NULL CHECK (level IN ('explicit','deductive','inductive','contradiction')),
status TEXT NOT NULL CHECK (status IN ('active','proposed','superseded','rejected','expired','deleted')),
confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
authority TEXT NOT NULL CHECK (authority IN ('inferred','reviewed','source_of_truth')),
reinforcement_count INTEGER NOT NULL DEFAULT 0,
positive_feedback_count INTEGER NOT NULL DEFAULT 0,
negative_feedback_count INTEGER NOT NULL DEFAULT 0,
times_derived INTEGER NOT NULL DEFAULT 0,
valid_until_ms INTEGER,
superseded_by TEXT,
deleted_at_ms INTEGER,
created_at_ms INTEGER NOT NULL,
updated_at_ms INTEGER NOT NULL
```

Important Cycloid flavor:

- Do not overload repo-memory `level` (`strategic | tactical | gotcha`). Honcho's derivation level lives on `memory_conclusions.level`.
- Repo memories remain parsed through `shared/memory/parser.ts`; do not hand-parse `.cycloid/memory/**`.
- Repo memories with `enforcement='block'` remain hard guards in the bridge until graph parity is proven.

### Semantic Index

Add a D1 catalog for semantic documents:

```sql
CREATE TABLE memory_semantic_documents (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'memory_conclusion',
    'memory_message',
    'memory_scope_card',
    'repo_memory',
    'company_fact',
    'company_take'
  )),
  source_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dim INTEGER NOT NULL,
  vector_namespace TEXT NOT NULL,
  vector_id TEXT NOT NULL UNIQUE,
  vector_state TEXT NOT NULL CHECK (vector_state IN ('pending','synced','failed','deleted')),
  sync_attempts INTEGER NOT NULL DEFAULT 0,
  last_sync_at_ms INTEGER,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER
);
```

`memory_scope_card` is included for schema stability, but card chunks are not produced until the consolidation phase adds cards.

Indexes:

- Unique `(source_kind, source_id, embedding_model)`.
- Queue `(vector_state, last_sync_at_ms, sync_attempts)`.
- Lookup `(business_id, source_kind)`.
- Lookup `(repo_owner, repo_name, source_kind)`.
- Lookup `(scope_type, scope_id)`.

Vector metadata:

- `tenant_key`: hashed business id.
- `repo_key`: hashed `owner/name`, when repo-scoped.
- `scope_key`: hashed stable scope id.
- `source_kind`: short source kind.
- `active`: boolean.

Rules:

- Embedding model: OpenAI `text-embedding-3-small`, 1536 dimensions.
- One embedding model and one Vectorize index dimension at launch. No multi-model abstraction until a migration requires it.
- Phase 4 is not accepted unless CF Vectorize works end to end: embed, sync, metadata-filtered query, D1 rehydrate, trace, fake-provider tests, and one real environment smoke.
- Hybrid RRF is enabled only when the vector lane is working for that request.
- Writes insert or update D1 semantic docs as `pending`.
- A bounded worker embeds pending rows, upserts Vectorize, then marks rows `synced`.
- Supersede/delete marks rows `deleted` and best-effort deletes vectors.
- Retrieval uses only `synced` rows and must re-check D1 auth, scope, status, and deletion state after every vector hit.
- Embedding failure, Vectorize timeout, missing binding, or async index lag falls back to lexical/graph candidates.

Add FTS:

- `repo_memories_fts` over `context_hint`, `content`, `primitive`, `applies_to_json`, and trigger-rebuilt on insert/update/delete.
- `memory_conclusions_fts` over `content`.
- `memory_messages_fts` over `content_text`.
- Keep existing `memory_facts_fts` and `memory_takes_fts` until legacy cutover.

### Retrieval Mechanism

Retrieval has three distinct steps:

1. Candidate generation.
2. Candidate ordering/fusion.
3. Selector-agent final choice.

#### 1. Candidate Generation

Normalize the request:

- Denoise task text using existing `shared/memory/task-denoising.ts` patterns.
- Extract repo, files, symbols, tool, error snippets, PR/session ids, Slack/thread ids, customer id, and user/business ids from trusted session context.
- Resolve scope and observer/observed peers.
- Apply hard filters before searching: business, repo, customer/thread scope, auth, active status, not superseded/rejected/deleted, not secret-quarantined.

Generate candidates from independent lanes:

- Scope-card lane: exact D1 load for matching scope/pair cards.
- Repo structural lane: path, symbol, tool, trigger, enforcement, and exact id matches from `repo_memories`.
- Repo FTS lane: server-side FTS over all active repo memories, not only the latest local candidate pool.
- Company FTS lane: existing facts/takes FTS during compatibility, then conclusions/messages FTS.
- Graph lane: anchored page/scope/relation traversal from current company-memory graph and later source-chain graph.
- Vector lane: query embedding against Vectorize with metadata filters, then D1 rehydration.
- Recent lane: recent messages/conclusions in the exact scope.
- Reinforced lane: high `reinforcement_count` / `times_derived` conclusions inside the scope.

Candidate cap before selector:

- Hard evidence lanes: max 20.
- FTS lanes: max 30 combined.
- Vector lane: max 30.
- Recent/reinforced lanes: max 20 combined.
- Deduplicate by canonical source id, preserving all lane evidence.
- Keep at most 60 compressed candidates for the selector.

#### 2. Ordering And Fusion

Do not use blanket RRF.

Use RRF only when all are true:

- There are at least two independent ranked lists.
- One list is semantic vector retrieval.
- One list is lexical FTS/BM25 or equivalent.
- The lists target the same candidate universe after D1 rehydration.

RRF formula:

```text
score(candidate) = sum(lane_weight / (60 + rank_in_lane))
```

Default weights:

- Vector semantic: `1.0`.
- FTS lexical: `1.0`.
- Message FTS: `0.8`.
- Conclusion FTS: `1.0`.

Do not RRF:

- Exact ids.
- Path/tool/trigger matches.
- Blocking repo memories.
- Graph anchors.
- Scope cards.

Those receive deterministic evidence labels and minimum ordering floors before selector input.

If vector is unavailable:

- No RRF.
- Use deterministic lane quotas, native FTS rank, exact-match floors, and the selector.
- Trace `vector_unavailable` with reason.

#### 3. Selector-Agent Final Choice

The selector is an actual bounded control-plane agent, not a one-shot reranker and not a general runtime agent. Retrieval surfaces candidates; the selector only judges applicability and may return zero memories.

Model:

- `OpenAIModel.GPT54`.
- Medium reasoning effort.
- Leave an implementation note that this selector should later move to an OSS model after quality and latency parity are proven.
- Structured output through `queryPlatformStructuredOutput`.

Loop:

1. Turn 1 receives denoised task context, trusted session signals, candidate previews, lane evidence, and ordering/fusion scores.
2. Turn 1 either returns a final selection or requests bounded evidence through allowlisted selector tools.
3. The control plane executes allowed local read-only tools.
4. Turn 2 must return a final decision. No further tools are allowed.

Allowed selector tools:

- `read_memory_sources(memory_ids[])`: returns source URI, source time, source excerpt, lifecycle state, and supersession/conflict metadata for candidate ids only.
- `read_session_context(excerpt_kind)`: returns already-authorized bounded session metadata such as current prompt excerpt, recent summary, changed files, or tool names.
- `read_candidate_trace(memory_ids[])`: returns lane evidence, raw scores, matched terms, path/entity anchors, and filters passed.

Disallowed:

- No network.
- No new retrieval searches.
- No repo/file reads.
- No writes.
- No access outside pre-authorized candidate ids.
- No arbitrary SQL.
- No sandbox shell/filesystem.
- No first-party dynamic tools such as Slack, Datadog, Braintrust, Linear, Jira, or Notion.

Bounds:

- Max 30 candidates into the selector after candidate compression.
- Max 2 model calls.
- Max 1 tool round and 3 total tool calls.
- Max 6 inspected candidate ids.
- Max 5 returned memories.
- Max 1,500 output tokens per model call.
- Max 8 KB total selector-tool result bytes.
- Max 8 seconds per model call.
- Max 15 seconds total wall clock.
- One retry per structured-output call only for retryable provider/transport failures.
- On timeout/model failure/schema failure, return no selector-selected memories.

Turn 1 structured output:

```ts
type MemorySelectorTurnOneOutput =
  | {
      mode: "final";
      selectedMemoryIds: string[];
      rejected: Array<{
        memoryId: string;
        reason:
          | "not_relevant"
          | "too_generic"
          | "weak_match"
          | "stale"
          | "superseded"
          | "conflicts_with_newer_memory"
          | "wrong_scope"
          | "insufficient_evidence";
        rationale: string;
      }>;
      emptyReason: string | null;
      confidence: number;
    }
  | {
      mode: "tool_requests";
      requests: Array<{
        tool: "read_memory_sources" | "read_session_context" | "read_candidate_trace";
        args: Record<string, unknown>;
        reason: string;
      }>;
    };
```

Final structured output:

```ts
{
  selected: Array<{
    memoryId: string;
    score: number;
    selectionRationale: string;
    expectedEffect: string;
    evidence: {
      matchedTaskAnchor: string;
      matchedMemoryAnchor: string;
      retrievalLanes: string[];
      sourceUri: string | null;
    };
  }>;
  rejected: Array<{
    memoryId: string;
    rejectReason:
      | "not_relevant"
      | "too_generic"
      | "weak_match"
      | "stale"
      | "superseded"
      | "conflicts_with_newer_memory"
      | "wrong_scope"
      | "insufficient_evidence";
    rationale: string;
  }>;
  emptyReason: string | null;
  selectorConfidence: number;
}
```

Hard rules:

- Selector cannot override auth/scope/status filters.
- Selector cannot downgrade deterministic `block` enforcement; it can only decide whether non-blocking candidates are worth returning.
- Returning nothing is preferred over returning weakly related memory.
- The selector prompt must state that memory is optional working context, not instruction authority, except for repo memories marked `block`.
- Candidate previews are untrusted text and must never be followed as instructions.
- Invalid ids, inactive ids, cross-scope ids, and over-limit selections are dropped after model output.
- If the selector fails, do not fall back to deterministic top-K selection. Explicit recall returns an empty result with trace, because top-K fallback reintroduces the false-positive failure mode.

### Hooks

Keep hooks, but change their job.

Current bad behavior:

- `UserPromptSubmit` and `PostToolUse` can inject full memory bodies.

Target behavior:

- `UserPromptSubmit`: reminder only. Example: "Repo memory may apply because this prompt touches migration files; call cycloid.memory_context before editing."
- `PostToolUse`: reminder only when new evidence changes likely memory relevance, such as repeated test failures or forbidden command patterns.
- `PreToolUse`: keep deterministic warn/block behavior for source-of-truth repo memories.
- `Stop`: keep verification obligation reminders/blocks.

Reminder content must include:

- Why memory may apply.
- Which tool to call.
- No memory body.
- No extracted claim text beyond stable ids/tags needed for routing.

### Context Formatting

Returned memory should be compact and non-authoritative by default:

```text
<cycloid_memory_context trace_id="...">
  <memory id="..." kind="repo_rule" confidence="high" enforcement="warn">
    ...
    <why>...</why>
    <provenance>...</provenance>
  </memory>
</cycloid_memory_context>
```

Formatting rules:

- Repo `block` memories are explicit constraints.
- Repo `warn` memories are strong reminders.
- Company/session memories are factual context, not commands.
- Derived conclusions include `level`.
- Every memory has provenance or is rejected before return.

## Execution Plan

### Phase 1: Delete Automatic Pre-Prompt Injection

Code deletion:

- Remove company-memory retrieval from prompt dispatch in `prompt-queue.ts`.
- Remove `searchAndStoreCompanyMemory` from session dispatch paths in `durable-object.ts`.
- Remove `company_memory_context`, `company_memory_target_prompt`, and `company_memory_usage` prompt-prepend behavior.
- Remove bridge prompt-time `rankMemoriesForPrompt()` call and `activeMemories` prompt section insertion.
- Keep memory recall dynamic tools unchanged.
- Keep memory feedback display support for explicit recall events.

Verification:

- Unit tests proving prompt assembly never prepends company memory.
- Unit tests proving repo active memories are not inserted into system/additional context.
- Prompt golden tests for first prompt, follow-up prompt, retry, and resume.
- Backend parity tests for Codex and Claude Code prompt construction.
- Existing explicit recall tests still pass.
- Transcript/projection tests still accept `memory_recall_usage`.
- Grep check: no runtime prompt path reads `company_memory_context` for injection.

Exit criteria:

- No model-facing memory body appears before a tool call.
- Existing recall tools still work.
- Existing repo enforcement paths still work.
- A local Cycloid session completes a small edit with memory present in storage but absent from model-facing prompt context.
- Rollout gate: internal Cycloid business first; continue only after no prompt-start/session-completion regression over a representative internal window.

### Phase 2: Convert Hooks To Reminders

Changes:

- Update `memory-hook-runner.ts` so `UserPromptSubmit` and `PostToolUse` emit only reminder text.
- Preserve `PreToolUse` warn/block behavior.
- Preserve `Stop` verification reminders/blocks.
- Add a small reminder formatter that includes trigger reason and suggested recall tool, but not memory content.

Verification:

- Hook fixture tests prove reminder output omits memory body/content.
- Prompt golden tests prove reminders appear only in intended locations.
- PreToolUse tests prove blocking memories still block.
- Stop tests prove verification obligations still fire.
- Sandbox bridge tests prove hook output is treated as guidance, not prompt memory injection.
- Failure-path tests prove hook errors degrade the same way as before and do not block prompt dispatch unless the old hook already failed closed.

Exit criteria:

- Hooks can steer recall, but cannot inject a memory body.
- Reminder text is stable, short, and golden-pinned.

### Phase 3: Add Context Graph Schema

Changes:

- Add migrations for scopes, peers, sessions/messages, collections/conclusions, source chains, work items, and context query traces.
- Add DAO/service modules under `apps/control-plane-worker/src/company-memory/context-*`.
- Add legacy adapters for `memory_facts`, `memory_takes`, and `repo_memories`.

Verification:

- Migration apply tests for all tables, indexes, constraints, and FTS triggers.
- DAO tests for business isolation, scope/peer uniqueness, session sequencing, collection uniqueness, source-chain traversal, and soft deletion.
- Backfill tests for company facts/takes and repo memory shadows.
- Compatibility tests proving old company/repo retrieval paths continue during dual-write.

Exit criteria:

- New graph can represent current memory without changing runtime recall behavior.

### Phase 4: Add Lexical And Semantic Candidate Generation

Changes:

- Add `repo_memories_fts`.
- Add `memory_conclusions_fts` and `memory_messages_fts`.
- Add `memory_semantic_documents`.
- Add `VectorMemoryIndex` interface with a fake implementation for tests and a Vectorize-backed implementation for Workers.
- Add embedding service with one model/dimension constant.
- Add bounded vector-sync worker and backfill job.

Verification:

- Repo FTS finds older active repo memories that are not in the bridge's local latest-candidate set.
- Vector disabled preserves FTS/graph behavior exactly.
- Fake vector tests cover timeout, empty index, stale id, duplicate id, wrong scope, wrong business, and deleted source.
- Backfill can be interrupted and resumed locally.
- No automated test calls live Vectorize, Workers AI, OpenAI, GitHub, or production APIs.

Exit criteria:

- Candidate generation returns scoped candidates from deterministic, FTS, graph, recent, reinforced, and vector lanes with a trace.
- Vector misses/failures degrade to lexical/graph without broad stale memory.
- Rollout gate: dark-read vector comparison first, then internal enablement, then business allowlist after latency/failure thresholds are met.

### Phase 5: Add Ordering, Fusion, And Trace

Changes:

- Implement candidate normalization.
- Implement hard-evidence floors for exact/path/tool/blocking/graph/scope-card lanes.
- Implement RRF only for independent vector + lexical ranked lists.
- Add `memory_context_queries` trace writes with lane counts, vector availability, fusion mode, candidate ids, rejection reasons, and selector outcome.

Verification:

- Tests prove RRF is not used when vector is unavailable.
- Tests prove exact/path/tool/blocking matches are not diluted by semantic rank.
- Tests prove wrong-scope vector hits are dropped during D1 rehydration.
- Trace snapshot tests prove enough evidence exists to debug every return.
- Tests prove graph/scope-card/exact lanes are not fused by RRF.

Exit criteria:

- We can explain why every candidate reached the selector and why fusion was or was not used.

### Phase 6: Add Bounded Selector Agent

Changes:

- Add selector service using `queryPlatformStructuredOutput` and `OpenAIModel.GPT54`.
- Add local inspection tools scoped to candidate ids.
- Add structured output schema and hard timeout/fallback behavior.
- Wire selector into `cycloid.memory_context`, but keep old wrapper tools.

Verification:

- Selector returns nothing for weak, broad, stale, or wrong-scope candidates.
- Selector returns high-value memories when exact structural and semantic evidence agree.
- Selector cannot inspect non-candidate ids.
- Selector timeout/schema failure returns empty; deterministic block memories are handled by the guardrail path, not top-K recall fallback.
- Prompt-injection fixtures prove candidate text cannot alter selector policy.
- Existing repo/company recall wrappers still return expected results.

Exit criteria:

- Explicit recall is pull-based, scoped, traceable, and selector-gated.
- Selector never blocks a dynamic-tool call beyond timeout.
- Local Cycloid session shows pull retrieval plus selector with successful task completion.

### Phase 7: Add Derivation And Consolidation

Changes:

- Add deriver work items from Slack/session/PR/repo-memory events into `memory_messages` and `memory_conclusions(level='explicit')`.
- Add duplicate reinforcement instead of duplicate rows.
- Add idle-debounced consolidation for `deductive`, `inductive`, and `contradiction` conclusions.
- Add `memory_scope_cards` with typed JSON entries.
- Add scope-card updates only from consolidation.
- Add `memory_scope_card_entries` only if typed JSON becomes hard to validate or query.
- Add `memory_consolidation_runs` only if `memory_work_items` and `memory_context_queries` do not provide enough auditability.

Verification:

- Deriver fixture tests produce self-contained attributed explicit conclusions.
- Duplicate evidence increments reinforcement and source links.
- Consolidation waits for idle threshold and cancels on new activity.
- Derived conclusions cite premises through `memory_conclusion_sources`.
- Scope-card validation rejects behavioral fluff and invalid entry kinds.
- Dry-run consolidation report is reviewed before live compaction.

Exit criteria:

- New memory can be produced and refined Honcho-style without affecting prompt assembly.

### Phase 8: Evals And Rollout

Evals:

- Downvoted June pre-prompt injection cases from `current-state-handoff.md` must return nothing unless the prompt explicitly asks for the implicated topic.
- Positive recall fixture must still return the useful June memory when relevant.
- Perturbation tests across Slack, Linear, GitHub, UI, API, review-loop, paraphrased prompts, and reordered wrappers.
- Honcho-style fixtures for bidirectional visibility, asymmetric visibility, contradiction, reinforcement, and reasoning-chain traversal.
- Baseline comparison: no memory vs old recall vs new pull memory.

Metrics:

- `memory_context.query_started`
- `memory_context.candidates_generated`
- `memory_context.vector_unavailable`
- `memory_context.selector_returned`
- `memory_context.selector_returned_empty`
- `memory_context.feedback_upvoted`
- `memory_context.feedback_downvoted`

Rollout:

- Internal dogfood only.
- Explicit tool only.
- No automatic pre-prompt injection.
- Promote wrappers to use unified tool after parity.
- Keep fast disable paths for retrieval, vector, selector, and consolidation independently.
- Do not consider any prompt-time injection in this plan. Re-adding it requires a separate spec.

Exit criteria:

- Explicit recall precision improves on fixtures.
- Downvoted pre-prompt injection regressions stay empty.
- Selector traces are actionable.
- No customer business receives model-facing memory until explicitly enabled.

## Resolved Decisions

- Vector provider: Cloudflare Vectorize. Phase 4 must build and verify the real Vectorize path, not only a fake interface. Runtime requests can still fail closed or degrade when Vectorize is temporarily unavailable.
- Embedding provider/model: OpenAI `text-embedding-3-small`, 1536 dimensions.
- Selector model: GPT-5.4 with medium reasoning. Add an implementation note that this should later move to an OSS model after parity is proven.
- Automatic pre-prompt memory injection: delete the concept entirely. Do not leave a disabled code path, feature flag, or future re-enable hook.

## Compatibility Backfill Plan

Existing company and repo memory stores cannot disappear when the graph lands. They already power recall, feedback, UI, provenance, repo enforcement, and historical evaluation fixtures.

Backfill means:

1. Leave existing tables and `.cycloid/memory/**` files readable.
2. Create graph rows that shadow existing memories:
   - `memory_facts` -> `memory_conclusions(level='explicit')`.
   - `memory_takes` -> `memory_conclusions(level='deductive' | 'inductive')` based on current kind/source.
   - `repo_memories` -> repo-scoped `memory_conclusions`, while `repo_memories` remains canonical for enforcement until parity.
   - `ingestion_events` -> `memory_sessions`, `memory_messages`, and `memory_conclusion_sources`.
3. Store source links in `memory_conclusion_sources` so every graph conclusion can explain which legacy row or event produced it.
4. Run old retrieval and new graph retrieval side by side in tests/dark-read until returned ids and feedback behavior match or the differences are deliberately accepted.
5. Cut reads over by surface:
   - explicit company recall first,
   - repo recall second,
   - reasoning-chain/provenance third,
   - enforcement last.
6. Only after parity and rollout should legacy reads become compatibility-only. Do not delete legacy data as part of this spec.

This is not a backward-compatibility shim for speculative callers. It is migration safety: the old rows are the source corpus, and the new graph must prove it can represent them before runtime behavior moves.

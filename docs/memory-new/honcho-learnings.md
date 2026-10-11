# Honcho Learnings

Audit of [plastic-labs/honcho](https://github.com/plastic-labs/honcho) for Cycloid's memory system.

## TL;DR

Honcho is a FastAPI memory backend (Postgres + pgvector) with a peer paradigm: every entity (user, agent, group, project) is a **peer**, and memory is keyed by **`(observer, observed)` pairs** — a directional theory-of-mind primitive. Pipeline is **deriver → dreamer → dialectic**: an LLM extracts atomic facts per message batch, an idle-debounced background pass consolidates them with surprisal-guided sampling, and a chat endpoint answers with two-pass retrieval and a reasoning-chain traversal tool.

The "ML" is mostly **prompt engineering + Postgres ergonomics + agent tool loops** — no fine-tuned model, no learned ranker, no RL. The headline ("Pareto frontier of agent memory") points to an external blog/tweet; **no bench numbers, baselines, or reproducibility scripts checked in**. The LongMemEval / LoCoMo / BEAM harness is real and runnable, but you'd have to run it yourself.

Borrowable for Cycloid: **typed observation levels + provenance**, **two-pass retrieval**, **reasoning-chain traversal as a tool**, **idle-debounced background consolidation**, **Postgres-as-queue with work-unit ordering**, **`reasoning_level` enum**, **agent-as-first-class CLI consumer** (JSON on non-TTY, structured error envelopes), and a clean **scenario-judge test harness**.

Skip: pgvector schema verbatim (no D1 equivalent), multi-tenant peer ceremony at our scale, the stateless Cloudflare Workers MCP shim (only works over an already clean stateless REST surface).

---

## 1. Data model — peer paradigm + (observer, observed) collections

Postgres + pgvector. All tables use 21-char nanoid TEXT PKs, JSONB `metadata` / `internal_metadata` / `configuration`, and **composite FKs that always include `workspace_name`** so cross-tenant leakage is structurally impossible.

| Table                   | Purpose                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `workspaces`            | Root tenant                                                                                   |
| `peers`                 | Any participant (user OR agent)                                                               |
| `sessions`              | Conversation context                                                                          |
| `session_peers`         | M:N membership with per-membership config, `joined_at`, `left_at`                             |
| `messages`              | Raw I/O — BigInt id + 21-char public_id, `seq_in_session` unique, GIN FTS index               |
| `message_embeddings`    | Decoupled embeddings with `sync_state` (pending\|synced\|failed), HNSW index                  |
| `collections`           | **Keyed by `(observer, observed, workspace)`**                                                |
| `documents`             | The memory unit: `content`, `embedding`, `level`, `times_derived`, `source_ids`, `deleted_at` |
| `queue_items`           | `task_type ∈ {representation, summary, reconciler, dream}`, JSONB payload                     |
| `active_queue_sessions` | Cross-instance work-unit lock                                                                 |

**Central conceptual move**: a Collection is keyed by a _pair_ of peers. `observer == observed` is self-representation; `observer != observed` is directional theory of mind ("what Alice believes about Bob"), separate from Bob's self-model. Perspectives can disagree without overwriting.

**Document `level` taxonomy**:

- `explicit` — extracted directly from a message
- `deductive` — inferred from premises (carries `source_ids` + `premises`)
- `inductive` — pattern across multiple sources (with `pattern_type` + `confidence` derived from source count: 2=low, 5+=high)
- `contradiction` — flags conflicting deductions

`source_ids` is a JSONB array with a GIN index so a `get_reasoning_chain` tool can traverse premise → conclusion.

**Conclusions API** (public name for Documents): `POST /conclusions` (batch ≤100), `POST .../list` (paginated), `POST .../query` (semantic — requires observer+observed filter), `DELETE .../{id}`.

**Borrow for Cycloid:**

- **Document `level` taxonomy with `source_ids` reasoning chain** — splits "fact extracted from this session" vs "consolidated inference across many sessions" vs "this contradicts a prior memory." Our analyzer flattens today; levels with source links give dedup, promotion paths, and a "why do you believe this" affordance.
- **`(observer, observed)` pair-keyed memory namespace** — even single-tenant, `(observer=agent_persona_or_codex_version, observed=repo)` tracks "what did Codex 5 learn vs Codex 6" or Claude-vs-Codex preferences on the same repo without collisions.
- **`sync_state` decoupling on writes** — `pending|synced|failed` + `last_sync_at` + `sync_attempts` + reconciler. Apply to AGENTS.md publish: write memory rows to D1 with sync_state, let a worker batch-write to the repo so the session HTTP path never blocks on PR/branch I/O.
- **`times_derived` + soft-delete (`deleted_at`)** — cheap reinforcement-count ranking signal; soft delete lets the analyzer learn from rejections.
- **`seq_in_session` (unique per session) + clone-at-cutoff** (`POST /sessions/{id}/clone` with optional `message_id`) — cheap session branching for replay/debug; matches our durableStep replay story.

**Skip:**

- **pgvector + HNSW verbatim** — D1 has neither. Port the _typing_, not the storage. For vectors: Cloudflare Vectorize or keyword-only.
- **Composite FKs everywhere with `workspace_name`** — awkward in D1; keep workspace scoping at the service layer.
- **First-class peer rows for every human + agent persona** — overhead at our scale. A lighter `(actor_type, actor_id, repo_id)` tuple captures the idea without a peers table.

## 2. Deriver — fast atomic-fact extractor

`src/deriver/deriver.py` runs **one LLM call per message batch** per `(session, observed_peer)` work unit. Single 30-line prompt: "extract explicit atomic facts about {peer_id}" — each fact self-contained, absolute dates, properly attributed.

Output is a `PromptRepresentation` (Pydantic, `json_mode=True`) split into 4 levels. The deriver only writes `explicit`; other slots exist so dreamer output round-trips through the same `Document` table.

**Fan-out cost**: the same fact is written to _every_ observer's collection of this peer (`deriver.py:202-218`) — one LLM call, N writes. Fine at low peer counts, expensive at high.

**Borrow for Cycloid:**

- **Single structured-output LLM call per message batch** with absolute-date / self-contained / attributed constraints — a concrete prompt shape that beats our freeform extraction.
- **Telemetry per batch** (`RepresentationCompletedEvent` with token + latency breakdowns) — easy to add to our analyzer.

## 3. Dreamer — idle-debounced consolidation with surprisal sampling

Most algorithmically interesting piece.

- **Scheduler** (`dream_scheduler.py`): triggered when `current_explicit_count - last_dream_count >= threshold`; waits `IDLE_TIMEOUT_MINUTES` and **cancels pending dreams on new user activity**; enforces `MIN_HOURS_BETWEEN_DREAMS`.
- **Surprisal pre-filter** (`src/dreamer/surprisal.py` + `trees/{covertree,rptree,lsh}.py`): embeds observations, builds a tree, computes geometric surprisal — observations far from cluster centroids. Top-N feed in as **hints** (not constraints).
- **Two sequential specialists** (`orchestrator.py::run_dream`), both with tool harness (`get_recent_observations`, `search_memory`, `search_messages`, `create_observations_*`, `delete_observations`, `update_peer_card`):
  - `DeductionSpecialist` — produces `deductive` observations with `source_ids` + `premises`, flags contradictions, updates the **peer card**. Max 12 iterations, 8192 tokens.
  - `InductionSpecialist` — emits `inductive` observations with `pattern_type` (preference/behavior/personality/tendency/correlation) and confidence-from-source-count. Never touches the peer card.
- **Peer card** is a structured identity store with 4 strict entry kinds: `IDENTITY:`, `ATTRIBUTE:`, `RELATIONSHIP:`, `INSTRUCTION:`. Explicitly rejects behavioral/trait entries — only stable markers.

**Borrow for Cycloid:**

- **Idle-debounced background consolidation** — cancel pending re-reasoning on new user activity; fire after N idle minutes. Cheaper than per-message work; matches "wait until the user stops iterating on a session."
- **Surprisal-guided sampling** — cluster embeddings, re-reason on outliers. Even without trees, centroid-distance gives ~80% of the value. For Cycloid: "look harder at sessions whose tool-call patterns are far from cluster."
- **Two-specialist split** — one for typed deductions + peer-card updates, one for patterns. Cleaner than one prompt doing both.
- **Peer card as a separate structured store** with strict entry kinds and reject-on-format violation. For Cycloid: a `user_profile` / `repo_profile` table updated only by background reasoning, never by the chat path — stable identity facts out of the noisy observations stream.

## 4. Reconciler — vector-store self-healing, not contradiction resolution

Despite the name, `src/reconciler/scheduler.py` is just two periodic tasks:

1. `sync_vectors` — finds `sync_state="pending"` rows, re-embeds, upserts to vector store, 10-min flat backoff, 20-attempt ceiling. Cleans up soft-deleted documents.
2. `cleanup_queue` — GCs old processed queue items every 12h.

Contradiction handling is NOT here — the deduction specialist creates `contradiction`-level observations and deletes outdated sources.

**Borrow for Cycloid:** the **reconciler pattern with sync_state + attempt cap** as the canonical retry primitive for any async write (memory → AGENTS.md, embeddings, external integrations).

## 5. Dialectic chat — two-pass retrieval + reasoning-chain tool

`POST /workspaces/{ws}/peers/{peer_id}/chat`. Body: `{ query, session_id?, target?, stream?, reasoning_level: minimal|low|medium|high|max }`. `peer_id` is the observer; `target` is the observed (defaults to self → omniscient mode).

**Pipeline:**

1. **Preflight** loads observer's self peer-card + observer's card _of_ observed; injects as `<observer_peer_card>` / `<observed_peer_card>`.
2. **Session history** injected up to `SESSION_HISTORY_MAX_TOKENS`.
3. **Two-pass prefetch** with one embedding, two parallel semantic searches: `["explicit"]` and `["deductive","inductive","contradiction"]` separately — "to prevent retrieval dilution." 25 each (10 for `minimal`).
4. **Agentic loop** with tools: `search_memory`, `get_reasoning_chain`, `search_messages`, `grep_messages`, `get_observation_context`, `get_messages_by_date_range`, `search_messages_temporal`. System prompt enforces explicit workflows for enumeration (mandatory grep + dedup table) and contradiction detection. ~230 lines.

**`reasoning_level`** simultaneously swaps model, tool set, prefetch window, max iterations, output cap, and `tool_choice`. One knob.

**Borrow for Cycloid:**

- **Two-pass retrieval to prevent dilution** — split "similar past sessions" into (a) raw session-event matches and (b) higher-order summaries/conclusions, so verbose derived blobs don't crowd out concrete events.
- **`get_reasoning_chain(id)` as a tool** — store memories with backpointers to specific PRs/sessions/tool calls; the agent drills into provenance only when needed. Beats blob injection.
- **`reasoning_level` enum** as a single dial swapping model + tools + prefetch + iterations + output cap + tool_choice; surfaces cost/latency to the planner.
- **Enumeration playbook in the prompt** — "grep-first + ≥3 semantic searches + dedup table" for "how many PRs touched X" queries our agent currently gets wrong.
- **Explicit "abstain rather than fabricate" gate** in the system prompt.

## 6. Queue — Postgres-backed, no Redis

`QueueItem` + `ActiveQueueSession` tables. Work-unit key is the ordering primitive: `representation:{workspace}:{session}:{observed}`, `dream:{type}:{workspace}:{observer}:{observed}`.

`QueueManager.polling_loop` polls every `POLLING_SLEEP_INTERVAL_SECONDS`, claims work units via `INSERT ... ON CONFLICT DO NOTHING RETURNING` against `ActiveQueueSession` — the cross-instance lock. `with_for_update(skip_locked=True)` handles stale cleanup. Representation tasks **batch**: a work unit only claims when accumulated message tokens ≥ `REPRESENTATION_BATCH_MAX_TOKENS`.

**Borrow for Cycloid:**

- **DB-as-queue with work-unit ordering** maps onto D1 + control-plane. The `ActiveQueueSession` claim pattern (insert-on-conflict-do-nothing) gives durable per-session ordered processing without new infra. Directly relevant to ARC-1012's durableStep work.
- **Token-threshold batching** for background work — flush a work unit only when accumulated payload crosses a size threshold. Cuts LLM call frequency.

## 7. MCP server (Cloudflare Workers, stateless shim)

`mcp/src/index.ts` is a single Cloudflare Worker over `@modelcontextprotocol/sdk` McpServer. ~30 tools across 5 modules (workspace / peer / session / conclusion / system).

Notable choices:

- **`reasoning_level` enum** on the `chat` tool as an agent-visible cost/quality dial.
- **Per-call scope via headers**: `Authorization` + `X-Honcho-Workspace-ID` + `X-Honcho-User-Name` + `X-Honcho-Assistant-Name`.
- **Multi-line `.describe()` on every Zod input** — "what / when to use / returns" becomes agent-facing docs.
- Common `textResult` / `errorResult` envelope JSON-stringified into MCP content.

**The decomposition only works because Honcho's REST API is already a clean stateless surface with per-request scoping.** Cycloid would have to first expose the bridge as a clean stateless REST API before this fits.

**Borrow for Cycloid:**

- **Multi-line tool descriptions** ("what / when to use / returns") raise tool-call accuracy more than re-prompting.
- **`reasoning_level` enum** as an agent-facing dial.
- **Header-driven scope** (`Authorization` + `X-Cycloid-Business` + `X-Cycloid-Repo`) if we ever build a stateless API surface.

## 8. CLI — first-class agent consumer

Installed via `uv tool install honcho-cli`. Audience is operators AND agents:

- **Auto-emits JSON when stdout isn't a TTY** (or `HONCHO_JSON=1`).
- **Structured error envelopes** (`{error: {code, message, details}}`).
- **Env-var precedence** `flag → env → config → default`.
- Installable **skill** (`npx skills add plastic-labs/honcho`) for Claude Code / OpenCode.
- `honcho doctor` — structured JSON health check.

**Borrow for Cycloid:**

- **JSON-on-not-a-TTY + structured error envelopes** for the `cycloid` CLI — simplifies sandbox-bridge error handling.
- **`doctor` command** producing structured JSON — perfect for bridge sandbox-health verification.
- **Env-var precedence rule** documented and enforced.

## 9. Webhooks — DB-queued with HMAC signing

Two events today (`queue.empty`, `test.event`). Events publish to the `QueueItem` table; the deriver worker polls and fires `httpx.post` in parallel via `asyncio.gather`, signing with HMAC-SHA256 over canonical JSON in `X-Honcho-Signature`. Per-workspace URLs.

**Borrow for Cycloid:** **DB-queued webhook delivery + HMAC signing** with canonical JSON — replay-safe webhook fanout for our session-DO event streams.

## 10. Scoped JWTs

Single symmetric HS256 JWT with tiny payload: `t` (created), `exp`, `ad` (admin), `w` (workspace), `p` (peer), `s` (session). Hierarchy `admin > workspace > {peer, session}`. `auth()` walks: admin → session → peer → workspace. `POST /keys` (admin-only) mints scoped tokens.

**Borrow for Cycloid:**

- **Hierarchical scope walk** (admin → session → repo → business) for sandbox-issued tokens.
- **Compact field names** in JWT payload — small tokens for header-bound contexts.

## 11. Benchmarks and test rigor

**Benchmark harness** (`tests/bench/`): LongMemEval, LoCoMo, BEAM, OOLONG, Molecular. Each has a `*_baseline.py` (raw LLM, no Honcho) and `*_common.py` (judge prompt + statistics). Boots local Postgres + API + deriver via `harness.py`.

**Unified test framework** (`tests/unified/`): ~50 JSON test cases including `observation_2peer_bidirectional`, `observation_2peer_unidirectional`, `observation_2peer_observe_me_false_blocks_observation`, `observation_3peer_circular`, `observation_4peer_complex_matrix`, `observation_asymmetric_visibility`, `dialectic_reasoning_levels`, `dream_knowledge_updates_and_patterns`, `longmem_*` regression slices. Assertions: `llm_judge | contains | exact_match | json_match`.

**Borrow for Cycloid:**

- **JSON scenario harness with LLM-judge assertions** for sandbox-bridge memory injection. Define fixture past sessions + expected behavior on a new task, judge with Claude. Low-friction regression coverage missing today.
- **Baseline + system comparison harness** — same eval, raw LLM vs LLM+memory, identical judge. Forces honest measurement.

## 12. What we explicitly do NOT borrow

- **pgvector + HNSW + Postgres `to_tsvector` GIN FTS** — wrong stack for D1.
- **Multi-tenant `Workspace`/`Peer` ceremony** — overhead at our scale.
- **Per-observer fan-out** writing the same fact N times — expensive at high peer counts.
- **Stateless Cloudflare Workers MCP shim** — the Cycloid bridge holds rich Codex-process state that doesn't map onto a stateless fetch handler.
- **Dreamer's full agentic tool loop with 12 iterations per consolidation** — fine for human-chat scale, expensive for our session volume. Borrow idle-debounce + surprisal; cap iterations lower.
- **"Dialectic" branding** — it's RAG-over-observations with a peer-card preamble, not Hegelian reasoning.

## 13. Skeptical caveats

- **"Pareto frontier of agent memory"** is a README claim pointing to external blog/tweet/evals page. No numbers, baselines, or tables in-repo; bench runners are real but you must run them. Treat as marketing.
- **No bench results checked in** — `tests/bench/eval_results/` is absent. `incorrect_beam_qs.txt` exists — at least honest about failure cases.
- **Judge bias** — unified tests use Claude as judge; passing proves "Claude thinks the answer is fine," not ground truth.
- **Dialectic unit-test coverage is anemic** — one 111-line file verifying reasoning levels select the right model config; behavioral guarantees live in the JSON harness only.
- **Prefetch counts (10/25) are heuristic** — no ablation in-repo.
- **230-line dialectic system prompt** does heavy lifting — hard to separate architecture wins (observations + reasoning trees) from prompt-engineering wins.
- **"Surprisal trees" are the only real algorithm** but optional, gated on `TREE_K * 2` observations, and only seed hints. Most value comes from specialist loops + prompts.
- **The "ML" is mostly prompt engineering and Postgres ergonomics.**

---

## Recommended Cycloid next steps (priority order)

1. **Document `level` taxonomy** (`explicit | deductive | inductive | contradiction`) **with `source_ids` reasoning chain** — fixes our flat-memory problem and enables a `get_reasoning_chain` tool.
2. **`sync_state` decoupling on memory writes** — D1 row with `pending|synced|failed`, worker batches AGENTS.md PR fanout; session HTTP path never blocks on Git/PR I/O.
3. **Two-pass retrieval to prevent dilution** — raw events vs derived summaries, equal limits, no cross-pollution.
4. **`get_reasoning_chain` tool** — backpointers; agent drills into provenance only when needed.
5. **DB-as-queue with work-unit ordering** for background consolidation — durable per-session ordered processing on D1 + control-plane (relevant to ARC-1012 durableStep).
6. **Idle-debounced background consolidation** — cancel on new user activity, fire after N idle minutes; pair with surprisal sampling (centroid-distance is enough).
7. **Peer-card-style structured profile** — strict entry kinds (`IDENTITY: / ATTRIBUTE: / RELATIONSHIP: / INSTRUCTION:`) updated only by background reasoning.
8. **`reasoning_level` enum** on retrieval/synthesis paths — one dial → model + tools + prefetch + iterations + cap.
9. **JSON scenario test harness with LLM-judge** for memory regression coverage.
10. **CLI: JSON on non-TTY + structured error envelopes + `doctor` command.**
11. **Enumeration playbook in our agent prompt** ("grep-first + ≥3 semantic searches + dedup table") + explicit abstain gate.
12. **DB-queued webhook delivery + HMAC signing** for replay-safe session-DO event fanout.
13. **`times_derived` + soft-delete `deleted_at`** on memory rows.

## Key file references in honcho repo

- `src/models.py` — full ORM schema
- `src/routers/peers.py`, `sessions.py`, `messages.py`, `workspaces.py`, `conclusions.py` — API surface
- `src/schemas/api.py` — Conclusion schemas
- `src/utils/types.py:240` — `DocumentLevel` enum
- `src/deriver/{deriver.py, prompts.py, queue_manager.py, enqueue.py, consumer.py}` — fast extraction pipeline
- `src/dreamer/{orchestrator.py, specialists.py, surprisal.py, dream_scheduler.py, trees/}` — consolidation pipeline
- `src/reconciler/{scheduler.py, sync_vectors.py, queue_cleanup.py}` — sync_state + reconciler
- `src/dialectic/{chat.py, core.py, prompts.py}` — agentic chat endpoint (~230-line system prompt)
- `src/utils/{representation.py, work_unit.py, agent_tools.py, peer_card.py}` — shared primitives
- `src/crud/{representation.py, peer_card.py}` — observer/observed CRUD
- `mcp/src/index.ts`, `mcp/src/server.ts`, `mcp/src/tools/{workspace,peers,sessions,conclusions,system}.ts`, `mcp/instructions.md`, `mcp/wrangler.toml` — Cloudflare Workers MCP shim
- `sdks/{python, typescript}/` — Honcho client SDKs
- `honcho-cli/` — CLI patterns
- `src/webhooks/{events.py, webhook_delivery.py}` — HMAC-signed queue fanout
- `src/security.py`, `src/routers/keys.py` — scoped JWT
- `tests/unified/test_cases/observation_*.json` — multi-peer test fixtures
- `tests/bench/{README.md, longmem.py, locomo.py, beam.py, harness.py}` — bench runners
- `docs/v3/documentation/core-concepts/representation.mdx`, `features/chat.mdx` — design rationale

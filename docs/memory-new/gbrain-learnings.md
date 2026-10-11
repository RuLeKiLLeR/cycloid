# GBrain Learnings

Audit of [garrytan/gbrain](https://github.com/garrytan/gbrain) for Cycloid's memory system. Lens: GBrain isn't Slack-native but our goal is — extract surface-agnostic patterns and assess what survives a Slack-native port vs requires rebuild.

## TL;DR

Most concretely engineered system audited: 85 typed operations, knowledge graph as pages-and-typed-edges (no separate graph DB), LLM-free entity extraction via hand-tuned verb regexes, takes-vs-facts two-store epistemology, dream-cycle phases consolidating hot facts → cold takes nightly, gap analysis as first-class output, OAuth 2.1 + PKCE so ChatGPT/Claude Desktop/Cursor can use it as MCP, and an `INSTALL_FOR_AGENTS.md` install protocol written for an LLM to execute.

**Slack lens**: knowledge graph, dream cycle, multi-tenant scoping, takes/facts split, hybrid retrieval, voice gate, OAuth scoping all survive a Slack-native port. Does NOT survive: output story (host agent owns delivery — no `OutputChannel` interface), session model (request-scoped — no durable `session_id = thread_ts`), conversation parser (assumes finished one-shot transcripts, not streaming accumulation).

**Highest-leverage borrows**:

1. **Pages-as-entities + links-as-typed-edges** in D1 (two tables with verb columns, no graph DB).
2. **Hand-tuned verb regexes** for Cycloid verbs (`uses_framework`, `depends_on`, `supersedes`, `reviewed_by`, `blocks`) — zero-LLM typed-edge extraction.
3. **Takes vs facts as two stores** with one-way nightly bridge (hot per-conversation facts → cold consolidated takes).
4. **Voice gate per output surface** (in-thread "nudge" vs CLI banner vs PR comment) with Haiku-judged tone + template fallback.
5. **Gap analysis as first-class output** — every Cycloid Slack response ends with a "what I don't know" note (builds trust like GBrain's "heads up: nothing's been added since April 22").
6. **Single `Operation[]` registry + one schema mapper** feeding stdio MCP, HTTP MCP, web routes, Slack commands.
7. **`INSTALL_FOR_AGENTS.md` pattern** — numbered steps, `[AGENT]`-prefixed stdout markers, JSON envelopes, explicit "DO NOT SKIP" cost gates.
8. **Code-for-data, LLMs-for-judgment** — deterministic URL/slug/SHA construction; never let the agent compose these.

**Skip**: the 1318-line `schema.sql` (mostly ops), the 43-skill scaffolding (we have Claude Code skills), in-process scoped DB defaults (we need real multi-tenant day one), auto-think / drift / anomaly phases (scaffold-only in v0.40).

---

## 1. The knowledge graph — pages + typed edges in two tables

**Biggest takeaway of the audit.** No separate entities or edges tables; two primitives:

- **Entities = `pages` rows where `type IN ('person','company','organization','entity')`** (`src/core/by-mention.ts:33`). Identity = `(source_id, slug)`. Title is display name. Frontmatter (JSONB) carries attributes. Indexes: GIN on frontmatter, trigram on title, FTS on `search_vector`.
- **Typed edges = `links` rows** (`src/schema.sql:399-428`). Columns: `from_page_id`, `to_page_id`, `link_type TEXT` (the verb: `works_at`, `invested_in`, `founded`, `advises`, `attended`, `mentions`, `image_of`, `supersedes`, …), `link_source IN ('markdown','frontmatter','manual','mentions')`, `link_kind IN ('plain','typed_ner')`, `origin_page_id`, `origin_field`, `resolution_type`, `context`. UNIQUE `(from, to, type, source, origin) NULLS NOT DISTINCT`.

The "graph" is `SELECT id, link_type FROM links`; multi-hop is recursive CTEs.

### Other relevant tables in the same DB

- `takes` — `claim, kind ('fact'|'take'|'bet'|'hunch'), holder, weight REAL [0..1], since_date, until_date, source, superseded_by, active, embedding VECTOR(1536)` with HNSW partial index. Multi-holder beliefs.
- `facts` — `entity_slug, fact, kind ('event'|'preference'|'commitment'|'belief'|'fact'), visibility, notability, valid_from, valid_until, expired_at, superseded_by, consolidated_at, consolidated_into, source_session, confidence, embedding`. Single-user hot memory.
- `synthesis_evidence` for take→take citations.
- `timeline_entries(page_id, date, source, summary, detail)` for structured temporality.
- `slug_aliases` for entity dedup.
- `code_edges_chunk` / `code_edges_symbol` — same edge model at chunk/symbol grain.

### Borrow for Cycloid

- **`memory_pages` + `memory_links` in D1** — two tables carry 95% of the value. Edge model `(from_id, to_id, link_type, link_source, origin_page_id, origin_field, resolution_type)` is directly portable. `UNIQUE NULLS NOT DISTINCT` lets us re-ingest a session without clobbering other sessions' edges.
- **Per-edge `link_source` + `origin_page_id` + `origin_field`** so reconciliation only touches edges THIS write owns — critical for safe re-ingestion.
- **`code_edges_*` style fine-grained code graph**: `(file_id, file_id, link_type='imports'|'extends'|'calls'|'references')` from existing parsers — high-leverage for "which PRs touch the same module."

## 2. LLM-free entity extraction + typed-edge inference

Two cheap passes, no NER library, no model:

1. **Gazetteer build** (`buildGazetteer` in `src/core/by-mention.ts`): one SQL pull of all entity-typed pages → `Map<lowercase-first-token, GazetteerEntry[]>`. Hardcoded ignore list (`Apple`, `Amazon`, `Stripe`, `Box`, `Meta`) suppressed unless user explicitly created such a page. `MIN_NAME_LENGTH = 4` avoids `AI`/`YC` noise.
2. **Per-page mention scan** (`findMentionedEntities`): tokenize body with `/[a-zA-Z0-9]+/g`, look up by first token, **maximal-munch** (longest multi-token match wins), self-link guard, cross-source guard, first-mention-only-per-target cap.

**The catalog is the source of truth.** Entities only exist if a `people/foo.md` or `companies/bar.md` page exists. No NER discovers new entities from raw text.

### Edge typing without an LLM

`src/core/link-extraction.ts:431-558` — hand-tuned regexes calibrated against a 240-page rich-prose benchmark:

```
WORKS_AT_RE   = /\b(?:CEO of|CTO of|VP at|works at|joined as|engineer at|
                 (?:senior|staff|principal|lead) engineer at|
                 (?:his|her|their) time at)\b/i
INVESTED_RE   = /\b(?:invested in|backed by|funded by|led the (?:seed|Series)|
                 early investor|portfolio (?:company|includes))\b/i
FOUNDED_RE    = /\b(?:founded|co-?founded|founder of|founders? (?:include|are))\b/i
ADVISES_RE    = explicit advisor-rooted phrasings, excludes generic "board member"
```

Two inference layers (`inferLinkType`):

1. **Per-edge**: ~240-char window around the slug mention, first matching verb regex wins (precedence `founded > invested_in > advises > works_at`).
2. **Page-role prior**: if per-edge falls through to `mentions` AND `pageType === 'person'` AND target is `companies/…`, check the WHOLE page for `PARTNER_ROLE_RE`/`ADVISOR_ROLE_RE`/`EMPLOYEE_ROLE_RE`. Catches partner bios listing portcos without repeating "invested in."

Two regex-free type rules: `pageType === 'meeting' → 'attended'`; `pageType === 'image' → 'image_of'`.

Second deterministic path is **schema-pack-driven** (`src/core/schema-pack/link-inference.ts` + `src/core/extract-ner.ts`): users declare `link_types[].inference.regex` and `inference.page_type` in YAML packs, run under a ReDoS budget. Pack verbs WIN over built-ins.

### Borrow for Cycloid

- **Ship Cycloid verbs**: `USES_FRAMEWORK_RE`, `DEPENDS_ON_RE`, `SUPERSEDED_BY_RE`, `REVIEWED_BY_RE`, `BLOCKS_RE`, `AUTHORED_BY_RE`, `MENTIONED_IN_RE`. Same precedence + page-role-prior structure. Especially: `uses_framework` from `package.json`/imports → `(repo_page → framework_page)` edge.
- **Maximal-munch tokenizer + first-token-keyed gazetteer** as the canonical entity-recognition pattern. Cheap, deterministic, debuggable.
- **Page-role priors** — session page mentions a file → default `touched`; PR page mentions a user → `reviewed_by` only if author role pattern hits.
- **Resist the schema-pack abstraction** until customer demand justifies it. Value is concentrated in 3-4 verbs.

## 3. Takes vs facts — two-store epistemology

Source: `docs/takes-vs-facts.md`.

- **Takes** = cold storage. Multi-holder beliefs about anyone, LLM-extracted from page markdown. `holder` is who BELIEVES the claim (`world` | `brain` | `people/<slug>` | `companies/<slug>`). Kinds: `fact|take|bet|hunch`. Canonical in markdown fences (`<!--- gbrain:takes:begin -->` table), mirrored to the `takes` table.
- **Facts** = hot memory. Single-user (brain owner only), real-time per-conversation-turn extraction by Haiku. Kinds: `event|preference|commitment|belief|fact`.

**One-way bridge**: the "consolidate" dream phase promotes durable facts → takes nightly, marking source facts `consolidated_at` + `consolidated_into`.

**Append-only with supersession**. Takes use `superseded_by` + `active BOOLEAN` (strikethrough `~~claim~~` in fence) so row numbers never shift — cross-page refs `slug#N` stay valid forever. Facts use `superseded_by` + `expired_at` + `valid_until`.

### Borrow for Cycloid

- **Two stores**: per-session "facts" (extracted live from a Codex run) and per-repo "takes" (consolidated, multi-source, multi-holder). Nightly consolidate promotes facts surviving their TTL into takes.
- **`holder` = who believes** — `brain` (Cycloid's observation), `users/shivam` (user-stated preference), `world` (objective fact). Tracks "this user prefers X" separately from "this repo objectively uses X."
- **Append-only fenced table in `AGENTS.md`** (the `<!--- gbrain:takes:begin -->` shape). Strikethrough supersession with stable row numbers, far less destructive than rewriting prose.
- **`since_date` / `until_date` intervals on takes**: "Alice worked at Acme 2022–2024" = one `takes` row + one `links` row `(alice, acme, works_at)`. Interval lives on the take, not the edge.

## 4. Effective date — when was this true, not when was it written

`src/core/effective-date.ts`. Two patterns:

1. **Per-page `effective_date`**: precedence chain `frontmatter.event_date → .date → .published → filename YYYY-MM-DD → updated_at → created_at`, per-prefix override (`daily/`, `meetings/` hoist filename-date to position 1). Range-validated to `[1990-01-01, NOW + 1y]`. `effective_date_source` enum stored so the doctor can detect "fell back to updated_at" pages.
2. **Per-claim interval**: takes have `since_date` + `until_date`; facts have `valid_from` + `valid_until` + `expired_at`.

### Borrow for Cycloid

- Same problem: `updated_at` churn vs "when was this true." Ship `computeEffectiveDate` semantics for memory entries from PRs/sessions.

## 5. Resolvers / dedup

`src/core/entities/resolve.ts`: given raw "Alice", try (1) exact slug match, (2) pg_trgm fuzzy match on slug+title, (3) prefix expansion `people/alice-%` then `companies/alice-%` with link-count tiebreaker, (4) `slugify()` fallback. Returns `'exact_page' | 'fuzzy_match' | 'fallback_slugify'` so callers can gate on resolution quality.

Plus: `slug_aliases` table for explicit aliases, in-process LRU `(source_kind, content_hash) → seen` with 24h TTL, content-hash on pages for write-time skip.

### Borrow for Cycloid

- **Two-layer dedup**: content-hash skip on write + per-process LRU on ingest source. Lifts straight into the control plane worker pattern.
- **Resolution-quality enum** returned with the slug — callers can refuse to act on `fallback_slugify` matches.

## 6. Dream cycle — single primitive, many phases

There is **no "66 cron jobs" inside gbrain** — that's Garry's external OpenClaw deployment. The real dream cycle is **one cycle primitive** (`src/core/cycle.ts`) with fixed phase ordering, invoked three ways: `gbrain dream` (one-shot CLI), `gbrain autopilot` (daemon), the `autopilot-cycle` Minion handler.

Core phases in order: `lint` → `backlinks` → `sync` → `synthesize` → `extract` → `extract_facts` → `resolve_symbol_edges` → `patterns` → `recompute_emotional_weight` → `consolidate` → `propose_takes` → `grade_takes` → `calibration_profile` → `embed` → `orphans` → `purge` → `schema-suggest` → `extract_atoms` → `synthesize_concepts` → `conversation_facts_backfill`.

Deferred/scaffold standalone modules: `auto-think.ts` (re-runs `gbrain think` on operator questions), `drift.ts` (flags takes whose evidence shifted — v0.29 TODO), `anomaly.ts` (statistical cohort spike detection), `nightly-quality-probe.ts`, `phantom-redirect.ts` (rewrites unprefixed slugs).

**Coordination**: single Postgres `gbrain_cycle_locks` row (30-min TTL, refreshed between phases) or PGLite filelock. Read-only phases skip the lock.

### Borrow for Cycloid

- **Single cycle primitive, multiple invocation surfaces** — same `runCycle()` callable from CLI, Workers cron, manual API, durable queue handler.
- **Phase ordering as data**, not code — enable/disable/reorder per-customer.
- **30-min advisory lock** doesn't translate to Workers; use a Durable Object lock.

## 7. Synthesis + gap analysis — RRF fusion + structured `gaps[]`

`runThink()` in `think/index.ts`: INTENT → GATHER → SYNTHESIZE → optional COMMIT.

**GATHER** runs four retrievers in parallel, fused with **reciprocal-rank fusion (k=60)**:

1. Hybrid page search (vector + keyword)
2. Takes-keyword
3. Takes-vector
4. Anchor-entity subgraph traversal (depth 2)

**SYNTHESIZE** ships pages, takes, and optional subgraph as `<pages>`, `<takes>`, `<graph>` XML blocks. v0.40.2 added a `<trajectory>` block grouping facts by `(metric ?? event_type)` with per-metric (20) and total (100) caps.

**Output is strict JSON**: `{answer, citations[{page_slug, row_num, citation_index}], gaps[]}`. `cite-render.ts` resolves citations, with a regex fallback for models that inline `[slug#row]` but omit the structured field.

### Honest read on gap analysis

"Heads up: nothing's been added about Alice since April 22, six weeks ago" is **LLM-generated prose, not deterministic computation**. The system prompt instructs the model to emit `gaps[]`. Staleness-shaped inputs available to it:

- Take rows carry `since_date`, `weight`, `kind`, `holder`
- `pages.last_retrieved_at` (5-min throttled write-back)
- Trajectory points chronologically ordered with explicit gaps
- **No code computes "X days since last write."** The model is _trusted_ to infer staleness from prompt timestamps.

### Borrow for Cycloid

- **RRF fusion of multiple retrievers** including graph traversal — fuse session memory + repo grep + entity-graph (PR/issue links) with k=60.
- **Structured JSON answers with `gaps[]` first-class** — forces honesty, gives downstream consumers something to act on. Cycloid session summaries should include an explicit "uncertain about" array.
- **Throttled `last_retrieved_at`** (5-min throttle, ~90% writes dropped, bounded drain before disconnect) for D1 access tracking without write amplification.

## 8. Self-correcting citations + contradictions

`filing-audit.ts` is narrower than it sounds — audits skill manifests' `writes_to:` against `skills/_brain-filing-rules.json`, NOT answer citations. What actually self-corrects:

- `synthesize_concepts` + synthesis pages persist `synthesis_evidence` with page-id FKs; bad slugs get `CITATION_PAGE_NOT_IN_BRAIN` warnings instead of dangling refs.
- `phantom-redirect.ts` migrates `alice.md` → `people/alice-example` and rewrites links, facts, embeddings.

**Contradictions** (`src/core/eval-contradictions/`): hybrid search top-K → cross-slug + intra-page-chunk-vs-take pairs → A1 date pre-filter → deterministic vs score-first sampling → persistent judge cache → cost ceiling. Judge is query-conditioned Haiku returning `{contradicts, confidence, resolution_kind, severity}`. **Never auto-applies** — emits paste-ready CLI commands (`takes_supersede`, `dream_synthesize`, `takes_mark_debate`, `manual_review`).

### Borrow for Cycloid

- **Contradiction probe that never auto-resolves** — emits proposals, not silent overwrites. Conflicting facts surface as PRs the user reviews.
- **Cost-tracker pre-flight + mid-run ceiling** on every background phase. Every background extraction gets a USD cap with greppable "actual vs estimated" line.
- **Judge cache + confidence floor** — Haiku judge cached by `(query, page_a, page_b)`; confidence < 0.7 double-enforced to false.

## 9. Calibration voice gate — Haiku judge + template fallback

`src/core/calibration/voice-gate.ts` is one Haiku-judged function shared across **five surfaces**: `pattern_statement`, `nudge`, `forecast_blurb`, `dashboard_caption`, `morning_pulse`. Up to 2 regeneration attempts; on failure, falls back to hand-written `templates.ts` slot. Failures land in `calibration_profiles.voice_gate_passed/voice_gate_attempts` for operator review.

**Suppression is explicitly not an option.** The rubric is mode-tuned, not the gate, so voice can't drift across surfaces.

Voice principles (DESIGN.md):

- Second person, contractions allowed
- Grounded in concrete data ("2 of 3 missed" beats "Brier 0.31")
- Never preachy. Never "we recommend." Never "according to your data."
- Short. Under 25 words for narrative; under one line for status.
- Numbers grounded in real outcomes.

### Borrow for Cycloid — directly applicable to Slack outputs

- **Voice gate per surface**: Slack-thread `nudge`, PR-comment `review`, web-UI `dashboard_caption`, daily Slack DM `morning_pulse`. Different rubrics, same gate primitive.
- **Two regen attempts, then static template, never silent suppression** — failure rate becomes operator-visible signal.
- **The DESIGN.md voice principles are gold** — copy verbatim into our output style guide, especially "Never preachy. Never 'we recommend.'"

## 10. Multi-tenant scoping — row-level via `source_id`

Tenancy axis is `source_id`. Every page, fact, chunk, embedding, link, timeline entry carries it; every read filters `WHERE source_id = $X`. Sources are first-class rows; `CASCADE` delete cleans everything.

**Login → query filter chain**:

- OAuth client row has `source_id` (write scope) + `federated_read TEXT[]` (read scope, multi-value).
- `verifyAccessToken` JOINs `oauth_tokens` to `oauth_clients` → returns `sourceId` + `allowedSources[]` on `AuthInfo`.
- HTTP transport threads these into `OperationContext` with `sourceId`.
- Every op handler calls `sourceScopeOpts(ctx)` and passes `{sourceId, sourceIds}` to engine reads.

Write vs read scope are deliberately distinct — Alice writes to `customers`, reads `customers + shared`.

### Borrow for Cycloid

- **`tenant_scope_opts(ctx)` helper** threaded from auth through every DAO. Cycloid's `business_id` filtering coverage is uneven — single helper unifies.
- **Read vs write scope as separate columns on the auth row** — clean for "this Slack vendor can read public channels but only write to its own."
- **Per-token `permissions` JSONB allow-lists** (e.g. `allowed_repos: string[]`) for finer isolation than scope — for Slack/CLI tokens issued to vendors.
- **CASCADE delete on the tenant row** as the cleanup guarantee.

## 11. MCP + OAuth 2.1 + agent install — the surface story

**85 operations** in `src/core/operations.ts` (README's "30+" is conservative). Single typed `Operation[]` array. `buildToolDefs(ops)` maps each op's `ParamDef` to JSON Schema — **one mapper feeds stdio MCP, HTTP MCP, and the subagent tool registry** (three call sites that previously drifted; consolidating killed a recurring bug class).

`localOnly` ops (`sync_brain`, `file_upload`) are rejected over HTTP regardless of scope — **fail-closed at transport boundary**.

**OAuth 2.1 + PKCE** (`src/core/oauth-provider.ts`, 953 lines) implements MCP SDK's `OAuthServerProvider`:

- Authorization code + PKCE (S256) for browser clients (ChatGPT, Claude Code, Cursor)
- Client credentials for M2M
- Refresh token rotation
- Dynamic Client Registration (RFC 7591) behind opt-in flag
- Atomic `client_id` binding inside DELETE/SELECT predicates (prevents stolen-code attacks)
- HTTPS-only redirect_uri except loopback
- CORS default-deny
- Constant SHA-256 hashing for tokens at rest
- Scope hierarchy: `admin > {sources_admin, users_admin, write > read}` + `agent` as deliberate sibling so legacy admin tokens can't silently dispatch costly ops

**`INSTALL_FOR_AGENTS.md`** is 332 lines, written for an LLM reader. Numbered steps with `[AGENT]`-prefixed stdout markers, JSON envelopes with `schema_version`, "DO NOT SKIP" gates for cost-sensitive decisions (Step 3.5 presents a 9-cell cost matrix requiring operator consent), structured `gbrain onboard --check --json` activation surface with per-recommendation `apply_policy: auto_apply|prompt_required|manual_only`. Two-gate opt-in for LLM-bearing ops (config flag + `--yes`).

### Borrow for Cycloid

- **Single `Operation[]` registry + one schema mapper** feeding web routes, Slack commands, MCP tools, CLI — exactly the drift bug class GBrain documents.
- **OAuth 2.1 + PKCE for MCP exposure** — unlocks ChatGPT, Claude Desktop, Cursor as Cycloid clients. The F1–F7 hardening checklist is copy-paste-grade reference.
- **`localOnly` op flag with fail-closed transport check** — Cycloid's sensitive ops (sandbox spawn, PR creation) should reject over wrong transport.
- **`INSTALL_FOR_AGENTS.md` pattern** for customer-repo install of Cycloid's `AGENTS.md` block.
- **`destructive-guard.ts` two-phase pattern**: 72h tombstone with `DestructiveImpact` blast-radius preview before any cascading delete. Apply to session/PR/sandbox cleanup.

## 12. Slack-native gap analysis — what survives, what doesn't

### Surface-agnostic — survives intact

- **Knowledge graph + auto-link** (pattern matching, zero LLM)
- **Dream cycle / nightly consolidation** (any scheduler)
- **Multi-tenant scoping** (`source_id` maps to Slack workspaces/channels)
- **Takes vs facts** (threads feed facts per-message; dream cycle promotes to takes)
- **Hybrid retrieval** (vector + BM25 + RRF + graph signals)
- **Voice gate** (already pipe-agnostic)
- **OAuth + source scoping**
- **Ingestion event contract**

### Surface-coupled — requires rebuild

- **No `OutputChannel` interface**. Host agent owns delivery — every recipe shell-execs "post to Slack" inside an LLM prompt. Slack-native needs a first-class output abstraction parallel to `IngestionSource`.
- **No durable session model**. Everything is request-scoped (CLI, MCP call, voice call). No `session_id = thread_ts` equivalent.
- **Conversation parser assumes finished transcripts** in one shot. Slack inverts this — messages accumulate one at a time.
- **Recipes are out-of-process collectors** (cron + Node script + git commit + push). Doesn't map to Slack's webhook-push model — would mean reinventing the recipe layer as event handlers.
- **"Agent installs and operates"** assumes a long-running daemon (OpenClaw/Hermes on Render/Railway). Cycloid's Workers + per-request DO model is fundamentally different; the dream cycle in particular assumes a 24/7 daemon.

### What "Slack-native GBrain" would require

- **Session/thread model**: `session_id = team_id:channel_id:thread_ts`, persistent, resumable, brain owns thread state.
- **Identity**: `slack_user_id → brain_identity` mapping, story for shared-channel users without OAuth.
- **Channel scoping**: `channel_id → source/repo` binding, per-channel ACL inheriting Slack channel membership.
- **Push output channel**: first-class `OutputChannel` abstraction. `morning_pulse`/`nudge` voice modes are ready; the pipe isn't.
- **File ingestion via Slack uploads**: `IngestionEvent` already handles binary via path pointers; need a fetcher source for the Slack `file_shared` webhook with `untrusted_payload: true`.
- **Deterministic Slack URL construction**: `company-brain.md` Part 8 documents this as a hard-won lesson — LLMs hallucinate Slack URLs constantly. First-class helper required.
- **Conversation as first-class**: invert the parser to accumulate messages into a thread, not extract messages from a blob.

## 13. Borrowable Slack-native lessons from GBrain (even though it isn't Slack-native)

1. **Voice gate per surface** — Cycloid Slack outputs (status updates, PR comments, session-done messages) pass through per-surface tone rubric. `nudge` rubric ("friend tapping you on the shoulder, NEVER preachy, always closes with a concrete next step") is the in-thread tone you want vs "CYCLOID SESSION COMPLETED ✓."
2. **Gap analysis as first-class output shape** — every Slack response ends with an honest "what I don't know" note: stale telemetry, unverified assumption, missing repo access.
3. **Code-for-data, LLMs-for-judgment** — GBrain's email collector hard-codes Gmail link construction because LLMs hallucinate URLs. Cycloid must do the same for Slack permalinks, PR URLs, commit SHAs.
4. **Deterministic dedup window + `untrusted_payload` flag at ingestion** — 24h `(source_kind, content_hash)` dedup means the same message reposted in two threads doesn't double-spawn sessions; `untrusted_payload` fits public Slack channel ingestion.
5. **Per-person/per-channel cron skills with scoped credentials** — `crons/<user>/07am-customer-digest.md` with `client: alice-example` enforcing scope. Lets users define "every weekday 9am, in #my-channel, sweep my repos for X" without full account scope.
6. **Topic registry (channel-ID → friendly-name)** — never let agents reference Slack by raw IDs. Map once, reference by name everywhere.
7. **Botmaster onboarding pattern** — pre-populate the user's slice → walk through 2-3 wow flows → graduate to free-form DM. Applies to Cycloid Slack onboarding.

## 14. What we explicitly do NOT borrow

- **PGLite default + Postgres-at-scale upgrade path** — wrong stack for D1/Workers.
- **`postgres.js` raw-SQL ergonomics** (`pgArray`, JSONB, `RETURNING 1`) — don't translate to D1 prepared statements.
- **In-process scoped DB defaults** (`source_id='default'` single-tenant) — we need real multi-tenant day one.
- **The 43-skill scaffolding system** — we have Claude Code skills. Borrow the scaffold-with-diff-protection installer pattern, not the skill content.
- **Auto-think / drift / anomaly cycle phases** — scaffold-only in v0.40.
- **The 1318-line `schema.sql`** — mostly ops (jobs, cache invalidation, OAuth, eval harness). Strip to ~6 tables: pages, links, tags, timeline_entries, takes, facts (+ slug_aliases).
- **"66 cron jobs"** as Cycloid marketing — that's an OpenClaw deployment, not gbrain.

## 15. Skeptical caveats

- **Headline benchmark is GBrain-internal and self-graded.** "P@5 49.1%, R@5 97.9% on 240-page Opus-generated corpus" — corpus is LLM-generated narrative tuned against the same regexes (file says regexes were "calibrated against the BrainBench rich-prose corpus"). In-distribution. +31.4-point delta over graph-disabled is "regex-tuned-on-this vs no-regex," not "regex vs frontier LLM."
- **"Zero LLM calls"** applies only to the typed-edge layer. Facts (Haiku per turn) and takes (full Opus extraction) use LLMs.
- **Entity catalog is bootstrapped manually.** Gazetteer only sees pages the user created.
- **English-only tokenization** — explicitly punts CJK/accented chars.
- **"Fixes its own citations"** is mostly `synthesis_evidence` FK enforcement + `phantom-redirect`. No agent re-reads published answers.
- **"Gap analysis"** is LLM prose; no `staleness-detector.ts`. Quality depends on model.
- **"Fuzz-tested zero leaks"** is mostly regression coverage, not generative fuzzing. Actual fast-check suite is 2 pure functions × 1000 runs; the file's own comment admits the plan was 7 targets and 5 didn't survive the purity guard.
- **Single-machine PGLite by default**; multi-user requires Supabase/Postgres migration. Default brain is single-tenant (`source_id='default'`).
- **Drift detection is scaffold-only** (v0.29 TODO).

---

## Recommended Cycloid next steps (priority order)

**Memory model (highest leverage):**

1. **`memory_pages` + `memory_links` two-table graph in D1** with `link_type` text + `link_source` + `origin_page_id` + `origin_field` columns. No separate graph DB.
2. **Ship Cycloid verb regexes** (`uses_framework`, `depends_on`, `supersedes`, `reviewed_by`, `blocks`, `authored_by`, `mentioned_in`) with precedence + page-role priors. Zero LLM, deterministic, debuggable.
3. **Takes vs facts as two stores** with one-way nightly consolidation. `holder` tracks per-user preferences vs objective repo facts.
4. **`since_date` / `until_date` on takes** + effective-date precedence chain for memory entries.
5. **Append-only fenced table in `AGENTS.md`** with strikethrough supersession and stable row numbers.

**Slack-native (per goal):**

6. **`OutputChannel` first-class abstraction** parallel to ingestion. Slack thread, PR comment, web UI, daily DM as channel types with per-channel formatter + voice-gate rubric.
7. **Voice gate per surface** with Haiku judge + template fallback; apply DESIGN.md voice principles to all outputs.
8. **Gap analysis as first-class output** — every Slack response ends with a structured "what I don't know" note.
9. **Code-for-data, LLMs-for-judgment** — deterministic Slack URL / PR URL / commit SHA construction.
10. **Topic registry** mapping Slack channel ID → friendly name.
11. **`untrusted_payload: true` flag** on public-channel ingestion — skips auto-link, applies allowlist.
12. **Two-layer dedup** on Slack message ingest: content-hash skip + 24h LRU.

**Architecture / surface:**

13. **Single `Operation[]` registry + one schema mapper** for web routes, Slack commands, MCP tools, CLI.
14. **OAuth 2.1 + PKCE for MCP exposure** — ChatGPT/Claude Desktop/Cursor as clients. F1–F7 hardening reference.
15. **`tenant_scope_opts(ctx)` helper** threaded from auth through every DAO. Read vs write scope as separate columns. Per-token `permissions` JSONB allow-list.
16. **`destructive-guard.ts` two-phase pattern**: 72h tombstone with blast-radius preview.

**Background pipelines:**

17. **Single `runCycle()` primitive** with phase ordering as data, callable from cron / Workers / DO / manual API.
18. **RRF fusion of multiple retrievers** including graph traversal (k=60): session memory + repo grep + entity-graph.
19. **Throttled `last_retrieved_at`** (5-min throttle, 90% writes dropped).
20. **Contradiction probe that never auto-resolves** — emits PRs for review, with cost-tracker pre-flight + mid-run ceiling.

**Eval / agent install:**

21. **`INSTALL_FOR_AGENTS.md` for Cycloid's customer-repo `AGENTS.md` block** — numbered steps, `[AGENT]` markers, JSON envelopes, DO NOT SKIP gates.
22. **Multi-tenant regression tests** modeled on `facts-multi-tenant.test.ts` — pin every read path against a seeded two-tenant fixture, assert zero cross-tenant bleed.

## Key file references in gbrain repo

- `src/schema.sql` + `src/core/pglite-schema.ts` — full schema (~6 load-bearing tables under ops sprawl)
- `src/core/by-mention.ts` — gazetteer + maximal-munch tokenizer
- `src/core/link-extraction.ts:431-558` — hand-tuned verb regexes
- `src/core/extract-ner.ts` + `src/core/schema-pack/link-inference.ts` — schema-pack-driven edge typing
- `src/core/entities/resolve.ts` — slug resolver with resolution-quality enum
- `src/core/takes-fence.ts` — `<!--- gbrain:takes:begin -->` fence format
- `src/core/effective-date.ts` — precedence chain
- `src/core/ingestion/dedup.ts` — two-layer dedup
- `src/core/migrate.ts:1180-1250` (takes) + `:2280-2360` (facts) — DDL
- `src/core/cycle.ts` + `src/core/cycle/` — dream cycle phases
- `src/core/think/{index,gather,prompt,cite-render}.ts` — synthesis with RRF + structured gaps
- `src/core/eval-contradictions/{runner,judge,auto-supersession}.ts` — contradiction probe
- `src/core/calibration/voice-gate.ts` + `templates.ts` — five-surface voice gate
- `src/core/last-retrieved.ts` — throttled write-back
- `src/core/minions/` + `src/core/minion-spend.ts` — durable job queue + per-client spend cap
- `src/core/operations.ts` — 85-op registry
- `src/mcp/{server,dispatch,http-transport,tool-defs}.ts` — single mapper, three transports
- `src/core/oauth-provider.ts` — OAuth 2.1 + PKCE
- `src/core/scope.ts` — hierarchical scopes with deliberate sibling isolation
- `src/core/destructive-guard.ts` — 72h tombstone + blast-radius preview
- `src/core/output/writer.ts` — `BrainWriter`
- `src/core/conversation-parser/{types,parse}.ts` — multi-strategy parser
- `src/core/ingestion/types.ts` — `IngestionSource` contract
- `INSTALL_FOR_AGENTS.md` — agent-install protocol
- `DESIGN.md` — voice principles
- `docs/takes-vs-facts.md` — two-store epistemology
- `docs/tutorials/company-brain.md` (esp. Part 8) — Slack hard-won lessons
- `test/facts-multi-tenant.test.ts` + 30 other source-scope regression tests
- External: `openclaw.plugin.json`, `gbrain.yml` — host-agent integration

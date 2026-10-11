# Memory 2.0 Plan

Synthesis across the memory-system audits, checked against Cycloid's current Slack, session, and repo-memory implementation.

## North Star

**Cycloid lives in Slack, picks up company context from the work happening around it, and uses that context to make better decisions in the next task.**

Feel like a teammate who remembers the company, not a bot with a search box. Core loop:

1. Slack threads, PRs, and Cycloid sessions are remembered with exact provenance.
2. Background refinement turns raw artifacts into a small typed company map.
3. Sessions retrieve the relevant map slices before acting.
4. Useful task outcomes feed the map again.

## Current Reality

Constraints from the repo:

- Slack is already a webhook surface. `app_mention` creates sessions, existing thread replies enqueue follow-up prompts, and `slack_thread_session_refs(channel_id, thread_ts)` maps Slack threads to random Cycloid session UUIDs.
- Customer Slack workspaces use encrypted bot tokens in `slack_workspaces`, resolved by `team_id`. Missing `team_id` or token fails closed.
- Slack session creation does not start sessions from `message.im`; non-`app_mention` events only continue already-claimed threads.
- Slack search uses the user's Slack OAuth token and `search.messages`; workspace bot tokens handle thread reads and writes.
- Repo memory exists as `.cycloid/memory/**/*.md`, parsed by `shared/memory/parser.ts`, ranked by the sandbox bridge, tracked in D1 for telemetry and PR outcomes. With `MEMORY_REPO_SINK=d1`, new repo memories may be written directly to the `repo_memories` table (bypassing Git PRs); the Session DO attaches D1-backed memories to sandbox prompts for ranking.
- Database access is D1-only via raw prepared statements in DAO files. New timestamps are integer milliseconds. New migrations must be additive and indexed for expected read paths.

## Product Shape

### 1. Slack As The Substrate

Slack is the primary capture and interaction surface.

- **Thread continuity**: keep Cycloid session IDs as UUIDs; add a team-aware mapping table keyed by `(business_id, team_id, channel_id, thread_ts)`. Do NOT make `session_id = team_id:channel_id:thread_ts` — too much session state assumes opaque UUIDs. Replies to an open or paused mapped session continue it. Replies to a terminal session create a new prompt only if the session can legally resume; otherwise post a terse "start a new thread" reply rather than silently reusing closed state.
- **Mention mode**: `app_mention` and DM messages can create or continue sessions.
- **Intake mode**: opted-in channels feed memory without starting sessions. Default off, per channel, with an explicit scope such as customer, repo, incident, or support.
- **Channel scope**: channel IDs map to stable topics (`customer/acme`, `repo/cycloid`, `incident/foo`). The agent sees friendly names; storage keeps IDs.
- **Slack search**: keep user-token search as an optional runtime tool. Treat `search:read.public` as a later AI-search upgrade after validating Slack approval and token behavior.
- **Assistant status**: use `chat:write` for loading/status updates where possible. Slack docs say `assistant.threads.setStatus` accepts `chat:write` and `assistant:write` only temporarily, so `assistant:write` should not be a Phase 1 dependency.
- **Customized Slack messages**: do not impersonate the requester. If `chat:write.customize` is used, the message must still clearly be from Cycloid and only customize attribution where Slack policy and user consent allow.

Concrete Slack app surface:

- Bot scopes for the core path: `app_mentions:read`, `chat:write`, `reactions:write`, `users:read`, `users:read.email`, `files:read`, `channels:read`, `groups:read`, `channels:history`, `groups:history`, `im:read`, `im:write`, `im:history`, `mpim:history`.
- Optional user scope: `search:read` for the existing `search.messages` tool. Not required for normal mention/intake memory.
- Event subscriptions: `app_mention`, opted-in `message.channels`, opted-in `message.groups`, `app_uninstalled`, and later `reaction_added`. Assistant events (`assistant_thread_started`, `assistant_thread_context_changed`) wait until the core thread capture/retrieve loop works. DMs are not a supported Memory 2.0 surface.
- Routing guardrails: ignore Cycloid's own bot messages, dedupe Slack `event_id`, verify Slack signatures, and check channel intake settings before persisting ambient channel messages.

### 2. Remember

Capture immutable source artifacts, normalized into one ingestion contract.

Phase 1 producers:

- Slack `app_mention`, `message.im`, and existing-thread replies.
- Opted-in `message.channels` and `message.groups` intake events.
- Slack thread links pasted into Cycloid task creation.
- Existing Cycloid session events and PR/session completion metadata.
- GitHub PR events already flowing through webhook infrastructure.

Storage pipeline:

- Redact or quarantine secret-like content before any D1 or R2 write. Quarantined events keep only metadata, hash, and a redaction reason until an operator approves retention.
- Apply retention and tenant-cancellation deletion rules to raw R2 artifacts. Structured memories can use soft delete and supersession, but raw artifacts must be removable when policy requires.

- `ingestion_events`: one row per source artifact with `business_id`, `source_type`, `source_uri`, `source_event_id`, `source_time_ms`, `content_hash`, `content_ref`, `scope_type`, `scope_id`, `actor_ref`, `team_id`, `channel_id`, `thread_ts`, `untrusted_payload`, and `processing_state`.
- Raw content goes to R2 only when too large or not already stored durably elsewhere. Store an R2 key in `content_ref`; do not duplicate full session transcripts or PR data already in existing tables.
- Dedup by `(business_id, source_type, source_event_id)` first, then `(business_id, source_type, content_hash)` where provider event IDs are unavailable.
- Public or broadly visible Slack intake writes `untrusted_payload = 1`; downstream extraction may quote/summarize it but must not auto-link entities without allowlisted signals.

Every derived memory row must cite at least one `ingestion_events.id`.

### 3. Refine

Refine should be boring and bounded. Start with memory types that clearly improve coding and customer-context tasks.

Phase 1 extraction output:

- `decision`: durable choices and rationale.
- `constraint`: requirements, policies, customer promises, repo rules.
- `action_item`: owner, due date if present, status, source thread.
- `dead_end`: attempted approach, why it failed, task class.
- `preference`: user/team preferences that should alter future behavior.
- `fact`: stable entity facts that help route or ground work.

Core tables:

- `memory_pages`: typed entities such as customer, repo, service, person, channel, incident, decision, thread.
- `memory_facts`: hot extracted claims with `kind`, `claim`, `status`, `holder`, `confidence`, `effective_time_ms`, optional `valid_until_ms`, optional `due_time_ms`, and provenance.
- `memory_takes`: consolidated durable claims with append-only supersession. Source events go through `memory_provenance`, not a D1 array column.
- `memory_links`: typed edges between pages. Keep uniqueness expressible in SQLite; avoid Postgres-only syntax such as `NULLS NOT DISTINCT`.
- `memory_provenance`: join table from facts/takes/links to ingestion events.

Implementation rules:

- D1 rows are canonical for structured memory. Markdown is a generated/review surface, not the only source of truth.
- Human-editable markdown lives in a Git-backed location when review/audit matters. R2 may hold generated read caches, not the human-editing workflow.
- Run extraction in background workers/queues with D1 claim rows first. Add a Durable Object only where serialization is actually required for a specific scope write.
- Structured outputs for LLM extraction. Deterministic code for Slack permalinks, PR URLs, commit SHAs, entity slugs, and source URIs.
- Redact secrets before persistence; never rely on read-time filtering.
- Contradictions never overwrite existing takes — they create supersession candidates or review items with source links.

### 4. Retrieve

One control-plane API used by session bootstrap, Slack task creation, and later watchers.

Minimum useful retrieval:

- Scope filters: `business_id`, current Slack team/channel/thread, repo, customer, time window.
- Keyword/BM25 over claims and summaries.
- Structural traversal over `memory_links` from detected entities.
- Optional vector signal only after keyword + structural retrieval works.
- Recency and authority weighting: HITL-approved or source-of-truth rows outrank inferred rows; stale rows decay unless marked non-decaying (e.g. dead ends).
- Hard timeout with fail-open behavior. Retrieval must not block the agent.

Agent integration:

- Inject a bounded "company context" block at session start: scope summary, relevant decisions/constraints, dead ends for the task class, source links.
- Expose `query_memory` for explicit follow-up retrieval.
- Expose `get_reasoning_chain(memory_id)` for provenance drill-down.
- Keep existing repo-memory recall working during transition. The new retrieval layer should include `.cycloid/memory` entries, then gradually replace repo-only memory with D1-backed company memory where appropriate.

Retrieval backend choices:

- Phase 3 uses D1 FTS/keyword indexes plus structured graph queries. No Vectorize binding required for the first useful release.
- Vectorize or Workers AI embeddings require a follow-up plan with binding name, local test fake, migration/backfill path, and deploy sequencing. Do not block the first retrieval release on vector search.
- `query_memory` is additive to `cycloid.memory_recall`: repo memories carry codebase rules and blocking hooks; company memory supplies Slack/customer/repo context. During Phase 3.5 reconciliation, conflicts use a first-release newer-wins policy with audit trails; later versions add source-authority nuance.

### 5. Source-Aware Task Creation

The highest-value Slack-native workflow.

When a user says "use this thread and fix it", "create a Linear issue from this", or "summarize the decision", Cycloid should:

1. Fetch the Slack thread with the workspace bot token; fail closed if `team_id` or token is missing.
2. Remember any missing thread events.
3. Run `refine_one_thread(slack_url)` on demand if no recent extraction exists.
4. Produce structured task context: goal, non-goals, constraints, decisions, blockers, owners, open questions, suggested verification, citations.
5. Start the session or create the downstream issue with citations back to Slack.

Ship this before broad watcher infrastructure.

## Phasing

Each phase leaves a useful system behind.

### Phase 1: Slack Capture And Typed Storage

Goal: reliable capture, tenant isolation, minimum schema.

- Additive D1 migrations for `ingestion_events`, `memory_pages`, `memory_facts`, `memory_takes`, `memory_links`, and `memory_provenance`, with `business_id` indexes for every read path.
- Replace or migrate Slack thread mapping to include `business_id` and `team_id` in the uniqueness key while preserving UUID session IDs and defining terminal-session behavior.
- Add `message.im` new-session handling for DMs.
- Per-channel intake-mode settings and fail-closed checks for workspace install state.
- Capture Slack events, session completion signals, and PR references into `ingestion_events`.
- DAO/service tests for two-business isolation, duplicate events, missing workspace token, public-channel `untrusted_payload`, secret redaction/quarantine before persistence, and bot-message loop prevention.
- App review/reinstall work stays scoped to the bot scopes and events above. `assistant:write`, `search:read.public`, and `chat:write.customize` are separate follow-ups, not Phase 1 gates.

Deliverable: Slack and existing Cycloid activity durably captured with provenance and no cross-tenant bleed.

### Phase 2: Focused Refine

Goal: turn captured artifacts into the smallest useful company map.

- Implement `refine_one_thread(slack_url)` and background extraction for completed sessions/PRs.
- Extract only decisions, constraints, action items, dead ends, preferences, and stable facts.
- Create pages for obvious entities: Slack channel, repo, customer, person, incident, thread.
- Create typed links only for high-signal relations: owns, mentions, decides, blocks, depends_on, committed_to, supersedes.
- Generate markdown review artifacts for scope pages through Git-backed PRs or a controlled admin review path; R2 only as a generated cache.
- Add contradiction candidates for review; no general HITL queue beyond contradictions and markdown review.

Deliverable: operators can inspect a sourced company map and see contradictions without silent overwrites.

### Phase 3: Retrieval Into Sessions

Goal: memory changes agent behavior.

- Add the Retrieve API with provenance-backed source filters, BM25/keyword, graph traversal, recency/authority weighting, timeout, and fail-open behavior.
- Inject bounded context into Slack-originated and UI-originated sessions.
- Add `query_memory` and `get_reasoning_chain` tools.
- Keep bootstrap and tool retrieval evidence in session events so PRs can cite the Slack threads and memories that influenced them.
- Tests for timeout/fail-open, auth failures, scope filtering, prompt-size bounds.
- E2E verify with a real Cycloid session that uses a seeded Slack/thread memory and cites it in the resulting task/PR flow.

Deliverable: tasks stop repeating known dead ends and start with the right customer/repo context.

### Phase 3.5: Memory Management And Reconciliation

Goal: keep the two memory stores correct without pretending they have one write path.

Two canonical memory locations:

- **Repo memory**: `.cycloid/memory/**` files (file-backed), plus the D1 `repo_memories` table when `MEMORY_REPO_SINK=d1` is configured. Canonical for codebase rules, gotchas, procedures, and enforcement. File-backed edits happen through Git PRs; D1-backed memories are written directly by the judge-gated analyzer pipeline.
- **D1 company memory**: Slack, session, PR, customer, and ambient company facts. Edits happen through admin-reviewed D1 lifecycle actions.

The stores can stay forked, but drift and incorrectness management must cover both:

- Periodic reconciliation job scanning active memories for stale, duplicate, contradicted, superseded, and expired entries.
- Within D1: first-release newer-wins policy — when two sourced memories conflict, assume the newer is correct, soft-supersede the older, write an audit candidate. D1 changes are soft deletes unless retention/privacy requires hard deletion.
- Within repo memory: read active memory files, honor their `status`, `supersedes`, and `contradicts` metadata. Fixes to stale or incorrect repo memory produce repo-memory PRs, not direct D1 rewrites.
- Across stores: compare active D1 company memory with active repo memory. First release: newer sourced memory wins by default; if that means changing repo memory, the action is still a repo-memory PR, not a silent D1 rewrite.
- Use retrieval/scoring plus structured adjudication for candidate selection and classification. No hardcoded semantic regexes for contradiction decisions.
- One "Needs review" operator surface with source labels (`Repo memory`, `Company memory`, `Cross-store conflict`), provenance, proposed action, and the write path to be used.
- Newer-wins is intentionally simple for the first release; later versions add nuance for source authority, source-of-truth repo memories, HITL approval, customer criticality, and confidence.

Deliverable: stale or contradictory memories are automatically cleaned up with audit trails across both stores; operators can review or correct source-appropriate edits.

### Phase 4: Two Proactive Watchers

Goal: proactive value without product sprawl. Start with only:

- **Customer/support escalation context**: opted-in escalation channels trigger a terse DM or thread reply with known customer constraints, owners, and recent related incidents.
- **Unresolved action items**: sourced Slack action items with owners/due dates can remind the original thread.

Watcher output must reuse the same Slack token resolution and channel authorization checks as session callbacks, rate-limit per business/channel, and log skipped outputs without leaking message text.

Defer repeated-question clustering, broad gap analysis, voice gates, and generic watcher composition until retrieval is proven useful in normal sessions.

Deliverable: Cycloid speaks up only when sourced memory clearly changes what a teammate should do next.

### Later

Second-source producers only after the Slack + PR + session loop works: Linear, support tools, CRM, meeting notes, customer repo docs. Each must fit the same `IngestionEvent` and provenance model.

## Anti-Goals

- Standalone wiki product.
- Generic enterprise search.
- Heavy review queue for every fact.
- Separate vector database as a product dependency.
- Broad multi-agent dispatch or a Cortex-style mesh.
- Rebuilding all Slack AI assistant surfaces before thread capture, refine, and retrieve work.
- Watcher frameworks before the two high-value watchers have proven useful.
- Customer-visible impersonation. Slack output may be personalized but must not pretend to be a user.

## Hard Rules

1. Every memory fact, take, and link has provenance.
2. Every DAO read filters by `business_id`; tests must prove two-business isolation.
3. Webhooks verify signatures and dedupe before side effects.
4. Missing Slack `team_id`, missing bot token, uninstalled workspace, or missing user binding fails closed.
5. D1 migrations are additive, timestamp columns are integer milliseconds, SQL stays prepared.
6. Human-readable memory is prompt-injection wrapped before agent injection.
7. Secrets are redacted or quarantined before any raw or structured persistence.
8. Retrieve has a hard timeout and fails open.
9. Contradictions are auditable. Phase 3.5 may soft-supersede older D1 memory automatically when source ordering is clear, but must preserve provenance and write an applied audit row.
10. The first implementation optimizes for Slack thread context, repo/customer decisions, dead ends, and action items. Everything else waits for evidence.

## Source Attribution

- Slack-native thread/session model and search-as-context: Scout.
- Pages, typed edges, takes vs facts, contradiction handling, RRF retrieval: GBrain and Honcho.
- Remember/Refine/Retrieve pipeline and HITL review concept: Applied Compute.
- Scoped auto-load and fractal summaries: Intent Layer.
- Redact-before-persist and scope model: Mastra.
- Provenance-first memory records: Sentra, GBrain, Honcho, Empirica.
- Prompt-injection-safe wrapping and supersession: Supermemory.
- Dead-end ledger and handoff fields: Empirica.

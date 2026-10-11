# goose cross-pollination — what to steal

Source: aaif-goose/goose (Linux Foundation, Rust). Survey of 10 subsystems against Cycloid (Cloudflare Workers + D1 + E2B + sandbox-bridge). Picks below are filtered to things we don't already have, that map to a concrete subsystem here, and that we'd actually ship.

Evidence paths are goose paths; clone with `git clone https://github.com/aaif-goose/goose` if you want to dig in.

## Architectural differences worth naming

These are structural concepts goose has that we don't. They aren't all "implement now," but if you're touching the relevant subsystem, know they exist.

1. **Recipe DSL.** Goose has a declarative YAML unit (`crates/goose/src/recipe/mod.rs`) with version, title, instructions, typed parameters (String/Number/Boolean/Date/File/Select with requirement + default), an `extensions` set, a JSON `response` schema, and `sub_recipes`. Recipes are the portable, parameterized, composable unit of work. Our prompt layers do part of this ad-hoc; we have no portable artifact a customer can hand us.
2. **Sub-agent delegation as first-class tool.** The `summon` platform extension (`crates/goose/src/agents/platform_extensions/summon.rs`) exposes `delegate(recipe, params, extensions, max_turns, async)` and `load`. Background tasks are tracked in a `HashMap<task_id, BackgroundTask>` with `cancellation_token`, atomic turn count, `last_activity`, and a `completed_tasks` map. The main agent decomposes work into sub-agents with isolated MCP sets and turn budgets. Our model is one monolithic session.
3. **Context-management primitives.** Two pieces we lack: (a) a `<turn-context>` block injected at the start of every turn with time/cwd/turns_taken/max_turns/compaction status (`agents/moim.rs:inject_moim`), and (b) `maybe_summarize_tool_pairs` (`context_mgmt/mod.rs`) that collapses old tool-call pairs into a summary and toggles message visibility (agent-only vs user-only). We rely on the model to self-manage long sessions; this is a recurring failure class.
4. **Tool-inspection pipeline.** Pre-dispatch inspectors run in a chain (`agents/agent.rs:576-600`): SecurityInspector, EgressInspector, AdversaryInspector, PermissionInspector, RepetitionInspector. The PermissionInspector uses an LLM judge for read-only classification (`permission/permission_judge.rs`). Inspectors annotate or route to approval. We have a bash-parser and a permission system but no inspector composition layer.
5. **Lifecycle hooks with regex matchers.** `hooks.json` (`hooks/mod.rs`) supports `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `BeforeShellExecution`, `AfterFileEdit`, `Stop`. Stop hooks can block turn exit with a counted escape hatch (`GOOSE_STOP_HOOK_BLOCK_CAP`, default 8). Zero-code extensibility for audit/security/telemetry plugins.
6. **Session ops as first-class APIs.** `fork`, `truncate`, `export`, multi-format `import` (Claude Code / Codex / Pi JSONL with `detect_format()`), and full-text `ChatHistorySearch` across messages. Sessions are an editable artifact, not a write-once log.
7. **Canonical model registry + lead/worker split + cache-aware usage.** `canonical_models.json` (`goose-providers/src/canonical/registry.rs`) is a provider-agnostic catalog of context limit, cost per token, cache behavior, reasoning support. `Provider::complete_fast()` (`goose-providers/src/base.rs:215-247`) tries a `fast_model` first, falls back to main. `Usage` tracks `cache_read_input_tokens` and `cache_write_input_tokens` separately. Our model config is hard-coded; sidecar calls all hit the primary model.
8. **Declarative eval matrix + assertion DSL.** `open-model-gym/suite/src/runner.ts` runs the Cartesian product of `ModelConfig[] × RunnerConfig[] × MatrixEntry[]`. Validation rules (`validator.ts`) include `file_exists`, `file_contains`, `file_matches`, `command_succeeds`, and — most useful for us — `tool_called` with arg-regex matching. Results are content-hash cached. Our Braintrust+Modal pipeline runs scenarios but has no parametric matrix and no integration-call assertions.
9. **Plan / dry-run mode as a `RunMode` enum.** `RunMode::{Normal, Plan}` (CLI `mod.rs:115-118`) and `GOOSE_PLANNER_CONTEXT_LIMIT`. Plan mode swaps the system prompt to produce a structured plan and stops; user approves before execution.
10. **ACP-relayed subscription providers.** Goose can relay a user's personal Claude/ChatGPT/Gemini _subscription_ as a provider via ACP. Unusual auth/monetization shape; mostly a competitive curiosity for us, but worth knowing it exists.

## What to implement — Tier 1 (next sprint)

Concrete pain we already have, small surface area, no design debate required.

### 1. Tool-pair summarization with visibility toggling — M, high

After tool-call traffic crosses a token budget, collapse older request/response pairs into one summary message. Toggle visibility: agent sees the summary, user-facing transcript keeps the originals (or vice versa).

- **Lands in:** `apps/sandbox-bridge/src/` near `memory-manager.ts`; threshold in `shared/constants/`.
- **Why:** Directly attacks long-session context-exhaustion bugs.
- **goose:** `crates/goose/src/context_mgmt/mod.rs:maybe_summarize_tool_pairs`.
- **First step:** Add `tool-pair-summarizer.ts` with a token-budget threshold; emit a summary message with an `agentOnly` visibility flag; extend the bridge event type to carry visibility.

### 2. `<turn-context>` breadcrumb injection — S–M, high

Small block prepended to each turn: current time, cwd, turns_taken/max_turns, memory usage, PR/branch state. Lets the model self-pace as it approaches limits.

- **Lands in:** `apps/sandbox-bridge/src/prompt-loop/turn-context.ts`; called from per-turn prompt assembly.
- **goose:** `crates/goose/src/agents/moim.rs:inject_moim`.
- **First step:** Build the block, wire into existing assembly, document fields in `docs/bridge.md`. Composes naturally with #1.

### 3. Session fork / truncate / export APIs — M, high

`POST /api/sessions/:id/fork` (with `fromMessageId`), `POST /:id/truncate`, `GET /:id/export`. Unlocks "go back and try Y", support exports, and eval-fixture generation from real sessions.

- **Lands in:** `control-plane-worker` routes → service → new session DAO; emit `SessionForked` event.
- **goose:** `goose-server/src/routes/session.rs:338-410`, `acp/server/fork_session.rs`.
- **First step:** Append-only migration for any new columns; transactional copy+truncate; UI affordance in the transcript.

### 4. MCP tool-call audit trail as eval assertions — M, high

Persist every MCP call (`tool_name`, `args`, `result`) as a structured event; add a `tool_called` assertion type to the eval validator with optional arg-regex matching.

- **Lands in:** `shared/types/sandbox.ts` new `mcp_call` event; sandbox-bridge MCP client; eval validator in `control-plane-worker/src/eval/`.
- **Why:** Integrations are the differentiator and the hardest thing to eval today. No new infra.
- **goose:** `evals/open-model-gym/suite/src/validator.ts:96-162`.
- **First step:** Emit the event, write one fixture scenario asserting `slack_send_message` was called with a thread_id.

### 5. Matrix eval harness — M, high

Declarative YAML matrix that expands across models, bridge/prompt variants, and tasks, then enqueues runs against the existing eval pipeline.

- **Lands in:** `control-plane-worker/src/eval/matrix.ts`; one committed `matrix.yaml`.
- **goose:** `evals/open-model-gym/suite/src/runner.ts:150-245`.
- **First step:** Parser + Cartesian expander + enqueue; reuse existing Braintrust+Modal run path.

### 6. Full-text session search — M, high

`GET /api/search/sessions` with keyword + date filters; FTS5 virtual table over `messages.content`; group by session with snippet previews and known-secret redaction.

- **Lands in:** `control-plane-worker` routes + DAO; FTS5 migration.
- **goose:** `ChatHistorySearch` in `goose/src/session/session_manager.rs`.
- **First step:** Migration, query, redaction helper. Pair with lazy session-summary generation if appetite.

### 7. Cursor-based pagination with filter-hash binding — S–M, medium-high

Keyset pagination on `(updated_at DESC, id DESC)`, base64 cursor includes SHA-256 of the filter set so a cursor cannot be reused across queries.

- **Lands in:** Session list route + new `control-plane-worker/src/session/pagination.ts` helpers.
- **goose:** `SessionListCursorToken` in `session_manager.rs`.
- **First step:** Add the index, encode/decode helpers, swap list route.

## What to implement — Tier 2 (next quarter, larger lift)

Architecturally healthy; needs a real design pass but the wins are clear.

### 8. Plan / dry-run mode — M, high

`planningMode` flag at session-create. Swap the system prompt to produce a structured plan, stop after one turn, surface "Approve & Run" in UI. Pairs with our existing plan-link convention in `docs/workflow.md`.

- **Lands in:** Session-create API + SessionDO state + sandbox-bridge prompt assembly + UI approval affordance.
- **goose:** `RunMode::Plan` (CLI `mod.rs:115-118`).

### 9. Tool-inspection pipeline — L, high

Chain `bash-safety → file-access → permission → LLM read-only judge`. Annotate tools with risk levels; route auto-approve vs user-modal; reuse existing bash-parser and permission system.

- **Lands in:** `control-plane-worker/src/services/tool-inspection/` (new) or sandbox-bridge depending on where the dispatch decision lives.
- **goose:** `crates/goose/src/agents/agent.rs:576-600` and `permission/permission_judge.rs`.

### 10. Cost-aware token usage tracking — M, medium

Per-turn `ProviderUsage` with cache_read / cache_write breakdown. UI surfaces cache hit rate and per-turn cost. Unlocks the lead/worker conversation (#11).

- **Lands in:** SessionDO state, session event payload, UI session-detail panel.
- **goose:** `goose-providers/src/token_usage.rs`.

### 11. Lead/worker model split with fast-model fallback — M, high

Model session config as `{ primary, fast? }`. Use fast model for non-creative sidecar steps (summarization, classification, tool-call repair); fall back to primary on failure.

- **Lands in:** `session-model-routing.ts` and any sidecar caller; thread through to bridge.
- **goose:** `Provider::complete_fast()` in `goose-providers/src/base.rs:215-247`.
- **First step:** Define the tuple type, add a fast-model default inferred from tier (opus → sonnet, etc.), retry-on-fail to primary.

### 12. Action-required elicitation manager — M, medium

Per-session queue of approval prompts with timeouts, streamed to the UI as events, response routed back through the worker via a oneshot. Drains expired/failed requests in-turn.

- **Lands in:** `control-plane-worker/src/session/elicitation.ts` (new) or SessionDO method.
- **goose:** `action_required_manager.rs:48-120`. UI pattern: `ElicitationRequest.tsx` (JSON Schema form + countdown badge).

## What to revisit later (deliberately deferred)

- **Recipe DSL (YAML).** Highest leverage of anything goose has, but it's a major design choice — picks the shape of customer-facing automation for years. Needs its own design doc; don't sneak it in.
- **Sub-agent delegation (`delegate` / `load` / BackgroundTask).** Depends on a Recipe DSL existing. Powerful for "lint+test+build in parallel" but big lift: child SessionDO lifecycle, cancellation, billing. Park behind a real customer use case.
- **Lifecycle hooks with regex matchers.** Strong extensibility story; only worth it once a customer asks for zero-code audit/telemetry.
- **OAuth refresh for customer-supplied MCPs.** Necessary the moment we onboard one with a private OAuth MCP. Pre-spec the D1 refresh-token schema and 401-retry path so it's a week, not a month.
- **Declarative provider registry with env-var templating.** Defer until a paying customer needs a non-Anthropic/non-OpenAI provider.
- **Cron-scheduled recipes via a ScheduleDO.** Premature without the Recipe DSL.
- **Multi-format session import (Claude Code / Codex / Cursor JSONL).** Cheap to add and possibly useful for onboarding; revisit if a customer wants to bring transcripts in.
- **Thread-based conversation branching (goose migration v10).** Bigger overhaul than fork; not worth it if fork-via-truncate (Tier 1 #3) covers the UX need.

## Skip pile (called out for completeness)

Duplicates we already have (business vs user integration scoping, SSE event streaming, basic OAuth, multi-turn sessions), Rust-specific machinery whose port cost exceeds its boilerplate savings (ACP macros, declarative JSON-RPC dispatch, toolshim for tool-unsupported models), and shape mismatches with our SaaS model (Nostr session sharing, ACP-relayed subscription providers, multi-runner comparison harness, terminal-shell-hook persistence, CLI theme persistence).

## Pointers back to the raw survey

10 subsystems, 70 raw ideas, 8-pick synthesis. Raw output: `/private/tmp/claude-501/.../we6qspvzl.output`. Workflow script: `goose-cross-pollinate-wf_6b0f2529-a80.js` in the session's workflow scripts dir.

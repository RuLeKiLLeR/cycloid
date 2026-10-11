# Empirica Learnings

Audit of [Nubaeon/empirica](https://github.com/Nubaeon/empirica) for Cycloid's memory system.

## TL;DR

Most concretely implemented of the four systems audited. Python CLI + Claude Code integration wrapping an agent loop with:

- A **4-tier memory architecture** (hot `MEMORY.md` cache → on-demand `memory/*.md` → SQLite + git-notes + Qdrant → transient JSON).
- A **PreToolUse "Sentinel" gate** classifying tool calls as inspection vs mutation, blocking mutations on epistemic-readiness thresholds.
- A **domain × criticality YAML registry** scaling required checks per work type.
- **Self-vs-observed Brier divergence** as a calibration signal.
- A **handoff system** (git-notes + SQLite) carrying findings/dead-ends/recommended-next-steps from session N to N+1.
- A **dispatch bus** for cross-agent coordination over git-notes-as-transport, plus **completion handshakes carrying commit SHAs**.

Heavy philosophical framing ("noetic/praxic", "Sentinel constitution", "13 epistemic vectors") covers a more modest engineering reality; strip the vocabulary and the patterns are borrowable.

Also confirms what NOT to borrow: git-notes as cross-tenant transport (security), `memory_swap.py` (single-tenant CWD hack), Qdrant at our scale, the 13-vector self-reported ceremony per turn.

---

## 1. Memory architecture — the 4-layer system

Documented three inconsistent ways across three docs (load-time tiers vs storage backends vs L1–L5). Most useful framing, from `memory_manager.py`:

| Layer                | Where                                                                        | Lifecycle                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 — Hot cache       | `MEMORY.md` auto-section (delimited, line-capped at 100 auto / 180 total)    | Rewritten on POSTFLIGHT and SessionEnd; preserves manual content                                                                                      |
| L2 — On-demand       | `memory/*.md` files                                                          | Promoted from Qdrant eidetic when `confidence ≥ 0.7`, deduped by MD5 hash, capped at 3 promotions per call; demoted to `_archive/` after 30 days idle |
| L3 — Semantic        | Qdrant collections (`findings`, `unknowns`, `dead_ends`, `lessons`)          | Written by CLI verbs (`finding-log`, `deadend-log`, …)                                                                                                |
| L4 — Source of truth | `sessions.db` (SQLite per-project) + `workspace.db` (cross-project registry) | Written on every epistemic event                                                                                                                      |
| L5 — Portable        | `refs/notes/empirica/...` git notes                                          | Dual-written alongside SQLite; travels with the repo                                                                                                  |

**Ranking formula** (`CANONICAL_STORAGE.md`): `weight = impact × type_confidence × recency_decay` with `recency_decay = exp(-0.029 × age_hours)` (~24h half-life). Type weights: finding=0.9, dead_end=0.85, mistake=0.85, goal=0.75, unknown=0.6. Hot cache capped at 12 items.

**Borrow for Cycloid:**

- **Auto-section delimiters with line caps in `AGENTS.md`/`CLAUDE.md`** (`memory_manager.py:_replace_auto_section`). Cap auto content, preserve manual content between markers — direct fix for "human edits get clobbered."
- **Type-weighted recency ranking** for what we surface next session — `impact × type_confidence × recency_decay` is simple, defensible, beats "most recent N." Pick ONE formula everywhere (Empirica has 5 different decay functions — don't repeat that).
- **Promotion threshold + content-hash dedup + per-run cap** (`confidence ≥ 0.7` AND `.promoted_hashes` MD5 tracker AND `max_promote=3`) — clean anti-spam recipe: hash column on the memory row, cap writes per session.
- **Auto-demotion after N days idle** to a `memory_archive` table — reversible, strips index references. Our memories have no TTL today; `AGENTS.md` will bloat.

**Skip:**

- **Git-notes-as-memory** — Empirica targets a developer's local repo. Cycloid's ephemeral E2B sandboxes against customer repos mean git notes either pollute the customer repo or die with the sandbox.
- **Qdrant** — overkill at our scale; even Empirica admits "core works without it."
- **`memory_swap.py`** — Claude Code CWD-quirk workaround we don't have.

## 2. Context budgeting — the most directly portable subsystem

`context_budget.py` (911 lines) treats the context window as **RAM with paging**:

- 3 zones: **ANCHOR** (15k tokens, non-evictable — system prompt + key docs), **WORKING** (150k, active task), **CACHE** (35k, evicted first).
- Each `ContextItem` has `estimated_tokens`, `epistemic_value`, `reference_count`, `last_referenced`, zone.
- **Eviction priority**: `epistemic_value * exp(-decay_rate * idle_minutes) * log(1 + refs) * zone_weight` (zone weights ANCHOR=100, WORKING=1.0, CACHE=0.5). Lowest-score evicted first.
- Subscribes to `EpistemicBus`:
  - `CONFIDENCE_DROPPED` → **page fault** injects bootstrap context.
  - `POSTFLIGHT_COMPLETE` → decay all items.
  - `GOAL_COMPLETED` → demote goal from WORKING to CACHE with 0.3× value multiplier.
  - utilization ≥ 0.85 → `MEMORY_PRESSURE`.

**Borrow for Cycloid:**

- **Zone model** for injected context: anchor (system prompt + CLAUDE.md) never evicts; per-task working set; cache evicts first.
- **Eviction priority formula** with `reference_count` (re-touches per turn) as a multiplier — cheap unused signal.
- **Confidence-drop → bootstrap injection** event: if a Codex tool repeatedly fails, page in the relevant past-session dead-end automatically.

**Skip:** the Unix-virtual-memory vocabulary (`/proc/meminfo`, "page fault"). Cute, distracting.

## 3. Sentinel — PreToolUse gate keyed on readiness, not permissions

Runs as a **Claude Code `PreToolUse` hook** (`sentinel-gate.py`, 2963 LOC — alarming size). Every tool call classified:

- **Noetic** (Read, Grep, Glob, safe Bash) → flow.
- **Praxic** (Edit, Write, mutating Bash, `git push`, etc.) → gated against `know ≥ threshold` and `uncertainty ≤ threshold`.

Two defense layers:

- **NoeticFilter** — regex/domain pattern blocks during investigation.
- **AxiologicGate** — action-pattern gate during praxic (e.g. `delete.*production` requires `know ≥ 0.85, uncertainty ≤ 0.15`).

Gate actions: `PROCEED | INVESTIGATE | HALT_AND_AUDIT | REQUIRE_HUMAN | ESCALATE | LOG_AND_CONTINUE`. Strict priority: HALT > REQUIRE_HUMAN > ESCALATE > INVESTIGATE > threshold check. Subagents exempt (parent CHECK authorizes them).

**Domain × criticality YAML** in `empirica/config/domains/*.yaml`. `cybersec.yaml`: `low` requires `tests, lint`, coverage 0.3; `high` adds `semgrep_full, trivy_deps, gitleaks`, coverage 0.7; `critical` adds `sbom_audit, threat_model_current, privilege_review`, coverage 0.85. Resolution falls back exact → next-lower criticality → "default" → empty.

**Borrow for Cycloid:**

- **Read-vs-write tool classification** at the bridge's pre-tool boundary — cheap; cuts the "agent edits before reading" failure class.
- **AxiologicGate action patterns** — small regex/predicate table requiring extra confirmation/replan for high-blast-radius ops (force-push to main, D1 deletes, `gh pr merge`, Terraform edits). Partially exists for PR creation; promote to first-class.
- **Domain × criticality YAML registry** for required checks per repo — blast-radius rules as data, customer-admin tunable. Maps onto `AGENTS.md` directives but typed.

**Skip:**

- A 2963-line monolithic gate script — build a small typed rule engine in the bridge.
- **The 13-vector self-reported assessment per transaction** — ceremony; overhead dominates a one-shot PR loop. Borrow the _gate idea_, not the vector blocks.

## 4. Three-vector calibration + Brier divergence

Per transaction, stored in `grounded_verifications`:

- **`self_assessed_vectors`** — AI's own 0–1 score at POSTFLIGHT.
- **`observed_vectors`** — deterministic service-computed (tests, lint, coverage, ruff, radon, semgrep). The "praxic proxies."
- **`grounded_vectors` + `grounded_rationale`** — AI-reasoned synthesis with prose justification.

Combination is a **Bayesian update** per vector: `posterior_mean = (prior_var * observed + obs_var * prior_mean) / (prior_var + obs_var)`. Holistic score is **phase-weighted** by the noetic/praxic tool-call split.

Dynamic thresholds (`dynamic_thresholds.py`) use **Brier reliability** (Murphy 1973: BS = Reliability − Resolution + Uncertainty). Only Reliability inflates thresholds — **good calibration does not loosen gates**, it just makes the system trust the numbers; bad calibration tightens them. Code is more conservative than the docs ("earned autonomy → looser gates" is not implemented).

**Borrow for Cycloid:**

- **Self-assessed vs observed divergence tracking.** Agent declares expected outcome at the start of a praxic step (tests will pass, PR will land green); Brier-score against reality after. Persisted divergence per `(repo, work_type)` signals when to force a re-plan. Brier is a **strictly proper scoring rule** — can't be gamed by hedging.
- **Observed vector = deterministic service output**, not LLM judgment. We already have lint/test results — surface them as a structured vector the agent must predict.

## 5. Epistemic snapshot (cross-AI handoff)

`epistemic_snapshot.py` (433 LOC): compress a session into ~500 tokens (13 vectors + delta + previous_snapshot_id chain + ContextSummary + domain_vectors). Tracks `fidelity_score`, `information_loss_estimate`, `transfer_count`, `compression_ratio`. `estimate_memory_reliability() = fidelity − 0.03*transfers − 0.01*age_hours − info_loss`. `should_refresh()` triggers below 0.75 reliability / 5 transfer hops / 24h age.

**Borrow for Cycloid:**

- **Compressed handoff snapshot** for resume across cold/warm sandboxes — when E2B pools get reclaimed mid-task, a 500-token vector + narrative beats replaying full Codex history.
- **`should_refresh` heuristic** (hops + age + reliability) for "this resumed context is too stale; rebuild from D1."

## 6. Agent integration — table-driven MCP, attention-recency hook injection

**MCP server** (`empirica-mcp/server.py`, 804 LOC) is a **thin table-driven CLI wrapper** — single `TOOL_REGISTRY` dict (~55 tools) mapping MCP tool name → CLI command + flag schema. Subprocess-shells with `--output json`. No epistemic logic inside.

Notable tool families:

- `bootstrap_context` — **three-circle pattern**: active_state (recency-decayed) + persistent_reference (no-decay) + topic_relevant_backlog (semantic similarity).
- `noetic_batch` — one MCP tool whose payload is `{intent, reads:[], greps:[], globs:[], investigate:[]}`. Investigation costs one round-trip instead of N.
- Log verbs (`finding_log`, `deadend_log`, `mistake_log`, `decision_log`, `source_add`) each take `visibility` (public/shared/local) and `epistemic_source` (intuition/search/mixed) — provenance flags.
- Goals/tasks (8 tools) with `--evidence <commit-sha-or-test-result>` to close a task.

**Hooks** wired via `~/.claude/settings.json`. ~24 hooks across PreToolUse, PreCompact, SessionStart, SessionEnd, SubagentStart/Stop, UserPromptSubmit, PostToolUse, TaskCompleted, PostToolUseFailure, Stop. `tool-router.py` injects a `<semantic-pushback-check>` block **last** in `additionalContext` "to exploit attention recency bias" (line 833).

**Epistemic bus** (`epistemic_bus.py`, 253 LOC): **synchronous in-process pub/sub** — dumb fanout, not an event log. Useful event vocabulary: `memory_pressure`, `context_evicted`, `confidence_dropped`, `page_fault`, `investigation_spinning`, `calibration_drift_detected`.

**Statusline** (`statusline_empirica.py`, 1476 LOC) reads live from `SessionDatabase`, emits ANSI single-line: `🎯3 ❓6/4 ████░░░░ 45%` with moon-phase emoji.

**Borrow for Cycloid:**

- **Table-driven MCP wrapper** — one registry → N tools, schema auto-generated from numeric/boolean/enum param sets. Cleanest pattern seen for keeping MCP in lockstep with a CLI. Sandbox-bridge could expose registry-driven MCP for `arc` CLI commands.
- **Attention-recency injection placement** — put the steering block (current durableStep / current PR state / known dead-ends) **last** in `additionalContext` every turn.
- **`bootstrap_context` three-circle pattern** — single bootstrap MCP tool emitting active_state + persistent_reference + topic_relevant_backlog. Maps onto session DO state + project memory + repo-scoped past sessions we already have half-built.
- **`noetic_batch`** — sandbox-bridge could expose `bridge_batch_read` so Codex's investigation phase costs one round-trip.
- **`--evidence <commit-sha>` on task close** — ties completion claims to something deterministic. Add an `evidence:` field to `durableStep` completion records.
- **Event-type vocabulary** for our existing D1 + Durable Object event stream.

**Skip:**

- An **in-process synchronous pub/sub bus** on our multi-process Workers + sandbox + DO architecture — we already have D1 + DO event streams.
- The **2963-line monolithic gate hook**.
- A **24-hook chain** with cumulative timeouts. Codex runs thousands of tool calls per session — 5s × thousands blows the latency budget. Pick 1–2 hooks (PreToolUse readiness gate, SessionStart context bootstrap), merge the rest into bridge logic.

## 7. Handoff system — dual git-notes + SQLite

**This** is Empirica's actual cross-session persistence (the EPP skill, despite the name, is _within-conversation_ anti-sycophancy — its docs say so).

`EpistemicHandoffReportGenerator` at session end writes: `task_summary`, `epistemic_deltas` (pre/postflight vector delta), `key_findings`, `knowledge_gaps_filled`, `remaining_unknowns`, `recommended_next_steps`, `artifacts_created`, `compressed_json` + `markdown`.

Stored via `HybridHandoffStorage`: (a) git notes at `refs/notes/empirica/handoff/{session_id}` and (b) SQLite `handoff_reports` table. Writes go to both; reads prefer DB, fall back to git.

CLI: `empirica project-handoff --session-id` at end, `empirica project-bootstrap --session-id` at start of next. Bootstrap loads postflight vectors as the new session's preflight + injects findings/dead-ends via Qdrant similarity on task context.

Four breadcrumb categories — findings, unknowns, dead-ends, mistakes — persisted to SQLite + `.breadcrumbs.yaml` + Qdrant. **Dead-ends and lessons never decay**; eidetic facts decay only on contradiction; episodic narratives use time-recency.

**Borrow for Cycloid:**

- **Structured handoff_reports row** keyed on session_id with `findings | remaining_unknowns | dead_ends | recommended_next_steps`. Our extraction is freeform markdown today — promote these to typed columns so the next session's bootstrap can query precisely.
- **Dead-end ledger that never decays.** Cycloid re-tries failing approaches across sessions (wrong dir, missing env var). Per-repo `dead_ends.jsonl` loaded at sandbox boot beats generic `AGENTS.md`.
- **SessionStart hook injects findings + dead-ends scoped to task** via similarity. We already do "similar past sessions"; bake `dead_ends` and `remaining_unknowns` as their own injection slots.

**Skip:** the **git-notes mirror to customer repos** — pollutes the repo unless we maintain a side-channel branch. D1 alone is fine.

## 8. Cortex peer-AI mesh — borrow the completion handshake

Two layers:

- **DispatchBus** (`dispatch_bus.py`): typed action protocol over `GitMessageStore` (git notes as transport). `DispatchMessage{action, from_instance, to_instance, payload, correlation_id, priority, deadline, required_capabilities, callback_channel}` → `DispatchResult{correlation_id, status, payload, error, duration_ms}`. Instance registry declares capabilities (`gmail`, `browser`, `codebase`). Route by direct `instance_id` OR `"*"` + `required_capabilities`. CLI: `bus-register / bus-dispatch / bus-subscribe / bus-poll`.
- **EventListener + Cortex**: push wake via **ntfy** (HTTP held-stream `curl -sN`), tag-filtered server-side. Wake is a ping; listener fetches the actual proposal envelope from Cortex `/v1/orchestration/inbox`. **ECO gate** = human Accept/Decline on Cortex.

**Completion handshake**: when target AI calls `cortex_complete_proposal`, an outbox `completed` event fires to the source AI carrying `audit_log.details.commit_sha` — the literal "commit SHA in the handshake."

**Borrow for Cycloid:**

- **Completion handshake with commit SHA + PR URL** as a typed envelope. We already emit PR-created webhooks; formalize the envelope, propagate as a wake event back to the originating Slack/UI session. Auditable.
- **Capability-routed dispatch on `"*"`** — for parallel multi-agent investigations, declare capabilities (`browser`, `github`, `vercel-deploy`) and dispatch by required-capability rather than instance names.
- **ECO-style content-layer re-authorization** — any wake-triggered sandbox spawn re-verifies against control-plane state (business membership, repo access) at action time; never trust the wake payload. Matches our "control plane owns auth" invariant; make it structurally explicit.

**Skip:**

- **Git-notes-as-transport** for multi-tenant — plaintext, no auth on `from_instance`.
- **ntfy push** — we have webhook + DO infrastructure.

## 9. EPP (Epistemic Persistence Protocol) — what it actually is

**EPP is NOT cross-session persistence.** It's within-conversation anti-sycophancy: a `<semantic-pushback-check>` block (~400 tokens) injected into every UserPromptSubmit prompt, instructing Claude to:

1. ANCHOR prior position with confidence + source_type.
2. CLASSIFY pushback as EMOTIONAL/RHETORICAL/EVIDENTIAL/LOGICAL/CONTEXTUAL.
3. DECIDE HOLD/SOFTEN/UPDATE/REFRAME via an explicit calibration table (e.g. confidence 0.9–1.0 RETRIEVED → update threshold 0.85).
4. RESPOND.

In-context recall only; EPP docs: "EPP does NOT persist Claude's prior positions to any file."

**Borrow for Cycloid:** position-anchor framing (claim + confidence + basis + what-would-change-my-mind) for **plan documents** in spec/plan flows, not the runtime loop — Cycloid sessions are autonomous to a PR, with no mid-session human pushback for EPP to mitigate.

## 10. What we explicitly do NOT borrow

- **Git notes as cross-tenant transport** — plaintext, no auth, solo-dev only.
- **Qdrant** — D1 FTS5 + LLM rerank is simpler at our scale.
- **`memory_swap.py`** — CWD-quirk workaround we don't need.
- **24-hook chain with cumulative 90s timeouts** — blows Codex's per-turn latency budget.
- **The 13-vector self-reported ceremony** per transaction — borrow the gate idea, not the vectors.
- **`MEMORY.md` swarm learning** via shared file — assumes co-located processes; cross-session memory must go through D1/R2 for us.
- **In-process synchronous EpistemicBus** — we have multi-process event streams.
- **"Noetic / Praxic / Sentinel Constitution"** vocabulary — flavor, not engineering.

## 11. Skeptical caveats

- **Three different "4-layer" diagrams** that disagree (load-time tiers vs storage backends vs L1–L5). Organic growth, retro-documented — treat docs as inspiration, not coherent design.
- **5 different decay/ranking formulas** across `context_budget.py`, `memory_manager.py`, `findings_deprecation.py`, `session-end-postflight.py` with different tau values (24h vs 30d). Pick ONE for Cycloid.
- **Self-reported telemetry** — EPP activations, 13 vectors, calibration are all LLM-self-reported; "weak signal" per the docs. Trending only, not auditing.
- **Roadmap admits unimplemented pieces**: "Automatic branch pruning ❌ Not started", "Dynamic persona selection ❌", "Winner→Extract→Embed flow ❌". Don't borrow what isn't built.
- **EPP misnamed** — the actual cross-session artifact is the Handoff System.

---

## Recommended Cycloid next steps (priority order)

1. **Read-vs-write tool classification + AxiologicGate at the sandbox-bridge `PreToolUse` boundary** — cheapest big win; cuts "agent edits before investigating."
2. **Typed `handoff_reports` row at session end** (findings / remaining_unknowns / dead_ends / recommended_next_steps) + auto-inject at next session start scoped to task similarity.
3. **Dead-end ledger that never decays**, per-repo, loaded at sandbox boot.
4. **Type-weighted recency ranking** as the single canonical surfacing formula — `impact × type_confidence × recency_decay`, one formula everywhere.
5. **Auto-section delimiters in `AGENTS.md`/`CLAUDE.md`** with line caps; preserves human edits between markers.
6. **Domain × criticality YAML registry** for required checks per repo/work-type.
7. **Self-vs-observed Brier divergence** — declare expected outcome before a praxic step, Brier-score after, persist divergence per `(repo, work_type)`.
8. **`noetic_batch`-style bundled inspection MCP tool** — one round-trip for many reads/greps/globs.
9. **`bootstrap_context` three-circle pattern** as a single MCP tool returning active_state + persistent_reference + topic_relevant_backlog.
10. **Compressed handoff snapshot** for sandbox resume + `should_refresh` heuristic.
11. **Completion handshake envelope** carrying `commit_sha + pr_url` propagated back to originating Slack/UI session.
12. **Attention-recency injection placement** — steering block last in additional context.
13. **Context-budget zone model** (anchor / working / cache) with reference-count-weighted eviction.

## Key file references in empirica repo

- `empirica/core/memory_manager.py` — L1/L2 manager, promotion/demotion, auto-section
- `empirica/core/context_budget.py` — zone-based eviction with priority scoring
- `empirica/core/findings_deprecation.py` — time-decay relevance scoring
- `empirica/core/sentinel/orchestrator.py` — gate orchestrator
- `empirica/plugins/claude-code-integration/hooks/sentinel-gate.py` — PreToolUse gate (2963 LOC)
- `empirica/config/domains/*.yaml` — domain × criticality required checks
- `empirica/core/post_test/dynamic_thresholds.py` — Brier reliability thresholds
- `empirica/core/post_test/grounded_calibration.py` — Bayesian per-vector update
- `empirica/data/epistemic_snapshot.py` — compressed cross-AI handoff
- `empirica/core/handoff/` — handoff report generator + hybrid storage
- `empirica/core/dispatch_bus.py` — typed cross-instance protocol
- `empirica/core/epistemic_bus.py` — in-process pub/sub + event vocabulary
- `empirica/core/issue_capture.py` — auto-captured issues lifecycle
- `empirica-mcp/empirica_mcp/server.py` — table-driven MCP wrapper (~55 tools)
- `empirica/plugins/claude-code-integration/hooks/tool-router.py` — attention-recency injection
- `empirica/plugins/claude-code-integration/scripts/statusline_empirica.py` — live statusline
- `docs/architecture/MEMORY_ARCHITECTURE.md`, `CANONICAL_STORAGE.md`, `GRAPH_TEMPORAL_LAYER.md`
- `docs/architecture/SENTINEL_ARCHITECTURE.md`, `SENTINEL_CONSTITUTION.md`, `PHASE_AWARE_CALIBRATION.md`
- `docs/architecture/HANDOFF_SYSTEM.md`, `DISPATCH_BUS.md`, `EVENT_LISTENER.md`, `EPP_ARCHITECTURE.md`

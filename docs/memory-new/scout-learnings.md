# Scout Learnings

Audit of [agno-agi/scout](https://github.com/agno-agi/scout) for Cycloid's memory system — with a heavy lens on **living-in-Slack as a memory substrate**, per Shivam's framing.

## TL;DR

Scout is a single agent with multiple `ContextProvider`s — each provider exposes two natural-language tools (`query_X` / `update_X`) and hides a sub-agent that owns the source's quirks. Memory is the agent maintaining its own CRM (Postgres `scout.*` tables) and markdown wiki via `update_crm` / `update_knowledge` mid-conversation.

The big shift vs everything else audited: **Scout lives in Slack rather than consuming it.** Each Slack thread is a session (`session_id = thread_ts`); replying weeks later resumes the same agno session with full history. Channel and user identity are first-class context. Most relevant angle for Cycloid — today we consume Slack as a trigger/notification channel; "living in" it unlocks memory primitives we currently build by hand.

Caveats: the actual Slack/threading mapping lives in the external `agno==2.6.4` package, not Scout. The "links Josh to the RLM paper" pitch is unwired (no FK, no frontmatter, no eval). Knowledge wiki is gitignored by default and ephemeral. But the patterns — sub-agent isolation, `query_X`/`update_X` symmetry, wiring evals as a sub-second tier, schema-on-demand inside a guarded schema, read/write split — are concrete and copy-able.

---

## 1. Living-in-Slack: the memory unlock

Cycloid today: webhook in, status post out. Scout: teammate-grade integration with `assistant:write`, threading-as-sessions, Slack search as RAG.

### Slack → Session mapping

`docs/SLACK_CONNECT.md:165`: **"Thread timestamps are used as session IDs, so each Slack thread is an independent conversation with full history."**

- `session_id = thread_ts` (top-level message ts if no thread yet)
- `user_id = slack_user_id` (or resolved display name when `resolve_user_identity=True`)
- Storage: standard agno `sessions` Postgres table, `ai` schema
- Reopening a thread weeks later resumes the session, replays last 5 runs (`num_history_runs=5`) plus long-term `enable_agentic_memory=True`

Scout adds ~10 lines (`app/main.py:30-41`); the heavy lifting is agno's `Slack` interface (signing verification, retry dedup, streaming PATCH updates).

### Event flow

Webhook → `https://<host>/slack/events`. Subscribed bot events: `app_mention`, `message.channels`, `message.groups`, `message.im`. agno verifies signing secret, dedupes retries, derives `session_id`/`user_id`, calls `scout.arun(text, session_id=..., user_id=...)`. Streaming on → tokens PATCH the message in place.

### What memory keys off

**Only `user_id` and `thread_ts`** — not channel, not team. All CRM rows scoped `WHERE user_id = '{user_id}'`. Two coworkers in the same channel get separate memories; the same user across DM and channel thread shares CRM but has separate per-thread conversation history.

### `assistant:write` + the assistant pane

The manifest opts Scout into Slack's first-class **AI Assistant** surface — right-rail pane with native thinking indicators, suggested prompts, persistent thread-as-conversation UX. Scout asks for the scope but doesn't customize `assistant_thread_started` / `assistant_thread_context_changed`, so it gets the pane "for free" from agno without using its features (suggested follow-ups, context cards).

### Borrow for Cycloid — Slack memory unlocks

Each is something we'd build by hand today:

1. **Threading = free session continuity.** Adopt `session_id = team_id:channel_id:thread_ts`. A Slack reply weeks later resumes the same Cycloid session DO — just a deterministic mapping table.
2. **Channel = free scope/namespace.** Channel id is a stable namespace for repo/project routing. Invite `@Cycloid` into `#repo-foo` → every task auto-routes to that repo. Replaces per-message repo-disambiguation prompting.
3. **`assistant:write` pane = a real chat home.** "Post status update" becomes two-way conversation with typing indicators, suggested follow-ups; `assistant_thread_context_changed` carrying source channel = free user-intent context.
4. **`chat:write.customize` = post AS the requester.** Scout requests but doesn't use. Cycloid could post PR-opened messages with the _user's_ avatar/name — better for Slack-native CODEOWNERS pings and accountability.
5. **`search:read.public` + `query_slack` = free RAG over team history.** Before opening a PR, search `#eng-decisions` for prior discussions of the file being touched, cite in PR body. No ingestion pipeline needed.
6. **`files:read` = free document ingestion.** Drag a PDF spec or screenshot into the thread → attached to session. No upload UI, no D1 blob handling.
7. **`users:read.email` = free identity bridge.** Email joins Slack user → GitHub user (verified email) → Cycloid user row. One scope replaces "link your GitHub" onboarding.
8. **Reactions as feedback signal.** Subscribe to `reaction_added`; ✅ on a Cycloid message = positive eval, ❌ = negative. Feeds Braintrust without explicit thumbs UI.
9. **DM/thread duality as scope axis.** Scout treats DM and channel thread identically; Cycloid could differentiate ("private debugging" vs "team-visible work") for memory scope.
10. **Cross-thread, cross-channel memory keyed on Slack identity.** Scout misses this (no channel/team partitioning). Design it in upfront: per-user durable memory + per-thread session history + per-channel repo binding.

### Honest caveats on the Slack angle

- **The interesting session/thread mapping is in the agno library, not Scout.** Scout is mostly composition.
- **`assistant:write` requested but custom handlers aren't wired** — pane only, no suggested prompts or context cards.
- **`SlackContextProvider` is read-only.** Sending goes through agno's `Slack` interface (`AGENTS.md:155`: "Sending is disabled (Slack interface handles posting)").
- **No cross-thread, cross-channel memory** beyond `user_id` — channel/team aren't partitioning keys anywhere. Borrowing idea #10 above is a _gap_, not a Scout pattern.
- **No Slack→CRM identity resolution.** `users:read.email` is requested; dedup-by-email into a `scout_contacts` row doesn't exist (dedup rule is primary email only, free-text matched).

## 2. Core architecture — `ContextProvider` + sub-agent isolation

Each provider exposes exactly two tools to the main agent:

- `query_<id>` — read (always present)
- `update_<id>` — write (only when supported; voice is `write=False`)

Inputs are a **single natural-language string** (`question` for query, `instruction` for update). Outputs are `Answer(results: list[Document], text)`. The main agent never sees structured tool schemas or source quirks.

Behind each tool is a **dedicated sub-agent** with:

- Its own LLM instance (same family, fresh — "avoids shared-state footguns")
- Its own tools (e.g. `SQLTools(get_readonly_engine())` for CRM read, `SQLTools(get_sql_engine())` for CRM write)
- Its own prompt (`SCOUT_CRM_READ` vs `SCOUT_CRM_WRITE` are distinct)
- **Quirk isolation**: pagination cursors, `conversations.replies`, `corpora=all`, SQL DDL never enter the main agent's context. Sub-agent collapses everything to an Answer string — Scout sees `"Saved note ... (id=47)"`, not the SQL.

CRM splits **read and write into separate sub-agents** so the read path _physically can't write_ (read engine has `default_transaction_read_only`).

### Provider table

| Provider         | Trigger                       | Tools                                                                          |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| Web              | always on                     | `query_web` (Parallel SDK or free Parallel MCP)                                |
| Workspace        | always on                     | `query_workspace` (rooted at Scout repo — Scout can answer about its own code) |
| Database (CRM)   | always on                     | `query_crm`, `update_crm`                                                      |
| Wiki (knowledge) | always on                     | `query_knowledge`, `update_knowledge`                                          |
| Wiki (voice)     | always on                     | `query_voice` (read-only, code-managed)                                        |
| Slack            | `SLACK_BOT_TOKEN`             | `query_slack` (read-only)                                                      |
| GDrive           | `GOOGLE_SERVICE_ACCOUNT_FILE` | `query_gdrive` (read-only)                                                     |
| MCP              | per server                    | one `query_mcp_<slug>` per registered server                                   |

### "Navigation over search"

README: _"Coding agents figured out the right approach. They navigate: `ls`, `grep`, open the file, follow the import. Scout does the same thing across Slack, Drive, and the rest."_

**No vector DB in the repo.** Each source is browsed live per-question by its sub-agent:

- Wiki: filesystem markdown walk
- Web: `web_search` → `web_extract` / `web_fetch`
- Slack: `search.messages` + `conversations.replies`
- GDrive: folder/file traversal (`AllDrivesGoogleDriveTools`)
- CRM: SQL introspection-first ("Introspect first … query `information_schema.columns`")

### Borrow for Cycloid

1. **`query_memory` / `update_memory` natural-language tool pair** backed by a sub-agent owning embedding/keyword/SQL search quirks. Replaces "inject similar past sessions into the prompt" — main agent context stays clean; sub-agent decides retrieval method.
2. **Sub-agent quirk isolation as a hard invariant** with wiring-eval enforcement: assert the orchestrator does NOT hold raw tools belonging to a sub-system (Cycloid's "control-plane agent must not hold bare `D1Tools`").
3. **Read/write split into separate sub-agents per provider** — different prompts, different DB connections, read path can't write. Maps onto Cycloid memory ("extract" vs "persist").
4. **Provider `mode` enum (`default`/`agent`/`tools`)** — A/B whether a noisy integration belongs as direct tools or sub-agent-wrapped without touching the calling agent.
5. **`list_contexts` introspection tool** — returns `[{id, name, ok, detail}]` so the agent self-diagnoses missing integrations.

## 3. Memory growth — CRM + wiki, agent-maintained

### CRM (Postgres `scout.*`)

Four canonical tables via idempotent DDL (no Alembic; `CREATE TABLE IF NOT EXISTS`):

- `scout_contacts` — name, emails[], phone, tags[], notes
- `scout_projects` — name, status, tags[]
- `scout_notes` — title, body, tags[], `source_url`
- `scout_followups` — title, notes, due_at, status (`pending`/`done`/`dropped`), tags[]

Every table: `id SERIAL PK`, `user_id TEXT NOT NULL`, `created_at TIMESTAMPTZ`.

### Schema on demand — real and guarded

"Track my coffee orders" → the CRM write sub-agent issues `CREATE TABLE scout.scout_coffee_orders (...)` with standard columns + inferred domain fields, then INSERTs. Writes confined to the `scout` schema by a SQLAlchemy `before_cursor_execute` hook that **rejects DDL/DML targeting `public`/`ai`** (wiring check W3 exercises it directly).

Write engine permissive; read engine `default_transaction_read_only=True` — physically can't write.

Every write scoped to `user_id = '{user_id}'`. Sentinel `user_id="anon"` (W7) prevents an unrendered `{user_id}` template literal from leaking into SQL.

### Wiki (markdown files)

- `wiki/knowledge/` — **agent-writable**. `FileSystemBackend` by default (gitignored — ephemeral across container restarts), flips to `GitBackend` when `WIKI_REPO_URL` + `WIKI_GITHUB_TOKEN` set.
- `wiki/voice/` — **code-managed** style guide (`slack-message.md`, `email.md`, `x-post.md`, `document.md`), `write=False` so `update_voice` doesn't exist.

`GitBackend` per `docs/WIKI_GIT.md`: every `update_knowledge` clones (first use), writes the page, stages, commits with an LLM-summarised one-line message, rebases onto remote, pushes. Conflicts surface as errors, not silent overwrites. PAT scrubbed from logs by a `Scrubber`.

### When does writing happen

**Synchronously, in-conversation, every turn.** No background workers, no post-session extraction, no scheduled compactors. `scout_followups.due_at` is a stub for an unbuilt "future scheduled cron." Routing instructions: "save", "add", "track", "log", "remind me", "file a learning", "record a runbook" → all user-initiated.

### Link model — there isn't one

Biggest pitch-vs-reality gap. README: "Scout adds Josh to the CRM, parses the paper into the wiki, and links them." In code: **no FKs, no `wiki_page_id` column, no `crm_contact_id` frontmatter**. Only link primitive is `scout_notes.source_url TEXT`. Cross-references are whatever prose the LLM writes into markdown. No eval tests CRM↔wiki linking — `scout_wiki_round_trip` writes and reads back, never crosses providers.

### Borrow for Cycloid

1. **Schema-on-demand inside a guarded sub-schema.** Let the agent CREATE TABLE in a fenced schema (`arc_*`) with fixed-column prefix (`id`, `user_id`, `created_at`) + domain fields. The `before_cursor_execute` engine-level guard rejecting writes outside scope is exactly the fail-closed defense our CLAUDE.md prefers.
2. **Read/write engine split at the SQL level**, not just the prompt — read engine in `READ ONLY` transaction mode.
3. **GitBackend for durable memory** — private GitHub repo as backing store. Free audit trail, PR review of agent-filed pages, history via `git log -p`, LLM-written commit messages, auto-rebase on conflict, error rather than silent overwrite. Better than D1 for prose memory.
4. **Voice = read-only code-managed wiki.** Host `docs/conventions.md`, escalation policies, bridge prompts as `query_voice` content — agent reads before drafting customer-facing content; never agent-editable.
5. **Three-status follow-ups (`pending`/`done`/`dropped`)** instead of soft-delete — preserves history without polluting active reads.
6. **Sentinel default values** preventing template-literal leakage (`user_id="anon"` so an unrendered `{user_id}` can't pass as an unauthenticated query).

## 4. Eval discipline — three tiers + a live-container loop

Cleanest eval rigor across the five audits.

### Tier 1 — Wiring (`evals/wiring.py`, no LLM, <1s)

Nine structural assertions:

- W1: Scout's tool surface does NOT contain bare `SQLTools` / `run_sql_query` (must be CRM sub-agent-wrapped)
- W2: CRM provider overrides BOTH `aquery` and `aupdate` (base raises `NotImplementedError`)
- W3: Schema guard fires on `CREATE TABLE public.pwned`, `INSERT INTO ai.secrets` — exercised against the real engine
- W4: Every provider has `id: str`, `name: str`, callable `query`/`status`/`get_tools`/`instructions`
- W5: GDrive uses `AllDrivesGoogleDriveTools` (Shared Drives), not the default
- W6: MCP provider lifecycle (`asetup`/`aclose`)
- W7: Scout has sentinel `user_id` so unrendered `{user_id}` template can't leak into SQL — **brilliant**
- W8: Knowledge is read+write, voice is read-only
- W9: `scout_followups` is in canonical DDL

### Tier 2 — Behavioral (`evals/cases.py`, ~30 cases)

`expected_tools` / `forbidden_tools` substring checks, `response_contains` / `response_matches` regex, multi-turn `followups` in the same session. Tests routing collisions ("note" is ambiguous CRM-vs-wiki), DDL-on-demand, DDL boundary refusals, prompt-injection from tool output, graceful degradation per provider.

### Tier 3 — LLM-judge (`evals/judges.py`, 7 cases)

`AgentAsJudgeEval` scored 0–10 against rubrics with explicit point partitions ("+4 names file, +3 cites webViewLink, +2 no fabrication, +1 focused"). Default pass at 7.0. **Each judged case forks a fresh `session_id`** to prevent cross-case history bleed; `user_id` extracted from prompt.

### Tier 4 — Live-container `/loop` improvement harness (`IMPROVE_WITH_CLAUDE.md`)

`/loop` autonomously probes a running scout-api with ~28 hand-written probe categories (A through BB), edits `scout/instructions.py`, commits per iteration, stops on two clean sweeps. Hot-reloads on file save; never touches Docker; persists state in `tmp/improve-state.md`.

### Borrow for Cycloid

1. **Wiring evals as a separate, sub-second tier.** The W1–W9 model — assertions on tool shape, override correctness, guard activation, template-literal anti-leaks — catches a whole regression class cheaply. Cycloid has nothing equivalent. **Highest-leverage borrow on the page.**
2. **Fresh `session_id` per eval case** so `add_history_to_context` can't leak prior cases. Any Cycloid eval suite reusing session memory must adopt this.
3. **Live-container `/loop` improvement harness** — probe → triage → one edit → commit → state file → repeat. Maps onto `durableStep` cadence.
4. **Behavioral cases test routing collisions explicitly.** Cycloid has analogous ambiguities (e.g. "PR" the integration vs "PR" the artifact); test them by name.
5. **Three-tier model** (wiring → behavioral → judge) with clear cost/coverage tradeoffs — adopt the framing even without copying harnesses verbatim.

## 5. What we explicitly do NOT borrow

- **agno framework dependency.** The Slack mapping, sub-agent dispatch, and `ContextProvider` base live in `agno==2.6.4` — not vendored. Borrow patterns, not the dependency.
- **No background memory work.** Scout writes synchronously in-turn. For Cycloid, where sessions complete and produce PRs, post-session extraction remains the right cadence.
- **The "links Josh to RLM paper" pitch as wired.** It isn't — design our own link model from scratch.
- **Gitignored knowledge wiki by default.** Ephemeral storage masquerading as memory. Always use GitBackend or a real DB.
- **Single `user_id`-only scoping.** No channel/team partitioning — design ours in upfront.

## 6. Skeptical caveats

- **agno is the magic.** Scout is ~7 Python files in `scout/` plus a tiny app shim; the interesting Slack threading, sub-agent dispatch, and `ContextProvider` base class are upstream. Our implementation will be new code.
- **Pitch vs reality on linking.** No FKs, no frontmatter, no eval — "linked them" is LLM prose.
- **`assistant:write` requested but unused** (no custom handlers; suggested prompts, context cards unused).
- **Sub-agent dispatch mechanism isn't visible in repo** — Scout asserts outcomes (W1: no bare SQL on Scout) not mechanism (how agno bridges tool call → sub-agent run → string return).
- **Behavioral eval breadth is in the live-container probe library** (hand-driven), not CI — excellent but not automated regression.
- **No cross-thread, cross-channel memory beyond `user_id`** — a real gap, not a pattern.

---

## Recommended Cycloid next steps (priority order)

**Slack-as-substrate (the big architectural shift):**

1. **`session_id = team_id:channel_id:thread_ts`** with a deterministic mapping table from Slack threads to Cycloid session DOs. A Slack reply resumes the same session.
2. **Channel = repo binding.** `@Cycloid` invited into `#repo-foo` auto-routes tasks; stable namespace replaces per-message disambiguation.
3. **Opt into `assistant:write` + customize handlers** — `assistant_thread_started` and `assistant_thread_context_changed` carry source channel = free intent context. Use suggested follow-ups + context cards.
4. **`chat:write.customize` so PR-opened messages post AS the requester** — Slack-native accountability.
5. **`search:read.public` + `query_slack` as a sub-agent tool** — free RAG over team conversational history at PR-time.
6. **`files:read` for free document ingestion** — drag PDF/screenshot to thread, attached to session.
7. **`users:read.email` as the identity bridge** Slack user ↔ GitHub user ↔ Cycloid user. Replaces "link your GitHub" onboarding.
8. **Reactions as feedback signal** — `reaction_added` on Cycloid messages feeds Braintrust.

**Architecture (regardless of Slack):**

9. **`query_memory` / `update_memory` tool pair** backed by a sub-agent owning retrieval quirks; main agent context stays clean.
10. **Read/write split into separate sub-agents** with different DB connection modes (read engine `READ ONLY` at the engine level, not the prompt).
11. **Sentinel default values** (`user_id="anon"`) so unrendered template literals can't leak into SQL.
12. **Schema-on-demand inside a guarded `arc_*` schema** with `before_cursor_execute` engine-level rejection of writes outside scope.
13. **GitBackend for durable memory** — private GitHub repo with auto-rebase, LLM-written commits, PAT scrubbing.
14. **Code-managed read-only "voice" wiki** — conventions, escalation policies, bridge prompts as `query_voice` content. PR-only updates.
15. **Three-status lifecycle (`pending`/`done`/`dropped`)** on follow-ups/memories instead of soft-delete.

**Eval discipline (highest leverage of all):**

16. **Wiring eval tier** — sub-second, no LLM. Assert tool shape, sub-agent override correctness, schema guard activation, template-literal anti-leaks, integration health invariants. **Do this first.**
17. **Fresh `session_id` per eval case** so memory doesn't bleed.
18. **Behavioral cases that explicitly test routing collisions.**
19. **Live-container `/loop` improvement harness** — probe → triage → one edit → commit → state file. Maps onto our `durableStep` cadence.

## Key file references in scout repo

- `scout/contexts.py` — all 8 `ContextProvider`s + `create_context_providers()` factory
- `scout/agent.py` — main agent definition (`enable_agentic_memory=True`, `num_history_runs=5`, `add_history_to_context=True`)
- `scout/instructions.py` — main prompt including `{user_id}` template + routing rules
- `scout/settings.py` — fresh-model factory pattern
- `app/main.py:30-41` — Slack interface wiring (10 lines)
- `app/router.py` — minimal HTTP shell
- `db/tables.py` — 4 canonical tables + idempotent DDL
- `evals/wiring.py` — **W1–W9 structural assertions** (the highest-leverage file in the repo)
- `evals/cases.py`, `judges.py`, `runner.py` — behavioral + LLM-judge tiers
- `docs/SLACK_CONNECT.md` — full Slack manifest, scopes, scope rationale
- `docs/WIKI_GIT.md` — Git-backed wiki write loop
- `docs/EVALS.md`, `docs/EVAL_AND_IMPROVE.md`, `docs/IMPROVE_WITH_CLAUDE.md` — eval discipline + live `/loop` harness
- `wiki/voice/{document, email, slack-message, x-post}.md` — code-managed style guide
- `AGENTS.md` — internal architectural doc
- External: `agno==2.6.4` for `ContextProvider`, `Slack` interface, sub-agent dispatch (not in repo)

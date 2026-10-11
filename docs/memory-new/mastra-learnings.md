# Mastra Learnings

Notes from auditing the [Mastra memory docs](https://mastra.ai/docs/memory/overview) for Cycloid memory-system ideas.

## TL;DR

Mastra is a framework, not a research engine — the design _is_ the source. High-value ideas: the **scope model** (`thread` vs `resource`), **typed working-memory schema**, **observational ↔ reflection tiering**, **per-stage retrieval pipeline with redaction-before-persistence**, plus small ergonomics (`readOnly`, `messageRange`, `generateTitle`). Skip the `Memory` class (libSQL/Node defaults, requires their runtime). Their Cloudflare D1 + Vectorize adapters confirm the patterns work on our stack without porting.

---

## 1. Scope model — `thread` × `resource`

Every memory call is keyed on two IDs:

- `resourceId` — stable owner (user/agent/entity), shared across threads.
- `threadId` — single conversation; owned by exactly one resource at creation, cannot be reassigned.

Defaults: message history is thread-scoped; working memory, semantic recall, and observational are configurable, default **resource**. Subagent calls auto-derive child resource id `{parentResourceId}-{agentName}` for per-role memory.

**Borrow for Cycloid:**

- Map: `resource = (userId, repoId)` or `(businessId, repoId)`; `thread = sessionId`.
- Our `AGENTS.md`/`CLAUDE.md` target is effectively resource-scoped with **no thread axis**. Adding one gives a home for transient observations that shouldn't pollute repo docs (e.g. "tests flaked on a port collision this session" — useful for the next continuation only).
- Bake `scope` ('thread' | 'resource') as an explicit column in `memory/db.ts`, not implicit repo-keying.
- If Codex specializes into planner/fixer/reviewer agents, the child-resource pattern gives per-role memory cheaply.

## 2. Working memory — agent-controlled scratchpad

Persistent block the agent **edits live mid-session** via an `updateWorkingMemory` tool. Auto-injected every turn. Distinct from observational memory (post-hoc, like our analyzer).

```ts
workingMemory: {
  enabled: true,
  scope: 'resource' | 'thread',  // default 'resource'
  template?: string,             // Markdown -- REPLACE semantics
  schema?: ZodSchema,            // structured -- MERGE semantics, null deletes
}
```

**Borrow for Cycloid:**

- A live, agent-edited scratchpad is our biggest gap: today we learn only **after** a session — the running agent can't write "this repo uses pnpm, not npm" when it discovers it. A bridge-surfaced working-memory tool captures mid-task facts now lost or re-discovered.
- **Use schema mode (Zod/JSON Schema), not Markdown.** Structured per-repo facts (build/test/lint cmds, package manager, branch conventions) want merge semantics; Markdown replace-mode forces full rewrites and can silently drop content.
- Render schema → markdown at write time into `AGENTS.md`; on-disk format unchanged.
- `readOnly` flag: for replay/eval/benchmark sessions, load working memory but block writes.

**Bad fit:** auto-injecting every turn inflates tokens; Codex sessions are near context limits — gate by size/relevance.

## 3. Observational → Reflection tiering

Two background agents compress raw history into a tiered log:

```
raw messages  →[Observer @ 30k tokens]→  observations  →[Reflector @ 40k]→  reflections
```

Triggers: `observation.messageTokens`, `bufferTokens` (default 20% buffer), `bufferOnIdle`, `activateAfterIdle`, `activateOnProviderChange`, `ModelByInputTokens` tiered model router (cheap models for small chunks), `retrieval: { vector: true, scope }` — observations themselves become searchable.

**Borrow for Cycloid:**

- Three-tier mapping: 1. **Raw** = session transcript / tool calls (kept today). 2. **Observations** = per-session notes (what `analyzer.ts` produces). 3. **Reflections** = cross-session patterns merged into repo `AGENTS.md`/`CLAUDE.md`; making this explicit unlocks dedup/contradiction logic.
- **Triggers beyond "session completed"**: `activateOnProviderChange` (model swap) and `activateAfterIdle` (sandbox idle) are cheap wins; today we only run post-session.
- **`ModelByInputTokens` routing**: Haiku for small per-session observations, larger model for cross-session reflections — meaningful extraction-cost reduction.

**Bad fit:** Mastra runs the Observer _during_ the live session at ~6k-token cadence; our Worker/DO + sandbox split makes end-of-session extraction the natural cadence.

**Gap:** docs are silent on dedup/contradiction in the observation log — confirmed append-only. Our `analyzer.ts` handling is better; keep it.

## 4. Semantic recall — per-message vector search

```ts
semanticRecall: {
  topK: 3,
  messageRange: 2,                   // N neighbors before+after each hit
  scope: 'resource' | 'thread',
  filter: { projectId: { $eq: 'p-a' } }  // $and/$or/$eq/$in/$gt/$gte/$lt/$lte/$ne/$nin
}
```

Indexed unit is the **individual message**, not the session. Cloudflare Vectorize is a first-class backend.

**Borrow for Cycloid:**

- **`messageRange`** — return matched event plus N tool calls before/after instead of a session blob.
- **Per-message granularity** retrieves the exact failing tool call, PR review comment, or user correction.
- **Metadata filter operators** fit scoping by `repoId`, `userId`, `outcome=success`, `agentVersion`. Bake filter keys into the write path **now** — filters match at write time, not retroactively.
- **Cloudflare Vectorize backend** — no new infra dependency.

**Bad fit:**

- Indexing every message at our session sizes (hundreds of tool calls) is expensive. Pre-filter to high-signal events: errors, PR comments, user corrections, plan revisions.
- No documented similarity threshold — add a min-score cutoff.
- No reranking / no hybrid (BM25 + vector); pure embedding recall under-performs on code/identifier-heavy queries. Plan lexical signals.

## 5. Memory processor pipeline

```
Input:   [Memory Processors] -> [user inputProcessors]
Output:  [user outputProcessors] -> [Memory Processors]
```

Memory runs **first on input** (retrieved context visible to user processors) and **last on output** — user guardrails run _before_ memory persists. Listing a memory processor explicitly disables auto-injection for full ordering control.

Honest read: no built-in token limiter, redactor, or reorderer — the "pipeline" is three handlers plus BYO middleware. Don't build a heavy plugin framework chasing it.

**Borrow for Cycloid:**

- The durable lesson is the ordering rule: **redact/guardrail BEFORE persistence**, not at read time. Scrub secrets/tokens _before_ writing to `AGENTS.md`.
- **Stage retrieval into named steps** with per-stage token budgets: `recent-history` | `semantic-similar-past-sessions` | `repo-working-state`. Each capped, each independently swappable.

## 6. Multi-user threads — useful pattern, not an ACL

Many users in one thread keyed by one resourceId; identity injected via tag:

```html
<turn author_id="..." author_name="..." functional_role="...">...</turn>
```

Doc verbatim: **"Set the speaker from your authenticated request context, never from the request body."**

**Borrow for Cycloid:** for multi-actor sessions (Slack thread: reviewer + requester + agent), `<turn>` tags keyed off authenticated context keep per-user facts as tagged turns in one resource rather than fragmenting tables.

**Bad fit:** a string convention, not a permission model — no row-level ACL. Keep our business/repo auth boundary; never lean on tags for tenancy isolation.

## 7. Small ergonomics worth borrowing

- **`readOnly`** memory read — context without writes; perfect for replay/eval runs.
- **`generateTitle`** auto-titles a thread from the first user message via a small model.
- **Server-as-source-of-truth invariant**: clients send only the new turn, never replay history — codifies our control-plane ownership rule for any future "resume session" flow.

## 8. What to explicitly NOT borrow

- The `Memory` class — libSQL file storage default, Node-only.
- The streaming in-session Observer loop — end-of-session is our cadence.
- `lastMessages: 10` count-based recency window — a single Codex tool output can be 50k tokens; any equivalent must be **token-budgeted**.
- A general processor/plugin framework — a typed function chain in `memory/` suffices.
- Markdown replace-mode working memory — schema merge avoids silent drops.

---

## Recommended Cycloid next steps (priority order)

1. **Typed working-memory tool callable mid-session** — Zod schema, merge semantics, scope = `(userId, repoId)`, renders to markdown at write time. Biggest gap closed.
2. **Formalize `thread × resource` scope** in `memory/db.ts` — explicit columns, `thread = sessionId`, `resource = (userId, repoId)`. Unblocks 3 and 4.
3. **Stage the retrieval pipeline** into `recent-history | semantic-similar | repo-working-state` with per-stage token budgets; bake **redaction before persistence**.
4. **Three-tier extraction**: raw → per-session observation → cross-session reflection, with `activateOnProviderChange` / `activateAfterIdle` triggers; Haiku per-session, larger model for reflections.
5. **Pre-bake metadata filter keys** (`repoId`, `userId`, `outcome`, `agentVersion`) into the embedding write path.
6. **`readOnly` mode** for eval/benchmark runs.

## What we explicitly do NOT learn from the docs

- Concrete table schemas / migrations (`/docs/memory/storage` punts to a sparse reference).
- Dedup or contradiction logic in the observation log (confirmed append-only).
- Token budgeting in `lastMessages` (count-based only).
- Reranking, similarity thresholds, or hybrid lexical+vector retrieval.
- Anything resembling row-level ACLs.

## Key source pages

- `https://mastra.ai/docs/memory/overview`
- `https://mastra.ai/docs/memory/message-history`
- `https://mastra.ai/docs/memory/working-memory`
- `https://mastra.ai/docs/memory/semantic-recall`
- `https://mastra.ai/docs/memory/observational-memory`
- `https://mastra.ai/docs/memory/multi-user-threads`
- `https://mastra.ai/docs/memory/memory-processors`
- `https://mastra.ai/docs/memory/storage`
- `https://mastra.ai/reference/memory/memory-class`

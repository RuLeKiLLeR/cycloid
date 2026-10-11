# North Star: Remember, Refine, Retrieve (Applied Compute)

Source: https://www.appliedcompute.com/research/remember-refine-retrieve

## The thesis in one line

> Agent rollouts are training data for the knowledge base, not just outputs.

The contextbase is a living artifact continuously refined by human inputs and the agent's own work, not a static doc store.

## The three layers

### Remember

Ingestion layer. Pulls raw resources from SaaS connectors (S3, Azure, Google Drive, GitHub) plus **agent traces** from their Agent Cloud or third-party SDKs. Inputs:

- Existing docs (SOPs, wikis, runbooks)
- Completed work (tickets, codebases, exemplars)
- Secondary data (product logs, DBs, meeting notes, emails)
- **Agent rollout traces** — tool calls + turn-by-turn records, first-class alongside human docs.

Stores raw, not just distilled.

### Refine

Always-on swarm of context-curation agents. Three named operations:

1. **Summarize each rollout**.
2. **Extract key procedures and facts** as a follow-up step.
3. **Extract concept links + resolve conflicting information**.

Output is a structured **Contextbase** of three types:

- **Facts** — what "good" looks like at this company.
- **Skills** — how this team approaches a class of problem.
- **Episodes** — reconstructable prior work.

Procedures carry **rollout-ID + turn-range citations** (verbatim example: `[rollout d593c43c, turns 32-38]`). HITL: "subject matter experts can accept or reject changes to the Contextbase." Continuous, not one-shot: each pass combines new Remember data with the existing Contextbase.

### Retrieve

Runtime APIs the agent calls to search the Contextbase. **Mechanics deliberately undisclosed** (likely competitive moat) — no re-ranking signals, no graph-vs-vector commitment.

## Worked example (verbatim from their post)

> "Do not count on Excel recalculation. Because `libreoffice/soffice` is absent and `openpyxl` does not recalc, the winning strategy is usually: extract cached base values, manually recompute only the scenario-dependent lines, write the final outputs as literal numbers into a new sheet or summary block."

Compact procedural knowledge with provenance citation — the shape of a Contextbase entry.

## Why this beats vanilla RAG (their framing)

Knowledge-work knowledge vs code: 1. **Scattered**, not centralized. 2. **Hidden** dependencies, no explicit graph. 3. **Silent divergence**, no merge conflicts.

Claimed advantages: continual learning from agent rollouts, conflict resolution, HITL curation, cold-start usability.

## Evals

- **APEX-Agents** (Mercor, 208 Law/IB/Consulting tasks): 44.2% → 51.7% with Contextbase (+16.9% rel).
- **GDPVal** (OpenAI, 89 tasks / 44 occupations): 83.6% → 85.1%.
- **Reasoning amortization**: low-reasoning + Contextbase ≈ medium-reasoning without (44.5% → 52.4%).
- Caveat: training-time traces were **simulated** (3 rollouts per train sample), not real production.

## Translation to Cycloid living in Slack

**Remember**: unified ingestion in `control-plane-worker` capturing Slack messages/threads/DMs/files/incident channels (Events API + scheduled backfills), GitHub PRs/issues/comments, Codex session traces. Store raw artifacts in D1 + R2 with provenance (`session_id`, `slack_ts`, `pr_number`, `turn_range`) on every row. Today's `apps/control-plane-worker/src/memory/` is the seed — single source (Codex), single sink (AGENTS.md). Generalize.

**Refine**: continuous Durable Object / cron-driven swarm. Stages:

1. Per-source summarize (per Slack thread, per PR, per session)
2. Extract atomic facts / skills / episodes
3. Cross-source link extraction (which Slack thread caused which PR caused which incident)
4. Contradiction resolution against existing company map
5. HITL queue for high-confidence-but-conflicting writes

Refine writes to a **queryable Contextbase**, not a markdown file.

**Retrieve**: new API surface hit at runtime by sessions, the Slack bot, and PR-review flows. Hybrid is the safe default: vector over chunks + structured filters over D1 (repo, channel, user, time, customer) + graph traversal over fact → episode → artifact links. Re-rank by recency, source-authority, confirmed-vs-inferred.

## The "live in Slack" thesis derived from this

Cycloid isn't surfacing in Slack — it's **learning the company from Slack** to do the next task better. Every Codex session, Slack incident triage, and PR review refines the company map. Slack is the highest-bandwidth Remember channel because that's where the company actually decides things.

## What they leave for us to invent

- Retrieve mechanics, schema, ranking
- Keeping Refine cheap on Workers without burning CPU budget
- HITL queue UI / approval flow
- Conflict-resolution heuristics

## Honest caveat

A **product launch dressed as research**: evals on public benchmarks with simulated trace data; no schemas/prompts open-sourced. Architectural inspiration, not a reproducible spec.

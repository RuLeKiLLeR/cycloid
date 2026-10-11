# North Star: Intent Layer (Intent Systems)

Source: https://intent-systems.com/blog/intent-layer

## The thesis in one line

> "The ceiling on AI results isn't model intelligence — it's _what the model sees before it acts_."

A pre-authored, hierarchical, auto-loaded context system beats blind agentic search. Unit = **Intent Node**: one markdown file per semantic chunk of the system, organized in a tree.

## The mental model

- **Dark room problem**: every agent starts from zero, without the senior engineer's implicit model — boundaries, invariants, anti-patterns, why-it-is-this-way. The Intent Layer fills the room with light before the agent acts.
- Not RAG over chunks, not a graph DB, not session memory, not fine-tuning — it is **disciplined, hierarchical AGENTS.md** with token budgets, auto-load semantics, and a maintenance loop.

## Architecture

- **Unit**: Intent Node — one markdown file (`AGENTS.md` / `CLAUDE.md`) per semantic chunk.
- **Node content**: purpose & scope; entry points & contracts; usage patterns; anti-patterns; dependencies & edges; patterns & pitfalls.
- **Hierarchy**: root node auto-loads; **ancestor nodes auto-load** when a descendant is touched; non-overlapping coverage; children inherit parents.
- **Fractal compression**: capturing a parent summarizes child Intent Nodes, not the raw code they cover.
- **Token target**: ~16k tokens of Intent Layer context + ~16k tokens of relevant code.

## Lifecycle

- **Construction**: semantic chunking (not filesystem-mirrored), leaf-first capture with SME interviews, hierarchical roll-up.
- **Maintenance**: merge-triggered. Detect changed files → identify affected nodes → re-summarize if behavior changed → propose update → human review.
- **Reinforcement**: agents using the layer surface what's missing; future agents start from a better baseline.

## What it deliberately doesn't formalize

- No type system distinguishing decisions / commitments / facts / goals / open questions.
- No decay or supersession model — overwrite-on-drift, not time-based.
- No multi-tenant scope.
- No retrieval algorithm beyond "ancestor auto-load by directory."
- No published schema / SDK / benchmark.

## Translation to Cycloid living in Slack

Maps directly:

- **Hierarchical, scope-aligned nodes**. Cycloid's natural chunks aren't directories — they're **company-scoped surfaces**: business → customer → channel cluster → repo → service → person → thread. Auto-load ancestors = new thread in `#cust-acme` pulls `company → customer:acme → channel` nodes.
- **Fractal summarization**. Roll thread-level facts up to channel-level, channel up to customer-level. Per-scope markdown blobs in R2, structured rows in D1.
- **Event-triggered sync** (replaces `git merge`). Thread resolution, status change, PR merge, decision message ("we're going with X"), incident close — each fires a re-summarize.
- **Anti-pattern capture**. "Don't ping Lewis after 6pm." "Acme requires SOC2 evidence before demos." Exactly the "what must never happen" entries.

Does NOT map — we must invent:

- **Decision / commitment / goal / fact typing.** Slack is full of promises, goals, revocations; their model has no slot. Need explicit types with `owner`, `due`, `status`, `supersedes`.
- **Decay and supersession.** Need at minimum `valid_until`, `superseded_by`, recency-weighted retrieval.
- **Multi-tenant isolation** at the D1 query layer.
- **Adversarial / contested intent.** Slack has disagreement; their docs assume consensus.

## Net for Cycloid

Use as a **north-star frame** (pre-authored, hierarchical, scoped, auto-loaded, event-synced), not a _design_ — the type system, decay model, multi-tenant scope graph, Slack-event-driven producers, and retrieval mechanics are ours to invent.

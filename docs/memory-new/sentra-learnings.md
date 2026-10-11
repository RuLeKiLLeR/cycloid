# Sentra Learnings

Notes from auditing [Sentra](https://www.sentra.app/) ("Your Organization's Memory System") for Cycloid memory-system ideas.

## TL;DR

Pitch: **"Semantic Memory Filesystem"** — 6-class ontology, recursive ingestion with provenance + multiplicative confidence decay, 4-channel hybrid retrieval (BM25 + embeddings + graph + temporal). Mostly **marketing prose**: no concrete schemas on `/research`, `/manifesto`, or the blog (blog links offload to paywalled X posts).

Durable signal: the **live OpenAPI spec at `https://api.sentra.app/external/v1/openapi.json`** — read-only, 7-endpoint, OAuth-pull API on three runtime primitives (Entity, FactChunk, ExtractedLink) — plus one citable research result ("dimensional collapse to effective rank ~10–18" in production embedding models).

---

## 1. The 6-class ontology

Marketing classes: **Actors, Interactions, Decisions, Rationale, Commitments, Value-Creating Objects** — "Actors and Interactions are primary, everything else is derived." The API collapses these into **three runtime primitives**:

- `Entity` — typed node; types are org-configured slugs from `/entities/types`. The six classes appear as entity _types_, not first-class resources.
- `FactChunk` — atomic memory unit: `{ chunk_id, source_event_id, fact_text, event_time, source }`. Decisions/Rationale/Commitments surface as fact chunks on an entity.
- `ExtractedLink` + `CoAttendance` — typed edges between entities.

No per-class CRUD; no published schemas, fields, or examples.

**Borrow for Cycloid:**

- **Actor/Interaction primacy**: primary nodes = `Session` (Interaction) and `User`/`Repo` (Actors); derived = `Decision` (e.g. "use Drizzle, not raw D1"), `Commitment` (TODOs the agent promised). Clean D1 fit.
- **Collapse to Entity / FactChunk / Edge primitives** instead of per-class tables; cheap to evolve.

## 2. Ingestion pipeline

Marketing: "recursive six-stage LLM pipeline with provenance tracking and multiplicative confidence decay." Stages undescribed; "recursive" unexplained. Best-guess reconstruction (inference, not disclosure): raw artifact → Actors → Interactions linked to Actors → Decisions + Rationale → Commitments + VCOs → edges/symlinks.

Worth taking seriously: **multiplicative confidence decay** — `confidence = prod(parent_confidences * stage_extraction_confidence)`, multiplied per hop (e.g. Commitment ← Decision ← transcript).

**Borrow for Cycloid:**

- **Per-memory `confidence` column** = product of extraction-stage confidence and source confidence.
- **Decay confidence over time** since last confirmation and on conflicting later sessions. Use as pruning signal in `markdown.ts` — emit only above a threshold so `AGENTS.md` doesn't bloat.
- **Per-memory `extraction_stage` tag** to debug which stage produced bad memories.

## 3. Provenance as first-class

Every FactChunk carries `source_event_id` + `source` (meeting/file/slack/github/linear) + `event_time`; retrievals always return citations.

**Borrow for Cycloid:**

- **`memory_provenance(memory_id, artifact_type, artifact_id, event_time, source)`** join table; every memory row points to the session event, tool call, PR comment, or user prompt that produced it.
- Enables UI "this memory came from session X, PR Y" and duplicate detection by **shared provenance** rather than text similarity. Cheap given session-events-in-D1.

## 4. "Semantic Memory Filesystem" — borrow the _idea_, skip the framing

Claim: POSIX filesystem substrate; directories = ontology classes; files = atomic units; **bidirectional symlinks = edges** ("zero-cost graph edges"). No example tree published; POSIX symlinks are one-way (presumably pair tables); the filesystem framing is a constraint branded as a feature.

**Borrow for Cycloid:**

- **`memory_edge(src_id, dst_id, type, direction)` table** with both directions inserted — graph traversal in pure SQL ("sessions that touched the same file/PR/issue").
- **Skip filesystem-as-substrate.** D1 + markdown-in-repo already gives a structural (SPP-violating) channel without emulating POSIX on Workers.

## 5. 4-channel hybrid retrieval — the durable lesson

Marketing: BM25 + embeddings + graph traversal + temporal filtering, "each compensating for the others' blind spots." Fusion algorithm **not published** — no RRF, weights, or reranker.

Citable results from the paper ("The Price of Meaning"):

- **Production embedding models (1024–3584 nominal dims) collapse to effective rank ~10–18** (variance concentration).
- "No-Escape Theorem": false recall cannot be eliminated by threshold tuning under growing memory; retention decays power-law.
- Pure vector retrieval false-alarm rate ≈ 0.58; BM25/filesystem FA = 0 but Semantic Proximity correlation drops to r = 0.21.

Framing: vectors aren't broken — they have an asymptotic ceiling that worsens with corpus growth and benefits from non-semantic complements.

**Borrow for Cycloid:**

- **Hybrid retrieval inside the Worker**: D1 FTS5 (BM25-equivalent) + Workers AI embeddings, 2-channel hybrid **fused with Reciprocal Rank Fusion** (Sentra won't disclose theirs). Beats "write to AGENTS.md and let Codex grep" for large repos hitting token budgets.
- **Structural filters as a third channel**: same repo / author / files touched / integration touched. Cheap, deterministic, no model.
- **Recency decay as a ranker multiplier**, not a hard filter — `S(t) = (1+βt)^−ψ` (paper: β=0.20, ψ=0.5). Avoids the time-window cliff.
- **Reserve embeddings for fuzzy past-session lookup**, not primary code context — repo markdown (paths, hierarchy) outperforms embeddings on structural queries.

## 6. The API surface — concrete and borrowable

Live at `https://api.sentra.app/external/v1/openapi.json` (OpenAPI 3.1.0, 37 KB). Base `https://api.sentra.app`, prefix `/external/v1`, Bearer auth (`sk_sentra_…`), 120 reads/min/key.

**All 7 endpoints are GET / read-only — no writes exposed:**

| Endpoint                                              | Purpose                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /`                                               | Self-describing discovery doc (base_url, auth scheme, key format, endpoint catalog, openapi URL, rate limits) |
| `GET /external/v1/meetings`                           | List (filters: start_date, end_date, page, limit, search, status, attendee)                                   |
| `GET /external/v1/meetings/{meeting_id}`              | Full transcript + summary                                                                                     |
| `GET /external/v1/sources`                            | Connector inventory + per-source `connected` flag                                                             |
| `GET /external/v1/entities`                           | List (entity_type, updated_since, limit, cursor, search)                                                      |
| `GET /external/v1/entities/types`                     | Entity type slug + display-name registry                                                                      |
| `GET /external/v1/entities/{entity_id}/chunks`        | ACL-filtered fact chunks with citations                                                                       |
| `GET /external/v1/entities/{entity_id}/relationships` | Extracted links + co-attendance (default 180-day window)                                                      |

Writes happen only via ingestion from OAuth-connected sources (`meeting`, `file`, `slack_channel_day`, `github_item`, `linear_issue`).

**LLM-tuned OpenAPI descriptions**: cost guidance ("Expensive — returns large payloads") and steering ("Prefer `get_entity_chunks` over `get_meeting` for cross-meeting questions", "Call at most once per turn unless the user explicitly asks…").

**Borrow for Cycloid:**

- **Self-describing `GET /` root** on the control plane: base_url, auth scheme, key format, endpoint catalog, openapi URL, rate limits. Cheap; great for agent bootstrap from a fresh sandbox.
- **LLM-tuned endpoint descriptions in our OpenAPI** with cost hints and steering for session / PR / run / memory endpoints.
- **FactChunk-shaped retrieval primitive**: return `{ text, source_event_id, event_time, source }` tuples instead of full transcripts or session blobs.
- **Per-user ACL on org-connected sources**: a source can be `connected=true` at org level yet return zero rows for a user without repo/channel membership — codifies "integration installed" vs "this user can see this row"; useful for our GitHub flow.

## 7. Per-user ACL through native source membership

A connector is `connected=true` once org OAuth completes, but **per-row visibility cascades through native ACLs** — Slack channel, Linear team, GitHub repo membership. The agent treats "connected but seeing nothing" as a permission question, not missing data.

**Borrow for Cycloid:** surface "connected at org level but you don't have repo access" as a first-class API response shape, not a 404 — fits our GitHub installation model.

---

## What we explicitly do NOT learn

- **Schemas for the 6 classes** — no fields or examples on any public page.
- **The six ingestion stages** — count only.
- **Fusion algorithm** for the 4 channels — no RRF/weights/reranker.
- **Filesystem directory layout / naming convention** — no example tree.
- **"50× smaller model + architecture matches frontier" / "+0.112 F1 from retrieval"** — no dataset, baseline, or eval harness; unverifiable marketing.
- **MCP server** — "coming soon"; not present.
- **SDKs** — none documented.
- **200+ business tools** claim — the spec enumerates 5 source kinds (meeting / file / slack_channel_day / github_item / linear_issue).

## Honest caveats

- Marketing pages and the paper are **rhetorically joined but technically separate**: the paper proves embedding-geometry theorems, not the product. Don't treat product claims as proven or paper claims as product capability.
- "Bidirectional symlink" / filesystem-as-substrate is defensible engineering but also a slide-deck signature — don't emulate on Workers + D1.
- Manifesto framings ("negation over scale", "positive rewards degrade performance") are unsupported in the public paper. Ignore.
- The **one durable empirical result** is the dimensional-collapse number — motivation for hybrid retrieval; don't import the rest as gospel.

---

## Recommended Cycloid next steps (priority order)

1. **Provenance-as-first-class column** on every memory row (`source_event_id`, `source_type`, `event_time`) — enables citation UI and duplicate detection by shared provenance.
2. **Confidence column + multiplicative decay on staleness/conflict** + threshold-gate before emitting to `AGENTS.md`.
3. **Hybrid retrieval inside the worker** (D1 FTS5 + Workers AI embeddings + structural filters), fused with RRF.
4. **Recency decay as a ranker multiplier**, not a time-window filter.
5. **`memory_edge` table with both directions inserted** — graph queries in plain SQL.
6. **Reshape to Entity / FactChunk / Edge primitives** with Actor/Interaction primary; collapse the rest into entity types.
7. **Self-describing `GET /` root** + LLM-tuned OpenAPI descriptions on session/PR/run/memory endpoints.
8. **Per-source ACL surfacing** in our integrations API — "connected at org" vs "this user can see this row."

## Key source pages

- `https://www.sentra.app/research`
- `https://www.sentra.app/manifesto`
- `https://www.sentra.app/use-cases`
- `https://www.sentra.app/integrations`
- `https://www.sentra.app/data-privacy`
- `https://api.sentra.app/` — discovery JSON
- `https://api.sentra.app/external/v1/openapi.json` — full OpenAPI 3.1.0 spec (37 KB)
- Underlying research: "The Price of Meaning" (arXiv 2603.27116)

# Cycloid Memory

This tree uses the Memory 2.0 Markdown schema. Memory files must have YAML frontmatter plus bounded Markdown body text, and parser expectations are enforced by `shared/memory/parser.ts`.

`README.md` and `index.md` files are navigation only and are ignored by memory loaders. Active repo memories may live in descendant Markdown under `.cycloid/memory/` (file-backed) or in D1 (`repo_memories` table) when `MEMORY_REPO_SINK=d1` is configured. The control-plane Session DO attaches D1-backed memories to sandbox prompts; the bridge merges them with file-backed memories for ranking.

Retrieval is intentionally LLM-ranked only for now. Prompt-start injection and `cycloid.memory_recall` require `ARCANIST_MEMORY_TOOLS_ENABLED=1`; the control plane currently sets that only for production sessions in Cycloid's own business. Customer businesses do not receive model-facing memory injection or recall. See `docs/memory-new/current-state-handoff.md` for the authoritative runtime state.

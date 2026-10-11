# Engineering Memory

Engineering memory records use Memory 2.0 frontmatter and are loaded from descendant Markdown files. This index is ignored.

Required frontmatter includes `id`, `vertical: engineering`, `memory_type`, `level`, `primitive`, `status`, `confidence`, `authority`, `context_hint`, `created_at`, and `updated_at`. Action memories also include `action_type`.

Keep active records only when they are durable, non-obvious, actionable in a
future session, and not already captured better by repo docs, code guardrails,
or focused tests. Stale or low-value records should be deleted so retrieval does
not rank them ahead of better context.

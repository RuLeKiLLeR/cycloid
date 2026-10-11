---
id: mem_1f68148d
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: gotcha
engineering_domains:
  - data_persistence
  - runtime_behavior
  - testing
subjects:
  - Durable Object SQLite
  - event append
  - generated IDs
  - deduplication
symbols:
  - INSERT OR IGNORE
  - event-N
tags:
  - n-plus-one
  - id-collision
  - sqlite
  - replay
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/session/do-db.ts
  - tests/test_cloudflare/session/do-db.test.ts
context_hint: Relevant to any DO-local append path that mixes caller-supplied event IDs with auto-generated sequence-based IDs.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4092
source_session_ids:
  - 2c45e176-c531-4ed8-b079-ae999e4f4a20
evidence: []
enforcement: warn
triggers:
  tools:
    - sql.exec
  path_globs:
    - apps/control-plane-worker/src/session/do-db.ts
  command_patterns: []
  forbidden_patterns: []
  mcp_tools: []
supersedes: []
contradicts: []
created_at: 2026-06-05
updated_at: 2026-06-05
---

When appending events with `INSERT OR IGNORE`, do not let an explicit ID collision consume the same generated `event-${sequence}` slot for the rest of the batch; if an explicit ID can look like `event-N`, skip only that row or break/advance before retrying, and add a regression that mixes explicit `event-N` IDs with later generated entries.

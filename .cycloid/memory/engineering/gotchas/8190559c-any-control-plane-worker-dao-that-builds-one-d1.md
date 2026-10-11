---
id: mem_8190559c
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: gotcha
engineering_domains:
  - data_persistence
  - dependencies
  - testing
subjects:
  - D1
  - batch queries
  - IN clause
  - session lookups
symbols:
  - getEvaluationsBySessions
tags:
  - d1
  - bind-limit
  - batching
  - sql
  - n-plus-one
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/integrations/test-credentials-db.ts
  - apps/control-plane-worker/src/memory/service.ts
  - apps/control-plane-worker/src/eval/db.ts
context_hint: Any control-plane-worker DAO that builds one D1 query with shared equality predicates plus a variable-length IN list.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/3642
source_session_ids:
  - 19adbd1d-5493-488a-b6f3-f09d424f9670
evidence: []
enforcement: warn
triggers:
  tools:
    - D1Database
  path_globs:
    - apps/control-plane-worker/src/**/*.ts
    - tests/test_cloudflare/**/*.test.ts
  command_patterns:
    - "*.prepare(... IN (...))"
    - "*.bind(...ids)"
  forbidden_patterns:
    - single IN query with >100 binds
  mcp_tools: []
supersedes: []
contradicts: []
created_at: 2026-05-29
updated_at: 2026-06-05
---

When batching D1 lookups with an IN clause, chunk by total bind count, not just list length; subtract any fixed leading binds in the query so the final statement stays at 100 parameters or fewer.

---
id: mem_55655873
vertical: engineering
memory_type: action
action_type: procedure
level: tactical
primitive: procedure
engineering_domains:
  - data_model
  - runtime_behavior
subjects:
  - pagination
  - SQL cursor
  - joined rows
  - GitHub PR refs
symbols:
  - cursor
  - ORDER BY
  - external_ref
tags:
  - pagination
  - sql
  - cursor
  - join
  - gotcha
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/webhooks/db.ts
  - tests/test_cloudflare/review-loop-reconciler-listing.test.ts
context_hint: Relevant for list queries over joined tables where one parent entity can have multiple child refs and paging is done with an encoded cursor.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4363
source_session_ids:
  - 4216990a-4cd6-4d2f-b395-f70579beb3d2
  - 9d3a591f-e70a-4c99-b419-8ab94b31a00b
evidence: []
enforcement: warn
triggers:
  tools: []
  path_globs:
    - apps/control-plane-worker/src/webhooks/db.ts
    - tests/test_cloudflare/review-loop-reconciler-listing.test.ts
  command_patterns: []
  forbidden_patterns: []
  mcp_tools: []
supersedes: []
contradicts: []
created_at: 2026-06-11
updated_at: 2026-06-11
---

When paginating a joined result set, make the cursor include every ORDER BY tie-breaker, including child-table keys like `external_ref`; otherwise rows that share the same parent timestamp/session can be skipped or duplicated across pages.

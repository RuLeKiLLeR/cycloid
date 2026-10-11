---
id: mem_2670f42b
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: gotcha
engineering_domains:
  - runtime_behavior
  - data_persistence
subjects:
  - SessionDO
  - rich_status projection
  - D1
symbols:
  - persistAndRecordSessionStatusFrame
  - persistRichStatusToD1
tags:
  - race-condition
  - serialization
  - stale-write
  - sessiondo
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/session/durable-object.ts
  - tests/test_cloudflare/session/lifecycle-projection-blocking.test.ts
context_hint: Use this whenever lifecycle/state transitions re-derive rich_status and persist it asynchronously or after any await.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/3540
source_session_ids:
  - 366ac39b-1a0b-421b-9536-389f39a54b50
evidence: []
enforcement: warn
triggers:
  tools:
    - git diff
    - code review
  path_globs:
    - apps/control-plane-worker/src/session/durable-object.ts
  command_patterns: []
  forbidden_patterns: []
  mcp_tools: []
supersedes: []
contradicts: []
created_at: 2026-05-27
updated_at: 2026-05-27
---

When a SessionDO path can start multiple rich_status projection writes for the same session, serialize them per session or guard the UPDATE with a compare-and-swap; a stale-frame recheck before the UPDATE is not enough because an older D1 write can still land after a newer one and overwrite it.

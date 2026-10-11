---
id: mem_93c50ec0
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: procedure
engineering_domains:
  - data_persistence
  - runtime_behavior
  - testing
subjects:
  - scheduled-rule cap
  - concurrent inserts
  - D1
symbols:
  - insert ... SELECT ... WHERE COUNT(*) < cap
  - rule_cap_reached
  - duplicate_rule
tags:
  - atomicity
  - concurrency
  - db-catch-separation
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/automation/db.ts
  - apps/control-plane-worker/src/automation/service.ts
context_hint: Any create flow where a read-then-write cap can be raced by another request.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/3612
source_session_ids:
  - befb4838-5166-4ff2-99a1-a185dfdc9ad1
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-05-28
updated_at: 2026-05-28
---

When enforcing a per-tenant/per-business cap under concurrent writes, make the INSERT itself conditional (`... SELECT ... WHERE COUNT(*) < cap`) and treat `changes === 0` as the cap-reached path; don’t rely on a pre-insert count check alone.

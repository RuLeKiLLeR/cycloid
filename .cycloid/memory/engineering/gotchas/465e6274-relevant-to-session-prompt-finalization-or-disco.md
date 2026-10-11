---
id: mem_465e6274
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
  - session prompt completion
  - D1 projection
  - rich-status projection
symbols:
  - setHasPendingQuestion
  - bulkUpdatePrompts
  - processing
tags:
  - prompt-queue
  - projection-failure
  - durable-object
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/session/prompt-queue.ts
  - tests/test_cloudflare/session/prompt-queue-helper.test.ts
context_hint: Relevant to session prompt finalization or disconnect-failure flows that update prompt rows and then call a separate host projection method.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4360
source_session_ids:
  - 07ef07f3-ebb3-4206-ba36-a781cc42e1a2
  - 56ee5078-e2a2-4d2d-9677-74241e48b151
evidence: []
enforcement: suggest
supersedes: []
contradicts: []
created_at: 2026-06-11
updated_at: 2026-06-11
---

When a prompt completion path both persists terminal prompt state and then runs a projection/cleanup step, write the terminal/bulk prompt update first and only then invoke the projection. If the projection fails, the DB must already show the prompt as completed/failed and any promoted follow-up prompt as running; otherwise an alarm retry can see the old "processing" state and leave the prompt stuck.

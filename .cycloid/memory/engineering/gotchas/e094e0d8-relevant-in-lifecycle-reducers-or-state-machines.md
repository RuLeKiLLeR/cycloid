---
id: mem_e094e0d8
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: gotcha
engineering_domains:
  - runtime_behavior
  - testing
subjects:
  - Session lifecycle reducer
  - prompt phase transitions
  - dispatch timeout
symbols:
  - prompt.agent_prompt_sent
  - prompt.running_activity
  - dispatch_deadline_elapsed
tags:
  - race-condition
  - state-regression
  - watchdog
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/session/lifecycle/reducer.ts
  - tests/test_cloudflare/session/lifecycle/reducer.test.ts
context_hint: Relevant in lifecycle reducers or state machines where a dispatch phase can be followed by a late send/ack event after execution has already started.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4352
source_session_ids:
  - 0ac7b2ab-7678-4514-ba47-4c9b9be62ed8
  - 1b7fa694-6feb-4f41-a0cc-62ddc68eb451
evidence: []
enforcement: suggest
supersedes: []
contradicts: []
created_at: 2026-06-11
updated_at: 2026-06-11
---

When handling a late prompt-sent event, do not let it move a prompt back from `running` to `dispatching`; if execution was already observed, noop instead so the dispatch watchdog cannot be re-armed and fire a false timeout.

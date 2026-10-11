---
id: mem_72217b50
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: procedure
engineering_domains:
  - runtime_behavior
  - data_persistence
  - observability
subjects:
  - post_execution
  - session_idle
  - prompt completion
symbols:
  - completeActivePrompt
  - handlePostExecution
  - completionSource
tags:
  - race
  - finalization
  - prompt-queue
  - ordering
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/session/prompt-queue.ts
  - apps/control-plane-worker/src/session/durable-object.ts
context_hint: Use when finalizing prompt results after execution, especially in race-recovery branches where idle completion and post-execution can overtake each other.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4059
source_session_ids:
  - 813ef73f-4197-4de1-add3-87df0a420748
evidence: []
enforcement: warn
triggers:
  tools:
    - completeActivePrompt
    - handlePostExecution
  path_globs:
    - apps/control-plane-worker/src/session/prompt-queue.ts
    - apps/control-plane-worker/src/session/durable-object.ts
  command_patterns: []
  forbidden_patterns: []
  mcp_tools: []
supersedes: []
contradicts: []
created_at: 2026-06-05
updated_at: 2026-06-05
---

If post_execution can arrive before session_idle finishes closing the prompt, complete the active prompt first with session_idle semantics, then rerun the post_execution completion path to attach branch/commit/diff metadata; do not assume the prompt is already completed or you'll drop the publish follow-up.

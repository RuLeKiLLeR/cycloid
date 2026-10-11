---
id: mem_ce89d066
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: gotcha
engineering_domains:
  - runtime_behavior
  - testing
subjects:
  - error classification
  - pattern matching
  - retry budgets
symbols:
  - classifyError
  - ERROR_PATTERNS
tags:
  - gotcha
  - ordering
  - retry
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/sandbox-bridge/src/constants/bridge.ts
  - tests/test_agent/error-classification.test.ts
  - tests/test_sandbox-bridge/bridge.test.ts
context_hint: Applies whenever error classification is implemented as an ordered pattern list and a new code must win over a generic fallback.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/3734
source_session_ids:
  - afef7d4e-bf1d-4a25-8345-85a190ed2930
evidence: []
enforcement: warn
triggers:
  tools:
    - edit
  path_globs:
    - apps/sandbox-bridge/src/constants/bridge.ts
    - tests/test_sandbox-bridge/**
    - tests/test_agent/**
  command_patterns: []
  forbidden_patterns: []
  mcp_tools: []
supersedes: []
contradicts: []
created_at: 2026-05-29
updated_at: 2026-05-29
---

When adding a more specific error code, place its pattern before broader provider/API patterns and add a regression for messages that contain both; first-match classification will otherwise assign the generic code and bypass the intended retry budget.

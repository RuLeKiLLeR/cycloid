---
id: mem_e9bde4cc
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: procedure
engineering_domains:
  - runtime_behavior
  - developer_workflow
  - observability
subjects:
  - SessionPublishService
  - publishSessionResult
  - PR-created events
symbols:
  - inFlightPromptPublishes
  - publish.pr.created
  - publish.completed
tags:
  - concurrency
  - dedupe
  - publish
  - race
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/session/publish-service.ts
  - tests/test_cloudflare/session/pr-workflow.test.ts
context_hint: Use this for any prompt-scoped publish flow that writes PR events or terminal publish telemetry and may be re-entered before the first run finishes.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4059
source_session_ids:
  - 813ef73f-4197-4de1-add3-87df0a420748
evidence: []
enforcement: warn
triggers:
  tools:
    - publishSessionResult
  path_globs:
    - apps/control-plane-worker/src/session/publish-service.ts
  command_patterns: []
  forbidden_patterns: []
  mcp_tools: []
supersedes: []
contradicts: []
created_at: 2026-06-05
updated_at: 2026-06-05
---

When publishSessionResult can be called concurrently for the same session+prompt, dedupe the whole publish run per DurableObjectStorage key and return the in-flight promise; otherwise duplicate callers can double-emit PR-created/completion side effects even if the GitHub create call itself is idempotent.

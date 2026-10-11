---
id: mem_424e979c
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: procedure
engineering_domains:
  - external_interface
  - runtime_behavior
  - observability
  - developer_workflow
subjects:
  - postStructuredEventToDd
  - Cloudflare Workers
  - waitUntil
symbols:
  - waitUntil
  - postStructuredEventToDd
tags:
  - telemetry
  - fire-and-forget
  - workers
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/session/sandbox-state-owners/prompt-activity.ts
  - apps/control-plane-worker/src/session/sandbox-state-owners/runtime-identity.ts
context_hint: Any worker code that sends best-effort Datadog or other outbound telemetry from a request/DO path.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4042
source_session_ids:
  - e6f1411c-b51d-495f-9398-645698031704
evidence: []
enforcement: warn
triggers:
  tools: []
  path_globs:
    - apps/control-plane-worker/src/**/*.ts
  command_patterns: []
  forbidden_patterns: []
  mcp_tools: []
supersedes: []
contradicts: []
created_at: 2026-06-05
updated_at: 2026-06-05
---

When posting telemetry from a Cloudflare Worker, always register the promise with `waitUntil`; if a call site may omit it, warn explicitly or avoid the fallback, because the fetch can be dropped when the request finishes.

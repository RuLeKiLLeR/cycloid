---
id: mem_79f79f5a
vertical: engineering
memory_type: action
action_type: procedure
level: tactical
primitive: procedure
engineering_domains:
  - observability
  - security
  - runtime_behavior
subjects:
  - logger redaction
  - error sanitization
symbols:
  - entryRedactor
  - redactError
  - Error.cause
tags:
  - redaction
  - logger
  - sentry
  - error-cause
status: active
confidence: medium
authority: reviewed
owner: cycloid
applies_to:
  - shared/observability/logger.ts
  - apps/sandbox-bridge/src/logger.ts
context_hint: Any shared logger or log pipeline with multiple emission targets and an optional redaction hook.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/3968
source_session_ids:
  - 24cbdf09-36e3-45cc-8719-f99d5602166b
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-06-03
updated_at: 2026-06-03
---

When adding logger redaction, apply it before every downstream consumer of the entry: console output, sink/archive payloads, and error-handler context. Redacting only the console path still leaks raw fields into sinks or Sentry metadata.

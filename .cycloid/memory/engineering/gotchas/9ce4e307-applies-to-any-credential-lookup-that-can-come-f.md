---
id: mem_9ce4e307
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: gotcha
engineering_domains:
  - security
  - runtime_behavior
  - external_interface
subjects:
  - encrypted integration credentials
  - TOKEN_ENCRYPTION_KEY
  - spawn runtime
symbols:
  - TOKEN_ENCRYPTION_KEY
tags:
  - credentials
  - encryption
  - fail-closed
  - integrations
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/integrations/runtime.ts
  - tests/test_cloudflare/integration-runtime.test.ts
context_hint: Applies to any credential lookup that can come from either a batched snapshot or direct DB read, especially integration/spawn runtime env injection.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4354
source_session_ids:
  - a38c1e80-056e-481f-8a96-47dfbf9dee0e
  - b4b9b37a-5b03-432c-844a-905d16f2b1c9
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-06-11
updated_at: 2026-06-11
---

When resolving encrypted integration credentials, fail closed if the stored row is marked encrypted and TOKEN_ENCRYPTION_KEY is missing: return null and warn, rather than letting ciphertext fall through as a usable token or trying a fallback path.

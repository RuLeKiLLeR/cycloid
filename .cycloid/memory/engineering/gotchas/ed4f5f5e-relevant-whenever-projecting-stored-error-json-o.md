---
id: mem_ed4f5f5e
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: gotcha
engineering_domains:
  - observability
  - security
  - external_interface
subjects:
  - session debug summary
  - error redaction
  - provider response previews
symbols:
  - debug-summary
  - responseBodyPreview
tags:
  - redaction
  - allowlist
  - debug
  - security
status: active
confidence: medium
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/services/session-debug.ts
  - tests/test_cloudflare/session-debug-service.test.ts
  - tests/test_cloudflare/session-debug-summary-build.test.ts
context_hint: Relevant whenever projecting stored error JSON or other potentially user/provider-generated text into a user-facing debug endpoint or summary payload.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/3736
source_session_ids:
  - b3b147a8-8cbe-4fee-b516-ce40d10d3aaf
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-05-29
updated_at: 2026-05-29
---

When expanding any debug-summary/error-details allowlist, omit raw provider response previews entirely and redact embedded file paths anywhere in the string; do not rely on heuristics that only match paths after whitespace or on partial redaction of preview text.

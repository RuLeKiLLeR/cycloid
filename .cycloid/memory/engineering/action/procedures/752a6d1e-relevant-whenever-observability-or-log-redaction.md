---
id: mem_752a6d1e
vertical: engineering
memory_type: action
action_type: procedure
level: tactical
primitive: procedure
engineering_domains:
  - testing
  - runtime_behavior
subjects:
  - secret redaction
  - provider tokens
  - regression tests
symbols:
  - SECRET_PATTERNS
  - redact
tags:
  - redaction
  - regression
  - tokenization
status: active
confidence: medium
authority: reviewed
owner: cycloid
applies_to:
  - shared/observability/redact.ts
  - tests/test_shared/redact.test.ts
context_hint: Relevant whenever observability or log redaction patterns are broadened or rewritten, especially provider-token matchers.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4261
source_session_ids:
  - 2374b16c-c0dd-443b-9e71-981673fc69df
  - b03ffd5d-d7e3-4b34-b0aa-8bb6da240d82
  - d283bb52-2072-4f7f-9899-fa213570793c
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-06-10
updated_at: 2026-06-10
---

When expanding secret-redaction regexes, add regression vectors for every rewritten branch and include at least one glued-token case (secret adjacent to letters/digits) so word-boundary assumptions can’t hide leaks.

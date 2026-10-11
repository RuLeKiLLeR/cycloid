---
id: mem_d51f8566
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: procedure
engineering_domains:
  - security
  - runtime_behavior
  - testing
subjects:
  - quoted shell payload redaction
  - replacement ordering
  - command reconstruction
symbols:
  - -c
  - "|"
  - "|&"
tags:
  - redaction
  - shell-quoting
  - ordering
  - recursive
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/sandbox-bridge/src/services/pr-readiness.ts
  - tests/test_sandbox-bridge/pr-readiness.test.ts
context_hint: Relevant whenever CLI evidence may contain nested shell commands, pipelines, or other embedded command strings that need recursive sanitization.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4416
source_session_ids:
  - 0a292562-fd12-4365-9f9c-f45e34b311c8
  - 83e9d71f-6d0f-43eb-bb1e-1913ee648dc7
  - d65e1f72-2814-4673-996b-9dff8f5117a5
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-06-11
updated_at: 2026-06-11
---

When a command sanitizer descends into quoted shell `-c` payloads, redact the nested payload recursively and apply all replacements sorted by start offset before rebuilding the string; otherwise earlier outer replacements can be emitted out of order and leak or garble secrets.

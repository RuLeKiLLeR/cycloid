---
id: mem_f2c6fca9
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
  - command evidence redaction
  - inline short options
  - shell payloads
symbols:
  - -p
  - -pw
  - -profile
  - bash -lc
tags:
  - redaction
  - cli
  - false-positive
  - shell-quoting
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/sandbox-bridge/src/services/pr-readiness.ts
  - tests/test_sandbox-bridge/pr-readiness.test.ts
context_hint: Relevant to any command sanitizer that rewrites CLI evidence or logs, especially glued short options that can collide with ordinary flags.
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

When redacting inline short password options in command evidence, scope the match to known password-taking executables and preserve longer single-dash flags like `-profile`; do not treat every token starting with `-p`/`-pw` as a secret.

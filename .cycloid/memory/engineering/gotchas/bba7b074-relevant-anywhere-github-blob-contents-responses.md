---
id: mem_bba7b074
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: procedure
engineering_domains:
  - external_interface
  - runtime_behavior
  - dependencies
subjects:
  - GitHub base64 decoding
  - UTF-8
symbols:
  - decodeBase64Content
  - TextDecoder
tags:
  - github
  - base64
  - utf8
  - encoding
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/github/skills.ts
context_hint: Relevant anywhere GitHub blob/contents responses are base64-decoded before Markdown or JSON parsing.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4093
source_session_ids:
  - 8ad10669-589e-4dda-85a7-baba5be121d2
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-06-05
updated_at: 2026-06-05
---

When decoding GitHub base64 blobs that will be parsed as text, convert the binary string into bytes and decode with TextDecoder; do not use atob() output directly as text, or non-ASCII skill content can be corrupted.

---
id: mem-084f6600
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: gotcha
engineering_domains:
  - external_interface
subjects:
  - Slack API
symbols:
  - files.getUploadURLExternal
  - slackApi
tags:
  - slack
  - uploads
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/slack/notify.ts
context_hint: When calling Slack API methods, especially file upload related ones like files.getUploadURLExternal
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/1389
source_session_ids:
  - cc12facf-13a4-4a7c-a4c3-518b8b80bff5
evidence: []
enforcement: warn
triggers:
  tools:
    - apply_patch
  path_globs:
    - apps/control-plane-worker/src/slack/notify.ts
  command_patterns: []
  forbidden_patterns: []
  mcp_tools: []
supersedes: []
contradicts: []
created_at: 2026-05-13
updated_at: 2026-05-13
---

# Slack Upload URL Requires Form Encoding

Slack `files.getUploadURLExternal` requires `application/x-www-form-urlencoded`, not JSON. The `slackApi` helper supports an `encoding` option; use `"form"` for this method and do not assume all Slack Web API endpoints accept JSON.

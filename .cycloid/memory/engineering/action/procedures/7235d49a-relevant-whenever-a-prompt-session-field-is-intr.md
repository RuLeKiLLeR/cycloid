---
id: mem_7235d49a
vertical: engineering
memory_type: action
action_type: procedure
level: tactical
primitive: procedure
engineering_domains:
  - data_persistence
  - testing
  - code_structure
subjects:
  - prompt state
  - persistence
  - schema migrations
symbols:
  - reviewLoopSourceKind
  - serializePromptRow
  - seedPrompt
tags:
  - persistence
  - serialization
  - test-fixture
  - prompt-metadata
status: active
confidence: medium
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/session/do-db.ts
  - apps/control-plane-worker/src/session/schema.ts
  - tests/test_cloudflare/session/helpers.ts
context_hint: Relevant whenever a prompt/session field is introduced or becomes necessary after a reconnect/reload, especially for review-loop or publish metadata.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4356
source_session_ids:
  - 61873825-c4cd-41b0-ae95-1d96cac997c5
  - 9e5f02e7-1563-4f76-8e1b-49db9cf5ef30
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-06-11
updated_at: 2026-06-11
---

When adding new prompt metadata that must survive later review/bridge actions, wire it through every persistence path: DB schema, row serializer/deserializer, and test/legacy seed helpers. If you only update the live write path, older storage writes and reloaded prompts can drop the field and break follow-up review behavior.

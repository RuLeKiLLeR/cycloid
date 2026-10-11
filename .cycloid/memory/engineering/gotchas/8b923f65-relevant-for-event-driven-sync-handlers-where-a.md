---
id: mem_8b923f65
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: procedure
engineering_domains:
  - data_persistence
  - external_interface
  - runtime_behavior
subjects:
  - GitHub installation webhooks
  - permission refresh
  - suspended installations
symbols:
  - new_permissions_accepted
  - upsertInstallation
  - updateInstallationPermissions
tags:
  - webhooks
  - upsert-vs-update
  - suspension-state
  - event-ordering
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/webhooks/github.ts
  - apps/control-plane-worker/src/github/installations-db.ts
  - tests/test_cloudflare/installations-db.test.ts
context_hint: Relevant for event-driven sync handlers where a later metadata-refresh delivery can arrive after suspend/delete lifecycle events.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4353
source_session_ids:
  - 0f502368-ad99-428f-a105-ff2d669c0324
  - 56b25a1f-f94b-469c-bd9d-097b0fd2f2e5
  - 7f4eae3f-2077-49eb-982f-101153885c31
  - 81d490cd-76b9-4d08-85f4-296e65f4e7c8
evidence: []
enforcement: warn
triggers:
  tools:
    - github webhook handlers
    - D1/SQL persistence helpers
  path_globs:
    - apps/**/webhooks/*.ts
    - apps/**/installations-db.ts
  command_patterns: []
  forbidden_patterns:
    - route a permission-refresh event through an upsert that resets suspension state
    - INSERT ... ON CONFLICT for permission-only webhook refreshes
  mcp_tools: []
supersedes: []
contradicts: []
created_at: 2026-06-11
updated_at: 2026-06-11
---

When a webhook only refreshes installation permissions/events, route it through an update-only DB helper that leaves lifecycle fields like `suspended_at` untouched, and do not use an upsert path that can resurrect deleted rows or clear suspension state.

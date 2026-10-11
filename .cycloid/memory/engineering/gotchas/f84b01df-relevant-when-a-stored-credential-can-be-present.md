---
id: mem_f84b01df
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: gotcha
engineering_domains:
  - architecture
  - runtime_behavior
  - external_interface
subjects:
  - OpenAI API keys
  - managed key fallback
  - bootstrap availability
symbols:
  - last_validation_status
  - invalid
  - managed_virtual_key_resolved
tags:
  - credential-validation
  - fallback
  - bootstrap
  - runtime-injection
status: active
confidence: medium
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/integrations/runtime.ts
  - apps/control-plane-worker/src/services/bootstrap.ts
  - apps/control-plane-worker/src/integrations/db.ts
context_hint: Relevant when a stored credential can be present but must be ignored because validation marked it invalid, especially for runtime env injection plus bootstrap/provider-availability projection.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/4364
source_session_ids:
  - 49d781c2-1ecb-4388-b54a-9ef469b75557
  - 9a4ad16a-6b86-48a6-8334-b10c088e1861
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-06-11
updated_at: 2026-06-11
---

When you treat a saved provider key with `last_validation_status = 'invalid'` as missing at runtime, update every availability check that drives model/provider visibility too. Otherwise bootstrap can still advertise the provider as available from row presence alone, and users will see models that immediately lack an injected key.

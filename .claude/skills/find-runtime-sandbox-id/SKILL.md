---
name: find-runtime-sandbox-id
description: Find the provider-facing `runtime_sandbox_id` / E2B sandbox id for a single Cycloid session from the control-plane source of truth. Use when someone asks for the E2B sandbox id, `runtime_sandbox_id`, or `runtimeSandboxId` for a session URL or UUID and you need the persisted provider id rather than the bridge's internal `sandboxId`.
user_invocable: true
argument: required -- a single Cycloid session URL or session UUID
---

# Find Runtime Sandbox ID

Resolve the current persisted provider-facing runtime sandbox id for one session. Keep the work read-only and scoped to the requested session.

## Input

`$ARGUMENTS` is one of:

- `https://app.trycycloid.com/sessions/<uuid>`
- raw Cycloid session UUID

If the request includes several session IDs, use the one the user explicitly asked about. If that is ambiguous, ask for clarification instead of guessing.

## Source Of Truth

Query Cycloid's control-plane D1 directly. Do not use `cloudflare.query_d1` for this skill; that tool targets the connected customer D1, not Cycloid's control-plane database.

For normal customer sessions, use production:

```bash
wrangler d1 execute cycloid-control-plane-production --remote \
  --command "SELECT session_id, runtime_provider, runtime_sandbox_id FROM session_index WHERE session_id = '<session_id>' LIMIT 1"
```

Only switch to QA when the user explicitly says the session is on QA:

```bash
wrangler d1 execute cycloid-control-plane-qa --remote --env qa \
  --command "SELECT session_id, runtime_provider, runtime_sandbox_id FROM session_index WHERE session_id = '<session_id>' LIMIT 1"
```

Rules:

- Treat `runtime_sandbox_id` as the answer only when `runtime_provider = e2b`.
- If the row is missing, say the session was not found in `session_index`.
- If the provider is not `e2b`, report the current provider and do not invent an E2B id.
- If `runtime_sandbox_id` is `NULL`, report that there is no current persisted E2B runtime id for that session.

## Contract Check

Before answering, confirm the field mapping in code:

- `apps/control-plane-worker/src/sandbox/e2b-client.ts` returns `runtimeSandboxId: sandbox.sandboxId`.
- `apps/control-plane-worker/src/session/durable-object.ts` records `result.runtimeSandboxId` into runtime state during spawn attach.
- `apps/control-plane-worker/src/session/db.ts` persists `runtimeState.runtimeSandboxId` to `session_index.runtime_sandbox_id`.

Ignore the separate internal `sandboxId` path used for bridge auth and correlation. That value is not the provider-facing E2B runtime id.

## Output

Keep the answer short and direct. Default shape:

`runtime_sandbox_id` for session `<session_id>` is `<runtime_sandbox_id>`.

Add one brief provenance sentence only when useful, for example when you need to make clear that the value came from `session_index` in control-plane D1 and not the internal `sandboxId` path. Do not broaden into incident analysis unless the user asked for it.

# Managed OpenAI Virtual Key Runtime Wiring

**Date:** 2026-06-07
**Status:** Draft design, pending implementation plan
**Author:** Shivam Pandey (with Codex)

## Problem

Cycloid can create managed OpenAI virtual keys and show them in the settings usage page, but sandbox startup still treats user BYOK as the only non-local OpenAI credential source. Users with only an active managed virtual key can select OpenAI models, but spawn fails with "No API key configured for OpenAI" before Codex starts.

The usage-page failure is the same wiring gap from the other side: `/settings/usage` reads `openai_virtual_keys` and `openai_gateway_ledger`. Ledger rows are only written by the gateway handler when Codex requests traverse `/openai/responses` with an `arc-vk-*` bearer token. No sandbox receives that derived virtual-key secret or Codex base URL override, so virtual-key-only sessions never reach the gateway and usage stays empty.

## Current State

- `apps/control-plane-worker/src/openai-gateway/db.ts`
  - `ensureDefaultOpenAIVirtualKeyForUser` creates `vk_user_<userId>`.
  - With `secretSeed`, the secret is deterministic: `arc-vk-${sha256("openai-gateway:" + secretSeed + ":" + userId)}`.
  - Only `key_hash` is stored; the secret is never persisted.
  - `hasActiveOpenAIVirtualKeyForOwner` only returns a boolean.
- `apps/control-plane-worker/src/openai-gateway/service.ts`
  - `POST /openai/responses` and websocket `GET /openai/responses` authenticate with the virtual key bearer token.
  - The gateway writes `openai_gateway_ledger` reservation and settlement rows.
  - Ledger rows already accept optional `x-cycloid-session-id` and `x-cycloid-prompt-id` headers.
- `apps/control-plane-worker/src/integrations/runtime.ts`
  - `resolveSpawnIntegrationRuntime` resolves BYOK/business OpenAI credentials from integration tables.
  - Local dev can fall back to `.dev.vars` OpenAI keys.
  - It does not check managed virtual keys or derive the deterministic secret.
- `apps/control-plane-worker/src/session/durable-object.ts`
  - The spawn payload merges `integrationRuntime.envVars` into `e2bEnvs`.
  - `CONTROL_PLANE_URL` is already injected; defaults to `https://app.trycycloid.com`.
  - `CODEX_API_KEY` is copied from `OPENAI_API_KEY`.
- `apps/sandbox-bridge/src/services/codex-server.ts`
  - `buildCodexRuntimeConfig` always writes `model_provider = "openai"`; it does not write `openai_base_url`.
  - The pinned Codex CLI (`shared/constants/codex-runtime.ts`) is `0.129.0`; that binary accepts `openai_base_url`. Do not write `[model_providers.openai]`: `openai` is a reserved built-in provider id.
- `apps/ui/src/components/settings/UsageSettings.tsx`
  - Shows current-month gateway ledger usage and virtual-key rows; not based on session token usage.

## Goal

Make managed OpenAI virtual keys a complete runtime credential path: run Codex sessions without BYOK, route OpenAI traffic through Cycloid's gateway, and populate spend/token usage in settings.

Desired steady state:

1. BYOK/business OpenAI credentials still win when configured; BYOK now routes through the gateway with `arc-gw-*` session tokens (see BYOK gateway spend tracking spec).
2. Users without BYOK but with an active managed virtual key receive a derived `arc-vk-*` secret at spawn.
3. The bridge writes `openai_base_url = "<CONTROL_PLANE_URL>/openai"` only for managed virtual-key sessions.
4. Codex calls `<CONTROL_PLANE_URL>/openai/responses`; the gateway authenticates, proxies, budgets, and writes ledger usage.
5. Existing settings usage UI shows non-zero gateway ledger data after settled calls.

Non-goals:

- Replacing BYOK for users who already configured it.
- Adding a new model provider or changing Codex's model catalog.
- Reworking gateway pricing/budget semantics.
- Exposing virtual-key secrets in UI or API responses.
- Per-session usage UI beyond the existing owner-level settings page.

## Design

### 1. Add a managed virtual-key credential resolver

Add a helper in `apps/control-plane-worker/src/openai-gateway/db.ts`:

```ts
export async function resolveDefaultOpenAIVirtualKeyForOwner(
  db: D1Database,
  params: { ownerUserId: number; secretSeed: string },
): Promise<{ id: string; secret: string } | null>;
```

Behavior:

- Look up an active `vk_user_<ownerUserId>` row for the owner; return `null` if none.
- Derive and return the deterministic secret with `deriveDefaultOpenAIVirtualKeySecret(ownerUserId, secretSeed)`.
- Verify the derived secret hash matches the stored `key_hash` before returning. On mismatch, throw a typed error or return a distinct mismatch result so spawn diagnostics fail closed and operators can reseed.

Why verify the hash: historical/admin-created rows can use random secret material; deriving a secret for those produces a key the gateway rejects. Detect at spawn instead of sending a broken key into the sandbox.

### 2. Resolve managed keys at spawn after BYOK misses

In `resolveSpawnIntegrationRuntime`:

- Keep current ordering:
  1. business-scoped OpenAI key
  2. user BYOK OpenAI key
  3. managed virtual key
  4. local-dev fallback key
- Only attempt managed virtual-key resolution when: `db` exists, `availableSet.has("openai")`, no BYOK/business key resolved, and `ownerUserId` is a finite number.
- Require `env.TOKEN_ENCRYPTION_KEY`. Missing seed while a managed key exists must fail closed with a clear diagnostic; do not fall through to a platform key in non-local environments.
- Inject:
  - `OPENAI_API_KEY = arc-vk-*`
  - `ARCANIST_OPENAI_GATEWAY_ENABLED = "1"`
- Set diagnostics: `virtual_key_resolved`, `virtual_key_missing`, `virtual_key_secret_seed_missing`, `virtual_key_secret_mismatch`, `virtual_key_lookup_failed`.

Add `virtual_key_resolved` to lifecycle success events as OpenAI `credential_resolved` and `sandbox_token_prepared` with `credentialScope: "managed_virtual_key"`.

### 3. Route Codex through the gateway only for managed-key sessions

In `apps/sandbox-bridge/src/services/codex-server.ts`:

- Extend `CodexRuntimeConfig` with optional `openai_base_url?: string`.
- In `buildCodexRuntimeConfig`, detect managed-key sessions with both:
  - `env.ARCANIST_OPENAI_GATEWAY_ENABLED === "1"`
  - `env.OPENAI_API_KEY` or `env.CODEX_API_KEY` starts with `arc-vk-`
- Resolve gateway base URL from `CONTROL_PLANE_URL`: trim trailing slashes, require `http:` or `https:`, append `/openai`, write `openai_base_url = "<origin>/openai"`.
- If the marker says gateway is enabled but the key is not `arc-vk-*`, warn and do not write `openai_base_url`.
- Never write `openai_base_url` for BYOK `sk-*` credentials.

Generated `config.toml`:

```toml
model_provider = "openai"
openai_base_url = "https://app.trycycloid.com/openai"
web_search = "disabled"
```

Codex appends `/responses`, so the base URL must be `/openai`, not `/openai/responses`.

### 4. Add request attribution headers if Codex supports provider headers

The gateway already reads `x-cycloid-session-id` and `x-cycloid-prompt-id`. Before implementing attribution, confirm whether pinned Codex supports built-in OpenAI provider request headers. If so, write safe static/env-indirected headers for:

- `x-cycloid-session-id = SESSION_ID`
- `x-cycloid-prompt-id = current prompt id`

If pinned Codex cannot set provider headers per turn, defer prompt/session attribution. Owner-level usage still works because `owner_user_id` is attached to the authenticated virtual key in the gateway ledger. Do not block the virtual-key migration on per-prompt attribution.

### 5. Add a deliberate reseed/repair path

Rows created without `secretSeed` have random, unrecoverable secrets. Add an admin-only helper:

```ts
export async function reseedDefaultOpenAIVirtualKeyForUser(
  db: D1Database,
  params: {
    userId: number;
    businessId: string | null;
    secretSeed: string;
    now?: number;
  },
): Promise<{ id: string; created: boolean; rotated: boolean }>;
```

Behavior:

- Target only `vk_user_<userId>`.
- If no row exists, create via the deterministic path.
- If a row exists and its hash already matches the derived secret, no-op.
- If a row exists and mismatches, update `key_hash`, `business_id`, `status = 'active'`, and `updated_at`.
- Preserve `monthly_limit_usd_micros` unless creating a new row.

Wire the Slack seed action and admin approval seed path to this helper, not plain `ensureDefaultOpenAIVirtualKeyForUser`, so operators can repair old random rows without manual SQL.

### 6. Usage page behavior

No UI change required for the core migration; the usage page is correctly tied to the gateway ledger. After runtime traffic goes through the gateway, the existing endpoint should report: virtual key rows from `openai_virtual_keys`, current-month reserved/settled/released counts from `openai_gateway_ledger`, and settled token counts and spend after response usage is observed.

Optional copy-only follow-up (not required): if a user has active virtual keys but zero ledger rows, show an empty-state sentence that usage appears after the first managed OpenAI session settles.

## Error Handling

- BYOK/business credential lookup errors keep today's `lookup_failed` behavior.
- Active managed key + missing `TOKEN_ENCRYPTION_KEY` fails closed (server configuration problem, not a user settings problem).
- Active managed key + derived-hash mismatch fails closed with a diagnostic pointing operators to reseed/repair.
- Gateway authentication failure (`401`) remains terminal; bridge error classification already surfaces OpenAI auth failures from Codex stderr.
- Invalid `CONTROL_PLANE_URL` in a managed-key session: do not route to OpenAI directly; fail closed before Codex startup or produce a clear bridge startup error.

## Security

- The sandbox receives a scoped virtual key, not the platform `ARCANIST_OPENAI_API_KEY`.
- The virtual key is deterministic but not stored; only its hash is.
- `TOKEN_ENCRYPTION_KEY` is already server-side; treat it as the secret seed for deterministic default virtual keys.
- Do not expose virtual-key secrets in settings, Slack responses, logs, or PR output.
- Keep `ARCANIST_OPENAI_API_KEY` stripped from `e2bEnvs` as today.
- BYOK users now route through the gateway with `arc-gw-*` session tokens; the managed virtual-key path applies only when no BYOK credential is configured.

## Data / Migrations

No schema migration required.

Operational data repair is required for any `vk_user_<id>` rows whose `key_hash` came from random secret material: use the new reseed helper through an admin action or one-off script after deploy. Do not update rows with ad hoc SQL unless the script uses the same deterministic derivation helper.

## Testing

Control-plane unit tests:

- `resolveSpawnIntegrationRuntime` injects derived `OPENAI_API_KEY` and `ARCANIST_OPENAI_GATEWAY_ENABLED` when an active deterministic virtual key exists and BYOK is absent.
- BYOK/business OpenAI credentials take precedence over managed virtual keys.
- Missing `TOKEN_ENCRYPTION_KEY` with an active managed key fails closed.
- Hash mismatch for `vk_user_<id>` fails closed and does not inject a bad key.
- Local dev fallback still works when no BYOK or managed key exists.
- Lifecycle events include managed virtual-key success status.

OpenAI gateway DB tests:

- `resolveDefaultOpenAIVirtualKeyForOwner` returns the derived secret only for a matching active default row.
- Inactive rows are ignored; random/mismatched rows are detected.
- `reseedDefaultOpenAIVirtualKeyForUser` creates, no-ops, and rotates the default row correctly.

Bridge tests:

- `buildCodexRuntimeConfig` writes `openai_base_url` for `ARCANIST_OPENAI_GATEWAY_ENABLED=1` plus `arc-vk-*`.
- It does not write `openai_base_url` for `sk-*` BYOK.
- It warns/fails closed for invalid `CONTROL_PLANE_URL` in managed-key sessions.
- TOML serialization emits `openai_base_url` at top level.

Gateway / settings tests:

- Existing `openai-gateway-service` tests continue proving ledger writes.
- Existing settings route tests continue proving the usage page reads owner-scoped keys and ledger summary.
- Add or update one integration-style test simulating a managed virtual-key session env, bridge config output, and gateway request path enough to prove the same derived key authenticates.

## Live Verification Plan

Per `docs/testing.md`, end-to-end proof means a real Cycloid session, not only unit/worker-route tests. This change also affects visible settings UI, so verification must include browser-use inspection of the usage page with real gateway ledger data.

### Automated preflight

Run the focused suites before any live session:

```bash
npx vitest run tests/test_cloudflare/integration-runtime.test.ts
npx vitest run tests/test_cloudflare/openai-gateway-usage.test.ts
npx vitest run tests/test_cloudflare/openai-gateway-service.test.ts
npx vitest run tests/test_cloudflare/settings-routes.test.ts
npx vitest run tests/test_sandbox-bridge/codex-stdio.test.ts -t "openai_base_url"
```

Expected: all pass; no test performs live OpenAI/GitHub/Slack network I/O.

### Local real-session proof

Local dev first: it exercises spawn path, bridge config, local D1, gateway route, and settings UI without QA deploys. Start the full stack only for this live session:

```bash
npm run dev:full
```

Prepare a local test owner:

1. Remove or disable the local user's BYOK OpenAI row.
2. Ensure `vk_user_<userId>` exists with a derived hash from `TOKEN_ENCRYPTION_KEY` using the new reseed helper.
3. Confirm `CONTROL_PLANE_URL` points at the dev tunnel and is reachable from E2B.

Start a real Cycloid session against a low-risk fixture repo with a prompt forcing at least one Codex model call and minimal edits, for example:

```text
Create a tiny documentation-only change in the fixture repo, run the smallest
relevant check, and stop before publishing if anything looks unsafe.
```

Expected session evidence:

- Session reaches Codex; no "No API key configured for OpenAI" failure.
- Sandbox env diagnostics show `OPENAI_API_KEY`/`CODEX_API_KEY` present and `ARCANIST_OPENAI_GATEWAY_ENABLED=1`, without exposing secret values.
- Bridge-generated `$CODEX_HOME/config.toml` contains `openai_base_url = "<CONTROL_PLANE_URL>/openai"`.
- Gateway logs show `/openai/responses` traffic for the session.
- Local D1 has at least one `openai_gateway_ledger` row for the owner, with `lifecycle_status` eventually `settled` or `settlement_unresolved`.

Verify local UI with browser-use:

```bash
browser-use doctor
browser-use open http://localhost:<ui-port>/settings/usage
browser-use state
browser-use wait text "OpenAI spend"
browser-use screenshot /tmp/cycloid-openai-usage-local.png --full
browser-use eval "document.body.innerText"
```

Expected UI evidence:

- Usage page loads without console-visible failure text.
- Virtual key section includes `vk_user_<userId>`.
- `Settled requests` or the unresolved request notice reflects the live session.
- Token/spend fields are non-zero when the gateway settled with usage.
- Screenshot path and session URL recorded in the implementation PR.

### QA deployed proof

Run QA only after local proof passes — the final migration depends on deployed Cloudflare routing, stable HTTPS callbacks, and deployed E2B sandbox semantics. Use a QA user/business with BYOK removed and a deterministic managed virtual key.

Steps:

1. Deploy the branch to QA.
2. Reseed the QA test user through the admin/Slack seed path so the row is definitely deterministic.
3. Start a real QA Cycloid session from the QA UI or CLI against the fixture repo.
4. Wait for the session to complete at least one prompt.
5. Query QA D1 or logs for the owner's `openai_gateway_ledger` row.

Verify QA UI with browser-use using an authenticated browser profile:

```bash
browser-use profile list
browser-use --profile "Default" open https://qa.app.trycycloid.com/settings/usage
browser-use state
browser-use wait text "OpenAI spend"
browser-use screenshot /tmp/cycloid-openai-usage-qa.png --full
browser-use eval "document.body.innerText"
```

Expected QA evidence:

- QA session URL shows a completed or safely stopped real session.
- Gateway logs include QA `/openai/responses` traffic for the managed key.
- QA settings usage shows the managed key and the new request count/usage.
- No BYOK row required for model selection or session spawn.

### Prod canary before switching all users

After QA passes, run one internal prod canary user with BYOK removed and a deterministic managed key, on a non-customer-visible task in an internal repo.

Evidence required before broader migration:

- Prod session URL and prompt.
- Gateway ledger row for the canary owner.
- Browser-use screenshot of `https://app.trycycloid.com/settings/usage` showing the canary usage.
- No increase in OpenAI auth failures or gateway `401`/settlement-unresolved errors in Datadog for the canary window.

Only after the prod canary passes should operators reseed and switch additional users.

## Rollout

1. Ship code; behavior gates naturally on active managed virtual keys and no BYOK.
2. Reseed/repair existing default virtual-key rows that do not match the deterministic secret.
3. Smoke one internal user with BYOK removed.
4. Switch additional users by ensuring each has an active deterministic default key. No frontend setting change required.
5. After usage ledger data is confirmed, update operator docs to make managed virtual keys the default OpenAI credential path for new users.

Rollback:

- Re-disable managed-key spawn resolution by removing or bypassing the virtual-key branch in `resolveSpawnIntegrationRuntime`.
- Existing BYOK users unaffected (they never use `openai_base_url`).
- Already-written gateway ledger rows can remain; usage summaries are additive and owner-scoped.

## Open Questions

1. Fail spawn on derived-key hash mismatch, or auto-reseed when the actor is an admin/system path?
   Recommendation: fail spawn and provide an admin reseed action. Runtime spawn should not mutate credential material as a side effect.

2. Per-prompt ledger attribution in the first migration?
   Recommendation: no. Owner-level usage is enough to switch users. Add per-prompt headers only if pinned Codex supports provider headers cleanly.

3. Should business-managed OpenAI scope ever prefer managed virtual keys over a business BYOK credential?
   Recommendation: no for this change. Preserve current explicit business credential precedence.

4. Should the usage page expose virtual-key status mismatch?
   Recommendation: no. Mismatch requires secret knowledge and belongs in admin diagnostics, not user settings.

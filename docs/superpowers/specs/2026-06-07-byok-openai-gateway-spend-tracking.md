# BYOK OpenAI Gateway Spend Tracking

**Date:** 2026-06-07
**Status:** Implemented and verified locally
**Author:** Codex

## Problem

Cycloid now routes managed OpenAI virtual-key sessions through `/openai/responses` and shows settled usage in Settings. BYOK users still bypass the gateway: the sandbox receives the decrypted OpenAI key and Codex talks directly to OpenAI.

Two incomplete spend stories:

- Managed-key spend is exact (`openai_gateway_ledger` records raw OpenAI usage observed by the gateway).
- BYOK spend is only indirectly available from `prompt_runs` when Codex reports prompt usage — useful for observability, but a different ledger with different token semantics and no reserved/unresolved gateway states.

To make Settings trustworthy for all OpenAI traffic, route BYOK OpenAI sessions through the same gateway and record spend in the same ledger.

## Goals

1. Route both managed virtual-key and BYOK OpenAI sessions through `/openai/responses`.
2. Keep user BYOK secrets server-side; never send the raw `sk-*` key to the sandbox when gateway routing is available.
3. Preserve credential precedence:
   1. business OpenAI key
   2. user OpenAI key
   3. managed virtual key
   4. local-dev fallback
4. Record exact OpenAI usage for BYOK in `openai_gateway_ledger`.
5. Show Settings usage split by credential source: Cycloid managed key / Your OpenAI key / Workspace OpenAI key.
6. Avoid double counting `prompt_runs` and gateway ledger data.

## Non-Goals

- Charging users for BYOK usage.
- Replacing `prompt_runs`; it remains the per-prompt observability record.
- Showing exact OpenAI invoice data from the user's OpenAI account.
- Supporting non-OpenAI providers in this gateway.
- Exposing raw OpenAI or virtual-key secrets in UI or public APIs.

## Current State

### Managed Virtual Keys

- Runtime injects `OPENAI_API_KEY = arc-vk-*` and `ARCANIST_OPENAI_GATEWAY_ENABLED = "1"`.
- Sandbox bridge writes:

```toml
model_provider = "openai"
openai_base_url = "<CONTROL_PLANE_URL>/openai"
```

- Gateway authenticates the `arc-vk-*` bearer key, uses `ARCANIST_OPENAI_API_KEY` upstream, and records `openai_gateway_ledger`.

### BYOK

- Runtime decrypts user/business OpenAI keys; sandbox receives `OPENAI_API_KEY = sk-*`.
- Bridge does not write `openai_base_url`; Codex calls OpenAI directly.
- `prompt_runs` records prompt-level usage reported by the bridge, but Settings usage does not read `prompt_runs`.

## Proposed Design

### 1. Add Gateway Credential Source Metadata

Add credential-source columns to `openai_gateway_ledger`:

```sql
ALTER TABLE openai_gateway_ledger
  ADD COLUMN credential_source TEXT NOT NULL DEFAULT 'managed_virtual_key';

ALTER TABLE openai_gateway_ledger
  ADD COLUMN upstream_credential_ref TEXT;
```

Allowed `credential_source` values: `managed_virtual_key`, `user_byok`, `business_byok`.

`upstream_credential_ref` is a non-secret identifier for debugging and grouping:

- managed virtual key: `vk_user_<id>` or the existing `virtual_key_id`
- user BYOK: `user:<userId>:openai`
- business BYOK: `business:<businessId>:openai`

Do not store key material, key hashes, or decryptable ciphertext in the ledger.

### 2. Create Gateway Session Tokens for BYOK

BYOK cannot use the raw OpenAI key as the sandbox bearer token. Instead, create a Cycloid gateway token identifying which server-side credential to use.

New table:

```sql
CREATE TABLE IF NOT EXISTS openai_gateway_session_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  business_id TEXT,
  credential_source TEXT NOT NULL,
  credential_provider TEXT NOT NULL DEFAULT 'openai',
  credential_owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_openai_gateway_session_tokens_owner_expires
  ON openai_gateway_session_tokens(owner_user_id, expires_at);
```

Token format:

```text
arc-gw-<random 32+ byte secret>
```

Behavior:

- Only store `sha256(token)`.
- Token is short lived, scoped to one session or spawn attempt, and expires no later than the sandbox runtime retention window.
- Token must be scoped to `session_id`. Runtime verification should assert every BYOK gateway ledger row has `session_id` populated from the token row, not from a sandbox-supplied header.
- `business_id` is nullable (personal BYOK sessions can run outside a workspace credential); business BYOK tokens must still set it.
- Token references the existing encrypted integration row indirectly:
  - `credential_source = 'user_byok'`, `credential_owner_id = '<userId>'`
  - `credential_source = 'business_byok'`, `credential_owner_id = '<businessId>'`
- Gateway re-resolves and decrypts the OpenAI key server-side for each request, using the same DAO rules as spawn.
- Expired tokens are handled by lazy lookup: gateway auth treats expired rows as invalid and may delete them opportunistically. A cron cleanup can be added later for storage hygiene; request correctness must not depend on cron.

Why not put the decrypted key in a token table: D1 would become another secret store. The control plane already owns encrypted integration credentials; reuse that boundary.

### 3. Runtime Credential Resolution

In `resolveSpawnIntegrationRuntime`:

- When business/user BYOK resolves, do not inject `sk-*` directly by default. Instead:
  1. Create an `openai_gateway_session_tokens` row.
  2. Inject `OPENAI_API_KEY = arc-gw-*`.
  3. Inject `ARCANIST_OPENAI_GATEWAY_ENABLED = "1"`.
  4. Inject `ARCANIST_OPENAI_GATEWAY_CREDENTIAL_SOURCE =
"user_byok" | "business_byok"`.

Managed virtual-key sessions continue to inject `arc-vk-*`.

Local dev fallback can keep injecting a raw key; do not let local fallback change production semantics.

Fail closed if: a gateway token cannot be created; `CONTROL_PLANE_URL` is unavailable for a gateway-routed OpenAI session; or the referenced BYOK credential cannot be decrypted at request time.

### 4. Sandbox Bridge Gateway Detection

Update `resolveManagedOpenAIBaseUrl` in `apps/sandbox-bridge/src/services/codex-server.ts` to support both token types:

```ts
const isGatewayToken = apiKey.startsWith("arc-vk-") || apiKey.startsWith("arc-gw-");
```

Rename the helper to something source-neutral, for example:

```ts
resolveOpenAIGatewayBaseUrl(...)
```

Behavior:

- If `ARCANIST_OPENAI_GATEWAY_ENABLED !== "1"`, do not write `openai_base_url`.
- If the marker is set and the key is not `arc-vk-*` or `arc-gw-*`, throw.
- If the marker is set and `CONTROL_PLANE_URL` is invalid or missing, throw.
- Write `openai_base_url = "<CONTROL_PLANE_URL>/openai"`.

Keep the existing behavior preserving `OPENAI_API_KEY` and `CODEX_API_KEY` when gateway routing is enabled, even if Codex auth files exist.

### 5. Gateway Authentication and Upstream Key Resolution

Split gateway authentication into two paths:

```ts
type GatewayAuthContext =
  | {
      kind: "managed_virtual_key";
      virtualKey: OpenAIVirtualKeyRow;
      upstreamApiKey: string; // env.ARCANIST_OPENAI_API_KEY
      ownerUserId: string;
      businessId: string;
    }
  | {
      kind: "user_byok" | "business_byok";
      sessionToken: OpenAIGatewaySessionTokenRow;
      upstreamApiKey: string; // decrypted BYOK
      ownerUserId: string;
      businessId: string;
    };
```

Authentication rules:

- `arc-vk-*`: existing `getVirtualKeyBySecret`.
- `arc-gw-*`: lookup `openai_gateway_session_tokens` by hash and require `expires_at > now`.
- Expired or missing token returns 401.
- For BYOK, resolve the upstream key from existing encrypted integration tables: user token → user integration row; business token → business integration row.
- If the credential is missing or decrypt fails, return a gateway auth/upstream failure and mark any reservation as released or unresolved as appropriate.

The gateway must not trust sandbox-supplied headers for owner/business identity; identity comes from the authenticated gateway token.

For BYOK tokens, the gateway should also use `session_id` from the token row for ledger attribution — exact session-level spend even if Codex cannot attach custom provider headers.

### 6. Ledger Writes

Extend `insertGatewayLedgerRow` parameters:

```ts
credentialSource: "managed_virtual_key" | "user_byok" | "business_byok";
upstreamCredentialRef: string | null;
```

For `arc-vk-*`:

- `virtual_key_id = vk_user_<id>`
- `credential_source = managed_virtual_key`
- `upstream_credential_ref = virtual_key_id`

For BYOK:

- `virtual_key_id = NULL` is preferable, but current schema may require it. If a nullable migration is too invasive, use a synthetic stable id: `byok_user_<userId>` / `byok_business_<businessId>`.
- `credential_source = user_byok | business_byok`
- `upstream_credential_ref = user:<id>:openai | business:<id>:openai`

Preferred migration: make `virtual_key_id` nullable and update indexes/queries to group by `credential_source` instead of treating every ledger row as a virtual-key row.

### 7. Settings API

Replace the current "virtual-key-only" usage payload with source-aware usage:

```ts
{
  currentMonth: {
    totalSpentUsdMicros,
    totalReservedUsdMicros,
    sources: [
      {
        source: "managed_virtual_key",
        label: "Cycloid managed key",
        spentUsdMicros,
        reservedUsdMicros,
        settledRequestCount,
        reservedRequestCount,
        settlementUnresolvedRequestCount,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens
      },
      {
        source: "user_byok",
        label: "Your OpenAI key",
        ...
      },
      {
        source: "business_byok",
        label: "Workspace OpenAI key",
        ...
      }
    ]
  },
  virtualKeys: [...]
}
```

Compatibility option: keep the existing top-level fields as totals so current UI code keeps working; add `sources` for the new breakdown.

Do not merge in `prompt_runs` costs — once BYOK routes through the gateway, `prompt_runs` would double count.

For Cycloid's own spend tracking, favor maximal historical accuracy over current configuration state:

- Include BYOK ledger rows even if the user later deletes their OpenAI key.
- Label deleted-key historical usage by source, e.g. "Your OpenAI key (historical)" if the API can cheaply detect key absence.
- Never hide settled ledger usage just because the credential no longer exists.
- Keep source totals based on ledger facts, not live integration rows.

### 8. Settings UI

Update `UsageSettings` to show:

- Total current-month OpenAI spend and reserved spend.
- A compact source breakdown: Cycloid managed key / Your OpenAI key / Workspace OpenAI key.
- Token totals per source.
- Virtual key list only under the managed-key source, or as a separate "Managed keys" section.

Empty states:

- No OpenAI traffic: "Usage appears after an OpenAI session completes."
- BYOK configured but no usage: show the BYOK source with zeroes if the API can cheaply determine key presence; otherwise omit zero rows.

## Rollout Plan

1. Add schema migration and DAO helpers.
2. Add BYOK gateway session-token creation in runtime resolution.
3. Teach bridge gateway base URL detection to accept `arc-gw-*`.
4. Teach gateway auth to resolve `arc-gw-*` tokens and decrypt upstream BYOK.
5. Extend ledger writes with `credential_source`.
6. Extend settings usage aggregation and UI source breakdown.
7. Run virtual-key-only and BYOK-only live user simulations.
8. After verification, gateway routing is the default for BYOK OpenAI sessions.

Raw BYOK fallback is local-dev only.

## Testing Plan

### Unit Tests

Control plane:

- `openai_gateway_session_tokens` DAO: creates token hash only; rejects expired token; returns source/owner/business metadata; deletes or ignores expired rows.
- Runtime resolution:
  - business BYOK produces `arc-gw-*`, gateway enabled marker, `business_byok` source.
  - user BYOK produces `arc-gw-*`, gateway enabled marker, `user_byok` source.
  - managed virtual key still produces `arc-vk-*`.
  - no BYOK plus managed key still works.
  - token creation failure fails closed.
- Gateway service:
  - `arc-vk-*` still uses platform upstream key.
  - `arc-gw-*` user token decrypts user BYOK and uses it upstream.
  - `arc-gw-*` business token decrypts business BYOK and uses it upstream.
  - expired/missing gateway token returns 401.
  - BYOK ledger rows include `credential_source`.
  - BYOK ledger rows copy `session_id` from the gateway token row.
  - WebSocket terminal usage settles before socket close for BYOK and managed key paths.
- Settings route:
  - aggregates current-month totals across all sources; returns source breakdown.
  - excludes other users/businesses; excludes previous-month rows.
  - includes BYOK historical rows even when the BYOK key was deleted after the request settled.
  - does not read `prompt_runs`.

Sandbox bridge:

- `ARCANIST_OPENAI_GATEWAY_ENABLED=1` with `arc-vk-*` writes `openai_base_url`.
- `ARCANIST_OPENAI_GATEWAY_ENABLED=1` with `arc-gw-*` writes `openai_base_url`.
- gateway marker with `sk-*` throws.
- raw BYOK without marker writes no `openai_base_url`.

UI:

- usage page renders total spend and source rows.
- managed virtual-key rows remain visible.
- zero/reserved/unresolved states render without overlap.

### Local Integration Tests

Run with `npm run dev:full`.

Managed-key-only baseline:

1. Delete user OpenAI BYOK row.
2. Ensure deterministic `vk_user_<id>`.
3. Clear `openai_gateway_ledger`.
4. Create a UI session on a writable Cycloid-owned test repo with `GPT-5.4`.
5. Confirm session completes.
6. Confirm `openai_gateway_ledger.credential_source =
'managed_virtual_key'`.
7. Confirm Settings shows settled usage under "Cycloid managed key".

User BYOK:

1. Save a user OpenAI key through Settings.
2. Managed key may also exist, but BYOK wins.
3. Clear `openai_gateway_ledger`.
4. Create a UI session on a writable Cycloid-owned test repo with `GPT-5.4`.
5. Confirm sandbox env uses `arc-gw-*`, not `sk-*`.
6. Confirm Codex config has `openai_base_url`.
7. Confirm session completes.
8. Confirm ledger source is `user_byok`.
9. Confirm Settings shows settled usage under "Your OpenAI key".

Business BYOK:

1. Configure business OpenAI key for the user's business.
2. Ensure user BYOK is absent or lower precedence.
3. Repeat the UI session flow.
4. Confirm ledger source is `business_byok`.
5. Confirm Settings shows settled usage under "Workspace OpenAI key".

### Browser-Use Product Verification

Use browser-use for the user-visible flows:

1. Open `http://localhost:<ui-port>`.
2. Authenticate with a local user session cookie.
3. Select org/repo/model from the visible composer controls.
4. Submit a no-modification prompt:

```text
Real user simulation: inspect this repository and reply with only the current
branch name. Do not modify files, do not commit, and do not open a pull request.
```

5. Wait for the session page to show completed output.
6. Screenshot the session page.
7. Open `/settings/usage`.
8. Confirm the source row, settled request count, spend, token totals, and reserved count.
9. Screenshot the usage page.

Required browser-use artifacts: managed-key session screenshot, user-BYOK session screenshot, business-BYOK session screenshot, final usage page screenshot showing source breakdown.

### Real Cycloid Session Evidence

For each source, record: session id, prompt ids, runtime sandbox id, session `rich_status`, prompt `outcome`, `openai_gateway_ledger.credential_source`, `actual_cost_usd_micros`, token totals, Settings API payload.

Not verified until at least one managed-key UI session and one BYOK UI session complete and settle gateway ledger rows.

## Risks

- **Token leakage:** `arc-gw-*` tokens are bearer tokens. Mitigate with hashes at rest, short TTLs, session scoping, no UI exposure.
- **Credential lookup drift:** Gateway request-time decryption must match spawn precedence. Mitigate with shared DAO helpers and runtime/gateway tests.
- **Double counting:** Do not add `prompt_runs` to Settings totals after gateway BYOK routing.
- **Long-lived WebSockets:** Settlement must happen on terminal response events, not only socket close.

## Resolved Decisions

1. BYOK gateway session tokens are scoped to `session_id`. Add runtime/session id to token creation and copy it into ledger rows server-side.
2. Expired token handling is lazy lookup: treat expired rows as invalid during gateway auth, opportunistically delete. Cron cleanup is not required for correctness.
3. Settings should be maximally accurate for Cycloid tracking: show historical BYOK ledger spend even if the key has since been deleted.

Codex header support:

The current Codex manual documents `openai_base_url` for pointing the built-in OpenAI provider at a proxy. It documents `http_headers` and `env_http_headers` for custom `model_providers.*`, not for the built-in `openai` provider. Project config also cannot override provider/auth metadata such as `openai_base_url`, `model_provider`, or `model_providers`; the sandbox bridge must write these in the sandbox user-level Codex config.

Decision:

- Do not depend on built-in OpenAI provider request headers for attribution.
- Session attribution must come from the `arc-gw-*` token row.
- Prompt attribution remains best-effort unless we either:
  - issue a gateway token per prompt and update the sandbox key before each Codex turn, or
  - switch from the built-in `openai` provider to a custom provider configured with `wire_api = "responses"` and `env_http_headers`.

Keep the built-in OpenAI provider plus `openai_base_url` — the documented way to proxy the built-in provider, matching the current managed virtual-key implementation. Require exact owner/session/source spend tracking in this change; leave exact per-prompt gateway attribution as a follow-up unless implementation discovers a safe existing hook in the sandbox bridge.

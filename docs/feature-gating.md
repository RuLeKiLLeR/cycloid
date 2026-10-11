# Feature Gating

Cycloid's internal feature gate is a binary, homegrown gate for "Cycloid-owned business only" features.
It is not a general feature-flag system and should not become one. Membership is manually assigned and
deliberate, so business membership is the source of truth.

## Single Source Of Truth

Use [`internal-feature-gate.ts`](../apps/control-plane-worker/src/services/internal-feature-gate.ts) for
internal feature access:

- `isCycloidMember(user)` is sync and pure. It returns true for users in the prod Cycloid business or
  the QA Cycloid business.
- `isCycloidAdmin(user)` is sync and pure. It returns true for Cycloid-owned business admins only.
- `verifyCycloidMember(db, auth)` is async. It resolves the request identity from D1 and evaluates
  the real operator (`actorUser`) during impersonation.
- `verifyCycloidAdmin(db, auth)` is async. It uses the same identity rules for admin-only gates.

The canonical helpers intentionally treat the QA business as equivalent to prod so internal developers
are not locked out on QA deploys. There is no staff allowlist.

## Which Function To Use

| Need                          | Function                        | Use when                                                                    |
| ----------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| Member, request authorization | `verifyCycloidMember(db, auth)` | Authenticated routes, services reached from routes, and request-time checks |
| Admin, request authorization  | `verifyCycloidAdmin(db, auth)`  | Admin routes and privileged request-time checks                             |
| Member, resolved row          | `isCycloidMember(user)`         | Already-authoritative user or business rows, not request authorization      |
| Admin, resolved row           | `isCycloidAdmin(user)`          | Already-authoritative user or business rows, not request authorization      |
| UI exposure                   | Bootstrap capability            | Showing or hiding affordances only; server authorization still owns access  |

Existing sync-helper call sites are the pattern for resolved rows:

- [`auth/auth-me.ts`](../apps/control-plane-worker/src/auth/auth-me.ts) populates `user.isCycloidAdmin`.
- [`auth/impersonation-db.ts`](../apps/control-plane-worker/src/auth/impersonation-db.ts) re-checks the
  impersonation actor against the same admin predicate.

Route and request paths should use the async `verify*` helpers so identity resolution, D1 state, and
impersonation semantics stay consistent.

## Gating A Route

Fail closed before running the internal behavior:

```ts
import { verifyCycloidMember } from "../services/internal-feature-gate";

export async function handleInternalRoute(env: Env, auth: AuthInfo | null): Promise<Response> {
  if (!(await verifyCycloidMember(env.DB, auth))) {
    return jsonErrorResponse("Forbidden", 403);
  }

  return handleInternalFeature(env, auth);
}
```

Use `verifyCycloidAdmin` instead when the capability is admin-only.

## Gating UI

UI gates are exposure controls, not a security boundary. The control plane must still enforce the route
or service behavior with the async helpers.

To add an authenticated UI capability, update all of these in the same PR:

- [`shared/types/bootstrap.ts`](../shared/types/bootstrap.ts), the `BootstrapCapabilities` contract.
- `buildBootstrapCapabilities` in
  [`bootstrap.ts`](../apps/control-plane-worker/src/services/bootstrap.ts).
- [`tests/test_cloudflare/bootstrap-service.test.ts`](../tests/test_cloudflare/bootstrap-service.test.ts).
- The UI consumer that reads `capabilities.*`.

Derive new internal capabilities from the canonical helper instead of copying raw business-ID compares.
Current bootstrap predicates are not all identical:

- `planApproval` uses the single `PLAN_APPROVAL_ACTIVATION` deploy-safety seam, now enabled for every authenticated user.

- `canStartSupportView` uses the canonical admin gate and excludes impersonation.
- `canAdminPendingSignups` uses the resolved `user.isCycloidAdmin` bootstrap field and excludes
  impersonation.
- `canUseInternalModelProviderKeys` is a prod-only raw `SEEDED_BUSINESS_IDS.cycloid` check. It excludes
  QA and is a known exception.

## Testing

Use these tests as the reference patterns:

- [`internal-feature-gate.test.ts`](../tests/test_cloudflare/services/internal-feature-gate.test.ts) for
  canonical gate behavior.
- [`bootstrap-service.test.ts`](../tests/test_cloudflare/bootstrap-service.test.ts) for UI capabilities.

For each new gated path, cover the branch matrix that the existing tests encode:

- Prod Cycloid business, QA Cycloid business, and customer business.
- Admin and member roles when the role matters.
- Missing, malformed, or invalid auth.
- Impersonation evaluated through `actorUser`, not the impersonated customer.

Prod-only exceptions also need an explicit QA-denial test so a future cleanup does not silently grant QA
access to prod credentials.

## Known Prod-Only Exceptions

These checks deliberately differ from the canonical prod+QA helper today. Do not "consolidate" them
through `isCycloidMember` or `verifyCycloidMember` unless the change intentionally grants QA access to
real prod credentials and has tests proving that outcome.

- `canUseInternalModelProviderKeys` in
  [`bootstrap.ts`](../apps/control-plane-worker/src/services/bootstrap.ts) is an inline prod-only
  bootstrap capability.

These are probably intentional because they protect real prod ChatGPT or model-provider billing
credentials. Keeping them separate is safer than accidentally broadening access under the name of cleanup.

## Per-Business Capability Columns

A capability that rolls out deliberately to specific businesses (not "all Cycloid members")
uses a single boolean column on `businesses`, default off, mirroring
`self_hosted_sandboxes_enabled` (migration 0101). This is not the binary internal gate and is
not a general flag system — it is one column per capability, read server-side and enforced there.

- `codex_byos_enabled` (migration 0255) gates Codex bring-your-own-subscription (BYOS): connecting
  and using a personal ChatGPT/Codex `auth.json` as the OpenAI model-provider credential, alongside
  BYOK. Resolver `isCodexByosEnabledForBusiness(db, businessId)` in
  [`business/db.ts`](../apps/control-plane-worker/src/business/db.ts); per-user eligibility via
  `isCodexSubscriptionEligibleForUser(db, userId)` in
  [`settings/service.ts`](../apps/control-plane-worker/src/settings/service.ts). Enforced at the
  settings save/clear/toggle routes, the session-create provider-credential gate, and the spawn-time
  credential resolver. Seeded on prod `biz-arcanist` to preserve the prior internal-only behavior.

## What Not To Do

- Do not hardcode Cycloid business IDs inline for new gates.
- Do not add PostHog, LaunchDarkly, per-feature flag tables, or speculative rollout config for this
  binary internal gate.
- Do not gate only in the UI.
- Do not use sync helpers for request authorization.
- Do not collapse prod-only credential exceptions into the canonical helper without preserving or
  intentionally changing QA behavior with tests.

# Support View Impersonation

## Goal

Let Cycloid internal operators view a customer's Cycloid experience for debugging without the ability to act as that customer. First version focuses on session list/detail/transcript debugging.

## Non-Goals

- Do not use WorkOS or another external impersonation provider.
- Do not support submitting prompts, stopping sessions, creating PRs, changing settings, connecting OAuth providers, or mutating customer data while impersonating.
- Do not make impersonation a general customer-success workflow; keep it an internal debugging tool.

## Existing Foundation

The repo already has most of the backend primitives:

- `apps/control-plane-worker/src/routes/admin-impersonation.ts`
- `apps/control-plane-worker/src/auth/impersonation-db.ts`
- `apps/control-plane-worker/migrations/0111_impersonation_sessions.sql`
- `apps/control-plane-worker/src/router.ts` read-only guard
- `apps/control-plane-worker/src/routes/shared.ts` route flags:
  - `impersonationReadOnlyAllowed`
  - `impersonationMutatingGet`
- `apps/ui/src/components/ImpersonationBanner.tsx`
- `apps/control-plane-worker/src/auth/routes.ts` already resolves an impersonation cookie before the normal browser session cookie.

## Cookie Override Model

Use `impersonation_token` as the support-view login override instead of replacing `session_token`.

Current auth resolution already supports this:

1. Browser keeps the operator's normal `session_token`.
2. Starting support view sets `impersonation_token`.
3. `authenticateRequest()` checks `impersonation_token` first.
4. If valid, auth resolves as the target customer user and includes actor metadata:
   - `auth.userId` / `auth.user`: target customer
   - `auth.actorUserId` / `auth.actorUser`: Cycloid operator
   - `auth.impersonationId`
   - `auth.readOnly: true`
5. If the impersonation token is expired, revoked, or invalid, auth fails closed and clears `impersonation_token`; it must not silently fall back to `session_token`.
6. Stopping support view revokes the impersonation row and clears `impersonation_token`; the operator's original `session_token` remains intact.

This overwrites the active logged-in identity while preserving the operator's real session for exit/recovery. Avoid replacing `session_token` directly: it would make safe exit harder, blur actor tracking, and risk treating support-view traffic as a normal customer login.

## User Flow

1. Operator opens an internal admin page.
2. Operator searches for a customer by login, email, business, or session ID.
3. Operator selects a target user and enters a required reason.
4. Backend verifies:
   - request is from a real browser session,
   - actor is a Cycloid admin,
   - actor has authoritative internal-feature access,
   - actor's current browser session is active,
   - target user exists and has active business membership,
   - actor is below the active impersonation limit.
5. Backend creates an `impersonation_sessions` row, stores only a token hash, and sets `impersonation_token`.
6. UI redirects to the selected customer session when started from a session lookup, otherwise to the customer's session list.
7. Layout shows a persistent `Viewing as <customer> in read-only mode` banner with a stop button.
8. Stop button revokes the impersonation row, clears `impersonation_token`, and reloads as the operator.

## Backend Requirements

- Keep the impersonation token separate from `session_token`.
- Keep 30-minute TTL with no extension on use.
- Require a reason between the existing configured min/max lengths.
- Log creation, use, blocked mutation attempts, and revocation with:
  - impersonation ID,
  - actor user ID and GitHub ID,
  - target user ID and login,
  - reason,
  - request ID,
  - IP / user agent when available.
- Keep Sentry user bound to the actor, not the target, during impersonation.
- Preserve target-user read behavior so existing session/business access checks work naturally.
- Deny mutating authenticated routes when `auth.readOnly` is set.
- Keep explicit opt-outs only for exit routes such as logout and impersonation revoke.
- Audit all authenticated `GET` routes for side effects; mark side-effectful ones with `impersonationMutatingGet: true`.
- Add service-level read-only checks on sensitive session operations as defense in depth:
  - send prompt,
  - answer question,
  - stop/resume,
  - archive/unarchive,
  - create PR,
  - repo/settings/integration mutations.

## Admin UI Requirements

Add an internal admin route, for example `/admin/impersonation`.

Controls:

- Search input supporting login, email, business name/id, and session ID.
- Target result list showing user, business, and recent sessions.
- Required reason textarea.
- Start support view button.

Visibility:

- Gate the route behind the same capabilities used for internal admin access.
- Non-authorized users should receive the same capability denial behavior as other internal pages.

After start:

- If a session was selected, navigate to `/sessions/:sessionId`.
- Otherwise navigate to `/`.

## Read-Only UI Requirements

When `user.impersonation?.readOnly` is present:

- Show `ImpersonationBanner` globally.
- Hide or disable:
  - new session entry points,
  - prompt composer,
  - file uploads,
  - answer-question controls,
  - stop/resume buttons,
  - archive/unarchive,
  - create PR / publish actions,
  - settings mutation controls,
  - OAuth connect/disconnect controls,
  - token/API key management.
- Keep passive reads available:
  - session list,
  - session detail,
  - transcript/history,
  - artifacts/screenshots where normal target access permits.

UI disabling is convenience only. Backend denial is authoritative.

## Data Model

Continue using `impersonation_sessions`:

- `id`
- `token_hash`
- `actor_user_id`
- `target_user_id`
- `reason`
- `expires_at`
- `revoked_at`
- `created_at`
- `last_used_at`

Optional follow-up fields if audit needs them in D1 rather than logs:

- `created_ip`
- `created_user_agent`
- `revoked_ip`
- `revoked_user_agent`

Do not store raw impersonation tokens.

## Security Invariants

- Fail closed if the impersonation cookie is present but invalid.
- Never fall back to the operator's `session_token` while an invalid impersonation cookie is present.
- Never expose customer credentials or provider tokens to the operator.
- Never allow writes under `auth.readOnly`, even if the UI accidentally exposes a control.
- Never let bearer tokens, CLI tokens, admin tokens, or automation tokens mint impersonation sessions.
- Target session existence must still be hidden from unauthorized non-impersonated users with existing `404` behavior.
- Operator identity must be retained in logs and Sentry for every impersonated request.

## Testing Plan

Backend:

- Existing `routeMutatesUnderImpersonation` tests should remain.
- Add route tests for:
  - creation requires admin/internal access,
  - creation requires an active browser session,
  - creation requires reason,
  - target must exist and have active business membership,
  - invalid impersonation cookie fails closed and clears cookie,
  - mutating session routes return `403` under impersonation,
  - revoke works while impersonating.

UI:

- `/auth/me` with impersonation context renders the banner.
- Prompt composer is unavailable in support view.
- Stop impersonating clears the mode and reloads.
- Internal admin page can search, require reason, and submit.

Manual/local verification:

- Start local app.
- Log in as an internal Cycloid admin.
- Start support view for a seeded customer.
- Confirm `impersonation_token` is set while `session_token` remains.
- Confirm `/auth/me` returns target user plus impersonation context.
- Confirm session transcript reads work.
- Confirm prompt submission and other mutations return `403`.
- Stop support view and confirm the operator session is restored.

## Rollout Plan

1. Backend hardening:
   - finish route tests,
   - audit side-effectful `GET`s,
   - add service-level read-only checks.
2. Admin UI:
   - target search,
   - required reason,
   - start support view,
   - redirect.
3. UI read-only polish:
   - banner,
   - hide/disable mutation controls,
   - focused UI tests.
4. Operational audit:
   - confirm logs contain actor/target/reason,
   - add Datadog/Sentry facets if needed.

## Open Questions

- Should support view be limited to Cycloid-owned/internal businesses first, or all customers once admin-gated?
- Should we store IP/user-agent in D1 or rely on structured logs?
- Should an operator be allowed to have more than one active support-view session at a time? The current limit allows up to five; one may be simpler operationally.

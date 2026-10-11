# Configurable CI-failure Response & Review-loop Timeout

Date: 2026-06-01
Status: Design — pending implementation plan

## Problem

The PR review loop has two hardcoded behaviors that don't fit all users:

1. **CI failures are coupled to the bot checklist.** `ingestReviewLoopCiFailureWebhook`
   (`apps/control-plane-worker/src/services/review-loop-epochs.ts:1536`) gates on
   `resolveReviewLoopChecklist`, which returns `empty_expected_bots`
   (`review-loop-settings.ts:146`) when a repo has no configured bots. Result: a user
   with **no review bots but real CI failures** gets those failures silently dropped, and
   a user who **doesn't want** the loop reacting to CI has no way to turn it off.

2. **The collection-window timeout is hardcoded** to 10 minutes
   (`FALLBACK_AFTER_MS = 10 * 60 * 1000`, `review-loop-epochs.ts:131`, applied at `:520`).
   Users can't shorten it (respond faster) or lengthen it (wait for slow bots/CI).

## Goals

- Make "respond to CI failures" an **opt-out**, per repo, **enabled by default**, and
  **independent of the bot checklist** (works with zero bots configured).
- Make the collection-window timeout **configurable per repo**, default 10 min, clamped
  to **1–60 min**.
- Reuse the existing per-repo settings table, routes, service, and UI panel. No new
  routes, no new tables.

## Non-goals

- Changing bot or human review response behavior. The CI toggle suppresses **only**
  CI-failure-triggered loops; bot and human responses are unaffected.
- Global (per-user) settings. Both new settings are per-repo, matching the bot checklist
  granularity (decision: per-repo).
- Changing CI epoch readiness semantics. CI epochs have no expected bots, so they are
  immediately `ready`; the timeout governs only the **bot collection window**.

## Decisions (confirmed)

- **Scope:** per-repo, stored on `user_pr_review_bot_settings`.
- **CI default:** enabled — if the master `pr_review_auto_response_enabled` toggle is on,
  CI failures are addressed even with zero bots.
- **Timeout bounds:** 1–60 minutes, default 10.
- **CI-off scope:** suppresses only CI-triggered loops; bot/human paths unchanged.

## Data model

Append-only migration adding two columns to `user_pr_review_bot_settings`:

```sql
ALTER TABLE user_pr_review_bot_settings
  ADD COLUMN ci_response_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_pr_review_bot_settings
  ADD COLUMN review_timeout_minutes INTEGER NOT NULL DEFAULT 10;
```

Run `npx vitest run tests/test_cloudflare/migration-integrity.test.ts` after adding the file.

Timeout is stored in **minutes** (human-readable, DB-inspectable) and converted to ms
internally (`minutes * 60_000`).

**No row = defaults.** `getUserPrReviewBotSettings` maps a null row to the column
defaults, so a user with zero bots gets `ci_response_enabled = 1` and
`review_timeout_minutes = 10` without ever opening settings — this is what unblocks the
no-bots-but-CI-failures case.

## CI gate decoupled from the bot checklist

Add `resolveReviewLoopCiEligibility` to `review-loop-settings.ts`, mirroring
`resolveReviewLoopHumanEligibility`:

```ts
export type ReviewLoopCiEligibility =
  | { ok: true; ownerUserId: number; installationId: number; fallbackAfterMs: number }
  | { ok: false; reason: "auto_response_disabled" | "ci_response_disabled" | "installation_capabilities_missing" };
```

Logic:

1. Master toggle on (`pr_review_auto_response_enabled !== 0`), else `auto_response_disabled`.
2. Installation capabilities present (reuse `checkReviewLoopInstallationCapabilities`),
   else `installation_capabilities_missing`.
3. Per-repo `ci_response_enabled = 1`, else `ci_response_disabled`.
4. No bot checklist required.

Swap this in at `ingestReviewLoopCiFailureWebhook`
(`review-loop-epochs.ts:1536`) in place of `resolveReviewLoopChecklist`. The CI epoch
continues to use `expectedBots: []` and `expectedBotsHash: REVIEW_LOOP_CI_EPOCH_HASH`.

## Configurable timeout plumbing

1. Extend the `getUserPrReviewBotSettings` payload (`settings/db.ts`) to also return
   `ciResponseEnabled: boolean` and `timeoutMs: number` (derived from
   `review_timeout_minutes`), so the bot path resolves bots + timeout in one read.
2. `resolveReviewLoopChecklist` adds `fallbackAfterMs` to its `ok` result.
3. Add an optional `fallbackAfterMs` to `ReviewLoopActivityInput`.
4. `insertReviewLoopEpochActivity` (`review-loop-epochs.ts:520`) uses
   `input.fallbackAfterMs ?? FALLBACK_AFTER_MS` instead of the bare constant. Human
   epochs still resolve to `now` (immediate); CI epochs stay immediately-ready via empty
   expected bots, so the configured timeout meaningfully affects only the bot collection
   window.
5. Clamp to 1–60 min at the API boundary; `FALLBACK_AFTER_MS` remains the default/fallback.

## API & validation

Extend the existing endpoints (no new routes):
`GET` / `PUT /api/settings/repositories/:owner/:repo/pr-review-bots`.

- `prReviewBotSettingsBodySchema` (`settings/routes.ts:59`) gains:
  - `ciResponseEnabled: z.boolean().optional()`
  - `reviewTimeoutMinutes: z.number().int().min(1).max(60).optional()`
- `getPrReviewBotSettingsPayload` returns `{ expectedBots, ciResponseEnabled, reviewTimeoutMinutes }`.
- `updatePrReviewBotSettingsPayload` / `setUserPrReviewBotSettings` persist the two new
  fields alongside `expected_bots_json`.

### Persisting a no-bots preference

Today a repo only surfaces in settings if it has bots — `listUserPrReviewBotSettings`
filters `expected_bots_json <> '[]'` (`settings/db.ts:361,371`), and
`listPrReviewBotSettingsPayload` skips empty-bot rows (`service.ts:393`). For a no-bots user
to save a CI/timeout preference:

- `PUT` must persist a row even when `expectedBots` is empty (currently
  `setUserPrReviewBotSettings` already writes `'[]'`; the empty-bots PUT path just needs
  to be reachable — it is, since the body validates an empty array).
- Widen the list predicate to include rows that are non-default:
  `expected_bots_json <> '[]' OR ci_response_enabled = 0 OR review_timeout_minutes <> 10`.
  Update both the cursor and non-cursor branches, and drop the
  `if (row.expectedBots.length === 0) continue;` skip in `service.ts:393` so configured
  repos with CI/timeout but no bots still list.

## UI

In `apps/ui/src/components/settings/GeneralSettings.tsx`, within the per-repo PR-review
panel:

- "Respond to CI failures" toggle, default on, bound to `ciResponseEnabled`.
- Timeout number input (1–60, default 10) labeled in minutes, bound to
  `reviewTimeoutMinutes`.
- Both saved through the existing PUT for that repo.

## Testing (same PR)

- **DAO:** `getUserPrReviewBotSettings` returns column defaults for a null row; round-trips
  `ci_response_enabled` and `review_timeout_minutes` after `setUserPrReviewBotSettings`.
- **CI eligibility:** no bots → eligible; `ci_response_enabled = 0` → `ci_response_disabled`;
  master toggle off → `auto_response_disabled`; missing install caps → fail closed.
- **Timeout:** per-repo minutes flow into `fallback_after_at` on the bot path; default
  preserved when unset; API rejects `< 1` and `> 60`.
- **CI ingestion:** a failing check on a no-bots repo creates a `source_kind='ci'` epoch
  (previously dropped as `empty_expected_bots`); disabled CI returns ignored.
- **List:** a repo with no bots but non-default CI/timeout appears in the settings list.

Extend existing suites: `tests/test_cloudflare/session/pr-workflow.test.ts` and the
settings/DAO tests; add cases rather than new files where a suite already covers the area.

## Risks

- **Widening the list predicate** could surface repos that previously stayed hidden;
  acceptable since they now carry a real preference. Verify pagination/cursor still order
  by `(repo_owner, repo_name)` consistently.
- **Default-on CI for no-bots users** increases the set of PRs the loop reacts to versus
  today. This is the intended behavior; it is still gated by the master toggle and
  installation capabilities, both fail-closed.

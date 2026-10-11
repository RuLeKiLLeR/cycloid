# Database & Migrations

D1, DAO, and migration rules.

## Database contract

- The control-plane worker uses **Cloudflare D1** as its only database.
- All access is via raw SQL prepared statements on `D1Database`. No ORM, no generated schema layer.
- Row types live alongside the DAO queries that use them.
- DAO functions accept `D1Database` as their first argument.

## Where data access lives

| Area                                     | Primary DAO files                                                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions and replay metadata             | `src/session/db.ts`, `src/session/do-db.ts`, `src/session/usage-db.ts`, `src/session/completions-db.ts`, `src/session/feedback-db.ts`, `src/session/memory-feedback-db.ts`, `src/session/slack-posts-db.ts` |
| Auth and users                           | `src/auth/db.ts`, `src/auth/impersonation-db.ts`, `src/settings/db.ts`, `src/business/db.ts`                                                                                                                |
| Integrations and GitHub                  | `src/integrations/db.ts`, `src/integrations/lifecycle/db.ts`, `src/integrations/health-db.ts`, `src/integrations/test-credentials-db.ts`, `src/github/db.ts`, `src/github/installations-db.ts`              |
| Webhooks, historical evaluations, memory | `src/webhooks/db.ts`, `src/eval/db.ts`, `src/memory/db.ts`, `src/slack/interaction-requests-db.ts`                                                                                                          |
| Automation rules and event jobs          | `src/automation/db.ts`                                                                                                                                                                                      |
| Sandbox, QA, env, child sessions         | `src/qa/db.ts`, `src/env-blobs/db.ts`, `src/session/child-session-db.ts`, `src/sandbox/vm-reservations-db.ts`                                                                                               |
| OpenAI gateway                           | `src/openai-gateway/db.ts`                                                                                                                                                                                  |

## Query rules

- Prepared statements with bind parameters for every query.
- Keep business logic out of DAO files.
- New query filtering/sorting by a new column on a large table: add the matching index in the same migration.
- Timestamps are Unix milliseconds, not ISO strings.

```ts
// Single query
const row = await db
  .prepare("SELECT * FROM session_index WHERE session_id = ? LIMIT 1")
  .bind(sessionId)
  .first<SessionRow>();

// Batch two independent queries into one round-trip
const [resultA, resultB] = await db.batch([
  db.prepare("SELECT * FROM user_settings WHERE user_id = ? LIMIT 1").bind(userId),
  db.prepare("SELECT integration_id FROM user_integrations WHERE user_id = ?").bind(userId),
]);
// Batch results are D1Result[] — access via .results, not .first()
const settingsRow = (resultA.results as SettingsRow[])[0] ?? null;
const integrationRows = resultB.results as IntegrationRow[];
```

Use `db.batch()` whenever a handler needs two or more independent queries — it combines them into one round-trip. **Do not** use `Promise.all` for parallel D1 calls; it still makes separate network round-trips.

For conditional related data (e.g. member IDs only when a flag is set), use a `CASE WHEN` subquery with `GROUP_CONCAT` in the primary query instead of a second round-trip; split the comma-separated result with `.split(',')` in the application layer.

## Migration workflow

1. Add a new SQL file under `apps/control-plane-worker/migrations/` using `NNNN_description.sql` (four-digit zero-padded sequence, e.g. `0099_new_feature.sql`).
2. Commit the SQL file.
3. Apply and verify the migration locally.

For internal Cycloid business membership changes, follow [Cycloid Business Membership Runbook](cycloid-business-membership-runbook.md).

## Migration rules

- Never modify a deployed migration file.
- Prefer `IF NOT EXISTS` / `IF EXISTS` where SQLite supports it.
- Migrations apply once via `wrangler d1 migrations apply` (tracked in wrangler's native `d1_migrations` table), the same engine the CI gate validates with. There is no custom runner and no duplicate-column-error swallowing, so a migration that fails partway is recorded as unapplied and re-runs the whole file. `ALTER TABLE ADD COLUMN` is not idempotent; keep each migration minimal and prefer `IF NOT EXISTS` guards where SQLite supports them so a re-run after a partial failure does not error.
- Constraint changes usually require table recreation. Use a previous table-rebuild migration as the reference pattern.
- Destructive column or table changes require the three-PR sequence:
  1. add the new schema alongside the old one
  2. switch application code to the new schema
  3. remove the old schema in a later migration
- A migration PR should not include app code depending on the new schema unless the change is strictly additive and deploy-safe.

## Dead/unused schema

Retained for append-only discipline; no code reads or writes these:

- `businesses.self_hosted_sandboxes_enabled` and `user_settings.self_hosted_sandboxes_opt_in` columns.
- `runtime_capacity_admissions` table.
- `user_settings.pr_review_auto_response_enabled`, `user_pr_review_bot_settings.ci_response_enabled`, and `user_pr_review_bot_settings.review_timeout_minutes` columns — the auto-response / CI-response opt-outs (ARC-1288) and the review-loop wall-time collect window (`review_timeout_minutes`, #6999/#7000) were removed; review-listening always arms for capable repos and there is no batching/collection window. Fully orphaned: no code reads, writes, or echoes them (`settings/db.ts` deliberately leaves them out of the write so their schema DEFAULTs apply). The settings routes/service/DAOs, API, and bootstrap payloads dropped them; the columns are retained (with their schema defaults) for append-only discipline until a later drop wave.
- `ws_recovery` table — WebSocket client recovery cursor persistence was removed (#6184). The table is retained in the SessionDO schema for append-only discipline.
- `pr_review_reviewer_settle` table (migration `0217`) — the per-PR-per-reviewer first-contact "settle / no-show" latch. Fully orphaned after the review-loop lifecycle collapse: `caught_up` no longer waits on reviewer settle, so no code reads, writes, arms, or fires these rows. The table (and its `offboarding-tables.ts` cascade entry) are retained under append-only discipline until a later drop wave.
- `pr_stage_regions` table (migration `0188`) — the per-PR ownership + last-rendered-hash bookkeeping for the PR-body "PR progress" stage region. Fully orphaned after the stage region was removed: the renderer, DAO, `prStageOf` projection, and all sync call sites are deleted, so no code reads or writes these rows. The table (and its `offboarding-tables.ts` cascade entry) are retained under append-only discipline until a later drop wave (precedent: `pr_review_reviewer_settle`).
- `user_pr_review_bot_settings.expected_bots_json` — **not dead / not a drop candidate; recorded here only for the role change.** Its former **wait-set** role (pause the loop until the expected bots arrive or the collect window elapses) was retired with the wall-time collect window and the reviewer wait-set / no-show subsystem (#6999/#7003). Its **allow-list** role stays fully live: `expectedBots` is the set of reviewers whose terminal signals the sweep ingests, matches, and backfills (`services/review-loop-sweep.ts` — `missingExpectedKnownBotKeys`, `matchExpectedKnownTerminalBotByActor`). Do not drop this column.

## Local commands

```bash
# Apply local migrations
npm run db:migrate:local

# Query local D1
wrangler d1 execute cycloid-control-plane-production --local --command "SELECT * FROM session_index LIMIT 5"
```

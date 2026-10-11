# Plan Mode Text Enum Migration Design

## Goal

Store the plan-mode setting in D1 as the checked text enum `off | on | auto`, while keeping every deployment and rollback compatible throughout the migration.

## Decision

Use a three-PR Graphite stack that expands the schema, switches the application, and then contracts the schema. The final D1 column is `user_settings.plan_mode_setting TEXT NOT NULL DEFAULT 'off' CHECK (plan_mode_setting IN ('off', 'on', 'auto'))`.

The public API remains unchanged: it already exposes `planMode: "off" | "on" | "auto"` after PR #7572. This migration only makes the persistence representation match that contract.

## Alternatives Considered

1. **One-shot table rebuild:** smallest final diff, but the migration would remove the integer column before the new worker is deployed. The running worker would fail during that deployment window and rollback would be unsafe. Rejected.
2. **Four application dual-write waves:** avoids database triggers, but needs an extra deploy to stop writing the old column before it can be dropped. Safe but unnecessarily slow for one setting.
3. **Three waves with temporary D1 synchronization triggers:** keeps old and new workers compatible, closes the between-deploy write gap, and matches the repository's required expand/switch/contract sequence. Selected.

## PR 1: Expand and Synchronize

PR #7572 remains the first PR in the stack.

- Add `plan_mode_setting` as a checked text column with default `off`.
- Backfill every existing row with the exact mapping `0 -> off`, `1 -> on`, `2 -> auto`.
- Fail migration verification if any other integer value exists instead of silently converting it.
- Add temporary, guarded D1 triggers that synchronize integer writes to text and text writes to integer. Separate, mutually exclusive insert triggers support both the old worker (integer supplied, text defaulted) and new worker (text supplied, integer defaulted); guarded update triggers keep later writes aligned. The guards compare mapped values so trigger recursion is harmless even if recursive triggers are enabled.
- Keep application reads and writes on the integer column in this PR.
- Retain #7572's internal Cycloid backfill to `auto`; the synchronization trigger keeps the new text column consistent.

This makes the new schema available without requiring it and preserves rollback compatibility.

## PR 2: Switch the Application

- Change the settings DAO row contract and SQL to read and write `plan_mode_setting` directly as `PlanModeSetting`.
- Remove the integer conversion helpers once no application code uses them.
- Keep both synchronization triggers so a rollback to the PR-1 worker still observes current integer values.
- Re-run a consistency update before switching reads, covering any rows written during deployment transitions.
- Keep API, bootstrap, session-resolution, and UI contracts on `off | on | auto`.

Invalid persisted text must not silently become `off`. The D1 `CHECK` constraint prevents new invalid values, and application parsing fails closed if an impossible value reaches the DAO boundary.

## PR 3: Contract

- Rebuild `user_settings` without the integer `plan_mode` column, following the repository's existing D1 table-rebuild pattern.
- Preserve every other column, value, primary key, foreign key, default, and index.
- Keep the text column named `plan_mode_setting`; no deploy-time rename is needed.
- Drop the temporary synchronization triggers as part of the rebuild.
- Remove migration-only compatibility tests and retain final-schema tests.

Because the PR-2 worker no longer references the integer column, the contract migration is safe before the PR-3 worker deploys.

## Data Flow

During PR 1, the application writes the integer and D1 mirrors the text value. During PR 2, the application writes the text value and D1 mirrors the integer for rollback. After PR 3, only the checked text value remains.

## Verification

Each PR receives a focused Workerd migration test before production code or SQL is changed.

- PR 1 proves the backfill mapping, both trigger directions, recursive-trigger safety, the internal `auto` backfill, and rejection of invalid text.
- PR 2 proves DAO creation, update, read, bootstrap, and session resolution use the text column while the rollback integer remains synchronized.
- PR 3 proves a fully migrated fixture retains all settings, the integer column and triggers are absent, and invalid text cannot be inserted.
- Every PR runs its focused suites, `git diff --check`, and `npm run verify:changed`.

## Stack and Rollout

The stack is created and submitted only with Graphite. PR 2 depends on PR 1; PR 3 depends on PR 2. They merge and deploy in order. The contract PR must not merge until the application-switch PR is deployed successfully.

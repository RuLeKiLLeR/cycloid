# Plan Mode Text Enum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the D1 integer encoding for the user plan-mode setting with the checked text enum `off | on | auto` through a deploy-safe three-PR Graphite stack.

**Architecture:** PR 1 expands `user_settings` with `plan_mode_setting` and temporary bidirectional synchronization triggers while the application stays on `plan_mode`. PR 2 switches the application to the text column while the triggers preserve rollback compatibility. PR 3 rebuilds `user_settings` without the integer column or triggers after the text-reading worker is deployed.

**Tech Stack:** Cloudflare D1/SQLite migrations, TypeScript, Vitest, Workerd migration tests, Graphite.

## Global Constraints

- Never modify migration `0256_user_settings_plan_mode.sql`; it is already deployed.
- Use append-only migrations `0260`, `0261`, and `0262`.
- Keep the API field `planMode` typed as `"off" | "on" | "auto"` throughout the stack.
- Use `business_members` as the source of truth for the internal Cycloid membership backfill.
- Submit and restack branches only through Graphite (`gt`).
- Do not merge PR 3 until PR 2 has deployed successfully.

---

### Task 1: Expand D1 with the checked text column

**Files:**

- Modify: `tests/test_workerd/d1-migrations.test.ts`
- Modify: `apps/control-plane-worker/migrations/0260_backfill_cycloid_plan_mode_auto.sql`

**Interfaces:**

- Consumes: existing `user_settings.plan_mode INTEGER` values `0`, `1`, and `2`.
- Produces: `user_settings.plan_mode_setting TEXT NOT NULL DEFAULT 'off' CHECK (...)` plus temporary synchronization triggers.

- [ ] **Step 1: Extend Workerd assertions before changing the migration**

Add `plan_mode_setting` assertions to the three fixture rows:

```ts
expect(internal).toMatchObject({ plan_mode: 2, plan_mode_setting: "auto" });
expect(inserted).toMatchObject({ plan_mode: 2, plan_mode_setting: "auto" });
expect(external).toMatchObject({ plan_mode: 1, plan_mode_setting: "on" });
```

Add a test that exercises old-worker and new-worker inserts, both update directions, and the constraint. Use fresh fixture users for the insert cases: inserting only `plan_mode = 2` must produce `plan_mode_setting = 'auto'`, while inserting only `plan_mode_setting = 'auto'` must produce `plan_mode = 2`.

```ts
it("keeps integer and text plan-mode columns synchronized during rollout", async () => {
  await env.DB.prepare("UPDATE user_settings SET plan_mode = 2 WHERE user_id = ?")
    .bind(EXTERNAL_WITH_SETTINGS_ID)
    .run();
  expect(
    await env.DB.prepare("SELECT plan_mode_setting FROM user_settings WHERE user_id = ?")
      .bind(EXTERNAL_WITH_SETTINGS_ID)
      .first(),
  ).toMatchObject({ plan_mode_setting: "auto" });

  await env.DB.prepare("UPDATE user_settings SET plan_mode_setting = 'off' WHERE user_id = ?")
    .bind(EXTERNAL_WITH_SETTINGS_ID)
    .run();
  expect(
    await env.DB.prepare("SELECT plan_mode FROM user_settings WHERE user_id = ?")
      .bind(EXTERNAL_WITH_SETTINGS_ID)
      .first(),
  ).toMatchObject({ plan_mode: 0 });

  await expect(
    env.DB.prepare("UPDATE user_settings SET plan_mode_setting = 'sometimes' WHERE user_id = ?")
      .bind(EXTERNAL_WITH_SETTINGS_ID)
      .run(),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run Workerd and verify RED**

Run `npm run test:workerd -- tests/test_workerd/d1-migrations.test.ts`.

Expected: FAIL because `plan_mode_setting` does not exist.

- [ ] **Step 3: Expand migration 0260 and backfill text values**

Prepend:

```sql
ALTER TABLE user_settings
ADD COLUMN plan_mode_setting TEXT NOT NULL DEFAULT 'off'
CHECK (plan_mode_setting IN ('off', 'on', 'auto'));

UPDATE user_settings
SET plan_mode_setting = CASE plan_mode
  WHEN 0 THEN 'off'
  WHEN 1 THEN 'on'
  WHEN 2 THEN 'auto'
  ELSE '__invalid_plan_mode__'
END;
```

The fallback deliberately violates the `CHECK`, making an unknown integer fail the migration.

- [ ] **Step 4: Add guarded rollout triggers**

Add before the internal-business update:

```sql
CREATE TRIGGER user_settings_plan_mode_to_setting_insert
AFTER INSERT ON user_settings
WHEN NEW.plan_mode != 0 AND NEW.plan_mode_setting = 'off'
BEGIN
  UPDATE user_settings SET plan_mode_setting = CASE NEW.plan_mode
    WHEN 0 THEN 'off' WHEN 1 THEN 'on' WHEN 2 THEN 'auto'
    ELSE '__invalid_plan_mode__' END
  WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER user_settings_plan_mode_setting_to_mode_insert
AFTER INSERT ON user_settings
WHEN NEW.plan_mode = 0 AND NEW.plan_mode_setting != 'off'
BEGIN
  UPDATE user_settings SET plan_mode = CASE NEW.plan_mode_setting
    WHEN 'off' THEN 0 WHEN 'on' THEN 1 WHEN 'auto' THEN 2 END
  WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER user_settings_plan_mode_to_setting_update
AFTER UPDATE OF plan_mode ON user_settings
WHEN NEW.plan_mode_setting != CASE NEW.plan_mode
  WHEN 0 THEN 'off' WHEN 1 THEN 'on' WHEN 2 THEN 'auto'
  ELSE '__invalid_plan_mode__' END
BEGIN
  UPDATE user_settings SET plan_mode_setting = CASE NEW.plan_mode
    WHEN 0 THEN 'off' WHEN 1 THEN 'on' WHEN 2 THEN 'auto'
    ELSE '__invalid_plan_mode__' END
  WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER user_settings_plan_mode_setting_to_mode_update
AFTER UPDATE OF plan_mode_setting ON user_settings
WHEN NEW.plan_mode != CASE NEW.plan_mode_setting
  WHEN 'off' THEN 0 WHEN 'on' THEN 1 WHEN 'auto' THEN 2 END
BEGIN
  UPDATE user_settings SET plan_mode = CASE NEW.plan_mode_setting
    WHEN 'off' THEN 0 WHEN 'on' THEN 1 WHEN 'auto' THEN 2 END
  WHERE user_id = NEW.user_id;
END;
```

Keep the existing internal Cycloid update and missing-row insert after the triggers.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run test:workerd -- tests/test_workerd/d1-migrations.test.ts
```

Expected: migration, mapping, trigger, and constraint assertions pass.

- [ ] **Step 6: Verify and amend PR #7572**

Run `git diff --check`, `npm run verify:changed`, stage Task 1 files plus the design and plan, then run:

```bash
gt modify --no-interactive
gt submit --no-interactive --publish
```

Expected: PR #7572 remains the first ready PR.

---

### Task 2: Switch settings persistence to the text enum

**Files:**

- Create: `apps/control-plane-worker/migrations/0261_resync_plan_mode_setting.sql`
- Modify: `apps/control-plane-worker/src/settings/db.ts`
- Modify: `apps/control-plane-worker/src/settings/service.ts`
- Modify: `apps/control-plane-worker/src/services/bootstrap.ts`
- Modify: `apps/control-plane-worker/src/session/state.ts`
- Modify: `shared/plan-mode.ts`
- Modify: `tests/test_cloudflare/settings-db.test.ts`
- Modify: `tests/test_cloudflare/settings-routes.test.ts`
- Modify: `tests/test_cloudflare/bootstrap-service.test.ts`
- Modify: `tests/test_cloudflare/session-plan-mode-resolution.test.ts`
- Modify: `tests/test_workerd/d1-migrations.test.ts`

**Interfaces:**

- Consumes: checked `UserSettingsRow.plan_mode_setting` values.
- Produces: direct `PlanModeSetting` persistence; the temporary trigger mirrors text writes into `plan_mode` for rollback.

- [ ] **Step 1: Create the second Graphite branch**

Run:

```bash
gt create codex/plan-mode-text-application -m "Read plan mode from the D1 text enum"
```

Expected: direct child of `codex/plan-mode-enum-cleanup`.

- [ ] **Step 2: Change tests to the desired text row contract**

Update fake row types and fixtures from `plan_mode: number` to:

```ts
plan_mode_setting: PlanModeSetting;
```

Change DAO expectations to:

```ts
expect(on.plan_mode_setting).toBe("on");
expect(auto.plan_mode_setting).toBe("auto");
expect(off.plan_mode_setting).toBe("off");
```

Change bootstrap and session-resolution fixtures such as `{ plan_mode: 2 }` to `{ plan_mode_setting: "auto" }`. Assert that the generated upsert names `plan_mode_setting` and binds the string unchanged.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npx vitest run tests/test_cloudflare/settings-db.test.ts \
  tests/test_cloudflare/settings-routes.test.ts \
  tests/test_cloudflare/bootstrap-service.test.ts \
  tests/test_cloudflare/session-plan-mode-resolution.test.ts
```

Expected: FAIL because production code still uses integer persistence.

- [ ] **Step 4: Add the final consistency migration**

Create `0261_resync_plan_mode_setting.sql`:

```sql
UPDATE user_settings
SET plan_mode_setting = CASE plan_mode
  WHEN 0 THEN 'off'
  WHEN 1 THEN 'on'
  WHEN 2 THEN 'auto'
  ELSE '__invalid_plan_mode__'
END;
```

- [ ] **Step 5: Switch the DAO contract and SQL**

In `settings/db.ts`, define `plan_mode_setting: PlanModeSetting` in `UserSettingsRow`. Replace `"plan_mode"` with `"plan_mode_setting"` in `USER_SETTINGS_COLUMNS`, both inserts, and the upsert conflict set. Bind `fields.planMode ?? "off"` directly instead of calling `planModeSettingToColumn`.

- [ ] **Step 6: Switch consumers and remove integer adapters**

Return `settings.plan_mode_setting` directly from the settings and bootstrap services. Resolve session settings with:

```ts
const requested = input.explicitPlanMode ?? input.settings?.plan_mode_setting ?? "off";
```

Delete `planModeSettingFromColumn` and `planModeSettingToColumn` after `rg` confirms no callers remain.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
npx vitest run tests/test_shared/plan-mode.test.ts \
  tests/test_cloudflare/settings-db.test.ts \
  tests/test_cloudflare/settings-routes.test.ts \
  tests/test_cloudflare/bootstrap-service.test.ts \
  tests/test_cloudflare/session-plan-mode-resolution.test.ts
npm run test:workerd -- tests/test_workerd/d1-migrations.test.ts
```

Expected: focused tests pass and application-style text writes leave both columns synchronized.

- [ ] **Step 8: Verify and submit PR 2**

Run `git diff --check` and `npm run verify:changed`; stage only Task 2 files; then:

```bash
gt modify --no-interactive
gt submit --no-interactive --publish
```

Expected: a ready PR stacked directly above #7572.

---

### Task 3: Remove the integer column and rollout triggers

**Files:**

- Create: `apps/control-plane-worker/migrations/0262_drop_integer_plan_mode.sql`
- Modify: `tests/test_workerd/d1-migrations.test.ts`

**Interfaces:**

- Consumes: a deployed worker that references only `plan_mode_setting`.
- Produces: final `user_settings` schema containing only the checked text representation.

- [ ] **Step 1: Create the contract branch**

Run:

```bash
gt create codex/plan-mode-text-contract -m "Drop the integer plan-mode column"
```

Expected: direct child of `codex/plan-mode-text-application`.

- [ ] **Step 2: Replace rollout-only assertions with final-schema assertions before the migration**

Remove the PR-1 test that updates `plan_mode` and inspects synchronization triggers, because those compatibility surfaces intentionally disappear in this PR. Remove `plan_mode` from the fixture `toMatchObject` assertions while retaining the `plan_mode_setting` and unrelated-setting assertions. Then add:

```ts
it("contracts user_settings to the checked text plan-mode column", async () => {
  const columns = await env.DB.prepare("PRAGMA table_info(user_settings)").all<{ name: string }>();
  expect(columns.results.map((column) => column.name)).toContain("plan_mode_setting");
  expect(columns.results.map((column) => column.name)).not.toContain("plan_mode");

  const triggers = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'user_settings'",
  ).all<{ name: string }>();
  expect(triggers.results).toEqual([]);

  await expect(
    env.DB.prepare("UPDATE user_settings SET plan_mode_setting = 'sometimes' WHERE user_id = ?")
      .bind(INTERNAL_WITH_SETTINGS_ID)
      .run(),
  ).rejects.toThrow();
});
```

- [ ] **Step 3: Run Workerd and verify RED**

Run `npm run test:workerd -- tests/test_workerd/d1-migrations.test.ts`.

Expected: FAIL because the integer column and synchronization triggers remain.

- [ ] **Step 4: Rebuild `user_settings` without the integer column**

Create `0262_drop_integer_plan_mode.sql`:

```sql
DROP TRIGGER user_settings_plan_mode_to_setting_insert;
DROP TRIGGER user_settings_plan_mode_setting_to_mode_insert;
DROP TRIGGER user_settings_plan_mode_to_setting_update;
DROP TRIGGER user_settings_plan_mode_setting_to_mode_update;

CREATE TABLE user_settings_new (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  default_model TEXT,
  custom_instructions TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  default_repo TEXT,
  pr_review_auto_response_enabled INTEGER NOT NULL DEFAULT 0,
  self_hosted_sandboxes_opt_in INTEGER NOT NULL DEFAULT 0,
  use_codex_subscription INTEGER NOT NULL DEFAULT 0,
  default_pr_draft INTEGER NOT NULL DEFAULT 0,
  auto_verify_enabled INTEGER NOT NULL DEFAULT 0,
  automatic_reviews_enabled INTEGER NOT NULL DEFAULT 0,
  plan_mode_setting TEXT NOT NULL DEFAULT 'off'
    CHECK (plan_mode_setting IN ('off', 'on', 'auto'))
);

INSERT INTO user_settings_new (
  user_id, default_model, custom_instructions, created_at, updated_at,
  default_repo, pr_review_auto_response_enabled, self_hosted_sandboxes_opt_in,
  use_codex_subscription, default_pr_draft, auto_verify_enabled,
  automatic_reviews_enabled, plan_mode_setting
)
SELECT
  user_id, default_model, custom_instructions, created_at, updated_at,
  default_repo, pr_review_auto_response_enabled, self_hosted_sandboxes_opt_in,
  use_codex_subscription, default_pr_draft, auto_verify_enabled,
  automatic_reviews_enabled, plan_mode_setting
FROM user_settings;

DROP TABLE user_settings;
ALTER TABLE user_settings_new RENAME TO user_settings;
```

- [ ] **Step 5: Verify GREEN and preserved data**

Run:

```bash
npm run test:workerd -- tests/test_workerd/d1-migrations.test.ts
npx vitest run tests/test_cloudflare/settings-db.test.ts \
  tests/test_cloudflare/settings-routes.test.ts \
  tests/test_cloudflare/bootstrap-service.test.ts \
  tests/test_cloudflare/session-plan-mode-resolution.test.ts
```

Expected: schema and application suites pass; unrelated setting values remain unchanged.

- [ ] **Step 6: Verify and submit PR 3**

Run `git diff --check` and `npm run verify:changed`; stage only Task 3 files; then:

```bash
gt modify --no-interactive
gt submit --no-interactive --publish
```

Expected: a ready contract PR stacked above PR 2, marked as waiting for PR 2 deployment.

---

### Task 4: Final stack audit

**Files:** Inspect only.

**Interfaces:**

- Consumes: three submitted Graphite branches.
- Produces: evidence that each PR is independently deployable and correctly ordered.

- [ ] **Step 1: Inspect stack and cleanliness**

Run:

```bash
gt log short
git status -sb
```

Expected: three plan-mode branches form one linear stack and the worktree is clean.

- [ ] **Step 2: Inspect PR metadata and checks**

Run `gh pr view --json title,body,state,isDraft,url,headRefName,baseRefName,statusCheckRollup` for each PR. Confirm all are ready, PR 2 targets PR 1, PR 3 targets PR 2, and CI is running or green.

- [ ] **Step 3: Record rollout order**

Report the three PR URLs in merge order: PR 1 may merge first; PR 2 follows after PR 1 deploys; PR 3 remains unmerged until PR 2 is deployed and verified.

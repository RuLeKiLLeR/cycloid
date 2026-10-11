# Configurable CI-failure Response & Review-loop Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PR review loop's CI-failure response a per-repo opt-out (default on, independent of the bot checklist) and make the collection-window timeout per-repo configurable (default 10 min, 1–60 min).

**Architecture:** Add two columns to the existing per-repo `user_pr_review_bot_settings` table. A new `resolveReviewLoopCiEligibility` gate decouples CI responses from the bot checklist. The resolved per-repo timeout threads through `ReviewLoopActivityInput` into epoch creation, replacing the hardcoded `FALLBACK_AFTER_MS`. Existing settings routes, service, DAO, and the UI panel are extended — no new routes or tables.

**Tech Stack:** Cloudflare Workers (TypeScript), D1 (raw prepared statements), Zod validation, React UI, Vitest with better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-06-01-configurable-ci-response-and-review-loop-timeout-design.md`

**Test commands:**

- Single file: `npx vitest run tests/test_cloudflare/<file>.test.ts`
- Typecheck: `npm run typecheck`

---

## Shared constants (referenced throughout)

Defined in Task 1; use these exact names in later tasks:

- `REVIEW_LOOP_TIMEOUT_DEFAULT_MINUTES = 10`
- `REVIEW_LOOP_TIMEOUT_MIN_MINUTES = 1`
- `REVIEW_LOOP_TIMEOUT_MAX_MINUTES = 60`
- `clampReviewLoopTimeoutMinutes(minutes: number): number`

Payload field names used everywhere (DAO → service → route → UI):

- `ciResponseEnabled: boolean`
- `reviewTimeoutMinutes: number`

DB column names: `ci_response_enabled` (INTEGER 0/1), `review_timeout_minutes` (INTEGER).

---

## Task 1: Shared constants for the timeout

**Files:**

- Modify: `shared/constants/pr-review-bots.ts`
- Test: `tests/test_cloudflare/review-loop-timeout-constants.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test_cloudflare/review-loop-timeout-constants.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  clampReviewLoopTimeoutMinutes,
  REVIEW_LOOP_TIMEOUT_DEFAULT_MINUTES,
  REVIEW_LOOP_TIMEOUT_MAX_MINUTES,
  REVIEW_LOOP_TIMEOUT_MIN_MINUTES,
} from "../../shared/constants/pr-review-bots";

describe("review-loop timeout constants", () => {
  it("exposes the agreed default/min/max", () => {
    expect(REVIEW_LOOP_TIMEOUT_DEFAULT_MINUTES).toBe(10);
    expect(REVIEW_LOOP_TIMEOUT_MIN_MINUTES).toBe(1);
    expect(REVIEW_LOOP_TIMEOUT_MAX_MINUTES).toBe(60);
  });

  it("clamps out-of-range and non-finite values", () => {
    expect(clampReviewLoopTimeoutMinutes(0)).toBe(1);
    expect(clampReviewLoopTimeoutMinutes(61)).toBe(60);
    expect(clampReviewLoopTimeoutMinutes(10)).toBe(10);
    expect(clampReviewLoopTimeoutMinutes(12.7)).toBe(12);
    expect(clampReviewLoopTimeoutMinutes(Number.NaN)).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_cloudflare/review-loop-timeout-constants.test.ts`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Add the constants**

Append to `shared/constants/pr-review-bots.ts`:

```ts
export const REVIEW_LOOP_TIMEOUT_DEFAULT_MINUTES = 10;
export const REVIEW_LOOP_TIMEOUT_MIN_MINUTES = 1;
export const REVIEW_LOOP_TIMEOUT_MAX_MINUTES = 60;

/** Clamp a user-supplied timeout to [1, 60] minutes; non-finite falls back to the default. */
export function clampReviewLoopTimeoutMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return REVIEW_LOOP_TIMEOUT_DEFAULT_MINUTES;
  const floored = Math.floor(minutes);
  if (floored < REVIEW_LOOP_TIMEOUT_MIN_MINUTES) return REVIEW_LOOP_TIMEOUT_MIN_MINUTES;
  if (floored > REVIEW_LOOP_TIMEOUT_MAX_MINUTES) return REVIEW_LOOP_TIMEOUT_MAX_MINUTES;
  return floored;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/test_cloudflare/review-loop-timeout-constants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/constants/pr-review-bots.ts tests/test_cloudflare/review-loop-timeout-constants.test.ts
git commit -m "feat: add review-loop timeout constants and clamp helper"
```

---

## Task 2: Migration — add per-repo CI and timeout columns

**Files:**

- Create: `apps/control-plane-worker/migrations/0124_review_loop_ci_optout_and_timeout.sql`
- Modify: `tests/test_cloudflare/migration-integrity.test.ts` (via script)

- [ ] **Step 1: Write the migration**

Create `apps/control-plane-worker/migrations/0124_review_loop_ci_optout_and_timeout.sql`:

```sql
-- Per-repo review-loop controls:
--  * ci_response_enabled: opt-out for addressing CI failures (default on), independent of the bot checklist.
--  * review_timeout_minutes: collection-window timeout in minutes (default 10), governs the bot wait.
ALTER TABLE user_pr_review_bot_settings
  ADD COLUMN ci_response_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE user_pr_review_bot_settings
  ADD COLUMN review_timeout_minutes INTEGER NOT NULL DEFAULT 10;
```

- [ ] **Step 2: Regenerate the migration lock**

Run: `npx vitest run tests/test_cloudflare/migration-integrity.test.ts`
Expected: `migration-integrity.test.ts` hash changes; no errors.

- [ ] **Step 3: Verify the migration applies against a scratch DB**

Run:

```bash
npx wrangler d1 migrations list cycloid-db --local 2>/dev/null | tail -5 || echo "verify via test harness instead"
```

Expected: `0124_review_loop_ci_optout_and_timeout` appears as pending/applied. (If wrangler is unavailable locally, the Task 3 DAO test is the real verification.)

- [ ] **Step 4: Commit**

```bash
git add apps/control-plane-worker/migrations/0124_review_loop_ci_optout_and_timeout.sql tests/test_cloudflare/migration-integrity.test.ts
git commit -m "feat: add ci_response_enabled and review_timeout_minutes columns"
```

---

## Task 3: DAO — read/write the new columns and widen the list predicate

**Files:**

- Modify: `apps/control-plane-worker/src/settings/db.ts`
- Test: `tests/test_cloudflare/review-loop-bot-settings-dao.test.ts` (create)

The DAO test builds an in-memory sqlite D1 shim, applies migrations 0114 and 0124, and is the authoritative verification that the migration columns exist and round-trip.

- [ ] **Step 1: Write the failing test**

Create `tests/test_cloudflare/review-loop-bot-settings-dao.test.ts`:

```ts
import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getUserPrReviewBotSettings,
  listUserPrReviewBotSettings,
  setUserPrReviewBotSettings,
} from "../../apps/control-plane-worker/src/settings/db";

class Stmt {
  private values: unknown[] = [];
  constructor(
    private readonly db: Database.Database,
    private readonly q: string,
  ) {}
  bind(...v: unknown[]): this {
    this.values = v;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.q).get(...this.values) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.q).all(...this.values) as T[] };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.q).run(...this.values);
    return { success: true, meta: { changes: info.changes } };
  }
}

class D1 {
  constructor(readonly db: Database.Database) {}
  prepare(q: string) {
    return new Stmt(this.db, q);
  }
}

function makeDb(): D1 {
  const db = new Database(":memory:");
  for (const file of [
    "apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql",
    "apps/control-plane-worker/migrations/0124_review_loop_ci_optout_and_timeout.sql",
  ]) {
    db.exec(readFileSync(file, "utf8"));
  }
  return new D1(db) as unknown as D1;
}

describe("pr review bot settings DAO — ci/timeout", () => {
  let d1: D1;
  beforeEach(() => {
    d1 = makeDb();
  });

  it("defaults to ci enabled + 10 min when no row exists", async () => {
    const settings = await getUserPrReviewBotSettings(d1 as never, 1, "acme", "web");
    expect(settings.expectedBots).toEqual([]);
    expect(settings.ciResponseEnabled).toBe(true);
    expect(settings.reviewTimeoutMinutes).toBe(10);
  });

  it("round-trips ci flag and timeout (clamped) with no bots", async () => {
    await setUserPrReviewBotSettings(d1 as never, 1, "acme", "web", {
      expectedBots: [],
      ciResponseEnabled: false,
      reviewTimeoutMinutes: 90,
    });
    const settings = await getUserPrReviewBotSettings(d1 as never, 1, "acme", "web");
    expect(settings.expectedBots).toEqual([]);
    expect(settings.ciResponseEnabled).toBe(false);
    expect(settings.reviewTimeoutMinutes).toBe(60);
  });

  it("lists a no-bots repo that has a non-default preference", async () => {
    await setUserPrReviewBotSettings(d1 as never, 1, "acme", "web", {
      expectedBots: [],
      ciResponseEnabled: false,
      reviewTimeoutMinutes: 10,
    });
    const listed = await listUserPrReviewBotSettings(d1 as never, 1, {});
    expect(listed.rows.map((r) => `${r.repoOwner}/${r.repoName}`)).toContain("acme/web");
  });

  it("omits a no-bots repo that is entirely default", async () => {
    await setUserPrReviewBotSettings(d1 as never, 1, "acme", "web", {
      expectedBots: [],
      ciResponseEnabled: true,
      reviewTimeoutMinutes: 10,
    });
    const listed = await listUserPrReviewBotSettings(d1 as never, 1, {});
    expect(listed.rows.map((r) => `${r.repoOwner}/${r.repoName}`)).not.toContain("acme/web");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_cloudflare/review-loop-bot-settings-dao.test.ts`
Expected: FAIL — `ciResponseEnabled` undefined / `setUserPrReviewBotSettings` signature mismatch.

- [ ] **Step 3: Update the row interface and payload type**

In `apps/control-plane-worker/src/settings/db.ts`, extend `UserPrReviewBotSettingsRow` (currently ~line 205) and `UserPrReviewBotSettingsPayload` / `ListedUserPrReviewBotSettings`:

```ts
export interface UserPrReviewBotSettingsRow {
  user_id: number;
  repo_owner: string;
  repo_name: string;
  expected_bots_json: string;
  ci_response_enabled: number;
  review_timeout_minutes: number;
  created_at: number;
  updated_at: number;
}

export interface UserPrReviewBotSettingsPayload {
  expectedBots: PrReviewExpectedBot[];
  expectedBotsHash: string;
  ciResponseEnabled: boolean;
  reviewTimeoutMinutes: number;
}

export interface ListedUserPrReviewBotSettings {
  repoOwner: string;
  repoName: string;
  expectedBots: PrReviewExpectedBot[];
  expectedBotsHash: string;
  ciResponseEnabled: boolean;
  reviewTimeoutMinutes: number;
}
```

Add the import at the top of the file (with the other `pr-review-bots` imports):

```ts
import {
  clampReviewLoopTimeoutMinutes,
  PR_REVIEW_KNOWN_BOT_ID_SET,
  REVIEW_LOOP_TIMEOUT_DEFAULT_MINUTES,
  type PrReviewExpectedBot,
  type PrReviewKnownBotId,
} from "../../../../shared/constants/pr-review-bots.js";
```

(Replace the existing `pr-review-bots.js` import block so the two new symbols are included.)

- [ ] **Step 4: Update `mapPrReviewBotSettingsRow` to derive the new fields**

Replace `mapPrReviewBotSettingsRow` (currently ~line 276):

```ts
async function mapPrReviewBotSettingsRow(
  row: UserPrReviewBotSettingsRow | null,
): Promise<UserPrReviewBotSettingsPayload> {
  const expectedBots = normalizeExpectedPrReviewBots(parseExpectedPrReviewBotsJson(row?.expected_bots_json));
  return {
    expectedBots,
    expectedBotsHash: await computeExpectedPrReviewBotsHash(expectedBots),
    // No row → defaults: CI on, 10-minute window. This is what unblocks no-bots users.
    ciResponseEnabled: row ? row.ci_response_enabled !== 0 : true,
    reviewTimeoutMinutes: row
      ? clampReviewLoopTimeoutMinutes(row.review_timeout_minutes)
      : REVIEW_LOOP_TIMEOUT_DEFAULT_MINUTES,
  };
}
```

- [ ] **Step 5: Update `getUserPrReviewBotSettings` SELECT to include new columns**

In `getUserPrReviewBotSettings` (~line 286), add the two columns to the SELECT list:

```ts
const row = await db
  .prepare(
    `SELECT user_id, repo_owner, repo_name, expected_bots_json, ci_response_enabled, review_timeout_minutes, created_at, updated_at
       FROM user_pr_review_bot_settings
       WHERE user_id = ? AND repo_owner = ? AND repo_name = ?
       LIMIT 1`,
  )
  .bind(userId, owner, repo)
  .first<UserPrReviewBotSettingsRow>();
```

- [ ] **Step 6: Update `setUserPrReviewBotSettings` to persist all three fields**

Replace the function signature and body (~line 307):

```ts
export async function setUserPrReviewBotSettings(
  db: D1Database,
  userId: number,
  repoOwner: string,
  repoName: string,
  input: { expectedBots: PrReviewExpectedBot[]; ciResponseEnabled: boolean; reviewTimeoutMinutes: number },
): Promise<UserPrReviewBotSettingsPayload> {
  const owner = normalizeRepoKey(repoOwner);
  const repo = normalizeRepoKey(repoName);
  const normalized = normalizeExpectedPrReviewBots(input.expectedBots);
  const ciFlag = input.ciResponseEnabled ? 1 : 0;
  const timeoutMinutes = clampReviewLoopTimeoutMinutes(input.reviewTimeoutMinutes);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO user_pr_review_bot_settings (user_id, repo_owner, repo_name, expected_bots_json, ci_response_enabled, review_timeout_minutes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, repo_owner, repo_name) DO UPDATE SET
         expected_bots_json = excluded.expected_bots_json,
         ci_response_enabled = excluded.ci_response_enabled,
         review_timeout_minutes = excluded.review_timeout_minutes,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, owner, repo, JSON.stringify(normalized), ciFlag, timeoutMinutes, now, now)
    .run();

  return {
    expectedBots: normalized,
    expectedBotsHash: await computeExpectedPrReviewBotsHash(normalized),
    ciResponseEnabled: input.ciResponseEnabled,
    reviewTimeoutMinutes: timeoutMinutes,
  };
}
```

- [ ] **Step 7: Widen the list query predicate and SELECT**

In `listUserPrReviewBotSettings` (~line 347), update both branches. Replace the `expected_bots_json <> '[]'` filter with a non-default predicate, and add the new columns to the SELECT so the row mapper can read them:

```ts
const NON_DEFAULT = "(expected_bots_json <> '[]' OR ci_response_enabled = 0 OR review_timeout_minutes <> 10)";
const statement = cursor
  ? db
      .prepare(
        `SELECT user_id, repo_owner, repo_name, expected_bots_json, ci_response_enabled, review_timeout_minutes, created_at, updated_at
           FROM user_pr_review_bot_settings
           WHERE user_id = ?
             AND ${NON_DEFAULT}
             AND (repo_owner > ? OR (repo_owner = ? AND repo_name > ?))
           ORDER BY repo_owner ASC, repo_name ASC
           LIMIT ?`,
      )
      .bind(userId, cursor.repoOwner, cursor.repoOwner, cursor.repoName, queryLimit)
  : db
      .prepare(
        `SELECT user_id, repo_owner, repo_name, expected_bots_json, ci_response_enabled, review_timeout_minutes, created_at, updated_at
           FROM user_pr_review_bot_settings
           WHERE user_id = ? AND ${NON_DEFAULT}
           ORDER BY repo_owner ASC, repo_name ASC
           LIMIT ?`,
      )
      .bind(userId, queryLimit);
```

Then update the per-row push in the same function to carry the new fields:

```ts
for (const row of pageRows) {
  const mapped = await mapPrReviewBotSettingsRow(row);
  rows.push({
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    expectedBots: mapped.expectedBots,
    expectedBotsHash: mapped.expectedBotsHash,
    ciResponseEnabled: mapped.ciResponseEnabled,
    reviewTimeoutMinutes: mapped.reviewTimeoutMinutes,
  });
}
```

- [ ] **Step 8: Run the DAO test to verify it passes**

Run: `npx vitest run tests/test_cloudflare/review-loop-bot-settings-dao.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 9: Commit**

```bash
git add apps/control-plane-worker/src/settings/db.ts tests/test_cloudflare/review-loop-bot-settings-dao.test.ts
git commit -m "feat: persist and read per-repo ci/timeout in bot settings DAO"
```

---

## Task 4: Service layer — carry ci/timeout through payloads

**Files:**

- Modify: `apps/control-plane-worker/src/settings/service.ts`
- Test: `tests/test_cloudflare/review-loop-bot-settings-service.test.ts` (create)

Note: callers of `setUserPrReviewBotSettings` changed signature in Task 3 — `updatePrReviewBotSettingsPayload` is the only caller and is updated here.

- [ ] **Step 1: Write the failing test**

Create `tests/test_cloudflare/review-loop-bot-settings-service.test.ts`:

```ts
import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getPrReviewBotSettingsPayload,
  updatePrReviewBotSettingsPayload,
} from "../../apps/control-plane-worker/src/settings/service";

class Stmt {
  private values: unknown[] = [];
  constructor(
    private readonly db: Database.Database,
    private readonly q: string,
  ) {}
  bind(...v: unknown[]): this {
    this.values = v;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.q).get(...this.values) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.q).all(...this.values) as T[] };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.q).run(...this.values);
    return { success: true, meta: { changes: info.changes } };
  }
}
class D1 {
  constructor(readonly db: Database.Database) {}
  prepare(q: string) {
    return new Stmt(this.db, q);
  }
}
function makeDb(): D1 {
  const db = new Database(":memory:");
  for (const file of [
    "apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql",
    "apps/control-plane-worker/migrations/0124_review_loop_ci_optout_and_timeout.sql",
  ]) {
    db.exec(readFileSync(file, "utf8"));
  }
  return new D1(db);
}

describe("pr review bot settings service — ci/timeout", () => {
  let d1: D1;
  beforeEach(() => {
    d1 = makeDb();
  });

  it("returns defaults for an unconfigured repo", async () => {
    const payload = await getPrReviewBotSettingsPayload(d1 as never, 1, "acme", "web");
    expect(payload).toEqual({ expectedBots: [], ciResponseEnabled: true, reviewTimeoutMinutes: 10 });
  });

  it("persists provided overrides and preserves unspecified fields", async () => {
    await updatePrReviewBotSettingsPayload(d1 as never, 1, "acme", "web", {
      expectedBots: [],
      ciResponseEnabled: false,
      reviewTimeoutMinutes: 25,
    });
    // Second update only changes bots; ci/timeout should be preserved from the stored row.
    const updated = await updatePrReviewBotSettingsPayload(d1 as never, 1, "acme", "web", {
      expectedBots: [{ type: "known", id: "greptile" }],
    });
    expect(updated).toMatchObject({ ciResponseEnabled: false, reviewTimeoutMinutes: 25 });
    expect((updated as { expectedBots: unknown[] }).expectedBots).toHaveLength(1);
  });

  it("rejects invalid bots without touching ci/timeout", async () => {
    const result = await updatePrReviewBotSettingsPayload(d1 as never, 1, "acme", "web", {
      expectedBots: [{ type: "custom", login: "" }],
    });
    expect(result).toMatchObject({ ok: false });
  });
});
```

Replace `greptile` above with a valid id from `PR_REVIEW_BOT_IDS` if `greptile` is not present — check `shared/constants/pr-review-bots.ts` and use any real known id.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_cloudflare/review-loop-bot-settings-service.test.ts`
Expected: FAIL — `getPrReviewBotSettingsPayload` returns only `{ expectedBots }`; `updatePrReviewBotSettingsPayload` signature mismatch.

- [ ] **Step 3: Update `getPrReviewBotSettingsPayload`**

In `apps/control-plane-worker/src/settings/service.ts` (~line 356):

```ts
export async function getPrReviewBotSettingsPayload(
  db: D1Database,
  userId: number,
  repoOwner: string,
  repoName: string,
): Promise<{ expectedBots: PrReviewExpectedBot[]; ciResponseEnabled: boolean; reviewTimeoutMinutes: number }> {
  const settings = await getUserPrReviewBotSettings(db, userId, repoOwner, repoName);
  return {
    expectedBots: settings.expectedBots,
    ciResponseEnabled: settings.ciResponseEnabled,
    reviewTimeoutMinutes: settings.reviewTimeoutMinutes,
  };
}
```

- [ ] **Step 4: Update `updatePrReviewBotSettingsPayload` (read-modify-write)**

Replace the function (~line 366):

```ts
export async function updatePrReviewBotSettingsPayload(
  db: D1Database,
  userId: number,
  repoOwner: string,
  repoName: string,
  input: { expectedBots: PrReviewExpectedBot[]; ciResponseEnabled?: boolean; reviewTimeoutMinutes?: number },
): Promise<
  | { expectedBots: PrReviewExpectedBot[]; ciResponseEnabled: boolean; reviewTimeoutMinutes: number }
  | { ok: false; reason: string }
> {
  const validated = normalizeAndValidatePrReviewBotSettings(input.expectedBots);
  if (!validated.ok) return validated;
  // Read current so a partial PUT (e.g. only bots) preserves the other fields.
  const current = await getUserPrReviewBotSettings(db, userId, repoOwner, repoName);
  const ciResponseEnabled = input.ciResponseEnabled ?? current.ciResponseEnabled;
  const reviewTimeoutMinutes = clampReviewLoopTimeoutMinutes(
    input.reviewTimeoutMinutes ?? current.reviewTimeoutMinutes,
  );
  const settings = await setUserPrReviewBotSettings(db, userId, repoOwner, repoName, {
    expectedBots: validated.expectedBots,
    ciResponseEnabled,
    reviewTimeoutMinutes,
  });
  return {
    expectedBots: settings.expectedBots,
    ciResponseEnabled: settings.ciResponseEnabled,
    reviewTimeoutMinutes: settings.reviewTimeoutMinutes,
  };
}
```

Add `clampReviewLoopTimeoutMinutes` to the existing `pr-review-bots.js` import block at the top of `service.ts` (alongside `PR_REVIEW_EXPECTED_BOT_LIMIT`, etc.).

- [ ] **Step 5: Update `PrReviewBotSettingsListPayload` shape and `listPrReviewBotSettingsPayload`**

In the same file, extend the list payload type (~line 274) and stop skipping empty-bot rows so no-bots-but-configured repos still list:

```ts
export interface PrReviewBotSettingsListPayload {
  repositories: Array<{
    repoOwner: string;
    repoName: string;
    expectedBots: PrReviewExpectedBot[];
    ciResponseEnabled: boolean;
    reviewTimeoutMinutes: number;
  }>;
  nextCursor: string | null;
}
```

In `listPrReviewBotSettingsPayload` (~line 379), remove the `if (row.expectedBots.length === 0) continue;` line and include the new fields when pushing:

```ts
for (const row of listed.rows) {
  try {
    if (await options.verifyAccess(row.repoOwner, row.repoName)) {
      repositories.push({
        repoOwner: row.repoOwner,
        repoName: row.repoName,
        expectedBots: row.expectedBots,
        ciResponseEnabled: row.ciResponseEnabled,
        reviewTimeoutMinutes: row.reviewTimeoutMinutes,
      });
    } else {
      log.warn(
        { userId: options.userId, owner: row.repoOwner, repo: row.repoName },
        "Omitting inaccessible PR review bot setting",
      );
    }
  } catch (error) {
    log.warn(
      { userId: options.userId, owner: row.repoOwner, repo: row.repoName, error: String(error) },
      "Omitting PR review bot setting because repo access could not be verified",
    );
  }
}
```

- [ ] **Step 6: Run the service test to verify it passes**

Run: `npx vitest run tests/test_cloudflare/review-loop-bot-settings-service.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane-worker/src/settings/service.ts tests/test_cloudflare/review-loop-bot-settings-service.test.ts
git commit -m "feat: carry ci/timeout through bot settings service payloads"
```

---

## Task 5: Routes — validate and pass the new fields

**Files:**

- Modify: `apps/control-plane-worker/src/settings/routes.ts`

This task wires the route to the Task-4 service signature. Covered end-to-end by the route handler test in Task 9; here we make a focused schema unit test.

- [ ] **Step 1: Write the failing test**

Create `tests/test_cloudflare/review-loop-bot-settings-route-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { __testables } from "../../apps/control-plane-worker/src/settings/routes";

const { prReviewBotSettingsBodySchema } = __testables;

describe("prReviewBotSettingsBodySchema", () => {
  it("accepts ci flag and in-range timeout", () => {
    const parsed = prReviewBotSettingsBodySchema.safeParse({
      expectedBots: [],
      ciResponseEnabled: false,
      reviewTimeoutMinutes: 30,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects out-of-range timeout", () => {
    expect(prReviewBotSettingsBodySchema.safeParse({ expectedBots: [], reviewTimeoutMinutes: 0 }).success).toBe(false);
    expect(prReviewBotSettingsBodySchema.safeParse({ expectedBots: [], reviewTimeoutMinutes: 61 }).success).toBe(false);
    expect(prReviewBotSettingsBodySchema.safeParse({ expectedBots: [], reviewTimeoutMinutes: 1.5 }).success).toBe(
      false,
    );
  });

  it("accepts a bare bots body (fields optional)", () => {
    expect(prReviewBotSettingsBodySchema.safeParse({ expectedBots: [] }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_cloudflare/review-loop-bot-settings-route-schema.test.ts`
Expected: FAIL — `__testables` not exported / new schema fields absent.

- [ ] **Step 3: Extend the Zod schema**

In `apps/control-plane-worker/src/settings/routes.ts`, replace `prReviewBotSettingsBodySchema` (~line 59):

```ts
const prReviewBotSettingsBodySchema = z
  .object({
    expectedBots: z
      .array(z.discriminatedUnion("type", [knownPrReviewBotSchema, customPrReviewBotSchema]))
      .max(PR_REVIEW_EXPECTED_BOT_LIMIT),
    ciResponseEnabled: z.boolean().optional(),
    reviewTimeoutMinutes: z
      .number()
      .int()
      .min(REVIEW_LOOP_TIMEOUT_MIN_MINUTES)
      .max(REVIEW_LOOP_TIMEOUT_MAX_MINUTES)
      .optional(),
  })
  .strict();

export const __testables = { prReviewBotSettingsBodySchema };
```

Add to the `pr-review-bots.js` import block at the top of `routes.ts`:

```ts
import {
  isValidGithubOwnerLogin,
  isValidGithubRepoName,
  PR_REVIEW_BOT_IDS,
  PR_REVIEW_EXPECTED_BOT_LIMIT,
  REVIEW_LOOP_TIMEOUT_MAX_MINUTES,
  REVIEW_LOOP_TIMEOUT_MIN_MINUTES,
  type PrReviewExpectedBot,
} from "../../../../shared/constants/pr-review-bots.js";
```

- [ ] **Step 4: Thread the parsed fields through the body parser and handler**

Update `parseBoundedPrReviewBotSettingsBody` return type and value (~line 93) to carry the optional fields:

```ts
async function parseBoundedPrReviewBotSettingsBody(
  request: Request,
): Promise<
  | { ok: true; expectedBots: PrReviewExpectedBot[]; ciResponseEnabled?: boolean; reviewTimeoutMinutes?: number }
  | { ok: false; response: Response }
> {
```

And the success return at the end of that function:

```ts
return {
  ok: true,
  expectedBots: body.data.expectedBots,
  ciResponseEnabled: body.data.ciResponseEnabled,
  reviewTimeoutMinutes: body.data.reviewTimeoutMinutes,
};
```

Update the call in `handlePutPrReviewBotSettings` (~line 355) to pass the object form:

```ts
const updated = await updatePrReviewBotSettingsPayload(env.DB, userId, parsedRepo.owner, parsedRepo.repo, {
  expectedBots: body.expectedBots,
  ciResponseEnabled: body.ciResponseEnabled,
  reviewTimeoutMinutes: body.reviewTimeoutMinutes,
});
```

- [ ] **Step 5: Run the schema test to verify it passes**

Run: `npx vitest run tests/test_cloudflare/review-loop-bot-settings-route-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane-worker/src/settings/routes.ts tests/test_cloudflare/review-loop-bot-settings-route-schema.test.ts
git commit -m "feat: validate and forward ci/timeout in pr-review-bots route"
```

---

## Task 6: CI eligibility gate + timeout in resolver

**Files:**

- Modify: `apps/control-plane-worker/src/services/review-loop-settings.ts`
- Test: `tests/test_cloudflare/review-loop-ci-eligibility.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test_cloudflare/review-loop-ci-eligibility.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUserSettingsIfExists = vi.fn();
const mockGetUserPrReviewBotSettings = vi.fn();
const mockGetInstallationByOwner = vi.fn();

vi.mock("../../apps/control-plane-worker/src/settings/db", () => ({
  getUserSettingsIfExists: (...a: unknown[]) => mockGetUserSettingsIfExists(...a),
  getUserPrReviewBotSettings: (...a: unknown[]) => mockGetUserPrReviewBotSettings(...a),
}));
vi.mock("../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: (...a: unknown[]) => mockGetInstallationByOwner(...a),
}));

import { resolveReviewLoopCiEligibility } from "../../apps/control-plane-worker/src/services/review-loop-settings";

const CAPABLE_INSTALL = {
  installation_id: 42,
  suspended_at: null,
  permissions_json: JSON.stringify({ contents: "write", metadata: "read", pull_requests: "write" }),
  events_json: JSON.stringify([
    "check_run",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "push",
    "status",
  ]),
};

const env = { DB: {} } as never;
const input = { ownerUserId: 1, repoOwner: "acme", repoName: "web" };

describe("resolveReviewLoopCiEligibility", () => {
  beforeEach(() => {
    mockGetUserSettingsIfExists.mockReset().mockResolvedValue({ pr_review_auto_response_enabled: 1 });
    mockGetInstallationByOwner.mockReset().mockResolvedValue(CAPABLE_INSTALL);
    mockGetUserPrReviewBotSettings
      .mockReset()
      .mockResolvedValue({ expectedBots: [], ciResponseEnabled: true, reviewTimeoutMinutes: 10 });
  });

  it("is eligible with zero bots when CI is enabled", async () => {
    const result = await resolveReviewLoopCiEligibility(env, input);
    expect(result).toMatchObject({ ok: true, installationId: 42 });
  });

  it("is ignored when the master toggle is off", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ pr_review_auto_response_enabled: 0 });
    const result = await resolveReviewLoopCiEligibility(env, input);
    expect(result).toMatchObject({ ok: false, reason: "auto_response_disabled" });
  });

  it("is ignored when CI response is opted out for the repo", async () => {
    mockGetUserPrReviewBotSettings.mockResolvedValue({
      expectedBots: [],
      ciResponseEnabled: false,
      reviewTimeoutMinutes: 10,
    });
    const result = await resolveReviewLoopCiEligibility(env, input);
    expect(result).toMatchObject({ ok: false, reason: "ci_response_disabled" });
  });

  it("fails closed when installation capabilities are missing", async () => {
    mockGetInstallationByOwner.mockResolvedValue(null);
    const result = await resolveReviewLoopCiEligibility(env, input);
    expect(result).toMatchObject({ ok: false, reason: "installation_capabilities_missing" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_cloudflare/review-loop-ci-eligibility.test.ts`
Expected: FAIL — `resolveReviewLoopCiEligibility` not exported.

- [ ] **Step 3: Add `fallbackAfterMs` to the bot checklist resolution**

In `apps/control-plane-worker/src/services/review-loop-settings.ts`, extend the `ok` arm of `ReviewLoopChecklistResolution` (~line 24) and the return at the end of `resolveReviewLoopChecklist` (~line 151):

```ts
export type ReviewLoopChecklistResolution =
  | { ok: true; expectedBots: PrReviewExpectedBot[]; expectedBotsHash: string; fallbackAfterMs: number }
  | {
      ok: false;
      reason:
        | "auto_response_disabled"
        | "empty_expected_bots"
        | "expected_bots_changed"
        | "installation_capabilities_missing";
    };
```

```ts
return {
  ok: true,
  expectedBots: botSettings.expectedBots,
  expectedBotsHash: botSettings.expectedBotsHash,
  fallbackAfterMs: botSettings.reviewTimeoutMinutes * 60_000,
};
```

- [ ] **Step 4: Add `resolveReviewLoopCiEligibility`**

Append to `review-loop-settings.ts` (after `resolveReviewLoopHumanEligibility`):

```ts
export type ReviewLoopCiEligibility =
  | { ok: true; ownerUserId: number; installationId: number }
  | {
      ok: false;
      reason: "auto_response_disabled" | "ci_response_disabled" | "installation_capabilities_missing";
    };

/**
 * CI-failure gate. Unlike resolveReviewLoopChecklist, this does NOT require a bot
 * checklist — a repo with zero configured bots is eligible. Gated by the master
 * auto-response toggle, installation capabilities, and the per-repo ci_response_enabled
 * opt-out (default on).
 */
export async function resolveReviewLoopCiEligibility(
  env: Pick<Env, "DB">,
  input: { ownerUserId: number; repoOwner: string; repoName: string },
): Promise<ReviewLoopCiEligibility> {
  const ownerSettings = await getUserSettingsIfExists(env.DB, input.ownerUserId);
  if (!ownerSettings || ownerSettings.pr_review_auto_response_enabled === 0) {
    return { ok: false, reason: "auto_response_disabled" };
  }

  const caps = await checkReviewLoopInstallationCapabilities(env, input);
  if (!caps.ok) return caps;

  const botSettings = await getUserPrReviewBotSettings(env.DB, input.ownerUserId, input.repoOwner, input.repoName);
  if (!botSettings.ciResponseEnabled) return { ok: false, reason: "ci_response_disabled" };

  return { ok: true, ownerUserId: input.ownerUserId, installationId: caps.installation.installation_id };
}
```

- [ ] **Step 5: Run the eligibility test to verify it passes**

Run: `npx vitest run tests/test_cloudflare/review-loop-ci-eligibility.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-settings.ts tests/test_cloudflare/review-loop-ci-eligibility.test.ts
git commit -m "feat: add ci eligibility gate decoupled from bot checklist"
```

---

## Task 7: Epoch ingestion — use CI gate and per-repo timeout

**Files:**

- Modify: `apps/control-plane-worker/src/services/review-loop-epochs.ts`
- Test: `tests/test_cloudflare/review-loop-webhook-service.test.ts` (extend existing)

This task: (a) the CI ingestion path uses `resolveReviewLoopCiEligibility` instead of `resolveReviewLoopChecklist` so no-bots repos are no longer dropped as `empty_expected_bots`; (b) the bot-path ingestions pass the resolved `fallbackAfterMs` into the activity input so the configured timeout governs the collection window.

- [ ] **Step 1: Write the failing tests (extend the existing suite)**

In `tests/test_cloudflare/review-loop-webhook-service.test.ts`, inside the existing `describe("ci_failure ingestion", ...)` block (~line 667), add:

```ts
it("records a CI failure on a repo with ZERO configured bots (no longer dropped)", async () => {
  mockGetUserPrReviewBotSettings.mockResolvedValue({
    expectedBots: [],
    expectedBotsHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ciResponseEnabled: true,
    reviewTimeoutMinutes: 10,
  });
  const result = await service.ingestReviewLoopCiFailureWebhook({
    env,
    deliveryId: "d-ci-nobots",
    sourceId: "check_run:9001",
    checkRunId: 9001,
    checkRunName: "build",
    checkRunConclusion: "failure",
    actorLogin: "github-actions",
    repoOwner: "acme",
    repoName: "web",
    prNumber: 7,
    prUrl: "https://github.com/acme/web/pull/7",
    headSha: "headsha123",
  });
  expect(result.status).toBe("handled");
});

it("ignores a CI failure when ci_response_enabled is false for the repo", async () => {
  mockGetUserPrReviewBotSettings.mockResolvedValue({
    expectedBots: [],
    expectedBotsHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ciResponseEnabled: false,
    reviewTimeoutMinutes: 10,
  });
  const result = await service.ingestReviewLoopCiFailureWebhook({
    env,
    deliveryId: "d-ci-optout",
    sourceId: "check_run:9002",
    checkRunId: 9002,
    checkRunName: "build",
    checkRunConclusion: "failure",
    actorLogin: "github-actions",
    repoOwner: "acme",
    repoName: "web",
    prNumber: 7,
    prUrl: "https://github.com/acme/web/pull/7",
    headSha: "headsha123",
  });
  expect(result.status).toBe("ignored");
  expect(result.reason).toBe("ci_response_disabled");
});
```

In this test file's `beforeEach` (~line 115), add `ciResponseEnabled: true, reviewTimeoutMinutes: 10` to the default `mockGetUserPrReviewBotSettings` return value (search for `mockGetUserPrReviewBotSettings.mock`) so existing bot-path tests still pass.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/test_cloudflare/review-loop-webhook-service.test.ts -t "ci_failure ingestion"`
Expected: the two new cases FAIL (no-bots currently returns ignored `empty_expected_bots`; opt-out reason not produced).

- [ ] **Step 3: Switch the CI ingestion to the CI gate**

In `apps/control-plane-worker/src/services/review-loop-epochs.ts`, update the import (~line 12):

```ts
import { resolveReviewLoopChecklist, resolveReviewLoopCiEligibility } from "./review-loop-settings";
```

In `ingestReviewLoopCiFailureWebhook` (~line 1536), replace the `resolveReviewLoopChecklist` call and its guard:

```ts
const ciEligibility = await resolveReviewLoopCiEligibility(input.env, {
  ownerUserId,
  repoOwner: input.repoOwner,
  repoName: input.repoName,
});
if (!ciEligibility.ok) {
  ignored.push(ciEligibility.reason);
  continue;
}
```

The existing `upsertReviewLoopEpochActivity` call below it already passes `expectedBots: []` and `expectedBotsHash: REVIEW_LOOP_CI_EPOCH_HASH`, so no other change is needed in this block. (CI epochs are immediately `ready`, so they do not depend on the timeout.)

- [ ] **Step 4: Add `fallbackAfterMs` to the activity input type and use it on insert**

Extend `ReviewLoopActivityInput` (~line 111) with:

```ts
  fallbackAfterMs?: number;
```

In `insertReviewLoopEpochActivity` (~line 520), replace the fallback computation:

```ts
// Human-source epochs are immediately due (fallback = now). Bot/mixed epochs wait the
// per-repo configured window (default 10 min via FALLBACK_AFTER_MS).
const fallbackAfterAt = isHuman ? input.nowMs : input.nowMs + (input.fallbackAfterMs ?? FALLBACK_AFTER_MS);
```

- [ ] **Step 5: Pass `fallbackAfterMs` at each bot-path ingest site**

To each `upsertReviewLoopEpochActivity(input.env.DB, { ... })` call fed by a `resolveReviewLoopChecklist` result (near lines 1188, 1282, 1371, 1460, and 1638 — each preceded by `const checklist = await resolveReviewLoopChecklist(...)` and already passing `expectedBots: checklist.expectedBots`), add `fallbackAfterMs: checklist.fallbackAfterMs,`. Example shape:

```ts
const epoch = await upsertReviewLoopEpochActivity(input.env.DB, {
  sessionId,
  ownerUserId,
  repoOwner: input.repoOwner,
  repoName: input.repoName,
  // ...existing fields...
  expectedBots: checklist.expectedBots,
  expectedBotsHash: checklist.expectedBotsHash,
  fallbackAfterMs: checklist.fallbackAfterMs,
  // ...existing fields...
});
```

Do NOT add it to the CI ingest `upsertReviewLoopEpochActivity` call (it has no `checklist` and CI epochs are immediately ready). Wave re-inserts reuse the same `input`, so `fallbackAfterMs` is preserved across waves automatically.

- [ ] **Step 6: Add a timeout-plumbing assertion**

Add a bot-path test asserting the configured timeout reaches `fallback_after_at`, inside the suite where a configured bot epoch is created (near the existing "records configured bot review submissions" test ~line 146), with a fixed clock for deterministic math:

```ts
it("uses the per-repo timeout for the bot collection window", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
  const nowMs = Date.parse("2026-06-01T00:00:00.000Z");
  mockGetUserPrReviewBotSettings.mockResolvedValue({
    expectedBots: [{ type: "known", id: "greptile" }],
    expectedBotsHash: "abc",
    ciResponseEnabled: true,
    reviewTimeoutMinutes: 30,
  });
  // Drive a configured bot review submission through the same helper the existing
  // "records configured bot review submissions" test uses, then read the epoch back.
  // Assert: epoch.fallbackAfterAt - first_activity_at === 30 * 60_000.
  // (Mirror that test's setup for env/session mocks; assert on the returned epoch.)
  vi.useRealTimers();
});
```

Replace the placeholder comment body by copying the setup of the existing "records configured bot review submissions as terminal epoch activity" test and asserting `epoch.fallbackAfterAt === nowMs + 30 * 60_000`, using a bot id from `PR_REVIEW_BOT_IDS`. The point: one concrete assertion that `reviewTimeoutMinutes` flows into `fallback_after_at`.

- [ ] **Step 7: Run the full webhook-service suite**

Run: `npx vitest run tests/test_cloudflare/review-loop-webhook-service.test.ts`
Expected: PASS, including the new no-bots, opt-out, and timeout cases, and all pre-existing cases.

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-epochs.ts tests/test_cloudflare/review-loop-webhook-service.test.ts
git commit -m "feat: gate CI responses via ci eligibility and apply per-repo timeout"
```

---

## Task 8: UI API client — send and receive the new fields

**Files:**

- Modify: `apps/ui/src/api/settings.ts`

- [ ] **Step 1: Update the response types and request body**

In `apps/ui/src/api/settings.ts`, extend `PrReviewBotSettingsResponse` (~line 54), `PrReviewBotSettingsListResponse` (~line 58), and `updatePrReviewBotSettings` (~line 71):

```ts
export type PrReviewBotSettingsResponse = {
  expectedBots: PrReviewExpectedBot[];
  ciResponseEnabled: boolean;
  reviewTimeoutMinutes: number;
};

export type PrReviewBotSettingsListResponse = {
  repositories: Array<{
    repoOwner: string;
    repoName: string;
    expectedBots: PrReviewExpectedBot[];
    ciResponseEnabled: boolean;
    reviewTimeoutMinutes: number;
  }>;
  nextCursor: string | null;
};

export async function updatePrReviewBotSettings(
  owner: string,
  repo: string,
  input: { expectedBots: PrReviewExpectedBot[]; ciResponseEnabled: boolean; reviewTimeoutMinutes: number },
): Promise<PrReviewBotSettingsResponse> {
  return requestJson<PrReviewBotSettingsResponse>(
    `/api/settings/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pr-review-bots`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}
```

(Keep the existing second argument shape of `requestJson` — match the current call; only the `body` content changes.)

- [ ] **Step 2: Typecheck the UI package**

Run: `npm run -w cycloid-ui typecheck`
Expected: FAIL only in `GeneralSettings.tsx` (the only caller; still passes an array) — fixed in Task 9.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/api/settings.ts
git commit -m "feat: extend pr-review-bots UI client with ci/timeout"
```

---

## Task 9: UI panel — CI toggle + timeout input

**Files:**

- Modify: `apps/ui/src/components/settings/GeneralSettings.tsx`

The panel already loads via `fetchPrReviewBotSettings` and saves via `updatePrReviewBotSettings`. Add two pieces of local state, hydrate them, fold them into the dirty check and save payload, and render two controls.

- [ ] **Step 1: Add local state for the new fields**

Near the other review-bot `useState` hooks (search for `setReviewBotSettings(`), add:

```tsx
const [ciResponseEnabled, setCiResponseEnabled] = useState(true);
const [savedCiResponseEnabled, setSavedCiResponseEnabled] = useState(true);
const [reviewTimeoutMinutes, setReviewTimeoutMinutes] = useState(10);
const [savedReviewTimeoutMinutes, setSavedReviewTimeoutMinutes] = useState(10);
```

- [ ] **Step 2: Hydrate them on load**

In the `fetchPrReviewBotSettings(...).then((payload) => {...})` block (~line 120), add:

```tsx
setReviewBotSettings(payload.expectedBots);
setSavedReviewBotSettings(payload.expectedBots);
setCiResponseEnabled(payload.ciResponseEnabled);
setSavedCiResponseEnabled(payload.ciResponseEnabled);
setReviewTimeoutMinutes(payload.reviewTimeoutMinutes);
setSavedReviewTimeoutMinutes(payload.reviewTimeoutMinutes);
```

In the same effect's reset branches (the `setReviewBotSettings([])` / `setSavedReviewBotSettings([])` paths at ~lines 105, 111, 129), reset the new fields to defaults so a failed/blank load doesn't carry stale values:

```tsx
setCiResponseEnabled(true);
setSavedCiResponseEnabled(true);
setReviewTimeoutMinutes(10);
setSavedReviewTimeoutMinutes(10);
```

- [ ] **Step 3: Extend the dirty check**

Find `const reviewBotsDirty = !sameBotSets(reviewBotSettings, savedReviewBotSettings);` (~line 183) and replace with:

```tsx
const reviewBotsDirty =
  !sameBotSets(reviewBotSettings, savedReviewBotSettings) ||
  ciResponseEnabled !== savedCiResponseEnabled ||
  reviewTimeoutMinutes !== savedReviewTimeoutMinutes;
```

- [ ] **Step 4: Send the new fields on save and reset saved-state**

In `saveReviewBotChecklist` (~line 222), update the call and the post-save state:

```tsx
const updated = await updatePrReviewBotSettings(parsed.owner, parsed.repo, {
  expectedBots: reviewBotSettings,
  ciResponseEnabled,
  reviewTimeoutMinutes,
});
setReviewBotSettings(updated.expectedBots);
setSavedReviewBotSettings(updated.expectedBots);
setCiResponseEnabled(updated.ciResponseEnabled);
setSavedCiResponseEnabled(updated.ciResponseEnabled);
setReviewTimeoutMinutes(updated.reviewTimeoutMinutes);
setSavedReviewTimeoutMinutes(updated.reviewTimeoutMinutes);
```

Note: the `configuredReviewRepos` add/delete currently keys off `updated.expectedBots.length > 0`. Change it to keep the repo listed when it carries a non-default preference:

```tsx
setConfiguredReviewRepos((previous) => {
  const next = new Set(previous);
  const key = reviewBotRepo.toLowerCase();
  const nonDefault =
    updated.expectedBots.length > 0 || !updated.ciResponseEnabled || updated.reviewTimeoutMinutes !== 10;
  if (nonDefault) next.add(key);
  else next.delete(key);
  return next;
});
```

- [ ] **Step 5: Update `discardReviewBotChanges`**

Replace `discardReviewBotChanges` (~line 215) so discard also reverts the new fields:

```tsx
function discardReviewBotChanges() {
  setReviewBotError(null);
  setCustomBotLogin("");
  setCustomInputOpen(false);
  setReviewBotSettings(savedReviewBotSettings);
  setCiResponseEnabled(savedCiResponseEnabled);
  setReviewTimeoutMinutes(savedReviewTimeoutMinutes);
}
```

- [ ] **Step 6: Render the two controls**

Inside the panel body, after the "Selected" bots block (the `<div>` ending ~line 506, before the save/discard footer at ~line 508), insert a new block. Match the existing label/styling idiom used in the panel:

```tsx
<div className="space-y-3 border-t border-border pt-4">
  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <div className="min-w-0">
      <p className="text-[13px] font-medium text-text-primary">Respond to CI failures</p>
      <p className="mt-0.5 max-w-[52ch] text-[12px] leading-relaxed text-text-secondary">
        Address failing CI checks on these PRs, even with no review bots configured.
      </p>
    </div>
    <Toggle
      checked={ciResponseEnabled}
      onChange={() => setCiResponseEnabled((v) => !v)}
      disabled={reviewBotLoading}
      label="Respond to CI failures"
      showLabel={false}
    />
  </div>

  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <div className="min-w-0">
      <label htmlFor={reviewTimeoutInputId} className="text-[13px] font-medium text-text-primary">
        Collection window
      </label>
      <p className="mt-0.5 max-w-[52ch] text-[12px] leading-relaxed text-text-secondary">
        Minutes Cycloid waits for review bots before responding (1–60).
      </p>
    </div>
    <input
      id={reviewTimeoutInputId}
      type="number"
      min={1}
      max={60}
      step={1}
      value={reviewTimeoutMinutes}
      disabled={reviewBotLoading}
      onChange={(event) => {
        const next = Number.parseInt(event.target.value, 10);
        if (Number.isNaN(next)) {
          setReviewTimeoutMinutes(1);
        } else {
          setReviewTimeoutMinutes(Math.min(60, Math.max(1, next)));
        }
      }}
      className="min-h-[40px] w-20 rounded-md border border-border bg-surface-0 px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
    />
  </div>
</div>
```

Add the input id alongside the other `useId`/id declarations near the top of the component (search for `reviewBotRepoSelectId`):

```tsx
const reviewTimeoutInputId = useId();
```

If the component uses a different id pattern than `useId()` (e.g. literal string ids), match it. `Toggle` is already imported; `useId` may need adding to the existing `react` import.

- [ ] **Step 7: Typecheck the UI**

Run: `npm run -w cycloid-ui typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/ui/src/components/settings/GeneralSettings.tsx
git commit -m "feat: add CI-response toggle and timeout input to review-loop settings"
```

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: PASS across cli, control-plane-worker, ui, sandbox-bridge.

- [ ] **Step 2: Run the review-loop and settings test suites**

Run:

```bash
npx vitest run \
  tests/test_cloudflare/review-loop-timeout-constants.test.ts \
  tests/test_cloudflare/review-loop-bot-settings-dao.test.ts \
  tests/test_cloudflare/review-loop-bot-settings-service.test.ts \
  tests/test_cloudflare/review-loop-bot-settings-route-schema.test.ts \
  tests/test_cloudflare/review-loop-ci-eligibility.test.ts \
  tests/test_cloudflare/review-loop-webhook-service.test.ts \
  tests/test_cloudflare/review-loop-ci-sweep.test.ts \
  tests/test_cloudflare/github-pr-review-webhook.test.ts
```

Expected: all PASS. The last two are regression checks for the CI path and webhook wiring.

- [ ] **Step 3: Run the broader cloudflare suite to catch fallout**

Run: `npx vitest run tests/test_cloudflare`
Expected: PASS. Failures are almost certainly `getUserPrReviewBotSettings`/`setUserPrReviewBotSettings`/`updatePrReviewBotSettingsPayload` mocks or signatures expecting the old shape — add `ciResponseEnabled` and `reviewTimeoutMinutes` to those mocks.

- [ ] **Step 4: Final commit (if any mock fixes were needed)**

```bash
git add -A
git commit -m "test: align review-loop settings mocks with ci/timeout fields"
```

---

## Self-Review Notes (already incorporated)

- **Spec coverage:** migration (Task 2), CI gate decoupling (Task 6 + 7), timeout plumbing (Task 1, 6, 7), API/validation (Task 4, 5), list-predicate widening (Task 3, 4), UI (Task 8, 9), tests (every task + Task 10).
- **Type consistency:** field names `ciResponseEnabled` / `reviewTimeoutMinutes` and column names `ci_response_enabled` / `review_timeout_minutes` used identically across DAO, service, route, client, and UI. `setUserPrReviewBotSettings` takes an object (Task 3) and its only caller is updated in Task 4. `resolveReviewLoopChecklist.ok` gains `fallbackAfterMs` (Task 6) consumed in Task 7.
- **Known-bot ids in tests:** replace `greptile` with any id present in `PR_REVIEW_BOT_IDS` if it differs; verify against `shared/constants/pr-review-bots.ts` during implementation.

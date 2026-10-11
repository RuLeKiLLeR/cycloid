import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { listSessions } from "../../apps/control-plane-worker/src/session/db.js";

let migrationsApplied = false;
type D1Migration = { name: string; queries: string[] };

const ARCANIST_BUSINESS_ID = "295d2abc-d10b-4662-b84d-7bfa66242882";
const EXTERNAL_BUSINESS_ID = "b004178c-58e4-421b-a6b9-43b410fc64ec";
const INTERNAL_WITH_SETTINGS_ID = -9_900_001;
const INTERNAL_WITHOUT_SETTINGS_ID = -9_900_002;
const EXTERNAL_WITH_SETTINGS_ID = -9_900_003;

async function seedPlanModeBackfillFixtures(): Promise<void> {
  const now = 1_700_000_000_000;
  for (const [id, name] of [
    [ARCANIST_BUSINESS_ID, "Cycloid migration fixture"],
    [EXTERNAL_BUSINESS_ID, "External migration fixture"],
  ] as const) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    )
      .bind(id, name, now, now)
      .run();
  }
  for (const [id, businessId] of [
    [INTERNAL_WITH_SETTINGS_ID, ARCANIST_BUSINESS_ID],
    [INTERNAL_WITHOUT_SETTINGS_ID, ARCANIST_BUSINESS_ID],
    [EXTERNAL_WITH_SETTINGS_ID, EXTERNAL_BUSINESS_ID],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
    )
      .bind(id, id, `migration-user-${Math.abs(id)}`, businessId, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?)`,
    )
      .bind(businessId, id, now, now)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO user_settings (
       user_id, default_pr_draft, auto_verify_enabled, automatic_reviews_enabled,
       plan_mode, use_codex_subscription, default_model, default_repo, created_at, updated_at
     ) VALUES (?, 1, 1, 1, 0, 1, 'gpt-5.4-mini', 'trycycloid/cycloid', ?, ?)`,
  )
    .bind(INTERNAL_WITH_SETTINGS_ID, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO user_settings (
       user_id, default_pr_draft, auto_verify_enabled, automatic_reviews_enabled,
       plan_mode, use_codex_subscription, default_model, default_repo, custom_instructions,
       pr_review_auto_response_enabled, self_hosted_sandboxes_opt_in, created_at, updated_at
     ) VALUES (?, 1, 1, 1, 1, 1, 'gpt-5.4-mini', 'external/repo',
       'preserve these distinctive instructions', 1, 1, ?, ?)`,
  )
    .bind(EXTERNAL_WITH_SETTINGS_ID, now, now)
    .run();
}

async function applyControlPlaneMigrations(): Promise<void> {
  if (migrationsApplied) return;
  const response = await env.MIGRATIONS.fetch("https://migrations.test/");
  expect(response.ok).toBe(true);
  const migrations = (await response.json()) as D1Migration[];
  for (const migration of migrations) {
    for (const query of migration.queries) {
      await env.DB.prepare(query).run();
    }
    if (migration.name === "0259_pr_review_trigger_claims.sql") {
      await seedPlanModeBackfillFixtures();
    }
  }
  migrationsApplied = true;
}

describe("workerd D1 smoke", () => {
  beforeAll(async () => {
    await applyControlPlaneMigrations();
  });

  it("applies control-plane SQL migrations directly and runs the session list DAO", async () => {
    // This intentionally bypasses wrangler's d1_migrations bookkeeping.
    // The deploy flow owns migration-runner semantics; this smoke targets SQL/SQLite behavior under workerd.
    await env.DB.prepare(
      `INSERT INTO session_index (session_id, owner_user_id, business_id, status, created_at, updated_at, title, rich_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind("sess-d1-workerd", 42, "biz-workerd", "active", Date.now(), Date.now(), "Workerd D1 smoke", "created")
      .run();

    const listed = await listSessions(env.DB, null, null, { businessId: "biz-workerd", limit: 10 });

    expect(listed.data.map((row) => ({ sessionId: row.session_id, title: row.title }))).toEqual([
      expect.objectContaining({
        sessionId: "sess-d1-workerd",
        title: "Workerd D1 smoke",
      }),
    ]);
    expect(listed.nextCursor).toBeNull();
  });

  it("backfills plan mode auto only for Cycloid users without changing unrelated settings", async () => {
    const internal = await env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?")
      .bind(INTERNAL_WITH_SETTINGS_ID)
      .first<Record<string, unknown>>();
    expect(internal).toMatchObject({
      default_pr_draft: 1,
      auto_verify_enabled: 1,
      automatic_reviews_enabled: 1,
      plan_mode_setting: "auto",
      use_codex_subscription: 1,
      default_model: "gpt-5.4-mini",
      default_repo: "trycycloid/cycloid",
      created_at: 1_700_000_000_000,
    });

    const inserted = await env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?")
      .bind(INTERNAL_WITHOUT_SETTINGS_ID)
      .first<Record<string, unknown>>();
    expect(inserted).toMatchObject({
      default_pr_draft: 0,
      auto_verify_enabled: 0,
      automatic_reviews_enabled: 0,
      plan_mode_setting: "auto",
      use_codex_subscription: 0,
      default_model: null,
      default_repo: null,
    });

    const external = await env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?")
      .bind(EXTERNAL_WITH_SETTINGS_ID)
      .first<Record<string, unknown>>();
    expect(external).toEqual({
      user_id: EXTERNAL_WITH_SETTINGS_ID,
      default_model: "gpt-5.4-mini",
      custom_instructions: "preserve these distinctive instructions",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      default_repo: "external/repo",
      pr_review_auto_response_enabled: 1,
      self_hosted_sandboxes_opt_in: 1,
      use_codex_subscription: 1,
      default_pr_draft: 1,
      auto_verify_enabled: 1,
      automatic_reviews_enabled: 1,
      plan_mode_setting: "on",
      plan_approval_required: null,
      settings_profile: null,
    });
  });

  it("contracts user_settings to the checked text plan-mode column", async () => {
    type TableInfoRow = {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    };
    const columns = await env.DB.prepare("PRAGMA table_info(user_settings)").all<TableInfoRow>();
    expect(columns.results.map((column) => column.name)).toEqual([
      "user_id",
      "default_model",
      "custom_instructions",
      "created_at",
      "updated_at",
      "default_repo",
      "pr_review_auto_response_enabled",
      "self_hosted_sandboxes_opt_in",
      "use_codex_subscription",
      "default_pr_draft",
      "auto_verify_enabled",
      "automatic_reviews_enabled",
      "plan_mode_setting",
      "plan_approval_required",
      "settings_profile",
    ]);
    const columnsByName = new Map(columns.results.map((column) => [column.name, column]));
    expect(columnsByName.get("user_id")).toMatchObject({ type: "INTEGER", pk: 1 });
    for (const name of ["default_model", "custom_instructions", "default_repo"]) {
      expect(columnsByName.get(name)).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
    }
    for (const name of ["created_at", "updated_at"]) {
      expect(columnsByName.get(name)).toMatchObject({
        type: "INTEGER",
        notnull: 1,
        dflt_value: "unixepoch() * 1000",
        pk: 0,
      });
    }
    for (const name of [
      "pr_review_auto_response_enabled",
      "self_hosted_sandboxes_opt_in",
      "use_codex_subscription",
      "default_pr_draft",
      "auto_verify_enabled",
      "automatic_reviews_enabled",
    ]) {
      expect(columnsByName.get(name)).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 });
    }
    expect(columnsByName.get("plan_mode_setting")).toMatchObject({
      type: "TEXT",
      notnull: 1,
      dflt_value: "'off'",
      pk: 0,
    });

    const foreignKeys = await env.DB.prepare("PRAGMA foreign_key_list(user_settings)").all<{
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
    }>();
    expect(foreignKeys.results).toEqual([
      expect.objectContaining({
        table: "users",
        from: "user_id",
        to: "id",
        on_update: "NO ACTION",
        on_delete: "NO ACTION",
      }),
    ]);

    const triggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'user_settings'",
    ).all<{ name: string }>();
    expect(triggers.results).toEqual([]);

    const table = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_settings'",
    ).first<{ sql: string }>();
    expect(table?.sql).toContain("CHECK (plan_mode_setting IN ('off', 'on', 'auto'))");

    await expect(
      env.DB.prepare("UPDATE user_settings SET plan_mode_setting = 'sometimes' WHERE user_id = ?")
        .bind(INTERNAL_WITH_SETTINGS_ID)
        .run(),
    ).rejects.toThrow();
  });
});
